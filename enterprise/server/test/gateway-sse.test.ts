import { describe, expect, it } from "vitest";
import { SseUsageParser } from "../src/gateway/sse.ts";

const completed = {
  type: "response.completed",
  response: {
    id: "resp_1",
    output: [{ type: "message", content: [{ text: "héllo 🙂" }] }],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 30,
      total_tokens: 150,
    },
  },
};

function stream(eol: string, named = true): Buffer {
  const ev = (name: string, data: unknown) =>
    `${named ? `event: ${name}${eol}` : ""}data: ${JSON.stringify(data)}${eol}${eol}`;
  return Buffer.from(
    `: keep-alive${eol}${eol}` +
      ev("response.created", { type: "response.created" }) +
      ev("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "🙂 response.completed",
      }) +
      ev("response.completed", completed),
  );
}

const expected = {
  inputTokens: 120,
  outputTokens: 30,
  cachedTokens: 20,
  cacheCreationTokens: 0,
};

describe("SseUsageParser", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    for (const named of [true, false]) {
      it(`finds usage at every split point (eol=${JSON.stringify(eol)}, named=${named})`, () => {
        const buf = stream(eol, named);
        for (let i = 0; i <= buf.length; i++) {
          const p = new SseUsageParser();
          p.push(buf.subarray(0, i));
          p.push(buf.subarray(i));
          p.end();
          expect(p.usage, `split at ${i}`).toEqual(expected);
        }
      });
    }
  }

  it("handles byte-by-byte delivery and a missing final blank line", () => {
    const buf = Buffer.from(`data: ${JSON.stringify(completed)}`);
    const p = new SseUsageParser();
    for (const b of buf) p.push(Uint8Array.of(b));
    expect(p.usage).toBeNull();
    p.end();
    expect(p.usage).toEqual(expected);
  });

  it("joins multi-line data fields", () => {
    const json = JSON.stringify(completed, null, 2).split("\n");
    const text = `event: response.completed\n${json.map((l) => `data: ${l}`).join("\n")}\n\n`;
    const p = new SseUsageParser();
    p.push(Buffer.from(text));
    expect(p.usage).toEqual(expected);
  });

  it("skips events larger than the cap but keeps parsing later ones", () => {
    const big = {
      ...completed,
      response: { ...completed.response, pad: "x".repeat(5000) },
    };
    const small = {
      ...completed,
      response: { usage: { input_tokens: 1, output_tokens: 2 } },
    };
    const text =
      `event: response.completed\ndata: ${JSON.stringify(big)}\n\n` +
      `data: ${JSON.stringify(big)}\n\n`;
    const p = new SseUsageParser(1000);
    const buf = Buffer.from(text);
    for (let i = 0; i < buf.length; i += 300) p.push(buf.subarray(i, i + 300));
    expect(p.usage).toBeNull();
    p.push(Buffer.from(`data: ${JSON.stringify(small)}\n\n`));
    expect(p.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("ignores malformed json and other event types", () => {
    const p = new SseUsageParser();
    p.push(
      Buffer.from(
        'event: response.completed\ndata: {"type":"response.completed",\n\n' +
          `event: response.failed\ndata: ${JSON.stringify(completed)}\n\n`,
      ),
    );
    p.end();
    expect(p.usage).toBeNull();
  });
});
