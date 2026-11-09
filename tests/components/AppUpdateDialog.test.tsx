import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: undefined as { firstRunNoticeConfirmed?: boolean } | undefined,
  checkUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: mocks.settings }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ state: { loggedIn: true, serverUrl: "" } }),
}));
vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: true,
    updateInfo: { availableVersion: "4.1.0" },
    readyVersion: "4.1.0",
    isDismissed: false,
    dismissUpdate: vi.fn(),
    checkUpdate: mocks.checkUpdate,
  }),
}));

import { AppUpdateDialog } from "@/components/AppUpdateDialog";

describe("AppUpdateDialog", () => {
  beforeEach(() => {
    mocks.settings = undefined;
  });

  it("waits for settings and first-run confirmation before showing an update", async () => {
    const { rerender } = render(<AppUpdateDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    mocks.settings = {};
    rerender(<AppUpdateDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    mocks.settings = { firstRunNoticeConfirmed: true };
    rerender(<AppUpdateDialog />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
