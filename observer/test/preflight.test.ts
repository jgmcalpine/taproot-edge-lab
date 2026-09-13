import test from "node:test";
import assert from "node:assert/strict";
import { options, resolveContainers } from "../src/config.ts";
import { checkInvoice, checkLiquidity, checkTopology } from "../src/preflight.ts";
import { config, decoded, invoice, snapshot } from "./helpers.ts";

test("discovers a complete n7 network; rejects missing, ambiguous and mixed networks", () => {
  const names = ["bob", "carol", "alice", "backend1"].map(n => `polar-n7-${n}`);
  assert.equal(resolveContainers(names, {}).bob, "polar-n7-bob");
  assert.throws(() => resolveContainers(names.slice(1), {}), /bob/);
  assert.throws(() => resolveContainers([...names, "polar-n1-bob"], {}), /found 2/);
  assert.throws(() => resolveContainers(names.map(n => n.replace("n7-bob", "n8-bob")), {}), /different Polar networks/);
});

test("CLI options reject invalid amounts and mutually exclusive invoice overrides", () => {
  assert.equal(options([]).amountSat, "1000"); assert.equal(options(["--", "--amount-sat", "1200"]).amountSat, "1200");
  for (const amount of ["0", "-1", "1.5", "1e3", "9007199254740993"]) assert.throws(() => options(["--amount-sat", amount]));
  assert.throws(() => options(["--invoice", "x", "--amount-sat", "1"]), /either/);
  assert.throws(() => options(["--invoice", ""]), /empty/);
});

test("preflight rejects unsynced, wrong-network, inactive and missing-asset topology", () => {
  assert.equal(checkTopology(snapshot(), config).bobAsset.assetLocal, "98999");
  const cases: [(s: ReturnType<typeof snapshot>) => void, RegExp][] = [
    [s => { s.nodes.bob!.info!.synced_to_chain = false; }, /fully synced/],
    [s => { s.nodes.alice!.info!.chains = [{ chain: "bitcoin", network: "mainnet" }]; }, /regtest/],
    [s => { s.nodes.bob!.channels![0].active = false; }, /active/],
    [s => { s.nodes.carol!.channels![1].active = false; }, /BTC channel/],
    [s => { s.nodes.bob!.channels![0].assetId = "ff".repeat(32); }, /LabUSD/],
  ];
  for (const [mutate, pattern] of cases) { const s = snapshot(); mutate(s); assert.throws(() => checkTopology(s, config), pattern); }
});

test("liquidity screen uses asset estimate plus fee allowance, not wallet balance or sats as units", () => {
  const before = snapshot(), estimate = { asset_amount: "2000", genesis_info: { asset_id: config.assetId } };
  assert.equal(checkLiquidity(before, config, estimate, "1000000").conservativeRequiredUnits, "3001");
  before.nodes.bob!.channels![0].assetLocal = "3000";
  before.bobAssetBalances = { asset_balances: { [config.assetId]: { balance: "999999999" } } };
  assert.throws(() => checkLiquidity(before, config, estimate, "1000000"), /conservative estimate.*3001/);
});

test("invoice must belong to Alice, be open, unexpired and have a fixed sat amount", () => {
  const open = { ...invoice, state: "OPEN" }, decode = decoded();
  assert.equal(checkInvoice(decode, open, snapshot()).amountMsat, "1000000");
  assert.throws(() => checkInvoice(decode, invoice, snapshot()), /OPEN/);
  assert.throws(() => checkInvoice({ ...decode, destination: config.carolPubkey }, open, snapshot()), /recipient/);
  assert.throws(() => checkInvoice({ ...decode, num_msat: "0" }, open, snapshot()), /positive/);
  assert.throws(() => checkInvoice({ ...decode, timestamp: "1" }, open, snapshot()), /expired/);
});
