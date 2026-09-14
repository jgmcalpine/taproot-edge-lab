import { loadConfig, options } from "./config.ts";
import { tracePayment } from "./trace.ts";

try {
  const args = options(process.argv.slice(2));
  if (args.help) {
    console.log(`Trace one LabUSD -> BTC payment in the existing Polar regtest lab.

pnpm trace:payment [--amount-sat 1000 | --invoice '<BOLT11>']
                   [--config observer/lab.local.json] [--out traces]
                   [--htlc-grace-ms 1000]

Default: create a 1000 sat Alice invoice; pay once from Bob through Carol.
Configuration and evidence guide: observer/README.md`);
  } else {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    const result = await tracePayment(args, loadConfig(args.configPath), { progress: console.log, signal: controller.signal });
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    console.log(`${result.status}\nSummary: ${result.directory}/summary.md`);
    for (const error of result.errors) console.error(error);
    process.exitCode = result.exitCode;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
