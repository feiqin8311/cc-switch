import {
  type AdminFleet,
  type AdminFleetProvider,
  AdminFleetSchema,
  type FleetMode,
  ListDevicesResponseSchema,
  type PutFleetRequest,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  inputClass,
  textareaClass,
  LoadingState,
  Notice,
  PageHeader,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  trClass,
} from "../components/ui";
import { useApi } from "../lib/auth";
import { describeError, fieldErrorsOf, formatDateTime } from "../lib/format";

const FLEET_KEY = ["admin", "fleet"] as const;
const DEVICES_KEY = ["admin", "devices"] as const;

const MODE_LABEL: Record<FleetMode, string> = {
  direct: "直连",
  route: "路由",
  stack: "聚合",
};

interface Draft {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  modelsText: string;
  apiKey: string;
  hint: string;
}

function toDraft(p: AdminFleetProvider): Draft {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    modelsText: p.models
      .map((m) => (m.displayName !== m.id ? `${m.id} | ${m.displayName}` : m.id))
      .join("\n"),
    apiKey: "",
    hint: p.apiKeyHint,
  };
}

function parseModels(text: string, model: string) {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      const id = (parts[0] ?? "").trim();
      const displayName = parts.slice(1).join("|").trim();
      return { id, displayName: displayName || id };
    })
    .filter((m) => m.id.length > 0);
  if (model && !rows.some((row) => row.id === model)) {
    rows.unshift({ id: model, displayName: model });
  }
  return rows.length > 0 ? rows : undefined;
}

