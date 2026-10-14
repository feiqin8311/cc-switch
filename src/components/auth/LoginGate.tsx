import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CODEX_ONLY } from "@/config/edition";
import { useAuth } from "@/contexts/AuthContext";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isWindows } from "@/lib/platform";
import { WindowControls } from "@/components/shell/WindowControls";
import { EnterpriseLoginForm, LoginFormCard } from "./LoginModal";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * Enterprise edition keeps the main window off the app until a session exists.
 * A restored session (including offline) counts as signed in.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { state, isLoading } = useAuth();
  if (!CODEX_ONLY || state.loggedIn) return children;
  return (
    <div className="flex h-screen flex-col bg-background text-fg-1">
      <header
        className="flex h-[52px] shrink-0 items-center justify-end gap-1 pe-4"
        {...DRAG_REGION_ATTR}
        style={DRAG_REGION_STYLE as React.CSSProperties}
      >
        {isWindows() && (
          <div className="flex items-center gap-1" style={NO_DRAG}>
            <WindowControls />
          </div>
        )}
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        {isLoading ? (
          <p className="text-sm text-fg-2">{t("common.loading")}</p>
        ) : (
          <LoginFormCard>
            <EnterpriseLoginForm active variant="page" />
          </LoginFormCard>
        )}
      </div>
    </div>
  );
}
