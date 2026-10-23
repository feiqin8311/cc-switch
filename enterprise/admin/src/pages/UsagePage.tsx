import {
  UsageAccountCostsResponseSchema,
  type UsageAccountCostsResponse,
  DeviceUsageResponseSchema,
  UsageResponseSchema,
  type UsageRow,
} from "@ccse/contracts";
import {
  keepPreviousData,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  BarChart3,
  CalendarDays,
  ChevronDown,
  Search,
  Pencil,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Card,
  Dialog,
  InlineError,
  EmptyState,
  ErrorState,
  Field,
  inputClass,
  LoadingState,
  MultiSelect,
  PageHeader,
  type SelectOption,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  trClass,
} from "../components/ui";
import { useApi, useSession } from "../lib/auth";
import {
  daySpan,
  describeError,
  formatNumber,
  lastUtcDays,
  matchingUtcPreset,
  rangeForPreset,
  type UtcRangePreset,
} from "../lib/format";
import { useUsers } from "./UsersPage";

const MAX_DAYS = 92;
const PAGE_SIZE = 10;

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

interface Filters {
  userIds: string[];
  groups: string[];
  providerIds: string[];
}

const NO_FILTERS: Filters = { userIds: [], groups: [], providerIds: [] };

/** Fields shared by gateway and device usage rows that the filters look at. */
interface Filterable {
  userId: string;
  groupName: string;
  providerId: string;
}

function matches(f: Filters, r: Filterable): boolean {
  return (
    (f.userIds.length === 0 || f.userIds.includes(r.userId)) &&
    (f.groups.length === 0 || f.groups.includes(r.groupName)) &&
    (f.providerIds.length === 0 || f.providerIds.includes(r.providerId))
  );
}

const groupLabel = (g: string) => g || "未分组";

/** Sorted options for every distinct key, keeping already selected ones. */
function optionsOf(
  keys: Map<string, string>,
  selected: readonly string[],
): SelectOption[] {
  const all = new Map(keys);
  for (const v of selected) if (!all.has(v)) all.set(v, v);
  return [...all]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

const num = `${tdClass} text-right tabular-nums`;
const numTh = `${thClass} text-right`;

const RANGE_PRESETS: { id: UtcRangePreset; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "yesterday", label: "昨天" },
  { id: "last24h", label: "近24小时" },
  { id: "last7d", label: "近7天" },
  { id: "last14d", label: "近14天" },
  { id: "last30d", label: "近30天" },
  { id: "thisMonth", label: "本月" },
  { id: "lastMonth", label: "上月" },
];

const ACCOUNT_COSTS_KEY = ["admin", "usage-account-costs"] as const;

function slashDate(iso: string) {
  return iso.replaceAll("-", "/");
}

