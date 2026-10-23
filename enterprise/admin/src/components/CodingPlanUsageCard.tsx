import type {
  CodingPlanUsageResponse,
  CodingPlanWindow,
} from "@ccse/contracts";
import { CODING_PLAN_ACCOUNT_NAME } from "@ccse/contracts";
import { AccountUsageCard, fmtResetAt } from "./UpstreamAccountCard";

const WINDOWS: { id: CodingPlanWindow["id"]; label: string }[] = [
  { id: "fiveHour", label: "5h" },
  { id: "weekly", label: "7d" },
  { id: "monthly", label: "月" },
];

/** Compact upstream account card; the page owns both queries and refresh. */
export function CodingPlanUsageCard({
  data,
  now,
  refreshFailed = false,
}: {
  data: CodingPlanUsageResponse;
  now: number;
  refreshFailed?: boolean;
}) {
  const stale = data.stale || (refreshFailed && !!data.fetchedAt);
  const expired =
    data.subscription?.status === "Expired" || data.status === "Expired";
  const active =
    data.subscription?.status === "Running" || data.status === "Running";
  const error = data.error ?? (refreshFailed ? "刷新失败，请稍后重试。" : null);
  const name = CODING_PLAN_ACCOUNT_NAME;
  const resetAt = fmtResetAt(data.subscription?.expiresAt ?? null);
  return (
    <AccountUsageCard
      name={name}
      subtitle={data.providerId}
      status={
        stale
          ? "同步延迟"
          : error
            ? "异常"
            : expired
              ? "已过期"
              : active
                ? "正常"
                : "已同步"
      }
      statusClass={
        stale
          ? "text-amber-600"
          : error || expired
            ? "text-destructive"
            : active
              ? "text-emerald-600"
              : "text-muted-foreground"
      }
      group={`Coding Plan${data.subscription?.planType ? ` ${data.subscription.planType}` : ""}`}
      details={
        resetAt ? (
          <span
            className="tabular-nums text-muted-foreground"
            title={data.subscription?.expiresAt ?? undefined}
          >
            套餐到期 {resetAt}
          </span>
        ) : undefined
      }
      percentDigits={2}
      windows={WINDOWS.map(({ id, label }) => {
        const window = data.windows.find((w) => w.id === id);
        return {
          id: label,
          usedPercent: window?.usedPercent ?? null,
          resetsAt: window?.resetsAt ?? null,
          remainingSeconds: window?.resetsAt
            ? (new Date(window.resetsAt).getTime() - now) / 1000
            : null,
        };
      })}
      error={
        error
          ? `${error}${stale ? " 当前保留上次成功同步的数据。" : ""}`
          : data.warning
      }
      note={
        <>
          账号共享额度
          {data.fetchedAt && (
            <span title={data.fetchedAt}>
              {" "}
              · 同步于{" "}
              {new Intl.DateTimeFormat("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }).format(new Date(data.fetchedAt))}
            </span>
          )}
        </>
      }
    />
  );
}
