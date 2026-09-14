import { createHash } from "node:crypto";
import type { RawHtlcRecord } from "./htlc-capture.ts";
import type { Channel, Json, NodeName, Snapshot, TraceEvent } from "./model.ts";
import { array, hex, integer, object, string } from "./normalize.ts";

const variants = ["forward_event", "forward_fail_event", "settle_event", "link_fail_event", "subscribed_event", "final_htlc_event"] as const;
export function parseHtlcRecord(line: string): RawHtlcRecord {
  const record = object(JSON.parse(line));
  if (!["bob", "carol", "alice"].includes(String(record.node)) ||
      typeof record.observer_receive_timestamp !== "string" || !Number.isFinite(Date.parse(record.observer_receive_timestamp)) ||
      !record.event || typeof record.event !== "object" || Array.isArray(record.event)) throw new Error("Invalid raw HTLC record");
  return record as RawHtlcRecord;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function eventFingerprint(record: RawHtlcRecord): string {
  return createHash("sha256").update(canonical({ node: record.node, event: record.event })).digest("hex");
}

// Keep all uint64s exact. Proto3 absent scalars decode to zero; only a payload
// with an info message can supply amounts, never a settle/final message.
export function normalizeHtlc(record: RawHtlcRecord, reference: string, startedAt: string): TraceEvent {
  const raw = record.event;
  const payloadVariant = variants.find(key => Object.hasOwn(raw, key));
  const eventType = typeof raw.event_type === "number" ? ["UNKNOWN", "SEND", "RECEIVE", "FORWARD"][raw.event_type] : string(raw.event_type) ?? "UNKNOWN";
  const type = payloadVariant === "forward_event" ? ({ SEND: "htlc_send", RECEIVE: "htlc_receive", FORWARD: "htlc_forward" }[eventType ?? ""] ?? "htlc_forward_unknown") :
    ({ forward_fail_event: "htlc_forward_fail", settle_event: "htlc_settle", link_fail_event: "htlc_link_fail",
      subscribed_event: "htlc_subscribed", final_htlc_event: "htlc_final", "": "htlc_unknown" }[payloadVariant ?? ""] ?? "htlc_unknown");
  const timestampNs = integer(raw.timestamp_ns);
  const ns = timestampNs && timestampNs !== "0" ? BigInt(timestampNs) : undefined;
  const validTime = ns !== undefined && ns / 1_000_000n <= 8_640_000_000_000_000n;
  const timestamp = validTime ? new Date(Number(ns! / 1_000_000n)).toISOString() : record.observer_receive_timestamp;
  const incomingChannelId = integer(raw.incoming_channel_id), outgoingChannelId = integer(raw.outgoing_channel_id);
  const incomingHtlcId = integer(raw.incoming_htlc_id), outgoingHtlcId = integer(raw.outgoing_htlc_id);
  const payload = object(raw[payloadVariant ?? ""]);
  const info = ["forward_event", "link_fail_event"].includes(payloadVariant ?? "") ? object(payload.info) : {};
  return {
    timestamp, relativeMs: validTime ? Number(ns! - BigInt(Date.parse(startedAt)) * 1_000_000n) / 1e6 : Date.parse(timestamp) - Date.parse(startedAt),
    observerReceiveTimestamp: record.observer_receive_timestamp, timestampNs, timestampSource: validTime ? "daemon" : "observer",
    node: record.node, layer: "lightning", type, observed: true, source: "SubscribeHtlcEvents", evidenceRefs: [reference],
    eventId: eventFingerprint(record), circuitKey: [record.node, incomingChannelId ?? "?", incomingHtlcId ?? "?", outgoingChannelId ?? "?", outgoingHtlcId ?? "?"].join(":"),
    eventType, payloadVariant, incomingChannelId, outgoingChannelId, incomingHtlcId, outgoingHtlcId,
    incomingAmountMsat: integer(info.incoming_amt_msat), outgoingAmountMsat: integer(info.outgoing_amt_msat),
    paymentPreimage: payloadVariant === "settle_event" ? hex(payload.preimage) : undefined,
    details: { incomingTimelock: integer(info.incoming_timelock), outgoingTimelock: integer(info.outgoing_timelock),
      ...(payloadVariant === "link_fail_event" ? { wireFailure: payload.wire_failure, failureDetail: payload.failure_detail, failureString: payload.failure_string } : {}),
      ...(payloadVariant === "final_htlc_event" ? { settled: payload.settled, offchain: payload.offchain } : {}) },
  };
}

export function htlcNormalizer(startedAt: string) {
  const seen = new Map<string, TraceEvent>();
  const duplicates: { eventId: string; original: string; replay: string }[] = [];
  return { duplicates, accept(record: RawHtlcRecord, reference: string): TraceEvent | undefined {
    const event = normalizeHtlc(record, reference, startedAt);
    const previous = seen.get(event.eventId!);
    if (previous) {
      duplicates.push({ eventId: event.eventId!, original: previous.evidenceRefs![0], replay: reference });
      return undefined;
    }
    seen.set(event.eventId!, event); return event;
  } };
}

export function resolveHtlcChannel(before: Snapshot, node: NodeName, id?: string): Channel | undefined {
  if (!id || id === "0") return undefined;
  const candidates = before.nodes[node]?.channels?.filter(c => c.routingIds.includes(id)) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}
const title = (name: string) => name[0].toUpperCase() + name.slice(1);
export function channelLabel(before: Snapshot, node: NodeName, id: string | undefined, direction: "incoming" | "outgoing"): string {
  if (!id || id === "0") return "—";
  const channel = resolveHtlcChannel(before, node, id);
  const peer = Object.entries(before.nodes).find(([, state]) => hex(state.info?.identity_pubkey, 33) === channel?.remotePubkey)?.[0];
  if (!channel || !peer) return `${id} (unresolved)`;
  const names = direction === "incoming" ? [peer, node] : [node, peer];
  return `${id} (${names.map(title).join(" → ")} / ${channel.commitmentType === "SIMPLE_TAPROOT_OVERLAY" ? "asset overlay" : "BTC"})`;
}

export function correlateHtlcs(events: TraceEvent[], before: Snapshot, payments: Json[], invoice?: Json, invoiceSource = "after.json") {
  const htlcs = events.filter(e => e.source === "SubscribeHtlcEvents" && e.type.startsWith("htlc_") && e.type !== "htlc_subscribed");
  const finalPayment = payments.at(-1), paymentHash = hex(finalPayment?.payment_hash);
  const paymentPreimage = hex(finalPayment?.payment_preimage), invoicePreimage = invoice?.state === "SETTLED" ? hex(invoice.r_preimage) : undefined;
  const adjacency = htlcs.map(() => new Set<number>());
  const link = (a: number, b: number) => { adjacency[a].add(b); adjacency[b].add(a); };
  const incomingMatches = (a: TraceEvent, b: TraceEvent) => a.incomingChannelId !== undefined && a.incomingChannelId !== "0" &&
    a.incomingHtlcId !== undefined && a.incomingChannelId === b.incomingChannelId && a.incomingHtlcId === b.incomingHtlcId;
  for (let i = 0; i < htlcs.length; i++) for (let j = i + 1; j < htlcs.length; j++) {
    const a = htlcs[i], b = htlcs[j];
    const completeCircuit = [a.incomingChannelId, a.incomingHtlcId, a.outgoingChannelId, a.outgoingHtlcId].every(id => id !== undefined) &&
      (a.incomingChannelId !== "0" || a.outgoingChannelId !== "0");
    if (completeCircuit && a.node === b.node && a.circuitKey === b.circuitKey) link(i, j);
    // Across nodes, require directed channel endpoints, matching channel point
    // and HTLC index. Never equate Bob's payment attempt ID to a circuit ID.
    for (const [out, inc] of [[a, b], [b, a]]) {
      if (out.node === inc.node || out.outgoingHtlcId === undefined || out.outgoingHtlcId !== inc.incomingHtlcId) continue;
      const outgoing = resolveHtlcChannel(before, out.node as NodeName, out.outgoingChannelId);
      const incoming = resolveHtlcChannel(before, inc.node as NodeName, inc.incomingChannelId);
      if (outgoing?.channelPoint && outgoing.channelPoint === incoming?.channelPoint &&
          outgoing.remotePubkey === hex(before.nodes[inc.node as NodeName]?.info?.identity_pubkey, 33) &&
          incoming.remotePubkey === hex(before.nodes[out.node as NodeName]?.info?.identity_pubkey, 33)) link(i, j);
    }
  }
  // v0.20 FINAL has only incoming IDs and UNKNOWN role. Link only if that
  // partial key resolves to one full local circuit; ambiguity stays unlinked.
  for (let i = 0; i < htlcs.length; i++) if (htlcs[i].type === "htlc_final") {
    const matches = htlcs.map((event, index) => ({ event, index })).filter(({ event }) =>
      event.node === htlcs[i].node && event.type !== "htlc_final" && incomingMatches(event, htlcs[i]));
    if (new Set(matches.map(m => m.event.circuitKey)).size === 1) for (const match of matches) link(i, match.index);
  }
  const seed = (event: TraceEvent): string[] => {
    if (!paymentHash) return [];
    const refs: string[] = [];
    if (event.paymentPreimage && createHash("sha256").update(Buffer.from(event.paymentPreimage, "hex")).digest("hex") === paymentHash) {
      refs.push(...event.evidenceRefs!, `payment.jsonl:${payments.length}`);
    }
    if (event.node === "alice" && hex(invoice?.r_hash) === paymentHash && array(invoice?.htlcs).some(h =>
      integer(h.chan_id) === event.incomingChannelId && integer(h.htlc_index) === event.incomingHtlcId && event.incomingChannelId !== "0")) refs.push(invoiceSource);
    return refs;
  };
  const visited = new Set<number>();
  const lifecycles: { nodes: string[]; circuitKeys: string[]; eventIds: string[]; evidenceRefs: string[];
    correlatedPaymentHash?: string; correlationEvidenceRefs: string[] }[] = [];
  for (let i = 0; i < htlcs.length; i++) {
    if (visited.has(i)) continue;
    const queue = [i]; visited.add(i);
    for (const index of queue) for (const next of adjacency[index]) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    const group = queue.map(index => htlcs[index]);
    const refs = [...new Set(group.flatMap(seed))];
    lifecycles.push({ nodes: [...new Set(group.map(e => e.node))], circuitKeys: [...new Set(group.map(e => e.circuitKey!))],
      eventIds: group.map(e => e.eventId!), evidenceRefs: group.flatMap(e => e.evidenceRefs!),
      correlatedPaymentHash: refs.length ? paymentHash : undefined, correlationEvidenceRefs: refs });
  }
  const nonzero = (value?: string) => value !== undefined && !/^0+$/.test(value);
  const settlements = htlcs.filter(e => e.type === "htlc_settle").map(e => ({ node: e.node, eventId: e.eventId,
    evidenceRefs: e.evidenceRefs, preimage: e.paymentPreimage,
    matchesBob: nonzero(paymentPreimage) && e.paymentPreimage ? e.paymentPreimage === paymentPreimage : null,
    matchesAlice: nonzero(invoicePreimage) && e.paymentPreimage ? e.paymentPreimage === invoicePreimage : null,
    hashesToPayment: paymentHash && e.paymentPreimage ? createHash("sha256").update(Buffer.from(e.paymentPreimage, "hex")).digest("hex") === paymentHash : null,
  }));
  return { paymentHash, method: "CORRELATED: exact preimage/hash or Alice invoice channel/HTLC pair anchors; full local circuits, unambiguous FINAL incoming circuits, and directed peer channel-point/HTLC pairs link lifecycle messages. Time proximity is never a match.", lifecycles, settlements };
}
