import { describe, expect, it, vi } from "vitest";
import { clearSub2ApiTokenCache } from "../src/sub2api.ts";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

describe("upstream user sync", () => {
  it("does not apply a partial upstream snapshot when a later page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/auth/login"))
          return Response.json({ data: { access_token: "token" } });
        if (url.searchParams.get("page") === "1")
          return Response.json({
            data: {
              total: 101,
              items: Array.from({ length: 100 }, (_, i) => ({
                id: i + 1,
                name: `user${i}`,
                group_id: null,
              })),
            },
          });
        return Response.json({ message: "failed" }, { status: 503 });
      }),
    );
    const ctx = await setup({
      SUB2API_URL: "https://upstream.test",
      SUB2API_EMAIL: "admin@example.com",
      SUB2API_PASSWORD: "secret",
    });
    try {
      const admin = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(admin.accessToken);
      const result = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/admin/users/sync-upstream",
        headers,
      });
      expect(result.statusCode).toBe(500);
      const list = await ctx.app.inject({
        url: "/api/v1/admin/users",
        headers,
      });
      expect(list.json().items).toHaveLength(1);
    } finally {
      await ctx.close();
      vi.unstubAllGlobals();
      clearSub2ApiTokenCache();
    }
  });
  it("imports names and groups, preserves local users and credentials, and locks imported groups", async () => {
    let entries = [
      {
        id: 1,
        name: "吴肖艳",
        group_id: 3,
        group: { name: "中台组" },
        key: "must-not-be-stored",
      },
      { id: 2, name: "已有用户", group_id: 4, group: { name: "新分组" } },
      { id: 3, name: "重复用户", group_id: 3, group: { name: "中台组" } },
      { id: 4, name: "重复用户", group_id: 4, group: { name: "新分组" } },
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/auth/login"))
        return Response.json({ data: { access_token: "token" } });
      if (path.endsWith("/keys"))
        return Response.json({
          data: { items: entries, total: entries.length },
        });
      throw new Error(`Unexpected upstream request ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const ctx = await setup({
      SUB2API_URL: "https://upstream.test",
      SUB2API_EMAIL: "admin@example.com",
      SUB2API_PASSWORD: "secret",
    });
    try {
      const admin = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(admin.accessToken);
      const create = async (username: string) =>
        ctx.app.inject({
          method: "POST",
          url: "/api/v1/admin/users",
          headers,
          payload: {
            username,
            password: "old-password",
            role: "member",
            groupName: "本地组",
          },
        });
      const local = (await create("本地用户")).json();
      const existing = (await create("已有用户")).json();
      const sync = () =>
        ctx.app.inject({
          method: "POST",
          url: "/api/v1/admin/users/sync-upstream",
          headers,
        });
      expect((await sync()).json()).toEqual({
        created: 1,
        updated: 1,
        skipped: 2,
      });
      const list = async () =>
        (await ctx.app.inject({ url: "/api/v1/admin/users", headers })).json()
          .items;
      let rows = await list();
      const imported = rows.find(
        (u: { username: string }) => u.username === "吴肖艳",
      );
      expect(imported).toMatchObject({
        groupName: "中台组",
        upstreamSynced: true,
      });
      expect(
        rows.find((u: { id: string }) => u.id === existing.id),
      ).toMatchObject({ groupName: "新分组", upstreamSynced: true });
      expect(rows.find((u: { id: string }) => u.id === local.id)).toMatchObject(
        { groupName: "本地组", upstreamSynced: false },
      );
      await login(ctx.app, "吴肖艳", "123456");
      await login(ctx.app, "已有用户", "old-password");
      expect(
        (
          await ctx.app.inject({
            method: "PATCH",
            url: `/api/v1/admin/users/${imported.id}`,
            headers,
            payload: { groupName: "手动组" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await ctx.app.inject({
            method: "PATCH",
            url: `/api/v1/admin/users/${local.id}`,
            headers,
            payload: { groupName: "手动组" },
          })
        ).statusCode,
      ).toBe(200);
      entries = [
        { id: 1, name: "吴肖艳", group_id: 5, group: { name: "调整组" } },
      ];
      expect((await sync()).json()).toEqual({
        created: 0,
        updated: 1,
        skipped: 0,
      });
      rows = await list();
      expect(
        rows.find((u: { id: string }) => u.id === imported.id).groupName,
      ).toBe("调整组");
      expect(
        rows.find((u: { id: string }) => u.id === local.id).groupName,
      ).toBe("手动组");
      expect(JSON.stringify(rows)).not.toContain("must-not-be-stored");
      expect(
        fetcher.mock.calls.every(
          ([url]) => !String(url).includes("/admin/users"),
        ),
      ).toBe(true);
    } finally {
      await ctx.close();
      vi.unstubAllGlobals();
      clearSub2ApiTokenCache();
    }
  });
});
