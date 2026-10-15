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
