import { describe, expect, it } from "vitest";
import {
  matchUpstreamUsage,
  type UsageMatchCandidate,
} from "../src/usage/match-upstream.ts";

const row = (
  id: string,
  changes: Partial<UsageMatchCandidate> = {},
): UsageMatchCandidate => ({
  id,
  keyId: 1,
  model: "gpt-6-sol",
  inputTokens: 100,
  outputTokens: 10,
  timestampMs: 1_000_000,
  ...changes,
});

describe("matching upstream usage", () => {
  it("matches a shared request id even if usage differs", () => {
    expect(
      matchUpstreamUsage(
        [row("cc", { requestId: "r" })],
        [row("up", { requestId: "r", outputTokens: 12 })],
      ),
    ).toEqual([
      { gatewayId: "cc", upstreamId: "up", confidence: "request-id" },
    ]);
  });
  it("labels unique token and time matches as probable", () => {
    expect(
      matchUpstreamUsage([row("cc")], [row("up", { timestampMs: 1_010_000 })]),
    ).toEqual([{ gatewayId: "cc", upstreamId: "up", confidence: "probable" }]);
  });
  it("does not pair ambiguous, zero-token, different-key or distant records", () => {
    expect(matchUpstreamUsage([row("cc")], [row("a"), row("b")])).toEqual([]);
    expect(
      matchUpstreamUsage(
        [row("cc", { inputTokens: 0, outputTokens: 0 })],
        [row("up", { inputTokens: 0, outputTokens: 0 })],
      ),
    ).toEqual([]);
    expect(matchUpstreamUsage([row("cc")], [row("up", { keyId: 2 })])).toEqual(
      [],
    );
    expect(
      matchUpstreamUsage(
        [row("cc", { requestId: "one" })],
        [row("up", { requestId: "two" })],
      ),
    ).toEqual([]);
    expect(
      matchUpstreamUsage([row("cc")], [row("up", { timestampMs: 1_120_001 })]),
    ).toEqual([]);
  });
});
