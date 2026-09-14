import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { htlcRecords } from "./htlc-helpers.ts";
import { channelLabel, correlateHtlcs, eventFingerprint, htlcNormalizer, normalizeHtlc, parseHtlcRecord } from "../src/htlc-normalize.ts";
import { renderSummary } from "../src/summary.ts";
import { routerDefinition, mappedEndpoint } from "../src/htlc-source.ts";
import type { ServiceDefinition } from "@grpc/proto-loader";
import { changedSnapshot, config, invoice, payment, snapshot } from "./helpers.ts";

const start = "2026-09-13T22:30:15.000Z";
const normalized = () => htlcRecords.map((r, i) => normalizeHtlc(r, `raw/htlc-${r.node}.ndjson:${i + 1}`, start));

test("v0.20 binary protobuf decoding preserves payloads, default scalars, uint64 and base64 preimage", () => {
  const method = (routerDefinition["routerrpc.Router"] as ServiceDefinition).SubscribeHtlcEvents;
  assert.equal(method.path, "/routerrpc.Router/SubscribeHtlcEvents");
  assert.equal(method.responseStream, true);
  for (const record of htlcRecords) {
    const decoded = method.responseDeserialize(method.responseSerialize(record.event));
    assert.deepEqual(decoded, record.event);
    assert.deepEqual(parseHtlcRecord(JSON.stringify({ ...record, event: decoded })), record);
  }
  assert.throws(() => parseHtlcRecord('{"node":"other"}'), /Invalid raw/);
});

test("SEND normalization retains exact carrier amount, zero HTLC index and daemon/observer times", () => {
  const record = structuredClone(htlcRecords[1]); record.event.outgoing_htlc_id = "0";
  const event = normalizeHtlc(record, "raw:2", start);
  assert.equal(event.type, "htlc_send"); assert.equal(event.outgoingAmountMsat, "354000");
  assert.equal(event.outgoingHtlcId, "0"); assert.equal(event.timestampNs, "1789338617000001000");
  assert.equal(event.relativeMs, 2000.001); assert.equal(event.timestampSource, "daemon");
  assert.equal(event.observerReceiveTimestamp, record.observer_receive_timestamp);
  assert.equal(event.paymentHash, undefined);
});

test("FORWARD normalization observes both amounts in one event without asset denomination", () => {
  const event = normalized()[2];
  assert.equal(event.type, "htlc_forward"); assert.equal(event.incomingAmountMsat, "354000");
  assert.equal(event.outgoingAmountMsat, "1000000"); assert.equal(event.assetAmount, undefined);
  assert.deepEqual(event.evidenceRefs, ["raw/htlc-carol.ndjson:3"]);
});

test("RECEIVE/SETTLE exposes preimage and circuit but no amount; optional forward payload normalizes separately", () => {
  const event = normalized()[3];
  assert.equal(event.eventType, "RECEIVE"); assert.equal(event.type, "htlc_settle");
  assert.equal(event.paymentPreimage, payment.payment_preimage); assert.equal(event.incomingAmountMsat, undefined);
  assert.equal(event.outgoingAmountMsat, undefined);
  const record = structuredClone(htlcRecords[3]); delete record.event.settle_event;
  record.event.forward_event = { info: { incoming_amt_msat: "1000000" } };
  const receive = normalizeHtlc(record, "constructed", start);
  assert.equal(receive.type, "htlc_receive"); assert.equal(receive.incomingAmountMsat, "1000000");
  assert.equal(receive.outgoingAmountMsat, undefined);
});

test("FINAL preserves UNKNOWN role and incoming-only key without inheriting settle/forward fields", () => {
  const event = normalized()[6];
  assert.equal(event.type, "htlc_final"); assert.equal(event.eventType, "UNKNOWN");
  assert.equal(event.outgoingChannelId, "0"); assert.equal(event.incomingHtlcId, "7");
  assert.equal(event.details?.settled, true); assert.equal(event.details?.offchain, true);
  assert.equal(event.paymentPreimage, undefined); assert.equal(event.incomingAmountMsat, undefined);
});

test("LINK_FAIL and FORWARD_FAIL retain their distinct failure payloads", () => {
  const event = normalized()[8];
  assert.equal(event.type, "htlc_link_fail"); assert.equal(event.outgoingAmountMsat, "355000");
  assert.equal(event.details?.wireFailure, "TEMPORARY_CHANNEL_FAILURE");
  assert.equal(event.details?.failureDetail, "INSUFFICIENT_BALANCE");
  assert.equal(normalized()[9].type, "htlc_forward_fail");
  assert.equal(normalized()[9].incomingAmountMsat, undefined);
});

