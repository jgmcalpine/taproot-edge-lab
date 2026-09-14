import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as grpc from "@grpc/grpc-js";
import { captureHtlcs } from "../src/htlc-capture.ts";
import { createHtlcSource, routerDefinition, tlsName } from "../src/htlc-source.ts";
import type { DockerReader } from "../src/htlc-source.ts";
import { config } from "./helpers.ts";
import { htlcRecords } from "./htlc-helpers.ts";

// A real, ephemeral TLS gRPC server exercises the actual adapter and protobuf
// decoder offline. These credentials are generated for the test, never Polar's.
async function serverFixture() {
  const directory = mkdtempSync(join(tmpdir(), "edge-grpc-test-"));
  const keyPath = join(directory, "test.key"), certPath = join(directory, "test.cert");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certPath, "-days", "1", "-subj", "/CN=node-fixture", "-addext", "subjectAltName=DNS:node-fixture"], { stdio: "ignore" });
  const key = readFileSync(keyPath), cert = readFileSync(certPath);
  const server = new grpc.Server();
  const calls: grpc.ServerWritableStream<object, object>[] = [];
  const metadata: string[] = [];
  let rejectCall = false;
  const service = (grpc.loadPackageDefinition(routerDefinition).routerrpc as grpc.GrpcObject).Router as grpc.ServiceClientConstructor;
  server.addService(service.service, { subscribeHtlcEvents(call: grpc.ServerWritableStream<object, object>) {
    calls.push(call); metadata.push(String(call.metadata.get("macaroon")[0]));
    if (rejectCall) { call.emit("error", { code: grpc.status.PERMISSION_DENIED, details: "do-not-serialize-this-secret" }); return; }
    call.write(htlcRecords[0].event);
    call.write(htlcRecords[2].event);
  } });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync("127.0.0.1:0",
    grpc.ServerCredentials.createSsl(null, [{ private_key: key, cert_chain: cert }]), (error, port) => error ? reject(error) : resolve(port)));
  const secret = Buffer.from("test-only-macaroon-never-in-trace");
  const read: DockerReader = async args => {
    if (args[0] === "inspect") return Buffer.from(JSON.stringify({ hostname: "node-fixture", bindings: [{ HostIp: "127.0.0.1", HostPort: String(port) }] }));
    assert.deepEqual(args.slice(0, 2), ["exec", "--user"]);
    return args.at(-1)!.endsWith("tls.cert") ? Buffer.from(cert) : Buffer.from(secret);
  };
  const trace = join(directory, "trace"); mkdirSync(join(trace, "raw"), { recursive: true, mode: 0o700 });
  return { directory, trace, server, calls, metadata, secret, cert, read,
    reject() { rejectCall = true; },
    close() { server.forceShutdown(); rmSync(directory, { recursive: true, force: true }); } };
}

test("real TLS gRPC subscription gates on readiness, sends hex macaroon in memory and cancels cleanly", { timeout: 10000 }, async () => {
  const f = await serverFixture();
  const records: unknown[] = [], connections: unknown[] = [];
  const source = createHtlcSource(config, { read: f.read, connected: (node, info) => connections.push({ node, ...info }) });
  const capture = captureHtlcs(source, f.trace, 2000, r => records.push(r));
  try {
    await capture.ready; capture.assertHealthy();
    assert.equal(f.metadata.length, 3); assert.ok(f.metadata.every(value => value === f.secret.toString("hex")));
    assert.equal(await capture.stop(), undefined);
    assert.ok(capture.diagnostics.filter(d => d.state === "canceled").length === 3);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(f.calls.every(call => call.cancelled));
    const serialized = JSON.stringify({ records, connections, diagnostics: capture.diagnostics }) +
      readdirSync(join(f.trace, "raw")).map(name => readFileSync(join(f.trace, "raw", name), "utf8")).join("");
    for (const forbidden of [f.secret.toString("hex"), f.secret.toString("base64"), f.secret.toString(), "BEGIN CERTIFICATE", "PRIVATE KEY"]) assert.ok(!serialized.includes(forbidden), forbidden);
    assert.equal(tlsName(f.cert, "node-fixture", "other-container"), "node-fixture");
    assert.throws(() => tlsName(f.cert, "unrelated", "unrelated-container"), /no SAN matching/);
  } finally { await capture.stop(); f.close(); }
});

test("remote gRPC denial before readiness preserves node/status diagnostics without metadata or server error secrets", { timeout: 10000 }, async () => {
  const f = await serverFixture(); f.reject();
  const capture = captureHtlcs(createHtlcSource(config, { read: f.read }), f.trace, 2000, () => {});
  try {
    await assert.rejects(capture.ready, /SubscribeHtlcEvents.*PERMISSION_DENIED/);
    const failure = await capture.stop(); assert.ok(failure);
    const serialized = JSON.stringify(capture.diagnostics) + failure.message;
    assert.ok(!serialized.includes("do-not-serialize-this-secret"));
    assert.ok(!serialized.includes(f.secret.toString("hex")));
  } finally { await capture.stop(); f.close(); }
});

test("credential read failures cannot serialize child-process stdout or stderr", async () => {
  const secret = "credential-read-secret";
  const source = createHtlcSource(config, { read: async () => { throw Object.assign(new Error(secret), { stdout: Buffer.from(secret), stderr: secret }); } });
  await assert.rejects(async () => {
    for await (const _event of source.subscribe("carol", new AbortController().signal)) assert.fail("No event expected");
  }, error => {
    assert.match(String(error), /carol\/SubscribeHtlcEvents/);
    assert.ok(!String(error).includes(secret)); assert.ok(!JSON.stringify(error).includes(secret)); return true;
  });
});
