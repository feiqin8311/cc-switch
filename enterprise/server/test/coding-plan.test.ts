import { CodingPlanUsageResponseSchema } from "@ccse/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createCodingPlanReader,
  parseCodingPlanUsage,
} from "../src/volcengine.ts";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

const config = {
  accessKeyId: "AKLT-test-only",
  secretAccessKey: "secret-test-only",
  region: "cn-beijing",
  providerId: "volcengine-coding",
};
const usage = {
  Status: "Running",
  UpdateTimestamp: 1_792_464_000,
  QuotaUsage: [
    { Level: "session", Percent: 2.05, ResetTimestamp: -1 },
    { Level: "weekly", Percent: 6.39, ResetTimestamp: 1_792_900_000 },
    { Level: "monthly", Percent: 33.97, ResetTimestamp: 1_795_000_000 },
  ],
};
const plan = {
  PlanType: "Pro",
  Status: "Running",
  StartTime: "2026-09-29T14:53:00+08:00",
  EndTime: "2026-11-29T23:59:59+08:00",
  AutoRenew: false,
};
const json = (Result: unknown) => Response.json({ Result });
const fetcher = () =>
  vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      new URL(String(input)).searchParams.get("Action") === "GetPersonalPlan"
        ? json(plan)
        : json(usage),
    );

describe("Coding Plan OpenAPI", () => {
  it("keeps provider percentages and unknown reset times without estimating tokens", () => {
    const result = parseCodingPlanUsage(usage);
    expect(result.windows).toEqual([
      { id: "fiveHour", usedPercent: 2.05, resetsAt: null },
      { id: "weekly", usedPercent: 6.39, resetsAt: "2026-10-25T03:46:40.000Z" },
      {
        id: "monthly",
        usedPercent: 33.97,
        resetsAt: "2026-11-18T11:06:40.000Z",
      },
    ]);
    expect(() =>
      parseCodingPlanUsage({ QuotaUsage: [{ Level: "session" }] }),
    ).toThrow();
    expect(() => parseCodingPlanUsage({ QuotaUsage: [] })).toThrow();
  });

  it("signs only read operations and shares requests/cache between viewers", async () => {
    let now = Date.parse("2026-10-20T00:00:00Z");
    const fetch = fetcher();
    const read = createCodingPlanReader(config, fetch, () => now);
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(CodingPlanUsageResponseSchema.parse(a).subscription).toMatchObject({
      planType: "Pro",
      autoRenew: false,
      startsAt: "2026-09-29T06:53:00.000Z",
    });
    for (const [input, init] of fetch.mock.calls) {
      const url = new URL(String(input));
      expect(url.host).toBe("open.volcengineapi.com");
      expect(["GetCodingPlanUsage", "GetPersonalPlan"]).toContain(
        url.searchParams.get("Action"),
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toMatch(
        /^HMAC-SHA256 Credential=AKLT-test-only\//,
      );
      expect(init?.redirect).toBe("error");
      if (url.searchParams.get("Action") === "GetPersonalPlan")
        expect(JSON.parse(String(init?.body))).toEqual({ Plan: "CodingPlan" });
    }
    expect(JSON.stringify(a)).not.toContain(config.accessKeyId);
    expect(JSON.stringify(a)).not.toContain(config.secretAccessKey);
    await read();
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 30_001;
    await read();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("marks retained usage stale after network failure and recovers next refresh", async () => {
    let now = Date.now();
    const fetch = fetcher();
    const read = createCodingPlanReader(config, fetch, () => now);
    const first = await read();
    now += 30_001;
    fetch.mockRejectedValue(new Error("network failure"));
    const failed = await read();
    expect(failed.stale).toBe(true);
    expect(failed.error).toContain("网络不可用");
    expect(failed.windows).toEqual(first.windows);
    expect(failed.fetchedAt).toBe(first.fetchedAt);
    now += 10_001;
    fetch.mockImplementation(async () => json(usage));
    const recovered = await read();
    expect(recovered.stale).toBe(false);
    expect(recovered.error).toBeNull();
  });

  it("keeps usage when optional subscription details fail", async () => {
    const fetch = fetcher();
    fetch.mockImplementation(async (input) =>
      new URL(String(input)).searchParams.get("Action") === "GetPersonalPlan"
        ? Response.json(
            {
              ResponseMetadata: {
                Error: {
                  Code: "AccessDenied",
                  Message: config.secretAccessKey,
                },
              },
            },
            { status: 403 },
          )
        : json(usage),
    );
    const result = await createCodingPlanReader(config, fetch)();
    expect(result.windows).toHaveLength(3);
    expect(result.error).toBeNull();
    expect(result.subscription).toBeNull();
    expect(result.warning).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(config.secretAccessKey);
  });

  it("never exposes credentials echoed by upstream errors or treats failures as zero usage", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          ResponseMetadata: {
            Error: {
              Code: "SignatureDoesNotMatch",
              Message: config.secretAccessKey,
            },
          },
        },
        { status: 400 },
      ),
    );
    const result = await createCodingPlanReader(config, fetch)();
    expect(result.error).toContain("鉴权失败");
    expect(result.fetchedAt).toBeNull();
    expect(result.windows).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(config.secretAccessKey);
  });

  it("does not call external APIs before configuration", async () => {
    const fetch = fetcher();
    const result = await createCodingPlanReader(null, fetch)();
    expect(result.configured).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("protects account-wide quotas with login and audit.read", async () => {
  const ctx = await setup();
  try {
    const url = "/api/v1/admin/usage/coding-plan";
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(401);
    const admin = await login(ctx.app, ADMIN.username, ADMIN.password);
    const response = await ctx.app.inject({
      method: "GET",
      url,
      headers: bearer(admin.accessToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      CodingPlanUsageResponseSchema.parse(response.json()).configured,
    ).toBe(false);
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: bearer(admin.accessToken),
      payload: {
        username: "plan-member",
        displayName: "member",
        password: "password-123",
        role: "member",
      },
    });
    const member = await login(ctx.app, "plan-member", "password-123");
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url,
          headers: bearer(member.accessToken),
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await ctx.close();
  }
});