test("readiness zero timestamp falls back to observer time; large IDs/amounts never round", () => {
  const event = normalized()[0];
  assert.equal(event.type, "htlc_subscribed"); assert.equal(event.timestampSource, "observer");
  const record = structuredClone(htlcRecords[1]); record.event.outgoing_channel_id = "18446744073709551615";
  record.event.forward_event = { info: { outgoing_amt_msat: "9007199254740993" } };
  const large = normalizeHtlc(record, "large", start);
  assert.equal(large.outgoingChannelId, "18446744073709551615"); assert.equal(large.outgoingAmountMsat, "9007199254740993");
});

test("exact replay fingerprints ignore key order and receive time, preserve all distinct lifecycle messages", () => {
  const normalizer = htlcNormalizer(start), original = htlcRecords[2];
  const replay = { ...original, observer_receive_timestamp: "2026-09-13T22:31:00.000Z", event: Object.fromEntries(Object.entries(original.event).reverse()) };
  assert.equal(eventFingerprint(replay), eventFingerprint(original));
  assert.ok(normalizer.accept(original, "first")); assert.equal(normalizer.accept(replay, "replay"), undefined);
  assert.ok(normalizer.accept(htlcRecords[5], "settle")); assert.ok(normalizer.accept(htlcRecords[6], "final"));
  assert.ok(normalizer.accept({ ...original, event: { ...original.event, timestamp_ns: "1789338617000002999" } }, "different-time"));
  assert.ok(normalizer.accept({ ...original, node: "bob" }, "different-node"));
  assert.deepEqual(normalizer.duplicates.map(d => [d.original, d.replay]), [["first", "replay"]]);
});

test("lifecycle correlation links partial FINAL and peer circuits through verified channels and preimages", () => {
  const correlation = correlateHtlcs(normalized(), snapshot(), [payment], invoice, "invoice-evidence");
  const linked = correlation.lifecycles.filter(l => l.correlatedPaymentHash === payment.payment_hash);
  assert.equal(linked.length, 1); assert.equal(linked[0].eventIds.length, 7);
  assert.deepEqual(new Set(linked[0].nodes), new Set(["bob", "carol", "alice"]));
  assert.equal(correlation.lifecycles.filter(l => !l.correlatedPaymentHash).length, 2);
  assert.ok(correlation.settlements.every(s => s.matchesAlice && s.matchesBob && s.hashesToPayment));
  assert.ok(linked[0].correlationEvidenceRefs.includes("invoice-evidence"));
});

test("missing settle events can link through exact Alice invoice pair; no amounts/time-only matching", () => {
  const events = normalized().filter(e => e.type !== "htlc_settle");
  const linked = correlateHtlcs(events, snapshot(), [payment], invoice).lifecycles.filter(l => l.correlatedPaymentHash);
  assert.equal(linked.length, 1); assert.equal(linked[0].eventIds.length, 4);
  const unrelated = structuredClone(invoice); (unrelated.htlcs as any[])[0].htlc_index = "99";
  assert.ok(correlateHtlcs(events, snapshot(), [payment], unrelated).lifecycles.every(l => !l.correlatedPaymentHash));
  assert.equal(correlateHtlcs(events, snapshot(), [payment], invoice).settlements.length, 0);
});

test("missing circuit IDs never attach unrelated lifecycle observations to a known preimage", () => {
  const record = structuredClone(htlcRecords[3]);
  for (const key of ["incoming_channel_id", "outgoing_channel_id", "incoming_htlc_id", "outgoing_htlc_id"]) delete record.event[key];
  const settle = normalizeHtlc(record, "partial-settle", start);
  delete record.event.settle_event; record.event.forward_event = { info: { incoming_amt_msat: "1000000" } };
  const forward = normalizeHtlc(record, "partial-forward", start);
  const result = correlateHtlcs([settle, forward], snapshot(), [payment]);
  assert.equal(result.lifecycles.length, 2);
  assert.equal(result.lifecycles.filter(l => l.correlatedPaymentHash).length, 1);
});

