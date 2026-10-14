import {
  type AdminProfile,
  AdminProfileSchema,
  DeviceDetailResponseSchema,
  ListProfilesResponseSchema,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  inputClass,
} from "../components/ui";
import { useApi } from "../lib/auth";
import { describeError, formatDateTime, formatNumber } from "../lib/format";

export function DeviceDetailPage() {
  const { id = "" } = useParams();
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({
    queryKey: ["admin", "device", id],
    queryFn: ({ signal }) =>
      client.get(`/admin/devices/${id}`, DeviceDetailResponseSchema, signal),
    enabled: id.length > 0,
  });
  const profiles = useQuery({
    queryKey: ["admin", "profiles"],
    queryFn: ({ signal }) =>
      client.get("/admin/profiles", ListProfilesResponseSchema, signal),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      client.request(`/admin/devices/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "device", id] });
      qc.invalidateQueries({ queryKey: ["admin", "devices"] });
      toast.success("已保存");
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const personal = useMutation({
    mutationFn: () =>
      client.request<AdminProfile>(`/admin/devices/${id}/personal-profile`, {
        method: "POST",
        schema: AdminProfileSchema,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "device", id] });
      qc.invalidateQueries({ queryKey: ["admin", "profiles"] });
      toast.success("已生成这台电脑的方案");
    },
    onError: (err) => toast.error(describeError(err)),
  });

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) {
    return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  }
  const { device, days, byProvider, gateway } = detail.data;
  const maxTokens = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));

  return (
    <div className="space-y-6">
      <PageHeader
        title={device.name}
        description={`${device.username} · ${device.hostname || "未知主机"}`}
        actions={
          <Link className="text-sm underline" to="/devices">
            返回列表
          </Link>
        }
      />
      <Card className="space-y-4 p-6">
        <div className="flex flex-wrap gap-2">
          <Badge tone={device.online ? "green" : "gray"}>
            {device.online ? "在线" : "离线"}
          </Badge>
          <Badge tone={device.sync === "failed" ? "red" : device.sync === "synced" ? "green" : "amber"}>
            {device.sync === "synced" ? "已同步" : device.sync === "failed" ? "同步失败" : "同步中"}
          </Badge>
          {device.disabled && <Badge tone="red">已停用</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          正在使用 {device.reported.mode} 
          {device.reported.activeProviderName ? ` · ${device.reported.activeProviderName}` : ""}
          。上次上报 {formatDateTime(device.lastSeenAt)}。
          {device.userChangedAt ? ` 使用人于 ${formatDateTime(device.userChangedAt)} 更换。` : ""}
          {device.applyError ? ` 错误：${device.applyError}` : ""}
        </p>
        <Field label="备注">
          <input
            className={inputClass}
            defaultValue={device.note}
            key={device.note}
            onBlur={(e) => {
              if (e.target.value !== device.note) patch.mutate({ note: e.target.value });
            }}
          />
        </Field>
        <Field label="配置方案" htmlFor="device-profile">
          <select
            id="device-profile"
            className={inputClass}
            value={device.profileId ?? ""}
            onChange={(e) =>
              patch.mutate({ profileId: e.target.value === "" ? null : e.target.value })
            }
          >
            <option value="">默认方案</option>
            {profiles.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.isDefault ? "（默认）" : ""}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => personal.mutate()} disabled={personal.isPending}>
            为此电脑单独配置
          </Button>
          <Button variant="secondary" onClick={() => patch.mutate({ forceSync: true })}>
            立即同步
          </Button>
          <Button
            variant={device.disabled ? "secondary" : "danger"}
            onClick={() => patch.mutate({ disabled: !device.disabled })}
          >
            {device.disabled ? "恢复" : "停用"}
          </Button>
        </div>
      </Card>
      <Card className="p-6">
        <h2 className="mb-3 text-sm font-medium">近 7 天（设备上报）</h2>
        <div className="space-y-2">
          {days.length === 0 && <p className="text-sm text-muted-foreground">还没有上报。</p>}
          {days.map((day) => {
            const tokens = day.inputTokens + day.outputTokens;
            return (
              <div key={day.date} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-xs">
                <span>{day.date}</span>
                <span className="h-2 rounded-full bg-muted">
                  <span
                    className="block h-2 rounded-full bg-[#c9643b]"
                    style={{ width: `${Math.max(4, (tokens / maxTokens) * 100)}%` }}
                  />
                </span>
                <span className="tabular-nums">
                  {formatNumber(tokens)} · ${day.costUsd.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
        <h3 className="mb-2 mt-6 text-sm font-medium">按供应商</h3>
        <ul className="space-y-1 text-sm">
          {byProvider.map((row) => (
            <li key={`${row.providerId}/${row.model}`}>
              {row.providerId} / {row.model}：{formatNumber(row.inputTokens + row.outputTokens)} tokens
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          企业网关精确计量（可对账）：{gateway.requests} 次请求，
          {formatNumber(gateway.inputTokens + gateway.outputTokens)} tokens。
          设备上报覆盖官方订阅和直连，数字由客户端提供。
        </p>
      </Card>
    </div>
  );
}
