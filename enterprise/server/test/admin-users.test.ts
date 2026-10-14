import { UserSchema } from "@ccse/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let adminToken: string;
let adminId: string;

beforeEach(async () => {
  ctx = await setup();
  const s = await login(ctx.app, ADMIN.username, ADMIN.password);
  adminToken = s.accessToken;
  adminId = s.user.id;
});
afterEach(async () => {
  await ctx.close();
});

async function createUser(
  role: "admin" | "member" | "viewer",
  username = "alice",
) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: bearer(adminToken),
    payload: {
      username,
      displayName: "Alice",
      password: "alice-password-1",
      role,
    },
  });
  return res;
}

describe("admin users", () => {
  it("creates, lists and rejects duplicate users", async () => {
    const res = await createUser("member");
    expect(res.statusCode).toBe(201);
    const user = UserSchema.parse(res.json());
    expect(user.role).toBe("member");
    expect(res.body).not.toContain("password");

    expect((await createUser("member")).statusCode).toBe(409);

    const list = await ctx.app.inject({
      url: "/api/v1/admin/users",
      headers: bearer(adminToken),
    });
    expect(
      list.json().items.map((u: { username: string }) => u.username),
    ).toEqual(["admin", "alice"]);
  });

  it("validates username and password policy", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: bearer(adminToken),
      payload: {
        username: "Bad Name",
        displayName: "x",
        password: "short",
        role: "member",
      },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["username", "password"]));
  });

  it("forbids non-admins", async () => {
    await createUser("member");
    const member = await login(ctx.app, "alice", "alice-password-1");
    expect(member.permissions).toEqual(["models.use", "market.install"]);
    const res = await ctx.app.inject({
      url: "/api/v1/admin/users",
      headers: bearer(member.accessToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("disabling a user revokes their sessions immediately", async () => {
    const created = UserSchema.parse((await createUser("member")).json());
    const member = await login(ctx.app, "alice", "alice-password-1");

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${created.id}`,
      headers: bearer(adminToken),
      payload: { disabled: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().disabled).toBe(true);

    const me = await ctx.app.inject({
      url: "/api/v1/me",
      headers: bearer(member.accessToken),
    });
    expect(me.statusCode).toBe(401);
    const relog = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "alice", password: "alice-password-1" },
    });
    expect(relog.statusCode).toBe(401);
  });

  it("role change takes effect on the next request", async () => {
    const created = UserSchema.parse((await createUser("member")).json());
    const member = await login(ctx.app, "alice", "alice-password-1");
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${created.id}`,
      headers: bearer(adminToken),
      payload: { role: "admin" },
    });
    // Old session was revoked; a fresh login carries the new permissions.
    const me = await ctx.app.inject({
      url: "/api/v1/me",
      headers: bearer(member.accessToken),
    });
    expect(me.statusCode).toBe(401);
    const again = await login(ctx.app, "alice", "alice-password-1");
    expect(again.permissions).toContain("users.manage");
  });

  it("deletes a user, ends their session, and refuses self-deletion", async () => {
    const created = UserSchema.parse((await createUser("member")).json());
    const member = await login(ctx.app, "alice", "alice-password-1");

    const self = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${adminId}`,
      headers: bearer(adminToken),
    });
    expect(self.statusCode).toBe(403);

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${created.id}`,
      headers: bearer(adminToken),
    });
    expect(del.statusCode).toBe(204);

    const me = await ctx.app.inject({
      url: "/api/v1/me",
      headers: bearer(member.accessToken),
    });
    expect(me.statusCode).toBe(401);
    const relog = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "alice", password: "alice-password-1" },
    });
    expect(relog.statusCode).toBe(401);

    const list = await ctx.app.inject({
      url: "/api/v1/admin/users",
      headers: bearer(adminToken),
    });
    expect(
      list.json().items.map((u: { username: string }) => u.username),
    ).toEqual(["admin"]);

    const missing = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${created.id}`,
      headers: bearer(adminToken),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("prevents admins from disabling or demoting themselves", async () => {
    for (const payload of [{ disabled: true }, { role: "member" }]) {
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/v1/admin/users/${adminId}`,
        headers: bearer(adminToken),
        payload,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("returns 404 for unknown and 400 for malformed ids", async () => {
    const unknown = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/users/00000000-0000-4000-8000-000000000000",
      headers: bearer(adminToken),
      payload: { displayName: "x" },
    });
    expect(unknown.statusCode).toBe(404);
    const malformed = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/users/not-a-uuid",
      headers: bearer(adminToken),
      payload: { displayName: "x" },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
