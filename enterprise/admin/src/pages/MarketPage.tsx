import {
  ListMarketItemsResponseSchema,
  type MarketItem,
  type MarketItemKind,
  type MarketItemPatch,
  MarketItemSchema,
  PromptDefinitionSchema,
  type User,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Plug, ScrollText, Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  InlineError,
  inputClass,
  LoadingState,
  PageHeader,
  Spinner,
  Switch,
  tableClass,
  tdClass,
  thClass,
  trClass,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useApi } from "../lib/auth";
import {
  describeError,
  fieldErrorsOf,
  formatBytes,
  formatDateTime,
} from "../lib/format";
import {
  isJsonKind,
  KIND_LABELS,
  MarketUploadForm,
  type MarketUploadValues,
} from "./MarketUploadForm";
import { useUsers } from "./UsersPage";

const MARKET_KEY = ["market", "items"] as const;

const KIND_BADGES: Record<
  MarketItem["kind"],
  { tone: "blue" | "purple" | "green" | "amber"; label: string }
> = {
  skill: { tone: "blue", label: "skill" },
  plugin: { tone: "purple", label: "plugin" },
  mcp: { tone: "green", label: KIND_LABELS.mcp },
  prompt: { tone: "amber", label: KIND_LABELS.prompt },
  connector: { tone: "blue", label: KIND_LABELS.connector },
};

/** Copy and kinds of one market page; all of them share the list query. */
export interface MarketPageProps {
  kinds: readonly MarketItemKind[];
  title: string;
  description: string;
  /** Dialog title when uploading a new item. */
  uploadTitle: string;
  emptyTitle: string;
  emptyText: string;
  icon: "skills" | "mcp" | "prompts" | "connectors";
}

export const MARKET_PAGES = {
  skills: {
    kinds: ["skill", "plugin"],
    title: "Skills",
    description:
      "发布企业内部的 Codex 技能与插件。员工可在客户端安装，标记为必装的会自动安装。",
    uploadTitle: "上传技能 / 插件",
    emptyTitle: "还没有技能或插件",
    emptyText: "点击右上角「上传」发布第一个技能或插件。",
    icon: "skills",
  },
  mcp: {
    kinds: ["mcp"],
    title: "MCP",
    description:
      "发布 MCP 服务器配置。员工可在客户端安装，标记为必装的会自动安装并为 Codex 启用。",
    uploadTitle: "上传 MCP 服务器",
    emptyTitle: "还没有 MCP 服务器",
    emptyText: "点击右上角「上传」发布第一个 MCP 服务器。",
    icon: "mcp",
  },
  connectors: {
    kinds: ["connector"],
    title: "连接器",
    description:
      "发布公司系统连接器。员工在桌面客户端「连接器 → 企业市场」安装；钉钉 dws 登录仍需本人扫码。",
    uploadTitle: "上传连接器",
    emptyTitle: "还没有连接器",
    emptyText: "点击右上角「上传」发布第一个连接器。",
    icon: "connectors",
  },
  prompts: {
    kinds: ["prompt"],
    title: "提示词",
    description:
      "发布 Codex 全局提示词（写入员工的 ~/.codex/AGENTS.md）。员工可在客户端安装；标记为必装的会自动安装并启用。",
    uploadTitle: "上传提示词",
    emptyTitle: "还没有提示词",
    emptyText: "点击右上角「上传」发布第一个提示词。",
    icon: "prompts",
  },
} as const satisfies Record<string, MarketPageProps>;

const PAGE_ICONS = {
  skills: Sparkles,
  mcp: Plug,
  prompts: ScrollText,
  connectors: Cable,
};

const METADATA_FIELDS = new Set([
  "id",
  "kind",
  "name",
  "description",
  "version",
  "mandatory",
]);