function DateRangePicker({
  from,
  to,
  onApply,
  error,
}: {
  from: string;
  to: string;
  onApply: (next: { from: string; to: string }) => boolean;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const root = useRef<HTMLDivElement>(null);
  const matched = matchingUtcPreset(from, to);
  const triggerLabel =
    RANGE_PRESETS.find((p) => p.id === matched)?.label ??
    `${slashDate(from)} – ${slashDate(to)}`;

  useEffect(() => {
    if (!open) return;
    setDraftFrom(from);
    setDraftTo(to);
  }, [open, from, to]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <Field label="时间范围">
      <div ref={root} className="relative">
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 w-full items-center gap-1.5 rounded-lg border border-input bg-card px-2.5 text-sm text-foreground shadow-2xs outline-none transition-colors hover:bg-muted/40 focus:border-ring focus:ring-1 focus:ring-ring"
        >
          <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
        {open && (
          <div
            role="dialog"
            aria-label="选择时间范围"
            className="absolute z-30 mt-1.5 w-[22rem] rounded-xl border border-border/80 bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <div className="grid grid-cols-2 gap-1">
              {RANGE_PRESETS.map((p) => {
                const selected = matched === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      const [a, b] = rangeForPreset(p.id);
                      if (onApply({ from: a, to: b }) !== false) setOpen(false);
                    }}
                    className={`h-8 rounded-lg px-2 text-sm transition-colors cursor-pointer ${
                      selected
                        ? "bg-muted font-medium text-foreground"
                        : "text-foreground hover:bg-muted/60"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-end gap-2 border-t border-border/60 pt-3">
              <Field
                label="开始日期"
                htmlFor="usage-from"
                className="min-w-0 flex-1"
              >
                <input
                  id="usage-from"
                  type="date"
                  className={inputClass}
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                />
              </Field>
              <span className="mb-2 text-muted-foreground">→</span>
              <Field
                label="结束日期"
                htmlFor="usage-to"
                className="min-w-0 flex-1"
              >
                <input
                  id="usage-to"
                  type="date"
                  className={inputClass}
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                />
              </Field>
            </div>
            {error && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => {
                  if (onApply({ from: draftFrom, to: draftTo }) !== false)
                    setOpen(false);
                }}
              >
                应用
              </Button>
            </div>
          </div>
        )}
      </div>
    </Field>
  );
}

export function UsagePage() {
  const client = useApi();
  const session = useSession();
  const isGroupLeader = session.user.role === "group_leader";
  const groupUsers = useUsers(
    isGroupLeader && session.permissions.includes("users.group.manage"),
  );
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
  const byDevice = useQuery({
    queryKey: ["admin", "usage-devices", range.from, range.to],
    queryFn: ({ signal }) =>
      client.request("/admin/usage/devices", {
        query: range,
        schema: DeviceUsageResponseSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
  });

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const filtering =
    filters.userIds.length +
      filters.groups.length +
      filters.providerIds.length >
    0;
  // Remembers usernames so a selected user keeps its label in a range where
  // they have no usage.
  const usernames = useRef(new Map<string, string>());

  const allRows = usage.data?.items ?? [];
  const deviceRows = byDevice.data?.items ?? [];
  const options = useMemo(() => {
    const users = new Map<string, string>();
    const groups = new Map<string, string>();
    const providers = new Map<string, string>();
    for (const user of groupUsers.data?.items ?? []) {
      users.set(user.id, user.username);
      usernames.current.set(user.id, user.username);
    }
    for (const r of [...allRows, ...deviceRows]) {
      users.set(r.userId, r.username);
      usernames.current.set(r.userId, r.username);
      groups.set(r.groupName, groupLabel(r.groupName));
      if (r.providerId) providers.set(r.providerId, r.providerId);
    }
    for (const id of filters.userIds) {
      const name = usernames.current.get(id);
      if (name && !users.has(id)) users.set(id, name);
    }
    return {
      users: optionsOf(users, filters.userIds),
      groups: optionsOf(groups, filters.groups).map((o) => ({
        ...o,
        label: groupLabel(o.value),
      })),
      providers: optionsOf(providers, filters.providerIds),
    };
  }, [allRows, deviceRows, filters, groupUsers.data]);

  const rows = useMemo(
    () => allRows.filter((r) => matches(filters, r)),
    [allRows, filters],
  );
  const devicesShown = useMemo(() => {
    const map = new Map<
      string,
      {
        deviceId: string;
        deviceName: string;
        usernames: string[];
        requests: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
      }
    >();
    for (const r of deviceRows) {
      if (!matches(filters, r)) continue;
      let d = map.get(r.deviceId);
      if (!d) {
        d = {
          deviceId: r.deviceId,
          deviceName: r.deviceName,
          usernames: [],
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
        map.set(r.deviceId, d);
      }
      if (!d.usernames.includes(r.username)) d.usernames.push(r.username);
      d.requests += r.requests;
      d.inputTokens += r.inputTokens;
      d.outputTokens += r.outputTokens;
      d.costUsd += r.costUsd;
    }
    return [...map.values()].sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );
  }, [deviceRows, filters]);

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
            <span className="ml-1 text-xs text-muted-foreground">
              {r.providerId}
            </span>
          </>
        ),
      ),
    [rows],
  );
  const detailRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          a.username.localeCompare(b.username, "zh-CN") ||
          a.providerId.localeCompare(b.providerId) ||
          a.model.localeCompare(b.model),
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

  const applyRange = (next: { from: string; to: string }) => {
    if (!next.from || !next.to) {
      setRangeError("请选择起止日期");
      return false;
    }
    const span = daySpan(next.from, next.to);
    if (span < 1) {
      setRangeError("开始日期不能晚于结束日期");
      return false;
    }
    if (span > MAX_DAYS) {
      setRangeError(`查询范围最多 ${MAX_DAYS} 天`);
      return false;
    }
    setRangeError(null);
    setDraft(next);
    setRange(next);
    return true;
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    applyRange(draft);
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
        <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(150px,1.2fr)_repeat(3,minmax(120px,1fr))_auto]">
          <DateRangePicker
            from={range.from}
            to={range.to}
            onApply={applyRange}
            error={rangeError}
          />
          <Field label="用户">
            <MultiSelect
              className="w-full"
              aria-label="按用户筛选"
              allLabel="全部用户"
              unit="个用户"
              options={options.users}
              value={filters.userIds}
              onChange={(userIds) => setFilters((f) => ({ ...f, userIds }))}
            />
          </Field>
          <Field label="组">
            {isGroupLeader ? (
              <input
                className={inputClass}
                aria-label="所属组"
                value={session.user.groupName || "未分配组"}
                readOnly
              />
            ) : (
              <MultiSelect
                className="w-full"
                aria-label="按组筛选"
                allLabel="全部组"
                unit="个组"
                options={options.groups}
                value={filters.groups}
                onChange={(groups) => setFilters((f) => ({ ...f, groups }))}
              />
            )}
          </Field>
          <Field label="供应商">
            <MultiSelect
              className="w-full"
              aria-label="按供应商筛选"
              allLabel="全部供应商"
              unit="个供应商"
              options={options.providers}
              value={filters.providerIds}
              onChange={(providerIds) =>
                setFilters((f) => ({ ...f, providerIds }))
              }
            />
          </Field>
          <div className="flex items-center gap-2">
            {filtering && (
              <Button variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
                清空筛选
              </Button>
            )}
            <Button type="submit" variant="primary">
              <Search className="size-3.5" />
              查询
            </Button>
            {usage.isFetching && !usage.isPending && (
              <Spinner className="mb-2" />
            )}
          </div>
        </div>
      </form>

      {devicesShown.length > 0 && (
        <Card className="overflow-x-auto">
          <h2 className="px-4 pt-4 text-sm font-medium">
            按设备（客户端上报）
          </h2>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>电脑</th>
                <th className={thClass}>用户</th>
                <th className={numTh}>请求</th>
                <th className={numTh}>输入</th>
                <th className={numTh}>输出</th>
                <th className={numTh}>费用</th>
              </tr>
            </thead>
            <tbody>
              {devicesShown.map((row) => (
                <tr key={row.deviceId} className={trClass}>
                  <td className={tdClass}>{row.deviceName}</td>
                  <td className={tdClass}>{row.usernames.join("、")}</td>
                  <td className={num}>{formatNumber(row.requests)}</td>
                  <td className={num}>{formatNumber(row.inputTokens)}</td>
                  <td className={num}>{formatNumber(row.outputTokens)}</td>
                  <td className={num}>${row.costUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {grand && (
        <Card>
          <div className="border-b border-border/50 pb-2.5 text-xs font-medium text-foreground">
            概览指标
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-left xl:grid-cols-4">
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
      <AccountStats />
      {usage.isPending ? (
        <Card>
          <LoadingState />
        </Card>
      ) : usage.isError ? (
        <Card>
          <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
        </Card>
      ) : rows.length === 0 && filtering && allRows.length > 0 ? (
        <Card>
          <EmptyState
            icon={<BarChart3 className="size-5 stroke-[1.5]" />}
            title="没有符合筛选条件的用量"
          >
            <Button variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
              清空筛选
            </Button>
          </EmptyState>
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
          {byUser.length > 0 && <UserTokenChart rows={byUser} />}
          <div className="grid gap-5 xl:grid-cols-2">
            <TotalsTable title="按用户汇总" keyLabel="用户" rows={byUser} />
            <TotalsTable title="按模型汇总" keyLabel="模型" rows={byModel} />
          </div>
          <DetailsTable rows={detailRows} />
        </div>
      )}
    </div>
  );
}

function AccountStats() {
  const client = useApi();
  const isAdmin = useSession().user.role === "admin";
  const [editing, setEditing] = useState(false);
  const accountCosts = useQuery({
    queryKey: ACCOUNT_COSTS_KEY,
    queryFn: ({ signal }) =>
      client.get(
        "/admin/usage/account-costs",
        UsageAccountCostsResponseSchema,
        signal,
      ),
    refetchInterval: 30_000,
  });
  const [period, setPeriod] = useState<"month" | "year">("month");

  if (accountCosts.isPending) {
    return (
      <Card>
        <h2 className="mb-3 text-sm font-medium">账户统计</h2>
        <LoadingState />
      </Card>
    );
  }
  if (accountCosts.isError) {
    return (
      <Card>
        <h2 className="mb-3 text-sm font-medium">账户统计</h2>
        <ErrorState
          error={accountCosts.error}
          onRetry={() => void accountCosts.refetch()}
        />
      </Card>
    );
  }

  const savedCosts = accountCosts.data.items;
  const multiplier = period === "year" ? 12 : 1;
  const costs = savedCosts
    .map((item) => ({
      name: item.department,
      monthlyUsd: item.monthlyUsd,
      amount: item.monthlyUsd * multiplier,
    }))
    .sort(
      (a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"),
    );
  const total = costs.reduce((sum, item) => sum + item.amount, 0);
  const maxAmount = Math.max(
    50,
    Math.ceil(Math.max(0, ...costs.map((item) => item.amount)) / 50) * 50,
  );
  const barScale = 80;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const formatUsd = (amount: number) =>
    `$${amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 pb-2.5">
          <div>
            <h2 className="text-sm font-medium">账户统计</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              按上游账号名称自动分组，根据套餐估算订阅费用（USD）
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-4">
            <div
              className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-0.5"
              role="group"
              aria-label="费用统计周期"
            >
              {(
                [
                  ["month", "按月"],
                  ["year", "按年"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={period === value}
                  onClick={() => setPeriod(value)}
                  className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                    period === value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="text-right">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {period === "month" ? "每月费用总计" : "每年费用总计"}
              </div>
              <div className="mt-1 text-2xl font-serif tabular-nums text-foreground">
                {formatUsd(total)}
              </div>
            </div>
          </div>
        </div>
        {(accountCosts.data.unpricedCount > 0 ||
          (isAdmin && accountCosts.data.manualAccounts.length > 0)) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground" role="status">
              {accountCosts.data.unpricedCount > 0
                ? `${accountCosts.data.unpricedCount} 个账号的套餐价格暂无法识别，总计仅包含已识别及手动补充的费用。`
                : "未识别套餐的费用已手动补充。"}
            </p>
            {isAdmin && accountCosts.data.manualAccounts.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3.5" />
                手动编辑
              </Button>
            )}
          </div>
        )}
        {!accountCosts.data.configured && (
          <p className="mt-3 text-sm text-muted-foreground">
            尚未连接上游账号。
          </p>
        )}
        {accountCosts.data.configured && costs.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            暂无可统计的上游账号。
          </p>
        )}
        {costs.length > 0 && (
          <div className="mt-4 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
            <div className="relative h-56 text-right text-[10px] tabular-nums text-muted-foreground">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2"
                  style={{ bottom: `${tick * barScale}%` }}
                >
                  {formatUsd(maxAmount * tick).replace(/\.00$/, "")}
                </span>
              ))}
            </div>
            <div className="relative h-56 border-b border-border/70">
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute inset-x-0 border-t border-dashed border-border/50"
                  style={{ bottom: `${tick * barScale}%` }}
                />
              ))}
              <div className="absolute inset-x-0 bottom-0 flex h-full items-end justify-around gap-3 px-2">
                {costs.map((item) => {
                  const height = (item.amount / maxAmount) * barScale;
                  return (
                    <div
                      key={item.name}
                      className="relative flex h-full min-w-0 flex-1 justify-center"
                      title={`${item.name}: ${formatUsd(item.amount)}`}
                    >
                      <span
                        className="absolute -translate-y-full whitespace-nowrap text-[11px] font-medium tabular-nums text-muted-foreground"
                        style={{ bottom: `${height}%` }}
                      >
                        {formatUsd(item.amount)}
                      </span>
                      <div
                        className="absolute bottom-0 w-8 max-w-[70%] rounded-t-md bg-brand transition-[height]"
                        style={{ height: `${height}%` }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            <div />
            <div className="flex justify-around gap-3 px-2 text-center text-xs text-muted-foreground">
              {costs.map((item) => (
                <div
                  key={item.name}
                  className="min-w-0 flex-1 truncate"
                  title={item.name}
                >
                  {item.name}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
      {editing && isAdmin && (
        <ManualAccountCostsDialog
          initial={accountCosts.data.manualAccounts}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

function ManualAccountCostsDialog({
  initial,
  onClose,
}: {
  initial: UsageAccountCostsResponse["manualAccounts"];
  onClose(): void;
}) {
  const client = useApi();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(() =>
    initial.map((account) =>
      account.monthlyUsd === null ? "" : String(account.monthlyUsd),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const items = initial.map((account, index) => ({
        accountId: account.accountId,
        platform: account.platform,
        planType: account.planType,
        monthlyUsd: values[index]?.trim() ? Number(values[index]) : null,
      }));
      if (
        items.some(
          (item) =>
            item.monthlyUsd !== null &&
            (!Number.isFinite(item.monthlyUsd) ||
              item.monthlyUsd < 0 ||
              item.monthlyUsd > 1_000_000),
        )
      )
        throw new Error("请填写有效的美元月费");
      await client.request("/admin/usage/account-costs/manual", {
        method: "PUT",
        body: { items },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_COSTS_KEY });
      onClose();
    },
    onError: (err) => setError(describeError(err)),
  });
  const close = () => {
    if (!save.isPending) onClose();
  };
  return (
    <Dialog
      open
      title="编辑未识别套餐费用"
      width="max-w-2xl"
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={save.isPending}>
            取消
          </Button>
          <Button
            type="submit"
            form="manual-account-costs"
            variant="primary"
            disabled={save.isPending}
          >
            {save.isPending && <Spinner className="size-3" />}保存费用
          </Button>
        </>
      }
    >
      <form
        id="manual-account-costs"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <p className="mb-4 text-xs text-muted-foreground">
          填写每个账号的美元月费；留空表示暂不计价。套餐变更后会重新识别费用。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {initial.map((account, index) => (
            <div
              key={`${account.platform}-${account.accountId}`}
              className="rounded-lg border border-border/60 p-3"
            >
              <div className="text-sm font-medium">{account.name}</div>
              <p className="mb-2 mt-1 text-xs text-muted-foreground">
                {account.department} · {account.planType || "未知套餐"}
              </p>
              <Field label="每月费用（USD）" htmlFor={`manual-cost-${index}`}>
                <input
                  id={`manual-cost-${index}`}
                  className={inputClass}
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.01"
                  placeholder="暂未定价"
                  value={values[index]}
                  disabled={save.isPending}
                  onChange={(event) => {
                    const value = event.target.value;
                    setValues((current) =>
                      current.map((entry, i) => (i === index ? value : entry)),
                    );
                  }}
                />
              </Field>
            </div>
          ))}
        </div>
        <InlineError>{error}</InlineError>
      </form>
    </Dialog>
  );
}

function DetailsTable({ rows }: { rows: UsageRow[] }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [rows]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
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
          {pageRows.map((r) => (
            <tr
              key={`${r.date}|${r.userId}|${r.providerId}|${r.model}`}
              className={trClass}
            >
              <td className={`${tdClass} whitespace-nowrap`}>{r.date}</td>
              <td className={tdClass}>{r.username}</td>
              <td className={`${tdClass} font-mono text-xs`}>{r.providerId}</td>
              <td className={`${tdClass} font-mono text-xs`}>{r.model}</td>
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
      <Pagination
        page={page}
        pageCount={pageCount}
        total={rows.length}
        onPageChange={setPage}
      />
    </Card>
  );
}

function UserTokenChart({ rows }: { rows: Totals[] }) {
  const data = rows.map((t) => ({
    key: t.key,
    name: typeof t.label === "string" ? t.label : t.key,
    input: t.inputTokens,
    output: t.outputTokens,
    total: t.inputTokens + t.outputTokens,
  }));
  const max = Math.max(...data.map((d) => d.total), 1);
  const formatCompactTokens = (value: number) => {
    const format = (scaled: number) => scaled.toFixed(2).replace(/\.?0+$/, "");
    if (value >= 1_000_000) return `${format(value / 1_000_000)}M`;
    if (value >= 1_000) return `${format(value / 1_000)}K`;
    return formatNumber(value);
  };

  return (
    <Card>
      <h2 className="border-b border-border/50 px-4 py-2.5 font-serif text-sm font-medium text-foreground">
        按用户 tokens
      </h2>
      <div className="flex items-center gap-4 px-4 pt-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-foreground/80" />
          输入
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-brand" />
          输出
        </span>
      </div>
      <div className="overflow-x-auto px-4 pb-4 pt-2">
        <div
          className="flex h-56 items-end gap-3"
          style={{ minWidth: `${Math.max(data.length * 56, 240)}px` }}
        >
          {data.map((d) => {
            const h = (d.total / max) * 100;
            const inPct = d.total ? (d.input / d.total) * 100 : 0;
            const outPct = 100 - inPct;
            return (
              <div
                key={d.key}
                className="flex h-full min-w-12 flex-1 flex-col items-center justify-end gap-1.5"
              >
                <span
                  className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
                  title={`${formatNumber(d.total)} tokens`}
                >
                  {formatCompactTokens(d.total)}
                </span>
                <div
                  className="flex w-8 flex-col-reverse overflow-hidden rounded-t-md"
                  style={{ height: `${d.total > 0 ? Math.max(h, 2) : 0}%` }}
                  title={`${d.name}：输入 ${formatNumber(d.input)}，输出 ${formatNumber(d.output)}`}
                >
                  <div
                    className="bg-foreground/80"
                    style={{ height: `${inPct}%` }}
                  />
                  <div className="bg-brand" style={{ height: `${outPct}%` }} />
                </div>
                <span className="max-w-16 truncate text-xs" title={d.name}>
                  {d.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
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
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [rows]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
          {pageRows.map((t) => (
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
      <Pagination
        page={page}
        pageCount={pageCount}
        total={rows.length}
        onPageChange={setPage}
      />
    </Card>
  );
}

function Pagination({
  page,
  pageCount,
  total,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/50 px-4 py-2.5 text-xs text-muted-foreground">
      <span>
        显示 {first}–{last} 条，共 {total} 条
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          aria-label="上一页"
        >
          上一页
        </button>
        <span className="tabular-nums">
          第 {page + 1} / {pageCount} 页
        </span>
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={page + 1 >= pageCount}
          onClick={() => onPageChange(page + 1)}
          aria-label="下一页"
        >
          下一页
        </button>
      </div>
    </div>
  );
}
