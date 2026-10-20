import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpstreamAccountsPage } from "@/components/upstream/UpstreamAccountsPage";
import { renderWithQueryClient } from "../utils/testQueryClient";

const upstreamAccounts = vi.fn();

vi.mock("@/lib/api/enterprise", () => ({
  enterpriseApi: {
    upstreamAccounts: () => upstreamAccounts(),
  },
}));

describe("UpstreamAccountsPage", () => {
  it("shows Coding Plan without Sub2API and preserves all quota windows", async () => {
    upstreamAccounts.mockResolvedValue({
      configured: true,
      error: null,
      items: [],
      codingPlan: {
        configured: true,
        providerId: "volcengine-coding",
        status: "Running",
        fetchedAt: "2026-10-20T00:00:00Z",
        sourceUpdatedAt: null,
        stale: false,
        error: null,
        warning: null,
        subscription: {
          planType: "Pro",
          status: "Running",
          startsAt: null,
          expiresAt: "2026-11-29T15:59:59Z",
          autoRenew: false,
        },
        windows: [
          { id: "fiveHour", usedPercent: 2.05, resetsAt: null },
          { id: "weekly", usedPercent: 6.39, resetsAt: null },
          { id: "monthly", usedPercent: 33.97, resetsAt: null },
        ],
      },
    });
    renderWithQueryClient(<UpstreamAccountsPage />);
    expect(await screen.findByText("火山方舟 Coding Plan")).toBeInTheDocument();
    expect(screen.getByText("2.05%")).toBeInTheDocument();
    expect(screen.getByText("6.39%")).toBeInTheDocument();
    expect(screen.getByText("33.97%")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    expect(
      screen.queryByTitle(/upstream\.capacityLabel|容量/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/账号共享额度/)).toBeInTheDocument();
  });

  it("shows missing quota data as unknown when the provider query fails", async () => {
    upstreamAccounts.mockResolvedValue({
      configured: true,
      error: null,
      items: [],
      codingPlan: {
        configured: true,
        providerId: "volcengine-coding",
        status: null,
        fetchedAt: null,
        sourceUpdatedAt: null,
        stale: false,
        error: "火山方舟查询失败",
        warning: null,
        subscription: null,
        windows: [],
      },
    });
    renderWithQueryClient(<UpstreamAccountsPage />);
    expect(await screen.findByText("火山方舟 Coding Plan")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("火山方舟查询失败");
    for (const bar of screen.getAllByRole("progressbar")) {
      expect(bar).not.toHaveAttribute("aria-valuenow");
      expect(bar).toHaveAttribute("aria-valuetext", "暂无数据");
    }
    expect(screen.queryByText(/0\.00%/)).not.toBeInTheDocument();
  });

  it("shows capacity and hides query/token/cost stats", async () => {
    upstreamAccounts.mockResolvedValue({
      configured: true,
      error: null,
      items: [
        {
          id: 1,
          name: "Yida-GPT",
          email: "zfu31415926@gmail.com",
          platform: "openai",
          type: "oauth",
          status: "active",
          schedulable: true,
          groups: ["openai-default"],
          currentConcurrency: 0,
          maxConcurrency: 1,
          windows: [
            {
              id: "5h",
              usedPercent: 0,
              remainingSeconds: 1200,
              resetsAt: "2026-10-15T13:00:00+08:00",
              requests: 2,
              tokens: 9900,
              accountCost: 0.01,
              userCost: 0.01,
            },
            {
              id: "7d",
              usedPercent: 2,
              remainingSeconds: 400000,
              resetsAt: "2026-10-20T13:43:00+08:00",
              requests: 150,
              tokens: 11_500_000,
              accountCost: 2.03,
              userCost: 2.03,
            },
          ],
        },
      ],
    });
    renderWithQueryClient(<UpstreamAccountsPage />);
    expect(await screen.findByText("Yida-GPT")).toBeInTheDocument();
    expect(screen.getByTitle(/upstream\.capacityLabel|容量/)).toHaveTextContent(
      /0\s*\/\s*1/,
    );
    expect(screen.queryByText(/次查询|queries/)).not.toBeInTheDocument();
    expect(screen.queryByText(/31\.2K|9\.9K|11\.5M/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A \$/)).not.toBeInTheDocument();
  });
});
