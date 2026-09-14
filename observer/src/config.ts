import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { Config } from "./model.ts";

export function options(args: string[]) {
  const { values } = parseArgs({ args: args[0] === "--" ? args.slice(1) : args, options: {
    "amount-sat": { type: "string" }, invoice: { type: "string" },
    config: { type: "string" }, out: { type: "string", default: "traces" },
    help: { type: "boolean", short: "h" },
    "htlc-grace-ms": { type: "string" },
  }});
  if (values.invoice !== undefined && !values.invoice.trim()) throw new Error("--invoice must not be empty");
  if (values.invoice && values["amount-sat"]) throw new Error("Use either --invoice or --amount-sat");
  const amountSat = values["amount-sat"] ?? "1000";
  if (!/^[1-9]\d*$/.test(amountSat) || !Number.isSafeInteger(Number(amountSat) * 1000)) {
    throw new Error("--amount-sat must be a positive, safely representable integer");
  }
  const htlcGraceMs = values["htlc-grace-ms"] === undefined ? undefined : Number(values["htlc-grace-ms"]);
  if (htlcGraceMs !== undefined && (!/^\d+$/.test(values["htlc-grace-ms"]!) || !Number.isSafeInteger(htlcGraceMs) || htlcGraceMs > 5000)) {
    throw new Error("--htlc-grace-ms must be an integer from 0 to 5000");
  }
  return { amountSat, invoice: values.invoice, configPath: values.config, htlcGraceMs,
    out: resolve(values.out!), help: values.help };
}

export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = JSON.parse(readFileSync(path ?? new URL("../lab.config.json", import.meta.url), "utf8"));
  // Older complete Milestone 01 configs inherit the central HTLC defaults.
  config.htlc ??= JSON.parse(readFileSync(new URL("../lab.config.json", import.meta.url), "utf8")).htlc;
  config.assetId = env.LAB_ASSET_ID ?? config.assetId;
  config.carolPubkey = env.LAB_CAROL_PUBKEY ?? config.carolPubkey;
  config.containers ??= {};
  for (const node of ["bob", "carol", "alice", "backend1"] as const) {
    config.containers[node] = env[`LAB_${node.toUpperCase()}_CONTAINER`] ?? config.containers[node];
  }
  if (!/^[a-f0-9]{64}$/i.test(config.assetId)) throw new Error("config: assetId must be 32-byte hex");
  if (!/^(02|03)[a-f0-9]{64}$/i.test(config.carolPubkey)) throw new Error("config: carolPubkey must be compressed pubkey hex");
  config.assetId = config.assetId.toLowerCase();
  config.carolPubkey = config.carolPubkey.toLowerCase();
  if (typeof config.assetName !== "string" || !config.assetName) throw new Error("config: assetName is required");
  if (!Number.isSafeInteger(config.feeLimitSat) || config.feeLimitSat < 0) throw new Error("config: invalid feeLimitSat");
  if (!Number.isSafeInteger(config.paymentTimeoutSeconds) || config.paymentTimeoutSeconds < 1 || config.paymentTimeoutSeconds > 600) {
    throw new Error("config: paymentTimeoutSeconds must be 1–600");
  }
  const arrays = [config.litcliArgs, config.tapcliArgs];
  for (const node of ["bob", "carol", "alice"] as const) {
    if (typeof config.users?.[node] !== "string" || !config.users[node]) throw new Error(`config: missing users.${node}`);
    arrays.push(config.lncliArgs?.[node]);
    for (const paths of [config.htlc.tlsCertPaths, config.htlc.macaroonPaths]) {
      if (typeof paths?.[node] !== "string" || !/^\/[^\r\n\0]+$/.test(paths[node])) throw new Error(`config: invalid HTLC credential path for ${node}`);
    }
  }
  for (const [field, min, max] of [["containerPort", 1, 65535], ["readinessTimeoutMs", 100, 60000], ["settlementGraceMs", 0, 5000]] as const) {
    if (!Number.isSafeInteger(config.htlc[field]) || config.htlc[field] < min || config.htlc[field] > max) throw new Error(`config: invalid htlc.${field}`);
  }
  for (const args of arrays) {
    if (!Array.isArray(args) || args.some(a => typeof a !== "string" || !/^--[a-z0-9_-]+=[^\r\n]+$/.test(a) || /^--(network|chain|no-macaroons)=/.test(a))) {
      throw new Error("config: CLI arguments must be --flag=value strings; network/chain/auth disabling cannot be overridden");
    }
  }
  return config;
}

export function resolveContainers(names: string[], explicit: Config["containers"]): Required<Config["containers"]> {
  const result = { ...explicit };
  for (const node of ["bob", "carol", "alice", "backend1"] as const) {
    if (result[node]) {
      if (!names.includes(result[node]!)) throw new Error(`${node}: configured container ${result[node]} is not running`);
      continue;
    }
    const candidates = names.filter(n => new RegExp(`^polar-n\\d+-${node}$`).test(n));
    if (candidates.length !== 1) throw new Error(`${node}: expected one running Polar container; found ${candidates.length}. Set LAB_${node.toUpperCase()}_CONTAINER.`);
    result[node] = candidates[0];
  }
  if (new Set(Object.values(result)).size !== 4) throw new Error("config: node containers must be distinct");
  const prefixes = Object.values(result).map(n => /^polar-(n\d+)-/.exec(n!)?.[1]).filter(Boolean);
  if (new Set(prefixes).size > 1) throw new Error("containers belong to different Polar networks; select one network explicitly");
  return result as Required<Config["containers"]>;
}
