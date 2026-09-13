import { array, hex, integer, object } from "./normalize.ts";
import type { Config, Json, Snapshot } from "./model.ts";

export function checkTopology(before: Snapshot, config: Config) {
  if (before.errors.length) throw new Error(`preflight: ${before.errors.join("; ")}`);
  for (const node of ["bob", "carol", "alice"] as const) {
    const info = before.nodes[node]?.info;
    if (!hex(info?.identity_pubkey, 33)) throw new Error(`${node}/getinfo: missing identity pubkey`);
    if (!array(info?.chains).some(c => c.chain === "bitcoin" && c.network === "regtest")) throw new Error(`${node}/getinfo: expected Bitcoin regtest`);
    if (info?.synced_to_chain !== true) throw new Error(`${node}/getinfo: wallet is not fully synced; tracer will not mine or repair it`);
  }
  if (hex(before.nodes.carol?.info?.identity_pubkey, 33) !== config.carolPubkey) throw new Error("carol/getinfo: pubkey differs from configured RFQ peer; update config");
  const bobKey = hex(before.nodes.bob?.info?.identity_pubkey, 33), aliceKey = hex(before.nodes.alice?.info?.identity_pubkey, 33);
  if (new Set([bobKey, config.carolPubkey, aliceKey]).size !== 3) throw new Error("preflight: Bob, Carol and Alice must be distinct nodes");
  const bob = before.nodes.bob?.channels?.filter(c => c.active && c.remotePubkey === config.carolPubkey && c.commitmentType === "SIMPLE_TAPROOT_OVERLAY" && c.assetId === config.assetId) ?? [];
  if (bob.length !== 1) throw new Error(`bob/channels: expected one active ${config.assetName} SIMPLE_TAPROOT_OVERLAY channel to Carol; found ${bob.length}`);
  const asset = bob[0];
  const carolAsset = before.nodes.carol?.channels?.find(c => c.active && c.remotePubkey === bobKey && c.channelPoint === asset.channelPoint && c.assetId === config.assetId);
  if (!carolAsset) throw new Error("carol/channels: matching active Bob asset channel not found");
  const btc = before.nodes.carol?.channels?.filter(c => c.active && c.remotePubkey === aliceKey && c.commitmentType !== "SIMPLE_TAPROOT_OVERLAY" && !c.assetId) ?? [];
  if (btc.length !== 1) throw new Error(`carol/channels: expected one active ordinary BTC channel to Alice; found ${btc.length}`);
  const alice = before.nodes.alice?.channels?.find(c => c.active && c.channelPoint === btc[0].channelPoint && c.remotePubkey === config.carolPubkey);
  if (!alice) throw new Error("alice/channels: matching active Carol BTC channel not found");
  if (!object(object(before.bobAssetBalances).asset_balances)[config.assetId] && !asset.assetFunding) {
    throw new Error(`bob/assets: configured asset ID ${config.assetId} was not found`);
  }
  if (!asset.assetLocal || BigInt(asset.assetLocal) === 0n) throw new Error("bob/channels: no known spendable channel-side asset balance");
  if (!asset.scid && !asset.routingIds.length) throw new Error("bob/channels: missing routing SCID");
  for (const c of [asset, carolAsset, btc[0], alice]) {
    if (!c.pendingHtlcs || c.pendingHtlcs.length || c.btcUnsettledSat !== "0") throw new Error(`${c.node}/channels: target channel has pending or unknown HTLC state; wait for a quiet lab before tracing`);
  }
  return { bobAsset: asset, carolAsset, carolBtc: btc[0], aliceBtc: alice };
}

export function checkInvoice(decoded: Json, invoice: Json, before: Snapshot): { hash: string; amountMsat: string } {
  const hash = hex(decoded.payment_hash), amountMsat = integer(decoded.num_msat);
  if (!hash || hash !== hex(invoice.r_hash)) throw new Error("alice/invoice: decoded hash does not match Alice's lookupinvoice");
  if (hex(decoded.destination, 33) !== hex(before.nodes.alice?.info?.identity_pubkey, 33)) throw new Error("alice/invoice: recipient is not configured Alice");
  if (invoice.state !== "OPEN") throw new Error(`alice/invoice: expected OPEN invoice, found ${invoice.state}; do not retry a settled payment`);
  if (!amountMsat || BigInt(amountMsat) === 0n || BigInt(amountMsat) % 1000n !== 0n) throw new Error("alice/invoice: v1 requires a positive whole-satoshi invoice");
  if (invoice.is_amp === true || invoice.is_blinded === true) throw new Error("alice/invoice: v1 requires an ordinary unblinded BOLT11 invoice");
  const created = integer(decoded.timestamp), expiry = integer(decoded.expiry);
  if (!created || !expiry || BigInt(created) + BigInt(expiry) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("alice/invoice: expired or missing expiry");
  return { hash, amountMsat };
}

export function checkLiquidity(before: Snapshot, config: Config, estimate: Json, amountMsat: string) {
  const topology = checkTopology(before, config);
  const units = integer(estimate.asset_amount);
  if (hex(object(estimate.genesis_info).asset_id) !== config.assetId || !units || BigInt(units) <= 0n) throw new Error("bob/asset-estimate: missing positive estimate for configured asset");
  // A deliberately conservative screen, not a binding Carol quote. The quote can
  // change between decode and send. Include the full fee allowance and rounding.
  const amount = BigInt(amountMsat), withFees = amount + BigInt(config.feeLimitSat) * 1000n;
  const required = (BigInt(units) * withFees + amount - 1n) / amount + 1n;
  if (BigInt(topology.bobAsset.assetLocal!) < required) throw new Error(`bob/liquidity: channel has ${topology.bobAsset.assetLocal} asset units; conservative estimate including fee allowance requires ${required}. Wallet assets are not channel liquidity.`);
  if (!topology.carolBtc.btcLocalSat || BigInt(topology.carolBtc.btcLocalSat) * 1000n < amount) throw new Error("carol/liquidity: BTC local balance is below invoice amount");
  return { invoiceAssetUnits: units, conservativeRequiredUnits: required.toString(),
    method: "ceil(decodeassetinvoice units × (invoice msat + fee limit msat) / invoice msat) + 1", binding: false };
}
