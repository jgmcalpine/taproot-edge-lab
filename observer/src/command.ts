import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Config, NodeName } from "./model.ts";

export type Command = { node: NodeName | "system"; category: string; file: string; args: string[]; timeoutMs?: number };
export type CommandResult = { stdout: string; stderr: string; exitCode: number | null; signal: string | null;
  startedAt: string; endedAt: string; timedOut: boolean; spawnError?: string };
export type Executor = (command: Command, onStdout?: (chunk: string) => void) => Promise<CommandResult>;

export function createExecutor(directory: string, signal?: AbortSignal): Executor {
  return async (command, onStdout) => {
    const startedAt = new Date().toISOString();
    const stdoutFd = openSync(join(directory, "raw", command.file), "w", 0o600);
    const stderrFile = command.file + ".stderr.txt";
    const stderrFd = openSync(join(directory, "raw", stderrFile), "w", 0o600);
    let stdout = "", stderr = "", timedOut = false, spawnError: string | undefined;
    const child = spawn("docker", command.args, { stdio: ["ignore", "pipe", "pipe"], signal, shell: false });
    // Raw buffers are written before decoding: no line rewriting, JSON formatting or TTY.
    child.stdout.on("data", (chunk: Buffer) => { writeSync(stdoutFd, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { writeSync(stderrFd, chunk); stderr += chunk.toString("utf8"); });
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => { const text = decoder.write(chunk); stdout += text; onStdout?.(text); });
    child.on("error", error => { spawnError = error.message; });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); }, command.timeoutMs ?? 20_000);
    const result = await new Promise<CommandResult>(resolve => child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      const tail = decoder.end(); stdout += tail; if (tail) onStdout?.(tail);
      closeSync(stdoutFd); closeSync(stderrFd);
      resolve({ stdout, stderr, exitCode, signal: exitSignal, startedAt, endedAt: new Date().toISOString(), timedOut, spawnError });
    }));
    const { stdout: _out, stderr: _err, ...metadata } = result;
    appendFileSync(join(directory, "commands.ndjson"), JSON.stringify({ ...command, executable: "docker", ...metadata,
      stdoutFile: `raw/${command.file}`, stderrFile: `raw/${stderrFile}` }) + "\n");
    return result;
  };
}

export function nodeCommand(config: Config, node: NodeName, cli: "lncli" | "litcli" | "tapcli", args: string[], file: string, category: string): Command {
  const globalArgs = cli === "lncli" ? config.lncliArgs[node] : cli === "litcli" ? config.litcliArgs : config.tapcliArgs;
  return { node, category, file, args: ["exec", "--user", config.users[node], config.containers[node]!, cli,
    ...globalArgs, "--network=regtest", ...args] };
}

export function assertCommand(result: CommandResult, command: Command): void {
  if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
    const hint = command.node === "system" ? "Check Docker Desktop and its socket permissions." :
      "Check container user, TLS path and daemon-specific macaroon path; see observer/README.md.";
    // stderr is retained locally, not echoed indiscriminately to the terminal.
    throw new Error(`${command.node}/${command.category}: ${result.timedOut ? "timed out" : result.spawnError ? "could not execute command" : `exit ${result.exitCode} (${result.signal ?? "no signal"})`}. ${hint} Evidence: raw/${command.file}.stderr.txt`);
  }
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
