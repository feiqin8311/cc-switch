import {
  ListMarketItemsResponseSchema,
  type MarketItem,
  type MarketItemPatch,
  MarketItemSchema,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  inputClass,
  LoadingState,
  PageHeader,
  Spinner,
  Switch,
} from "../components/ui";
import { useApi } from "../lib/auth";
import { describeError, formatBytes, formatDateTime } from "../lib/format";
import { isJsonKind } from "./MarketUploadForm";
import {
  MARKET_KEY,
  MarketUploadDialog,
  PublisherSelect,
  saveBlob,
  sha256Hex,
} from "./MarketPage";
import { useUsers } from "./UsersPage";

/**
 * Connectors admin page — list chrome mirrors the desktop MCP panel
 * (search + count, rounded panel, sticky name header, compact rows).
 */
export function ConnectorsPage() {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const users = useUsers();
  const [uploading, setUploading] = useState<MarketItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<MarketItem | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  const connectors = useMemo(
    () => (items.data?.items ?? []).filter((i) => i.kind === "connector"),
    [items.data?.items],
  );
  const normalized = searchQuery.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    if (!normalized) return connectors;
    return connectors.filter((i) => {
      const hay = [
        i.name,
        i.description,
        i.id,
        i.version,
        i.publishedByName ?? "",
      ]
        .join("\n")
        .toLocaleLowerCase();
      return hay.includes(normalized);
    });
  }, [connectors, normalized]);

  const togglingId = patch.isPending ? patch.variables?.id : undefined;

  return (
    <div>
      <PageHeader
        title="连接器"
        description="把公司系统接到 Codex。员工在桌面端「连接器」安装；钉钉登录需本人扫码。"
        actions={
          <Button variant="primary" onClick={() => setUploading("new")}>
            <Upload className="size-4" />
            上传
          </Button>
        }
      />

      {items.isPending ? (
        <LoadingState />
      ) : items.isError ? (
        <ErrorState error={items.error} onRetry={() => items.refetch()} />
      ) : connectors.length === 0 ? (
        <div className="rounded-xl border border-border/80 bg-card shadow-sm">
          <EmptyState
            icon={<Upload className="size-6 stroke-[1.5]" />}
            title="还没有连接器"
          >
            点击右上角「上传」发布第一个连接器。
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Search row — same rhythm as desktop MCP (h-14, 320px field, caption count) */}
          <div className="mb-3 flex h-10 items-center gap-3">
            <div className="relative w-[320px] min-w-[180px] shrink">
              <Search
                aria-hidden
                className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                strokeWidth={1.5}
              />
              <input
                className={`${inputClass} ps-8 pe-8`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索名称、说明或发布人"
                aria-label="搜索连接器"
                autoComplete="off"
                spellCheck={false}
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="清除搜索"
                  className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setSearchQuery("")}
                >
                  <X className="size-3.5" strokeWidth={1.5} />
                </button>
              )}
            </div>
            <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {normalized
                ? `${filtered.length} / ${connectors.length} 个连接器`
                : `${connectors.length} 个连接器`}
            </span>
          </div>

          {/* List panel — mirrors desktop MCP rounded-panel + sticky header */}
          <div className="overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm">
            <div className="sticky top-0 z-10 flex h-11 items-center border-b border-border/60 bg-muted/40 pe-2 ps-4">
              <span className="min-w-0 flex-1 text-xs font-semibold text-muted-foreground">
                名称
              </span>
              <span className="w-[7.5rem] shrink-0 text-xs font-semibold text-muted-foreground">
                必装
              </span>
              <span className="w-56 shrink-0 text-xs font-semibold text-muted-foreground">
                创建人
              </span>
              <span
                aria-hidden
                className="w-[11.5rem] shrink-0"
              />
            </div>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                <span className="text-sm text-muted-foreground">
                  没有匹配「{searchQuery.trim()}」的连接器
                </span>
                <Button size="sm" onClick={() => setSearchQuery("")}>
                  清除搜索
                </Button>
              </div>
            ) : (
              <ul aria-label="连接器列表" className="m-0 list-none p-0">
                {filtered.map((item, index) => (
                  <li
                    key={item.id}
                    className={`flex min-h-14 items-center gap-3 pe-2 ps-4 py-2.5 transition-colors hover:bg-muted/40 ${
                      index > 0 ? "border-t border-border/40" : ""
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 flex-col pe-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          title={item.name}
                          className="min-w-0 truncate text-sm font-medium text-foreground"
                        >
                          {item.name}
                        </span>
                        <Badge tone="blue">{item.id}</Badge>
                        {item.mandatory && <Badge tone="amber">必装</Badge>}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span
                          title={item.description || undefined}
                          className="min-w-0 truncate"
                        >
                          {item.description || item.id}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">
                          {item.version}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {formatBytes(item.sizeBytes)}
                        </span>
                        <span className="shrink-0">
                          {formatDateTime(item.updatedAt)}
                        </span>
                      </div>
                    </div>

                    <div className="flex w-[7.5rem] shrink-0 items-center gap-1.5">
                      <Switch
                        label={`${item.name} 必装`}
                        checked={item.mandatory}
                        disabled={togglingId === item.id}
                        onChange={(mandatory) =>
                          patch.mutate({ id: item.id, body: { mandatory } })
                        }
                      />
                      {togglingId === item.id && (
                        <Spinner className="size-3" />
                      )}
                    </div>

                    <div className="w-56 shrink-0">
                      <PublisherSelect
                        item={item}
                        users={users.data?.items}
                        disabled={togglingId === item.id}
                        onChange={(publishedBy) =>
                          patch.mutate({
                            id: item.id,
                            body: { publishedBy },
                          })
                        }
                      />
                    </div>

                    <div className="flex w-[11.5rem] shrink-0 justify-end gap-1">
                      <Button
                        size="sm"
                        disabled={downloadingId === item.id}
                        onClick={() => void download(item)}
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
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {uploading && (
        <MarketUploadDialog
          key={uploading === "new" ? "new" : uploading.id}
          kinds={["connector"]}
          title={
            uploading === "new"
              ? "上传连接器"
              : `发布新版本：${uploading.name}`
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
