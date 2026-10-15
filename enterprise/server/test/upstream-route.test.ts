import { describe, expect, it } from "vitest";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

describe("upstream accounts", () => {
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
