import {
  type AdminMenu,
  AdminMenuSchema,
  type Role,
  type SessionResponse,
  UserSchema,
} from "@ccse/contracts";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let admin: SessionResponse;
let sequence = 0;
const password = "menu-test-password";
const range = "?from=2026-10-01&to=2026-10-20";

beforeAll(async () => {
  ctx = await setup();
  admin = await login(ctx.app, ADMIN.username, ADMIN.password);
});
afterAll(async () => {
  await ctx?.close();
});

async function create(adminMenus: AdminMenu[] | null, role: Role = "viewer") {
  const username = `menu-user-${++sequence}`;
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: bearer(admin.accessToken),
    payload: { username, password, role, groupName: "test-group", adminMenus },
  });
  expect(res.statusCode).toBe(201);
  return login(ctx.app, username, password);
}

function get(path: string, session: SessionResponse) {
  return ctx.app.inject({
    url: `/api/v1${path}`,
    headers: bearer(session.accessToken),
  });
}
function patch(id: string, payload: Record<string, unknown>, session = admin) {
  return ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${id}`,
    headers: bearer(session.accessToken),
    payload,
  });
}

describe("per-user admin menus", () => {
  it("enforces each data menu independently on the server", async () => {
    const routes: Partial<Record<AdminMenu, string[]>> = {
      users: ["/admin/users"],
      devices: ["/admin/devices", "/admin/profiles", "/admin/providers"],
      usage: [`/admin/usage${range}`, `/admin/usage/devices${range}`],
      upstream: ["/admin/upstream/accounts", "/admin/usage/coding-plan"],
      conversations: ["/admin/conversations", "/admin/retention-policy"],
    };
    for (const selected of Object.keys(routes) as AdminMenu[]) {
      const session = await create([selected]);
      expect(UserSchema.parse(session.user).adminMenus).toEqual([selected]);
      for (const [menu, paths] of Object.entries(routes)) {
        for (const path of paths) {
          expect(
            (await get(path, session)).statusCode,
            `${selected}: ${path}`,
          ).toBe(
            menu === selected && path !== "/admin/usage/coding-plan"
              ? 200
              : 403,
          );
        }
      }
    }
  });

  it("revokes access and refresh tokens when menu permissions change", async () => {
    const session = await create(["usage"]);
    expect(
      (await patch(session.user.id, { adminMenus: ["mcp", "mcp"] })).json()
        .adminMenus,
    ).toEqual(["mcp"]);
    expect((await get(`/admin/usage${range}`, session)).statusCode).toBe(401);
    const refresh = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    const fresh = await login(ctx.app, session.user.username, password);
    expect(fresh.permissions).toEqual(["mcp.manage"]);
    expect((await get(`/admin/usage${range}`, fresh)).statusCode).toBe(403);
    expect((await get("/me", fresh)).json().permissions).toEqual(
      fresh.permissions,
    );
    expect((await get("/client/config", fresh)).json().permissions).toEqual(
      fresh.permissions,
    );
  });

  it("keeps role defaults, supports clearing and restoring defaults, and preserves admin access", async () => {
    const leader = await create(null, "group_leader");
    expect(leader.permissions).toContain("users.group.manage");
    await patch(leader.user.id, { adminMenus: [] });
    const closed = await login(ctx.app, leader.user.username, password);
    expect(closed.permissions).toEqual(["models.use", "market.install"]);
    await patch(leader.user.id, { adminMenus: null });
    expect(
      (await login(ctx.app, leader.user.username, password)).permissions,
    ).toEqual(leader.permissions);
    const anotherAdmin = await create([], "admin");
    expect(anotherAdmin.permissions).toEqual(admin.permissions);
    expect((await get("/admin/users", anotherAdmin)).statusCode).toBe(200);
  });

  it("rejects unknown menus and prevents delegated users from granting permissions", async () => {
    const user = await create(["users"], "member");
    expect(
      (await patch(user.user.id, { adminMenus: ["invalid"] })).statusCode,
    ).toBe(400);
    expect(
      (
        await patch(
          user.user.id,
          { role: "viewer", adminMenus: ["devices"] },
          user,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await patch(admin.user.id, { role: "viewer" }, user)).statusCode,
    ).toBe(403);
    const outsider = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: bearer(admin.accessToken),
      payload: {
        username: "outsider-menu",
        password,
        role: "member",
        groupName: "other-group",
      },
    });
    expect(
      (await patch(outsider.json().id, { role: "viewer" }, user)).statusCode,
    ).toBe(403);
  });

  it("allows limited user selectors without opening user management", async () => {
    const session = await create(["mcp"]);
    const res = await get("/admin/user-options", session);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().items[0]).sort()).toEqual([
      "displayName",
      "groupName",
      "id",
      "username",
    ]);
    expect((await get("/admin/users", session)).statusCode).toBe(403);
  });

  it("allows retention management through the conversation menu independently of devices", async () => {
    for (const menu of ["devices", "conversations"] as const) {
      const session = await create([menu]);
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/v1/admin/retention-policy",
        headers: bearer(session.accessToken),
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(menu === "conversations" ? 200 : 403);
    }
  });

  it("isolates marketplace publish, edit, delete and package access by kind", async () => {
    const definitions = {
      mcp: { type: "stdio", command: "node", args: [] },
      connector: { type: "dws" },
      prompt: { content: "Team rules" },
    };
    const publish = (kind: string, id: string, session: SessionResponse) =>
      ctx.app.inject({
        method: "PUT",
        url: `/api/v1/admin/market/items/${id}?kind=${kind}&name=Test&version=1.0.0`,
        headers: bearer(session.accessToken),
        payload: definitions[kind as keyof typeof definitions],
      });
    for (const menu of ["mcp", "connectors", "prompts"] as const) {
      const kind =
        menu === "connectors"
          ? "connector"
          : menu === "prompts"
            ? "prompt"
            : "mcp";
      const session = await create([menu]);
      const id = `test-${kind}`;
      expect((await publish(kind, id, session)).statusCode).toBe(200);
      const wrongKind = kind === "mcp" ? "prompt" : "mcp";
      expect(
        (await publish(wrongKind, `wrong-${kind}`, session)).statusCode,
      ).toBe(403);
      // Replacing an existing item with an allowed kind must not bypass its original kind.
      await publish(wrongKind, `other-${kind}`, admin);
      expect((await publish(kind, `other-${kind}`, session)).statusCode).toBe(
        403,
      );
      for (const method of ["PATCH", "DELETE"] as const) {
        const res = await ctx.app.inject({
          method,
          url: `/api/v1/admin/market/items/other-${kind}`,
          headers: bearer(session.accessToken),
          ...(method === "PATCH" ? { payload: { mandatory: true } } : {}),
        });
        expect(res.statusCode).toBe(403);
      }
      expect(
        (await get(`/market/items/other-${kind}/package`, session)).statusCode,
      ).toBe(404);
      expect(
        (await get(`/market/items/${id}/package`, session)).statusCode,
      ).toBe(200);
      expect(
        (await get("/market/items", session))
          .json()
          .items.every((item: { kind: string }) => item.kind === kind),
      ).toBe(true);
    }
    // All nine menu identifiers are accepted, including the skill/plugin menu.
    expect((await create([...AdminMenuSchema.options])).permissions).toContain(
      "skills.manage",
    );
  });

  it("delegates skill/plugin management without granting the other market menus", async () => {
    const session = await create(["skills"]);
    const payload = Buffer.from(
      zipSync({
        "SKILL.md": strToU8(
          "---\nname: delegated\ndescription: Demo\n---\nHello\n",
        ),
      }),
    );
    const uploaded = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/admin/market/items/delegated?kind=skill&name=Demo&version=1.0.0",
      headers: {
        ...bearer(session.accessToken),
        "content-type": "application/zip",
      },
      payload,
    });
    expect(uploaded.statusCode).toBe(200);
    const changed = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/delegated",
      headers: bearer(session.accessToken),
      payload: { mandatory: true },
    });
    expect(changed.statusCode).toBe(200);
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/market/items/delegated",
      headers: bearer(session.accessToken),
    });
    expect(removed.statusCode).toBe(204);
  });
});
