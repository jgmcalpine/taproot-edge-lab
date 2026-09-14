import { readFileSync } from "node:fs";
import type { HtlcEventSource } from "../src/htlc-source.ts";
import type { RawHtlcRecord } from "../src/htlc-capture.ts";

export const htlcRecords: RawHtlcRecord[] = JSON.parse(readFileSync(new URL("./fixtures/htlc-events.json", import.meta.url), "utf8"));
export function fixtureHtlcSource(): HtlcEventSource {
  return { async *subscribe(node, signal) {
    yield { ...htlcRecords[0].event };
    for (const record of htlcRecords.filter(r => r.node === node && !["subscribed_event", "link_fail_event", "forward_fail_event"].includes(String(r.event.event)))) yield structuredClone(record.event);
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  } };
}
