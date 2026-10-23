import {
  UsageAccountCostsResponseSchema,
  normalizeAccountCostDepartment,
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
  useId,
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
  Select,
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
      {(session.user.role === "admin" ||
        session.user.role === "leader" ||
        session.user.role === "group_leader") && <AccountStats />}
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
  const session = useSession();
  const isAdmin = session.user.role === "admin";
  const groupScoped = session.user.role === "group_leader";
  const [editing, setEditing] = useState(false);
  const [chartType, setChartType] = useState<"bar" | "line">("bar");
  const [period, setPeriod] = useState<"month" | "year">("month");
  const currentMonth = new Date()
    .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
    .slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [year, setYear] = useState(currentMonth.slice(0, 4));
  const [departmentSelection, setDepartment] = useState("");
  const department = groupScoped
    ? normalizeAccountCostDepartment(session.user.groupName || "未分配组")
    : departmentSelection;
  const trendView = !!department || chartType === "line";
  const requestPeriod = trendView ? "year" : period;
  const selectedPeriod = trendView
    ? period === "month"
      ? month.slice(0, 4)
      : currentMonth.slice(0, 4)
    : period === "month"
      ? month
      : year;
  const accountCosts = useQuery({
    queryKey: [
      ...ACCOUNT_COSTS_KEY,
      session.user.id,
      session.user.role,
      groupScoped ? department : null,
      requestPeriod,
      selectedPeriod,
    ],
    queryFn: ({ signal }) =>
      client.request("/admin/usage/account-costs", {
        query: { period: requestPeriod, value: selectedPeriod },
        schema: UsageAccountCostsResponseSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const data = accountCosts.data;
  const rows = (data?.items ?? [])
    .filter((item) => !department || item.department === department)
    .sort(
      (a, b) =>
        b.monthlyUsd - a.monthlyUsd ||
        a.department.localeCompare(b.department, "zh-CN"),
    );
  const history = data?.history ?? [];
  const accountColors = buildAccountColors(
    history.flatMap((snapshot) =>
      snapshot.items.flatMap((item) => item.accounts),
    ),
  );
  const timelineKeys =
    period === "month"
      ? Array.from(
          { length: 12 },
          (_, index) =>
            `${month.slice(0, 4)}-${String(index + 1).padStart(2, "0")}`,
        )
      : [
          ...new Set(history.map((snapshot) => snapshot.month.slice(0, 4))),
        ].sort();
  const buildTimeline = (name: string) =>
    timelineKeys.map((key) => {
      const snapshots = history.filter((snapshot) =>
        period === "month"
          ? snapshot.month === key
          : snapshot.month.startsWith(key + "-"),
      );
      const entries = snapshots.flatMap((snapshot) =>
        snapshot.items.filter((item) => item.department === name),
      );
      return {
        key,
        label: period === "month" ? `${Number(key.slice(5, 7))}月` : `${key}年`,
        recorded: entries.length > 0,
        accounts: mergeCostAccounts(entries.flatMap((item) => item.accounts)),
        future: period === "month" && key > currentMonth,
        monthlyUsd: entries.reduce((sum, item) => sum + item.monthlyUsd, 0),
        unpricedCount: entries.reduce(
          (sum, item) => sum + item.unpricedCount,
          0,
        ),
        accountCount: entries.reduce((sum, item) => sum + item.accountCount, 0),
        months: snapshots.length,
      };
    });
  const timeline = department ? buildTimeline(department) : [];
  const seriesNames = [
    ...new Set(
      history.flatMap((snapshot) =>
        snapshot.items.map((item) => item.department),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const lineColors = [
    "#d97706",
    "#2563eb",
    "#059669",
    "#9333ea",
    "#e11d48",
    "#0891b2",
  ];
  const multiSeries = seriesNames.map((name, index) => ({
    name,
    color: lineColors[index % lineColors.length]!,
    points: buildTimeline(name),
  }));
  const displayed = department
    ? timeline
    : chartType === "line"
      ? multiSeries.flatMap((series) => series.points)
      : rows;
  const total = displayed.reduce((sum, item) => sum + item.monthlyUsd, 0);
  const accounts = rows.reduce((sum, item) => sum + item.accountCount, 0);
  const unpriced = displayed.reduce((sum, item) => sum + item.unpricedCount, 0);
  const departments = [
    ...new Set([
      "运营部-EZARC",
      "运营部-LIBRATON",
      "运营部-YPLUS",
      "产品部",
      "技术部&独立站&TK",
      ...(data?.items ?? []).map((item) => item.department),
    ]),
  ];
  const chartMax = Math.max(
    50,
    Math.ceil(Math.max(0, ...displayed.map((item) => item.monthlyUsd)) / 50) *
      50,
  );
  const chartTicks = [0, 0.25, 0.5, 0.75, 1];
  const formatUsd = (value: number) =>
    `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const labelStyle = "flex flex-col text-[11px] text-muted-foreground";

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">账户统计</h2>
              {data?.demo && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
                  测试数据
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              部门续费支出概览 · 美元 USD
            </p>
          </div>
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-xs text-muted-foreground">
              {trendView
                ? period === "month"
                  ? "全年已记录费用："
                  : "历年费用总计："
                : period === "month"
                  ? "月度费用总计："
                  : "年度费用总计："}
            </span>
            <span className="text-3xl font-serif leading-none tabular-nums">
              {data ? formatUsd(total) : "—"}
            </span>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl bg-muted/35 p-3">
          <div className={labelStyle}>
            <div
              className="inline-flex h-9 items-center rounded-lg border border-border/70 p-0.5"
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
                  onClick={() => {
                    setPeriod(value);
                    if (value === "year") setYear(month.slice(0, 4));
                    else
                      setMonth(
                        `${year}-${month.slice(5, 7)}` > currentMonth
                          ? currentMonth
                          : `${year}-${month.slice(5, 7)}`,
                      );
                  }}
                  className={`h-full rounded-md px-3 text-xs transition-colors ${period === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div
            className="inline-flex h-9 items-center rounded-lg border border-border/70 p-0.5"
            role="group"
            aria-label="费用图表类型"
          >
            {(
              [
                ["bar", "柱状图"],
                ["line", "折线图"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={chartType === value}
                onClick={() => setChartType(value)}
                className={`h-full rounded-md px-3 text-xs transition-colors ${chartType === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {(!trendView || period === "month") && (
            <div className="w-28">
              <Select
                aria-label="费用年份"
                value={period === "month" ? month.slice(0, 4) : year}
                onChange={(value) => {
                  if (period === "year") setYear(value);
                  else {
                    const next = `${value}-${month.slice(5, 7)}`;
                    setMonth(next > currentMonth ? currentMonth : next);
                  }
                }}
                options={Array.from(
                  { length: Number(currentMonth.slice(0, 4)) - 1999 },
                  (_, index) => {
                    const value = String(
                      Number(currentMonth.slice(0, 4)) - index,
                    );
                    return { value, label: `${value} 年` };
                  },
                )}
              />
            </div>
          )}
          {period === "month" && !trendView && (
            <div className="w-24">
              <Select
                aria-label="费用月份"
                value={month.slice(5, 7)}
                onChange={(value) => setMonth(`${month.slice(0, 4)}-${value}`)}
                options={Array.from({ length: 12 }, (_, index) => {
                  const value = String(index + 1).padStart(2, "0");
                  return { value, label: `${index + 1} 月` };
                }).filter(
                  (option) =>
                    `${month.slice(0, 4)}-${option.value}` <= currentMonth,
                )}
              />
            </div>
          )}
          {groupScoped ? (
            <span
              className="rounded-lg border border-border bg-background px-3 py-2 text-xs"
              aria-label="所属费用部门"
            >
              {department}
            </span>
          ) : (
            <div className="w-48">
              <Select
                aria-label="费用部门"
                value={department}
                onChange={setDepartment}
                options={[
                  { value: "", label: "全部部门" },
                  ...departments.map((name) => ({ value: name, label: name })),
                ]}
              />
            </div>
          )}
          <div className="ml-auto text-xs text-muted-foreground">
            {department ? (
              `${department} · ${period === "month" ? month.slice(0, 4) + " 年月度趋势" : "历年费用趋势"}`
            ) : (
              <>
                {rows.length} 个部门
                {period === "month" && !trendView && <> · {accounts} 个账号</>}
              </>
            )}
          </div>
        </div>

        {accountCosts.isPending && (
          <div className="py-6">
            <LoadingState />
          </div>
        )}
        {accountCosts.isError && (
          <ErrorState
            error={accountCosts.error}
            onRetry={() => void accountCosts.refetch()}
          />
        )}
        {data && (
          <>
            <div
              className="mt-5 overflow-x-auto"
              aria-busy={accountCosts.isFetching}
            >
              {chartType === "line" && !department ? (
                <AccountCostsMultiLineChart
                  title={
                    period === "month"
                      ? `${month.slice(0, 4)} 年各部门月度订阅费用`
                      : "各部门历年订阅费用"
                  }
                  series={multiSeries}
                />
              ) : chartType === "line" ? (
                <AccountCostLineChart
                  title={
                    department
                      ? `${department} · ${period === "month" ? month.slice(0, 4) + " 年月度费用" : "历年费用"}`
                      : "各部门订阅费用对比"
                  }
                  timeSeries={!!department}
                  points={
                    department
                      ? timeline.map((item) => ({
                          key: item.key,
                          label: item.label,
                          amount:
                            item.recorded && item.monthlyUsd > 0
                              ? item.monthlyUsd
                              : null,
                          note: !item.recorded
                            ? item.future
                              ? "尚未到期"
                              : "无记录"
                            : item.unpricedCount
                              ? `${item.unpricedCount} 项费用待补充`
                              : item.monthlyUsd === 0
                                ? "无支出"
                                : period === "month"
                                  ? `${item.accountCount} 个账号`
                                  : `已记录 ${item.months} 个月`,
                          pending: item.unpricedCount > 0,
                        }))
                      : rows.map((item) => ({
                          key: item.department,
                          label: item.department,
                          amount: item.monthlyUsd,
                          note:
                            period === "month"
                              ? `${item.accountCount} 个账号`
                              : "年度已记录费用",
                          pending: item.unpricedCount > 0,
                        }))
                  }
                />
              ) : department ? (
                timeline.length > 0 ? (
                  <div
                    className="min-w-[36rem] pb-3"
                    role="group"
                    aria-label="部门订阅费用趋势图"
                  >
                    <p className="mb-6 text-[11px] text-muted-foreground">
                      {period === "month" ? "全年各月订阅费用" : "历年订阅费用"}{" "}
                      · USD · 缺失记录不补算
                    </p>
                    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3">
                      <div className="relative h-56 text-[10px] tabular-nums text-muted-foreground">
                        {chartTicks.map((tick) => (
                          <span
                            key={tick}
                            className="absolute right-0 translate-y-1/2"
                            style={{ bottom: `${tick * 80}%` }}
                          >
                            {formatUsd(chartMax * tick).replace(/\.00$/, "")}
                          </span>
                        ))}
                      </div>
                      <div className="relative flex h-56 items-end gap-2 border-b border-border px-2">
                        {chartTicks.map((tick) => (
                          <div
                            key={tick}
                            className="absolute inset-x-0 border-t border-dashed border-border/60"
                            style={{ bottom: `${tick * 80}%` }}
                          />
                        ))}
                        {timeline.map((item) => (
                          <div
                            key={item.key}
                            className="relative h-full min-w-0 flex-1"
                            title={`${item.label}：${item.recorded ? formatUsd(item.monthlyUsd) : item.future ? "尚未到期" : "无记录"}`}
                          >
                            <span
                              className="absolute left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap pb-2 text-[10px] tabular-nums text-muted-foreground"
                              style={{
                                bottom: `${(item.monthlyUsd / chartMax) * 80}%`,
                              }}
                            >
                              {item.recorded ? formatUsd(item.monthlyUsd) : "—"}
                            </span>
                            {item.recorded && (
                              <div
                                className="absolute bottom-0 left-1/2 w-7 max-w-[80%] -translate-x-1/2"
                                style={{
                                  height: `${(item.monthlyUsd / chartMax) * 80}%`,
                                }}
                              >
                                <AccountCostStack
                                  accounts={item.accounts}
                                  total={item.monthlyUsd}
                                  colors={accountColors}
                                  vertical
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <div />
                      <div className="flex gap-2 px-2 text-center text-[10px] text-muted-foreground">
                        {timeline.map((item) => (
                          <div key={item.key} className="min-w-0 flex-1">
                            <span className="text-foreground">
                              {item.label}
                            </span>
                            <div className="mt-1">
                              {item.recorded
                                ? item.unpricedCount > 0
                                  ? "待补价"
                                  : period === "month"
                                    ? `${item.accountCount} 个账号`
                                    : `已记录 ${item.months} 月`
                                : item.future
                                  ? "尚未到期"
                                  : "无记录"}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    暂无年度费用记录。
                  </p>
                )
              ) : rows.length > 0 ? (
                <div
                  className="min-w-[28rem] py-2"
                  role="group"
                  aria-label="订阅费用条形图"
                >
                  <div className="mb-3 flex justify-between text-[11px] text-muted-foreground">
                    <span>
                      {department
                        ? `${department} · ${period === "month" ? month.slice(0, 4) + " 年" : "年度费用"}`
                        : "部门费用对比"}
                    </span>
                    <span>费用 / 占比</span>
                  </div>
                  {rows.map((item) => {
                    const label = department
                      ? period === "month"
                        ? `${Number(month.slice(5, 7))}月`
                        : `${year}年`
                      : item.department;
                    return (
                      <div
                        key={item.department}
                        className="grid grid-cols-[8rem_minmax(0,1fr)_5.5rem] items-center gap-3"
                        aria-label={`${label}：${formatUsd(item.monthlyUsd)}`}
                      >
                        <div className="py-4">
                          <div
                            className="truncate text-xs font-medium"
                            title={item.department}
                          >
                            {label}
                          </div>
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            {period === "month" &&
                              `${item.accountCount} 个账号`}
                            {item.unpricedCount > 0 && (
                              <span className="ml-1 text-amber-700">
                                · {item.unpricedCount} 项待补充
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="relative flex h-full min-h-16 items-center">
                          {chartTicks.map((tick) => (
                            <div
                              key={tick}
                              className="absolute inset-y-0 border-l border-dashed border-border/60"
                              style={{ left: `${tick * 100}%` }}
                            />
                          ))}
                          <div
                            className="relative h-7 transition-[width] duration-300"
                            style={{
                              width: `${(item.monthlyUsd / chartMax) * 100}%`,
                            }}
                          >
                            <AccountCostStack
                              accounts={item.accounts}
                              total={item.monthlyUsd}
                              colors={accountColors}
                            />
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium tabular-nums">
                            {formatUsd(item.monthlyUsd)}
                          </div>
                          <div className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                            {total > 0
                              ? `${((item.monthlyUsd / total) * 100).toFixed(1)}%`
                              : "—"}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div className="grid grid-cols-[8rem_minmax(0,1fr)_5.5rem] gap-3 pb-3">
                    <div />
                    <div className="relative h-6 border-t border-border">
                      {chartTicks.map((tick) => (
                        <span
                          key={tick}
                          className="absolute top-2 -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground"
                          style={{ left: `${tick * 100}%` }}
                        >
                          {formatUsd(chartMax * tick).replace(/\.00$/, "")}
                        </span>
                      ))}
                    </div>
                    <span className="pt-2 text-right text-[10px] text-muted-foreground">
                      USD
                    </span>
                  </div>
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  所选期间或部门暂无费用记录。
                </p>
              )}
            </div>
            {isAdmin && (
              <>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
                  <p className="text-[11px] text-muted-foreground">
                    {trendView
                      ? period === "month"
                        ? `${month.slice(0, 4)} 年 · 已记录 ${(department ? timeline : (multiSeries[0]?.points ?? [])).filter((item, index) => (department ? item.recorded : multiSeries.some((series) => series.points[index]?.recorded))).length} 个月；缺失月份不补算`
                        : `共 ${(department ? timeline : (multiSeries[0]?.points ?? [])).length} 年记录；各年费用仅汇总已记录月份`
                      : period === "month"
                        ? `${month} · ${month === currentMonth ? "续费费用按订阅周期入账，停用或删除账号不扣减" : "历史月度记录"}`
                        : `${year} 年 · 已记录 ${data.recordedMonths.length} 个月；未记录月份不补算`}
                  </p>
                  {isAdmin && data.manualAccounts.length > 0 && (
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
                {unpriced > 0 && (
                  <p className="mt-2 text-[11px] text-amber-700" role="status">
                    {unpriced} 项套餐费用待补充，总计仅包含已计价费用。
                  </p>
                )}
                {unpriced === 0 && data.manualAccounts.length > 0 && (
                  <p
                    className="mt-2 text-[11px] text-muted-foreground"
                    role="status"
                  >
                    未识别套餐的费用已手动补充。
                  </p>
                )}
                {data.pendingDateCount > 0 && (
                  <p className="mt-2 text-[11px] text-amber-700">
                    {data.pendingDateCount}{" "}
                    个订阅缺少真实套餐到期时间，暂未归入月份；可通过手动编辑确认入账月份。
                  </p>
                )}
                {data.legacySnapshotCount > 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    旧版月度快照已保留供核对，不与续费记录重复累计。
                  </p>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  月付套餐按真实订阅到期时间前推一个月估算续费月份；已入账记录保留，重复同步不重复计费。
                </p>
                {data.demo && (
                  <p className="mt-2 text-[11px] text-amber-700">
                    本机模拟账号，未连接上游服务；测试月度记录单独保存。
                  </p>
                )}
              </>
            )}
          </>
        )}
      </Card>
      {editing && isAdmin && data && (
        <ManualAccountCostsDialog
          initial={data.manualAccounts}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

type CostAccount =
  UsageAccountCostsResponse["items"][number]["accounts"][number];
function mergeCostAccounts(accounts: CostAccount[]): CostAccount[] {
  const result = new Map<string, CostAccount>();
  for (const account of accounts) {
    const key = `${account.platform}:${account.accountId}`;
    const previous = result.get(key);
    result.set(
      key,
      previous
        ? {
            ...previous,
            monthlyUsd: previous.monthlyUsd + account.monthlyUsd,
            unpricedCount: previous.unpricedCount + account.unpricedCount,
          }
        : { ...account },
    );
  }
  return [...result.values()].sort(
    (a, b) =>
      b.monthlyUsd - a.monthlyUsd || a.name.localeCompare(b.name, "zh-CN"),
  );
}
function accountIdentity(account: CostAccount): string {
  return `${account.platform}:${account.accountId}`;
}
function buildAccountColors(accounts: CostAccount[]): Map<string, string> {
  const palette = [
    "#d97706",
    "#2563eb",
    "#059669",
    "#9333ea",
    "#e11d48",
    "#0891b2",
    "#64748b",
    "#4f46e5",
    "#a16207",
    "#0f766e",
    "#be185d",
    "#7c3aed",
  ];
  const identities = [...new Set(accounts.map(accountIdentity))].sort();
  return new Map(
    identities.map((key, index) => [
      key,
      palette[index] ??
        `hsl(${(index * 137.508) % 360} 65% ${35 + (Math.floor(index / 12) % 3) * 8}%)`,
    ]),
  );
}
function AccountCostStack({
  accounts,
  total,
  colors,
  vertical = false,
}: {
  accounts: CostAccount[];
  total: number;
  colors: Map<string, string>;
  vertical?: boolean;
}) {
  const [selected, setSelected] = useState<CostAccount | null>(null);
  const paid = accounts.filter((account) => account.monthlyUsd > 0);
  return (
    <div
      className={`relative flex size-full ${vertical ? "flex-col-reverse" : ""}`}
      onMouseLeave={() => setSelected(null)}
    >
      {paid.length ? (
        paid.map((account) => {
          const share = total > 0 ? (account.monthlyUsd / total) * 100 : 0;
          const text = `${account.name}：$${account.monthlyUsd.toFixed(2)}`;
          return (
            <button
              key={`${account.platform}:${account.accountId}`}
              type="button"
              aria-label={text}
              title={text}
              data-account-segment={account.name}
              style={{
                [vertical ? "height" : "width"]: `${share}%`,
                backgroundColor: colors.get(accountIdentity(account)),
              }}
              className={`shrink-0 border-white/30 text-[10px] text-white outline-none focus-visible:ring-2 focus-visible:ring-ring ${vertical ? "w-full border-t first:rounded-b-sm last:rounded-t-md" : "h-full border-r last:rounded-r-md"}`}
              onMouseEnter={() => setSelected(account)}
              onFocus={() => setSelected(account)}
              onBlur={() => setSelected(null)}
              onClick={() =>
                setSelected((current) => (current === account ? null : account))
              }
            >
              {!vertical && share >= 15
                ? `$${account.monthlyUsd.toFixed(2)}`
                : null}
            </button>
          );
        })
      ) : (
        <div className="size-full rounded-r-md bg-brand" />
      )}
      {selected && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-max max-w-72 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
        >
          {selected.name} · ${selected.monthlyUsd.toFixed(2)}
        </div>
      )}
    </div>
  );
}

type AccountCostTimePoint = {
  key: string;
  label: string;
  recorded: boolean;
  future: boolean;
  monthlyUsd: number;
  unpricedCount: number;
};

function AccountCostsMultiLineChart({
  title,
  series,
}: {
  title: string;
  series: { name: string; color: string; points: AccountCostTimePoint[] }[];
}) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ key: string; cents: number } | null>(
    null,
  );
  const points = series[0]?.points ?? [];
  const visible = series.filter((item) => !hidden.includes(item.name));
  const active =
    points.find((point) => point.key === activeKey) ??
    points
      .filter((_, index) =>
        visible.some((item) => item.points[index]?.recorded),
      )
      .at(-1) ??
    points[0];
  const details = visible
    .map((item) => ({
      ...item,
      point: item.points.find((point) => point.key === active?.key),
    }))
    .sort(
      (a, b) =>
        (b.point?.recorded ? b.point.monthlyUsd : -Infinity) -
          (a.point?.recorded ? a.point.monthlyUsd : -Infinity) ||
        a.name.localeCompare(b.name, "zh-CN"),
    );
  const width = Math.max(760, points.length * 76);
  const left = 64,
    right = width - 38,
    top = 28,
    bottom = 226;
  const maximum = Math.max(
    50,
    Math.ceil(
      Math.max(
        0,
        ...series.flatMap((item) =>
          item.points.map((point) => point.monthlyUsd),
        ),
      ) / 50,
    ) * 50,
  );
  const x = (index: number) =>
    points.length === 1
      ? (left + right) / 2
      : left + (index * (right - left)) / Math.max(1, points.length - 1);
  const y = (value: number) => bottom - (value / maximum) * (bottom - top);
  const usd = (value: number) =>
    `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const segments = (values: AccountCostTimePoint[]) => {
    const result: number[][] = [];
    values.forEach((point, index) => {
      if (!point.recorded || point.monthlyUsd <= 0) return;
      if (
        !index ||
        !values[index - 1]?.recorded ||
        values[index - 1]!.monthlyUsd <= 0
      )
        result.push([]);
      result.at(-1)!.push(index);
    });
    return result.filter((segment) => segment.length > 1);
  };
  const selectAtX = (clientX: number, clientY: number, rect: DOMRect) => {
    if (!rect.width || !points.length) return;
    const position = ((clientX - rect.left) / rect.width) * width;
    const index =
      points.length === 1
        ? 0
        : Math.max(
            0,
            Math.min(
              points.length - 1,
              Math.round(
                ((position - left) / (right - left)) * (points.length - 1),
              ),
            ),
          );
    const period = points[index]!;
    setActiveKey(period.key);
    if (!rect.height) {
      setHovered(null);
      return;
    }
    const distanceX = (Math.abs(x(index) - position) / width) * rect.width;
    const svgY = ((clientY - rect.top) / rect.height) * 282;
    const candidates = visible
      .map((item) => item.points[index])
      .filter(
        (point): point is AccountCostTimePoint =>
          !!point?.recorded && point.monthlyUsd > 0,
      )
      .sort(
        (a, b) =>
          Math.abs(y(a.monthlyUsd) - svgY) - Math.abs(y(b.monthlyUsd) - svgY),
      );
    const nearest = candidates[0];
    if (
      nearest &&
      distanceX <= 16 &&
      (Math.abs(y(nearest.monthlyUsd) - svgY) / 282) * rect.height <= 16
    )
      setHovered({
        key: period.key,
        cents: Math.round(nearest.monthlyUsd * 100),
      });
    else setHovered(null);
  };
  const hoverDetails = hovered
    ? visible
        .flatMap((item) => {
          const point = item.points.find((point) => point.key === hovered.key);
          return point?.recorded &&
            Math.round(point.monthlyUsd * 100) === hovered.cents
            ? [{ ...item, point }]
            : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    : [];
  const hoverIndex = points.findIndex((point) => point.key === hovered?.key);
  const tooltipHeight = 46 + hoverDetails.length * 23;
  const tooltipX =
    hoverIndex >= 0
      ? Math.max(
          8,
          x(hoverIndex) + 280 > width
            ? x(hoverIndex) - 278
            : x(hoverIndex) + 14,
        )
      : 0;
  const tooltipY = hoverDetails[0]
    ? Math.max(
        4,
        Math.min(
          282 - tooltipHeight - 4,
          y(hoverDetails[0].point.monthlyUsd) - tooltipHeight - 12,
        ),
      )
    : 0;
  if (!points.length)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        暂无可对比的部门费用记录。
      </p>
    );
  return (
    <div role="group" aria-label="全部部门费用趋势图" className="pb-2">
      <h3 className="text-xs font-medium">{title}</h3>
      <p className="mt-1 text-[11px] text-muted-foreground">
        每个部门独立曲线 · 仅绘制有支出的节点 · USD
      </p>
      <div
        className="my-4 flex flex-wrap gap-2"
        role="group"
        aria-label="部门曲线图例"
      >
        {series.map((item) => (
          <button
            key={item.name}
            type="button"
            aria-pressed={!hidden.includes(item.name)}
            onClick={() =>
              setHidden((current) =>
                current.includes(item.name)
                  ? current.filter((name) => name !== item.name)
                  : [...current, item.name],
              )
            }
            className={`flex items-center gap-2 rounded-full border border-border px-2.5 py-1 text-[11px] transition-opacity ${hidden.includes(item.name) ? "opacity-40" : ""}`}
          >
            <span
              className="h-0.5 w-4"
              style={{ backgroundColor: item.color }}
            />
            {item.name}
          </button>
        ))}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0 overflow-x-auto">
          <svg
            viewBox={`0 0 ${width} 282`}
            className="w-full"
            style={{ minWidth: Math.max(640, points.length * 58) }}
            role="group"
            aria-label="各部门按时间排列的费用曲线"
            onMouseLeave={() => setHovered(null)}
            onMouseMove={(event) =>
              selectAtX(
                event.clientX,
                event.clientY,
                event.currentTarget.getBoundingClientRect(),
              )
            }
            onClick={(event) =>
              selectAtX(
                event.clientX,
                event.clientY,
                event.currentTarget.getBoundingClientRect(),
              )
            }
          >
            {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
              <g key={tick}>
                <line
                  x1={left}
                  x2={right}
                  y1={y(maximum * tick)}
                  y2={y(maximum * tick)}
                  className="stroke-border"
                  strokeDasharray="3 5"
                />
                <text
                  x={left - 12}
                  y={y(maximum * tick) + 4}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px]"
                >
                  {usd(maximum * tick).replace(/\.00$/, "")}
                </text>
              </g>
            ))}
            {points.map((point, index) => (
              <g key={point.key}>
                {active?.key === point.key && (
                  <line
                    x1={x(index)}
                    x2={x(index)}
                    y1={top}
                    y2={bottom}
                    className="stroke-muted-foreground"
                    strokeOpacity="0.4"
                    strokeDasharray="3 4"
                    pointerEvents="none"
                  />
                )}
                <text
                  x={x(index)}
                  y={bottom + 28}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {point.label}
                </text>
                {!visible.some((item) => item.points[index]?.recorded) && (
                  <text
                    x={x(index)}
                    y={bottom - 10}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {point.future ? "尚未到期" : "无记录"}
                  </text>
                )}
              </g>
            ))}
            {visible.map((item, index) => (
              <g
                key={item.name}
                data-series={item.name}
                style={{ color: item.color }}
              >
                {segments(item.points).map((segment) => (
                  <path
                    key={segment[0]}
                    d={segment
                      .map(
                        (index, offset) =>
                          `${offset ? "L" : "M"} ${x(index)} ${y(item.points[index]!.monthlyUsd)}`,
                      )
                      .join(" ")}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeDasharray={
                      index % 3 === 1
                        ? "7 3"
                        : index % 3 === 2
                          ? "2 3"
                          : undefined
                    }
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                ))}
              </g>
            ))}
            {points.flatMap((period, index) => {
              const groups = new Map<
                number,
                { color: string; names: string[]; value: number }
              >();
              for (const item of visible) {
                const point = item.points[index];
                if (!point?.recorded || point.monthlyUsd <= 0) continue;
                const cents = Math.round(point.monthlyUsd * 100);
                const group = groups.get(cents) ?? {
                  color: item.color,
                  names: [],
                  value: point.monthlyUsd,
                };
                group.names.push(item.name);
                groups.set(cents, group);
              }
              return [...groups].map(([cents, group]) => (
                <circle
                  key={`${period.key}-${cents}`}
                  data-cost-marker={group.names.join("、")}
                  data-period={period.key}
                  cx={x(index)}
                  cy={y(group.value)}
                  r="4"
                  className="fill-background"
                  stroke={group.names.length > 1 ? "#71717a" : group.color}
                  strokeWidth="2"
                  pointerEvents="none"
                />
              ));
            })}
            {points.map((point, index) => {
              const start = index === 0 ? left : (x(index - 1) + x(index)) / 2;
              const end =
                index === points.length - 1
                  ? right
                  : (x(index) + x(index + 1)) / 2;
              return (
                <rect
                  key={point.key}
                  x={start}
                  y={top}
                  width={end - start}
                  height={bottom - top + 38}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${point.label}，查看所有部门费用`}
                  className="cursor-default outline-none focus-visible:stroke-border"
                  onMouseEnter={() => setActiveKey(point.key)}
                  onFocus={() => setActiveKey(point.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setActiveKey(point.key);
                    }
                  }}
                />
              );
            })}
            {hoverDetails.length > 0 && (
              <foreignObject
                x={tooltipX}
                y={tooltipY}
                width="264"
                height={tooltipHeight}
                pointerEvents="none"
                className="pointer-events-none"
              >
                <div
                  role="tooltip"
                  className="h-full rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg"
                >
                  <p className="mb-1 text-[11px] font-medium">
                    {hoverDetails[0]!.point.label}
                    {hoverDetails.length > 1
                      ? ` · ${hoverDetails.length} 个同额部门`
                      : ""}
                  </p>
                  {hoverDetails.map((item) => (
                    <div
                      key={item.name}
                      className="flex h-[23px] items-center justify-between gap-3 text-[11px]"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="truncate">{item.name}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {usd(item.point.monthlyUsd)}
                        {item.point.unpricedCount ? " *" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </foreignObject>
            )}
          </svg>
        </div>
        <aside
          className="h-64 overflow-y-auto rounded-xl border border-border/50 bg-muted/25 p-3"
          role="group"
          aria-label="当期部门费用明细"
          aria-live="polite"
        >
          <div className="mb-2 flex h-6 items-center justify-between">
            <span className="text-xs font-medium">
              {active?.label ?? "当期费用"}
            </span>
            <span className="text-[10px] text-muted-foreground">
              按费用排序
            </span>
          </div>
          {details.map((item) => {
            const point = item.point;
            const same =
              point?.recorded &&
              point.monthlyUsd > 0 &&
              details.filter(
                (other) =>
                  other.point?.recorded &&
                  Math.round(other.point.monthlyUsd * 100) ===
                    Math.round(point.monthlyUsd * 100),
              ).length > 1;
            return (
              <div
                key={item.name}
                data-cost-detail={item.name}
                className="flex h-8 items-center justify-between gap-2 text-[11px]"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="truncate" title={item.name}>
                    {item.name}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 tabular-nums">
                  {same && (
                    <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                      同额
                    </span>
                  )}
                  {point?.recorded
                    ? point.monthlyUsd > 0 || !point.unpricedCount
                      ? usd(point.monthlyUsd)
                      : "待补价"
                    : "无记录"}
                  {point?.unpricedCount ? " *" : ""}
                </span>
              </div>
            );
          })}
          {!details.length && (
            <p className="text-xs text-muted-foreground">
              点击图例可恢复部门曲线。
            </p>
          )}
        </aside>
      </div>
      <p className="mt-3 text-[10px] text-muted-foreground">
        移动到月份或年份区域，即可查看当期所有部门费用；同额部门共用一个点，明细分别列出。*
        表示费用待补充。
      </p>
    </div>
  );
}

type AccountCostLinePoint = {
  key: string;
  label: string;
  amount: number | null;
  note: string;
  pending: boolean;
};

function AccountCostLineChart({
  title,
  points,
  timeSeries,
}: {
  title: string;
  points: AccountCostLinePoint[];
  timeSeries: boolean;
}) {
  const gradientId = useId();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const known = points.filter((point) => point.amount !== null);
  const active =
    points.find((point) => point.key === activeKey) ??
    (timeSeries ? known.at(-1) : known[0]);
  const width = Math.max(760, points.length * 76);
  const height = 280;
  const left = 64,
    right = width - 38,
    top = 34,
    bottom = 226;
  const maximum = Math.max(
    50,
    Math.ceil(Math.max(0, ...known.map((point) => point.amount!)) / 50) * 50,
  );
  const x = (index: number) =>
    points.length === 1
      ? (left + right) / 2
      : left + (index * (right - left)) / Math.max(1, points.length - 1);
  const y = (amount: number) => bottom - (amount / maximum) * (bottom - top);
  const usd = (amount: number) =>
    `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const segments: number[][] = [];
  points.forEach((point, index) => {
    if (point.amount === null) return;
    if (index === 0 || points[index - 1]?.amount === null) segments.push([]);
    segments.at(-1)!.push(index);
  });
  const line = (segment: number[]) =>
    segment
      .map(
        (index, offset) =>
          `${offset ? "L" : "M"} ${x(index)} ${y(points[index]!.amount!)}`,
      )
      .join(" ");

  if (!points.length)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        所选期间或部门暂无费用记录。
      </p>
    );
  return (
    <div role="group" aria-label="订阅费用折线图" className="pb-2">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium">{title}</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {timeSeries
              ? "按时间顺序展示 · 缺失记录保留断点"
              : "按费用从高到低排列 · 横轴为部门"}{" "}
            · USD
          </p>
        </div>
        <div
          className="rounded-lg bg-muted/40 px-3 py-2 text-right"
          aria-live="polite"
        >
          <div className="text-[11px] text-muted-foreground">
            {active?.label ?? "暂无费用记录"}
          </div>
          <div className="mt-1 text-lg font-medium tabular-nums">
            {active?.amount !== null && active?.amount !== undefined
              ? usd(active.amount)
              : "—"}
          </div>
          {active && (
            <div className="mt-1 text-[10px] text-muted-foreground">
              {active.note}
              {active.pending ? " · 金额尚不完整" : ""}
            </div>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full min-w-[40rem] text-brand"
          style={{ minWidth: Math.max(640, points.length * 58) }}
          role="img"
          aria-label={`${title}，金额单位美元`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={right}
                y1={y(maximum * tick)}
                y2={y(maximum * tick)}
                className="stroke-border"
                strokeDasharray="3 5"
              />
              <text
                x={left - 12}
                y={y(maximum * tick) + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {usd(maximum * tick).replace(/\.00$/, "")}
              </text>
            </g>
          ))}
          {segments
            .filter((segment) => segment.length > 1)
            .map((segment) => (
              <g key={segment[0]}>
                <path
                  d={`${line(segment)} L ${x(segment.at(-1)!)} ${bottom} L ${x(segment[0]!)} ${bottom} Z`}
                  fill={`url(#${gradientId})`}
                />
                <path
                  d={line(segment)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            ))}
          {points.map((point, index) => (
            <g key={point.key}>
              <text
                x={x(index)}
                y={bottom + 27}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {point.label}
              </text>
              {point.amount === null ? (
                <text
                  x={x(index)}
                  y={bottom - 10}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {point.note}
                </text>
              ) : (
                <g>
                  {active?.key === point.key && (
                    <line
                      x1={x(index)}
                      x2={x(index)}
                      y1={top}
                      y2={bottom}
                      stroke="currentColor"
                      strokeOpacity="0.25"
                      strokeDasharray="3 4"
                    />
                  )}
                  <circle
                    cx={x(index)}
                    cy={y(point.amount)}
                    r={active?.key === point.key ? 6 : 4}
                    className={
                      point.pending
                        ? "fill-amber-400 stroke-amber-500"
                        : "fill-background"
                    }
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <circle
                    cx={x(index)}
                    cy={y(point.amount)}
                    r="16"
                    fill="transparent"
                    tabIndex={0}
                    role="button"
                    aria-label={`${point.label}：${usd(point.amount)}，${point.note}`}
                    className="cursor-pointer outline-none focus:stroke-brand focus:stroke-1"
                    onMouseEnter={() => setActiveKey(point.key)}
                    onFocus={() => setActiveKey(point.key)}
                    onClick={() => setActiveKey(point.key)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setActiveKey(point.key);
                      }
                    }}
                  >
                    <title>
                      {point.label}：{usd(point.amount)} · {point.note}
                    </title>
                  </circle>
                </g>
              )}
            </g>
          ))}
        </svg>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        悬停、点击或用 Tab 选中数据点查看费用
        {known.length === 1 ? " · 当前仅有一个已记录数据点" : ""}
        {points.some((point) => point.pending)
          ? " · 黄色节点表示费用待补充"
          : ""}
      </p>
    </div>
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
  const [billingMonths, setBillingMonths] = useState(() =>
    initial.map((account) => account.billingMonth ?? ""),
  );
  const current = new Date()
    .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
    .slice(0, 7);
  const monthOptions = Array.from({ length: 120 }, (_, index) => {
    const date = new Date(
      Date.UTC(
        Number(current.slice(0, 4)),
        Number(current.slice(5, 7)) - 1 - index,
        15,
      ),
    );
    const value = date.toISOString().slice(0, 7);
    return {
      value,
      label: `${value.slice(0, 4)}年${Number(value.slice(5, 7))}月`,
    };
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const items = initial.map((account, index) => ({
        accountId: account.accountId,
        platform: account.platform,
        planType: account.planType,
        monthlyUsd: values[index]?.trim() ? Number(values[index]) : null,
        billingMonth: billingMonths[index] || null,
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
      title={
        initial.some((account) => account.needsBillingMonth)
          ? "补充订阅计费信息"
          : "编辑未识别套餐费用"
      }
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
          补充待确认记录的费用或入账月份。已入账金额保留；本次填写的月费用于补充未计价记录及后续续费周期。
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
                  readOnly={
                    account.automaticPricing || account.monthlyUsd !== null
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    setValues((current) =>
                      current.map((entry, i) => (i === index ? value : entry)),
                    );
                  }}
                />
              </Field>
              {account.needsBillingMonth && (
                <div className="mt-3">
                  <Field
                    label="确认入账月份"
                    htmlFor={`billing-month-${index}`}
                  >
                    <Select
                      id={`billing-month-${index}`}
                      aria-label={`${account.name} 入账月份`}
                      value={billingMonths[index] ?? ""}
                      onChange={(value) =>
                        setBillingMonths((current) =>
                          current.map((entry, i) =>
                            i === index ? value : entry,
                          ),
                        )
                      }
                      options={[
                        { value: "", label: "待确认，暂不归账" },
                        ...monthOptions,
                      ]}
                      disabled={save.isPending}
                    />
                  </Field>
                </div>
              )}
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
