import { describe, expect, it, vi } from "vitest";
import type { UserRow } from "../src/db/schema.ts";
import { visibleUpstreamAccounts } from "../src/routes/upstream.ts";
import {
  accountFromSub2Api,
  clearSub2ApiTokenCache,
  listUpstreamAccounts,
} from "../src/sub2api.ts";

function user(role: UserRow["role"], ids: number[]): UserRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    username: "u",
    displayName: "u",
    passwordHash: "x",
    role,
    adminMenus: null,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    upstreamAccountIds: ids,
    groupName: "",
    offboardedAt: null,
    offboardedBy: null,
  };
}

describe("accountFromSub2Api", () => {
  it("merges extra percents with usage batch windows", () => {
    const acc = accountFromSub2Api(
      {
        id: 39,
        name: "Feiqin-Gpt",
        platform: "openai",
        type: "oauth",
        status: "active",
        schedulable: true,
        concurrency: 1,
        current_concurrency: 0,
        groups: [{ name: "openai-default" }],
        extra: {
          email: "a@example.com",
          codex_5h_used_percent: 0,
          codex_7d_used_percent: 3,
          codex_5h_reset_after_seconds: 14000,
          codex_7d_reset_after_seconds: 480000,
        },
      },
      {
        five_hour: {
          utilization: 0,
          remaining_seconds: 13800,
          resets_at: "2026-10-14T20:00:00+08:00",
          window_stats: {
            requests: 2,
            tokens: 9800,
            cost: 0.01,
            user_cost: 0.01,
          },
        },
        seven_day: {
          utilization: 3,
          remaining_seconds: 480000,
          resets_at: "2026-10-23T02:53:00+08:00",
          window_stats: {
            requests: 20,
            tokens: 311900,
            cost: 0.44,
            user_cost: 0.44,
          },
        },
      },
    );
    expect(acc).toMatchObject({
      id: 39,
      name: "Feiqin-Gpt",
      email: "a@example.com",
      groups: ["openai-default"],
      currentConcurrency: 0,
      maxConcurrency: 1,
    });
    expect(acc.windows[0]).toMatchObject({
      id: "5h",
      usedPercent: 0,
      requests: 2,
      tokens: 9800,
      accountCost: 0.01,
    });
    expect(acc.windows[1]).toMatchObject({
      id: "7d",
      usedPercent: 3,
      requests: 20,
      tokens: 311900,
    });
  });

  it("falls back to extra when usage batch is missing", () => {
    const acc = accountFromSub2Api(
      {
        id: 1,
        name: "x",
        extra: { codex_5h_used_percent: 12.5, codex_7d_used_percent: 40 },
      },
      undefined,
    );
    expect(acc.windows[0]!.usedPercent).toBe(12.5);
    expect(acc.windows[1]!.usedPercent).toBe(40);
    expect(acc.currentConcurrency).toBe(0);
    expect(acc.maxConcurrency).toBe(0);
  });
});

describe("visibleUpstreamAccounts", () => {
  const items = [
    accountFromSub2Api({ id: 1, name: "A" }, undefined),
    accountFromSub2Api({ id: 2, name: "B" }, undefined),
  ];

  it("admins see every account", () => {
    expect(visibleUpstreamAccounts(user("admin", []), items)).toHaveLength(2);
    expect(visibleUpstreamAccounts(user("admin", [1]), items)).toHaveLength(2);
  });

  it("members only see assigned ids", () => {
    expect(
      visibleUpstreamAccounts(user("member", [2]), items).map((a) => a.id),
    ).toEqual([2]);
    expect(visibleUpstreamAccounts(user("member", []), items)).toEqual([]);
  });
});

