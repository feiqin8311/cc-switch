import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPage } from "@/components/connectors/ConnectorsPage";
import { toast } from "@/lib/toast";
import { renderWithQueryClient } from "../utils/testQueryClient";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("@/lib/api/dws", () => ({
  dwsApi: { status: mocks.status },
}));

vi.mock("@/lib/api/enterpriseMarket", () => ({
  enterpriseMarketApi: { list: mocks.list, uninstall: mocks.uninstall },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ hasPermission: (p: string) => p === "market.install" }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("connector uninstall across installed and market tabs", () => {
  let installed: boolean;

  beforeEach(() => {
    installed = true;
    mocks.status.mockReset().mockImplementation(async () => ({
      installed,
      version: installed ? "1.0.65" : null,
      path: installed ? "C:\\Users\\test\\.local\\bin\\dws.exe" : null,
      loggedIn: installed,
    }));
    mocks.list.mockReset().mockImplementation(async () => [
      {
        item: {
          id: "dingtalk",
          kind: "connector",
          name: "DingTalk CLI",
          description: "",
          version: "1.0.0",
          mandatory: false,
          sha256: "abc",
          sizeBytes: 14,
          updatedAt: "",
        },
        installedVersion: installed ? "1.0.0" : null,
        updateAvailable: false,
      },
    ]);
    mocks.uninstall.mockReset().mockImplementation(async () => {
      installed = false;
    });
  });

  async function openMarket() {
    renderWithQueryClient(<ConnectorsPage />);
    await screen.findByText("connectors.installed");
    fireEvent.click(
      screen.getByRole("tab", { name: "enterpriseMarket.title" }),
    );
    return screen.findByTestId("enterprise-market-item-dingtalk");
  }

  it("removes the connector from installed and marks the market item uninstalled", async () => {
    const row = await openMarket();
    fireEvent.click(
      within(row).getByRole("button", { name: "enterpriseMarket.uninstall" }),
    );

    await waitFor(() =>
      expect(mocks.uninstall).toHaveBeenCalledWith("dingtalk"),
    );
    expect(
      await within(row).findByText("enterpriseMarket.status.notInstalled"),
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "enterpriseMarket.uninstall" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("tab", { name: "connectors.viewInstalledCount" }),
    );
    expect(await screen.findByText("connectors.emptyInstalled")).toBeVisible();
    expect(screen.queryByText("connectors.installed")).toBeNull();
  });

  it("keeps the connector installed and shows an error if removing the executable fails", async () => {
    mocks.uninstall.mockRejectedValue(new Error("dws.exe is in use"));
    const row = await openMarket();
    fireEvent.click(
      within(row).getByRole("button", { name: "enterpriseMarket.uninstall" }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    expect(
      within(row).getByText("enterpriseMarket.status.installed"),
    ).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("tab", { name: "connectors.viewInstalledCount" }),
    );
    expect(await screen.findByText("connectors.installed")).toBeVisible();
    expect(screen.queryByText("connectors.emptyInstalled")).toBeNull();
  });
});
