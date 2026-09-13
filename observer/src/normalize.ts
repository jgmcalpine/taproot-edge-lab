import { createHash } from "node:crypto";
import type { Channel, Delta, Json, NodeName, Snapshot, TraceEvent } from "./model.ts";

export function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
export function array(value: unknown): Json[] { return Array.isArray(value) ? value.map(object) : []; }
export function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
export function integer(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value).toString();
  return undefined;
}
export function hex(value: unknown, bytes = 32): string | undefined {
  if (typeof value !== "string") return undefined;
  if (new RegExp(`^[a-f0-9]{${bytes * 2}}$`, "i").test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const data = Buffer.from(value, "base64");
  return data.length === bytes && data.toString("base64") === value ? data.toString("hex") : undefined;
}
export function customData(value: unknown): Json {
  if (typeof value !== "string") return object(value);
  if (!value) return {};
  for (const text of [value, Buffer.from(value, "base64").toString("utf8")]) {
    try { return object(JSON.parse(text)); } catch { /* Unknown binary stays raw; never guess a TLV layout. */ }
  }
  return {};
}

export function channels(value: unknown, node: NodeName, assetId: string): Channel[] {
  return array(object(value).channels).map(c => {
    const data = customData(c.custom_channel_data);
    const funding = array(data.funding_assets).filter(a => hex(object(a.asset_genesis).asset_id) === assetId);
    const local = array(data.local_assets).filter(a => hex(a.asset_id) === assetId);
    const remote = array(data.remote_assets).filter(a => hex(a.asset_id) === assetId);
    const sum = (assets: Json[]) => assets.length && assets.every(a => integer(a.amount) !== undefined)
      ? assets.reduce((n, a) => n + BigInt(integer(a.amount)!), 0n).toString() : undefined;
    // A missing per-asset side is unknown, not automatically zero.
    const routingIds = [c.scid, c.chan_id, c.peer_scid_alias, c.zero_conf_confirmed_scid,
      ...(Array.isArray(c.alias_scids) ? c.alias_scids : [])].map(integer).filter((id): id is string => !!id && id !== "0");
    return { node, remotePubkey: hex(c.remote_pubkey, 33), channelPoint: string(c.channel_point),
      channelId: string(c.chan_id), scid: integer(c.scid), routingIds: [...new Set(routingIds)], active: c.active === true,
      commitmentType: string(c.commitment_type), btcLocalSat: integer(c.local_balance), btcRemoteSat: integer(c.remote_balance),
      btcUnsettledSat: integer(c.unsettled_balance),
      pendingHtlcs: Array.isArray(c.pending_htlcs) ? array(c.pending_htlcs).map(h => ({ paymentHash: hex(h.hash_lock),
        htlcId: integer(h.htlc_index), incoming: typeof h.incoming === "boolean" ? h.incoming : undefined, amountSat: integer(h.amount) })) : undefined,
      assetIncomingHtlcUnits: integer(data.incoming_htlc_balance), assetOutgoingHtlcUnits: integer(data.outgoing_htlc_balance),
      ...(funding.length || local.length || remote.length ? { assetId, assetLocal: sum(local), assetRemote: sum(remote), assetFunding: sum(funding) } : {}) };
  });
}

export function pendingChannelEvents(snapshot: Snapshot, paymentHash: string, source: string): TraceEvent[] {
  return Object.values(snapshot.nodes).flatMap(n => n.channels ?? []).flatMap(c => (c.pendingHtlcs ?? [])
    .filter(h => h.paymentHash === paymentHash).map(h => ({ node: c.node, layer: "lightning" as const,
      type: "PENDING_CHANNEL_HTLC_SNAPSHOT", observed: true, source, paymentHash, htlcId: h.htlcId,
      incomingChannelId: h.incoming === true ? c.scid : undefined,
      outgoingChannelId: h.incoming === false ? c.scid : undefined,
      amountMsat: h.amountSat === undefined ? undefined : (BigInt(h.amountSat) * 1000n).toString(),
      details: { incoming: h.incoming, channelPoint: c.channelPoint, correlation: "exact hash_lock; this is not a subscription event" } })));
}

// Checks settlement visibility, not expected economic deltas. Never hardcode a
// 1001-unit movement or assume that Bob's SUCCEEDED has reached every peer yet.
export function settlementIssues(before: Snapshot, after: Snapshot): string[] {
  const issues: string[] = [];
  for (const [node, state] of Object.entries(before.nodes)) for (const first of state.channels ?? []) {
    const last = after.nodes[node as NodeName]?.channels?.find(c => c.channelPoint === first.channelPoint);
    if (!last) { issues.push(`${node}: missing after channel ${first.channelPoint}`); continue; }
    if (!last.pendingHtlcs || last.pendingHtlcs.length || last.btcUnsettledSat !== "0") issues.push(`${node}: pending or unknown HTLC state on ${last.channelPoint}`);
    if (last.assetId && (last.assetIncomingHtlcUnits !== "0" || last.assetOutgoingHtlcUnits !== "0")) issues.push(`${node}: pending or unknown asset HTLC balance on ${last.channelPoint}`);
    const peer = Object.values(after.nodes).flatMap(n => n.channels ?? []).find(c => c.node !== node && c.channelPoint === last.channelPoint);
    if (peer && (last.btcLocalSat !== peer.btcRemoteSat || last.btcRemoteSat !== peer.btcLocalSat ||
      (last.assetId && (last.assetLocal !== peer.assetRemote || last.assetRemote !== peer.assetLocal)))) issues.push(`${node}: peer balances have not converged on ${last.channelPoint}`);
  }
  return [...new Set(issues)];
}

export function balanceDeltas(before: Snapshot, after: Snapshot): Delta[] {
  const deltas: Delta[] = [];
  for (const node of ["bob", "carol", "alice"] as const) {
    for (const first of before.nodes[node]?.channels ?? []) {
      const last = after.nodes[node]?.channels?.find(c => c.channelPoint && c.channelPoint === first.channelPoint && c.assetId === first.assetId);
      if (!last || !first.channelPoint) continue;
      const delta: Delta = { node, channelPoint: first.channelPoint, assetId: first.assetId };
      for (const field of ["btcLocalSat", "btcRemoteSat", "assetLocal", "assetRemote"] as const) {
        if (first[field] !== undefined && last[field] !== undefined) delta[field] = (BigInt(last[field]!) - BigInt(first[field]!)).toString();
      }
      deltas.push(delta);
    }
  }
  return deltas;
}

export function paymentEvents(payment: Json, source: string): TraceEvent[] {
  const paymentHash = hex(payment.payment_hash);
  const preimage = hex(payment.payment_preimage);
  const base = { node: "bob" as const, observed: true, source, paymentHash };
  const events: TraceEvent[] = [{ ...base, layer: "lightning", type: "PAYMENT_UPDATE",
    paymentPreimage: preimage && !/^0+$/.test(preimage) ? preimage : undefined,
    amountMsat: integer(payment.value_msat), details: { status: payment.status, feeMsat: integer(payment.fee_msat),
      creationTimeNs: string(payment.creation_time_ns), failureReason: payment.failure_reason } }];
  for (const attempt of array(payment.htlcs)) {
    const route = object(attempt.route), hops = array(route.hops), data = customData(route.custom_channel_data);
    const attemptId = integer(attempt.attempt_id), rfqId = hex(data.rfq_id);
    events.push({ ...base, layer: "lightning", type: "ATTEMPT_SNAPSHOT", attemptId, rfqId,
      outgoingChannelId: integer(hops[0]?.chan_id), amountMsat: integer(route.first_hop_amount_msat),
      details: { status: attempt.status, attemptTimeNs: attempt.attempt_time_ns, resolveTimeNs: attempt.resolve_time_ns,
        hops: hops.map(h => ({ channelId: integer(h.chan_id), pubkey: hex(h.pub_key, 33),
          amountToForwardMsat: integer(h.amt_to_forward_msat), feeMsat: integer(h.fee_msat) })) } });
    for (const balance of array(data.balances)) {
      events.push({ ...base, layer: "taproot-assets", type: "ASSET_FIRST_HOP_SNAPSHOT", attemptId, rfqId,
        outgoingChannelId: integer(hops[0]?.chan_id), assetId: hex(balance.asset_id), assetAmount: integer(balance.amount),
        amountMsat: integer(route.first_hop_amount_msat), details: { attemptStatus: attempt.status,
          amountMeaning: "satoshi carrier in msat; assetAmount is overlay units" } });
    }
  }
  return events;
}

export function quoteEvent(text: string, source: string): TraceEvent | undefined {
  const match = /^Got quote for (\d+) asset units at (\d+) msat\/unit from peer ([a-f0-9]{66}) with SCID (\d+)$/i.exec(text);
  if (!match) return undefined;
  return { node: "bob", layer: "rfq", type: "RFQ_QUOTE_PRINTED", observed: true, source, assetAmount: match[1],
    details: { displayedMsatPerUnit: match[2], peer: match[3].toLowerCase(), quoteScid: match[4],
      precision: "litcli integer display; invoice-only units, excluding fee allowance" } };
}

export function invoiceEvents(invoice: Json, source: string): TraceEvent[] {
  const paymentHash = hex(invoice.r_hash);
  const events: TraceEvent[] = [{ node: "alice", layer: "lightning", type: "INVOICE_SNAPSHOT", observed: true, source,
    paymentHash, paymentPreimage: invoice.state === "SETTLED" ? hex(invoice.r_preimage) : undefined,
    amountMsat: integer(invoice.amt_paid_msat), details: { state: invoice.state } }];
  for (const htlc of array(invoice.htlcs)) events.push({ node: "alice", layer: "lightning", type: "INVOICE_HTLC_SNAPSHOT",
    observed: true, source, paymentHash, incomingChannelId: integer(htlc.chan_id), htlcId: integer(htlc.htlc_index),
    amountMsat: integer(htlc.amt_msat), details: { state: htlc.state, acceptTime: htlc.accept_time, resolveTime: htlc.resolve_time,
      customRecords: htlc.custom_records, customChannelData: htlc.custom_channel_data } });
  return events;
}

export function acceptedQuoteEvents(quotes: Json, payments: Json[], source: string): TraceEvent[] {
  const routes = payments.flatMap(p => array(p.htlcs).map(h => ({ paymentHash: hex(p.payment_hash),
    rfqId: hex(customData(object(h.route).custom_channel_data).rfq_id) })));
  return array(quotes.sell_quotes).flatMap(q => {
    const match = routes.find(r => r.rfqId && r.rfqId === hex(q.id));
    return match ? [{ node: "bob" as const, layer: "rfq" as const, type: "ACCEPTED_QUOTE_SNAPSHOT", observed: true,
      source, paymentHash: match.paymentHash, rfqId: match.rfqId, assetId: hex(object(q.asset_spec).id),
      assetAmount: integer(q.asset_amount), details: { peer: q.peer, quoteScid: integer(q.scid),
        bidAssetRate: q.bid_asset_rate, expiry: q.expiry, minTransportableMsat: q.min_transportable_msat,
        correlation: "exact RFQ ID in payment route" } }] : [];
  });
}

export function correlate(payments: Json[], invoice: Json | undefined, before: Snapshot, events: TraceEvent[]) {
  const final = payments.at(-1), invoiceHash = hex(invoice?.r_hash), paymentHash = hex(final?.payment_hash);
  const paymentPreimage = hex(final?.payment_preimage), invoicePreimage = hex(invoice?.r_preimage);
  const nonzero = (value?: string) => !!value && !/^0+$/.test(value);
  const successful = array(final?.htlcs).filter(h => h.status === "SUCCEEDED");
  const routes = successful.map(h => {
    const route = object(h.route), data = customData(route.custom_channel_data), hops = array(route.hops);
    return { attemptId: integer(h.attempt_id), rfqId: hex(data.rfq_id), carrierMsat: integer(route.first_hop_amount_msat),
      balances: array(data.balances), hops: hops.map(hop => {
        const id = integer(hop.chan_id);
        const candidates = Object.values(before.nodes).flatMap(n => n.channels ?? []).filter(c => id && c.routingIds.includes(id));
        const points = [...new Set(candidates.map(c => c.channelPoint).filter(Boolean))];
        return { channelId: id, pubkey: hex(hop.pub_key, 33), amountToForwardMsat: integer(hop.amt_to_forward_msat),
          feeMsat: integer(hop.fee_msat), channelPoint: points.length === 1 ? points[0] : undefined,
          commitmentType: points.length === 1 ? candidates[0]?.commitmentType : undefined };
      }) };
  });
  const htlcs = array(invoice?.htlcs).filter(h => h.state === "SETTLED");
  const customFieldsEmpty = htlcs.length > 0 && htlcs.every(h =>
    h.custom_channel_data === "" && h.custom_records !== null && typeof h.custom_records === "object" &&
    !Array.isArray(h.custom_records) && Object.keys(object(h.custom_records)).length === 0);
  const matchedQuotes = events.filter(e => e.type === "ACCEPTED_QUOTE_SNAPSHOT" && e.paymentHash === paymentHash);
  const quoteLinks = events.filter(e => e.type === "RFQ_QUOTE_PRINTED").map(q => ({
    source: q.source, rfqIds: matchedQuotes.filter(a => a.details?.quoteScid === q.details?.quoteScid && a.details?.peer === q.details?.peer).map(a => a.rfqId),
    method: "exact quote SCID + peer; never timestamp proximity",
  }));
  const serializedInvoice = JSON.stringify(invoice ?? {}).toLowerCase();
  const rfqIds = [...new Set(payments.flatMap(p => array(p.htlcs).map(h => hex(customData(object(h.route).custom_channel_data).rfq_id))).filter((x): x is string => !!x))];
  return { paymentHash, invoiceHash, paymentPreimage,
    hashesMatch: paymentHash && invoiceHash ? paymentHash === invoiceHash : null,
    preimagesMatch: invoice?.state === "SETTLED" && nonzero(paymentPreimage) && nonzero(invoicePreimage) ? paymentPreimage === invoicePreimage : null,
    preimageHashesToPaymentHash: nonzero(paymentPreimage) && paymentHash ? createHash("sha256").update(Buffer.from(paymentPreimage!, "hex")).digest("hex") === paymentHash : null,
    rfqIds, quoteLinks, routes, aliceCustomFieldsEmpty: customFieldsEmpty,
    rfqIdsAbsentFromInvoice: invoice && rfqIds.length ? rfqIds.every(id => !serializedInvoice.includes(id) && !serializedInvoice.includes(Buffer.from(id, "hex").toString("base64").toLowerCase())) : null,
    settledInvoiceHtlcs: htlcs.map(h => ({ channelId: integer(h.chan_id), htlcId: integer(h.htlc_index), amountMsat: integer(h.amt_msat) })) };
}
