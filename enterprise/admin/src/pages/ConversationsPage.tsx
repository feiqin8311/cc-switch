import {
  ConversationDetailResponseSchema,
  type ConversationSummary,
  ListConversationsResponseSchema,
  type RetainedMessage,
} from "@ccse/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  MessageSquareText,
  RotateCcw,
  Search,
  User,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  Badge,
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
import { useApi, useCan } from "../lib/auth";
import {
  daySpan,
  describeError,
  formatDateTime,
  formatNumber,
} from "../lib/format";
import { useUsers } from "./UsersPage";

const PAGE_SIZE = 50;

interface Filters {
  userId: string;
  q: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { userId: "", q: "", from: "", to: "" };

export function ConversationsPage({ embedded }: { embedded?: boolean } = {}) {
  const client = useApi();
  const canListUsers = useCan("users.manage");
  const users = useUsers(canListUsers);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: ["admin", "conversations", filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      client.request("/admin/conversations", {
        query: {
          userId: filters.userId,
          q: filters.q.trim(),
          from: filters.from,
          to: filters.to,
          cursor: pageParam ?? undefined,
          limit: PAGE_SIZE,
        },
        schema: ListConversationsResponseSchema,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = useMemo(
    () => list.data?.pages.flatMap((p) => p.items) ?? [],
    [list.data],
  );

  const apply = (next: Filters) => {
    if (next.from && next.to && daySpan(next.from, next.to) < 1) {
      setFilterError("开始日期不能晚于结束日期");
      return;
    }
    setFilterError(null);
    setDraft(next);
    setFilters(next);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    apply(draft);
  };

  const filterByUser = (c: ConversationSummary) =>
    apply({ ...filters, userId: c.user.id });

  const filteredUser =
    filters.userId &&
    (users.data?.items.find((u) => u.id === filters.userId)?.username ??
      items.find((c) => c.user.id === filters.userId)?.user.username ??
      filters.userId);

  return (
    <div className="space-y-6">
      <PageHeader
        embedded={embedded}
        title="对话记录"
        description="查看员工确认留存告知后上传的 Codex 对话，按最近消息时间倒序。"
      />

      {/* Filter toolbar */}
      <form
        onSubmit={onSubmit}
        noValidate
        className="rounded-2xl border border-border/80 bg-card p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-end gap-3">
          {canListUsers ? (
            <Field label="用户" htmlFor="conv-user">
              <select
                id="conv-user"
                className={`${inputClass} w-48`}
                value={draft.userId}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, userId: e.target.value }))
                }
              >
                <option value="">全部用户</option>
                {users.data?.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}（{u.username}）
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            filters.userId && (
              <div className="flex h-9 items-center gap-1.5 text-sm">
                <span className="text-xs text-muted-foreground">用户：</span>
                <Badge tone="blue">{filteredUser}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => apply({ ...filters, userId: "" })}
                >
                  清除
                </Button>
              </div>
            )
          )}
          <Field label="关键词" htmlFor="conv-q">
            <input
              id="conv-q"
              className={`${inputClass} w-60`}
              placeholder="标题或消息内容"
              maxLength={200}
              value={draft.q}
              onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
            />
          </Field>
          <Field label="开始日期（UTC）" htmlFor="conv-from">
            <input
              id="conv-from"
              type="date"
              className={`${inputClass} w-40`}
              value={draft.from}
              onChange={(e) =>
                setDraft((d) => ({ ...d, from: e.target.value }))
              }
            />
          </Field>
          <Field label="结束日期（UTC）" htmlFor="conv-to">
            <input
              id="conv-to"
              type="date"
              className={`${inputClass} w-40`}
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary">
              <Search className="size-3.5" />
              查询
            </Button>
            <Button onClick={() => apply(EMPTY_FILTERS)}>
              <RotateCcw className="size-3.5" />
              重置
            </Button>
          </div>
        </div>
        {filterError && (
          <div className="mt-3">
            <InlineError>{filterError}</InlineError>
          </div>
        )}
      </form>

