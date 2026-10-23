import { CODING_PLAN_ACCOUNT_ID } from "@ccse/contracts";
import { describe, expect, it, vi } from "vitest";
import { clearSub2ApiTokenCache } from "../src/sub2api.ts";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

describe("upstream accounts", () => {
  it("applies account assignments to web and desktop for every non-admin role, including live revocation", async () => {
    clearSub2ApiTokenCache();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "open.volcengineapi.com")
          return Response.json({
            Result:
              url.searchParams.get("Action") === "GetPersonalPlan"
                ? { PlanType: "Pro", Status: "Running" }
                : {
                    Status: "Running",
                    QuotaUsage: [{ Level: "weekly", Percent: 7 }],
                  },
          });
        if (url.pathname.endsWith("/auth/login"))
          return Response.json({
            data: { access_token: "test-token", expires_in: 3600 },
          });
        if (url.pathname.endsWith("/usage/batch"))
          return Response.json({ data: { usage: {} } });
        return Response.json({
          data: {
            total: 2,
            items: [
              { id: 39, name: "产品部-GPT", platform: "openai" },
              { id: 12, name: "其他部门-GPT", platform: "openai" },
            ],
          },
        });
      }),
    );
    const ctx = await setup({
      SUB2API_URL: "https://upstream.test",
      SUB2API_EMAIL: "test@example.com",
      SUB2API_PASSWORD: "test-only",
      VOLCENGINE_ACCESS_KEY_ID: "test-ak",
      VOLCENGINE_SECRET_ACCESS_KEY: "test-sk",
    });
    try {
      const admin = await login(ctx.app, ADMIN.username, ADMIN.password);
      const adminHeaders = bearer(admin.accessToken);
      const accountsUrl = "/api/v1/admin/upstream/accounts";
      const planUrl = "/api/v1/admin/usage/coding-plan";
      for (const role of [
        "group_leader",
        "leader",
        "member",
        "viewer",
      ] as const) {
        const username = `scoped-${role}`;
        const created = await ctx.app.inject({
          method: "POST",
          url: "/api/v1/admin/users",
          headers: adminHeaders,
          payload: {
            username,
            password: "password-123",
            role,
            adminMenus: ["upstream", "users", "usage"],
            upstreamAccountIds: [39],
          },
        });
        expect(created.statusCode).toBe(201);
        const session = await login(ctx.app, username, "password-123");
        const headers = bearer(session.accessToken);
        const get = (url: string) =>
          ctx.app.inject({ method: "GET", url, headers });
        const update = (ids: number[]) =>
          ctx.app.inject({
            method: "PATCH",
            url: `/api/v1/admin/users/${created.json().id}`,
            headers: adminHeaders,
            payload: { upstreamAccountIds: ids },
          });
        const first = await get(accountsUrl);
        expect(first.statusCode).toBe(200);
        expect(first.headers["cache-control"]).toBe("no-store");
        expect(first.json().items.map((a: { id: number }) => a.id)).toEqual([
          39,
        ]);
        expect(first.json().codingPlanAvailable).toBe(false);
        expect((await get(planUrl)).statusCode).toBe(403);
        expect(
          (await get("/api/v1/client/upstream/accounts"))
            .json()
            .items.map((a: { id: number }) => a.id),
        ).toEqual([39]);

        expect((await update([12, CODING_PLAN_ACCOUNT_ID])).statusCode).toBe(
          200,
        );
        const changed = await get(accountsUrl);
        expect(changed.json().items.map((a: { id: number }) => a.id)).toEqual([
          12,
        ]);
        expect(changed.json().codingPlanAvailable).toBe(true);
        expect((await get(planUrl)).json().configured).toBe(true);

        expect((await update([])).statusCode).toBe(200);
        expect((await get(accountsUrl)).json()).toMatchObject({
          items: [],
          codingPlanAvailable: false,
        });
        expect((await get(planUrl)).statusCode).toBe(403);
        const desktop = await get("/api/v1/client/upstream/accounts");
        expect(desktop.json().items).toEqual([]);
        expect(desktop.json().codingPlan).toBeUndefined();
      }
      const all = await ctx.app.inject({
        url: accountsUrl,
        headers: adminHeaders,
      });
      expect(all.json().items.map((a: { id: number }) => a.id)).toEqual([
        39, 12,
      ]);
      expect(all.json().codingPlanAvailable).toBe(true);
      expect(
        (await ctx.app.inject({ url: planUrl, headers: adminHeaders }))
          .statusCode,
      ).toBe(200);
    } finally {
      await ctx.close();
      vi.unstubAllGlobals();
      clearSub2ApiTokenCache();
    }
  });

  it("persists Coding Plan assignments, enforces revocation, and shares the admin cache", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      Response.json({
        Result:
          new URL(String(input)).searchParams.get("Action") ===
          "GetPersonalPlan"
            ? { PlanType: "Pro", Status: "Running" }
            : {
                Status: "Running",
                QuotaUsage: [
                  { Level: "session", Percent: 2.05, ResetTimestamp: -1 },
                  { Level: "weekly", Percent: 6.39 },
                  { Level: "monthly", Percent: 33.97 },
                ],
              },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const ctx = await setup({
      VOLCENGINE_ACCESS_KEY_ID: "test-ak-not-real",
      VOLCENGINE_SECRET_ACCESS_KEY: "test-sk-not-real",
    });
    try {
      const url = "/api/v1/client/upstream/accounts";
      expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(
        401,
      );
      const admin = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(admin.accessToken);
      const choices = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/admin/upstream/accounts",
        headers,
      });
      expect(choices.json()).toMatchObject({
        configured: false,
        codingPlanAvailable: true,
        items: [],
      });
      expect(fetcher).not.toHaveBeenCalled();
      const created = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/admin/users",
        headers,
        payload: {
          username: "quota-member",
          password: "password-123",
          role: "member",
        },
      });
      expect(created.statusCode).toBe(201);
      const member = await login(ctx.app, "quota-member", "password-123");
      const memberHeaders = bearer(member.accessToken);
      const before = await ctx.app.inject({
        method: "GET",
        url,
        headers: memberHeaders,
      });
      expect(before.json().codingPlan).toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();

      const userUrl = `/api/v1/admin/users/${created.json().id}`;
      const assigned = await ctx.app.inject({
        method: "PATCH",
        url: userUrl,
        headers,
        payload: {
          upstreamAccountIds: [
            39,
            CODING_PLAN_ACCOUNT_ID,
            CODING_PLAN_ACCOUNT_ID,
            -2,
          ],
        },
      });
      expect(assigned.statusCode).toBe(200);
      expect(assigned.json().upstreamAccountIds).toEqual([
        39,
        CODING_PLAN_ACCOUNT_ID,
      ]);
      const visible = await ctx.app.inject({
        method: "GET",
        url,
        headers: memberHeaders,
      });
      expect(visible.statusCode).toBe(200);
      expect(visible.headers["cache-control"]).toBe("no-store");
      expect(visible.json()).toMatchObject({
        configured: true,
        error: null,
        items: [],
        codingPlan: {
          configured: true,
          windows: [
            { id: "fiveHour", usedPercent: 2.05, resetsAt: null },
            { id: "weekly", usedPercent: 6.39 },
            { id: "monthly", usedPercent: 33.97 },
          ],
        },
      });
      expect(visible.body).not.toContain("test-ak-not-real");
      expect(visible.body).not.toContain("test-sk-not-real");
      await ctx.app.inject({
        method: "GET",
        url: "/api/v1/admin/usage/coding-plan",
        headers,
      });
      const adminDesktop = await ctx.app.inject({
        method: "GET",
        url,
        headers,
      });
      expect(adminDesktop.json().codingPlan.configured).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);

      const revoked = await ctx.app.inject({
        method: "PATCH",
        url: userUrl,
        headers,
        payload: { upstreamAccountIds: [] },
      });
      expect(revoked.statusCode).toBe(200);
      const after = await ctx.app.inject({
        method: "GET",
        url,
        headers: memberHeaders,
      });
      expect(after.json().codingPlan).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await ctx.close();
      vi.unstubAllGlobals();
    }
  });

  it("returns configured:false when Sub2API env is unset", async () => {
    const ctx = await setup();
    try {
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const admin = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/admin/upstream/accounts",
        headers: bearer(session.accessToken),
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.json().configured).toBe(false);
      const client = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/client/upstream/accounts",
        headers: bearer(session.accessToken),
      });
      expect(client.statusCode).toBe(200);
      expect(client.json().items).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
