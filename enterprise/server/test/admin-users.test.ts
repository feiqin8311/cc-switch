import { OffboardUserResponseSchema, UserSchema } from "@ccse/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, devices } from "../src/db/schema.ts";
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
        password: "short",
        role: "member",
      },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["username", "password"]));
  });

  it("accepts a Chinese username and defaults displayName to it", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: bearer(adminToken),
      payload: {
        username: "张三",
        password: "alice-password-1",
        role: "member",
      },
    });
    expect(res.statusCode).toBe(201);
    const user = UserSchema.parse(res.json());
    expect(user.username).toBe("张三");
    expect(user.displayName).toBe("张三");
    const session = await login(ctx.app, "张三", "alice-password-1");
    expect(session.user.username).toBe("张三");
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

  it("offboards a user: disables, signs out, disables devices, keeps data", async () => {
    const created = UserSchema.parse((await createUser("member")).json());
    const member = await login(ctx.app, "alice", "alice-password-1");
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const beat = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/devices/heartbeat",
      headers: bearer(member.accessToken),
      payload: {
        deviceId,
        name: "Alice-Mac",
        hostname: "alice-mac",
        reported: {
          mode: "direct",
          activeProviderId: "codex-official",
          activeProviderName: "default",
          providers: [
            { id: "codex-official", name: "default", managed: false },
          ],
          stackMemberIds: [],
        },
      },
    });
    expect(beat.statusCode).toBe(200);

    const self = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${adminId}/offboard`,
      headers: bearer(adminToken),
    });
    expect(self.statusCode).toBe(403);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.id}/offboard`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = OffboardUserResponseSchema.parse(res.json());
    expect(body.revokedSessions).toBe(1);
    expect(body.disabledDevices).toBe(1);
    expect(body.user.disabled).toBe(true);
    expect(body.user.offboardedAt).not.toBeNull();
    expect(body.user.offboardedBy).toBe("admin");

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

    const [device] = await ctx.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId));
    expect(device?.disabled).toBe(true);
    expect(device?.userId).toBe(created.id);

    const events = await ctx.db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "user.offboard",
      actorId: adminId,
      actorUsername: "admin",
      targetUserId: created.id,
      targetUsername: "alice",
      detail: { revokedSessions: 1, disabledDeviceIds: [deviceId] },
    });

    const again = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.id}/offboard`,
      headers: bearer(adminToken),
    });
    expect(again.statusCode).toBe(409);

    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/admin/users/33333333-3333-4333-8333-333333333333/offboard",
      headers: bearer(adminToken),
    });
    expect(missing.statusCode).toBe(404);

    // Re-enabling (e.g. a rehire) clears the offboard marker.
    const enabled = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${created.id}`,
      headers: bearer(adminToken),
      payload: { disabled: false },
    });
    expect(enabled.statusCode).toBe(200);
    const user = UserSchema.parse(enabled.json());
    expect(user.disabled).toBe(false);
    expect(user.offboardedAt).toBeNull();
    expect(user.offboardedBy).toBeNull();
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

  it("stores unique upstream account ids on a member", async () => {
    const created = UserSchema.parse((await createUser("member")).json());
    expect(created.upstreamAccountIds).toEqual([]);
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${created.id}`,
      headers: bearer(adminToken),
      payload: { upstreamAccountIds: [39, 39, 12] },
    });
    expect(patch.statusCode).toBe(200);
    expect(UserSchema.parse(patch.json()).upstreamAccountIds).toEqual([39, 12]);
  });

  it("stores a trimmed group name and allows clearing it", async () => {
    const created = UserSchema.parse((await createUser("member")).json());
    expect(created.groupName).toBe("");
    const set = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${created.id}`,
      headers: bearer(adminToken),
      payload: { groupName: " Libraton组 " },
    });
    expect(set.statusCode).toBe(200);
    expect(UserSchema.parse(set.json()).groupName).toBe("Libraton组");
    const cleared = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${created.id}`,
      headers: bearer(adminToken),
      payload: { groupName: "  " },
    });
    expect(cleared.statusCode).toBe(200);
    expect(UserSchema.parse(cleared.json()).groupName).toBe("");
  });
});
