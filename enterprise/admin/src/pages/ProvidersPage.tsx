import {
  type AdminProvider,
  AdminProviderSchema,
  type CreateProviderRequest,
  ListProvidersResponseSchema,
  type UpdateProviderRequest,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Plus } from "lucide-react";
import { useMemo, useState } from "react";
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
  selectClass,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  trClass,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useApi } from "../lib/auth";
import { describeError, fieldErrorsOf } from "../lib/format";
import { gatewayUrl, ProviderForm, type ProviderPayload } from "./ProviderForm";
import { useUserOptions } from "./UsersPage";

const PROVIDERS_KEY = ["admin", "providers"] as const;

export function ProvidersPage({ embedded }: { embedded?: boolean } = {}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const users = useUserOptions();
  const userMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users.data?.items ?? []) {
      map.set(u.id, u.username);
    }
    return map;
  }, [users.data]);
  const [editing, setEditing] = useState<{
    mode: "edit" | "create";
    provider?: AdminProvider;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [deleting, setDeleting] = useState<AdminProvider | null>(null);

  const providers = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: ({ signal }) =>
      client.get("/admin/providers", ListProvidersResponseSchema, signal),
  });
  const keyword = search.trim().toLowerCase();
  const filtered = (providers.data?.items ?? []).filter((p) => {
    if (status !== "all" && p.enabled !== (status === "enabled")) return false;
    return !keyword || [
      p.name,
      p.id,
      p.baseUrl,
      ...p.models.flatMap((m) => [m.id, m.displayName]),
      ...p.allowedGroups,
      ...p.allowedUserIds.map((id) => userMap.get(id) ?? id.slice(0, 8)),
    ].some((value) => value.toLowerCase().includes(keyword));
  });
  const clearFilters = () => {
    setSearch("");
    setStatus("all");
  };

  const remove = useMutation({
    mutationFn: (id: string) =>
      client.request(`/admin/providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      toast.success(`已删除 ${id}`);
      setDeleting(null);
    },
    onError: (err) => toast.error(`删除失败：${describeError(err)}`),
  });

  return (
    <div>
      <PageHeader
        embedded={embedded}
        title="模型与网关"
        description="配置上游模型服务。员工客户端通过企业网关访问，上游 API Key 不会离开服务器。"
        actions={
          <Button variant="primary" onClick={() => setEditing({ mode: "create" })}>
            <Plus className="size-4" />
            新建模型服务
          </Button>
        }
      />
      <Card className="overflow-x-auto">
        {!!providers.data?.items.length && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input
              type="search"
              className={`${inputClass} max-w-sm`}
              aria-label="搜索模型服务"
              placeholder="搜索名称、ID、上游地址、模型或访问对象"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className={`${selectClass} max-w-32`}
              aria-label="按状态筛选"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="enabled">启用</option>
              <option value="disabled">停用</option>
            </select>
            {(search || status !== "all") && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                清除筛选
              </Button>
            )}
          </div>
        )}
        {providers.isPending ? (
          <LoadingState />
        ) : providers.isError ? (
          <ErrorState
            error={providers.error}
            onRetry={() => providers.refetch()}
          />
        ) : providers.data.items.length === 0 ? (
          <EmptyState
            icon={<Cpu className="size-6 stroke-[1.5]" />}
            title="暂无模型服务"
          >
            还没有模型服务，点击右上角「新建模型服务」添加。
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState title="没有匹配的模型服务">
            请调整搜索词或清除筛选。
          </EmptyState>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>名称</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>ID</th>
                <th className={thClass}>上游地址</th>
                <th className={thClass}>模型数</th>
                <th className={`${thClass} text-left`}>
                  <span className="pl-1.5">允许访问</span>
                </th>
                <th className={`${thClass} text-left`}>
                  <span className="pl-[calc(var(--spacing)*2.5+1px)]">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className={trClass}>
                  <td className={tdClass}>{p.name}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {p.enabled ? (
                      <Badge tone="green">启用</Badge>
                    ) : (
                      <Badge tone="gray">停用</Badge>
                    )}
                  </td>
                  <td className={`${tdClass} font-mono text-xs`}>
                    <div>{p.id}</div>
                    <div
                      className="max-w-56 truncate text-muted-foreground"
                      title={gatewayUrl(p.id)}
                    >
                      {gatewayUrl(p.id)}
                    </div>
                  </td>
                  <td
                    className={`${tdClass} max-w-64 truncate font-mono text-xs`}
                    title={p.baseUrl}
                  >
                    {p.baseUrl}
                  </td>
                  <td
                    className={tdClass}
                    title={p.models.map((m) => m.id).join(", ")}
                  >
                    {p.models.length}
                  </td>
                  <td className={`${tdClass} text-left`}>
                    {p.allowedGroups.length === 0 &&
                    p.allowedUserIds.length === 0 ? (
                      <Badge tone="gray">全员不可用</Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1 max-w-56">
                        {p.allowedGroups.map((g) => (
                          <Badge key={g} tone="blue">
                            {g}
                          </Badge>
                        ))}
                        {p.allowedUserIds.map((uid) => (
                          <Badge key={uid}>
                            {userMap.get(uid) ?? uid.slice(0, 8)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={`${tdClass} text-left whitespace-nowrap`}>
                    <div className="inline-flex gap-1">
                      <Button size="sm" onClick={() => setEditing({ mode: "edit", provider: p })}>
                        编辑
                      </Button>
                      <Button size="sm" onClick={() => setEditing({ mode: "create", provider: p })}>
                        复制创建
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleting(p)}
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

      {editing && (
        <ProviderDialog
          key={`${editing.mode}:${editing.provider?.id ?? ""}`}
          {...editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="删除模型服务"
        danger
        confirmLabel="删除"
        pending={remove.isPending}
        message={
          <>
            确定删除 <b>{deleting?.name}</b>（{deleting?.id}
            ）吗？使用该服务的员工将无法再调用其模型，此操作不可撤销。
          </>
        }
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function ProviderDialog({
  mode,
  provider,
  onClose,
}: {
  mode: "edit" | "create";
  provider?: AdminProvider;
  onClose(): void;
}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = mode === "edit" ? provider : undefined;
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (payload: ProviderPayload) => {
      if (!existing) {
        const body: CreateProviderRequest = {
          ...payload,
          apiKey: payload.apiKey ?? "",
          wireApi: payload.wireApi,
        };
        return client.request("/admin/providers", {
          method: "POST",
          body,
          schema: AdminProviderSchema,
        });
      }
      const { id: _id, ...rest } = payload;
      const body: UpdateProviderRequest = rest;
      return client.request(
        `/admin/providers/${encodeURIComponent(existing.id)}`,
        { method: "PATCH", body, schema: AdminProviderSchema },
      );
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      toast.success(existing ? `已保存 ${saved.name}` : `已创建 ${saved.name}`);
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "conflict") {
        setServerErrors({ id: "该 ID 已存在" });
        return;
      }
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) {
        setServerErrors(fields);
        setFormError("请检查标红的字段");
      } else {
        setFormError(describeError(err));
      }
    },
  });

  return (
    <Dialog
      open
      width="max-w-2xl"
      title={existing ? `编辑模型服务 ${existing.id}` : provider ? "复制创建模型服务" : "新建模型服务"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="submit"
            form="provider-form"
            variant="primary"
            disabled={save.isPending}
          >
            {save.isPending && <Spinner className="size-3" />}
            {existing ? "保存" : "创建"}
          </Button>
        </>
      }
    >
      {provider && !existing && (
        <p className="mb-4 text-sm text-muted-foreground">
          已预填「{provider.name}」的配置。请填写新 ID 和 API Key，并确认访问范围后创建。
        </p>
      )}
      <ProviderForm
        formId="provider-form"
        mode={mode}
        provider={provider}
        serverErrors={serverErrors}
        onSubmit={(payload) => {
          setServerErrors({});
          setFormError(null);
          save.mutate(payload);
        }}
      />
      {formError && (
        <div className="mt-3">
          <InlineError>{formError}</InlineError>
        </div>
      )}
    </Dialog>
  );
}
