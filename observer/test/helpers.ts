import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { channels, hex, object } from "../src/normalize.ts";
import type { Json, Snapshot } from "../src/model.ts";

export const fixture = JSON.parse(readFileSync(new URL("./fixtures/lab.json", import.meta.url), "utf8"));
export const config = loadConfig(undefined, {});
export const payment: Json = fixture.payment;
export const invoice: Json = fixture.invoice;
export const rfqId = hex(object(object((payment.htlcs as Json[])[0].route).custom_channel_data).rfq_id)!;
export const quotes: Json = { sell_quotes: [{ peer: config.carolPubkey, id: rfqId, scid: "17728331741764289321",
  asset_amount: "1500", bid_asset_rate: { coefficient: "100000000", scale: 0 }, expiry: "1789341488",
  min_transportable_msat: "355000", asset_spec: { id: config.assetId } }], buy_quotes: [] };
export const quoteText = `Got quote for 1000 asset units at 1000 msat/unit from peer ${config.carolPubkey} with SCID 17728331741764289321`;
export const inFlight: Json = { ...payment, status: "IN_FLIGHT", payment_preimage: "0".repeat(64), htlcs: [] };
// These intermediate test updates are constructed from the recorded final payment.
export const stream = quoteText + "\n" + JSON.stringify(inFlight, null, 2) + "\n" + JSON.stringify(payment, null, 2) + "\n";

export function snapshot(): Snapshot {
  return { startedAt: "2026-09-13T22:30:15.000Z", endedAt: "2026-09-13T22:30:16.000Z", errors: [],
    nodes: Object.fromEntries((["bob", "carol", "alice"] as const).map(node => [node, {
      info: structuredClone(fixture.infos[node]), channels: channels(fixture.channels[node], node, config.assetId),
    }])), bobAssetBalances: { asset_balances: {} }, bobQuotes: quotes, aliceInvoice: structuredClone(invoice) };
}

export function changedSnapshot(): Snapshot {
  const after = snapshot();
  for (const node of ["bob", "carol", "alice"] as const) for (const c of after.nodes[node]!.channels!) {
    const asset = c.assetId === config.assetId;
    const assetDelta = node === "bob" ? -1001n : 1001n;
    const btcDelta = asset ? (node === "bob" ? -354n : 354n) : (node === "carol" ? -1000n : 1000n);
    if (asset) { c.assetLocal = (BigInt(c.assetLocal!) + assetDelta).toString(); c.assetRemote = (BigInt(c.assetRemote!) - assetDelta).toString(); }
    c.btcLocalSat = (BigInt(c.btcLocalSat!) + btcDelta).toString(); c.btcRemoteSat = (BigInt(c.btcRemoteSat!) - btcDelta).toString();
  }
  return after;
}

export function decoded(): Json {
  return { payment_hash: payment.payment_hash, destination: fixture.infos.alice.identity_pubkey,
    num_msat: "1000000", num_satoshis: "1000", timestamp: String(Math.floor(Date.now() / 1000)), expiry: "86400" };
}