test("channel labels resolve captured roles, aliases, direction and unresolved channels", () => {
  const before = snapshot();
  assert.equal(channelLabel(before, "carol", "122045790748672", "incoming"), "122045790748672 (Bob → Carol / asset overlay)");
  assert.equal(channelLabel(before, "carol", "115448720982016", "outgoing"), "115448720982016 (Carol → Alice / BTC)");
  before.nodes.carol!.channels![0].routingIds.push("9007199254740993");
  assert.match(channelLabel(before, "carol", "9007199254740993", "incoming"), /Bob → Carol/);
  assert.equal(channelLabel(before, "bob", "0", "incoming"), "—");
  assert.equal(channelLabel(before, "bob", "123", "outgoing"), "123 (unresolved)");
});

test("summary renders only observed lifecycle rows, source-linked transition and honest missing Alice amount", () => {
  const summary = renderSummary({ config, before: snapshot(), after: changedSnapshot(), payments: [payment], events: normalized(), status: "SUCCEEDED", errors: [], limitations: [] });
  for (const text of ["## HTLC switch timeline", "DIRECTLY OBSERVED Carol FORWARD: incoming 354,000 msat, outgoing 1,000,000 msat", "raw/htlc-carol.ndjson:3", "RECEIVE | settle_event", "UNKNOWN | final_htlc_event", "1,001 LabUSD", "not the economic value", "Alice RECEIVE amount:    not observed", "Alice LookupInvoice:     1,000,000 msat", "CORRELATED"]) assert.ok(summary.includes(text), text);
  const settleRows = summary.split("\n").filter(l => l.includes("| settle_event |"));
  assert.ok(settleRows.every(l => !l.includes("354,000 msat") && !l.includes("1,000,000 msat")));
  const missing = renderSummary({ config, before: snapshot(), after: changedSnapshot(), payments: [payment], events: [], status: "SUCCEEDED", errors: [], limitations: [] });
  assert.ok(missing.includes("no payment-correlated role event observed"));
  assert.ok(!missing.includes("DIRECTLY OBSERVED Carol FORWARD:"));
});

test("host ports are discovered from Docker, including IPv6; missing/ambiguous mappings fail", () => {
  assert.deepEqual(mappedEndpoint({ hostname: "bob", bindings: [{ HostIp: "0.0.0.0", HostPort: "23456" }] }, 10009), { hostname: "bob", target: "127.0.0.1:23456" });
  assert.equal(mappedEndpoint({ bindings: [{ HostIp: "::1", HostPort: "12345" }] }, 10009).target, "[::1]:12345");
  assert.throws(() => mappedEndpoint({ bindings: null }, 10009));
  assert.throws(() => mappedEndpoint({ bindings: [{ HostIp: "0.0.0.0", HostPort: "1" }, { HostIp: "::", HostPort: "2" }] }, 10009));
});

test("recorded live switch streams preserve Carol's modified incoming amount and explain the carrier discrepancy", () => {
  const records = readFileSync(new URL("./fixtures/live-htlc.ndjson", import.meta.url), "utf8").trim().split("\n").map(parseHtlcRecord);
  const events = records.map((record, i) => normalizeHtlc(record, `live:${i + 1}`, "2026-09-14T15:38:55.943Z"));
  assert.equal(events.length, 10);
  const carol = events.find(e => e.type === "htlc_forward")!;
  const bob = events.find(e => e.type === "htlc_send")!;
  assert.equal(bob.outgoingAmountMsat, "354000");
  assert.equal(carol.incomingAmountMsat, "1002000"); assert.equal(carol.outgoingAmountMsat, "1000000");
  assert.equal(carol.incomingHtlcId, bob.outgoingHtlcId);
  const correlation = correlateHtlcs(events, snapshot(), [payment]);
  assert.equal(correlation.lifecycles.length, 1); assert.equal(correlation.lifecycles[0].eventIds.length, 7);
  assert.equal(correlation.lifecycles[0].correlatedPaymentHash, payment.payment_hash);
  assert.ok(correlation.settlements.every(e => e.matchesBob === true));
  assert.equal(events.filter(e => e.type === "htlc_receive").length, 0);
  assert.equal(events.filter(e => e.node === "bob" && e.type === "htlc_final").length, 0);
  const summary = renderSummary({ config, before: snapshot(), after: changedSnapshot(), payments: [payment], events, status: "SUCCEEDED", errors: [], limitations: [] });
  for (const fragment of ["incoming 1,002,000 msat, outgoing 1,000,000 msat", "CORRELATED discrepancy", "NOT directly observed inside Carol", "INFERRED explanation", "interceptor request/response itself was not captured", "bob FINAL: not observed", "not the observed payment fee"]) assert.ok(summary.includes(fragment), fragment);
});
