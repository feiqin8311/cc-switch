import { CODING_PLAN_ACCOUNT_ID } from "@ccse/contracts";
import { describe, expect, it, vi } from "vitest";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

describe("upstream accounts", () => {
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
