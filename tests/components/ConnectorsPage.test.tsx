import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPage } from "@/components/connectors/ConnectorsPage";
import { renderWithQueryClient } from "../utils/testQueryClient";

const status = vi.fn();
const install = vi.fn();
const openLogin = vi.fn();

vi.mock("@/lib/api/dws", () => ({
  dwsApi: {
    status: () => status(),
    install: () => install(),
    openLogin: () => openLogin(),
  },
}));

describe("ConnectorsPage", () => {
  beforeEach(() => {
    status.mockReset();
    install.mockReset();
    openLogin.mockReset();
  });

  it("installs dws from the connector card", async () => {
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
});
