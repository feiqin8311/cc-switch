import {
  ReconciledUsageResponseSchema,
  UsageResponseSchema,
} from "@ccse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.ts";
import { usageRecords, users } from "../src/db/schema.ts";
import { clearSub2ApiTokenCache } from "../src/sub2api.ts";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let token: string;
let userId: string;
const origin = "https://upstream.test";

beforeEach(async () => {
  ctx = await setup({
    SUB2API_URL: origin,
    SUB2API_EMAIL: "x@example.test",
    SUB2API_PASSWORD: "test",
  });
  const session = await login(ctx.app, ADMIN.username, ADMIN.password);
  token = session.accessToken;
  userId = session.user.id;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  clearSub2ApiTokenCache();
  await ctx.close();
});

const apiRow = (id: number, date: string, keyId: number, extra = {}) => ({
  id,
  api_key_id: keyId,
  model: "gpt-5",
  input_tokens: 80,
  output_tokens: 10,
  cache_read_tokens: 20,
  cache_creation_tokens: 0,
  actual_cost: 0.12,
  total_cost: 0.15,
  created_at: `${date}T12:00:00Z`,
  api_key: { name: `key-${keyId}`, key: "secret-not-to-return" },
  account: { name: "upstream-account" },
  group: { name: keyId === 1 ? "研发" : "其他" },
  ...extra,
});
function mockUpstream() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/auth/login"))
        return Response.json({ data: { access_token: "test" } });
      expect(url.searchParams.get("timezone")).toBe("UTC");
      const day = url.searchParams.get("start_date");
      const items =
        day === "2026-11-06"
          ? [
              apiRow(1, day, 1),
              apiRow(2, day, 2),
              apiRow(3, day, 1, {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                actual_cost: 0,
                total_cost: 0,
              }),
            ]
          : [apiRow(4, "2026-11-07", 1)];
      return Response.json({ data: { items } });
    }),
  );
}
const url = (day: string) =>
  `/api/v1/admin/usage/upstream?from=${day}&to=${day}`;

describe("independent usage views", () => {
  it("includes all upstream records for the selected date and retains overlapping CC usage", async () => {
    mockUpstream();
    await ctx.db.insert(usageRecords).values({
      userId,
      providerId: "hub",
      model: "gpt-5",
      inputTokens: 100,
      outputTokens: 10,
      status: 200,
      latencyMs: 10,
      createdAt: new Date("2026-11-06T12:00:00Z"),
    });
    const cc = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/usage?from=2026-11-06&to=2026-11-06",
      headers: bearer(token),
    });
    expect(UsageResponseSchema.parse(cc.json()).items).toMatchObject([
      { requests: 1, inputTokens: 100 },
    ]);
    const response = await ctx.app.inject({
      method: "GET",
      url: url("2026-11-06"),
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    const data = ReconciledUsageResponseSchema.parse(response.json());
    expect(data.items.reduce((sum, row) => sum + row.requests, 0)).toBe(3);
    expect(data.items.find((row) => row.username === "key-1")).toMatchObject({
      source: "upstream",
      providerId: "upstream-account",
      requests: 2,
      inputTokens: 100,
      outputTokens: 10,
      estimatedCostUsd: 0.12,
      actualRequests: 2,
    });
    expect(response.body).not.toContain("secret-not-to-return");
    const next = await ctx.app.inject({
      method: "GET",
      url: url("2026-11-07"),
      headers: bearer(token),
    });
    expect(
      ReconciledUsageResponseSchema.parse(next.json()).items,
    ).toMatchObject([{ date: "2026-11-07", requests: 1 }]);
  });

  it("limits group leaders to linked keys in their group", async () => {
    mockUpstream();
    await ctx.db.insert(users).values([
      {
        username: "leader",
        displayName: "leader",
        passwordHash: await hashPassword("password-123"),
        role: "group_leader",
        groupName: "研发",
      },
      {
        username: "member",
        displayName: "member",
        passwordHash: await hashPassword("password-123"),
        role: "member",
        groupName: "研发",
        upstreamKeyOrigin: origin,
        upstreamKeyId: 1,
      },
    ]);
    const leader = await login(ctx.app, "leader", "password-123");
    const response = await ctx.app.inject({
      method: "GET",
      url: url("2026-11-06"),
      headers: bearer(leader.accessToken),
    });
    expect(response.statusCode).toBe(200);
    expect(
      ReconciledUsageResponseSchema.parse(response.json()).items,
    ).toMatchObject([{ username: "key-1", requests: 2 }]);
  });
});
