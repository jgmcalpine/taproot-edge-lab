import { channelLabel, correlateHtlcs } from "./htlc-normalize.ts";
import { array, hex, integer, object, customData } from "./normalize.ts";
import type { NodeName, TraceEvent } from "./model.ts";
import type { SummaryInput } from "./summary.ts";

const amount = (value?: string) => value === undefined ? "not observed" : `${BigInt(value).toLocaleString("en-US")} msat`;
const safe = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const refs = (event: TraceEvent) => (event.evidenceRefs ?? []).map(r => `\`${r}\``).join(", ");
const comparison = (value: boolean | null) => value === null ? "not exposed / not established" : value ? "MATCH" : "MISMATCH";

export function renderHtlcSummary(input: SummaryInput): string[] {
  const { before, after, events, payments, config } = input;
  const invoiceSource = `raw/alice-invoice-${after.rawSuffix ?? "after"}.json`;
  const correlation = correlateHtlcs(events, before, payments, after.aliceInvoice, invoiceSource);
  const linkedIds = new Set(correlation.lifecycles.filter(l => l.correlatedPaymentHash && l.correlatedPaymentHash === correlation.paymentHash).flatMap(l => l.eventIds));
  const timeline = events.filter(e => e.source === "SubscribeHtlcEvents" && e.type.startsWith("htlc_") && e.type !== "htlc_subscribed")
    .toSorted((a, b) => (a.relativeMs ?? 0) - (b.relativeMs ?? 0));
  const linked = timeline.filter(e => linkedIds.has(e.eventId!));
  const unique = (node: NodeName, type: string) => {
    const matches = linked.filter(e => e.node === node && e.type === type);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const bob = unique("bob", "htlc_send"), carol = unique("carol", "htlc_forward"), alice = unique("alice", "htlc_receive");
  const rowAmount = (event: TraceEvent, direction: "incoming" | "outgoing") => {
    const id = direction === "incoming" ? event.incomingChannelId : event.outgoingChannelId;
    const value = direction === "incoming" ? event.incomingAmountMsat : event.outgoingAmountMsat;
    return id === "0" ? "—" : amount(value);
  };
  const lines = ["## HTLC switch timeline", "",
    "DIRECTLY OBSERVED SubscribeHtlcEvents messages only. Role (`event_type`: SEND / RECEIVE / FORWARD / UNKNOWN) and lifecycle payload are separate columns. Zero channel IDs denote an absent side; FINAL's incoming-only circuit is shown exactly as reported.", "",
    "| Time from run start | Node | Role | Payload | Incoming channel / HTLC ID | Incoming amount | Outgoing channel / HTLC ID | Outgoing amount | Payment link / raw evidence |",
    "| --- | --- | --- | --- | --- | ---: | --- | ---: | --- |"];
  for (const event of timeline) {
    const channel = (side: "incoming" | "outgoing") => {
      const id = side === "incoming" ? event.incomingChannelId : event.outgoingChannelId;
      const htlc = side === "incoming" ? event.incomingHtlcId : event.outgoingHtlcId;
      return `${channelLabel(before, event.node as NodeName, id, side)}${id && id !== "0" ? ` / HTLC ${htlc ?? "unknown"}` : ""}`;
    };
    lines.push(`| ${event.relativeMs === undefined ? "unknown" : `${event.relativeMs >= 0 ? "+" : ""}${event.relativeMs.toFixed(3)} ms`} | ${event.node} | ${safe(event.eventType ?? "UNKNOWN")} | ${safe(event.payloadVariant ?? "unknown")} | ${safe(channel("incoming"))} | ${rowAmount(event, "incoming")} | ${safe(channel("outgoing"))} | ${rowAmount(event, "outgoing")} | ${linkedIds.has(event.eventId!) ? "CORRELATED" : "unlinked"}; ${refs(event)} |`);
  }
  if (!timeline.length) lines.push("", "No live HTLC subscription lifecycle messages were observed; no SEND/FORWARD/RECEIVE rows can be supplied.");
  lines.push("", "Payment links are constructed comparisons, not fields supplied by this RPC. See `correlation.json` → `htlc` for preimage/hash anchors, invoice channel/HTLC anchors and circuit links. Unlinked background events remain visible without attributing them to this payment.",
    "Times prefer daemon timestamp_ns; raw records retain it and observer_receive_timestamp separately. Display order is not a claim of cross-node nanosecond causality. Identical replays remain raw; `htlc-streams.json` records normalized duplicates and readiness/teardown diagnostics.", "");
  for (const [node, role] of [["bob", "SEND"], ["carol", "FORWARD"], ["alice", "RECEIVE"]] as const) {
    const observations = linked.filter(e => e.node === node && e.eventType === role);
    lines.push(observations.length ? `OBSERVED ${node} ${role}: ${observations.map(e => `${e.payloadVariant} (${refs(e)})`).join("; ")}.` : `${node} ${role}: no payment-correlated role event observed.`);
  }
  if (carol) lines.push(`DIRECTLY OBSERVED Carol FORWARD: incoming ${amount(carol.incomingAmountMsat)}, outgoing ${amount(carol.outgoingAmountMsat)} in the same RPC message (${refs(carol)}).`);
  else lines.push("A single payment-correlated Carol FORWARD with incoming/outgoing amounts was not established; inspect the raw stream without synthesizing a transition.");
  if (bob?.outgoingAmountMsat !== undefined && carol?.incomingAmountMsat !== undefined) {
    if (bob.outgoingAmountMsat !== carol.incomingAmountMsat) lines.push("",
      `CORRELATED discrepancy: Bob's SEND outgoing amount (${amount(bob.outgoingAmountMsat)}; ${refs(bob)}) differs from Carol's FORWARD incoming amount (${amount(carol.incomingAmountMsat)}; ${refs(carol)}), although their channel/HTLC pair links the same first hop. The expected carrier → BTC transition is NOT directly observed inside Carol's FORWARD message. Do not relabel her incoming field as the raw carrier amount.`,
      "INFERRED explanation from the pinned implementations: [tapd v0.7 AssetPurchasePolicy.GenerateInterceptorResponse](https://github.com/lightninglabs/taproot-assets/blob/v0.7.0/rfq/order.go#L510-L537) converts the asset units plus one rounding unit at the accepted bid rate and supplies an incoming-amount override. [LND v0.20 ResumeModified](https://github.com/lightningnetwork/lnd/blob/v0.20.0-beta/htlcswitch/interceptable_switch.go#L669-L708) applies it to the packet; [the forwarding notifier](https://github.com/lightningnetwork/lnd/blob/v0.20.0-beta/htlcswitch/link.go#L1658-L1669) reports that packet amount. This explains why a switch field can differ from the carrier. The interceptor request/response itself was not captured, so this explanation remains distinct from the direct RPC evidence. The incoming/outgoing difference is not the observed payment fee; that fee is separately reported by Bob's payment RPC.");
    else lines.push(`CORRELATED comparison: Bob's SEND outgoing amount equals Carol's FORWARD incoming amount (${amount(bob.outgoingAmountMsat)}). Carol's two amount fields themselves are directly observed in the row above.`);
  }
  if (!alice) lines.push(`Alice's switch stream did not expose a unique amount-bearing RECEIVE/forward_event for this payment. RECEIVE/settle_event, if present above, exposes a preimage, not an amount. Her received amount is separately observed by LookupInvoice (${invoiceSource}).`);
  for (const node of ["bob", "carol", "alice"] as const) {
    if (!linked.some(e => e.node === node && e.type === "htlc_final")) lines.push(`${node} FINAL: not observed for this payment.`);
  }

  const successful = array(payments.at(-1)?.htlcs).filter(h => h.status === "SUCCEEDED");
  const routeData = successful.length === 1 ? customData(object(successful[0].route).custom_channel_data) : {};
  const asset = array(routeData.balances).find(b => hex(b.asset_id) === config.assetId);
  const assetUnits = integer(asset?.amount);
  const paid = integer(after.aliceInvoice?.amt_paid_msat);
  const economicInput = assetUnits === undefined ? "not observed" : `${BigInt(assetUnits).toLocaleString("en-US")} ${safe(config.assetName)} units`;
  const receivedSats = paid === undefined ? "not observed" : `${BigInt(paid) / 1000n}${BigInt(paid) % 1000n ? ` + ${BigInt(paid) % 1000n} msat` : ""} sats`;
  lines.push("", "## Asset/BTC boundary", "", "```text", "ECONOMIC VIEW — correlated from payment overlay and LookupInvoice", "",
    `Bob (${economicInput}) → Carol (asset/BTC edge) → Alice (${receivedSats})`, "",
    "LND SWITCH VIEW — separately observed RPC fields", "",
    `Bob SEND outgoing:       ${amount(bob?.outgoingAmountMsat)}`,
    `            ↓ same channel/HTLC; fields may reflect different processing stages`,
    `Carol FORWARD incoming:  ${amount(carol?.incomingAmountMsat)}`,
    `Carol FORWARD outgoing:  ${amount(carol?.outgoingAmountMsat)} → Alice`,
    `Alice RECEIVE amount:    ${amount(alice?.incomingAmountMsat)}`,
    `Alice LookupInvoice:     ${amount(paid)} (separate source)`, "```", "",
    "CORRELATED economic view: asset units come from the successful Bob route's custom_channel_data.balances (`payment.jsonl`); Alice's paid amount comes from LookupInvoice. Signed asset/balance deltas below provide a separate check, assuming a quiet lab.", "",
    `INFERRED protocol interpretation: Bob's first-hop satoshi amount is the asset carrier/anchor HTLC, not the economic value of the payment. The economic input is the ${safe(config.assetName)} asset movement. The Taproot Assets overlay/RFQ state supplies that denomination. Carol bridges the asset-side state to an ordinary sat-denominated outgoing Lightning HTLC; her switch incoming amount may already reflect an interceptor override as explained above. Alice's captured invoice custom fields describe the ordinary BTC endpoint. This is not a conversion of carrier sats into a larger number of sats.`, "",
    "### HTLC settlement preimages", "",
    "| Node | Exposed switch preimage | Equals Bob final preimage | Equals Alice invoice preimage | SHA-256 equals payment hash | Evidence |",
    "| --- | --- | --- | --- | --- | --- |");
  for (const node of ["bob", "carol", "alice"] as const) {
    const settlements = correlation.settlements.filter(s => s.node === node && linkedIds.has(s.eventId!));
    if (!settlements.length) lines.push(`| ${node} | not observed | not established | not established | not established | raw/htlc-${node}.ndjson |`);
    for (const s of settlements) lines.push(`| ${node} | ${s.preimage ?? "not exposed"} | ${comparison(s.matchesBob)} | ${comparison(s.matchesAlice)} | ${comparison(s.hashesToPayment)} | ${(s.evidenceRefs ?? []).map(r => `\`${r}\``).join(", ")} |`);
  }
  lines.push("", "These equalities are CORRELATED comparisons of independently observed preimages. SETTLE and FINAL rows never inherit forward amounts. Missing lifecycle messages mean not observed, not proof the lifecycle step did not occur.", "");
  return lines;
}
