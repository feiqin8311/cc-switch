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
  inputClass,
  LoadingState,
  Notice,
  PageHeader,
  Spinner,
  Switch,
  textareaClass,
} from "../components/ui";
import { useApi, useCan } from "../lib/auth";
import { describeError, fieldErrorsOf } from "../lib/format";

const POLICY_KEY = ["admin", "retention-policy"] as const;
const MAX_NOTICE = 2000;

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
        description="控制客户端是否上传 Codex 对话用于审计，以及服务器保留多久。"
      />
      <div className="mb-4">
        <Notice>
          客户端只会上传员工在本设备上<b>确认留存告知之后新开始</b>
          的会话；确认之前的历史会话永远不会上传。关闭留存后客户端停止上传，已上传的对话仍按保留天数清理。
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
  const canEdit = useCan("settings.manage");
  const [enabled, setEnabled] = useState(initial.enabled);
  const [noticeText, setNoticeText] = useState(initial.noticeText);
  const [days, setDays] = useState(String(initial.retentionDays));
  const [errors, setErrors] = useState<Record<string, string>>({});
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
    onError: (err) => {
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setFormError(describeError(err));
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const n = Number(days);
    if (!/^\d+$/.test(days.trim()) || n < 1 || n > 3650)
      next.retentionDays = "请输入 1-3650 之间的整数";
    if (noticeText.length > MAX_NOTICE)
      next.noticeText = `最多 ${MAX_NOTICE} 个字符`;
    if (enabled && !noticeText.trim())
      next.noticeText = "开启留存时必须填写告知内容";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    save.mutate({ enabled, noticeText, retentionDays: n });
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
            {enabled ? "已开启：客户端上传对话" : "已关闭：客户端不上传对话"}
          </span>
        </div>
      </Field>
      <Field
        label="员工告知内容"
        htmlFor="ret-notice"
        error={errors.noticeText}
        hint={`客户端在上传任何内容前向员工展示此文本并要求确认（${noticeText.length}/${MAX_NOTICE}）`}
      >
        <textarea
          id="ret-notice"
          rows={6}
          className={textareaClass}
          aria-invalid={!!errors.noticeText}
          readOnly={!canEdit}
          value={noticeText}
          onChange={(e) => setNoticeText(e.target.value)}
        />
      </Field>
      <Field
        label="保留天数"
        htmlFor="ret-days"
        error={errors.retentionDays}
        hint="对话最后一条消息超过该天数后由服务器自动删除（1-3650）"
      >
        <input
          id="ret-days"
          inputMode="numeric"
          className={`${inputClass} w-32`}
          aria-invalid={!!errors.retentionDays}
          readOnly={!canEdit}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
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