export function DevicesPage() {
  const client = useApi();
  const fleet = useQuery({
    queryKey: FLEET_KEY,
    queryFn: ({ signal }) => client.get("/admin/fleet", AdminFleetSchema, signal),
  });
  const devices = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: ({ signal }) =>
      client.get("/admin/devices", ListDevicesResponseSchema, signal),
    refetchInterval: 30_000,
  });

  return (
    <div>
      <PageHeader
        title="设备配置"
        description="一份 Codex 配置下发到所有已登录的电脑。各台机器上报自己套用到哪一版。"
      />
      <div className="mb-4">
        <Notice>
          客户端大约每 30 秒拉取一次。路由和聚合只在 CC Switch
          开着时保持，退出后会写回直连。聚合名单变化后，那台电脑上的 Codex
          桌面版需要完全退出再打开。下发的供应商在客户端只读。
        </Notice>
      </div>
      <Card className="mb-8 p-6 md:p-8">
        {fleet.isPending ? (
          <LoadingState />
        ) : fleet.isError ? (
          <ErrorState error={fleet.error} onRetry={() => fleet.refetch()} />
        ) : (
          <FleetForm key={fleet.data.revision} initial={fleet.data} />
        )}
      </Card>
      <h2 className="mb-3 font-serif text-sm font-medium text-foreground">
        电脑
      </h2>
      <Card className="overflow-x-auto">
        {devices.isPending ? (
          <LoadingState />
        ) : devices.isError ? (
          <ErrorState error={devices.error} onRetry={() => devices.refetch()} />
        ) : devices.data.items.length === 0 ? (
          <EmptyState
            icon={<Monitor className="size-6 stroke-[1.5]" />}
            title="还没有电脑上报"
          >
            员工在桌面端登录后，这台电脑会出现在这里。
          </EmptyState>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>电脑</th>
                <th className={thClass}>用户</th>
                <th className={thClass}>当前</th>
                <th className={thClass}>套用</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>错误</th>
              </tr>
            </thead>
            <tbody>
              {devices.data.items.map((d) => (
                <tr key={d.id} className={trClass}>
                  <td className={tdClass}>
                    <div>{d.name}</div>
                    <div className="text-xs text-muted-foreground">{d.hostname}</div>
                  </td>
                  <td className={tdClass}>{d.username}</td>
                  <td className={tdClass}>
                    {MODE_LABEL[d.reported.mode]}
                    {d.reported.activeProviderName
                      ? ` · ${d.reported.activeProviderName}`
                      : ""}
                  </td>
                  <td className={`${tdClass} font-mono`}>
                    {d.appliedRevision}/{d.desiredRevision}
                  </td>
                  <td className={tdClass}>
                    <Badge tone={d.online ? "green" : "gray"}>
                      {d.online ? "在线" : "离线"}
                    </Badge>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {formatDateTime(d.lastSeenAt)}
                    </div>
                  </td>
                  <td className={`${tdClass} max-w-64 text-destructive`}>
                    {d.applyError ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function FleetForm({ initial }: { initial: AdminFleet }) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<FleetMode>(initial.mode);
  const [active, setActive] = useState(initial.activeProviderId);
  const [members, setMembers] = useState<string[]>(initial.stackMemberIds);
  const [providers, setProviders] = useState<Draft[]>(
    initial.providers.map(toDraft),
  );
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: PutFleetRequest) =>
      client.request("/admin/fleet", {
        method: "PUT",
        body,
        schema: AdminFleetSchema,
      }),
    onSuccess: (saved) => {
      qc.setQueryData(FLEET_KEY, saved);
      qc.invalidateQueries({ queryKey: DEVICES_KEY });
      toast.success(`已保存，版本 ${saved.revision}`);
      setFormError(null);
    },
    onError: (err) => {
      const fields = fieldErrorsOf(err);
      const detail = Object.entries(fields)
        .map(([path, message]) => `${path}: ${message}`)
        .join("；");
      setFormError(detail || describeError(err));
    },
  });

  const ids = providers.map((p) => p.id).filter(Boolean);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const body: PutFleetRequest = {
      mode,
      activeProviderId: providers.length === 0 ? "" : active,
      stackMemberIds:
        mode === "stack" ? members.filter((id) => id !== active && ids.includes(id)) : [],
      providers: providers.map((p) => ({
        id: p.id.trim(),
        name: p.name.trim(),
        baseUrl: p.baseUrl.trim(),
        model: p.model.trim(),
        models: parseModels(p.modelsText, p.model.trim()),
        ...(p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}),
      })),
    };
    save.mutate(body);
  };

  const patch = (index: number, next: Partial<Draft>) => {
    setProviders((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...next } : row)),
    );
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <div className="text-xs text-muted-foreground">当前版本 {initial.revision}</div>
      <Field label="模式" htmlFor="fleet-mode">
        <select
          id="fleet-mode"
          className={inputClass}
          value={mode}
          onChange={(e) => setMode(e.target.value as FleetMode)}
        >
          <option value="direct">直连</option>
          <option value="route">路由</option>
          <option value="stack">聚合</option>
        </select>
      </Field>
      {providers.map((p, index) => (
        <div
          key={index}
          className="grid gap-3 rounded-2xl border border-border/80 bg-card p-4 md:grid-cols-2"
        >
          <Field label="ID" required>
            <input
              className={inputClass}
              value={p.id}
              onChange={(e) => patch(index, { id: e.target.value })}
              placeholder="volcengine"
              autoComplete="off"
            />
          </Field>
          <Field label="名称" required>
            <input
              className={inputClass}
              value={p.name}
              onChange={(e) => patch(index, { name: e.target.value })}
            />
          </Field>
          <Field label="地址" required className="md:col-span-2">
            <input
              className={inputClass}
              value={p.baseUrl}
              onChange={(e) => patch(index, { baseUrl: e.target.value })}
              placeholder="https://example.com/v1"
            />
          </Field>
          <Field
            label="API Key"
            hint={p.hint ? `已保存 ${p.hint}，留空则不修改` : "新供应商必填"}
            className="md:col-span-2"
          >
            <input
              className={inputClass}
              type="password"
              value={p.apiKey}
              onChange={(e) => patch(index, { apiKey: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Field label="当前模型" required>
            <input
              className={inputClass}
              value={p.model}
              onChange={(e) => patch(index, { model: e.target.value })}
            />
          </Field>
          <Field label="模型列表" hint="每行一个，可用 id | 显示名">
            <textarea
              className={textareaClass}
              value={p.modelsText}
              onChange={(e) => patch(index, { modelsText: e.target.value })}
            />
          </Field>
          <div className="md:col-span-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const id = providers[index]?.id;
                setProviders((rows) => rows.filter((_, i) => i !== index));
                if (id && id === active) setActive("");
                if (id) setMembers((ids) => ids.filter((m) => m !== id));
              }}
            >
              <Trash2 className="size-3.5" />
              移除
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          onClick={() =>
            setProviders((rows) => [
              ...rows,
              {
                id: "",
                name: "",
                baseUrl: "",
                model: "",
                modelsText: "",
                apiKey: "",
                hint: "",
              },
            ])
          }
        >
          <Plus className="size-4" />
          添加供应商
        </Button>
      </div>
      {ids.length > 0 && (
        <Field label={mode === "stack" ? "聚合默认供应商" : "生效供应商"} htmlFor="fleet-active">
          <select
            id="fleet-active"
            className={inputClass}
            value={active}
            onChange={(e) => setActive(e.target.value)}
          >
            <option value="">请选择</option>
            {providers
              .filter((p) => p.id.trim())
              .map((p) => (
                <option key={p.id} value={p.id.trim()}>
                  {p.name || p.id} ({p.id.trim()})
                </option>
              ))}
          </select>
        </Field>
      )}
      {mode === "stack" && ids.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-semibold text-foreground">
            其他聚合供应商
          </legend>
          {providers
            .filter((p) => p.id.trim() && p.id.trim() !== active)
            .map((p) => {
              const id = p.id.trim();
              return (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={members.includes(id)}
                    onChange={(e) =>
                      setMembers((cur) =>
                        e.target.checked
                          ? [...cur, id]
                          : cur.filter((m) => m !== id),
                      )
                    }
                  />
                  {p.name || id}
                </label>
              );
            })}
        </fieldset>
      )}
      {formError && <InlineError>{formError}</InlineError>}
      <div>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          保存并下发
        </Button>
      </div>
    </form>
  );
}
