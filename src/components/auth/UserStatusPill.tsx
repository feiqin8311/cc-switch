import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Building2, CloudOff, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/AuthContext";
import { useRetentionStatusQuery } from "@/lib/api/enterpriseRetention";
import { toast } from "@/lib/toast";
import { LoginModal } from "./LoginModal";

/** Header entry for the enterprise account: sign-in button or account menu. */
export function UserStatusPill() {
  const { t } = useTranslation();
  const { state, isLoading, logout, refresh } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  const { data: retention } = useRetentionStatusQuery();

  if (isLoading) return null;

  if (!state.loggedIn || !state.user) {
    return (
      <>
        <Button
          variant="outline"
          size="regular"
          onClick={() => setLoginOpen(true)}
        >
          <Building2 className="h-4 w-4" />
          {t("enterprise.login")}
        </Button>
        <LoginModal open={loginOpen} onOpenChange={setLoginOpen} />
      </>
    );
  }

  const { user } = state;
  const handleLogout = async () => {
    try {
      await logout();
    } catch (err) {
      toast.error(String(err));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="regular">
          {state.offline ? (
            <CloudOff className="h-4 w-4 text-fg-3" />
          ) : (
            <Building2 className="h-4 w-4" />
          )}
          <span className="max-w-32 truncate">{user.displayName}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="space-y-0.5">
          <div className="truncate">{user.displayName}</div>
          <div className="truncate text-caption font-normal text-fg-3">
            {user.username} · {t(`enterprise.role.${user.role}`)}
          </div>
          <div className="truncate text-caption font-normal text-fg-3">
            {state.offline ? t("enterprise.offline") : state.serverUrl}
          </div>
          <div className="truncate text-caption font-normal text-fg-3">
            {t("enterpriseRetention.statusLabel", {
              status: t(
                retention?.enabled
                  ? "enterpriseRetention.statusOn"
                  : "enterpriseRetention.statusOff",
              ),
            })}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void refresh()}>
          <RefreshCw className="h-4 w-4" />
          {t("enterprise.refresh")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleLogout()}>
          <LogOut className="h-4 w-4" />
          {t("enterprise.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
