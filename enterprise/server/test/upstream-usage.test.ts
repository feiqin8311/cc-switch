import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSub2ApiTokenCache, listUpstreamUsage } from "../src/sub2api.ts";

const config = {
  url: "https://upstream.test",
  email: "test@example.com",
  password: "test-only",
};

const row = (id: number) => ({
  id,
  api_key_id: 1,
  model: "example",
  input_tokens: 10,
  output_tokens: 2,
  cache_read_tokens: 3,
  cache_creation_tokens: 4,
  actual_cost: 0,
  total_cost: 0.1,
  created_at: "2026-11-06T12:00:00+08:00",
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSub2ApiTokenCache();
});

describe("upstream usage pagination", () => {
  it("ignores approximate totals and deduplicates overlapping pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/auth/login"))
          return Response.json({
            data: { access_token: "test", expires_in: 3600 },
          });
        const page = Number(url.searchParams.get("page"));
        const items =
          page === 1
            ? Array.from({ length: 100 }, (_, i) => row(i + 1))
            : [row(100), row(101)];
        return Response.json({ data: { items, total: 1001 } });
      }),
    );
    const result = await listUpstreamUsage(config, "2026-11-06", "2026-11-06");
    expect(result).toHaveLength(101);
    expect(result[0]).toMatchObject({
      apiKeyId: 1,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      actualCost: 0,
    });
  });

  it("rejects a page that never advances", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/auth/login"))
          return Response.json({ data: { access_token: "test" } });
        return Response.json({
          data: { items: Array.from({ length: 100 }, (_, i) => row(i + 1)) },
        });
      }),
    );
    await expect(
      listUpstreamUsage(config, "2026-11-06", "2026-11-06"),
    ).rejects.toThrow("分页重复");
  });
});
