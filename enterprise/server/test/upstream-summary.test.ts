import { UpstreamUsageSummaryResponseSchema } from "@ccse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.ts";
import { users } from "../src/db/schema.ts";
import { clearSub2ApiTokenCache } from "../src/sub2api.ts";
import {
  readUpstreamSummary,
  readUpstreamUsageOptions,
} from "../src/usage/read-upstream-summary.ts";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

const cfg = {
  url: "https://upstream.test",
  email: "admin@example.test",
  password: "test-only",
};
const query = {
  from: "2026-11-04",
  to: "2026-11-10",
  userIds: [] as string[],
  groups: [] as string[],
  providerIds: [] as string[],
};
const stats = (requests = 2) => ({
  total_requests: requests,
  total_input_tokens: requests * 100,
  total_output_tokens: requests * 10,
  total_tokens: requests * 135,
});

function mockApi(handler: (url: URL) => unknown = () => stats()) {
  const paths: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/auth/login")
        return Response.json({ data: { access_token: "test" } });
      paths.push(url);
      return Response.json({ data: handler(url) });
    }),
  );
  return paths;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSub2ApiTokenCache();
});

describe("upstream overview API", () => {
  it("loads scoped filter names without returning upstream credentials or usage logs", async () => {
    const paths = mockApi((url) => {
      if (url.pathname === "/api/v1/keys")
        return {
          total: 2,
          items: [
            {
              id: 1,
              name: "Alice",
              key: "secret-key",
              group_id: 7,
              group: { name: "group-a" },
            },
            {
              id: 2,
              name: "Bob",
              key: "other-secret",
              group_id: 8,
              group: { name: "group-b" },
            },
          ],
        };
      if (url.pathname === "/api/v1/admin/accounts")
        return {
          items: [
            { id: 45, name: "One", credentials: { password: "secret" } },
            { id: 46, name: "Two" },
          ],
          total: 2,
        };
      if (url.pathname === "/api/v1/admin/groups")
        return {
          items: [
            { id: 7, name: "group-a" },
            { id: 8, name: "group-b" },
          ],
          total: 2,
        };
      throw new Error("Unexpected endpoint");
    });
    expect(await readUpstreamUsageOptions(cfg, "group-a", [45])).toEqual({
      users: [{ id: "upstream-key:1", username: "Alice" }],
      groups: ["group-a"],
      providers: ["One"],
    });
    expect(paths.map((url) => url.pathname).sort()).toEqual([
      "/api/v1/admin/accounts",
      "/api/v1/admin/groups",
      "/api/v1/keys",
    ]);
  });
  it("reads the four aggregates in one request with the selected UTC dates", async () => {
    const paths = mockApi();
    expect(await readUpstreamSummary(cfg, query)).toEqual({
      requests: 2,
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 270,
    });
    expect(paths).toHaveLength(1);
    expect(paths[0]?.pathname).toBe("/api/v1/admin/usage/stats");
    expect(Object.fromEntries(paths[0]?.searchParams ?? [])).toEqual({
      start_date: query.from,
      end_date: query.to,
      timezone: "UTC",
    });
  });

  it("combines selected keys, accounts and groups without fetching usage logs", async () => {
    const paths = mockApi((url) => {
      if (url.pathname === "/api/v1/admin/accounts")
        return { items: [{ id: 45, name: "One" }], total: 1 };
      if (url.pathname === "/api/v1/admin/groups")
        return { items: [{ id: 7, name: "group-a" }], total: 1 };
      expect(url.pathname).toBe("/api/v1/admin/usage/stats");
      expect(url.searchParams.get("account_id")).toBe("45");
      expect(url.searchParams.get("group_id")).toBe("7");
      return stats();
    });
    const result = await readUpstreamSummary(cfg, {
      ...query,
      userIds: ["upstream-key:1", "upstream-key:2", "upstream-key:1"],
      providerIds: ["One"],
      groups: ["group-a"],
    });
    expect(result.requests).toBe(4);
    expect(
      paths
        .filter((url) => url.pathname.endsWith("/stats"))
        .map((url) => url.searchParams.get("api_key_id")),
    ).toEqual(["1", "2"]);
  });

  it("subtracts named groups for an ungrouped filter and preserves a valid zero", async () => {
    mockApi((url) => {
      if (url.pathname === "/api/v1/admin/groups")
        return { items: [{ id: 7, name: "group-a" }], total: 1 };
      return stats(url.searchParams.has("group_id") ? 2 : 3);
    });
    expect(
      (await readUpstreamSummary(cfg, { ...query, groups: [""] })).requests,
    ).toBe(1);
    mockApi(() => stats(0));
    expect(await readUpstreamSummary(cfg, query)).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it("does not turn a CC user filter into unrestricted upstream data", async () => {
    const paths = mockApi();
    expect(
      (await readUpstreamSummary(cfg, { ...query, userIds: ["cc-user"] }))
        .requests,
    ).toBe(0);
    expect(paths).toHaveLength(0);
  });

  it("fails on missing aggregates instead of silently displaying zero", async () => {
    mockApi(() => ({ total_requests: 2 }));
    await expect(readUpstreamSummary(cfg, query)).rejects.toThrow();
  });

  it("serves an overview without a database URL or any usage log pagination", async () => {
    const paths = mockApi();
    const ctx = await setup({
      SUB2API_URL: cfg.url,
      SUB2API_EMAIL: cfg.email,
      SUB2API_PASSWORD: cfg.password,
    });
    try {
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/admin/usage/upstream/summary",
        headers: bearer(session.accessToken),
        payload: query,
      });
      expect(response.statusCode).toBe(200);
      expect(
        UpstreamUsageSummaryResponseSchema.parse(response.json()),
      ).toMatchObject({
        configured: true,
        totals: { requests: 2, totalTokens: 270 },
      });
      expect(paths.map((url) => url.pathname)).toEqual([
        "/api/v1/admin/usage/stats",
      ]);
      const invalid = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/admin/usage/upstream/summary",
        headers: bearer(session.accessToken),
        payload: { ...query, from: "2026-02-30" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(paths).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it("enforces the leader's group and never retries a failed summary through log scans", async () => {
    const paths = mockApi((url) => {
      if (url.pathname === "/api/v1/admin/groups")
        return { items: [{ id: 7, name: "group-a" }], total: 1 };
      expect(url.searchParams.get("group_id")).toBe("7");
      throw new Error("upstream unavailable");
    });
    const ctx = await setup({
      SUB2API_URL: cfg.url,
      SUB2API_EMAIL: cfg.email,
      SUB2API_PASSWORD: cfg.password,
    });
    try {
      await ctx.db.insert(users).values({
        username: "leader",
        displayName: "leader",
        passwordHash: await hashPassword("password-123"),
        role: "group_leader",
        groupName: "group-a",
      });
      const session = await login(ctx.app, "leader", "password-123");
      const request = {
        method: "POST" as const,
        url: "/api/v1/admin/usage/upstream/summary",
        headers: bearer(session.accessToken),
        payload: query,
      };
      const response = await ctx.app.inject(request);
      expect(response.statusCode).toBe(502);
      expect(paths.map((url) => url.pathname)).toEqual([
        "/api/v1/admin/groups",
        "/api/v1/admin/usage/stats",
      ]);
      paths.length = 0;
      const outsideGroup = await ctx.app.inject({
        ...request,
        payload: { ...query, groups: ["group-b"] },
      });
      expect(outsideGroup.statusCode).toBe(200);
      expect(outsideGroup.json().totals.requests).toBe(0);
      expect(paths).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });
});
