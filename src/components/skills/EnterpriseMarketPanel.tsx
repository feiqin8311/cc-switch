import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import {
  enterpriseMarketApi,
  type EnterpriseMarketEntry,
} from "@/lib/api/enterpriseMarket";
import { toast } from "@/lib/toast";
import { extractErrorMessage } from "@/utils/errorUtils";

export const enterpriseMarketQueryKey = ["enterpriseMarket", "list"] as const;

type Action = "install" | "uninstall";

/**
 * Enterprise marketplace on top of the Skills page: skills and Codex plugins
 * published by the enterprise server. Only shown with `market.install`.
 */
export function EnterpriseMarketPanel() {
  const { hasPermission } = useAuth();
  const canInstall = hasPermission("market.install");
  if (!canInstall) return null;
  return <EnterpriseMarketList />;
}

function EnterpriseMarketList() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ id: string; action: Action }>();

  const query = useQuery({
    queryKey: enterpriseMarketQueryKey,
    queryFn: enterpriseMarketApi.list,
  });

  const afterChange = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: enterpriseMarketQueryKey }),
      queryClient.invalidateQueries({ queryKey: ["skills", "installed"] }),
      queryClient.invalidateQueries({ queryKey: ["skills", "unmanaged"] }),
    ]);

  const mutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: Action }) => {
      setPending({ id, action });
      if (action === "install") await enterpriseMarketApi.install(id);
      else await enterpriseMarketApi.uninstall(id);
    },
    onSuccess: (_data, { action }) => {
      toast.success(
        t(
          action === "install"
            ? "enterpriseMarket.toast.installed"
            : "enterpriseMarket.toast.uninstalled",
        ),
      );
    },
    onError: (error, { action }) => {
      toast.error(
        t(
          action === "install"
            ? "enterpriseMarket.toast.installFailed"
            : "enterpriseMarket.toast.uninstallFailed",
          { error: extractErrorMessage(error) },
        ),
      );
    },
    onSettled: async () => {
      setPending(undefined);
      await afterChange();
    },
  });

  const entries = query.data ?? [];
  const skills = entries.filter((e) => e.item.kind === "skill");
  const plugins = entries.filter((e) => e.item.kind === "plugin");

  return (
    <section
      className="mx-6 mt-2 max-h-[40vh] shrink-0 overflow-y-auto rounded-lg border border-border bg-surface p-3"
      aria-label={t("enterpriseMarket.title")}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg-1">
          {t("enterpriseMarket.title")}
        </h2>
        {query.isFetching && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-3" />
        )}
      </div>
      {query.isError ? (
        <p className="text-xs text-danger">
          {t("enterpriseMarket.loadFailed", {
            error: extractErrorMessage(query.error),
          })}
        </p>
      ) : query.isLoading ? (
        <p className="text-xs text-fg-3">{t("enterpriseMarket.loading")}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-fg-3">{t("enterpriseMarket.empty")}</p>
      ) : (
        <div className="space-y-3">
          <MarketSection
            title={t("enterpriseMarket.skills")}
            entries={skills}
            pending={pending}
            busy={mutation.isPending}
            onAction={(id, action) => mutation.mutate({ id, action })}
          />
          <MarketSection
            title={t("enterpriseMarket.plugins")}
            entries={plugins}
            pending={pending}
            busy={mutation.isPending}
            onAction={(id, action) => mutation.mutate({ id, action })}
          />
        </div>
      )}
    </section>
  );
}

interface MarketSectionProps {
  title: string;
  entries: EnterpriseMarketEntry[];
  pending?: { id: string; action: Action };
  busy: boolean;
  onAction: (id: string, action: Action) => void;
}

function MarketSection({
  title,
  entries,
  pending,
  busy,
  onAction,
}: MarketSectionProps) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-fg-2">{title}</h3>
      <ul className="divide-y divide-border">
        {entries.map(({ item, installedVersion, updateAvailable }) => {
          const installed = installedVersion != null;
          const status = !installed
            ? "notInstalled"
            : updateAvailable
              ? "updateAvailable"
              : "installed";
          const spinning = (action: Action) =>
            pending?.id === item.id && pending.action === action;
          return (
            <li
              key={item.id}
              className="flex items-center gap-3 py-2"
              data-testid={`enterprise-market-item-${item.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg-1">
                    {item.name}
                  </span>
                  <span className="text-xs text-fg-3">v{item.version}</span>
                  {item.mandatory && (
                    <Badge variant="secondary">
                      {t("enterpriseMarket.mandatory")}
                    </Badge>
                  )}
                  <Badge variant="outline">
                    {t(`enterpriseMarket.status.${status}`)}
                  </Badge>
                </div>
                {item.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-fg-3">
                    {item.description}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {(!installed || updateAvailable) && (
                  <Button
                    size="compact"
                    variant="neutral"
                    disabled={busy}
                    onClick={() => onAction(item.id, "install")}
                  >
                    {spinning("install") && (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    )}
                    {t(
                      installed
                        ? "enterpriseMarket.update"
                        : "enterpriseMarket.install",
                    )}
                  </Button>
                )}
                {installed && !item.mandatory && (
                  <Button
                    size="compact"
                    variant="quiet"
                    disabled={busy}
                    onClick={() => onAction(item.id, "uninstall")}
                  >
                    {spinning("uninstall") && (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    )}
                    {t("enterpriseMarket.uninstall")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default EnterpriseMarketPanel;
