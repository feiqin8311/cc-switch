import { UsageResponseSchema, type UsageRow } from "@ccse/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BarChart3, Search } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  inputClass,
  LoadingState,
  PageHeader,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  trClass,
} from "../components/ui";
import { useApi } from "../lib/auth";
import { daySpan, formatNumber, lastUtcDays } from "../lib/format";

const MAX_DAYS = 92;

interface Totals {
  key: string;
  label: ReactNode;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

function aggregate(
  rows: UsageRow[],
  keyOf: (r: UsageRow) => string,
  labelOf: (r: UsageRow) => ReactNode,
): Totals[] {
  const map = new Map<string, Totals>();
  for (const r of rows) {
    const key = keyOf(r);
    let t = map.get(key);
    if (!t) {
      t = {
        key,
        label: labelOf(r),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      map.set(key, t);
    }
    t.requests += r.requests;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
  }
  return [...map.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
}

const num = `${tdClass} text-right tabular-nums`;
const numTh = `${thClass} text-right`;

export function UsagePage() {
  const client = useApi();
  const [initialFrom, initialTo] = useMemo(() => lastUtcDays(7), []);
  const [draft, setDraft] = useState({ from: initialFrom, to: initialTo });
  const [range, setRange] = useState({ from: initialFrom, to: initialTo });
  const [rangeError, setRangeError] = useState<string | null>(null);

  const usage = useQuery({
    queryKey: ["admin", "usage", range.from, range.to],
    queryFn: ({ signal }) =>
      client.request("/admin/usage", {
        query: range,
        schema: UsageResponseSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
  });

  const rows = usage.data?.items ?? [];
  const byUser = useMemo(
    () =>
      aggregate(
        rows,
        (r) => r.userId,
        (r) => r.username,
      ),
    [rows],
  );
  const byModel = useMemo(
    () =>
      aggregate(
        rows,
        (r) => `${r.providerId}\u0000${r.model}`,
        (r) => (
          <>
            <span className="font-mono">{r.model}</span>
            <span className="ml-1 text-xs text-muted-foreground">{r.providerId}</span>
          </>
        ),
      ),
    [rows],
  );
  const grand = useMemo(
    () =>
      aggregate(
        rows,
        () => "all",
        () => "合计",
      )[0],
    [rows],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.from || !draft.to) {
      setRangeError("请选择起止日期");
      return;
    }
    const span = daySpan(draft.from, draft.to);
    if (span < 1) {
      setRangeError("开始日期不能晚于结束日期");
      return;
    }
    if (span > MAX_DAYS) {
      setRangeError(`查询范围最多 ${MAX_DAYS} 天`);
      return;
    }
    setRangeError(null);
    setRange({ ...draft });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="用量统计"
        description="按 UTC 日期统计经企业网关产生的请求数与 token 用量。"
      />
      <form
        onSubmit={onSubmit}
        noValidate
        className="rounded-2xl border border-border/80 bg-card p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="开始日期（UTC）" htmlFor="usage-from">
            <input
              id="usage-from"
              type="date"
              className={`${inputClass} w-40`}
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            />
          </Field>
          <Field label="结束日期（UTC）" htmlFor="usage-to">
            <input
              id="usage-to"
              type="date"
              className={`${inputClass} w-40`}
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            />
          </Field>
          <Button type="submit" variant="primary">
            <Search className="size-3.5" />
            查询
          </Button>
          {usage.isFetching && !usage.isPending && <Spinner className="mb-2" />}
        </div>
        {rangeError && (
          <div className="mt-3">
            <InlineError>{rangeError}</InlineError>
          </div>
        )}
      </form>

      {usage.isPending ? (
        <Card>
          <LoadingState />
        </Card>
      ) : usage.isError ? (
        <Card>
          <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BarChart3 className="size-5 stroke-[1.5]" />}
            title="暂无用量记录"
          >
            {range.from} 至 {range.to} 没有用量记录
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {grand && (
            <Card>
              <div className="border-b border-border/50 pb-2.5 text-xs font-medium text-foreground">
                概览指标
              </div>
              <div className="mt-4 grid grid-cols-4 gap-4 text-left">
                <Stat label="请求数" value={grand.requests} />
                <Stat label="输入 tokens" value={grand.inputTokens} />
                <Stat label="输出 tokens" value={grand.outputTokens} />
                <Stat
                  label="总 tokens"
                  value={grand.inputTokens + grand.outputTokens}
                />
              </div>
            </Card>
          )}
          <div className="grid grid-cols-2 gap-5">
            <TotalsTable title="按用户汇总" keyLabel="用户" rows={byUser} />
            <TotalsTable title="按模型汇总" keyLabel="模型" rows={byModel} />
          </div>
          <Card className="overflow-x-auto">
            <h2 className="border-b border-border/50 px-4 py-2.5 font-serif text-sm font-medium text-foreground">
              明细
            </h2>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>日期</th>
                  <th className={thClass}>用户</th>
                  <th className={thClass}>模型服务</th>
                  <th className={thClass}>模型</th>
                  <th className={numTh}>请求数</th>
                  <th className={numTh}>输入 tokens</th>
                  <th className={numTh}>输出 tokens</th>
                  <th className={numTh}>总 tokens</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.date}|${r.userId}|${r.providerId}|${r.model}`}
                    className={trClass}
                  >
                    <td className={`${tdClass} whitespace-nowrap`}>{r.date}</td>
                    <td className={tdClass}>{r.username}</td>
                    <td className={`${tdClass} font-mono text-xs`}>
                      {r.providerId}
                    </td>
                    <td className={`${tdClass} font-mono text-xs`}>
                      {r.model}
                    </td>
                    <td className={num}>{formatNumber(r.requests)}</td>
                    <td className={num}>{formatNumber(r.inputTokens)}</td>
                    <td className={num}>{formatNumber(r.outputTokens)}</td>
                    <td className={num}>
                      {formatNumber(r.inputTokens + r.outputTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-serif font-normal text-foreground tabular-nums">
        {formatNumber(value)}
      </div>
    </Card>
  );
}

function TotalsTable({
  title,
  keyLabel,
  rows,
}: {
  title: string;
  keyLabel: string;
  rows: Totals[];
}) {
  return (
    <Card className="overflow-x-auto">
      <h2 className="border-b border-border/50 px-4 py-2.5 font-serif text-sm font-medium text-foreground">
        {title}
      </h2>
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>{keyLabel}</th>
            <th className={numTh}>请求数</th>
            <th className={numTh}>输入</th>
            <th className={numTh}>输出</th>
            <th className={numTh}>合计</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.key} className={trClass}>
              <td className={tdClass}>{t.label}</td>
              <td className={num}>{formatNumber(t.requests)}</td>
              <td className={num}>{formatNumber(t.inputTokens)}</td>
              <td className={num}>{formatNumber(t.outputTokens)}</td>
              <td className={num}>
                {formatNumber(t.inputTokens + t.outputTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
