import {
  AdminProviderSchema,
  ListProvidersResponseSchema,
  UsageResponseSchema,
} from "@ccse/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providers, usageRecords } from "../src/db/schema.ts";
import { decryptSecret } from "../src/secrets.ts";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

const API_KEY = "sk-proj-very-secret-key-wxyz";

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

const basePayload = {
  id: "openai-main",
  name: "OpenAI",
  baseUrl: "https://api.example.com/v1",
  apiKey: API_KEY,
  models: [
    { id: "gpt-5", displayName: "GPT-5" },
    { id: "gpt-5-mini", displayName: "GPT-5 mini" },
  ],
  defaultModel: "gpt-5",
  allowedUserIds: [],
  allowedGroups: ["技术部"],
};

function api(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  token = adminToken,
) {
  return ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function createMember(role: "member" | "viewer", username: string) {
  const res = await api("POST", "/admin/users", {
    username,
    displayName: username,
    password: "password-123",
    role,
  });
  expect(res.statusCode).toBe(201);
  return login(ctx.app, username, "password-123");
}

describe("admin providers", () => {
  it("creates, lists, updates and deletes without ever returning the api key", async () => {
    const created = await api("POST", "/admin/providers", basePayload);
    expect(created.statusCode).toBe(201);
    const provider = AdminProviderSchema.parse(created.json());
    expect(provider).toMatchObject({
      id: "openai-main",
      wireApi: "responses",
      apiKeyHint: "sk-…wxyz",
      dailyTokenLimitPerUser: null,
      enabled: true,
    });

    const [row] = await ctx.db
      .select()
      .from(providers)
      .where(eq(providers.id, "openai-main"));
    expect(row?.apiKeyEnc).not.toContain(API_KEY);
    expect(decryptSecret(ctx.config.secretsKey, row?.apiKeyEnc ?? "")).toBe(
      API_KEY,
    );

    expect(
      (await api("POST", "/admin/providers", basePayload)).statusCode,
    ).toBe(409);

    const list = await api("GET", "/admin/providers");
    expect(ListProvidersResponseSchema.parse(list.json()).items).toHaveLength(
      1,
    );

    const patched = await api("PATCH", "/admin/providers/openai-main", {
      name: "OpenAI 2",
      dailyTokenLimitPerUser: 5000,
      apiKey: "sk-another-key-9876",
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: "OpenAI 2",
      dailyTokenLimitPerUser: 5000,
      apiKeyHint: "sk-…9876",
    });

    const keep = await api("PATCH", "/admin/providers/openai-main", {
      enabled: false,
    });
    expect(keep.json().apiKeyHint).toBe("sk-…9876");

    for (const res of [created, list, patched, keep]) {
      expect(res.body).not.toContain(API_KEY);
      expect(res.body).not.toContain("sk-another-key-9876");
      expect(res.body).not.toContain("apiKeyEnc");
      expect(res.body).not.toMatch(/"apiKey"/);
    }

    const del = await api("DELETE", "/admin/providers/openai-main");
    expect(del.statusCode).toBe(204);
    expect(
      (await api("DELETE", "/admin/providers/openai-main")).statusCode,
    ).toBe(404);
    expect(
      (await api("PATCH", "/admin/providers/openai-main", { name: "x" }))
        .statusCode,
    ).toBe(404);
  });

  it("validates bodies and keeps models/defaultModel consistent", async () => {
    const bad = await api("POST", "/admin/providers", {
      ...basePayload,
      id: "Bad Id",
      baseUrl: "ftp://x",
      defaultModel: "nope",
    });
    expect(bad.statusCode).toBe(400);

    await api("POST", "/admin/providers", basePayload);
    const dropDefault = await api("PATCH", "/admin/providers/openai-main", {
      models: [{ id: "gpt-5-mini", displayName: "mini" }],
    });
    expect(dropDefault.statusCode).toBe(400);
    expect(dropDefault.json().error.code).toBe("bad_request");

    const badDefault = await api("PATCH", "/admin/providers/openai-main", {
      defaultModel: "gpt-4",
    });
    expect(badDefault.statusCode).toBe(400);

    const both = await api("PATCH", "/admin/providers/openai-main", {
      models: [{ id: "gpt-5-mini", displayName: "mini" }],
      defaultModel: "gpt-5-mini",
    });
    expect(both.statusCode).toBe(200);
    expect(both.json().defaultModel).toBe("gpt-5-mini");

    expect(
      (await api("PATCH", "/admin/providers/openai-main", {})).statusCode,
    ).toBe(400);
  });

  it("validates allowedUserIds exist when creating or updating", async () => {
    const nonexistent = "00000000-0000-0000-0000-000000000000";
    const res = await api("POST", "/admin/providers", {
      ...basePayload,
      id: "invalid-user",
      allowedUserIds: [nonexistent],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");

    const member = await createMember("member", "validuser");
    const ok = await api("POST", "/admin/providers", {
      ...basePayload,
      id: "valid-user",
      allowedUserIds: [member.user.id],
      allowedGroups: ["研发部"],
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().allowedUserIds).toEqual([member.user.id]);
    expect(ok.json().allowedGroups).toEqual(["研发部"]);
  });

  it("forbids members and viewers", async () => {
    await api("POST", "/admin/providers", basePayload);
    const member = await createMember("member", "mia");
    const viewer = await createMember("viewer", "vic");
    for (const token of [member.accessToken, viewer.accessToken]) {
      for (const [method, url, payload] of [
        ["GET", "/admin/providers", undefined],
        ["POST", "/admin/providers", { ...basePayload, id: "other" }],
        ["PATCH", "/admin/providers/openai-main", { name: "x" }],
        ["DELETE", "/admin/providers/openai-main", undefined],
        ["GET", "/admin/usage?from=2026-01-01&to=2026-01-02", undefined],
      ] as const) {
        const res = await api(method, url, payload, token);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().error.code).toBe("forbidden");
      }
    }
  });
});

describe("admin usage", () => {
  it("aggregates by UTC date, user, provider and model", async () => {
    const member = await createMember("member", "mia");
    const at = (iso: string) => new Date(iso);
    const base = { status: 200, latencyMs: 10 };
    await ctx.db.insert(usageRecords).values([
      // 2026-03-01 (UTC), admin, p1/gpt-5 ×2
      {
        ...base,
        userId: adminId,
        providerId: "p1",
        model: "gpt-5",
        inputTokens: 10,
        outputTokens: 1,
        createdAt: at("2026-03-01T00:00:00Z"),
      },
      {
        ...base,
        userId: adminId,
        providerId: "p1",
        model: "gpt-5",
        inputTokens: 20,
        outputTokens: 2,
        createdAt: at("2026-03-01T23:59:59Z"),
      },
      // same day, different model / user
      {
        ...base,
        userId: adminId,
        providerId: "p1",
        model: "gpt-5-mini",
        inputTokens: 5,
        outputTokens: 5,
        createdAt: at("2026-03-01T12:00:00Z"),
      },
      {
        ...base,
        userId: member.user.id,
        providerId: "p1",
        model: "gpt-5",
        inputTokens: 7,
        outputTokens: 3,
        createdAt: at("2026-03-01T08:00:00Z"),
      },
      // next UTC day (late evening in UTC-5 would be the 1st)
      {
        ...base,
        userId: adminId,
        providerId: "p1",
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 10,
        createdAt: at("2026-03-02T03:00:00Z"),
      },
      // outside the range
      {
        ...base,
        userId: adminId,
        providerId: "p1",
        model: "gpt-5",
        inputTokens: 999,
        outputTokens: 999,
        createdAt: at("2026-02-28T23:59:59Z"),
      },
      {
        ...base,
        userId: adminId,
        providerId: "p1",
        model: "gpt-5",
        inputTokens: 999,
        outputTokens: 999,
        createdAt: at("2026-03-03T00:00:00Z"),
      },
    ]);

    const res = await api("GET", "/admin/usage?from=2026-03-01&to=2026-03-02");
    expect(res.statusCode).toBe(200);
    expect(UsageResponseSchema.parse(res.json()).items).toEqual([
      {
        date: "2026-03-01",
        userId: adminId,
        username: "admin",
        groupName: "",
        providerId: "p1",
        model: "gpt-5",
        requests: 2,
        inputTokens: 30,
        outputTokens: 3,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.0000675,
        unpricedRequests: 0,
        legacyRequests: 2,
      },
      {
        date: "2026-03-01",
        userId: adminId,
        username: "admin",
        groupName: "",
        providerId: "p1",
        model: "gpt-5-mini",
        requests: 1,
        inputTokens: 5,
        outputTokens: 5,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.00001125,
        unpricedRequests: 0,
        legacyRequests: 1,
      },
      {
        date: "2026-03-01",
        userId: member.user.id,
        username: "mia",
        groupName: "",
        providerId: "p1",
        model: "gpt-5",
        requests: 1,
        inputTokens: 7,
        outputTokens: 3,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.00003875,
        unpricedRequests: 0,
        legacyRequests: 1,
      },
      {
        date: "2026-03-02",
        userId: adminId,
        username: "admin",
        groupName: "",
        providerId: "p1",
        model: "gpt-5",
        requests: 1,
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.000225,
        unpricedRequests: 0,
        legacyRequests: 1,
      },
    ]);
  });

  it("prices each upstream model with caches once and preserves unknown costs", async () => {
    const base = {
      userId: adminId,
      providerId: "p1",
      model: "routed-model",
      status: 200,
      latencyMs: 10,
      createdAt: new Date("2026-03-01T12:00:00Z"),
    };
    await ctx.db.insert(usageRecords).values([
      {
        ...base,
        pricingModel: "gpt-6-luna",
        inputTokens: 1000,
        outputTokens: 200,
        cachedTokens: 600,
        cacheCreationTokens: 100,
      },
      {
        ...base,
        pricingModel: "gpt-5.6-terra",
        inputTokens: 1000,
        outputTokens: 200,
        cachedTokens: 600,
        cacheCreationTokens: 100,
      },
      {
        ...base,
        pricingModel: "unknown-model",
        inputTokens: 1000,
        outputTokens: 200,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      },
      // Bad cache counts are clamped per request, not against the day's total.
      {
        ...base,
        model: "gpt-6-luna",
        inputTokens: 10,
        outputTokens: 0,
        cachedTokens: 100,
        cacheCreationTokens: 50,
      },
      {
        ...base,
        model: "gpt-6-luna",
        inputTokens: 1000,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        ...base,
        model: "unknown-model",
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
    const response = await api(
      "GET",
      "/admin/usage?from=2026-03-01&to=2026-03-01",
    );
    expect(response.statusCode).toBe(200);
    const rows = UsageResponseSchema.parse(response.json()).items;
    expect(rows).toHaveLength(3);
    const routed = rows.find((row) => row.model === "routed-model");
    expect(routed).toMatchObject({
      requests: 3,
      cachedTokens: 1200,
      cacheCreationTokens: 200,
      unpricedRequests: 1,
      legacyRequests: 0,
    });
    // Luna: (300*.1 + 200*.5 + 600*.01 + 100*.125)/1M = .0001485
    // Terra: (300*2 + 200*12 + 600*.2 + 100*2.5)/1M = .00337
    expect(routed?.estimatedCostUsd).toBeCloseTo(0.0035185, 12);
    expect(
      rows.find((row) => row.model === "gpt-6-luna")?.estimatedCostUsd,
    ).toBeCloseTo(0.0001001, 12);
    expect(rows.find((row) => row.model === "unknown-model")).toMatchObject({
      estimatedCostUsd: null,
      unpricedRequests: 1,
    });
  });

  it("validates the date range", async () => {
    for (const q of [
      "from=2026-03-02&to=2026-03-01",
      "from=2026-01-01&to=2026-04-03", // 93 days
      "from=2026-02-30&to=2026-03-01",
      "from=2026-3-1&to=2026-03-01",
      "to=2026-03-01",
    ]) {
      const res = await api("GET", `/admin/usage?${q}`);
      expect(res.statusCode, q).toBe(400);
    }
    const max = await api("GET", "/admin/usage?from=2026-01-01&to=2026-04-02");
    expect(max.statusCode).toBe(200);
    expect(max.json()).toEqual({ items: [] });
  });
});
