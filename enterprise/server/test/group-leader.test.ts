import type { Role, SessionResponse, User } from "@ccse/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  devices,
  deviceUsageDaily,
  usageRecords,
  users,
} from "../src/db/schema.ts";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let admin: SessionResponse;
let leader: SessionResponse;
let peer: User;
let member: User;
let outsider: User;
let ungrouped: SessionResponse;
const password = "test-password-123";
const groupName = "Libraton组";
const range = "?from=2026-10-01&to=2026-10-20";

async function create(username: string, role: Role, groupName: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: bearer(admin.accessToken),
    payload: { username, password, role, groupName },
  });
  expect(res.statusCode).toBe(201);
  return res.json<User>();
}

const get = (path: string, session = leader) =>
  ctx.app.inject({
    url: `/api/v1${path}`,
    headers: bearer(session.accessToken),
  });
const patch = (id: string, payload: Record<string, unknown>) =>
  ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${id}`,
    headers: bearer(leader.accessToken),
    payload,
  });

beforeAll(async () => {
  ctx = await setup();
  admin = await login(ctx.app, ADMIN.username, ADMIN.password);
  await create("leader", "group_leader", groupName);
  leader = await login(ctx.app, "leader", password);
  peer = await create("peer", "group_leader", groupName);
  member = await create("member", "member", groupName);
  outsider = await create("outsider", "member", "其他组");
  await create("ungrouped-leader", "group_leader", "");
  ungrouped = await login(ctx.app, "ungrouped-leader", password);
  await ctx.db
    .update(users)
    .set({ groupName })
    .where(eq(users.id, admin.user.id));

  for (const [i, user] of [member, outsider, admin.user].entries()) {
    const deviceId = `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`;
    await ctx.db.insert(devices).values({
      id: deviceId,
      userId: user.id,
      name: user.username,
      reported: {},
    });
    await ctx.db.insert(deviceUsageDaily).values({
      deviceId,
      userId: user.id,
      date: "2026-10-20",
      providerId: "test",
      model: "test",
      requests: 1,
      inputTokens: 10,
      outputTokens: 2,
    });
    await ctx.db.insert(usageRecords).values({
      userId: user.id,
      providerId: "test",
      model: "test",
      inputTokens: 10,
      outputTokens: 2,
      status: 200,
      latencyMs: 1,
      createdAt: new Date("2026-10-20T00:00:00Z"),
    });
  }
});
afterAll(async () => {
  await ctx?.close();
});

describe("group leader", () => {
  it("is assignable by admins and lists only its own group", async () => {
    expect(leader.user.role).toBe("group_leader");
    expect(leader.permissions).toContain("models.use");
    const res = await get("/admin/users");
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .items.map((u: User) => u.username)
        .sort(),
    ).toEqual(["admin", "leader", "member", "peer"]);
  });

  it("can change member/viewer roles and revokes the affected user's sessions", async () => {
    const session = await login(ctx.app, member.username, password);
    expect((await patch(member.id, { role: "viewer" })).statusCode).toBe(200);
    expect((await get("/me", session)).statusCode).toBe(401);
    expect((await patch(member.id, { role: "member" })).statusCode).toBe(200);
  });

  it("rejects promotions, privileged targets and other groups", async () => {
    for (const role of ["admin", "group_leader"]) {
      expect((await patch(member.id, { role })).statusCode).toBe(400);
    }
    for (const id of [peer.id, admin.user.id, leader.user.id, outsider.id]) {
      expect((await patch(id, { role: "viewer" })).statusCode).toBe(403);
    }
  });

  it("rejects every field except role, including unknown fields", async () => {
    for (const field of [
      { username: "renamed" },
      { displayName: "renamed" },
      { groupName: "其他组" },
      { password: "new-password" },
      { disabled: true },
      { upstreamAccountIds: [1] },
      { unexpected: true },
    ]) {
      expect(
        (await patch(member.id, { role: "viewer", ...field })).statusCode,
      ).toBe(400);
    }
    const [row] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.id, member.id));
    expect(row?.role).toBe("member");
    expect(row?.groupName).toBe(groupName);
  });

  it("cannot create, delete, offboard users or access unrelated admin pages", async () => {
    for (const [method, path, payload] of [
      [
        "POST",
        "/admin/users",
        { username: "new-user", password, role: "member" },
      ],
      ["DELETE", `/admin/users/${member.id}`, undefined],
      ["POST", `/admin/users/${member.id}/offboard`, undefined],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url: `/api/v1${path}`,
        headers: bearer(leader.accessToken),
        payload,
      });
      expect(res.statusCode).toBe(403);
    }
    for (const path of [
      "/admin/providers",
      "/admin/devices",
      "/admin/conversations",
      "/admin/upstream/accounts",
    ]) {
      expect((await get(path)).statusCode).toBe(403);
    }
  });

  it("scopes both usage endpoints on the server while admins retain all groups", async () => {
    for (const path of ["/admin/usage", "/admin/usage/devices"]) {
      const res = await get(
        `${path}${range}&groupName=其他组&userId=${outsider.id}`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(2);
      expect(
        res
          .json()
          .items.every((r: { groupName: string }) => r.groupName === groupName),
      ).toBe(true);
      expect((await get(path + range, admin)).json().items).toHaveLength(3);
    }
  });

  it("denies ungrouped leaders access to ungrouped accounts and usage", async () => {
    for (const path of [
      "/admin/users",
      `/admin/usage${range}`,
      `/admin/usage/devices${range}`,
    ]) {
      const res = await get(path, ungrouped);
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
    }
  });

  it("uses the leader's current group on each request", async () => {
    await ctx.db
      .update(users)
      .set({ groupName: "其他组" })
      .where(eq(users.id, leader.user.id));
    const res = await get("/admin/users");
    expect(
      res
        .json()
        .items.map((u: User) => u.username)
        .sort(),
    ).toEqual(["leader", "outsider"]);
    expect((await patch(member.id, { role: "viewer" })).statusCode).toBe(403);
    for (const path of ["/admin/usage", "/admin/usage/devices"]) {
      const usage = await get(path + range);
      expect(
        usage.json().items.map((r: { userId: string }) => r.userId),
      ).toEqual([outsider.id]);
    }
    const moved = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${leader.user.id}`,
      headers: bearer(admin.accessToken),
      payload: { groupName },
    });
    expect(moved.statusCode).toBe(200);
    expect((await get("/me")).statusCode).toBe(401);
  });
});
