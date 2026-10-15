import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPage } from "@/components/connectors/ConnectorsPage";
import { renderWithQueryClient } from "../utils/testQueryClient";

const status = vi.fn();
const install = vi.fn();
const openLogin = vi.fn();
const canInstallMarket = vi.fn(() => false);

vi.mock("@/lib/api/dws", () => ({
  dwsApi: {
    status: () => status(),
    install: () => install(),
    openLogin: () => openLogin(),
  },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    hasPermission: (p: string) =>
      p === "market.install" && canInstallMarket(),
  }),
}));

vi.mock("@/components/skills/EnterpriseMarketPanel", () => ({
  EnterpriseMarketPanel: ({ kinds }: { kinds?: string[] }) => (
    <div data-testid="enterprise-market">{kinds?.join(",")}</div>
  ),
}));

describe("ConnectorsPage", () => {
  beforeEach(() => {
    status.mockReset();
    install.mockReset();
    openLogin.mockReset();
    canInstallMarket.mockReturnValue(false);
  });

  it("installs dws from the connector list", async () => {
    status.mockResolvedValue({
      installed: false,
      version: null,
      path: null,
      loggedIn: false,
    });
    install.mockResolvedValue({
      installed: true,
      version: "1.0.63",
      path: "C:\\Users\\a\\.local\\bin\\dws.exe",
      loggedIn: false,
    });
    renderWithQueryClient(<ConnectorsPage />);
    const btn = await screen.findByRole("button", {
      name: /connectors\.install|安装/,
    });
    fireEvent.click(btn);
    await waitFor(() => expect(install).toHaveBeenCalled());
    expect(
      await screen.findByText(/connectors\.installed|已安装/),
    ).toBeInTheDocument();
  });

  it("shows enterprise market tab when permitted", async () => {
    canInstallMarket.mockReturnValue(true);
    status.mockResolvedValue({
      installed: true,
      version: "1.0.0",
      path: "/tmp/dws",
      loggedIn: true,
    });
    renderWithQueryClient(<ConnectorsPage />);
    expect(
      await screen.findByRole("tab", {
        name: /enterpriseMarket\.title|企业市场/,
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("tab", {
        name: /enterpriseMarket\.title|企业市场/,
      }),
    );
    expect(await screen.findByTestId("enterprise-market")).toHaveTextContent(
      "connector",
    );
  });

  it("filters the connector list by search", async () => {
    status.mockResolvedValue({
      installed: false,
      version: null,
      path: null,
      loggedIn: false,
    });
    renderWithQueryClient(<ConnectorsPage />);
    const search = await screen.findByLabelText(
      /connectors\.searchAriaLabel|搜索连接器/,
    );
    fireEvent.change(search, { target: { value: "zzzz-no-match" } });
    expect(
      await screen.findByText(/connectors\.noMatch|没有匹配/),
    ).toBeInTheDocument();
  });
});