describe("upstream account pagination", () => {
  it.each([false, true])(
    "excludes Grok accounts and usage across pages (all excluded: %s)",
    async (allExcluded) => {
      clearSub2ApiTokenCache();
      const pages: string[] = [];
      const usageIds: number[][] = [];
      const excluded = [
        { platform: " GrOk " },
        { platform: "XAI" },
        { platform: "x.ai" },
        { name: "Kevin-Grok", platform: "openai" },
        { groups: [{ name: "grok-default" }] },
        { account_groups: ["GROK-default"] },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/auth/login"))
            return Response.json({
              data: { access_token: "test-token", expires_in: 3600 },
            });
          if (url.pathname.endsWith("/usage/batch")) {
            usageIds.push(JSON.parse(String(init?.body)).account_ids);
            return Response.json({ data: { usage: {} } });
          }
          const page = url.searchParams.get("page") ?? "";
          pages.push(page);
          return Response.json({
            data: {
              total: 101,
              items:
                page === "1"
                  ? Array.from({ length: 100 }, (_, index) => ({
                      id: index + 1,
                      ...excluded[index % excluded.length],
                    }))
                  : [
                      {
                        id: 101,
                        name: allExcluded ? "Yida-Grok" : "Fubin-GPT",
                        platform: "openai",
                      },
                    ],
            },
          });
        }),
      );
      try {
        const accounts = await listUpstreamAccounts({
          url: "https://upstream.test",
          email: "test@example.com",
          password: "test-only",
        });
        expect(pages).toEqual(["1", "2"]);
        expect(accounts.map((account) => account.id)).toEqual(
          allExcluded ? [] : [101],
        );
        expect(usageIds).toEqual(allExcluded ? [] : [[101]]);
      } finally {
        vi.unstubAllGlobals();
        clearSub2ApiTokenCache();
      }
    },
  );

  it("includes accounts beyond the first page with their subscription tiers", async () => {
    clearSub2ApiTokenCache();
    const pages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/auth/login"))
          return Response.json({
            data: { access_token: "test-token", expires_in: 3600 },
          });
        if (url.pathname.endsWith("/usage/batch"))
          return Response.json({ data: { usage: {} } });
        pages.push(url.searchParams.get("page")!);
        const first = url.searchParams.get("page") === "1";
        return Response.json({
          data: {
            total: 101,
            items: Array.from({ length: first ? 100 : 1 }, (_, index) => ({
              id: first ? index + 1 : 101,
              name: first ? `Account-${index}` : "EZARC-added",
              platform: "openai",
              credentials: { plan_type: "plus" },
            })),
          },
        });
      }),
    );
    try {
      const accounts = await listUpstreamAccounts({
        url: "https://upstream.test",
        email: "test@example.com",
        password: "test-only",
      });
      expect(accounts).toHaveLength(101);
      expect(pages).toEqual(["1", "2"]);
      expect(accounts[100]).toMatchObject({
        name: "EZARC-added",
        planType: "plus",
      });
    } finally {
      vi.unstubAllGlobals();
      clearSub2ApiTokenCache();
    }
  });
});

describe("Sub2API connection diagnostics", () => {
  it.each([
    ["ECONNREFUSED", "连接被拒绝"],
    ["ENOTFOUND", "无法解析上游域名"],
    ["UND_ERR_CONNECT_TIMEOUT", "连接上游超时"],
    ["CERT_HAS_EXPIRED", "上游 HTTPS 证书已过期"],
  ])("explains %s without exposing credentials", async (code, description) => {
    clearSub2ApiTokenCache();
    const cause = Object.assign(new Error("private connection details"), {
      code,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError("fetch failed", { cause })),
    );
    try {
      const error = await listUpstreamAccounts({
        url: "https://embedded-user:embedded-password@upstream.test/private?token=private-query",
        email: "private-email@example.com",
        password: "private-password",
      }).then(
        () => null,
        (failure: unknown) => failure as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("登录上游失败");
      expect(error?.message).toContain(description);
      expect(error?.message).toContain(code);
      expect(error?.message).toContain("https://upstream.test");
      for (const secret of [
        "embedded-user",
        "embedded-password",
        "/private",
        "private-query",
        "private-email",
        "private-password",
        "private connection details",
      ])
        expect(error?.message).not.toContain(secret);
      expect(error?.cause).toBeInstanceOf(TypeError);
    } finally {
      vi.unstubAllGlobals();
      clearSub2ApiTokenCache();
    }
  });

  it("identifies account-list failures after a successful login, including nested IPv4/IPv6 errors", async () => {
    clearSub2ApiTokenCache();
    const cause = new AggregateError([
      Object.assign(new Error("IPv4 connection failed"), {
        code: "ECONNREFUSED",
      }),
      Object.assign(new Error("IPv6 connection failed"), {
        code: "ENETUNREACH",
      }),
    ]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: { access_token: "test-token", expires_in: 3600 },
        }),
      )
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(
        listUpstreamAccounts({
          url: "https://upstream.test",
          email: "test@example.com",
          password: "test-only",
        }),
      ).rejects.toThrow(
        "读取账号列表失败：连接被拒绝，请检查上游服务和端口（ECONNREFUSED）；无法访问上游网络（ENETUNREACH）；连接地址：https://upstream.test",
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      clearSub2ApiTokenCache();
    }
  });

  it("reports request timeouts even when no system error code is present", async () => {
    clearSub2ApiTokenCache();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new DOMException("Request timed out", "TimeoutError"),
        ),
    );
    try {
      await expect(
        listUpstreamAccounts({
          url: "https://upstream.test",
          email: "test@example.com",
          password: "test-only",
        }),
      ).rejects.toThrow("登录上游失败：请求上游超时");
    } finally {
      vi.unstubAllGlobals();
      clearSub2ApiTokenCache();
    }
  });
});
