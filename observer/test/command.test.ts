import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor } from "../src/command.ts";

test("command adapter preserves raw bytes and records stderr, exit status, timestamps and timeouts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "edge-command-test-")), oldPath = process.env.PATH;
  mkdirSync(join(directory, "raw"));
  const docker = join(directory, "docker");
  writeFileSync(docker, `#!/usr/bin/env node
if (process.argv[2] === 'hang') setInterval(() => {}, 1000);
else {
  const data = Buffer.from('quote α\\n{ "status": "IN_FLIGHT" }\\n');
  process.stdout.write(data.subarray(0, 7));
  setTimeout(() => { process.stdout.write(data.subarray(7)); process.stderr.write('fixture stderr\\n'); process.exitCode = 7; }, 10);
}
`);
  chmodSync(docker, 0o700); process.env.PATH = `${directory}:${oldPath}`;
  try {
    const run = createExecutor(directory), streamed: string[] = [];
    const result = await run({ node: "bob", category: "fixture", file: "output.jsonl", args: ["emit"] }, chunk => streamed.push(chunk));
    const expected = 'quote α\n{ "status": "IN_FLIGHT" }\n';
    assert.equal(readFileSync(join(directory, "raw/output.jsonl"), "utf8"), expected);
    assert.equal(result.stdout, expected); assert.equal(streamed.join(""), expected);
    assert.equal(result.stderr, "fixture stderr\n"); assert.equal(result.exitCode, 7);
    const metadata = JSON.parse(readFileSync(join(directory, "commands.ndjson"), "utf8").trim());
    assert.ok(Date.parse(metadata.endedAt) >= Date.parse(metadata.startedAt));
    assert.equal(metadata.stderrFile, "raw/output.jsonl.stderr.txt");
    const timeout = await run({ node: "bob", category: "fixture-timeout", file: "timeout.jsonl", args: ["hang"], timeoutMs: 100 });
    assert.equal(timeout.timedOut, true); assert.notEqual(timeout.exitCode, 0);
  } finally { process.env.PATH = oldPath; rmSync(directory, { recursive: true, force: true }); }
});
