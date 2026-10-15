import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Loader2, LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MatrixSearch, NeutralBadge } from "@/components/mcp/AppMatrix";
import { EnterpriseMarketPanel } from "@/components/skills/EnterpriseMarketPanel";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import { PageTabs } from "@/components/ui/page-tabs";
import { useAuth } from "@/contexts/AuthContext";
import { dwsApi } from "@/lib/api/dws";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/utils/errorUtils";

const DWS_KEY = ["connectors", "dws"] as const;

type ConnectorView = "installed" | "enterprise";

export function ConnectorsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const showEnterprise = hasPermission("market.install");
  const [view, setView] = useState<ConnectorView>("installed");
  const [tabsTrailingSlot, setTabsTrailingSlot] =
    useState<HTMLDivElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (view === "enterprise" && !showEnterprise) setView("installed");
  }, [view, showEnterprise]);

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
      window.setTimeout(
        () => void qc.invalidateQueries({ queryKey: DWS_KEY }),
        4000,
      );
    },
  });

  const dws = status.data;
  const busy = install.isPending;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const dwsVisible = useMemo(() => {
    if (!normalizedQuery) return true;
    const hay = [
      t("connectors.dws.name"),
      t("connectors.dws.blurb"),
      "dws",
      "dingtalk",
    ]
      .join("\n")
      .toLowerCase();
    return hay.includes(normalizedQuery);
  }, [normalizedQuery, t]);
  const shownCount = dwsVisible ? 1 : 0;
  const totalCount = 1;

  const subtitle = dws?.installed
    ? [dws.version, dws.path].filter(Boolean).join(" · ") ||
      t("connectors.dws.blurb")
    : t("connectors.dws.blurb");

  return (
    <div id="main-content" className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Cable className="h-5 w-5" strokeWidth={1.5} />}
        title={t("nav.connectors")}
        titleExtra={
          <HelpTip title={t("nav.connectors")}>{t("connectors.intro")}</HelpTip>
        }
      />

      {showEnterprise && (
        <div className="shrink-0 px-6 pt-1">
          <PageTabs<ConnectorView>
            aria-label={t("connectors.viewAria")}
            idPrefix="connectors-view"
            className="h-11"
            value={view}
            onValueChange={setView}
            items={[
              {
                value: "installed",
                label: t("connectors.viewInstalledCount", {
                  count: totalCount,
                }),
              },
              { value: "enterprise", label: t("enterpriseMarket.title") },
            ]}
            trailing={
              <div ref={setTabsTrailingSlot} className="flex items-center" />
            }
          />
        </div>
      )}

      {view === "enterprise" && showEnterprise && (
        <EnterpriseMarketPanel
          kinds={["connector"]}
          renderTrailing={(trailing) =>
            tabsTrailingSlot ? createPortal(trailing, tabsTrailingSlot) : null
          }
        />
      )}

      <div
        className={cn(
          "min-h-0 flex-1 flex-col",
          view === "installed" ? "flex" : "hidden",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 px-6">
          <MatrixSearch
            className="w-[320px] min-w-[180px] shrink"
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder={t("connectors.searchPlaceholder")}
            ariaLabel={t("connectors.searchAriaLabel")}
            status={
              normalizedQuery
                ? t("appMatrix.found", { count: shownCount })
                : ""
            }
          />
          <span className="shrink-0 whitespace-nowrap text-caption tabular-nums text-fg-2">
            {normalizedQuery
              ? t("connectors.countFiltered", {
                  shown: shownCount,
                  count: totalCount,
                })
              : t("connectors.count", { count: totalCount })}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-6 pb-5">
          <div className="min-h-0 overflow-auto scroll-stable rounded-panel border border-border bg-surface">
            <div className="sticky top-0 z-10 flex h-11 items-center border-b border-border bg-subtle pe-2 ps-4">
              <span className="min-w-0 flex-1 text-caption font-semibold text-fg-2">
                {t("connectors.columnName")}
              </span>
              <span aria-hidden="true" className="w-28 shrink-0" />
            </div>

            {!dwsVisible ? (
              <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                <span className="text-body text-fg-2">
                  {t("connectors.noMatch", { query: searchQuery.trim() })}
                </span>
                <Button
                  type="button"
                  variant="neutral"
                  size="regular"
                  onClick={() => setSearchQuery("")}
                >
                  {t("connectors.clearSearch")}
                </Button>
              </div>
            ) : (
              <ul
                aria-label={t("connectors.listLabel")}
                className="m-0 list-none p-0"
              >
                <li className="flex h-14 items-center pe-2 ps-4 transition-colors duration-150 hover:bg-subtle">
                  <div className="flex min-w-0 flex-1 flex-col pe-3">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        title={t("connectors.dws.name")}
                        className="min-w-0 truncate text-body font-medium"
                      >
                        {t("connectors.dws.name")}
                      </span>
                      <NeutralBadge mono>dws</NeutralBadge>
                      {dws?.installed ? (
                        <NeutralBadge>{t("connectors.installed")}</NeutralBadge>
                      ) : (
                        <NeutralBadge>
                          {t("connectors.notInstalled")}
                        </NeutralBadge>
                      )}
                      {dws?.loggedIn && (
                        <NeutralBadge>{t("connectors.loggedIn")}</NeutralBadge>
                      )}
                    </div>
                    <div className="flex min-w-0 items-center text-caption text-fg-2">
                      <span
                        title={subtitle}
                        className="min-w-0 truncate font-mono"
                      >
                        {status.isLoading ? "…" : subtitle}
                      </span>
                      {install.isError && (
                        <span className="ms-2.5 shrink-0 text-danger">
                          {extractErrorMessage(install.error)}
                        </span>
                      )}
                      {login.isError && (
                        <span className="ms-2.5 shrink-0 text-danger">
                          {extractErrorMessage(login.error)}
                        </span>
                      )}
                      {install.isPending && (
                        <span className="ms-2.5 shrink-0">
                          {t("connectors.installing")}
                        </span>
                      )}
                      {dws?.installed && !dws.loggedIn && !login.isPending && (
                        <span className="ms-2.5 shrink-0">
                          {t("connectors.loginHint")}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex w-28 shrink-0 justify-end">
                    {status.isLoading ? (
                      <Loader2
                        className="h-4 w-4 animate-spin text-fg-3"
                        aria-hidden
                      />
                    ) : !dws?.installed ? (
                      <Button
                        type="button"
                        size="compact"
                        disabled={busy}
                        onClick={() => install.mutate()}
                      >
                        {busy && (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        )}
                        {t("connectors.install")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="compact"
                        variant={dws.loggedIn ? "quiet" : "default"}
                        disabled={login.isPending}
                        onClick={() => login.mutate()}
                      >
                        <LogIn className="mr-1 h-3.5 w-3.5" />
                        {dws.loggedIn
                          ? t("connectors.relogin")
                          : t("connectors.login")}
                      </Button>
                    )}
                  </div>
                </li>
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
