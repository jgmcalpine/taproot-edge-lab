import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import type { Config, Json, NodeName } from "./model.ts";

export type RawHtlcEvent = Json;
export interface HtlcEventSource {
  subscribe(node: NodeName, signal: AbortSignal): AsyncIterable<RawHtlcEvent>;
}

const protoDirectory = fileURLToPath(new URL("../proto/lnd-v0.20.0-beta/", import.meta.url));
export const routerDefinition = loadSync(`${protoDirectory}/routerrpc/router.proto`, {
  includeDirs: [protoDirectory], keepCase: true, longs: String, enums: String,
  bytes: String, defaults: true, oneofs: true,
});
type RouterClient = grpc.Client & {
  subscribeHtlcEvents(request: Json, metadata: grpc.Metadata): grpc.ClientReadableStream<RawHtlcEvent>;
};
const Router = (grpc.loadPackageDefinition(routerDefinition).routerrpc as grpc.GrpcObject).Router as
  unknown as { new(target: string, credentials: grpc.ChannelCredentials, options: grpc.ChannelOptions): RouterClient };

// This boundary intentionally cannot use the trace's recording Executor. No
// stdout, stderr, metadata or credential-bearing error object escapes it.
export type DockerReader = (args: string[], signal: AbortSignal) => Promise<Buffer>;
export const readDocker: DockerReader = (args, signal) => new Promise((resolve, reject) => {
  execFile("docker", args, { encoding: "buffer", timeout: 10000, maxBuffer: 1024 * 1024, signal, shell: false },
    (error, stdout) => error ? reject(new Error("Docker credential/configuration read failed")) : resolve(stdout));
});

export class HtlcSourceError extends Error {
  constructor(node: NodeName, stage: string, code?: number) {
    super(`${node}/SubscribeHtlcEvents: ${stage}${code === undefined ? "" : ` (gRPC ${grpc.status[code] ?? code})`}. Check Docker port mapping, LND TLS certificate and macaroon paths.`);
  }
}

export function mappedEndpoint(inspect: Json, port: number): { target: string; hostname: string } {
  const bindings = inspect.bindings as { HostIp: string; HostPort: string }[] | null;
  const local = bindings?.filter(b => ["0.0.0.0", "127.0.0.1", "::", "::1", ""].includes(b.HostIp)) ?? [];
  const ports = [...new Set(local.map(b => b.HostPort))];
  if (ports.length !== 1 || !/^\d+$/.test(ports[0]) || Number(ports[0]) < 1 || Number(ports[0]) > 65535) {
    throw new Error(`No unambiguous local host mapping for ${port}/tcp`);
  }
  const ipv4 = local.some(b => ["0.0.0.0", "127.0.0.1", ""].includes(b.HostIp));
  return { target: `${ipv4 ? "127.0.0.1" : "[::1]"}:${ports[0]}`, hostname: String(inspect.hostname ?? "") };
}

export function tlsName(cert: Buffer, hostname: string, container: string): string {
  const x509 = new X509Certificate(cert);
  for (const name of [hostname, container, "localhost"]) {
    if (name && x509.checkHost(name, { subject: "never" })) return name;
  }
  throw new Error("Certificate has no SAN matching the Docker hostname, container name or localhost");
}

export function createHtlcSource(config: Config, dependencies: {
  read?: DockerReader;
  connected?: (node: NodeName, info: { target: string; tlsServerName: string }) => void;
} = {}): HtlcEventSource {
  const read = dependencies.read ?? readDocker;
  return {
    async *subscribe(node, signal) {
      let client: RouterClient | undefined, call: grpc.ClientReadableStream<RawHtlcEvent> | undefined;
      let stage = "Docker configuration/credential read failed";
      const cancel = () => call?.cancel();
      try {
        signal.throwIfAborted();
        const container = config.containers[node]!;
        const exec = (path: string) => read(["exec", "--user", config.users[node], container, "cat", path], signal);
        // Read sequentially so no credential read is left running on setup failure.
        const inspect = JSON.parse((await read(["inspect", "--format",
          `{"hostname":{{json .Config.Hostname}},"bindings":{{json (index .NetworkSettings.Ports "${config.htlc.containerPort}/tcp")}}}`,
          container], signal)).toString("utf8")) as Json;
        const endpoint = mappedEndpoint(inspect, config.htlc.containerPort);
        const cert = await exec(config.htlc.tlsCertPaths[node]);
        stage = "TLS name verification failed";
        const serverName = tlsName(cert, endpoint.hostname, container);
        stage = "LND macaroon read failed";
        const macaroon = await exec(config.htlc.macaroonPaths[node]);
        if (!macaroon.length) throw new Error("Empty macaroon");
        const metadata = new grpc.Metadata();
        metadata.set("macaroon", macaroon.toString("hex"));
        macaroon.fill(0);
        stage = "stream failed";
        signal.throwIfAborted();
        client = new Router(endpoint.target, grpc.credentials.createSsl(cert), {
          "grpc.ssl_target_name_override": serverName,
          "grpc.default_authority": serverName,
          "grpc.enable_retries": 0,
        });
        call = client.subscribeHtlcEvents({}, metadata);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        dependencies.connected?.(node, { target: endpoint.target, tlsServerName: serverName });
        for await (const event of call) yield event as RawHtlcEvent;
        if (!signal.aborted) throw new HtlcSourceError(node, "stream ended unexpectedly");
      } catch (error) {
        const code = typeof (error as grpc.ServiceError)?.code === "number" ? (error as grpc.ServiceError).code : undefined;
        // Suppress only our own cancellation. Remote cancellation remains a fault.
        if (signal.aborted && (code === grpc.status.CANCELLED || (error as Error)?.name === "AbortError")) return;
        if (error instanceof HtlcSourceError) throw error;
        throw new HtlcSourceError(node, stage, code);
      } finally {
        signal.removeEventListener("abort", cancel);
        call?.cancel();
        client?.close();
      }
    },
  };
}
