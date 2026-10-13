import { describe, expect, it, vi } from "vitest";

// setupTests mocks the edition to multi-app; this suite covers the locked path.
vi.mock("@/config/edition", () => ({ CODEX_ONLY: true }));

const { resolveVisibleApps, SKILLS_APP_IDS, PROXY_APP_IDS } =
  await import("@/config/appConfig");
const { readStoredView } = await import("@/lib/navigation");
const { ACTIVE_TOOL_NAMES, ONE_CLICK_INSTALL_COMMANDS } = await import(
  "@/components/apps/useToolManagement"
);

describe("Codex-only edition", () => {
  it("shows only codex regardless of stored settings", () => {
    const visible = resolveVisibleApps({
      claude: true,
      gemini: true,
      codex: false,
    });
    expect(Object.entries(visible).filter(([, on]) => on)).toEqual([
      ["codex", true],
    ]);
  });

  it("locks skills and proxy app lists to codex only", () => {
    expect(SKILLS_APP_IDS).toEqual(["codex"]);
    expect(PROXY_APP_IDS).toEqual(["codex"]);
    expect(ACTIVE_TOOL_NAMES).toEqual(["codex"]);
    expect(ONE_CLICK_INSTALL_COMMANDS).toContain("codex");
    expect(ONE_CLICK_INSTALL_COMMANDS).not.toContain("claude");
  });

  it("redirects auth view to providers", () => {
    localStorage.setItem("ccswitch_last_view", "auth");
    expect(readStoredView()).toBe("providers");
  });
});
