import { describe, expect, it, vi } from "vitest";
import { accountFromSub2Api, listUpstreamAccounts } from "../src/sub2api.ts";
import {
  aggregateAccountCosts,
  saveCostMonth,
} from "../src/usage/account-costs.ts";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

vi.mock("../src/sub2api.ts", async (original) => ({
  ...(await original<typeof import("../src/sub2api.ts")>()),
  listUpstreamAccounts: vi.fn(),
}));

// Screenshot-like fixtures only: these never enter the live upstream list.
const fixture = (name: string, plan = "plus", id = 1) =>
  accountFromSub2Api(
    {
      id,
      name,
      platform: "openai",
      credentials: { plan_type: plan, access_token: "do-not-expose" },
    },
    undefined,
  );
const accounts = [
  fixture("EZARC-GPT1", "prolite"),
  fixture("EZARC-GPT2"),
  fixture("Libraton-GPT1"),
  fixture("Libraton-Gpt2"),
  fixture("Yplus-GPT"),
  fixture("产品部-GPT"),
  fixture("Fubin-GPT"),
  fixture("Oyww-GPT"),
  fixture("Yida-GPT"),
  fixture("Zjn-GPT"),
  fixture("Kevin-Grok", "pro"),
];

describe("live upstream subscription costs", () => {
  it("uses the same offline demo accounts in upstream cards and subscription costs", async () => {
    const ctx = await setup({ DEMO_UPSTREAM_ACCOUNTS: "true" });
    try {
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(session.accessToken);
      const upstream = (
        await ctx.app.inject({
          method: "GET",
          url: "/api/v1/admin/upstream/accounts",
          headers,
        })
      ).json();
      expect(upstream.demo).toBe(true);
      expect(upstream.items).toHaveLength(12);
      const result = (
        await ctx.app.inject({
          method: "GET",
          url: "/api/v1/admin/usage/account-costs",
          headers,
        })
      ).json();
      expect(result.demo).toBe(true);
      expect(
        result.items.reduce(
          (sum: number, item: { monthlyUsd: number }) => sum + item.monthlyUsd,
          0,
        ),
      ).toBe(280);
      expect(
        result.items.reduce(
          (sum: number, item: { accountCount: number }) =>
            sum + item.accountCount,
          0,
        ),
      ).toBe(11);
      expect(result.manualAccounts[0].name).toBe(upstream.items[11].name);
      ctx.config.demoUpstreamAccounts = false;
      const real = (
        await ctx.app.inject({
          method: "GET",
          url: "/api/v1/admin/usage/account-costs",
          headers,
        })
      ).json();
      expect(real.items).toEqual([]);
      expect(real.recordedMonths).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
  it("keeps historical months separate and sums recorded months for the selected year", async () => {
    const ctx = await setup();
    try {
      const row = (monthlyUsd: number) => [
        {
          department: "Libraton组",
          monthlyUsd,
          accountCount: 1,
          unpricedCount: 0,
        },
      ];
      await saveCostMonth(ctx.db, "2020-01", row(20));
      await saveCostMonth(ctx.db, "2020-02", row(40));
      await saveCostMonth(ctx.db, "2021-01", row(100));
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const get = (period: string, value: string) =>
        ctx.app.inject({
          method: "GET",
          url: `/api/v1/admin/usage/account-costs?period=${period}&value=${value}`,
          headers: bearer(session.accessToken),
        });
      const january = (await get("month", "2020-01")).json();
      expect(january.items[0].monthlyUsd).toBe(20);
      expect(january.manualAccounts).toEqual([]);
      const annual = (await get("year", "2020")).json();
      expect(annual.items[0].monthlyUsd).toBe(60);
      expect(
        annual.history.map((entry: { month: string }) => entry.month),
      ).toEqual(["2020-01", "2020-02", "2021-01"]);
      expect(annual.recordedMonths).toEqual(["2020-01", "2020-02"]);
      expect((await get("month", "2019-01")).json().items).toEqual([]);
      expect((await get("month", "2020-13")).statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });
  it("reads the real plan SKU without exposing credentials", () => {
    expect(fixture("test", "prolite").planType).toBe("prolite");
    expect(JSON.stringify(fixture("test"))).not.toContain("do-not-expose");
    expect(
      accountFromSub2Api({ parent_plan_type: "plus" }, undefined).planType,
    ).toBe("plus");
  });
  it("groups screenshot accounts by prefix, excludes Kevin and sorts by cost", () => {
    expect(
      aggregateAccountCosts(accounts).map(({ department, monthlyUsd }) => [
        department,
        monthlyUsd,
      ]),
    ).toEqual([
      ["运营部-EZARC", 120],
      ["技术部&独立站", 80],
      ["Libraton组", 40],
      ["产品部", 20],
      ["运营部-YPLUS", 20],
    ]);
    expect(
      aggregateAccountCosts([fixture("  eZaRc-new  "), fixture("KEVIN-new")])[0]
        ?.monthlyUsd,
    ).toBe(20);
  });
  it("keeps unknown subscriptions visibly unpriced and handles empty lists", () => {
    expect(
      aggregateAccountCosts([fixture("Other", "unknown")])[0],
    ).toMatchObject({ monthlyUsd: 0, unpricedCount: 1 });
    expect(aggregateAccountCosts([])).toEqual([]);
  });
  it("re-reads additions, removals, renames and plan changes and disables manual writes", async () => {
    const ctx = await setup({
      SUB2API_URL: "https://upstream.example",
      SUB2API_EMAIL: "test@example.com",
      SUB2API_PASSWORD: "test-password",
    });
    try {
      const url = "/api/v1/admin/usage/account-costs";
      expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(
        401,
      );
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(session.accessToken);
      vi.mocked(listUpstreamAccounts).mockResolvedValueOnce(accounts);
      const before = await ctx.app.inject({ method: "GET", url, headers });
      expect(before.statusCode).toBe(200);
      expect(before.headers["cache-control"]).toBe("no-store");
      expect(
        before
          .json()
          .items.reduce(
            (sum: number, item: { monthlyUsd: number }) =>
              sum + item.monthlyUsd,
            0,
          ),
      ).toBe(280);
      vi.mocked(listUpstreamAccounts).mockResolvedValueOnce([
        fixture("EZARC-GPT1", "pro"),
        fixture("EZARC-new"),
        fixture("renamed-account"),
      ]);
      const after = await ctx.app.inject({ method: "GET", url, headers });
      expect(after.json().items).toEqual([
        {
          department: "运营部-EZARC",
          monthlyUsd: 220,
          accountCount: 2,
          unpricedCount: 0,
        },
        {
          department: "技术部&独立站",
          monthlyUsd: 20,
          accountCount: 1,
          unpricedCount: 0,
        },
      ]);
      expect(
        (await ctx.app.inject({ method: "PUT", url, headers, payload: [] }))
          .statusCode,
      ).toBe(404);
    } finally {
      await ctx.close();
    }
  });
  it("persists per-account unknown fees, enforces admin-only writes and follows live plan changes", async () => {
    const ctx = await setup({
      SUB2API_URL: "https://upstream.example",
      SUB2API_EMAIL: "test@example.com",
      SUB2API_PASSWORD: "test-password",
    });
    try {
      const base = "/api/v1/admin/usage/account-costs";
      const admin = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(admin.accessToken);
      const unknown = fixture("Other", "unknown", 99);
      vi.mocked(listUpstreamAccounts).mockResolvedValue([unknown]);
      const before = await ctx.app.inject({
        method: "GET",
        url: base,
        headers,
      });
      expect(before.json()).toMatchObject({
        unpricedCount: 1,
        manualAccounts: [{ accountId: 99, monthlyUsd: null }],
      });
      const body = {
        items: [
          {
            accountId: 99,
            platform: "openai",
            planType: "unknown",
            monthlyUsd: 35.5,
          },
        ],
      };
      const write = () =>
        ctx.app.inject({
          method: "PUT",
          url: `${base}/manual`,
          headers,
          payload: body,
        });
      expect((await write()).statusCode).toBe(204);
      const saved = await ctx.app.inject({ method: "GET", url: base, headers });
      expect(saved.json()).toMatchObject({
        unpricedCount: 0,
        items: [{ monthlyUsd: 35.5 }],
        manualAccounts: [{ monthlyUsd: 35.5 }],
      });
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/admin/users",
        headers,
        payload: {
          username: "cost-reader",
          password: "password123",
          role: "leader",
          adminMenus: ["usage"],
        },
      });
      const reader = await login(ctx.app, "cost-reader", "password123");
      expect(
        (
          await ctx.app.inject({
            method: "PUT",
            url: `${base}/manual`,
            headers: bearer(reader.accessToken),
            payload: body,
          })
        ).statusCode,
      ).toBe(403);
      const visible = await ctx.app.inject({
        method: "GET",
        url: base,
        headers: bearer(reader.accessToken),
      });
      expect(visible.json()).toMatchObject({
        items: [{ monthlyUsd: 35.5 }],
        manualAccounts: [],
      });
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/admin/users",
        headers,
        payload: {
          username: "group-cost-reader",
          password: "password123",
          role: "group_leader",
          groupName: "Libraton组",
        },
      });
      const groupReader = await login(
        ctx.app,
        "group-cost-reader",
        "password123",
      );
      expect(
        (
          await ctx.app.inject({
            method: "GET",
            url: base,
            headers: bearer(groupReader.accessToken),
          })
        ).statusCode,
      ).toBe(403);
      body.items[0]!.monthlyUsd = 0;
      expect((await write()).statusCode).toBe(204);
      expect(
        (await ctx.app.inject({ method: "GET", url: base, headers })).json()
          .unpricedCount,
      ).toBe(0);
      // A new SKU must not silently reuse the old price, and recognized plans stay automatic.
      vi.mocked(listUpstreamAccounts).mockResolvedValue([
        fixture("Other", "new-unknown", 99),
      ]);
      expect(
        (await ctx.app.inject({ method: "GET", url: base, headers })).json()
          .unpricedCount,
      ).toBe(1);
      vi.mocked(listUpstreamAccounts).mockResolvedValue([
        fixture("Other", "plus", 99),
      ]);
      expect(
        (await ctx.app.inject({ method: "GET", url: base, headers })).json()
          .items[0].monthlyUsd,
      ).toBe(20);
      expect((await write()).statusCode).toBe(403);
      vi.mocked(listUpstreamAccounts).mockResolvedValue([]);
      expect(
        (await ctx.app.inject({ method: "GET", url: base, headers })).json()
          .items,
      ).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
