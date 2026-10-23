import type { CodingPlanUsageResponse } from "@ccse/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CodingPlanUsageCard } from "./CodingPlanUsageCard";

const data: CodingPlanUsageResponse = {
  configured: true,
  providerId: "volcengine-coding",
  fetchedAt: "2026-10-20T00:00:00.000Z",
  sourceUpdatedAt: null,
  status: "Running",
  stale: false,
  error: null,
  warning: null,
  subscription: {
    planType: "Pro",
    status: "Running",
    startsAt: "2026-09-29T06:53:00.000Z",
    expiresAt: "2026-11-29T15:59:59.000Z",
    autoRenew: false,
  },
  windows: [
    { id: "fiveHour", usedPercent: 2.05, resetsAt: null },
    { id: "weekly", usedPercent: 6.39, resetsAt: null },
  ],
};
afterEach(() => {
  cleanup();
});
function show(value = data) {
  return render(
    <CodingPlanUsageCard
      data={value}
      now={Date.parse("2026-10-20T00:00:00Z")}
    />,
  );
}
describe("CodingPlanUsageCard", () => {
  it("shows source percentages and metadata, missing windows remain unknown", async () => {
    show();
    expect(await screen.findByText("Coding Plan Pro")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Libraton-火山方舟Codin Plan 5h 用量" })
        .getAttribute("aria-valuetext"),
    ).toBe("已使用 2.05%");
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getByText("暂无用量数据")).toBeTruthy();
    expect(screen.getByText(/账号共享额度/)).toBeTruthy();
  });
  it("keeps last known quota visible with an explicit stale warning", async () => {
    show({
      ...data,
      stale: true,
      error: "连接暂时不可用",
    });
    expect(await screen.findByText("同步延迟")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "保留上次成功同步的数据",
    );
    expect(
      screen
        .getByRole("progressbar", { name: "Libraton-火山方舟Codin Plan 5h 用量" })
        .getAttribute("aria-valuenow"),
    ).toBe("2.05");
  });
});
