import {
  ListMarketItemsResponseSchema,
  type MarketItem,
  type MarketItemPatch,
  MarketItemSchema,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Spinner,
  Switch,
} from "../components/ui";
import { useApi } from "../lib/auth";
import { describeError, formatBytes, formatDateTime } from "../lib/format";
import {
  MARKET_KEY,
  MarketUploadDialog,
  PublisherSelect,
  saveBlob,
  sha256Hex,
} from "./MarketPage";
import { isJsonKind } from "./MarketUploadForm";
import { useUserOptions } from "./UsersPage";

/**
 * Connectors admin page — Claude-inspired card grid with full administrative controls.
 */
export function ConnectorsPage() {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const users = useUserOptions();
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
          <Button
            variant="primary"
            className="h-9 rounded-full px-4 shadow-none"
            onClick={() => setUploading("new")}
          >
            <Plus className="size-4" />
            上传连接器
          </Button>
        }
      />

      {items.isPending ? (
        <LoadingState />
      ) : items.isError ? (
        <ErrorState error={items.error} onRetry={() => items.refetch()} />
      ) : connectors.length === 0 ? (
        <div className="rounded-2xl border border-border/80 bg-card p-12">
          <EmptyState
            icon={<Cable className="size-8 stroke-[1.5]" />}
            title="还没有连接器"
          >
            点击右上角「上传连接器」发布第一个连接器。
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Claude-style search pill & count */}
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div className="relative w-full max-w-sm">
              <Search
                aria-hidden
                className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                strokeWidth={1.5}
              />
              <input
                className="h-10 w-full rounded-full border border-border/80 bg-card ps-10 pe-9 text-sm text-foreground outline-none placeholder:text-muted-foreground transition-all focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 shadow-2xs"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索连接器..."
                aria-label="搜索连接器"
                autoComplete="off"
                spellCheck={false}
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="清除搜索"
                  className="absolute end-3 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setSearchQuery("")}
                >
                  <X className="size-3.5" strokeWidth={1.5} />
                </button>
              )}
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {normalized
                ? `显示 ${filtered.length} / 共 ${connectors.length} 个连接器`
                : `共 ${connectors.length} 个连接器`}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-border/80 bg-card p-12">
              <EmptyState
                icon={<Cable className="size-8 stroke-[1.5]" />}
                title="未找到匹配的连接器"
              >
                没有匹配「{searchQuery.trim()}」的连接器，请尝试其他关键词。
              </EmptyState>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filtered.map((item) => (
                <div
                  key={item.id}
                  className="group flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-5 transition-all hover:border-zinc-300 dark:hover:border-zinc-700 shadow-2xs"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/50 text-foreground">
                      <Cable className="size-6 stroke-[1.5]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3
                          title={item.name}
                          className="truncate text-base font-medium text-foreground tracking-tight"
                        >
                          {item.name}
                        </h3>
                        <Badge tone="blue">{item.id}</Badge>
                        {item.mandatory && <Badge tone="amber">必装</Badge>}
                      </div>
                      <p
                        title={item.description || undefined}
                        className="mt-1 line-clamp-2 text-sm text-muted-foreground leading-relaxed"
                      >
                        {item.description || "暂无说明"}
                      </p>
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          by{" "}
                          <strong className="font-medium text-foreground/80">
                            {item.publishedByName || "系统"}
                          </strong>
                        </span>
                        <span className="text-border">•</span>
                        <span className="font-mono">{item.version}</span>
                        <span className="text-border">•</span>
                        <span>{formatBytes(item.sizeBytes)}</span>
                        <span className="text-border">•</span>
                        <span>{formatDateTime(item.updatedAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-3.5">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          必装
                        </span>
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
                      <div className="w-36">
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
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        disabled={downloadingId === item.id}
                        onClick={() => void download(item)}
                        title="下载安装包"
                      >
                        {downloadingId === item.id && (
                          <Spinner className="size-3" />
                        )}
                        下载
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setUploading(item)}
                        title="上传新版本"
                      >
                        新版本
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleting(item)}
                        title="删除连接器"
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {uploading && (
        <MarketUploadDialog
          key={uploading === "new" ? "new" : uploading.id}
          kinds={["connector"]}
          title={
            uploading === "new" ? "上传连接器" : `发布新版本：${uploading.name}`
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
