import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertCommand, createExecutor, nodeCommand, writeJson } from "./command.ts";
import type { Command, Executor } from "./command.ts";
import { resolveContainers } from "./config.ts";
import { JsonStream } from "./json-stream.ts";
import { acceptedQuoteEvents, balanceDeltas, channels, correlate, hex, integer, invoiceEvents, paymentEvents, pendingChannelEvents, quoteEvent, settlementIssues } from "./normalize.ts";
import { checkInvoice, checkLiquidity, checkTopology } from "./preflight.ts";
import { renderSummary } from "./summary.ts";
import type { Config, Json, Snapshot, TraceEvent } from "./model.ts";

export const limitations = [
  "Installed LND 0.20 lncli help exposes no SubscribeHtlcEvents command. No live Bob/Carol/Alice SEND, FORWARD, RECEIVE or SETTLE notification is claimed.",
  "Bob's --json --inflight_updates stream is captured live; Alice HTLC states and accepted RFQs are queried snapshots, not subscriptions.",
  "No daemon logs are collected. Carol's internal RFQ/conversion timeline is not directly instrumented.",
  "Observer timestamps measure when records were read; node timestamps remain in event details. Repeated attempt snapshots are retained and must not be counted as separate HTLCs.",
  "The liquidity preflight uses an oracle decoder estimate plus fee allowance. It is not a binding edge quote or a reserve/pending-HTLC spendability guarantee.",
  "A stopped/timed-out docker client does not prove the daemon payment failed. UNKNOWN requires checking the saved invoice hash before another payment.",
];

export type TraceOptions = { out: string; amountSat: string; invoice?: string };
export type TraceDependencies = { executor?: (directory: string) => Executor; progress?: (message: string) => void; signal?: AbortSignal };

