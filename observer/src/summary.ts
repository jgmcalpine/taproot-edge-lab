import { balanceDeltas, correlate, hex, integer } from "./normalize.ts";
import type { Config, Json, Snapshot, TraceEvent } from "./model.ts";
import { renderHtlcSummary } from "./htlc-summary.ts";

export type SummaryInput = { config: Config; before: Snapshot; after: Snapshot; payments: Json[];
  events: TraceEvent[]; status: string; errors: string[]; limitations: string[] };

const show = (value: unknown) => value === undefined || value === null ? "not observed" : String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const check = (value: boolean | null) => value === null ? "not established" : value ? "MATCH" : "MISMATCH";
const sats = (msat: unknown) => {
  const value = integer(msat);
  return value === undefined ? "not observed" : `${BigInt(value) / 1000n}${BigInt(value) % 1000n ? `.${(BigInt(value) % 1000n).toString().padStart(3, "0").replace(/0+$/, "")}` : ""}`;
};

export function renderSummary(input: SummaryInput): string {
  const { config, before, after, payments, events, status, errors, limitations } = input;
  const invoice = after.aliceInvoice ?? before.aliceInvoice;
  const final = payments.at(-1), correlation = correlate(payments, after.aliceInvoice, before, events);
  const deltas = balanceDeltas(before, after);
  const route = correlation.routes.length === 1 ? correlation.routes[0] : undefined;
  const bobKey = hex(before.nodes.bob?.info?.identity_pubkey, 33), aliceKey = hex(before.nodes.alice?.info?.identity_pubkey, 33);
  const routeKnown = route?.hops.length === 2 && route.hops[0].pubkey === config.carolPubkey && route.hops[1].pubkey === aliceKey && !!bobKey;
  const quotes = events.filter(e => e.type === "ACCEPTED_QUOTE_SNAPSHOT");
  const afterSuffix = after.rawSuffix ?? "after";
  const bobAssetDelta = deltas.find(d => d.node === "bob" && d.assetId === config.assetId)?.assetLocal;
  const economicDecrease = bobAssetDelta !== undefined && BigInt(bobAssetDelta) <= 0n ? (-BigInt(bobAssetDelta)).toString() : undefined;
  const lines = ["# Payment Trace", "", "## Result", "", status, "",
    `Bob's last streamed status: ${show(final?.status)}. Alice's captured state: ${show(invoice?.state)}.`, "",
    "OBSERVED means a captured CLI/RPC field. CORRELATED means comparisons or links across observations; balance changes are labeled arithmetic. INFERRED denotes protocol interpretation. Snapshot records are distinct from live HTLC notifications.", "",
    "## Invoice", "", "Recipient: Alice (configured plain LND)",
    `Requested: ${sats(invoice?.value_msat)} sats`, `Payment hash: ${show(hex(invoice?.r_hash))}`,
    `Invoice state: ${show(invoice?.state)}`, `Evidence: \`raw/alice-invoice-created.json\` (when created), \`raw/alice-invoice-before.json\`, \`raw/alice-invoice-${afterSuffix}.json\`.`, "",
    "## Asset", "", `Asset: ${show(config.assetName)} (configured label)`, `Asset ID: ${config.assetId}`, "Sender: Bob", "",
    "## RFQ", "", `Edge peer: ${config.carolPubkey} (Carol, verified in preflight when completed)`,
    `RFQ ID(s) in Bob's route data: ${correlation.rfqIds.join(", ") || "not observed"}`, ""];
  const printed = events.filter(e => e.type === "RFQ_QUOTE_PRINTED");
  for (const q of printed) {
    const link = correlation.quoteLinks.find(l => l.source === q.source);
    lines.push(`OBSERVED litcli display: ${show(q.assetAmount)} invoice asset units at ${show(q.details?.displayedMsatPerUnit)} msat/unit; quote SCID ${show(q.details?.quoteScid)}.`,
      `RFQ ID correlation: ${link?.rfqIds.length === 1 ? link.rfqIds[0] + " (exact quote SCID + peer)" : "not established; no timestamp-based match"}.`);
  }
  if (!printed.length) lines.push("Quoted rate / invoice asset units: not observed in the payment stream.");
  for (const q of quotes) lines.push(`OBSERVED accepted sell quote ${q.rfqId}: asset amount ${show(q.assetAmount)} units; raw bid_asset_rate ${JSON.stringify(q.details?.bidAssetRate)}. This quote allowance may include fees; it is not the amount ultimately spent.`);
  lines.push(`The printed msat/unit rate is litcli's integer display. The preflight decoder estimate is separate from this payment's negotiated RFQ. See \`preflight.json\` and \`raw/bob-quotes-${afterSuffix}.json\`.`, "",
    "## Route", "", routeKnown ? "OBSERVED Bob -> Carol -> Alice (successful attempt hop pubkeys + channel SCIDs)." : "The complete successful Bob -> Carol -> Alice route was not established from captured hop data.", "",
    "Bob -> Carol:", `- Channel type: ${show(route?.hops[0]?.commitmentType)}`,
    `- Routing SCID: ${show(route?.hops[0]?.channelId)}; channel point: ${show(route?.hops[0]?.channelPoint)}`,
    `- Successful attempt asset units: ${show(route?.balances.find(b => hex(b.asset_id) === config.assetId)?.amount)}`,
    `- First-hop carrier HTLC: ${sats(route?.carrierMsat)} sats / ${show(route?.carrierMsat)} msat`,
    `- RFQ ID: ${show(route?.rfqId)}`, "", "Carol -> Alice:",
    `- Channel type: ${show(route?.hops[1]?.commitmentType)}`,
    `- Routing SCID: ${show(route?.hops[1]?.channelId)}; channel point: ${show(route?.hops[1]?.channelPoint)}`,
    `- BTC to forward in successful route: ${sats(route?.hops[1]?.amountToForwardMsat)} sats`,
    `- Carol hop fee: ${sats(route?.hops[0]?.feeMsat)} sats / ${show(route?.hops[0]?.feeMsat)} msat`,
    `- Total payment fee: ${sats(final?.fee_msat)} sats / ${show(final?.fee_msat)} msat`,
    "Evidence: all `payment.jsonl` updates, `raw/bob-payment.jsonl`, and `correlation.json`. These route fields describe Bob's attempt; Carol's separately captured RPC messages appear in the HTLC switch timeline below.", "",
    "### Three different amounts", "",
    "| Quantity | Observed value | Evidence |", "| --- | --- | --- |",
    `| Economic asset movement (Bob local decrease) | ${show(economicDecrease)} asset units (see signed delta below) | before/after channel asset balances |`,
    `| First-hop satoshi carrier | ${sats(route?.carrierMsat)} sats | route.first_hop_amount_msat |`,
    `| BTC received by Alice | ${sats(after.aliceInvoice?.amt_paid_msat)} sats | Alice lookupinvoice |`, "",
    "INFERRED protocol interpretation: the asset amount lives in the overlay/custom channel data; the first-hop HTLC also carries a satoshi-denominated anchor at the LND layer. The carrier is not the economic LabUSD amount or Alice's invoice value. Carol's asset/BTC edge role is supported by the route and balance changes, not a captured internal conversion event. See the protocol references in `observer/README.md`.", "",
    ...renderHtlcSummary(input),
    "## Settlement", "", `Bob payment hash: ${show(correlation.paymentHash)}`,
    `Alice invoice hash: ${show(correlation.invoiceHash)}`, `Hash comparison: ${check(correlation.hashesMatch)}`,
    `Bob preimage: ${show(correlation.paymentPreimage)}`, `Preimage comparison with Alice: ${check(correlation.preimagesMatch)}`,
    `SHA-256(preimage) == payment hash: ${check(correlation.preimageHashesToPaymentHash)}`,
    `Alice received: ${sats(after.aliceInvoice?.amt_paid_msat)} sats`, "");
  if (correlation.aliceCustomFieldsEmpty) {
    lines.push("OBSERVED: every settled Alice invoice HTLC has `custom_records: {}` and `custom_channel_data: \"\"`. No asset ID or RFQ metadata is exposed in those custom fields.");
  } else lines.push("Alice's settled HTLC custom fields were not all explicitly empty; an ordinary BTC-only receipt is not established. Missing fields are not treated as empty.");
  lines.push(`Bob RFQ ID(s) absent from captured Alice invoice JSON: ${correlation.rfqIdsAbsentFromInvoice === null ? "not established" : correlation.rfqIdsAbsentFromInvoice ? "yes" : "no"}. This is a statement about the captured response, not proof about all internal node state.`, "",
    "| Alice settled HTLC ID | Incoming SCID | Amount msat |", "| --- | --- | --- |",
    ...correlation.settledInvoiceHtlcs.map(h => `| ${show(h.htlcId)} | ${show(h.channelId)} | ${show(h.amountMsat)} |`), "",
    "## Balance changes", "", "OBSERVED arithmetic, AFTER minus BEFORE. BTC values are sats; asset values are raw units. These are channel-local balances from each named node's perspective.", "",
    "| Node | Channel point | BTC local delta | BTC remote delta | Asset local delta | Asset remote delta |",
    "| --- | --- | --- | --- | --- | --- |",
    ...deltas.map(d => `| ${d.node} | ${d.channelPoint} | ${show(d.btcLocalSat)} | ${show(d.btcRemoteSat)} | ${d.assetId ? show(d.assetLocal) : "n/a"} | ${d.assetId ? show(d.assetRemote) : "n/a"} |`), "",
    `Evidence: \`before.json\`, \`after.json\` (final sample: ${afterSuffix}), \`deltas.json\`, and raw per-node channel responses. Every AFTER sample is retained. Snapshots are sequential RPCs, not an atomic ledger view. Attributing the entire delta to this payment assumes no concurrent lab activity.`, "",
    "## What this demonstrates", "");
  if (status === "SUCCEEDED" && correlation.hashesMatch && correlation.preimagesMatch && routeKnown && correlation.aliceCustomFieldsEmpty && route?.rfqId) {
    lines.push("CORRELATED: Bob's successful asset-bearing first hop and Alice's settled BTC invoice share a payment hash and preimage. Separately OBSERVED: the RFQ ID is present in Bob's route metadata and Alice's HTLC custom fields are empty.", "",
      "INFERRED from this evidence and the configured plain-LND recipient: Carol bridges the asset edge to the BTC channel, so Alice can receive without Taproot Assets support. This run demonstrates this two-hop lab path; it does not establish behavior for every Lightning route.");
  } else lines.push("The captured evidence does not establish the full successful asset-to-BTC demonstration. Inspect the result, correlation checks, and errors before drawing that conclusion.");
  lines.push("", "## Observability limits", "", ...limitations.map(l => `- ${l}`));
  if (errors.length) lines.push("", "## Errors / incomplete evidence", "", ...errors.map(e => `- ${show(e)}`));
  return lines.join("\n") + "\n";
}
