import { readUsage, type TokenUsage } from "./usage.ts";

/** Max size (UTF-16 code units ≈ bytes for JSON) of one buffered SSE event. */
export const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;

const COMPLETED = "response.completed";

/**
 * Incremental SSE parser that only looks for the Responses API
 * `response.completed` event and extracts its `response.usage`. Chunks may
 * split lines, CRLF pairs and multi-byte characters anywhere. Events larger
 * than `maxEventChars` are skipped (usage stays unknown).
 */
export class SseUsageParser {
  usage: TokenUsage | null = null;

  private readonly maxEventChars: number;
  private readonly decoder = new TextDecoder();
  private pending = "";
  /** The current line overflowed and is being discarded up to its terminator. */
  private discardingLine = false;
  /** The current event overflowed; ignore its fields until the blank line. */
  private skippingEvent = false;
  private eventName = "";
  private data: string[] = [];
  private dataChars = 0;

  constructor(maxEventChars: number = MAX_SSE_EVENT_CHARS) {
    this.maxEventChars = maxEventChars;
  }

  push(chunk: Uint8Array): void {
    this.feed(this.decoder.decode(chunk, { stream: true }));
  }

  /** Flushes the decoder and dispatches a trailing unterminated event. */
  end(): void {
    this.feed(this.decoder.decode());
    if (!this.discardingLine && this.pending !== "") this.line(this.pending);
    this.pending = "";
    this.discardingLine = false;
    this.dispatch();
  }

  private feed(text: string): void {
    if (text === "") return;
    const buf = this.pending + text;
    const re = /\r\n|\r|\n/g;
    let pos = 0;
    for (let m = re.exec(buf); m !== null; m = re.exec(buf)) {
      // A lone trailing "\r" may be the first half of a CRLF split across chunks.
      if (m[0] === "\r" && m.index === buf.length - 1) break;
      if (this.discardingLine) {
        this.discardingLine = false;
      } else {
        this.line(buf.slice(pos, m.index));
      }
      pos = m.index + m[0].length;
    }
    this.pending = buf.slice(pos);
    if (
      !this.discardingLine &&
      this.dataChars + this.pending.length > this.maxEventChars
    ) {
      this.pending = "";
      this.discardingLine = true;
      this.skipEvent();
    } else if (this.discardingLine) {
      this.pending = "";
    }
  }

  private skipEvent(): void {
    this.skippingEvent = true;
    this.data = [];
    this.dataChars = 0;
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (this.skippingEvent || line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      // Named events other than response.completed are never parsed.
      if (this.eventName !== "" && this.eventName !== COMPLETED) return;
      this.dataChars += value.length + 1;
      if (this.dataChars > this.maxEventChars) {
        this.skipEvent();
        return;
      }
      this.data.push(value);
    }
  }

  private dispatch(): void {
    const name = this.eventName;
    const data = this.data;
    const skipped = this.skippingEvent;
    this.eventName = "";
    this.data = [];
    this.dataChars = 0;
    this.skippingEvent = false;
    if (skipped || data.length === 0) return;

    const payload = data.join("\n");
    if (name !== COMPLETED && !payload.includes(COMPLETED)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as { type?: unknown; response?: { usage?: unknown } };
    if (name !== COMPLETED && obj.type !== COMPLETED) return;
    const usage = readUsage(obj.response?.usage);
    if (usage) this.usage = usage;
  }
}
