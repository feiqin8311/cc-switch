import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settings, users } from "../src/db/schema.ts";
import {
  accountFromSub2Api,
  listUpstreamAccounts,
  readWeeklyUsageSamples,
} from "../src/sub2api.ts";
import {
  applyWeeklySample,
  departmentUsageView,
  meterKey,
  readDepartmentState,
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
  it("starts from zero even in November, then quarters only subsequent changes", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    const now = date("2026-11-09T08:00:00Z");
    applyWeeklySample(state, sample(1, 9), now);
    applyWeeklySample(state, sample(2, 24), now);
    state.assignments = { EZARC: [1, 2], 技术部: [1, 2] };
    expect(departmentUsageView(state, now).accounts.map((a) => a.used)).toEqual(
      [0, 0],
    );
    applyWeeklySample(state, sample(1, 59), date("2026-11-09T08:01:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(12.5);
    applyWeeklySample(state, sample(1, 59), date("2026-11-09T08:02:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(12.5);
  });

  it("never adds a whole window when only its reset timestamp changes", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    applyWeeklySample(state, sample(1, 27), date("2026-11-09T08:00:00Z"));
    applyWeeklySample(state, sample(2, 33), date("2026-11-09T08:00:00Z"));
    for (const [index, reset] of [
      "2026-11-16T02:02:00Z",
      "2026-11-16T02:00:00Z",
      "2026-11-23T02:00:00Z",
      null,
    ].entries()) {
      const at = date(`2026-11-09T08:0${index + 1}:00Z`);
      applyWeeklySample(state, sample(1, 27, reset), at);
      applyWeeklySample(state, sample(2, 33, reset), at);
      expect(
        departmentUsageView(state, at).accounts.map((a) => a.used),
      ).toEqual([0, 0]);
    }
    applyWeeklySample(
      state,
      sample(1, 28, "2026-11-23T02:02:00Z"),
      date("2026-11-09T08:05:00Z"),
    );
    expect(state.meters["1"]?.months["2026-11"]).toBe(0.25);
  });

  it.each(["2026-11-16T02:00:00Z", "2026-11-23T02:00:00Z", null])(
    "counts a lower reading as new window usage regardless of reset time %s",
    (reset) => {
      const state: State = { assignments: {}, meters: {}, error: null };
      applyWeeklySample(state, sample(1, 50), date("2026-11-09T08:00:00Z"));
      applyWeeklySample(state, sample(1, 60), date("2026-11-09T08:01:00Z"));
      expect(state.meters["1"]?.months["2026-11"]).toBe(2.5);
      applyWeeklySample(
        state,
        sample(1, 20, reset),
        date("2026-11-09T08:02:00Z"),
      );
      expect(state.meters["1"]?.months["2026-11"]).toBe(7.5);
      expect(state.meters["1"]?.lastPercent).toBe(20);
      applyWeeklySample(
        state,
        sample(1, 20, reset),
        date("2026-11-09T08:03:00Z"),
      );
      expect(state.meters["1"]?.months["2026-11"]).toBe(7.5);
      applyWeeklySample(
        state,
        sample(1, 30, reset),
        date("2026-11-09T08:04:00Z"),
      );
      expect(state.meters["1"]?.months["2026-11"]).toBe(10);
    },
  );

  it("converts four fully observed 100 percent weekly windows to 100 percent", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    for (const [day, percent] of [
      [2, 0],
      [8, 100],
      [9, 0],
      [15, 100],
      [16, 0],
      [22, 100],
      [23, 0],
      [29, 100],
    ] as const) {
      applyWeeklySample(
        state,
        sample(1, percent, null),
        date(`2026-11-${String(day).padStart(2, "0")}T08:00:00Z`),
      );
    }
    expect(state.meters["1"]?.months["2026-11"]).toBe(100);
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
    expect(state.meters["1"]?.months["2026-11"]).toBe(0);
    expect(state.meters["1"]?.incompleteMonths).toContain("2026-12");
  });

  it("baselines a newly added account after December begins and ignores old observations", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    applyWeeklySample(state, sample(1, 30), date("2026-12-10T00:00:00Z"));
    applyWeeklySample(state, sample(1, 50), date("2026-12-09T00:00:00Z"));
    expect(state.meters["1"]?.months["2026-12"]).toBe(0);
    expect(state.meters["1"]?.lastPercent).toBe(30);
  });

  it("baselines a lower reading at the month boundary without adding it", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    applyWeeklySample(state, sample(1, 60), date("2026-11-30T15:59:00Z"));
    applyWeeklySample(state, sample(1, 20), date("2026-11-30T16:00:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(0);
    expect(state.meters["1"]?.months["2026-12"]).toBe(0);
    applyWeeklySample(state, sample(1, 30), date("2026-11-30T16:01:00Z"));
    expect(state.meters["1"]?.months["2026-12"]).toBe(2.5);
  });

  it("counts increases and a zero baseline without requiring reset timestamps", () => {
    const state: State = { assignments: {}, meters: {}, error: null };
    applyWeeklySample(state, sample(1, 9, null), date("2026-11-09T08:00:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(0);
    expect(state.meters["1"]?.incompleteMonths).toEqual([]);
    applyWeeklySample(state, sample(1, 59, null), date("2026-11-09T08:01:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(12.5);
    applyWeeklySample(state, sample(1, 0, null), date("2026-11-09T08:02:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(12.5);
    applyWeeklySample(state, sample(1, 50, null), date("2026-11-09T08:03:00Z"));
    expect(state.meters["1"]?.months["2026-11"]).toBe(25);
  });

  it("backs up old counters and restarts every account only once, even after missing samples or a restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(date("2026-11-10T08:00:00Z"));
    const ctx = await setup(env);
    const key = meterKey(`${env.SUB2API_URL}\n${env.SUB2API_EMAIL}`);
    const legacy: State = {
      assignments: { EZARC: [1, 2], 技术部: [1, 2] },
      error: "old error",
      meters: {
        "1": {
          lastPercent: 60,
          resetsAt: "2026-11-16T02:00:00Z",
          sampledAt: "2026-11-10T07:59:00Z",
          months: { "2026-10": 7, "2026-11": 63.5 },
          incompleteMonths: ["2026-10", "2026-11"],
        },
        "2": {
          lastPercent: 33,
          resetsAt: "2026-11-16T02:00:00Z",
          sampledAt: "2026-11-10T07:59:00Z",
          months: { "2026-11": 40 },
          incompleteMonths: ["2026-11"],
        },
      },
    };
    try {
      await ctx.db
        .update(settings)
        .set({ value: legacy })
        .where(eq(settings.key, key));
      const { buildApp } = await import("../src/app.ts");
      const restarted = await buildApp(ctx.db, ctx.config);
      try {
        const session = await login(restarted, ADMIN.username, ADMIN.password);
        const headers = bearer(session.accessToken);
        const url = "/api/v1/admin/usage/departments";
        const initial = (await restarted.inject({ url, headers })).json();
        expect(initial.assignments).toEqual(legacy.assignments);
        expect(initial.accounts).toEqual([
          { id: 1, used: 0, sampledAt: null, incomplete: true },
          { id: 2, used: 0, sampledAt: null, incomplete: true },
        ]);
        const [backup] = await ctx.db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, `${key}:backup:increments-only-2026-11-10`));
        expect(backup?.value).toEqual({
          savedAt: "2026-11-10T08:00:00.000Z",
          state: legacy,
        });

        vi.mocked(readWeeklyUsageSamples).mockRejectedValueOnce(
          new Error("offline"),
        );
        await restarted.inject({
          method: "POST",
          url: `${url}/refresh`,
          headers,
        });
        expect(
          (await readDepartmentState(ctx.db, key)).meters["1"]?.needsBaseline,
        ).toBe(true);

        vi.setSystemTime(date("2026-11-10T08:01:00Z"));
        vi.mocked(readWeeklyUsageSamples).mockResolvedValue([sample(1, 5)]);
        await restarted.inject({
          method: "POST",
          url: `${url}/refresh`,
          headers,
        });
        let state = await readDepartmentState(ctx.db, key);
        expect(state.meters["1"]?.months["2026-11"]).toBe(0);
        expect(state.meters["1"]?.lastPercent).toBe(5);
        expect(state.meters["2"]?.needsBaseline).toBe(true);

        vi.setSystemTime(date("2026-11-10T08:02:00Z"));
        vi.mocked(readWeeklyUsageSamples).mockResolvedValue([
          sample(1, 9),
          sample(2, 70),
        ]);
        const result = (
          await restarted.inject({
            method: "POST",
            url: `${url}/refresh`,
            headers,
          })
        ).json();
        expect(
          result.accounts.map((account: { used: number }) => account.used),
        ).toEqual([1, 0]);
        state = await readDepartmentState(ctx.db, key);
        expect(state.meters["1"]?.months["2026-10"]).toBe(7);

        const again = await buildApp(ctx.db, ctx.config);
        try {
          expect((await again.inject({ url, headers })).json()).toEqual(result);
          const [sameBackup] = await ctx.db
            .select({ value: settings.value })
            .from(settings)
            .where(
              eq(settings.key, `${key}:backup:increments-only-2026-11-10`),
            );
          expect(sameBackup).toEqual(backup);
        } finally {
          await again.close();
        }
      } finally {
        await restarted.close();
      }
    } finally {
      await ctx.close();
    }
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
          payload: { department, accountIds: [1, 1, 2] },
        });
        expect(response.statusCode).toBe(200);
      }
      let result = (await ctx.app.inject({ url, headers })).json();
      expect(result.assignments).toEqual({ EZARC: [1, 2], 技术部: [1, 2] });
      expect(result.accounts.map((a: { used: number }) => a.used)).toEqual([
        0, 0,
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
        12.5, 0,
      ]);
      vi.setSystemTime(date("2026-11-09T08:02:00Z"));
      vi.mocked(readWeeklyUsageSamples).mockResolvedValue([
        sample(1, 59, "2026-11-16T02:02:00Z"),
        sample(2, 24, "2026-11-16T02:02:00Z"),
      ]);
      vi.mocked(readWeeklyUsageSamples).mockClear();
      result = (
        await ctx.app.inject({ method: "POST", url: `${url}/refresh`, headers })
      ).json();
      expect(readWeeklyUsageSamples).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        [1, 2],
      );
      expect(result.accounts.map((a: { used: number }) => a.used)).toEqual([
        12.5, 0,
      ]);
      vi.mocked(readWeeklyUsageSamples).mockRejectedValue(new Error("offline"));
      result = (
        await ctx.app.inject({ method: "POST", url: `${url}/refresh`, headers })
      ).json();
      expect(result.accounts.map((a: { used: number }) => a.used)).toEqual([
        12.5, 0,
      ]);
      expect(result.error).toContain("采集失败");
      expect((await ctx.app.inject({ url })).statusCode).toBe(401);
      const { buildApp } = await import("../src/app.ts");
      const restarted = await buildApp(ctx.db, ctx.config);
      try {
        result = (await restarted.inject({ url, headers })).json();
        expect(result.assignments.EZARC).toEqual([1, 2]);
        expect(result.accounts.map((a: { used: number }) => a.used)).toEqual([
          12.5, 0,
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      await ctx.close();
    }
  });
});
