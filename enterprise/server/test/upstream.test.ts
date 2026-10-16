import { describe, expect, it } from "vitest";
import { visibleUpstreamAccounts } from "../src/routes/upstream.ts";
import { accountFromSub2Api } from "../src/sub2api.ts";
import type { UserRow } from "../src/db/schema.ts";

function user(role: UserRow["role"], ids: number[]): UserRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    username: "u",
    displayName: "u",
    passwordHash: "x",
    role,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    upstreamAccountIds: ids,
    groupName: "",
    offboardedAt: null,
    offboardedBy: null,
  };
}

describe("accountFromSub2Api", () => {
  it("merges extra percents with usage batch windows", () => {
    const acc = accountFromSub2Api(
      {
        id: 39,
        name: "Feiqin-Gpt",
        platform: "openai",
        type: "oauth",
        status: "active",
        schedulable: true,
        concurrency: 1,
        current_concurrency: 0,
        groups: [{ name: "openai-default" }],
        extra: {
          email: "a@example.com",
          codex_5h_used_percent: 0,
          codex_7d_used_percent: 3,
          codex_5h_reset_after_seconds: 14000,
          codex_7d_reset_after_seconds: 480000,
        },
      },
      {
        five_hour: {
          utilization: 0,
          remaining_seconds: 13800,
          resets_at: "2026-10-14T20:00:00+08:00",
          window_stats: {
            requests: 2,
            tokens: 9800,
            cost: 0.01,
            user_cost: 0.01,
          },
        },
        seven_day: {
          utilization: 3,
          remaining_seconds: 480000,
          resets_at: "2026-10-23T02:53:00+08:00",
          window_stats: {
            requests: 20,
            tokens: 311900,
            cost: 0.44,
            user_cost: 0.44,
          },
        },
      },
    );
    expect(acc).toMatchObject({
      id: 39,
      name: "Feiqin-Gpt",
      email: "a@example.com",
      groups: ["openai-default"],
      currentConcurrency: 0,
      maxConcurrency: 1,
    });
    expect(acc.windows[0]).toMatchObject({
      id: "5h",
      usedPercent: 0,
      requests: 2,
      tokens: 9800,
      accountCost: 0.01,
    });
    expect(acc.windows[1]).toMatchObject({
      id: "7d",
      usedPercent: 3,
      requests: 20,
      tokens: 311900,
    });
  });

  it("falls back to extra when usage batch is missing", () => {
    const acc = accountFromSub2Api(
      {
        id: 1,
        name: "x",
        extra: { codex_5h_used_percent: 12.5, codex_7d_used_percent: 40 },
      },
      undefined,
    );
    expect(acc.windows[0]!.usedPercent).toBe(12.5);
    expect(acc.windows[1]!.usedPercent).toBe(40);
    expect(acc.currentConcurrency).toBe(0);
    expect(acc.maxConcurrency).toBe(0);
  });
});

describe("visibleUpstreamAccounts", () => {
  const items = [
    accountFromSub2Api({ id: 1, name: "A" }, undefined),
    accountFromSub2Api({ id: 2, name: "B" }, undefined),
  ];

  it("admins see every account", () => {
    expect(visibleUpstreamAccounts(user("admin", []), items)).toHaveLength(2);
    expect(visibleUpstreamAccounts(user("admin", [1]), items)).toHaveLength(2);
  });

  it("members only see assigned ids", () => {
    expect(visibleUpstreamAccounts(user("member", [2]), items).map((a) => a.id)).toEqual([
      2,
    ]);
    expect(visibleUpstreamAccounts(user("member", []), items)).toEqual([]);
  });
});
