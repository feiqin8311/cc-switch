import { useQuery } from "@tanstack/react-query";
import { Gauge, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CodingPlanUsageResponse,
  UpstreamAccount,
} from "../../../enterprise/contracts/src/index.ts";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { enterpriseApi } from "@/lib/api/enterprise";
import { extractErrorMessage } from "@/utils/errorUtils";

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

function capacityClass(current: number, max: number): string {
  if (max > 0 && current >= max) return "text-danger";
  if (current > 0) return "text-warning-text";
  return "text-fg-3";
}

function WindowRow({
  w,
  percentDigits = 0,
}: {
  w: {
    id: string;
    usedPercent: number | null;
    remainingSeconds: number | null;
    resetsAt: string | null;
  };
  percentDigits?: number;
}) {
  const { t } = useTranslation();
  const pct = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  const resetAt = fmtResetAt(w.resetsAt);
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex h-5 min-w-8 shrink-0 items-center justify-center rounded-control bg-subtle px-1.5 text-caption font-medium text-fg-1">
        {w.id}
      </span>
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle"
        role="progressbar"
        aria-label={`${w.id} 用量`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={w.usedPercent == null ? undefined : pct}
        aria-valuetext={
          w.usedPercent == null
            ? "暂无数据"
            : `${w.usedPercent.toFixed(percentDigits)}%`
        }
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="w-32 shrink-0 text-right text-caption tabular-nums text-fg-3">
        <div>
          {w.usedPercent == null
            ? "—"
            : `${w.usedPercent.toFixed(percentDigits)}%`}{" "}
          {w.remainingSeconds == null ? "" : fmtRemain(w.remainingSeconds)}
        </div>
        {resetAt && (
          <div title={w.resetsAt ?? undefined}>
            {t("upstream.expiresAt", { time: resetAt })}
          </div>
        )}
      </div>
    </div>
  );
}

function AccountCard({ acc }: { acc: UpstreamAccount }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-panel border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-fg-1">
            {acc.name}
          </div>
          <div className="truncate text-caption text-fg-3">
            {acc.email ?? acc.platform}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-caption">
          <span
            className={acc.status === "active" ? "text-success" : "text-danger"}
          >
            {acc.status === "active" ? "正常" : acc.status}
          </span>
          {acc.groups[0] && <span className="text-fg-3">{acc.groups[0]}</span>}
          <span
            className="inline-flex items-center gap-1.5 tabular-nums"
            title={t("upstream.capacityLabel")}
          >
            <span className="text-fg-3">{t("upstream.capacityLabel")}</span>
            <span
              className={capacityClass(
                acc.currentConcurrency ?? 0,
                acc.maxConcurrency ?? 0,
              )}
            >
              {acc.currentConcurrency ?? 0} / {acc.maxConcurrency ?? 0}
            </span>
          </span>
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

function CodingPlanCard({
  data,
  now,
}: {
  data: CodingPlanUsageResponse;
  now: number;
}) {
  const expired =
    data.status === "Expired" || data.subscription?.status === "Expired";
  const active =
    data.status === "Running" || data.subscription?.status === "Running";
  const status = data.stale
    ? "同步延迟"
    : data.error
      ? "异常"
      : expired
        ? "已过期"
        : active
          ? "正常"
          : "已同步";
  const expiresAt = fmtResetAt(data.subscription?.expiresAt ?? null);
  return (
    <div className="space-y-3 rounded-panel border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-body font-medium text-fg-1">
            Libraton-火山方舟Codin Plan
          </div>
          <div className="truncate text-caption text-fg-3">
            {data.providerId}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-caption">
          <span
            className={
              data.stale
                ? "text-warning-text"
                : data.error || expired
                  ? "text-danger"
                  : active
                    ? "text-success"
                    : "text-fg-3"
            }
          >
            {status}
          </span>
          <span className="text-fg-3">
            Coding Plan
            {data.subscription?.planType
              ? ` ${data.subscription.planType}`
              : ""}
          </span>
          {expiresAt && (
            <span
              className="text-fg-3"
              title={data.subscription?.expiresAt ?? undefined}
            >
              套餐到期 {expiresAt}
            </span>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {(
          [
            ["fiveHour", "5h"],
            ["weekly", "7d"],
            ["monthly", "月"],
          ] as const
        ).map(([id, label]) => {
          const window = data.windows.find((w) => w.id === id);
          return (
            <WindowRow
              key={id}
              percentDigits={2}
              w={{
                id: label,
                usedPercent: window?.usedPercent ?? null,
                resetsAt: window?.resetsAt ?? null,
                remainingSeconds: window?.resetsAt
                  ? (new Date(window.resetsAt).getTime() - now) / 1000
                  : null,
              }}
            />
          );
        })}
      </div>
      {(data.error || data.warning) && (
        <p role="alert" className="text-caption text-warning-text">
          {data.error ?? data.warning}
          {data.stale ? " 当前保留上次成功同步的数据。" : ""}
        </p>
      )}
      <p className="text-caption text-fg-3">
        账号共享额度
        {data.fetchedAt && (
          <span title={data.fetchedAt}>
            {" "}
            · 同步于{" "}
            {new Date(data.fetchedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </span>
        )}
      </p>
    </div>
  );
}

export function UpstreamAccountsPage() {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const q = useQuery({
    queryKey: ["enterprise", "upstream", "accounts"],
    queryFn: enterpriseApi.upstreamAccounts,
    refetchInterval: 60_000,
  });
  const hasCodingPlan = !!q.data?.codingPlan?.configured;
  const hasCards = (q.data?.items.length ?? 0) > 0 || hasCodingPlan;

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
            <RefreshCw
              className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`}
            />
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
        ) : q.data.error && !hasCards ? (
          <p className="py-16 text-center text-body text-danger">
            {q.data.error}
          </p>
        ) : !hasCards ? (
          <p className="py-16 text-center text-body text-fg-2">
            {t("upstream.empty")}
          </p>
        ) : (
          <>
            {q.data.error && (
              <p role="alert" className="mb-4 text-caption text-danger">
                {q.data.error}
              </p>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {q.data.items.map((acc) => (
                <AccountCard key={acc.id} acc={acc} />
              ))}
              {hasCodingPlan && q.data.codingPlan && (
                <CodingPlanCard data={q.data.codingPlan} now={now} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
