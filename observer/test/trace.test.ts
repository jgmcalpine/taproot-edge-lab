import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tracePayment } from "../src/trace.ts";
import type { Command, Executor } from "../src/command.ts";
import { config, decoded, fixture, invoice, payment, quotes, stream } from "./helpers.ts";
import { fixtureHtlcSource, htlcRecords } from "./htlc-helpers.ts";
import type { HtlcEventSource } from "../src/htlc-source.ts";
import { HtlcSourceError } from "../src/htlc-source.ts";

function fake(directory: string, seen: Command[], mode: "success" | "inactive" | "truncated" | "failed" | "mismatch" | "pending" | "missing-custom" | "missing-route" = "success"): Executor {
  return async (command, onStdout) => {
    seen.push(command);
    let value: unknown = {}, stdout = "", exitCode = 0;
    if (command.category === "docker-containers") stdout = ["bob", "carol", "alice", "backend1"].map(n => JSON.stringify({ Names: `polar-n7-${n}`, Image: "fixture" })).join("\n");
    else if (command.category === "getinfo") value = fixture.infos[command.node];
    else if (command.category === "channels") {
      value = structuredClone(fixture.channels[command.node]);
      if (mode === "inactive" && command.node === "bob") (value as any).channels[0].active = false;
      if (mode === "pending" && command.file === "carol-channels-after.json") {
        (value as any).channels[0].pending_htlcs = [{ hash_lock: payment.payment_hash, htlc_index: "1", incoming: true, amount: "354" }];
        (value as any).channels[0].unsettled_balance = "354";
      }
    } else if (command.category === "invoice-create") value = { r_hash: payment.payment_hash, payment_request: "lnbcrt-fixture-not-payable" };
    else if (command.category === "invoice-decode") value = decoded();
    else if (command.category === "invoice-lookup") { value = structuredClone({ ...invoice,
      state: command.file.includes("before") || ["truncated", "failed"].includes(mode) ? "OPEN" : "SETTLED",
      ...(mode === "mismatch" && command.file.includes("after") ? { r_hash: "ee".repeat(32) } : {}) });
      if (mode === "missing-custom") delete (value as any).htlcs[0].custom_channel_data;
    }
    else if (command.category === "asset-estimate") value = { asset_amount: "1000", genesis_info: { asset_id: config.assetId } };
    else if (command.category === "accepted-quotes") value = quotes;
    else if (command.category === "cli-capabilities") stdout = "--inflight_updates --json --asset_id --rfq_peer_pubkey --outgoing_chan_id --last_hop --max_parts";
    else if (command.category === "payment") {
      stdout = mode === "truncated" ? stream.slice(0, -100) : mode === "failed" ? JSON.stringify({ ...payment, status: "FAILED", payment_preimage: "0".repeat(64), htlcs: [] }) : stream;
      if (mode === "missing-route") stdout = JSON.stringify({ ...payment, htlcs: [] });
      if (["truncated", "failed"].includes(mode)) exitCode = 1;
    }
    stdout ||= JSON.stringify(value);
    writeFileSync(join(directory, "raw", command.file), stdout);
    writeFileSync(join(directory, "raw", command.file + ".stderr.txt"), exitCode ? "fixture failure" : "");
    if (onStdout) for (let i = 0; i < stdout.length; i += 37) onStdout(stdout.slice(i, i + 37));
    const result = { stdout, stderr: "", exitCode, signal: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), timedOut: false };
    appendFileSync(join(directory, "commands.ndjson"), JSON.stringify({ ...command, ...result }) + "\n");
    return result;
  };
}

