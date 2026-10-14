import { describe, expect, it } from "vitest";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

describe("GET /admin/upstream/accounts", () => {
  it("returns configured:false when Sub2API env is unset", async () => {
    const ctx = await setup();
    try {
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/admin/upstream/accounts",
        headers: bearer(session.accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(false);
      expect(body.items).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
