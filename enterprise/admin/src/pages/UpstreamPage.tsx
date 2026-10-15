import {
  UpstreamAccountsResponseSchema,
  type UpstreamAccount,
  type UpstreamWindow,
} from "@ccse/contracts";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from "../components/ui";
import { useApi } from "../lib/auth";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtRemain(sec: number): string {
  if (sec <= 0) return "已过期";
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

function fmtResetAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function WindowRow({ w }: { w: UpstreamWindow }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const resetAt = fmtResetAt(w.resetsAt);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex h-5 min-w-8 items-center justify-center rounded bg-muted px-1.5 font-medium text-foreground">
          {w.id}
        </span>
        <span>{w.requests} 次查询</span>
        <span>{fmtTokens(w.tokens)}</span>
        <span>A ${w.accountCost.toFixed(2)}</span>
        <span>U ${w.userCost.toFixed(2)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          <div>
            {pct.toFixed(0)}% {fmtRemain(w.remainingSeconds)}
          </div>
          {resetAt && (
            <div title={w.resetsAt ?? undefined}>到期 {resetAt}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function AccountCard({ acc }: { acc: UpstreamAccount }) {
  const status =
    acc.status === "active"
      ? "正常"
      : acc.status === "error"
        ? "异常"
        : acc.status;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{acc.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {acc.email ?? acc.platform}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
          <span
            className={
              acc.status === "active" ? "text-emerald-600" : "text-destructive"
            }
          >
            {status}
          </span>
          {acc.groups[0] && (
            <span className="text-muted-foreground">{acc.groups[0]}</span>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {acc.windows.map((w) => (
          <WindowRow key={w.id} w={w} />
        ))}
      </div>
    </Card>
  );
}

export function UpstreamPage() {
  const client = useApi();
  const q = useQuery({
    queryKey: ["admin", "upstream", "accounts"],
    queryFn: ({ signal }) =>
      client.request("/admin/upstream/accounts", {
        schema: UpstreamAccountsResponseSchema,
        signal,
      }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="上游账号"
        description="Sub2API 里 ChatGPT / Codex 等账号的 5 小时与 7 天用量窗口。"
        actions={
          <Button
            variant="secondary"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw className={`size-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
            刷新
          </Button>
        }
      />
      {q.isPending ? (
        <LoadingState label="正在读取上游账号…" />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : !q.data.configured ? (
        <EmptyState title="未配置 Sub2API">
          {q.data.error ?? "在服务器 .env 里填写 SUB2API_URL / SUB2API_EMAIL / SUB2API_PASSWORD。"}
        </EmptyState>
      ) : q.data.error && q.data.items.length === 0 ? (
        <EmptyState title="无法读取 Sub2API">{q.data.error}</EmptyState>
      ) : q.data.items.length === 0 ? (
        <EmptyState title="没有上游账号">Sub2API 里还没有账号。</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {q.data.items.map((acc) => (
            <AccountCard key={acc.id} acc={acc} />
          ))}
        </div>
      )}
    </div>
  );
}
