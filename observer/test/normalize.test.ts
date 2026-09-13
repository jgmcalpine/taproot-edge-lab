import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JsonStream } from "../src/json-stream.ts";
import type { StreamRecord } from "../src/json-stream.ts";
import { acceptedQuoteEvents, balanceDeltas, channels, correlate, customData, hex, integer, invoiceEvents, paymentEvents, pendingChannelEvents, quoteEvent, settlementIssues } from "../src/normalize.ts";
import { renderSummary } from "../src/summary.ts";
import { changedSnapshot, config, fixture, invoice, payment, quotes, quoteText, rfqId, snapshot, stream } from "./helpers.ts";

test("frames text quote and every pretty JSON update at arbitrary chunk boundaries", () => {
  for (const size of [1, 7, 64, stream.length]) {
    const records: StreamRecord[] = [], parser = new JsonStream(r => records.push(r));
    for (let i = 0; i < stream.length; i += size) parser.push(stream.slice(i, i + size));
    parser.end();
    assert.equal(records.length, 3);
    assert.equal(records[0].kind, "text");
    assert.deepEqual(records.filter(r => r.kind === "json").map(r => r.value.status), ["IN_FLIGHT", "SUCCEEDED"]);
  }
});

test("recorded live litcli stream preserves both IN_FLIGHT updates and terminal route", () => {
  const raw = readFileSync(new URL("./fixtures/live-payment.jsonl", import.meta.url), "utf8");
  const records: StreamRecord[] = [], parser = new JsonStream(r => records.push(r));
  for (let i = 0; i < raw.length; i += 11) parser.push(raw.slice(i, i + 11));
  parser.end();
  const updates = records.filter(r => r.kind === "json");
  assert.deepEqual(updates.map(r => r.value.status), ["IN_FLIGHT", "IN_FLIGHT", "SUCCEEDED"]);
  assert.equal((updates[0].value.htlcs as unknown[]).length, 0);
  assert.equal((updates[1].value.htlcs as unknown[]).length, 1);
  assert.equal(paymentEvents(updates[2].value, "fixture").find(e => e.type === "ASSET_FIRST_HOP_SNAPSHOT")?.assetAmount, "1001");
  assert.equal(records.filter(r => r.kind === "text").length, 1);
});

test("recorded Carol settlement lag is detected without inventing a FORWARD event", () => {
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/settlement-samples.json", import.meta.url), "utf8"));
  const initial = snapshot(), settled = snapshot();
  initial.nodes = { carol: { channels: recorded.initial } };
  settled.nodes = { carol: { channels: recorded.final } };
  assert.ok(settlementIssues(initial, initial).some(i => i.includes("pending")));
  assert.deepEqual(settlementIssues(initial, settled), []);
  const h = initial.nodes.carol!.channels![0].pendingHtlcs![0];
  const events = pendingChannelEvents(initial, h.paymentHash!, "after-0.json");
  assert.equal(events.length, 1); assert.equal(events[0].node, "carol");
  assert.equal(events[0].type, "PENDING_CHANNEL_HTLC_SNAPSHOT");
  assert.equal(events[0].amountMsat, "354000");
  assert.deepEqual(pendingChannelEvents(initial, "ee".repeat(32), "after-0.json"), []);
});

test("handles escaped braces and quotes; malformed/truncated JSON is explicit", () => {
  const records: StreamRecord[] = [], parser = new JsonStream(r => records.push(r));
  parser.push(JSON.stringify({ message: 'a } \\" [ {', nested: [{ ok: true }] }) + '{}\n{bad}\n{"status":'); parser.end();
  assert.deepEqual(records.map(r => r.kind), ["json", "json", "error", "error"]);
});

test("normalizes asset amount, carrier, RFQ and attempt ID from actual final payment", () => {
  const events = paymentEvents(payment, "payment.jsonl:2");
  const asset = events.find(e => e.type === "ASSET_FIRST_HOP_SNAPSHOT")!;
  assert.equal(asset.assetAmount, "1001"); assert.equal(asset.amountMsat, "354000");
  assert.equal(asset.rfqId, rfqId); assert.equal(asset.outgoingChannelId, "122045790748672");
  assert.equal(asset.attemptId, "1"); assert.equal(asset.paymentHash, payment.payment_hash);
  assert.ok(events.every(e => e.observed));
  assert.equal(quoteEvent(quoteText, "raw/payment")?.details?.displayedMsatPerUnit, "1000");
  assert.equal(quoteEvent("maybe got some quote", "raw/payment"), undefined);
});

test("channel extraction preserves long channel ID separately from SCID and huge alias", () => {
  const [channel] = channels(fixture.channels.bob, "bob", config.assetId);
  assert.equal(channel.commitmentType, "SIMPLE_TAPROOT_OVERLAY");
  assert.equal(channel.assetLocal, "98999"); assert.equal(channel.assetRemote, "1001");
  assert.equal(channel.assetFunding, "100000"); assert.equal(channel.btcLocalSat, "96566");
  assert.equal(channel.scid, "122045790748672"); assert.equal(channel.channelId?.length, 64);
  assert.ok(channel.routingIds.includes("17592186044416000000"));
});

