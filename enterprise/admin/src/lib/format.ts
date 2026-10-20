import type { Role } from "@ccse/contracts";
import { ApiError } from "./api";

export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理员",
  group_leader: "组长",
  member: "成员",
  viewer: "只读",
};

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

const CODE_MESSAGES: Record<ApiError["code"], string> = {
  bad_request: "请求参数有误",
  unauthorized: "登录已失效，请重新登录",
  forbidden: "没有权限执行此操作",
  not_found: "资源不存在",
  conflict: "数据冲突，请刷新后重试",
  rate_limited: "操作过于频繁，请稍后再试",
  payload_too_large: "请求内容过大",
  upstream_error: "上游服务不可用",
  internal: "服务器内部错误，请稍后再试",
  network_error: "无法连接服务器，请检查网络",
  invalid_response: "服务器响应格式异常",
};

/** Codes whose server message adds useful detail to the generic text. */
const DETAILED: ReadonlySet<ApiError["code"]> = new Set([
  "bad_request",
  "forbidden",
  "conflict",
  "upstream_error",
]);

/** Chinese message for any error thrown by the API client. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const base = CODE_MESSAGES[err.code];
    return DETAILED.has(err.code) && err.message
      ? `${base}（${err.message}）`
      : base;
  }
  return "发生未知错误";
}

/** 400 validation issues keyed by dotted path (first message wins). */
export function fieldErrorsOf(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError) || err.code !== "bad_request") return out;
  for (const issue of err.fieldIssues) {
    out[issue.path] ??= issue.message;
  }
  return out;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("zh-CN");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** YYYY-MM-DD of a date in UTC. */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** [from, to] covering the last `days` UTC days, today included. */
export function lastUtcDays(days: number, now = new Date()): [string, string] {
  const from = new Date(now.getTime() - (days - 1) * 86_400_000);
  return [utcDate(from), utcDate(now)];
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function daySpan(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export type UtcRangePreset =
  | "today"
  | "yesterday"
  | "last24h"
  | "last7d"
  | "last14d"
  | "last30d"
  | "thisMonth"
  | "lastMonth";

/** UTC [from, to] for a named preset. last24h is yesterday–today (day API). */
export function rangeForPreset(
  preset: UtcRangePreset,
  now = new Date(),
): [string, string] {
  const today = utcDate(now);
  switch (preset) {
    case "today":
      return [today, today];
    case "yesterday": {
      const y = utcDate(new Date(now.getTime() - 86_400_000));
      return [y, y];
    }
    case "last24h":
      return lastUtcDays(2, now);
    case "last7d":
      return lastUtcDays(7, now);
    case "last14d":
      return lastUtcDays(14, now);
    case "last30d":
      return lastUtcDays(30, now);
    case "thisMonth": {
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth() + 1;
      return [`${y}-${pad2(m)}-01`, today];
    }
    case "lastMonth": {
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      const py = m === 0 ? y - 1 : y;
      const pm = m === 0 ? 12 : m;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return [`${py}-${pad2(pm)}-01`, `${py}-${pad2(pm)}-${pad2(lastDay)}`];
    }
  }
}

const PRESET_ORDER: UtcRangePreset[] = [
  "today",
  "yesterday",
  "last24h",
  "last7d",
  "last14d",
  "last30d",
  "thisMonth",
  "lastMonth",
];

/** First preset whose UTC range equals [from, to], else custom. */
export function matchingUtcPreset(
  from: string,
  to: string,
  now = new Date(),
): UtcRangePreset | "custom" {
  for (const p of PRESET_ORDER) {
    const [a, b] = rangeForPreset(p, now);
    if (a === from && b === to) return p;
  }
  return "custom";
}
