import {
  type AdminRetentionPolicy,
  AdminRetentionPolicySchema,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useToast } from "../components/Toast";
import {
  Button,
  Card,
  ErrorState,
  Field,
  InlineError,
  LoadingState,
  Notice,
  PageHeader,
  Spinner,
  Switch,
} from "../components/ui";
import { useApi, useCan } from "../lib/auth";
import { describeError } from "../lib/format";

const POLICY_KEY = ["admin", "retention-policy"] as const;

export function RetentionPage({ embedded }: { embedded?: boolean } = {}) {
  const client = useApi();
  const policy = useQuery({
    queryKey: POLICY_KEY,
    queryFn: ({ signal }) =>
      client.get("/admin/retention-policy", AdminRetentionPolicySchema, signal),
  });

  return (
    <div>
      <PageHeader
        embedded={embedded}
        title="留存策略"
        description="控制员工电脑是否把 Codex 对话同步到企业端用于审计。"
      />
      <div className="mb-4">
        <Notice>
          开启后，每台登录的电脑<b>每天自动同步一次</b>本机全部 Codex
          会话（包括开启前的历史会话），只上传新增的内容。关闭后客户端停止同步，已上传的对话会一直保留。
        </Notice>
      </div>
      <Card>
        {policy.isPending ? (
          <LoadingState />
        ) : policy.isError ? (
          <ErrorState error={policy.error} onRetry={() => policy.refetch()} />
        ) : (
          <PolicyForm key={JSON.stringify(policy.data)} initial={policy.data} />
        )}
      </Card>
    </div>
  );
}

function PolicyForm({ initial }: { initial: AdminRetentionPolicy }) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const canManageSettings = useCan("settings.manage");
  const canManageRetention = useCan("retention.manage");
  const canEdit = canManageSettings || canManageRetention;
  const [enabled, setEnabled] = useState(initial.enabled);
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: AdminRetentionPolicy) =>
      client.request("/admin/retention-policy", {
        method: "PUT",
        body,
        schema: AdminRetentionPolicySchema,
      }),
    onSuccess: (saved) => {
      qc.setQueryData(POLICY_KEY, saved);
      toast.success("留存策略已保存");
    },
    onError: (err) => setFormError(describeError(err)),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    save.mutate({ enabled });
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {!canEdit && (
        <p className="text-xs text-muted-foreground">
          只读：修改留存策略需要「系统设置」权限。
        </p>
      )}
      <Field label="对话留存" htmlFor="ret-enabled">
        <div className="flex h-8 items-center gap-2">
          <Switch
            id="ret-enabled"
            label="开启对话留存"
            checked={enabled}
            disabled={!canEdit}
            onChange={setEnabled}
          />
          <span className="text-sm">
            {enabled
              ? "已开启：客户端每天同步一次对话"
              : "已关闭：客户端不上传对话"}
          </span>
        </div>
      </Field>
      <InlineError>{formError}</InlineError>
      {canEdit && (
        <div>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner className="size-3" />}
            保存
          </Button>
        </div>
      )}
    </form>
  );
}
