import { type ReactNode, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { HoverTip } from "@/components/ui/hover-tip";
import { useAuth } from "@/contexts/AuthContext";
import {
  enterpriseMarketApi,
  type EnterpriseMarketEntry,
  type MarketItemKind,
} from "@/lib/api/enterpriseMarket";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/utils/errorUtils";

export const enterpriseMarketQueryKey = ["enterpriseMarket", "list"] as const;

type Action = "install" | "uninstall";

interface EnterpriseMarketPanelProps {
  /** Which kinds this page lists; one section per kind, in this order. */
  kinds?: MarketItemKind[];
  /** Puts the refresh button into the page's tab row (portal slot). */
  renderTrailing?: (trailing: ReactNode) => ReactNode;
}

const DEFAULT_KINDS: MarketItemKind[] = ["skill", "plugin"];

const KIND_TITLE_KEYS: Record<MarketItemKind, string> = {
  skill: "enterpriseMarket.skills",
  plugin: "enterpriseMarket.plugins",
  mcp: "enterpriseMarket.mcp",
  prompt: "enterpriseMarket.prompts",
};

/**
 * The "企业市场" tab of the Skills page (skills, Codex plugins), the MCP page
 * and the Codex prompts page, published by the enterprise server. Only shown
 * with `market.install`.
 */
export function EnterpriseMarketPanel(props: EnterpriseMarketPanelProps) {
  const { hasPermission } = useAuth();
  const canInstall = hasPermission("market.install");
  if (!canInstall) return null;
  return <EnterpriseMarketList {...props} />;
}

function EnterpriseMarketList({
  kinds = DEFAULT_KINDS,
  renderTrailing,
}: EnterpriseMarketPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ id: string; action: Action }>();
  const [selected, setSelected] = useState<string[]>([]);
  const bulkRef = useRef(false);

  const query = useQuery({
    queryKey: enterpriseMarketQueryKey,
    queryFn: enterpriseMarketApi.list,
  });

  const afterChange = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: enterpriseMarketQueryKey }),
      queryClient.invalidateQueries({ queryKey: ["skills", "installed"] }),
      queryClient.invalidateQueries({ queryKey: ["skills", "unmanaged"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp", "all"] }),
      queryClient.invalidateQueries({ queryKey: ["prompts"] }),
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

  const entries = (query.data ?? []).filter((e) => kinds.includes(e.item.kind));
  const installableIds = useMemo(
    () =>
      entries
        .filter((e) => e.installedVersion == null)
        .map((e) => e.item.id),
    [entries],
  );
  const selectedInstallable = selected.filter((id) =>
    installableIds.includes(id),
  );
  const allSelected =
    installableIds.length > 0 &&
    installableIds.every((id) => selectedInstallable.includes(id));
  const busy = mutation.isPending || pending != null;

  const installSelected = async () => {
    const ids = selectedInstallable;
    if (ids.length === 0 || busy || bulkRef.current) return;
    bulkRef.current = true;
    let ok = 0;
    let lastError = "";
    try {
      for (const id of ids) {
        try {
          setPending({ id, action: "install" });
          await enterpriseMarketApi.install(id);
          ok += 1;
        } catch (error) {
          lastError = extractErrorMessage(error);
        }
      }
    } finally {
      bulkRef.current = false;
      setPending(undefined);
    }
    setSelected([]);
    await afterChange();
    if (ok > 0) {
      toast.success(
        t("enterpriseMarket.toast.installedCount", { count: ok }),
      );
    }
    if (ok < ids.length) {
      toast.error(
        t("enterpriseMarket.toast.installPartial", {
          ok,
          fail: ids.length - ok,
          error: lastError,
        }),
      );
    }
  };

  const notice = (text: string, danger = false) => (
    <div
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-16 text-body",
        danger ? "text-danger" : "text-fg-2",
      )}
    >
      {text}
    </div>
  );

  return (
    <section
      className="flex min-h-0 flex-1 flex-col px-6 pb-5 pt-3"
      aria-label={t("enterpriseMarket.title")}
    >
      {renderTrailing?.(
        <HoverTip content={t("common.refresh")}>
          <Button
            type="button"
            variant="quiet"
            size="icon-compact"
            aria-label={t("common.refresh")}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              className={cn("h-4 w-4", query.isFetching && "animate-spin")}
              strokeWidth={1.5}
            />
          </Button>
        </HoverTip>,
      )}
      <div className="min-h-0 overflow-auto scroll-stable rounded-panel border border-border bg-surface">
        {query.isError ? (
          notice(
            t("enterpriseMarket.loadFailed", {
              error: extractErrorMessage(query.error),
            }),
            true,
          )
        ) : query.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-body text-fg-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("enterpriseMarket.loading")}
          </div>
        ) : entries.length === 0 ? (
          notice(t("enterpriseMarket.empty"))
        ) : (
          <>
            {installableIds.length > 0 && (
              <div className="flex h-11 items-center gap-3 border-b border-border bg-subtle px-4">
                <Checkbox
                  aria-label={t("enterpriseMarket.selectAll")}
                  disabled={busy}
                  checked={
                    allSelected
                      ? true
                      : selectedInstallable.length > 0
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={(on) =>
                    setSelected(on ? installableIds : [])
                  }
                />
                <Button
                  type="button"
                  size="compact"
                  variant="neutral"
                  disabled={busy || selectedInstallable.length === 0}
                  data-testid="enterprise-market-install-selected"
                  onClick={() => void installSelected()}
                >
                  {pending?.action === "install" &&
                    selectedInstallable.includes(pending.id) && (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    )}
                  {t("enterpriseMarket.installSelected", {
                    count: selectedInstallable.length,
                  })}
                </Button>
              </div>
            )}
            {kinds.map((kind) => (
              <MarketSection
                key={kind}
                // 只列一种时不用分组标题
                title={kinds.length > 1 ? t(KIND_TITLE_KEYS[kind]) : undefined}
                entries={entries.filter((e) => e.item.kind === kind)}
                selected={selectedInstallable}
                pending={pending}
                busy={busy}
                onToggle={(id, on) =>
                  setSelected((prev) => {
                    if (on) return prev.includes(id) ? prev : [...prev, id];
                    return prev.filter((x) => x !== id);
                  })
                }
                onAction={(id, action) => mutation.mutate({ id, action })}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

interface MarketSectionProps {
  title?: string;
  entries: EnterpriseMarketEntry[];
  selected: string[];
  pending?: { id: string; action: Action };
  busy: boolean;
  onToggle: (id: string, on: boolean) => void;
  onAction: (id: string, action: Action) => void;
}

function MarketSection({
  title,
  entries,
  selected,
  pending,
  busy,
  onToggle,
  onAction,
}: MarketSectionProps) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div className="[&+&]:border-t [&+&]:border-border">
      {title && (
        <h3 className="border-b border-border bg-subtle px-4 py-1.5 text-caption font-medium text-fg-3">
          {title}
        </h3>
      )}
      <ul className="m-0 list-none divide-y divide-border p-0">
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
              className="flex min-h-14 items-center gap-3 py-2 pe-3 ps-4"
              data-testid={`enterprise-market-item-${item.id}`}
            >
              {!installed && (
                <Checkbox
                  aria-label={item.name}
                  disabled={busy}
                  checked={selected.includes(item.id)}
                  onCheckedChange={(on) => onToggle(item.id, on)}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-body font-medium text-fg-1">
                    {item.name}
                  </span>
                  <span className="font-mono text-caption text-fg-3">
                    v{item.version}
                  </span>
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
                  <p className="mt-0.5 truncate text-caption text-fg-3">
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
