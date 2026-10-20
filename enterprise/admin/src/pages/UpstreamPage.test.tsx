import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamPage } from "./UpstreamPage";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/auth", () => ({ useApi: () => ({ request }) }));
const codingPlan = {
  configured: true,
  providerId: "volcengine-coding",
  fetchedAt: "2026-10-20T00:00:00.000Z",
  sourceUpdatedAt: null,
  stale: false,
  error: null,
  warning: null,
  status: "Running",
  subscription: { planType: "Pro", expiresAt: "2026-11-19T15:59:59.000Z" },
  windows: [
    { id: "fiveHour", usedPercent: 2.05, resetsAt: null },
    { id: "weekly", usedPercent: 6.39, resetsAt: null },
    { id: "monthly", usedPercent: 33.97, resetsAt: null },
  ],
};
const account = {
  id: 1,
  name: "Existing-GPT",
  email: "example@example.com",
  platform: "openai",
  status: "active",
  groups: ["openai-default"],
  currentConcurrency: 0,
  maxConcurrency: 2,
  windows: [],
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function show(accounts: (typeof account)[] = []) {
  request.mockImplementation(async (path: string) =>
    path === "/admin/usage/coding-plan"
      ? codingPlan
      : { configured: accounts.length > 0, error: null, items: accounts },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <UpstreamPage />
    </QueryClientProvider>,
  );
}
describe("upstream account placement", () => {
  it("appends Coding Plan after existing account cards and refreshes both sources", async () => {
    show([account]);
    await screen.findByText("火山方舟 Coding Plan");
    const existing = screen.getByText("Existing-GPT");
    const coding = screen.getByText("火山方舟 Coding Plan");
    expect(
      existing.compareDocumentPosition(coding) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "刷新" })).toHaveLength(1);
    expect(screen.getByText("月")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(
          ([path]) => path === "/admin/upstream/accounts",
        ),
      ).toHaveLength(2),
    );
    expect(
      request.mock.calls.filter(
        ([path]) => path === "/admin/usage/coding-plan",
      ),
    ).toHaveLength(2);
  });
  it("shows Coding Plan even when Sub2API is not configured", async () => {
    show();
    expect(await screen.findByText("火山方舟 Coding Plan")).toBeTruthy();
    expect(screen.queryByText("暂无上游账号")).toBeNull();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
  });
});
