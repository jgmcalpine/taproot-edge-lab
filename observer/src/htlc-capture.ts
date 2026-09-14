import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HtlcEventSource } from "./htlc-source.ts";
import { HtlcSourceError } from "./htlc-source.ts";
import type { Json, NodeName } from "./model.ts";

export type RawHtlcRecord = { observer_receive_timestamp: string; node: NodeName; event: Json };

export function captureHtlcs(source: HtlcEventSource, directory: string, timeoutMs: number,
  onRecord: (record: RawHtlcRecord, reference: string) => void, signal?: AbortSignal) {
  const controller = new AbortController();
  let stopping = false, failure: Error | undefined;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const readyNodes = new Set<NodeName>();
  const diagnostics: { node: NodeName; timestamp: string; state: string; message?: string }[] = [];
  let resolveReady: () => void, rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A later stream failure is saved and checked again immediately before payment.
  // Attach the handler at creation to avoid an unhandled rejection during setup.
  void ready.catch(() => {});
  const fail = (node: NodeName, error: unknown) => {
    if (stopping) return;
    const safe = error instanceof HtlcSourceError ? error : new HtlcSourceError(node, "capture or stream failed");
    failure ??= safe;
    diagnostics.push({ node, timestamp: new Date().toISOString(), state: "failed", message: safe.message });
    rejectReady!(safe); controller.abort();
  };
  const tasks = (["bob", "carol", "alice"] as const).map(async node => {
    const file = `raw/htlc-${node}.ndjson`;
    writeFileSync(join(directory, file), "", { mode: 0o600 });
    let line = 0;
    diagnostics.push({ node, timestamp: new Date().toISOString(), state: "connecting" });
    const timer = setTimeout(() => fail(node, new HtlcSourceError(node, "timed out waiting for subscribed_event")), timeoutMs);
    try {
      for await (const event of source.subscribe(node, controller.signal)) {
        const record = { observer_receive_timestamp: new Date().toISOString(), node, event };
        appendFileSync(join(directory, file), JSON.stringify(record) + "\n");
        onRecord(record, `${file}:${++line}`);
        if (Object.hasOwn(event, "subscribed_event")) {
          clearTimeout(timer); readyNodes.add(node);
          diagnostics.push({ node, timestamp: record.observer_receive_timestamp, state: "ready" });
          if (readyNodes.size === 3 && !failure && !controller.signal.aborted) resolveReady!();
        }
      }
      if (!stopping && !controller.signal.aborted) fail(node, new HtlcSourceError(node, "stream ended unexpectedly"));
    } catch (error) { if (!controller.signal.aborted) fail(node, error); }
    finally {
      clearTimeout(timer);
      diagnostics.push({ node, timestamp: new Date().toISOString(), state: stopping ? "canceled" : "closed" });
    }
  });
  // User cancellation during readiness must reject the gate promptly too.
  const rejectOnAbort = () => rejectReady!(failure ?? new Error("HTLC observation canceled before payment"));
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  if (controller.signal.aborted) rejectOnAbort();
  return {
    ready, diagnostics,
    assertHealthy() {
      if (failure) throw failure;
      if (controller.signal.aborted || readyNodes.size !== 3) throw new Error("All three HTLC subscriptions must be ready before payment");
    },
    async stop() {
      stopping = true; controller.abort();
      await Promise.all(tasks);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectOnAbort);
      return failure;
    },
  };
}