test("missing asset side remains unknown, other assets do not leak into target totals", () => {
  const raw = structuredClone(fixture.channels.bob);
  delete raw.channels[0].custom_channel_data.local_assets;
  raw.channels[0].custom_channel_data.remote_assets.push({ asset_id: "ff".repeat(32), amount: 999999 });
  const [channel] = channels(raw, "bob", config.assetId);
  assert.equal(channel.assetLocal, undefined); assert.equal(channel.assetRemote, "1001");
  assert.deepEqual(customData("opaque bytes"), {});
  assert.deepEqual(customData(Buffer.from('{"balances":[]}').toString("base64")), { balances: [] });
  assert.equal(integer(9007199254740992), undefined);
  assert.equal(integer("9007199254740993"), "9007199254740993");
});

test("balance changes use channel points and exact signed integer arithmetic", () => {
  const before = snapshot(), after = changedSnapshot();
  after.nodes.carol!.channels!.reverse();
  const deltas = balanceDeltas(before, after);
  assert.equal(deltas.find(d => d.node === "bob")?.assetLocal, "-1001");
  assert.equal(deltas.find(d => d.node === "carol" && d.assetId)?.assetLocal, "1001");
  assert.equal(deltas.find(d => d.node === "carol" && !d.assetId)?.btcLocalSat, "-1000");
  assert.equal(deltas.find(d => d.node === "alice")?.btcLocalSat, "1000");
  delete after.nodes.bob!.channels![0].assetLocal;
  assert.equal(balanceDeltas(before, after).find(d => d.node === "bob")?.assetLocal, undefined);
});

test("correlates hash/preimage, RFQ ID, quote SCID, routing SCID and invoice HTLC", () => {
  const events = [quoteEvent(quoteText, "quote")!, ...acceptedQuoteEvents(quotes, [payment], "quotes")];
  const result = correlate([payment], invoice, snapshot(), events);
  assert.equal(result.hashesMatch, true); assert.equal(result.preimagesMatch, true);
  assert.equal(result.preimageHashesToPaymentHash, true);
  assert.deepEqual(result.rfqIds, [rfqId]); assert.deepEqual(result.quoteLinks[0].rfqIds, [rfqId]);
  assert.equal(result.routes[0].hops[0].channelPoint, fixture.channels.bob.channels[0].channel_point);
  assert.equal(result.aliceCustomFieldsEmpty, true); assert.equal(result.rfqIdsAbsentFromInvoice, true);
  assert.equal(result.settledInvoiceHtlcs[0].channelId, "115448720982016");
  assert.equal(invoiceEvents(invoice, "invoice")[1].htlcId, "1");
});

test("never matches unrelated quote by time, or asserts absent custom fields are empty", () => {
  const unrelated = structuredClone(quotes); (unrelated.sell_quotes as any[])[0].id = "ff".repeat(32);
  assert.deepEqual(acceptedQuoteEvents(unrelated, [payment], "quotes"), []);
  const missing = structuredClone(invoice); delete (missing.htlcs as any[])[0].custom_channel_data;
  assert.equal(correlate([payment], missing, snapshot(), []).aliceCustomFieldsEmpty, false);
  missing.r_hash = "ee".repeat(32);
  assert.equal(correlate([payment], missing, snapshot(), []).hashesMatch, false);
  assert.equal(hex(Buffer.from(payment.payment_hash as string, "hex").toString("base64")), payment.payment_hash);
});

test("summary separates asset economics, carrier sats, BTC delivered and precision of fees", () => {
  const summary = renderSummary({ config, before: snapshot(), after: changedSnapshot(), payments: [payment],
    events: [quoteEvent(quoteText, "quote")!, ...acceptedQuoteEvents(quotes, [payment], "quotes")],
    status: "SUCCEEDED", errors: [], limitations: ["No live HTLC subscription"] });
  for (const fragment of ["Bob -> Carol -> Alice", "1001 asset units", "354 sats", "1000 sats", "1.001 sats / 1001 msat", "Hash comparison: MATCH", "Preimage comparison with Alice: MATCH", 'custom_records: {}', "INFERRED", "No live HTLC subscription"]) assert.ok(summary.includes(fragment), fragment);
  assert.ok(!summary.includes("OBSERVED FORWARD"));
});

test("failure/partial summary does not invent route, rate, zero balances, or BTC-only receipt", () => {
  const after = snapshot(); after.aliceInvoice = undefined;
  const summary = renderSummary({ config, before: snapshot(), after, payments: [], events: [], status: "UNKNOWN", errors: ["timeout"], limitations: [] });
  assert.ok(summary.includes("Quoted rate / invoice asset units: not observed"));
  assert.ok(summary.includes("an ordinary BTC-only receipt is not established"));
  assert.ok(summary.includes("does not establish the full successful"));
});
