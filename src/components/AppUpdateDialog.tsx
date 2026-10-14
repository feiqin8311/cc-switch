import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { settingsApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useUpdate } from "@/contexts/UpdateContext";
import { isMac } from "@/lib/platform";
import { extractErrorMessage } from "@/utils/errorUtils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 启动、登录后以及每小时检查一次；发现新版本先在后台下载并校验签名，
 * 下好再弹出。点“立即重启”直接安装已下载的包并重启；“稍后”过几小时再提醒，
 * macOS 上退出应用时也会自动装上。
 */
export function AppUpdateDialog() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const {
    hasUpdate,
    updateInfo,
    readyVersion,
    isDismissed,
    dismissUpdate,
    checkUpdate,
  } = useUpdate();
  const [installing, setInstalling] = useState(false);

  // 启动时的检查可能发生在登录之前。登录成功后再查一次。
  useEffect(() => {
    if (!state.loggedIn) return;
    void checkUpdate().catch(() => {});
  }, [state.loggedIn, state.serverUrl, checkUpdate]);
  const open =
    hasUpdate &&
    !isDismissed &&
    updateInfo != null &&
    readyVersion === updateInfo.availableVersion;

  const install = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      const installed = await settingsApi.installUpdateAndRestart();
      if (!installed) {
        toast.success(t("settings.upToDate"), { closeButton: true });
        dismissUpdate();
      }
    } catch (error) {
      toast.error(t("settings.updateFailed"), {
        description: extractErrorMessage(error) || undefined,
        closeButton: true,
      });
      setInstalling(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !installing) dismissUpdate();
      }}
    >
      <DialogContent zIndex="alert">
        <DialogHeader>
          <DialogTitle>{t("settings.updateDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.updateDialogBody", {
              version: updateInfo?.availableVersion ?? "",
            })}
            {isMac() ? ` ${t("settings.updateDialogInstallOnQuit")}` : null}
          </DialogDescription>
        </DialogHeader>
        {updateInfo?.notes ? (
          <p className="line-clamp-4 px-6 text-body text-fg-2">
            {updateInfo.notes}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="neutral"
            size="regular"
            disabled={installing}
            onClick={dismissUpdate}
          >
            {t("settings.updateLater")}
          </Button>
          <Button
            type="button"
            variant="solid"
            size="regular"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("settings.updating")}
              </>
            ) : (
              t("settings.updateNow")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
