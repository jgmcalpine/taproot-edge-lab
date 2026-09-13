import type { Json } from "./model.ts";

export type StreamRecord = { kind: "json"; value: Json } | { kind: "text"; value: string } | { kind: "error"; value: string };

// litcli 0.16 emits a quote TEXT line, then concatenated pretty-printed JSON
// objects, even with --json. This framer also accepts newline-delimited JSON.
export class JsonStream {
  private buffer = "";
  private position = 0;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private emit: (record: StreamRecord) => void;
  constructor(emit: (record: StreamRecord) => void) { this.emit = emit; }

  push(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.length) {
      if (this.position === 0) {
        this.buffer = this.buffer.trimStart();
        if (!this.buffer) return;
        if (this.buffer[0] !== "{") {
          const end = this.buffer.indexOf("\n");
          if (end < 0) return;
          this.emit({ kind: "text", value: this.buffer.slice(0, end).trimEnd() });
          this.buffer = this.buffer.slice(end + 1);
          continue;
        }
      }
      let complete = false;
      while (this.position < this.buffer.length) {
        const char = this.buffer[this.position++];
        if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (char === "\\") this.escaped = true;
          else if (char === '"') this.quoted = false;
        } else if (char === '"') this.quoted = true;
        else if (char === "{" || char === "[") this.depth++;
        else if (char === "}" || char === "]") this.depth--;
        if (this.depth === 0) {
          const raw = this.buffer.slice(0, this.position);
          try { this.emit({ kind: "json", value: JSON.parse(raw) }); }
          catch { this.emit({ kind: "error", value: "Invalid JSON object in payment stream" }); }
          this.buffer = this.buffer.slice(this.position); this.position = 0;
          complete = true; break;
        }
      }
      if (!complete) return;
    }
  }

  end(): void {
    if (this.buffer.trim()) this.emit(this.position ? { kind: "error", value: "Truncated JSON object in payment stream" } : { kind: "text", value: this.buffer.trim() });
    this.buffer = "";
  }
}