export async function tracePayment(options: TraceOptions, originalConfig: Config, deps: TraceDependencies = {}) {
  const config = structuredClone(originalConfig);
  const startedAt = new Date().toISOString();
  const directory = join(options.out, `${startedAt.replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(directory, "raw"), { recursive: true, mode: 0o700 });
  const errors: string[] = [], warnings: string[] = [], events: TraceEvent[] = [], payments: Json[] = [];
  const emptySnapshot = (): Snapshot => ({ startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), nodes: {}, errors: [] });
  let before = emptySnapshot(), after = emptySnapshot(), hash: string | undefined;
  let paymentAttempted = false, resolved = false, status = "NOT_ATTEMPTED", invoice = options.invoice;
  let paymentExitCode: number | null = null;
  const manifest: Json = { schemaVersion: 1, startedAt, status: "RUNNING", network: "regtest", config,
    invoiceCreated: false, paymentAttempted: false, limitations, warnings };
  const saveManifest = () => writeJson(join(directory, "manifest.json"), manifest);
  saveManifest();
  for (const file of ["commands.ndjson", "events.ndjson", "payment.jsonl", "raw/bob-payment.jsonl"]) writeFileSync(join(directory, file), "", { mode: 0o600 });
  writeJson(join(directory, "before.json"), before); writeJson(join(directory, "after.json"), after);
  let execute = deps.executor?.(directory) ?? createExecutor(directory, deps.signal);
  const emit = (event: TraceEvent) => {
    const timestamp = new Date().toISOString();
    const stamped = { ...event, timestamp, relativeMs: Date.parse(timestamp) - Date.parse(startedAt) };
    events.push(stamped); appendFileSync(join(directory, "events.ndjson"), JSON.stringify(stamped) + "\n");
  };
  const query = async (command: Command) => {
    const result = await execute(command); assertCommand(result, command);
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      return value as Json;
    } catch { throw new Error(`${command.node}/${command.category}: invalid JSON object; inspect raw/${command.file}`); }
  };
  const snapshot = async (phase: string): Promise<Snapshot> => {
    const snap = emptySnapshot();
    snap.rawSuffix = phase;
    const jobs: (() => Promise<void>)[] = [];
    for (const node of ["bob", "carol", "alice"] as const) {
      snap.nodes[node] = {};
      jobs.push(async () => { snap.nodes[node]!.info = await query(nodeCommand(config, node, "lncli", ["getinfo"], `${node}-info-${phase}.json`, "getinfo")); });
      jobs.push(async () => { snap.nodes[node]!.channels = channels(await query(nodeCommand(config, node, "lncli", ["listchannels"], `${node}-channels-${phase}.json`, "channels")), node, config.assetId); });
    }
    jobs.push(async () => { snap.bobAssetBalances = await query(nodeCommand(config, "bob", "tapcli", ["assets", "balance", "--all_script_key_types"], `bob-assets-${phase}.json`, "asset-balances")); });
    if (hash) jobs.push(async () => { snap.aliceInvoice = await query(nodeCommand(config, "alice", "lncli", ["lookupinvoice", `--rhash=${hash}`], `alice-invoice-${phase}.json`, "invoice-lookup")); });
    const results = await Promise.allSettled(jobs.map(job => job()));
    for (const result of results) if (result.status === "rejected") snap.errors.push(String(result.reason instanceof Error ? result.reason.message : result.reason));
    try { snap.bobQuotes = await query(nodeCommand(config, "bob", "tapcli", ["rfq", "acceptedquotes"], `bob-quotes-${phase}.json`, "accepted-quotes")); }
    catch (error) { warnings.push(String(error instanceof Error ? error.message : error)); }
    snap.endedAt = new Date().toISOString();
    const file = phase === "after" ? "after-0.json" : `${phase}.json`;
    writeJson(join(directory, file), snap);
    emit({ node: "system", layer: "observer", type: "SNAPSHOT_CAPTURED", observed: true, source: file, details: { phase, errors: snap.errors } });
    if (hash) for (const e of pendingChannelEvents(snap, hash, file)) emit(e);
    return snap;
  };
  try {
    deps.progress?.(`Trace: ${directory}\nChecking Docker and capturing BEFORE state…`);
    const docker: Command = { node: "system", category: "docker-containers", file: "docker-ps.jsonl", args: ["ps", "--format", '{"Names":{{json .Names}},"Image":{{json .Image}},"Status":{{json .Status}}}'] };
    const containers = await execute(docker); assertCommand(containers, docker);
    const running = containers.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Json);
    config.containers = resolveContainers(running.map(c => String(c.Names)), config.containers);
    manifest.containers = running.filter(c => Object.values(config.containers).includes(String(c.Names)));
    resolved = true; saveManifest();
    before = await snapshot("before");
    const topology = checkTopology(before, config);
    const helpCommands = [
      ...(["bob", "carol", "alice"] as const).map(node => nodeCommand(config, node, "lncli", ["--help"], `${node}-lncli-help.txt`, "cli-capabilities")),
      nodeCommand(config, "bob", "litcli", ["ln", "payinvoice", "--help"], "bob-payinvoice-help.txt", "cli-capabilities"),
      nodeCommand(config, "bob", "tapcli", ["--version"], "bob-tapcli-version.txt", "cli-version"),
      nodeCommand(config, "bob", "litcli", ["--version"], "bob-litcli-version.txt", "cli-version"),
    ];
    const helpResults = await Promise.allSettled(helpCommands.map(async command => {
      const result = await execute(command); assertCommand(result, command);
      if (command.file === "bob-payinvoice-help.txt") for (const flag of ["--inflight_updates", "--json", "--asset_id", "--rfq_peer_pubkey", "--outgoing_chan_id", "--last_hop", "--max_parts"]) {
        if (!result.stdout.includes(flag)) throw new Error(`bob/cli-capabilities: installed payinvoice lacks ${flag}`);
      }
    }));
    for (const r of helpResults) if (r.status === "rejected") throw r.reason;
    if (!invoice) {
      const created = await query(nodeCommand(config, "alice", "lncli", ["addinvoice", `--amt=${options.amountSat}`, "--memo=Taproot Edge Lab trace"], "alice-invoice-created.json", "invoice-create"));
      invoice = typeof created.payment_request === "string" ? created.payment_request : undefined;
      hash = hex(created.r_hash); manifest.invoiceCreated = true; manifest.paymentHash = hash; saveManifest();
      if (!invoice || !hash) throw new Error("alice/invoice-create: missing BOLT11 or hash; inspect saved response");
    }
    if (!/^lnbcrt/i.test(invoice)) throw new Error("alice/invoice: only Bitcoin regtest BOLT11 invoices are supported");
    const decoded = await query(nodeCommand(config, "alice", "lncli", ["decodepayreq", `--pay_req=${invoice}`], "alice-invoice-decoded.json", "invoice-decode"));
    hash = hex(decoded.payment_hash);
    if (!hash) throw new Error("alice/invoice-decode: missing payment hash");
    manifest.paymentHash = hash; saveManifest();
    before.aliceInvoice = await query(nodeCommand(config, "alice", "lncli", ["lookupinvoice", `--rhash=${hash}`], "alice-invoice-before.json", "invoice-lookup"));
    before.endedAt = new Date().toISOString(); writeJson(join(directory, "before.json"), before);
    const checked = checkInvoice(decoded, before.aliceInvoice, before);
    for (const e of invoiceEvents(before.aliceInvoice, "raw/alice-invoice-before.json")) emit(e);
    const estimate = await query(nodeCommand(config, "bob", "litcli", ["ln", "decodeassetinvoice", `--pay_req=${invoice}`, `--asset_id=${config.assetId}`], "bob-asset-estimate.json", "asset-estimate"));
    const liquidity = checkLiquidity(before, config, estimate, checked.amountMsat);
    writeJson(join(directory, "preflight.json"), { ...checked, liquidity, topology, completedAt: new Date().toISOString() });
    deps.signal?.throwIfAborted();
    deps.progress?.("Preflight passed. Capturing Bob’s RFQ/payment stream and paying Alice once…");
    const parser = new JsonStream(record => {
      if (record.kind === "json") {
        if (typeof record.value.status !== "string" || !hex(record.value.payment_hash)) {
          warnings.push("Unrecognized JSON message retained in raw/bob-payment.jsonl"); return;
        }
        payments.push(record.value);
        appendFileSync(join(directory, "payment.jsonl"), JSON.stringify(record.value) + "\n");
        for (const e of paymentEvents(record.value, `payment.jsonl:${payments.length}`)) emit(e);
      } else if (record.kind === "text") {
        const quote = quoteEvent(record.value, `raw/bob-payment.jsonl#quote-${events.filter(e => e.type === "RFQ_QUOTE_PRINTED").length + 1}`);
        if (quote) emit(quote); else if (record.value.trim()) warnings.push("Unrecognized payment stream text retained in raw/bob-payment.jsonl");
      } else errors.push(record.value);
    });
    const pay = nodeCommand(config, "bob", "litcli", ["ln", "payinvoice", `--pay_req=${invoice}`, `--asset_id=${config.assetId}`,
      `--rfq_peer_pubkey=${config.carolPubkey}`, `--fee_limit=${config.feeLimitSat}`, `--timeout=${config.paymentTimeoutSeconds}s`,
      `--outgoing_chan_id=${topology.bobAsset.scid ?? topology.bobAsset.routingIds[0]}`, `--last_hop=${config.carolPubkey}`,
      "--max_parts=1", "--force", "--json", "--inflight_updates"], "bob-payment.jsonl", "payment");
    pay.timeoutMs = (config.paymentTimeoutSeconds + 30) * 1000;
    paymentAttempted = true; manifest.paymentAttempted = true; saveManifest();
    emit({ node: "system", layer: "observer", type: "PAYMENT_COMMAND_STARTED", observed: true, paymentHash: hash, source: "commands.ndjson" });
    try {
      const result = await execute(pay, chunk => parser.push(chunk)); paymentExitCode = result.exitCode;
      assertCommand(result, pay);
    } finally { parser.end(); }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (deps.signal?.aborted && !deps.executor) execute = createExecutor(directory);
    if (resolved) {
      deps.progress?.("Capturing AFTER state and writing correlations, balance deltas, and summary…");
      // Best effort on failure too; each query has a finite timeout.
      try {
        after = await snapshot("after");
        if (payments.at(-1)?.status === "SUCCEEDED") {
          let issues = settlementIssues(before, after);
          for (let retry = 1; retry <= 3 && issues.length && !after.errors.length; retry++) {
            deps.progress?.(`Settlement is still visible as pending; taking read-only AFTER sample ${retry + 1}…`);
            await delay(500);
            after = await snapshot(`after-${retry}`);
            issues = settlementIssues(before, after);
          }
          if (issues.length) errors.push(`AFTER state did not converge within four samples: ${issues.join("; ")}`);
        }
        errors.push(...after.errors);
      }
      catch (error) { errors.push(`after snapshot: ${error instanceof Error ? error.message : String(error)}`); }
    }
    writeJson(join(directory, "after.json"), after);
    if (after.aliceInvoice) for (const e of invoiceEvents(after.aliceInvoice, `raw/alice-invoice-${after.rawSuffix}.json`)) emit(e);
    if (after.bobQuotes) for (const e of acceptedQuoteEvents(after.bobQuotes, payments, `raw/bob-quotes-${after.rawSuffix}.json`)) emit(e);
    const last = payments.at(-1);
    status = !paymentAttempted ? "NOT_ATTEMPTED" : last?.status === "SUCCEEDED" ? "SUCCEEDED" : last?.status === "FAILED" ? "FAILED" : "UNKNOWN";
    const correlation = correlate(payments, after.aliceInvoice, before, events);
    if (status === "SUCCEEDED" && (!correlation.hashesMatch || !correlation.preimagesMatch || !correlation.preimageHashesToPaymentHash)) errors.push("Settlement correlation is missing or mismatched; success evidence is incomplete.");
    if (status === "SUCCEEDED") {
      const route = correlation.routes.length === 1 ? correlation.routes[0] : undefined;
      const asset = route?.balances.find(b => hex(b.asset_id) === config.assetId);
      if (!route || route.hops.length !== 2 || route.hops[0].pubkey !== config.carolPubkey ||
        route.hops[1].pubkey !== hex(before.nodes.alice?.info?.identity_pubkey, 33) ||
        route.hops.some(h => !h.channelPoint) || !route.rfqId || !route.carrierMsat || !integer(asset?.amount)) {
        errors.push("The successful two-hop asset route, RFQ, or carrier data is missing; the full demonstration is not established.");
      }
      if (!correlation.aliceCustomFieldsEmpty || correlation.rfqIdsAbsentFromInvoice !== true) {
        errors.push("Alice's BTC-only receipt is not established by explicitly empty settled HTLC custom fields and absent RFQ IDs.");
      }
    }
    if (status === "UNKNOWN") errors.push("No terminal payment update observed. The payment may still settle; inspect this invoice hash before retrying.");
    writeJson(join(directory, "correlation.json"), correlation);
    writeJson(join(directory, "deltas.json"), balanceDeltas(before, after));
    writeFileSync(join(directory, "summary.md"), renderSummary({ config, before, after, payments, events, status, errors, limitations: [...limitations, ...warnings] }), { mode: 0o600 });
    Object.assign(manifest, { endedAt: new Date().toISOString(), status, paymentExitCode, errors, warnings,
      evidenceComplete: errors.length === 0 && paymentAttempted, normalizedPaymentUpdates: payments.length,
      normalizedEvents: events.length, paymentHash: hash });
    manifest.finalAfterSample = after.rawSuffix;
    saveManifest();
  }
  return { directory, status, errors, exitCode: status === "SUCCEEDED" && errors.length === 0 ? 0 : 1 };
}
