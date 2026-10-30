import { describe, expect, it, vi } from "vitest";
import { settings } from "../src/db/schema.ts";
import { accountFromSub2Api, listUpstreamAccounts } from "../src/sub2api.ts";
import {
  aggregateAccountCosts,
  currentCostMonth,
  saveCostMonth,
} from "../src/usage/account-costs.ts";
import {
  ledgerManualAccounts,
  ledgerMonths,
  readLedger,
  recordSubscriptions,
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
  it.each([false, true])(
    "excludes legacy Grok charges and pending fees (upstream unavailable: %s)",
    async (unavailable) => {
      const ctx = await setup(env);
      try {
        const cycle = {
          expires: null,
          month: null,
          name: "Other",
          department: "技术部&独立站&TK",
          planType: null,
          amount: null,
          automaticPricing: false,
        };
        const excluded = [
          { accountId: 10, platform: "grok", currentName: "Pengxiang" },
          { accountId: 11, platform: " XAI ", currentName: "Yida" },
          { accountId: 12, platform: "x.ai", currentName: "Luwu" },
          { accountId: 13, platform: "openai", currentName: "Yida-Grok" },
          { accountId: 14, platform: "openai", currentName: "Renamed" },
        ].map((account) => ({
          ...account,
          cycles: [
            { ...cycle, name: "Luwu-Grok" },
            { ...cycle, name: "Luwu-Grok", month: "2026-09", amount: 30 },
          ],
        }));
        // Legacy entries were recorded before Grok synchronization was disabled.
        await ctx.db.insert(settings).values(
          excluded.map((account) => ({
            key: `subscription-ledger:${JSON.stringify([account.platform, account.accountId])}`,
            value: account,
          })),
        );
        await recordSubscriptions(
          ctx.db,
          [fixture(1, "Fubin-GPT"), fixture(2, "Other-GPT", "plus", null)],
          new Map(),
        );
        if (unavailable)
          vi.mocked(listUpstreamAccounts).mockRejectedValue(
            new Error("upstream unavailable"),
          );
        else
          vi.mocked(listUpstreamAccounts).mockResolvedValue([
            fixture(99, "New-Grok", "unknown", null),
          ]);
        const session = await login(ctx.app, ADMIN.username, ADMIN.password);
        const headers = bearer(session.accessToken);
        const url = "/api/v1/admin/usage/account-costs";
        for (const period of ["month&value=2026-09", "year&value=2026"]) {
          const response = await ctx.app.inject({
            url: `${url}?period=${period}`,
            headers,
          });
          expect(response.statusCode).toBe(200);
          const result = response.json();
          expect(result.pendingDateCount).toBe(1);
          expect(
            result.manualAccounts.map(
              (account: { accountId: number }) => account.accountId,
            ),
          ).toEqual([2]);
          expect(result.items[0]).toMatchObject({
            monthlyUsd: 20,
            accountCount: 1,
            unpricedCount: 0,
          });
          expect(result.history).toHaveLength(1);
          expect(result.history[0].items[0].monthlyUsd).toBe(20);
          expect(result.availableMonths).toEqual(["2026-09"]);
          expect(JSON.stringify(result)).not.toMatch(/grok|xai|x\.ai/i);
        }
        if (!unavailable) {
          const write = await ctx.app.inject({
            method: "PUT",
            url: `${url}/manual`,
            headers,
            payload: {
              items: [
                {
                  accountId: 10,
                  platform: "grok",
                  planType: null,
                  monthlyUsd: 30,
                },
              ],
            },
          });
          expect(write.statusCode).toBe(403);
        }
        expect(await readLedger(ctx.db)).toHaveLength(2);
        const stored = await ctx.db.select().from(settings);
        expect(
          stored.filter((row) => row.key.startsWith("subscription-ledger:"))
            .length,
        ).toBe(7);
      } finally {
        await ctx.close();
      }
    },
  );

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
      fixture(6, "Pengxiang-Grok", "pro"),
      { ...fixture(7, "Yida", "pro"), platform: "grok" },
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
  it("syncs editor names by platform and ID without changing historical charges or duplicating cycles", async () => {
    const ctx = await setup(env);
    try {
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(session.accessToken);
      const get = () =>
        ctx.app.inject({
          method: "GET",
          url: "/api/v1/admin/usage/account-costs?period=month&value=2026-09",
          headers,
        });
      const anthropic = (id: number, name: string) => ({
        ...fixture(id, name, "unknown", null),
        platform: "anthropic",
        planType: null,
      });
      const originalSources = [
        anthropic(1, "Luwu-Claude"),
        anthropic(2, "Luwu-Claude"),
        anthropic(3, "Yida-Claude"),
        fixture(2, "Fubin-GPT", "plus", null),
        fixture(4, "EZARC-paid"),
      ];
      vi.mocked(listUpstreamAccounts).mockResolvedValue(originalSources);
      const originalResponse = await get();
      expect(originalResponse.statusCode).toBe(200);
      const originalHistory = originalResponse.json().history;
      const originalLedger = await readLedger(ctx.db);

      vi.mocked(listUpstreamAccounts).mockResolvedValue([
        anthropic(1, "Luwu-Claude"),
        anthropic(2, "Pengxiang-Claude"),
        anthropic(3, "Yida-Claude"),
        fixture(2, "Fubin-GPT-renamed", "plus", null),
        fixture(4, "产品部-renamed"),
      ]);
      const renamedResponse = await get();
      expect(renamedResponse.statusCode).toBe(200);
      const renamed = renamedResponse.json();
      expect(renamed.manualAccounts).toHaveLength(4);
      expect(renamed.manualAccounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: 1,
            platform: "anthropic",
            name: "Luwu-Claude",
          }),
          expect.objectContaining({
            accountId: 2,
            platform: "anthropic",
            name: "Pengxiang-Claude",
          }),
          expect.objectContaining({
            accountId: 3,
            platform: "anthropic",
            name: "Yida-Claude",
          }),
          expect.objectContaining({
            accountId: 2,
            platform: "openai",
            name: "Fubin-GPT-renamed",
            monthlyUsd: 20,
          }),
        ]),
      );
      expect(renamed.history).toEqual(originalHistory);
      await get();
      const refreshedLedger = await readLedger(ctx.db);
      expect(refreshedLedger).toHaveLength(originalLedger.length);
      for (const account of refreshedLedger) {
        const original = originalLedger.find(
          (item) =>
            item.accountId === account.accountId &&
            item.platform === account.platform,
        );
        expect(account.cycles).toEqual(original?.cycles);
      }

      vi.mocked(listUpstreamAccounts).mockRejectedValue(
        new Error("upstream unavailable"),
      );
      const cached = (await get()).json();
      expect(cached.manualAccounts).toEqual(renamed.manualAccounts);
      expect(cached.history).toEqual(originalHistory);
    } finally {
      await ctx.close();
    }
  });
  it("syncs names for legacy ledger entries and retains the exclusion of new Kevin accounts", async () => {
    const ctx = await setup();
    try {
      const legacy = {
        accountId: 2,
        platform: "anthropic",
        cycles: [
          {
            expires: null,
            month: null,
            name: "Luwu-Claude",
            department: "技术部&独立站&TK",
            planType: null,
            amount: null,
            automaticPricing: false,
          },
        ],
      };
      await ctx.db.insert(settings).values({
        key: 'subscription-ledger:["anthropic",2]',
        value: legacy,
      });
      expect(ledgerManualAccounts(await readLedger(ctx.db))[0]?.name).toBe(
        "Luwu-Claude",
      );
      const sources = [
        {
          id: 2,
          platform: "anthropic",
          name: "Pengxiang-Claude",
          planType: null,
          subscriptionExpiresAt: null,
        },
      ];
      let ledger = await recordSubscriptions(ctx.db, sources, new Map());
      expect(ledgerManualAccounts(ledger)[0]?.name).toBe("Pengxiang-Claude");
      expect(ledger[0]?.cycles).toEqual(legacy.cycles);

      sources[0]!.name = "Kevin-Claude";
      ledger = await recordSubscriptions(
        ctx.db,
        [...sources, { ...sources[0]!, id: 99 }],
        new Map(),
      );
      expect(ledger).toHaveLength(1);
      expect(ledgerManualAccounts(ledger)[0]?.name).toBe("Kevin-Claude");
      expect(ledger[0]?.cycles).toEqual(legacy.cycles);
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
        expect(visible.statusCode).toBe(role === "member" ? 403 : 200);
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
  it.each(["运营部-EZARC", "Libraton组", "技术部&独立站"])(
    "scopes group leader history and totals to %s regardless of query parameters",
    async (groupName) => {
      const ctx = await setup(env);
      try {
        const session = await login(ctx.app, ADMIN.username, ADMIN.password);
        const headers = bearer(session.accessToken);
        vi.mocked(listUpstreamAccounts).mockResolvedValue([
          fixture(1, "EZARC-A"),
          fixture(2, "Libraton-A"),
          fixture(3, "Other"),
          fixture(4, "产品部-old", "pro", "2020-01-15T00:00:00Z"),
          fixture(5, "Yplus-undated", "plus", null),
        ]);
        await ctx.app.inject({
          method: "POST",
          url: "/api/v1/admin/users",
          headers,
          payload: {
            username: "scoped-reader",
            password: "password123",
            role: "group_leader",
            groupName,
          },
        });
        const reader = await login(ctx.app, "scoped-reader", "password123");
        const scopedHeaders = bearer(reader.accessToken);
        const response = await ctx.app.inject({
          method: "GET",
          url: "/api/v1/admin/usage/account-costs?period=year&value=2026&department=产品部",
          headers: scopedHeaders,
        });
        expect(response.statusCode).toBe(200);
        const { normalizeAccountCostDepartment } = await import(
          "@ccse/contracts"
        );
        const canonical = normalizeAccountCostDepartment(groupName);
        const result = response.json();
        expect(result.departmentScope).toBe(canonical);
        expect(result.items).toMatchObject([
          {
            department: canonical,
            monthlyUsd: 20,
            accountCount: 1,
            unpricedCount: 0,
          },
        ]);
        expect(result.history).toHaveLength(1);
        expect(
          result.history[0].items.every(
            (item: { department: string }) => item.department === canonical,
          ),
        ).toBe(true);
        expect(result.availableMonths).toEqual(["2026-09"]);
        expect(result.pendingDateCount).toBe(0);
        expect(result.manualAccounts).toEqual([]);
        expect(
          (
            await ctx.app.inject({
              method: "PUT",
              url: "/api/v1/admin/usage/account-costs/manual",
              headers: scopedHeaders,
              payload: {
                items: [
                  {
                    accountId: 3,
                    platform: "openai",
                    planType: "plus",
                    monthlyUsd: 40,
                  },
                ],
              },
            })
          ).statusCode,
        ).toBe(403);
        vi.mocked(listUpstreamAccounts).mockResolvedValue([]);
        expect(
          (
            await ctx.app.inject({
              method: "GET",
              url: "/api/v1/admin/usage/account-costs?period=month&value=2026-09",
              headers: scopedHeaders,
            })
          ).json().items[0].monthlyUsd,
        ).toBe(20);
      } finally {
        await ctx.close();
      }
    },
  );

  it("keeps old snapshots archived instead of counting them twice, and isolates demo ledgers", async () => {
    const ctx = await setup({ DEMO_UPSTREAM_ACCOUNTS: "true" });
    try {
      await saveCostMonth(
        ctx.db,
        currentCostMonth(),
        [
          {
            department: "Other",
            accounts: [],
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