      {/* Conversations table */}
      <Card className="overflow-x-auto">
        {list.isPending ? (
          <LoadingState />
        ) : list.isError && items.length === 0 ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<MessageSquareText className="size-6 stroke-[1.5]" />}
            title="暂无对话记录"
          >
            没有符合条件的对话
          </EmptyState>
        ) : (
          <>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>用户</th>
                  <th className={thClass}>标题</th>
                  <th className={thClass}>项目目录</th>
                  <th className={thClass}>模型</th>
                  <th className={thClass}>设备</th>
                  <th className={`${thClass} text-right`}>消息数</th>
                  <th className={thClass}>开始时间</th>
                  <th className={thClass}>最近消息</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr
                    key={c.id}
                    className={`${trClass} cursor-pointer ${
                      selected === c.id ? "bg-brand/10 font-medium" : ""
                    }`}
                    onClick={() => setSelected(c.id)}
                  >
                    <td className={`${tdClass} whitespace-nowrap`}>
                      <div className="font-medium">{c.user.displayName}</div>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-brand hover:underline cursor-pointer"
                        title="只看此用户"
                        onClick={(e) => {
                          e.stopPropagation();
                          filterByUser(c);
                        }}
                      >
                        @{c.user.username}
                      </button>
                    </td>
                    <td className={`${tdClass} max-w-72`}>
                      <div
                        className="truncate font-medium"
                        title={c.title ?? undefined}
                      >
                        {c.title ?? (
                          <span className="text-muted-foreground/60 font-normal">
                            （无标题）
                          </span>
                        )}
                      </div>
                    </td>
                    <td
                      className={`${tdClass} max-w-56 truncate font-mono text-xs text-muted-foreground`}
                      title={c.projectDir ?? undefined}
                    >
                      {c.projectDir ?? "—"}
                    </td>
                    <td
                      className={`${tdClass} font-mono text-xs whitespace-nowrap`}
                    >
                      {c.model ? (
                        <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
                          {c.model}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td
                      className={`${tdClass} max-w-40 truncate text-xs text-muted-foreground`}
                    >
                      {c.deviceName ?? "—"}
                    </td>
                    <td
                      className={`${tdClass} text-right tabular-nums font-mono text-xs`}
                    >
                      {formatNumber(c.messageCount)}
                    </td>
                    <td
                      className={`${tdClass} whitespace-nowrap text-xs text-muted-foreground`}
                    >
                      {formatDateTime(c.startedAt)}
                    </td>
                    <td
                      className={`${tdClass} whitespace-nowrap text-xs text-muted-foreground`}
                    >
                      {formatDateTime(c.lastMessageAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-center gap-3 py-4 border-t border-border/60">
              {list.isFetchNextPageError && (
                <span className="text-sm text-destructive">
                  加载失败：{describeError(list.error)}
                </span>
              )}
              {list.hasNextPage ? (
                <Button
                  onClick={() => list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage && <Spinner className="size-3" />}
                  加载更多
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  已显示全部 {items.length} 条
                </span>
              )}
            </div>
          </>
        )}
      </Card>

      {selected && (
        <ConversationDrawer id={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function ConversationDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const client = useApi();
  const detail = useQuery({
    queryKey: ["admin", "conversation", id],
    queryFn: ({ signal }) =>
      client.get(
        `/admin/conversations/${encodeURIComponent(id)}`,
        ConversationDetailResponseSchema,
        signal,
      ),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const messages = useMemo(
    () =>
      detail.data
        ? [...detail.data.messages].sort((a, b) => a.seq - b.seq)
        : [],
    [detail.data],
  );
  const c = detail.data?.conversation;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="关闭详情"
        className="absolute inset-0 bg-black/40 backdrop-blur-xs transition-opacity cursor-pointer"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="对话详情"
        className="relative flex h-full w-[min(820px,94vw)] flex-col border-l border-border bg-card shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/50 bg-card px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="font-serif text-base font-normal text-foreground truncate">
              {c ? (c.title ?? "（无标题）") : "对话详情"}
            </h2>
            {c && (
              <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <User className="size-3 opacity-60" />
                  {c.user.displayName} (@{c.user.username})
                </span>
                {c.deviceName && <span>· 设备：{c.deviceName}</span>}
                {c.model && (
                  <span className="font-mono">· 模型：{c.model}</span>
                )}
                <span>· 开始：{formatDateTime(c.startedAt)}</span>
                <span>· 消息数：{formatNumber(c.messageCount)}</span>
                {c.projectDir && (
                  <span className="font-mono break-all">
                    · 目录：{c.projectDir}
                  </span>
                )}
                <span className="font-mono">
                  · 会话 ID：{c.clientSessionId}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {detail.isPending ? (
            <LoadingState />
          ) : detail.isError ? (
            <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
          ) : messages.length === 0 ? (
            <EmptyState
              icon={<MessageSquareText className="size-5 stroke-[1.5]" />}
              title="暂无消息"
            >
              该对话没有消息
            </EmptyState>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {messages.map((m) => (
                <MessageItem key={m.seq} message={m} />
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}

interface MessageStyle {
  label: string;
  tone: "blue" | "green" | "amber" | "purple" | "gray";
  box: string;
  mono: boolean;
}

function styleOf(m: RetainedMessage): MessageStyle {
  switch (m.kind) {
    case "reasoning":
      return {
        label: "推理",
        tone: "amber",
        box: "border-amber-500/20 bg-amber-500/5 italic text-muted-foreground",
        mono: false,
      };
    case "tool_call":
      return {
        label: m.toolName ? `工具调用 · ${m.toolName}` : "工具调用",
        tone: "purple",
        box: "border-border/60 bg-muted/40 font-mono text-xs",
        mono: true,
      };
    case "tool_result":
      return {
        label: m.toolName ? `工具结果 · ${m.toolName}` : "工具结果",
        tone: "gray",
        box: "border-border/60 bg-muted/40 font-mono text-xs",
        mono: true,
      };
    case "message":
      break;
  }
  switch (m.role) {
    case "user":
      return {
        label: "用户",
        tone: "blue",
        box: "border-border/60 bg-card shadow-xs",
        mono: false,
      };
    case "assistant":
      return {
        label: "助手",
        tone: "green",
        box: "border-border/60 bg-card shadow-xs",
        mono: false,
      };
    case "system":
      return {
        label: "系统",
        tone: "gray",
        box: "border-border/60 bg-muted/40",
        mono: false,
      };
    case "tool":
      return {
        label: "工具",
        tone: "gray",
        box: "border-border/60 bg-muted/40 font-mono text-xs",
        mono: true,
      };
  }
}

const COLLAPSE_CHARS = 1200;
const COLLAPSE_LINES = 16;

function isLong(content: string): boolean {
  if (content.length > COLLAPSE_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 && ++lines > COLLAPSE_LINES) return true;
  }
  return false;
}

function preview(content: string): string {
  const lines = content.split("\n", COLLAPSE_LINES).join("\n");
  return lines.length > COLLAPSE_CHARS ? lines.slice(0, COLLAPSE_CHARS) : lines;
}

function MessageItem({ message: m }: { message: RetainedMessage }) {
  const style = styleOf(m);
  const long = isLong(m.content);
  const [expanded, setExpanded] = useState(false);
  const shown = long && !expanded ? `${preview(m.content)}…` : m.content;

  return (
    <li className={`rounded-xl border p-3.5 ${style.box}`}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge tone={style.tone}>{style.label}</Badge>
        <span className="tabular-nums font-mono opacity-75">#{m.seq}</span>
        {m.timestamp && <span>· {formatDateTime(m.timestamp)}</span>}
        {m.model && (
          <span className="font-mono rounded bg-muted px-1 py-0.2 text-[10px]">
            {m.model}
          </span>
        )}
        {(m.inputTokens !== null || m.outputTokens !== null) && (
          <span className="tabular-nums text-[10px] opacity-75">
            输入 {m.inputTokens === null ? "—" : formatNumber(m.inputTokens)} /
            输出 {m.outputTokens === null ? "—" : formatNumber(m.outputTokens)}{" "}
            tokens
          </span>
        )}
      </div>
      {m.content ? (
        <pre
          className={`text-xs leading-relaxed break-words whitespace-pre-wrap ${
            style.mono ? "font-mono" : "font-sans"
          }`}
        >
          {shown}
        </pre>
      ) : (
        <span className="text-xs text-muted-foreground">（空）</span>
      )}
      {long && (
        <button
          type="button"
          className="mt-1.5 flex items-center gap-1 text-xs font-medium text-brand hover:underline cursor-pointer"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" /> 收起
            </>
          ) : (
            <>
              <ChevronDown className="size-3" /> 展开全部（
              {formatNumber(m.content.length)} 字符）
            </>
          )}
        </button>
      )}
    </li>
  );
}