/** Pretty-printed definition of an MCP item, as served by the package endpoint. */
function prettyDefinition(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function sha256Hex(blob: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function MarketPage({
  kinds,
  title,
  description,
  uploadTitle,
  emptyTitle,
  emptyText,
  icon,
}: MarketPageProps) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [uploading, setUploading] = useState<MarketItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<MarketItem | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const users = useUsers();

  const items = useQuery({
    queryKey: MARKET_KEY,
    queryFn: ({ signal }) =>
      client.get("/market/items", ListMarketItemsResponseSchema, signal),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: MarketItemPatch }) =>
      client.request(`/admin/market/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
        schema: MarketItemSchema,
      }),
    onSuccess: (item, vars) => {
      qc.setQueryData(MARKET_KEY, (old: { items: MarketItem[] } | undefined) =>
        old
          ? { items: old.items.map((i) => (i.id === item.id ? item : i)) }
          : old,
      );
      if (vars.body.publishedBy !== undefined) {
        toast.success(
          item.publishedByName
            ? `已将 ${item.name} 的创建人改为 ${item.publishedByName}`
            : `已清除 ${item.name} 的创建人`,
        );
        return;
      }
      toast.success(
        item.mandatory ? `${item.name} 已设为必装` : `${item.name} 已取消必装`,
      );
    },
    onError: (err) => toast.error(`修改失败：${describeError(err)}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      client.request(`/admin/market/items/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: MARKET_KEY });
      toast.success(`已删除 ${id}`);
      setDeleting(null);
    },
    onError: (err) => toast.error(`删除失败：${describeError(err)}`),
  });

  const download = async (item: MarketItem) => {
    setDownloadingId(item.id);
    try {
      const { blob, headers } = await client.download(
        `/market/items/${encodeURIComponent(item.id)}/package`,
      );
      const expected = headers.get("X-Content-SHA256") ?? item.sha256;
      const actual = await sha256Hex(blob);
      if (actual && expected && actual !== expected.toLowerCase()) {
        toast.error("下载的文件校验失败（SHA-256 不匹配），已取消保存");
        return;
      }
      const ext = isJsonKind(item.kind) ? "json" : "zip";
      saveBlob(blob, `${item.id}-${item.version}.${ext}`);
    } catch (err) {
      toast.error(`下载失败：${describeError(err)}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const togglingId = patch.isPending ? patch.variables?.id : undefined;
  const visible = items.data?.items.filter((i) => kinds.includes(i.kind));
  const Icon = PAGE_ICONS[icon];

  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        actions={
          <Button variant="primary" onClick={() => setUploading("new")}>
            <Upload className="size-4" />
            上传
          </Button>
        }
      />
      <Card className="overflow-x-auto">
        {items.isPending ? (
          <LoadingState />
        ) : items.isError ? (
          <ErrorState error={items.error} onRetry={() => items.refetch()} />
        ) : !visible || visible.length === 0 ? (
          <EmptyState
            icon={<Icon className="size-6 stroke-[1.5]" />}
            title={emptyTitle}
          >
            {emptyText}
          </EmptyState>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>类型</th>
                <th className={thClass}>ID</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>创建人</th>
                <th className={thClass}>版本</th>
                <th className={thClass}>必装</th>
                <th className={`${thClass} text-right`}>大小</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id} className={trClass}>
                  <td className={tdClass}>
                    <Badge tone={KIND_BADGES[item.kind].tone}>
                      {KIND_BADGES[item.kind].label}
                    </Badge>
                  </td>
                  <td className={`${tdClass} font-mono text-xs`}>{item.id}</td>
                  <td className={`${tdClass} max-w-72`}>
                    <div>{item.name}</div>
                    {item.description && (
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={item.description}
                      >
                        {item.description}
                      </div>
                    )}
                  </td>
                  <td className={tdClass}>
                    <PublisherSelect
                      item={item}
                      users={users.data?.items}
                      disabled={togglingId === item.id}
                      onChange={(publishedBy) =>
                        patch.mutate({ id: item.id, body: { publishedBy } })
                      }
                    />
                  </td>
                  <td className={`${tdClass} font-mono text-xs`}>
                    {item.version}
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-1.5">
                      <Switch
                        label={`${item.name} 必装`}
                        checked={item.mandatory}
                        disabled={togglingId === item.id}
                        onChange={(mandatory) =>
                          patch.mutate({ id: item.id, body: { mandatory } })
                        }
                      />
                      {togglingId === item.id && <Spinner className="size-3" />}
                    </div>
                  </td>
                  <td
                    className={`${tdClass} text-right whitespace-nowrap tabular-nums`}
                  >
                    {formatBytes(item.sizeBytes)}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {formatDateTime(item.updatedAt)}
                  </td>
                  <td className={`${tdClass} text-right whitespace-nowrap`}>
                    <div className="inline-flex gap-1">
                      <Button
                        size="sm"
                        disabled={downloadingId === item.id}
                        onClick={() => download(item)}
                      >
                        {downloadingId === item.id && (
                          <Spinner className="size-3" />
                        )}
                        下载
                      </Button>
                      <Button size="sm" onClick={() => setUploading(item)}>
                        新版本
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleting(item)}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {uploading && (
        <UploadDialog
          key={uploading === "new" ? "new" : uploading.id}
          kinds={kinds}
          title={
            uploading === "new" ? uploadTitle : `发布新版本：${uploading.name}`
          }
          existing={uploading === "new" ? undefined : uploading}
          onClose={() => setUploading(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="删除市场条目"
        danger
        confirmLabel="删除"
        pending={remove.isPending}
        message={
          <>
            确定删除 <b>{deleting?.name}</b>（{deleting?.id}
            ）吗？已安装的客户端不会被卸载，但无法再从市场安装或更新。
          </>
        }
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function publisherLabel(user: Pick<User, "displayName" | "username">): string {
  return user.displayName.trim() || user.username;
}

function PublisherSelect({
  item,
  users,
  disabled,
  onChange,
}: {
  item: MarketItem;
  users: User[] | undefined;
  disabled: boolean;
  onChange(userId: string): void;
}) {
  if (!users) {
    return <span>{item.publishedByName ?? "—"}</span>;
  }
  const known = users.some((u) => u.id === item.publishedBy);
  return (
    <select
      className={`${inputClass} min-w-36 max-w-52`}
      aria-label={`${item.name} 创建人`}
      value={item.publishedBy ?? ""}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value;
        if (!next || next === (item.publishedBy ?? "")) return;
        onChange(next);
      }}
    >
      {item.publishedBy == null && <option value="">未指定</option>}
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {publisherLabel(u)}
        </option>
      ))}
      {item.publishedBy && !known && (
        <option value={item.publishedBy}>
          {item.publishedByName ?? item.publishedBy}
        </option>
      )}
    </select>
  );
}

/** Text the definition field starts with for a new version of a JSON item. */
function definitionTextOf(kind: MarketItemKind, text: string): string {
  if (kind !== "prompt") return prettyDefinition(text);
  try {
    const parsed = PromptDefinitionSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.content : "";
  } catch {
    return "";
  }
}

const DEFINITION_LABELS = {
  mcp: "MCP 配置",
  prompt: "提示词",
  connector: "连接器配置",
} as const;
const DEFINITION_LIMITS = {
  mcp: "64 KB",
  prompt: "256 KB",
  connector: "16 KB",
} as const;

function UploadDialog({
  kinds,
  title,
  existing,
  onClose,
}: {
  kinds: readonly MarketItemKind[];
  title: string;
  existing?: MarketItem;
  onClose(): void;
}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Prefill a new MCP / prompt version with the current definition; on
  // failure the field just starts empty.
  const isJsonUpdate = existing !== undefined && isJsonKind(existing.kind);
  const current = useQuery({
    queryKey: ["market", "package", existing?.id, existing?.sha256],
    enabled: isJsonUpdate,
    retry: false,
    queryFn: async ({ signal }) => {
      const { blob } = await client.download(
        `/market/items/${encodeURIComponent(existing?.id ?? "")}/package`,
        signal,
      );
      return definitionTextOf(existing?.kind ?? "mcp", await blob.text());
    },
  });

  const upload = useMutation({
    mutationFn: (v: MarketUploadValues) =>
      client.request(`/admin/market/items/${encodeURIComponent(v.id)}`, {
        method: "PUT",
        query: {
          kind: v.kind,
          name: v.name,
          description: v.description,
          version: v.version,
          mandatory: v.mandatory ? "true" : "false",
        },
        ...(v.kind === "mcp" || v.kind === "prompt" || v.kind === "connector"
          ? { body: v.definition }
          : { raw: { data: v.file, contentType: "application/zip" } }),
        schema: MarketItemSchema,
      }),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: MARKET_KEY });
      toast.success(`已发布 ${item.name} ${item.version}`);
      onClose();
    },
    onError: (err, v) => {
      if (isJsonKind(v.kind)) {
        const label = DEFINITION_LABELS[v.kind];
        if (err instanceof ApiError && err.code === "payload_too_large") {
          setServerErrors({
            definition: `${label}超过服务器允许的大小（${DEFINITION_LIMITS[v.kind]}）`,
          });
          return;
        }
        // Definition issues carry paths like "command", "url" or "content";
        // metadata issues (query string) fall through to the regular mapping.
        const issue =
          err instanceof ApiError && err.code === "bad_request"
            ? err.fieldIssues.find((i) => !METADATA_FIELDS.has(i.path))
            : undefined;
        if (issue) {
          setServerErrors({
            definition: `${label}不符合要求：${issue.path ? `${issue.path} ` : ""}${issue.message}`,
          });
          return;
        }
      } else if (err instanceof ApiError && err.code === "payload_too_large") {
        setServerErrors({ file: "文件超过服务器允许的大小（20 MB）" });
        return;
      }
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) setServerErrors(fields);
      // Zip layout problems come back as a 400 without field paths.
      setFormError(describeError(err));
    },
  });

  return (
    <Dialog
      open
      width="max-w-2xl"
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="submit"
            form="market-upload-form"
            variant="primary"
            disabled={upload.isPending}
          >
            {upload.isPending && <Spinner className="size-3" />}
            上传
          </Button>
        </>
      }
    >
      {isJsonUpdate && current.isPending ? (
        <LoadingState
          label={`读取当前${existing.kind === "prompt" ? "提示词" : " MCP 配置"}…`}
        />
      ) : (
        <MarketUploadForm
          formId="market-upload-form"
          kinds={kinds}
          existing={existing}
          initialDefinition={current.data}
          serverErrors={serverErrors}
          onSubmit={(v) => {
            setServerErrors({});
            setFormError(null);
            upload.mutate(v);
          }}
        />
      )}
      {formError && (
        <div className="mt-3">
          <InlineError>{formError}</InlineError>
        </div>
      )}
    </Dialog>
  );
}
