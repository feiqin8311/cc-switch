import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: {} as { firstRunNoticeConfirmed?: boolean },
  updateReady: false,
  save: vi.fn(),
  checkUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/query", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useSettingsQuery: () =>
      useQuery({ queryKey: ["settings"], queryFn: async () => mocks.settings }),
  };
});
vi.mock("@/lib/api", () => ({ settingsApi: { save: mocks.save } }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "4.0.0" }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ state: { loggedIn: true, serverUrl: "" } }),
}));
vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: true,
    updateInfo: { availableVersion: "4.1.0" },
    readyVersion: mocks.updateReady ? "4.1.0" : undefined,
    isDismissed: false,
    dismissUpdate: vi.fn(),
    checkUpdate: mocks.checkUpdate,
  }),
}));

import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";
import { AppUpdateDialog } from "@/components/AppUpdateDialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

describe("first-run welcome and downloaded update", () => {
  it("keeps welcome clickable when an update becomes ready, then shows the update", async () => {
    mocks.settings = {};
    mocks.updateReady = false;
    mocks.save.mockImplementation(async (settings) => {
      mocks.settings = settings;
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const dialogs = () => (
      <QueryClientProvider client={client}>
        <FirstRunNoticeDialog />
        <AppUpdateDialog />
      </QueryClientProvider>
    );
    const { rerender } = render(dialogs());
    expect(await screen.findByText("firstRunNotice.title")).toBeInTheDocument();

    mocks.updateReady = true;
    rerender(dialogs());
    expect(
      screen.queryByText("settings.updateDialogTitle"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "firstRunNotice.confirm" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("settings.updateDialogTitle"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("firstRunNotice.title")).not.toBeInTheDocument();
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ firstRunNoticeConfirmed: true }),
    );
  });

  it("waits until another modal is unmounted even when settings already allow updates", async () => {
    mocks.settings = { firstRunNoticeConfirmed: true };
    mocks.updateReady = true;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const dialogs = (showOther: boolean) => (
      <QueryClientProvider client={client}>
        {showOther && (
          <Dialog open>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Other startup notice</DialogTitle>
              <button>Notice action</button>
            </DialogContent>
          </Dialog>
        )}
        <AppUpdateDialog />
      </QueryClientProvider>
    );
    const { rerender } = render(dialogs(true));
    expect(await screen.findByText("Other startup notice")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 2100)));
    expect(
      screen.queryByText("settings.updateDialogTitle"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notice action" })).toBeEnabled();

    rerender(dialogs(false));
    expect(
      await screen.findByText("settings.updateDialogTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "settings.updateLater" }),
    ).toBeEnabled();
  });
});
