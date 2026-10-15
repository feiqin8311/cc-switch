import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Loader2, LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dwsApi } from "@/lib/api/dws";
import { extractErrorMessage } from "@/utils/errorUtils";

const DWS_KEY = ["connectors", "dws"] as const;

export function ConnectorsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: DWS_KEY,
    queryFn: dwsApi.status,
  });
  const install = useMutation({
    mutationFn: dwsApi.install,
    onSuccess: (data) => {
      qc.setQueryData(DWS_KEY, data);
    },
  });
  const login = useMutation({
    mutationFn: dwsApi.openLogin,
    onSuccess: () => {
      window.setTimeout(() => void qc.invalidateQueries({ queryKey: DWS_KEY }), 4000);
    },
  });

  const dws = status.data;
  const busy = install.isPending;

  return (
    <div id="main-content" className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Cable className="h-5 w-5" strokeWidth={1.5} />}
        title={t("nav.connectors")}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 pb-10 pt-4">
        <p className="mb-4 max-w-2xl text-body text-fg-2">
          {t("connectors.intro")}
        </p>
        <div className="max-w-2xl rounded-panel border border-border bg-surface p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-body font-medium text-fg-1">
                  {t("connectors.dws.name")}
                </h2>
                {dws?.installed ? (
                  <Badge variant="secondary">{t("connectors.installed")}</Badge>
                ) : (
                  <Badge variant="outline">{t("connectors.notInstalled")}</Badge>
                )}
                {dws?.loggedIn && (
                  <Badge variant="secondary">{t("connectors.loggedIn")}</Badge>
                )}
              </div>
              <p className="mt-1 text-caption text-fg-3">
                {t("connectors.dws.blurb")}
              </p>
              {dws?.version && (
                <p className="mt-1 font-mono text-caption text-fg-3">
                  {dws.version}
                  {dws.path ? ` · ${dws.path}` : ""}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              {!dws?.installed ? (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => install.mutate()}
                >
                  {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  {t("connectors.install")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant={dws.loggedIn ? "quiet" : "default"}
                  disabled={login.isPending}
                  onClick={() => login.mutate()}
                >
                  <LogIn className="mr-1 h-4 w-4" />
                  {dws.loggedIn
                    ? t("connectors.relogin")
                    : t("connectors.login")}
                </Button>
              )}
            </div>
          </div>
          {install.isPending && (
            <p className="mt-3 text-caption text-fg-2">
              {t("connectors.installing")}
            </p>
          )}
          {install.isError && (
            <p className="mt-3 text-caption text-danger">
              {extractErrorMessage(install.error)}
            </p>
          )}
          {login.isError && (
            <p className="mt-3 text-caption text-danger">
              {extractErrorMessage(login.error)}
            </p>
          )}
          {dws?.installed && !dws.loggedIn && (
            <p className="mt-3 text-caption text-fg-2">
              {t("connectors.loginHint")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
