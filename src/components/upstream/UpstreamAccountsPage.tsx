import { useQuery } from "@tanstack/react-query";
import { Gauge, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UpstreamAccount, UpstreamWindow } from "../../../enterprise/contracts/src/index.ts";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { enterpriseApi } from "@/lib/api/enterprise";
import { extractErrorMessage } from "@/utils/errorUtils";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtRemain(sec: number): string {
  if (sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 窗口重置的本地时刻，如 10-15 20:00 */
function fmtResetAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function WindowRow({ w }: { w: UpstreamWindow }) {
  const { t } = useTranslation();
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const resetAt = fmtResetAt(w.resetsAt);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-caption text-fg-3">
        <span className="inline-flex h-5 min-w-8 items-center justify-center rounded-control bg-subtle px-1.5 font-medium text-fg-1">
          {w.id}
        </span>
        <span>{t("upstream.requests", { n: w.requests })}</span>
        <span>{fmtTokens(w.tokens)}</span>
        <span>A ${w.accountCost.toFixed(2)}</span>
        <span>U ${w.userCost.toFixed(2)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <div className="w-32 shrink-0 text-right text-caption tabular-nums text-fg-3">
          <div>
            {pct.toFixed(0)}% {fmtRemain(w.remainingSeconds)}
          </div>
          {resetAt && (
            <div title={w.resetsAt ?? undefined}>
              {t("upstream.expiresAt", { time: resetAt })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AccountCard({ acc }: { acc: UpstreamAccount }) {
  return (
    <div className="space-y-3 rounded-panel border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-fg-1">{acc.name}</div>
          <div className="truncate text-caption text-fg-3">
            {acc.email ?? acc.platform}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-caption">
          <span className={acc.status === "active" ? "text-success" : "text-danger"}>
            {acc.status === "active" ? "正常" : acc.status}
          </span>
          {acc.groups[0] && <span className="text-fg-3">{acc.groups[0]}</span>}
        </div>
      </div>
      <div className="space-y-3">
        {acc.windows.map((w) => (
          <WindowRow key={w.id} w={w} />
        ))}
      </div>
    </div>
  );
}

export function UpstreamAccountsPage() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["enterprise", "upstream", "accounts"],
    queryFn: enterpriseApi.upstreamAccounts,
  });

  return (
    <div id="main-content" className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<Gauge className="h-5 w-5" strokeWidth={1.5} />}
        title={t("nav.upstream")}
        actions={
          <Button
            type="button"
            variant="quiet"
            size="icon-compact"
            aria-label={t("common.refresh")}
            disabled={q.isFetching}
            onClick={() => void q.refetch()}
          >
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-stable px-6 pb-10 pt-4">
        {q.isPending ? (
          <p className="py-16 text-center text-body text-fg-2">
            {t("upstream.loading")}
          </p>
        ) : q.isError ? (
          <p className="py-16 text-center text-body text-danger">
            {extractErrorMessage(q.error)}
          </p>
        ) : !q.data.configured ? (
          <p className="py-16 text-center text-body text-fg-2">
            {q.data.error ?? t("upstream.unconfigured")}
          </p>
        ) : q.data.error && q.data.items.length === 0 ? (
          <p className="py-16 text-center text-body text-danger">{q.data.error}</p>
        ) : q.data.items.length === 0 ? (
          <p className="py-16 text-center text-body text-fg-2">{t("upstream.empty")}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {q.data.items.map((acc) => (
              <AccountCard key={acc.id} acc={acc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
