import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnterpriseMarketPanel } from "@/components/skills/EnterpriseMarketPanel";
import { renderWithQueryClient } from "../utils/testQueryClient";

const invokeMock = vi.fn();
const hasPermissionMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const item = (
  id: string,
  kind: "skill" | "plugin" | "mcp",
  extra: Partial<{
    mandatory: boolean;
    version: string;
    publishedBy: string | null;
    publishedByName: string | null;
  }> = {},
) => ({
  id,
  kind,
  name: `Name ${id}`,
  description: `Desc ${id}`,
  version: extra.version ?? "1.0.0",
  mandatory: extra.mandatory ?? false,
  sha256: "abc",
  sizeBytes: 10,
  updatedAt: "2026-10-13T00:00:00Z",
  publishedBy: extra.publishedBy ?? null,
  publishedByName: extra.publishedByName ?? null,
});

const entries = [
  {
    item: item("fresh-skill", "skill", { publishedByName: "Yida" }),
    installedVersion: null,
    updateAvailable: false,
  },
  {
    item: item("old-skill", "skill", { version: "2.0.0" }),
    installedVersion: "1.0.0",
    updateAvailable: true,
  },
  {
    item: item("must-plugin", "plugin", { mandatory: true }),
    installedVersion: "1.0.0",
    updateAvailable: false,
  },
  {
    item: item("github-mcp", "mcp"),
    installedVersion: null,
    updateAvailable: false,
  },
];

describe("EnterpriseMarketPanel", () => {
  beforeEach(() => {
    hasPermissionMock.mockImplementation((p: string) => p === "market.install");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "enterprise_market_list") return entries;
      if (cmd === "enterprise_market_install") return entries[0];
      if (cmd === "enterprise_market_uninstall") return null;
      throw new Error(`unexpected ${cmd}`);
    });
  });

  it("renders nothing without market.install", () => {
    hasPermissionMock.mockReturnValue(false);
    const { container } = renderWithQueryClient(<EnterpriseMarketPanel />);
    expect(container).toBeEmptyDOMElement();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("lists skills and plugins with their status", async () => {
    renderWithQueryClient(<EnterpriseMarketPanel />);

    const fresh = await screen.findByTestId(
      "enterprise-market-item-fresh-skill",
    );
    expect(within(fresh).getByText("Name fresh-skill")).toBeInTheDocument();
    expect(within(fresh).getByText("Yida")).toBeInTheDocument();
    expect(
      within(fresh).getByText("enterpriseMarket.status.notInstalled"),
    ).toBeInTheDocument();
    expect(
      within(fresh).getByText("enterpriseMarket.install"),
    ).toBeInTheDocument();

    const old = screen.getByTestId("enterprise-market-item-old-skill");
    expect(
      within(old).getByText("enterpriseMarket.status.updateAvailable"),
    ).toBeInTheDocument();
    expect(
      within(old).getByText("enterpriseMarket.update"),
    ).toBeInTheDocument();
    expect(
      within(old).getByText("enterpriseMarket.uninstall"),
    ).toBeInTheDocument();

    const must = screen.getByTestId("enterprise-market-item-must-plugin");
    expect(
      within(must).getByText("enterpriseMarket.status.installed"),
    ).toBeInTheDocument();
    expect(
      within(must).getByText("enterpriseMarket.mandatory"),
    ).toBeInTheDocument();
    // Mandatory: no uninstall; up to date: no install / update.
    expect(within(must).queryByRole("button")).toBeNull();

    expect(screen.getByText("enterpriseMarket.skills")).toBeInTheDocument();
    expect(screen.getByText("enterpriseMarket.plugins")).toBeInTheDocument();
  });

  it("keeps MCP items out of the Skills page", async () => {
    renderWithQueryClient(<EnterpriseMarketPanel />);
    await screen.findByTestId("enterprise-market-item-fresh-skill");
    expect(
      screen.queryByTestId("enterprise-market-item-github-mcp"),
    ).toBeNull();
  });

  it("lists only MCP items on the MCP page, without section titles", async () => {
    renderWithQueryClient(<EnterpriseMarketPanel kinds={["mcp"]} />);
    await screen.findByTestId("enterprise-market-item-github-mcp");
    expect(
      screen.queryByTestId("enterprise-market-item-fresh-skill"),
    ).toBeNull();
    expect(screen.queryByText("enterpriseMarket.mcp")).toBeNull();
  });

  it("installs an item and refreshes the list", async () => {
    renderWithQueryClient(<EnterpriseMarketPanel />);
    const fresh = await screen.findByTestId(
      "enterprise-market-item-fresh-skill",
    );

    fireEvent.click(within(fresh).getByText("enterpriseMarket.install"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("enterprise_market_install", {
        id: "fresh-skill",
      }),
    );
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(
          ([cmd]) => cmd === "enterprise_market_list",
        ),
      ).toHaveLength(2),
    );
  });

  it("installs selected uninstalled items in one click", async () => {
    renderWithQueryClient(<EnterpriseMarketPanel kinds={["mcp"]} />);
    const row = await screen.findByTestId("enterprise-market-item-github-mcp");
    fireEvent.click(within(row).getByRole("checkbox", { name: "Name github-mcp" }));
    fireEvent.click(screen.getByTestId("enterprise-market-install-selected"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("enterprise_market_install", {
        id: "github-mcp",
      }),
    );
  });

  it("uninstalls a non-mandatory item", async () => {
    renderWithQueryClient(<EnterpriseMarketPanel />);
    const old = await screen.findByTestId("enterprise-market-item-old-skill");

    fireEvent.click(within(old).getByText("enterpriseMarket.uninstall"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("enterprise_market_uninstall", {
        id: "old-skill",
      }),
    );
  });

  it("filters the list by search and keeps the publisher name", async () => {
    renderWithQueryClient(<EnterpriseMarketPanel />);
    const search = await screen.findByLabelText(
      "enterpriseMarket.searchAriaLabel",
    );
    fireEvent.change(search, { target: { value: "Yida" } });
    expect(
      screen.getByTestId("enterprise-market-item-fresh-skill"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("enterprise-market-item-old-skill"),
    ).toBeNull();

    fireEvent.change(search, { target: { value: "no-such-item" } });
    expect(
      screen.getByText("enterpriseMarket.noMatch"),
    ).toBeInTheDocument();
  });
});
