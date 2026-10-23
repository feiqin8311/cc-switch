import { describe, expect, it, vi } from "vitest";
import { accountFromSub2Api, listUpstreamAccounts } from "../src/sub2api.ts";
import {
  aggregateAccountCosts,
  currentCostMonth,
  saveCostMonth,
} from "../src/usage/account-costs.ts";
import {
  recordSubscriptions,
  ledgerMonths,
  subscriptionCycle,
} from "../src/usage/subscription-ledger.ts";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

vi.mock("../src/sub2api.ts", async (original) => ({
  ...(await original<typeof import("../src/sub2api.ts")>()),
  listUpstreamAccounts: vi.fn(),
}));
const fixture = (
  id: number,
  name: string,
  plan = "plus",
  expires: string | null = "2026-10-23T08:00:00Z",
) =>
  accountFromSub2Api(
    {
      id,
      name,
      platform: "openai",
      credentials: {
        plan_type: plan,
        subscription_expires_at: expires,
        access_token: "do-not-expose",
      },
    },
    undefined,
  );
const env = {
  SUB2API_URL: "https://upstream.example",
  SUB2API_EMAIL: "test@example.com",
  SUB2API_PASSWORD: "test-password",
};

describe("subscription renewal ledger", () => {
  it("reads expiry from upstream data and parent inheritance, never quota resets or access-token expiry", () => {
    expect(fixture(1, "a").subscriptionExpiresAt).toBe("2026-10-23T08:00:00Z");
    expect(JSON.stringify(fixture(1, "a"))).not.toContain("do-not-expose");
    expect(
      accountFromSub2Api(
        {
          credentials: { expires_at: "2026-11-23" },
          extra: { codex_7d_reset_at: "2026-10-30" },
        },
        undefined,
      ).subscriptionExpiresAt,
    ).toBeNull();
    expect(
      accountFromSub2Api(
        {
          parent_subscription_expires_at: "2026-11-12",
          parent_plan_type: "plus",
        },
        undefined,
      ).subscriptionExpiresAt,
    ).toBe("2026-11-12");
    expect(subscriptionCycle("2026-11-12T00:00:00Z")?.month).toBe("2026-10");
    expect(subscriptionCycle("2026-10-23T00:00:00Z")?.month).toBe("2026-09");
    expect(subscriptionCycle("2026-01-31T00:00:00Z")?.month).toBe("2025-12");
    expect(subscriptionCycle("2026-02-28T17:00:00Z")?.month).toBe("2026-02");
    expect(subscriptionCycle("invalid")).toBeNull();
  });
  it("keeps prefix grouping, plan estimates and Kevin exclusion", () => {
    const rows = aggregateAccountCosts([
      fixture(1, "EZARC-GPT1", "prolite"),
      fixture(2, "EZARC-GPT2"),
      fixture(3, "Libraton-Gpt2"),
      fixture(4, "Kevin-Grok", "pro"),
      fixture(5, "Other"),
    ]);
    expect(rows.map((row) => row.monthlyUsd)).toEqual([120, 20, 20]);
    expect(
      rows.find((row) => row.department === "运营部-LIBRATON")?.accountCount,
    ).toBe(1);
  });
  it("deduplicates concurrent reads, preserves removed/renamed accounts and adds one charge per new expiry", async () => {
    const ctx = await setup(env);
    try {
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(session.accessToken);
      const get = (value = "2026-09", period = "month") =>
        ctx.app.inject({
          method: "GET",
          url: `/api/v1/admin/usage/account-costs?period=${period}&value=${value}`,
          headers,
        });
      expect(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/v1/admin/usage/account-costs",
          })
        ).statusCode,
      ).toBe(401);
      vi.mocked(listUpstreamAccounts).mockResolvedValue([
        fixture(1, "EZARC-A"),
        fixture(2, "Other"),
        fixture(9, "Kevin-ignore"),
      ]);
      await Promise.all([get(), get()]);
      expect(
        (await get())
          .json()
          .items.reduce(
            (sum: number, row: { monthlyUsd: number }) => sum + row.monthlyUsd,
            0,
          ),
      ).toBe(40);
      vi.mocked(listUpstreamAccounts).mockResolvedValue([
        fixture(1, "产品部-renamed"),
      ]);
      const retained = (await get()).json();
      expect(
        retained.items.find(
          (row: { department: string }) =>
            row.department === "技术部&独立站&TK",
        ).monthlyUsd,
      ).toBe(20);
      expect(
        retained.items.find(
          (row: { department: string }) => row.department === "运营部-EZARC",
        ).monthlyUsd,
      ).toBe(20);
      vi.mocked(listUpstreamAccounts).mockResolvedValue([
        fixture(1, "EZARC-A", "plus", "2026-11-23T08:00:00Z"),
        fixture(3, "New"),
      ]);
      expect((await get("2026-10")).json().items[0].monthlyUsd).toBe(20);
      expect(
        (await get())
          .json()
          .items.reduce(
            (sum: number, row: { monthlyUsd: number }) => sum + row.monthlyUsd,
            0,
          ),
      ).toBe(60);
      vi.mocked(listUpstreamAccounts).mockResolvedValue([]);
      const annual = (await get("2026", "year")).json();
      expect(
        annual.items.reduce(
          (sum: number, row: { monthlyUsd: number }) => sum + row.monthlyUsd,
          0,
        ),
      ).toBe(80);
      expect(annual.recordedMonths).toEqual(["2026-09", "2026-10"]);
      expect((await get("2026-13")).statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });
  it("keeps undated charges pending and permits later confirmation without creating a second charge", async () => {
    const ctx = await setup();
    try {
      const source = fixture(1, "Other", "plus", null);
      let ledger = await recordSubscriptions(ctx.db, [source], new Map());
      expect(ledgerMonths(ledger)).toEqual([]);
      const override = {
        accountId: 1,
        platform: "openai",
        planType: "plus",
        monthlyUsd: 0,
        billingMonth: "2026-09",
      };
      const { manualCostKey } = await import("../src/usage/account-costs.ts");
      ledger = await recordSubscriptions(
        ctx.db,
        [],
        new Map([[manualCostKey(override), override]]),
      );
      expect(ledgerMonths(ledger)[0]?.items[0]?.monthlyUsd).toBe(20);
      ledger = await recordSubscriptions(
        ctx.db,
        [fixture(1, "Other")],
        new Map(),
      );
      expect(ledger[0]?.cycles).toHaveLength(1);
      expect(ledgerMonths(ledger)[0]?.month).toBe("2026-09");
    } finally {
      await ctx.close();
    }
  });
  it("allows only admin to fill pending fees, keeps them after deletion and rejects subsequent reductions", async () => {
    const ctx = await setup(env);
    try {
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(session.accessToken);
      const url = "/api/v1/admin/usage/account-costs";
      vi.mocked(listUpstreamAccounts).mockResolvedValue([
        fixture(99, "Other", "unknown"),
      ]);
      const get = () =>
        ctx.app.inject({
          method: "GET",
          url: url + "?period=month&value=2026-09",
          headers,
        });
      expect((await get()).json().manualAccounts[0].monthlyUsd).toBeNull();
      vi.mocked(listUpstreamAccounts).mockResolvedValue([]);
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
          url: url + "/manual",
          headers,
          payload: body,
        });
      expect((await write()).statusCode).toBe(204);
      expect((await get()).json().items[0].monthlyUsd).toBe(35.5);
      body.items[0]!.monthlyUsd = 0;
      expect((await write()).statusCode).toBe(403);
      for (const role of ["leader", "group_leader", "member"]) {
        await ctx.app.inject({
          method: "POST",
          url: "/api/v1/admin/users",
          headers,
          payload: {
            username: `reader-${role}`,
            password: "password123",
            role,
            adminMenus: ["usage"],
            groupName: "Test",
          },
        });
        const reader = await login(ctx.app, `reader-${role}`, "password123");
        const readerHeaders = bearer(reader.accessToken);
        const visible = await ctx.app.inject({
          method: "GET",
          url,
          headers: readerHeaders,
        });
        expect(visible.statusCode).toBe(role === "leader" ? 200 : 403);
        if (role === "leader")
          expect(visible.json().manualAccounts).toEqual([]);
        expect(
          (
            await ctx.app.inject({
              method: "PUT",
              url: url + "/manual",
              headers: readerHeaders,
              payload: body,
            })
          ).statusCode,
        ).toBe(403);
      }
    } finally {
      await ctx.close();
    }
  });
  it("keeps old snapshots archived instead of counting them twice, and isolates demo ledgers", async () => {
    const ctx = await setup({ DEMO_UPSTREAM_ACCOUNTS: "true" });
    try {
      await saveCostMonth(
        ctx.db,
        currentCostMonth(),
        [
          {
            department: "Other",
            monthlyUsd: 999,
            accountCount: 1,
            unpricedCount: 0,
          },
        ],
        true,
      );
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(session.accessToken);
      const url = "/api/v1/admin/usage/account-costs?period=year&value=2026";
      const upstream = (
        await ctx.app.inject({
          method: "GET",
          url: "/api/v1/admin/upstream/accounts",
          headers,
        })
      ).json();
      expect(upstream.items).toHaveLength(12);
      const result = (
        await ctx.app.inject({ method: "GET", url, headers })
      ).json();
      expect(result.legacySnapshotCount).toBe(1);
      expect(
        result.items.reduce(
          (sum: number, row: { monthlyUsd: number }) => sum + row.monthlyUsd,
          0,
        ),
      ).toBe(280);
      expect(result.history.map((row: { month: string }) => row.month)).toEqual(
        ["2026-09", "2026-10"],
      );
      ctx.config.demoUpstreamAccounts = false;
      vi.mocked(listUpstreamAccounts).mockResolvedValue([]);
      expect(
        (await ctx.app.inject({ method: "GET", url, headers })).json().items,
      ).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
