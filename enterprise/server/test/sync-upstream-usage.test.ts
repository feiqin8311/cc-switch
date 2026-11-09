import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upstreamUsageRecords } from "../src/db/schema.ts";
import { clearSub2ApiTokenCache } from "../src/sub2api.ts";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let token: string;

beforeEach(async () => {
  ctx = await setup({
    SUB2API_URL: "https://upstream.test",
    SUB2API_EMAIL: "test@example.com",
    SUB2API_PASSWORD: "test-only",
  });
  token = (await login(ctx.app, ADMIN.username, ADMIN.password)).accessToken;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  clearSub2ApiTokenCache();
  await ctx.close();
});

const usage = (id: number) => ({
  id,
  api_key_id: 1,
  model: "example",
  input_tokens: 10,
  output_tokens: 2,
  actual_cost: 0.1,
  created_at: "2026-11-06T12:00:00+08:00",
});

function sync(payload: object) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/usage/sync-upstream",
    headers: bearer(token),
    payload,
  });
}

describe("upstream usage sync", () => {
  it("validates dates before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (await sync({ from: "2026-02-30", to: "2026-03-01" })).statusCode,
    ).toBe(400);
    expect(
      (await sync({ from: "2026-01-01", to: "2026-05-01" })).statusCode,
    ).toBe(400);
    expect(
      (await sync({ from: "2026-11-07", to: "2026-11-06" })).statusCode,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates an existing upstream identity without inserting it twice", async () => {
    let cost = 0.1;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/auth/login"))
          return Response.json({ data: { access_token: "test" } });
        if (url.pathname.endsWith("/keys"))
          return Response.json({
            data: { items: [{ id: 1, key: "test-key" }] },
          });
        return Response.json({
          data: { items: [{ ...usage(1), actual_cost: cost }] },
        });
      }),
    );
    const range = { from: "2026-11-06", to: "2026-11-06" };
    expect((await sync(range)).statusCode).toBe(200);
    cost = 0.2;
    expect((await sync(range)).statusCode).toBe(200);
    const records = await ctx.db.select().from(upstreamUsageRecords);
    expect(records).toHaveLength(1);
    expect(records[0]?.payload.actualCost).toBe(0.2);
  });

  it("does not persist a partial result when a later page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/auth/login"))
          return Response.json({ data: { access_token: "test" } });
        return Number(url.searchParams.get("page")) === 1
          ? Response.json({
              data: {
                items: Array.from({ length: 100 }, (_, i) => usage(i + 1)),
              },
            })
          : new Response("failure", { status: 500 });
      }),
    );
    expect(
      (await sync({ from: "2026-11-06", to: "2026-11-06" })).statusCode,
    ).toBe(500);
    expect(await ctx.db.select().from(upstreamUsageRecords)).toHaveLength(0);
  });

  it("does not commit when successive scans disagree", async () => {
    let scan = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/auth/login"))
          return Response.json({ data: { access_token: "test" } });
        return Response.json({ data: { items: [usage(++scan)] } });
      }),
    );
    expect(
      (await sync({ from: "2026-11-06", to: "2026-11-06" })).statusCode,
    ).toBe(500);
    expect(await ctx.db.select().from(upstreamUsageRecords)).toHaveLength(0);
  });
});
