import {
  type AdminProvider,
  AdminProviderSchema,
  type CreateProviderRequest,
  ListProvidersResponseSchema,
  type UpdateProviderRequest,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Plus } from "lucide-react";
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
  LoadingState,
  Notice,
  PageHeader,
  Spinner,
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
  formatNumber,
  ROLE_LABELS,
} from "../lib/format";
import { gatewayUrl, ProviderForm, type ProviderPayload } from "./ProviderForm";

const PROVIDERS_KEY = ["admin", "providers"] as const;

export function ProvidersPage({ embedded }: { embedded?: boolean } = {}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<AdminProvider | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminProvider | null>(null);

  const providers = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: ({ signal }) =>
      client.get("/admin/providers", ListProvidersResponseSchema, signal),
  });

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
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            新建模型服务
          </Button>
        }
      />
      <div className="mb-4">
        <Notice>
          网关地址格式：
          <code className="font-mono">{gatewayUrl("<id>")}</code>
          （OpenAI Responses API 兼容，客户端使用各自的网关密钥鉴权）
        </Notice>
      </div>
      <Card className="overflow-x-auto">
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
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>名称</th>
                <th className={thClass}>ID</th>
                <th className={thClass}>上游地址</th>
                <th className={thClass}>模型数</th>
                <th className={thClass}>允许角色</th>
                <th className={thClass}>每日额度</th>
                <th className={thClass}>状态</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {providers.data.items.map((p) => (
                <tr key={p.id} className={trClass}>
                  <td className={tdClass}>{p.name}</td>
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
                  <td className={tdClass}>
                    <div className="flex flex-wrap gap-1">
                      {p.allowedRoles.map((r) => (
                        <Badge key={r}>{ROLE_LABELS[r]}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {p.dailyTokenLimitPerUser === null
                      ? "不限"
                      : formatNumber(p.dailyTokenLimitPerUser)}
                  </td>
                  <td className={tdClass}>
                    {p.enabled ? (
                      <Badge tone="green">启用</Badge>
                    ) : (
                      <Badge tone="gray">停用</Badge>
                    )}
                  </td>
                  <td className={`${tdClass} text-right whitespace-nowrap`}>
                    <div className="inline-flex gap-1">
                      <Button size="sm" onClick={() => setEditing(p)}>
                        编辑
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
          key={editing === "new" ? "new" : editing.id}
          provider={editing === "new" ? undefined : editing}
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
  provider,
  onClose,
}: {
  provider?: AdminProvider;
  onClose(): void;
}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const mode = provider ? "edit" : "create";
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (payload: ProviderPayload) => {
      if (!provider) {
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
        `/admin/providers/${encodeURIComponent(provider.id)}`,
        { method: "PATCH", body, schema: AdminProviderSchema },
      );
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: PROVIDERS_KEY });
      toast.success(provider ? `已保存 ${saved.name}` : `已创建 ${saved.name}`);
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
      title={provider ? `编辑模型服务 ${provider.id}` : "新建模型服务"}
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
            {provider ? "保存" : "创建"}
          </Button>
        </>
      }
    >
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
