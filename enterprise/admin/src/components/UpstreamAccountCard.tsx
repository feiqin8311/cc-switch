import type { UpstreamAccount } from "@ccse/contracts";
import type { ReactNode } from "react";
import { Card } from "./ui";

export interface AccountUsageWindow {
  id: string;
  usedPercent: number | null;
  resetsAt: string | null;
  remainingSeconds: number | null;
}

function fmtRemain(sec: number | null): string {
  if (sec == null) return "暂无重置时间";
  if (sec <= 0) return "已过期";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtResetAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Shared account card: identical header and quota rows for both sources. */
export function AccountUsageCard({
  name,
  subtitle,
  status,
  statusClass,
  group,
  details,
  windows,
  percentDigits = 0,
  note,
  error,
}: {
  name: string;
  subtitle: string;
  status: string;
  statusClass: string;
  group?: string;
  details?: ReactNode;
  windows: AccountUsageWindow[];
  percentDigits?: number;
  note?: ReactNode;
  error?: string | null;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{name}</div>
          <div
            className="truncate text-xs text-muted-foreground"
            title={subtitle}
          >
            {subtitle}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
          <span className={statusClass}>{status}</span>
          {group && <span className="text-muted-foreground">{group}</span>}
          {details}
        </div>
      </div>
      <div className="space-y-3">
        {windows.map((w) => {
          const pct =
            w.usedPercent == null
              ? null
              : Math.max(0, Math.min(100, w.usedPercent));
          const resetAt = fmtResetAt(w.resetsAt);
          return (
            <div key={w.id} className="flex items-center gap-2">
              <span className="inline-flex h-5 min-w-8 shrink-0 items-center justify-center rounded bg-muted px-1.5 text-xs font-medium text-foreground">
                {w.id}
              </span>
              <div
                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                {...(pct == null
                  ? {}
                  : {
                      role: "progressbar",
                      "aria-label": `${name} ${w.id} 用量`,
                      "aria-valuemin": 0,
                      "aria-valuemax": 100,
                      "aria-valuenow": pct,
                      "aria-valuetext": `已使用 ${w.usedPercent?.toFixed(percentDigits)}%`,
                    })}
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              <div className="w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                <div>
                  {w.usedPercent == null
                    ? "暂无用量数据"
                    : `${w.usedPercent.toFixed(percentDigits)}% ${fmtRemain(w.remainingSeconds)}`}
                </div>
                {resetAt && (
                  <div title={w.resetsAt ?? undefined}>到期 {resetAt}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-xs text-amber-600">
          {error}
        </p>
      )}
      {note && <div className="text-[11px] text-muted-foreground">{note}</div>}
    </Card>
  );
}

export function UpstreamAccountCard({ acc }: { acc: UpstreamAccount }) {
  const capacityClass =
    acc.maxConcurrency > 0 && acc.currentConcurrency >= acc.maxConcurrency
      ? "text-destructive"
      : acc.currentConcurrency > 0
        ? "text-amber-600"
        : "text-muted-foreground";
  return (
    <AccountUsageCard
      name={acc.name}
      subtitle={acc.email ?? acc.platform}
      status={
        acc.status === "active"
          ? "正常"
          : acc.status === "error"
            ? "异常"
            : acc.status
      }
      statusClass={
        acc.status === "active" ? "text-emerald-600" : "text-destructive"
      }
      group={acc.groups[0]}
      details={
        <span className={`tabular-nums ${capacityClass}`} title="容量">
          {acc.currentConcurrency} / {acc.maxConcurrency}
        </span>
      }
      windows={acc.windows}
    />
  );
}
