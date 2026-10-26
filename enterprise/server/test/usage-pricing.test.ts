import { describe, expect, it } from "vitest";
import {
  ChatToResponsesTransformer,
  convertChatJsonToResponsesJson,
} from "../src/gateway/chat_convert.ts";
import { estimateCostUsd, findModelPrice } from "../src/gateway/pricing.ts";
import { SseUsageParser } from "../src/gateway/sse.ts";
import { readUsage } from "../src/gateway/usage.ts";

describe("gateway usage pricing", () => {
  it.each([
    "gpt-6-luna",
    "gpt-6.1-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "deepseek-v4-pro",
    "deepseek-v4.1-flash",
    "doubao-seed-2-1-pro",
    "OpenAI/GPT-6-LUNA@HIGH",
    "doubao-seed-2-1-pro-260628",
  ])("has reference prices for %s", (model) => {
    expect(findModelPrice(model)).not.toBeNull();
  });

  it("prices separate cache categories without rounding small costs to zero", () => {
    expect(estimateCostUsd("gpt-6-luna", 300, 200, 600, 100)).toBeCloseTo(
      0.0001485,
      12,
    );
    expect(estimateCostUsd("gpt-6-luna", 1, 0, 0, 0)).toBeCloseTo(
      0.0000001,
      15,
    );
    expect(estimateCostUsd("gpt-6-luna", 0, 0, 0, 0)).toBe(0);
    expect(estimateCostUsd("gpt-6-luna-custom", 1000, 0, 0, 0)).toBeNull();
    expect(findModelPrice("gpt-6-luna-pro")).toBeNull();
  });

  it("captures cache writes and the actual model from Responses SSE", () => {
    const parser = new SseUsageParser();
    parser.push(
      Buffer.from(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            model: "gpt-6-luna",
            usage: {
              input_tokens: 1000,
              output_tokens: 200,
              input_tokens_details: {
                cached_tokens: 600,
                cache_write_tokens: 100,
              },
            },
          },
        })}\n\n`,
      ),
    );
    parser.end();
    expect(parser.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 600,
      cacheCreationTokens: 100,
      model: "gpt-6-luna",
    });
  });

  it("preserves cache writes in both Chat response transports, including a trailing usage chunk", () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 600,
      cache_creation_input_tokens: 100,
    };
    const converted = convertChatJsonToResponsesJson({
      model: "deepseek-v4-pro",
      usage,
    });
    expect(readUsage(converted.usage, converted.model)).toMatchObject({
      cachedTokens: 600,
      cacheCreationTokens: 100,
      model: "deepseek-v4-pro",
    });
    const transformer = new ChatToResponsesTransformer();
    transformer.push(
      Buffer.from(
        'data: {"model":"deepseek-v4-pro","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
      ),
    );
    transformer.push(
      Buffer.from(`data: ${JSON.stringify({ choices: [], usage })}\n\n`),
    );
    transformer.end();
    expect(transformer.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 600,
      cacheCreationTokens: 100,
      model: "deepseek-v4-pro",
    });
  });

  it("ignores malformed token counts and falls through zero cache aliases", () => {
    expect(
      readUsage({
        input_tokens: 100,
        output_tokens: -1,
        input_tokens_details: { cached_tokens: 0 },
        prompt_cache_hit_tokens: 20,
        cache_write_input_tokens: Number.NaN,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      cachedTokens: 20,
      cacheCreationTokens: 0,
    });
  });
});
