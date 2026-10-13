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
  kind: "skill" | "plugin",
  extra: Partial<{ mandatory: boolean; version: string }> = {},
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
});

const entries = [
  {
    item: item("fresh-skill", "skill"),
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
});
