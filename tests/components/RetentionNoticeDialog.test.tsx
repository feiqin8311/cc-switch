import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetentionNoticeDialog } from "@/components/auth/RetentionNoticeDialog";
import type { RetentionStatus } from "@/lib/api/enterpriseRetention";
import type { EnterpriseState } from "@/types/enterprise";
import { renderWithQueryClient } from "../utils/testQueryClient";

const invokeMock = vi.fn();
const logoutMock = vi.fn();
let authState: EnterpriseState;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ state: authState, logout: logoutMock }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const signedIn = (retentionEnabled: boolean): EnterpriseState =>
  ({
    serverUrl: "https://ent.example",
    loggedIn: true,
    offline: false,
    user: { id: "u1", username: "alice", displayName: "Alice" },
    permissions: [],
    config: {
      retention: { enabled: retentionEnabled, noticeText: "公司将留存对话" },
    },
    lastError: null,
  }) as unknown as EnterpriseState;

const status = (patch: Partial<RetentionStatus> = {}): RetentionStatus => ({
  enabled: true,
  noticeText: "公司将留存对话",
  acknowledged: false,
  acknowledgedAt: null,
  lastUploadAt: null,
  lastError: null,
  uploadedSessions: 0,
  ...patch,
});

describe("RetentionNoticeDialog", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    logoutMock.mockReset();
    authState = signedIn(true);
  });

  it("shows the notice when retention is enabled and not acknowledged; acknowledge calls the API", async () => {
    let acknowledged = false;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "enterprise_retention_status") {
        return status({ acknowledged });
      }
      if (command === "enterprise_retention_acknowledge") {
        acknowledged = true;
        return status({ acknowledged: true });
      }
      throw new Error(`unexpected command ${command}`);
    });

    renderWithQueryClient(<RetentionNoticeDialog />);

    expect(await screen.findByText("公司将留存对话")).toBeInTheDocument();
    expect(
      screen.getByText("enterpriseRetention.scopeNote"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("enterpriseRetention.acknowledge"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "enterprise_retention_acknowledge",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("公司将留存对话")).not.toBeInTheDocument(),
    );
    expect(logoutMock).not.toHaveBeenCalled();
  });

  it("logout button signs out of the enterprise account", async () => {
    invokeMock.mockResolvedValue(status());
    logoutMock.mockResolvedValue(undefined);

    renderWithQueryClient(<RetentionNoticeDialog />);

    fireEvent.click(await screen.findByText("enterpriseRetention.logout"));
    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith(
      "enterprise_retention_acknowledge",
    );
  });

  it("stays hidden when already acknowledged", async () => {
    invokeMock.mockResolvedValue(status({ acknowledged: true }));

    renderWithQueryClient(<RetentionNoticeDialog />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("enterprise_retention_status"),
    );
    expect(screen.queryByText("公司将留存对话")).not.toBeInTheDocument();
  });

  it("does not query or show anything when signed out", async () => {
    authState = { ...signedIn(true), loggedIn: false };

    renderWithQueryClient(<RetentionNoticeDialog />);

    await new Promise((r) => setTimeout(r, 20));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(
      screen.queryByText("enterpriseRetention.acknowledge"),
    ).not.toBeInTheDocument();
  });

  it("stays hidden when the policy is disabled", async () => {
    authState = signedIn(false);
    invokeMock.mockResolvedValue(status({ enabled: false }));

    renderWithQueryClient(<RetentionNoticeDialog />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(
      screen.queryByText("enterpriseRetention.acknowledge"),
    ).not.toBeInTheDocument();
  });
});
