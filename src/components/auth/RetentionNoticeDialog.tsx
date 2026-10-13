import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import {
  enterpriseRetentionApi,
  useRetentionStatusQuery,
} from "@/lib/api/enterpriseRetention";
import { toast } from "@/lib/toast";

/**
 * Blocking notice shown when the enterprise server enables conversation
 * retention and this account has not acknowledged it on this device. The only
 * ways out are acknowledging or signing out of the enterprise account.
 */
export function RetentionNoticeDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { state, logout } = useAuth();
  const { data: status } = useRetentionStatusQuery();
  const [busy, setBusy] = useState(false);

  const isOpen =
    state.loggedIn &&
    state.config?.retention.enabled === true &&
    status?.enabled === true &&
    !status.acknowledged;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: ["enterpriseRetention"],
      });
    } catch (err) {
      toast.error(
        t("enterpriseRetention.actionFailed", { error: String(err) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const noticeText =
    status?.noticeText.trim() || t("enterpriseRetention.noticeFallback");

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-lg"
        zIndex="top"
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-fg-1" />
            {t("enterpriseRetention.title")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 overflow-y-auto px-6 py-5">
          <DialogDescription className="whitespace-pre-line leading-relaxed">
            {noticeText}
          </DialogDescription>
          <p className="text-caption leading-relaxed text-fg-3">
            {t("enterpriseRetention.scopeNote")}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(logout)}
          >
            {t("enterpriseRetention.logout")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void run(enterpriseRetentionApi.acknowledge)}
          >
            {t("enterpriseRetention.acknowledge")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
