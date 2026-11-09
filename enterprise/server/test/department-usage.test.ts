import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { users } from "../src/db/schema.ts";
import {
  accountFromSub2Api,
  listUpstreamAccounts,
  readWeeklyUsageSamples,
} from "../src/sub2api.ts";
import {
  applyWeeklySample,
  departmentUsageView,
  type readDepartmentState,
  shanghaiMonth,
} from "../src/usage/department-usage.ts";
import { ADMIN, bearer, login, setup } from "./helpers.ts";

vi.mock("../src/sub2api.ts", async (original) => ({
  ...(await original<typeof import("../src/sub2api.ts")>()),
  listUpstreamAccounts: vi.fn(),
  readWeeklyUsageSamples: vi.fn(),
}));

type State = Awaited<ReturnType<typeof readDepartmentState>>;
const sample = (
  id: number,
  usedPercent: number,
  resetsAt: string | null = "2026-11-16T02:00:00Z",
) => ({ id, usedPercent, resetsAt });
const date = (value: string) => new Date(value);
const env = {
  SUB2API_URL: "https://upstream.example",
  SUB2API_EMAIL: "test@example.com",
  SUB2API_PASSWORD: "password",
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("department usage estimation", () => {
  it("counts the current November windows once, then quarters their changes", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    const now = date("2026-11-09T08:00:00Z");
    applyWeeklySample(state, sample(1, 9), now);
    applyWeeklySample(state, sample(2, 24), now);
    state.assignments = { EZARC: [1, 2], 技术部: [1, 2] };
    expect(departmentUsageView(state, now).accounts.map((a) => a.used)).toEqual(
      [2.25, 6],
    );
    applyWeeklySample(state, sample(1, 59), date("2026-11-09T08:01:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(14.75);
    applyWeeklySample(state, sample(1, 59), date("2026-11-09T08:02:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(14.75);
  });

  it("clears at Shanghai December, baselines the old value, and counts after a 7d reset", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    applyWeeklySample(
      state,
      sample(1, 30, "2026-12-08T00:00:00Z"),
      date("2026-11-30T15:59:00Z"),
    );
    expect(shanghaiMonth(date("2026-11-30T16:00:00Z"))).toBe("2026-12");
    expect(
      departmentUsageView(state, date("2026-11-30T16:00:00Z")).accounts[0]
        ?.sampledAt,
    ).toBeNull();
    applyWeeklySample(
      state,
      sample(1, 30, "2026-12-08T00:00:00Z"),
      date("2026-11-30T16:00:00Z"),
    );
    expect(state.meters["1"]?.months["2026-12"]).toBe(0);
    applyWeeklySample(
      state,
      sample(1, 80, "2026-12-08T00:00:00Z"),
      date("2026-11-30T16:01:00Z"),
    );
    expect(state.meters["1"]?.months["2026-12"]).toBe(12.5);
    applyWeeklySample(
      state,
      sample(1, 0, "2026-12-15T00:00:00Z"),
      date("2026-12-08T00:00:01Z"),
    );
    applyWeeklySample(
      state,
      sample(1, 50, "2026-12-15T00:00:00Z"),
      date("2026-12-08T00:01:01Z"),
    );
    expect(state.meters["1"]?.months["2026-12"]).toBe(25);
    expect(state.meters["1"]?.months["2026-11"]).toBe(7.5);
    expect(state.meters["1"]?.incompleteMonths).toContain("2026-12");
  });

  it("baselines a newly added account after December begins and ignores old observations", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    applyWeeklySample(state, sample(1, 30), date("2026-12-10T00:00:00Z"));
    applyWeeklySample(state, sample(1, 50), date("2026-12-09T00:00:00Z"));
    expect(state.meters["1"]?.months["2026-12"]).toBe(0);
    expect(state.meters["1"]?.lastPercent).toBe(30);
  });

  it("marks a missing window reset time as uncertain", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    applyWeeklySample(state, sample(1, 9, null), date("2026-11-09T08:00:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(2.25);
    expect(state.meters["1"]?.incompleteMonths).toContain("2026-11");
  });

  it("stores shared assignments, updates accounts once, and survives a new app instance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(date("2026-11-09T08:00:00Z"));
    const ctx = await setup(env);
    try {
      await ctx.db
        .update(users)
        .set({ groupName: "EZARC" })
        .where(eq(users.username, ADMIN.username));
      await ctx.db.insert(users).values({
        username: "member",
        displayName: "Member",
        passwordHash: "x",
        role: "member",
        groupName: "技术部",
      });
      vi.mocked(listUpstreamAccounts).mockResolvedValue([
        accountFromSub2Api({ id: 1, name: "One" }, undefined),
        accountFromSub2Api({ id: 2, name: "Two" }, undefined),
      ]);
      vi.mocked(readWeeklyUsageSamples).mockResolvedValue([
        sample(1, 9),
        sample(2, 24),
      ]);
      const session = await login(ctx.app, ADMIN.username, ADMIN.password);
      const headers = bearer(session.accessToken);
      const url = "/api/v1/admin/usage/departments";
      for (const department of ["EZARC", "技术部"]) {
        const response = await ctx.app.inject({
          method: "PUT",
          url,
          headers,
          payload: { department, accountIds: [1, 2] },
        });
        expect(response.statusCode).toBe(200);
      }
      let result = (await ctx.app.inject({ url, headers })).json();
      expect(result.assignments).toEqual({ EZARC: [1, 2], 技术部: [1, 2] });
      expect(result.accounts.map((a: { used: number }) => a.used)).toEqual([
        2.25, 6,
      ]);
      vi.setSystemTime(date("2026-11-09T08:01:00Z"));
      vi.mocked(readWeeklyUsageSamples).mockResolvedValue([
        sample(1, 59),
        sample(2, 24),
      ]);
      result = (
        await ctx.app.inject({ method: "POST", url: `${url}/refresh`, headers })
      ).json();
      expect(result.accounts.map((a: { used: number }) => a.used)).toEqual([
        14.75, 6,
      ]);
      vi.mocked(readWeeklyUsageSamples).mockRejectedValue(new Error("offline"));
      result = (
        await ctx.app.inject({ method: "POST", url: `${url}/refresh`, headers })
      ).json();
      expect(result.accounts.map((a: { used: number }) => a.used)).toEqual([
        14.75, 6,
      ]);
      expect(result.error).toContain("采集失败");
      expect((await ctx.app.inject({ url })).statusCode).toBe(401);
      const { buildApp } = await import("../src/app.ts");
      const restarted = await buildApp(ctx.db, ctx.config);
      try {
        result = (await restarted.inject({ url, headers })).json();
        expect(result.assignments.EZARC).toEqual([1, 2]);
        expect(result.accounts.map((a: { used: number }) => a.used)).toEqual([
          14.75, 6,
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      await ctx.close();
    }
  });
});
