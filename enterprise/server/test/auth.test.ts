import {
  ClientConfigResponseSchema,
  ErrorResponseSchema,
  SessionResponseSchema,
} from "@ccse/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.ts";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

describe("auth", () => {
  it("prevents caching of successful and failed authentication responses", async () => {
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: ADMIN,
    });
    expect(first.statusCode).toBe(200);
    const session = SessionResponseSchema.parse(first.json());
    expect(first.json().user).not.toHaveProperty("password");
    expect(first.json().user).not.toHaveProperty("passwordHash");
    const failed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { ...ADMIN, password: "wrong-password" },
    });
    expect(failed.statusCode).toBe(401);
    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: session.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    for (const response of [first, failed, refreshed]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("preserves HTTP login compatibility in production", async () => {
    ctx.config.env = "production";
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(SessionResponseSchema.parse(res.json()).refreshToken).toBeTruthy();
  });

  it("does not disclose whether an account is disabled", async () => {
    await ctx.db
      .update(users)
      .set({ disabled: true })
      .where(eq(users.username, ADMIN.username));
    const disabled = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: ADMIN,
    });
    const unknown = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { ...ADMIN, username: "nonexistent-user" },
    });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toEqual(unknown.json());
  });

  it("logs in and returns a session matching the contract", async () => {
    const session = await login(ctx.app, ADMIN.username, ADMIN.password);
    expect(SessionResponseSchema.parse(session).user.role).toBe("admin");
    expect(session.permissions).toContain("users.manage");
    expect(session.user.lastLoginAt).not.toBeNull();
  });

  it("is case-insensitive on username", async () => {
    await expect(login(ctx.app, "ADMIN", ADMIN.password)).resolves.toBeTruthy();
  });

  it("rejects a wrong password with the uniform error shape", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: ADMIN.username, password: "nope-nope-nope" },
    });
    expect(res.statusCode).toBe(401);
    expect(ErrorResponseSchema.parse(res.json()).error.code).toBe(
      "unauthorized",
    );
  });

  it("rate-limits repeated failures per account", async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: ADMIN.username, password: "wrong-password" },
      });
    }
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
  });

  it("rejects malformed bodies without echoing input", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: 12345 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("12345");
  });

  it("requires a valid bearer token for /me", async () => {
    expect((await ctx.app.inject({ url: "/api/v1/me" })).statusCode).toBe(401);
    const bad = await ctx.app.inject({
      url: "/api/v1/me",
      headers: bearer("not-a-jwt"),
    });
    expect(bad.statusCode).toBe(401);

    const session = await login(ctx.app, ADMIN.username, ADMIN.password);
    const ok = await ctx.app.inject({
      url: "/api/v1/me",
      headers: bearer(session.accessToken),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.username).toBe(ADMIN.username);
  });

  it("rotates refresh tokens and revokes the session on reuse", async () => {
    const first = await login(ctx.app, ADMIN.username, ADMIN.password);
    const refresh = (token: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: token },
      });

    const r1 = await refresh(first.refreshToken);
    expect(r1.statusCode).toBe(200);
    const second = SessionResponseSchema.parse(r1.json());
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Replaying the old token kills the session, including the new tokens.
    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
    expect((await refresh(second.refreshToken)).statusCode).toBe(401);
    const me = await ctx.app.inject({
      url: "/api/v1/me",
      headers: bearer(second.accessToken),
    });
    expect(me.statusCode).toBe(401);
  });

  it("logout revokes the session", async () => {
    const session = await login(ctx.app, ADMIN.username, ADMIN.password);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refreshToken: session.refreshToken },
    });
    expect(res.statusCode).toBe(204);
    const me = await ctx.app.inject({
      url: "/api/v1/me",
      headers: bearer(session.accessToken),
    });
    expect(me.statusCode).toBe(401);
  });

  it("serves client config matching the contract", async () => {
    const session = await login(ctx.app, ADMIN.username, ADMIN.password);
    const res = await ctx.app.inject({
      url: "/api/v1/client/config",
      headers: bearer(session.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(ClientConfigResponseSchema.parse(res.json()).user.username).toBe(
      ADMIN.username,
    );
  });

  it("returns not_found for unknown routes", async () => {
    const res = await ctx.app.inject({ url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});