for (const mode of ["success", "inactive", "truncated", "failed", "mismatch", "pending", "missing-custom", "missing-route"] as const) {
  test(`full orchestration with injected executor: ${mode}`, async () => {
    const out = mkdtempSync(join(tmpdir(), "edge-trace-test-")), seen: Command[] = [];
    try {
      const result = await tracePayment({ out, amountSat: "1000", htlcGraceMs: 0 }, config, { executor: dir => fake(dir, seen, mode), htlcSource: fixtureHtlcSource() });
      const manifest = JSON.parse(readFileSync(join(result.directory, "manifest.json"), "utf8"));
      assert.equal(result.exitCode, ["success", "pending"].includes(mode) ? 0 : 1);
      assert.equal(result.status, mode === "inactive" ? "NOT_ATTEMPTED" : mode === "truncated" ? "UNKNOWN" : mode === "failed" ? "FAILED" : "SUCCEEDED");
      assert.ok(readFileSync(join(result.directory, "summary.md"), "utf8").includes("# Payment Trace"));
      assert.ok(seen.some(c => c.file === "bob-channels-after.json"));
      assert.equal(seen.filter(c => c.category === "payment").length, mode === "inactive" ? 0 : 1);
      assert.equal(seen.filter(c => c.category === "invoice-create").length, mode === "inactive" ? 0 : 1);
      assert.ok(!seen.some(c => c.args.some(a => /^(mint|openchannel|fundchannel|generatetoaddress)$/.test(a))));
      if (mode === "success") {
        assert.equal(readFileSync(join(result.directory, "raw", "bob-payment.jsonl"), "utf8"), stream);
        assert.equal(manifest.normalizedPaymentUpdates, 2);
        assert.equal(JSON.parse(readFileSync(join(result.directory, "correlation.json"), "utf8")).preimagesMatch, true);
        const pay = seen.find(c => c.category === "payment")!;
        assert.ok(pay.args.includes("--max_parts=1")); assert.ok(pay.args.includes("--outgoing_chan_id=122045790748672"));
      }
      if (mode === "pending") {
        assert.equal(manifest.finalAfterSample, "after-1");
        assert.ok(readFileSync(join(result.directory, "after-0.json"), "utf8").includes('"btcUnsettledSat": "354"'));
        assert.ok(readFileSync(join(result.directory, "events.ndjson"), "utf8").includes("PENDING_CHANNEL_HTLC_SNAPSHOT"));
        assert.ok(seen.some(c => c.file === "carol-channels-after-1.json"));
      }
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
}

for (const mode of ["ready", "failure", "timeout", "failure-after-ready", "failure-during-payment"] as const) {
  test(`HTLC orchestration gate: ${mode}`, async () => {
    const out = mkdtempSync(join(tmpdir(), "edge-htlc-gate-")), seen: Command[] = [];
    const ready = new Set<string>(), closed = new Set<string>();
    let failLater: (() => void) | undefined;
    const source: HtlcEventSource = { async *subscribe(node, signal) {
      try {
        if (mode === "failure" && node === "carol") throw new HtlcSourceError(node, "fixture connection failed");
        if (mode === "timeout" && node === "carol") {
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return;
        }
        // Alice deliberately becomes ready last.
        if (node === "alice") await new Promise(resolve => setTimeout(resolve, 15));
        ready.add(node); yield htlcRecords[0].event;
        if (node === "carol" && mode.startsWith("failure-")) {
          await new Promise<void>(resolve => { failLater = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
          if (!signal.aborted) throw new HtlcSourceError(node, "fixture disconnected");
        } else {
          for await (const event of fixtureHtlcSource().subscribe(node, signal)) yield event;
        }
      } finally { closed.add(node); }
    } };
    try {
      const local = structuredClone(config); local.htlc.readinessTimeoutMs = 75;
      const result = await tracePayment({ out, amountSat: "1000", htlcGraceMs: 20 }, local, { htlcSource: source, executor: directory => {
        const run = fake(directory, seen);
        return async (command, output) => {
          if (command.category === "invoice-create" || command.category === "payment") assert.equal(ready.size, 3);
          if (command.category === "asset-estimate" && mode === "failure-after-ready" || command.category === "payment" && mode === "failure-during-payment") {
            failLater!(); await new Promise(resolve => setTimeout(resolve, 5));
          }
          if (command.file === "bob-channels-after.json") assert.equal(closed.size, 3);
          return run(command, output);
        };
      } });
      const attempted = mode === "ready" || mode === "failure-during-payment";
      assert.equal(seen.filter(c => c.category === "payment").length, attempted ? 1 : 0);
      assert.equal(result.exitCode, mode === "ready" ? 0 : 1);
      assert.equal(closed.size, 3);
      if (!attempted) assert.equal(result.status, "NOT_ATTEMPTED");
      if (mode === "failure" || mode === "timeout") assert.equal(seen.filter(c => c.category === "invoice-create").length, 0);
      if (mode !== "ready") assert.match(result.errors.join(" "), /carol\/SubscribeHtlcEvents/);
      if (mode === "ready") {
        const events = readFileSync(join(result.directory, "events.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.equal(events.filter(e => e.type === "htlc_subscribed").length, 3);
        const started = events.find(e => e.type === "PAYMENT_COMMAND_STARTED");
        const gate = events.find(e => e.type === "HTLC_SUBSCRIPTIONS_READY");
        assert.ok(Date.parse(gate.observerReceiveTimestamp) <= Date.parse(started.observerReceiveTimestamp));
        assert.ok(events.every((e, i) => !i || events[i - 1].relativeMs <= e.relativeMs));
      }
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
}
