import {
  type AdminProvider,
  GATEWAY_PREFIX,
  type Role,
  RoleSchema,
  type WireApi,
} from "@ccse/contracts";
import { type FormEvent, useRef, useState } from "react";
import { Button, Field, inputClass, Switch } from "../components/ui";
import { ROLE_LABELS } from "../lib/format";

const ROLES = RoleSchema.options;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export interface ModelRow {
  key: number;
  id: string;
  displayName: string;
}

export interface ProviderFormValues {
  id: string;
  name: string;
  baseUrl: string;
  wireApi: WireApi;
  apiKey: string;
  models: ModelRow[];
  defaultModel: string;
  allowedRoles: Role[];
  /** Empty = unlimited. */
  dailyLimit: string;
  enabled: boolean;
}

/** What the form submits; `apiKey` is omitted on edit when left empty. */
export interface ProviderPayload {
  id: string;
  name: string;
  baseUrl: string;
  wireApi: WireApi;
  apiKey?: string;
  models: { id: string; displayName: string }[];
  defaultModel: string;
  allowedRoles: Role[];
  dailyTokenLimitPerUser: number | null;
  enabled: boolean;
}

export type ProviderFormMode = "create" | "edit";

export function gatewayUrl(
  id: string,
  origin = window.location.origin,
): string {
  return `${origin}${GATEWAY_PREFIX}/${id}/v1`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Client-side mirror of CreateProviderRequestSchema; keys match the server's 400 paths. */
export function validateProvider(
  v: ProviderFormValues,
  mode: ProviderFormMode,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (mode === "create" && !PROVIDER_ID_RE.test(v.id.trim()))
    errors.id = "2-32 位，仅限小写字母、数字和 '-'，且以字母或数字开头";
  if (!v.name.trim()) errors.name = "请输入名称";
  else if (v.name.trim().length > 64) errors.name = "名称最多 64 个字符";
  if (!isHttpUrl(v.baseUrl.trim()))
    errors.baseUrl = "请输入 http(s) 地址，例如 https://api.openai.com/v1";
  if (mode === "create" && !v.apiKey.trim()) errors.apiKey = "请输入 API Key";
  if (v.apiKey.length > 512) errors.apiKey = "API Key 过长";

  if (v.models.length === 0) errors.models = "至少添加一个模型";
  else if (v.models.length > 100) errors.models = "最多 100 个模型";
  const seen = new Set<string>();
  v.models.forEach((m, i) => {
    const id = m.id.trim();
    if (!id) errors[`models.${i}.id`] = "请输入模型 ID";
    else if (id.length > 128) errors[`models.${i}.id`] = "最多 128 个字符";
    else if (seen.has(id)) errors[`models.${i}.id`] = "模型 ID 重复";
    seen.add(id);
    const name = m.displayName.trim();
    if (!name) errors[`models.${i}.displayName`] = "请输入显示名";
    else if (name.length > 128)
      errors[`models.${i}.displayName`] = "最多 128 个字符";
  });

  if (!v.defaultModel) errors.defaultModel = "请选择默认模型";
  else if (!v.models.some((m) => m.id.trim() === v.defaultModel))
    errors.defaultModel = "默认模型必须是模型列表中的一项";

  if (v.allowedRoles.length === 0) errors.allowedRoles = "至少选择一个角色";

  const limit = v.dailyLimit.trim();
  if (limit && !/^[1-9]\d*$/.test(limit))
    errors.dailyTokenLimitPerUser = "请输入正整数，留空表示不限";
  else if (limit && !Number.isSafeInteger(Number(limit)))
    errors.dailyTokenLimitPerUser = "数值过大";
  return errors;
}

export function toPayload(
  v: ProviderFormValues,
  mode: ProviderFormMode,
): ProviderPayload {
  const apiKey = v.apiKey.trim();
  const limit = v.dailyLimit.trim();
  return {
    id: v.id.trim(),
    name: v.name.trim(),
    baseUrl: v.baseUrl.trim(),
    wireApi: v.wireApi,
    ...(mode === "create" || apiKey ? { apiKey } : {}),
    models: v.models.map((m) => ({
      id: m.id.trim(),
      displayName: m.displayName.trim(),
    })),
    defaultModel: v.defaultModel,
    allowedRoles: ROLES.filter((r) => v.allowedRoles.includes(r)),
    dailyTokenLimitPerUser: limit ? Number(limit) : null,
    enabled: v.enabled,
  };
}

function initialValues(
  provider: AdminProvider | undefined,
  nextKey: () => number,
): ProviderFormValues {
  if (!provider) {
    return {
      id: "",
      name: "",
      baseUrl: "",
      wireApi: "responses",
      apiKey: "",
      models: [{ key: nextKey(), id: "", displayName: "" }],
      defaultModel: "",
      allowedRoles: ["admin", "member"],
      dailyLimit: "",
      enabled: true,
    };
  }
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    wireApi: provider.wireApi ?? "responses",
    apiKey: "",
    models: provider.models.map((m) => ({ key: nextKey(), ...m })),
    defaultModel: provider.defaultModel,
    allowedRoles: [...provider.allowedRoles],
    dailyLimit:
      provider.dailyTokenLimitPerUser === null
        ? ""
        : String(provider.dailyTokenLimitPerUser),
    enabled: provider.enabled,
  };
}

export function ProviderForm({
  formId,
  mode,
  provider,
  serverErrors,
  onSubmit,
}: {
  formId: string;
  mode: ProviderFormMode;
  /** Required for `edit`. */
  provider?: AdminProvider;
  /** Field errors from a 400 response, keyed by dotted path. */
  serverErrors?: Record<string, string>;
  onSubmit(payload: ProviderPayload): void;
}) {
  const keyRef = useRef(0);
  const nextKey = () => {
    keyRef.current += 1;
    return keyRef.current;
  };
  const [values, setValues] = useState<ProviderFormValues>(() =>
    initialValues(provider, nextKey),
  );
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const errors = { ...serverErrors, ...localErrors };

  const set = <K extends keyof ProviderFormValues>(
    key: K,
    value: ProviderFormValues[K],
  ) => setValues((v) => ({ ...v, [key]: value }));

  const updateModel = (key: number, patch: Partial<ModelRow>) =>
    setValues((v) => {
      const row = v.models.find((m) => m.key === key);
      // Renaming the default model keeps it selected.
      const defaultModel =
        row && patch.id !== undefined && v.defaultModel === row.id.trim()
          ? patch.id.trim()
          : v.defaultModel;
      return {
        ...v,
        defaultModel,
        models: v.models.map((m) => (m.key === key ? { ...m, ...patch } : m)),
      };
    });

  const addModel = () =>
    setValues((v) => ({
      ...v,
      models: [...v.models, { key: nextKey(), id: "", displayName: "" }],
    }));

  const removeModel = (key: number) =>
    setValues((v) => ({ ...v, models: v.models.filter((m) => m.key !== key) }));

  const toggleRole = (role: Role, on: boolean) =>
    setValues((v) => ({
      ...v,
      allowedRoles: on
        ? [...v.allowedRoles, role]
        : v.allowedRoles.filter((r) => r !== role),
    }));

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const found = validateProvider(values, mode);
    setLocalErrors(found);
    if (Object.keys(found).length > 0) return;
    onSubmit(toPayload(values, mode));
  };

  const modelIds = values.models.map((m) => m.id.trim()).filter(Boolean);
  const defaultValid = modelIds.includes(values.defaultModel);
  const idForHint = values.id.trim();

  return (
    <form
      id={formId}
      noValidate
      onSubmit={handleSubmit}
      className="grid grid-cols-2 gap-3"
    >
      <Field
        label="ID"
        htmlFor="pf-id"
        required={mode === "create"}
        error={errors.id}
        hint={
          idForHint && PROVIDER_ID_RE.test(idForHint) ? (
            <>
              网关地址：
              <code className="break-all">{gatewayUrl(idForHint)}</code>
            </>
          ) : (
            "创建后不可修改，用于网关路径"
          )
        }
      >
        <input
          id="pf-id"
          className={`${inputClass} font-mono`}
          aria-invalid={!!errors.id}
          value={values.id}
          disabled={mode === "edit"}
          placeholder="openai-main"
          onChange={(e) => set("id", e.target.value)}
        />
      </Field>
      <Field label="名称" htmlFor="pf-name" required error={errors.name}>
        <input
          id="pf-name"
          className={inputClass}
          aria-invalid={!!errors.name}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>
      <Field
        label="协议类型"
        htmlFor="pf-wire-api"
        required
        hint={
          values.wireApi === "chat_completions"
            ? "上游仅支持 Chat Completions（如 DeepSeek 等），网关会自动双向转换"
            : "上游支持 Responses API，网关原生追加 /responses"
        }
      >
        <select
          id="pf-wire-api"
          className={inputClass}
          value={values.wireApi}
          onChange={(e) => set("wireApi", e.target.value as WireApi)}
        >
          <option value="responses">OpenAI Responses API</option>
          <option value="chat_completions">OpenAI Chat Completions</option>
        </select>
      </Field>
      <Field
        label="上游地址"
        htmlFor="pf-base-url"
        required
        error={errors.baseUrl}
        hint={
          values.wireApi === "chat_completions"
            ? "网关会向该地址追加 /chat/completions"
            : "OpenAI Responses API 兼容的 base URL，网关会追加 /responses"
        }
      >
        <input
          id="pf-base-url"
          className={`${inputClass} font-mono`}
          aria-invalid={!!errors.baseUrl}
          value={values.baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => set("baseUrl", e.target.value)}
        />
      </Field>
      <Field
        label="API Key"
        htmlFor="pf-api-key"
        required={mode === "create"}
        error={errors.apiKey}
        hint={
          mode === "edit"
            ? `留空则不修改（当前：${provider?.apiKeyHint ?? "—"}）`
            : "仅保存在服务器，不会下发给客户端"
        }
        className="col-span-2"
      >
        <input
          id="pf-api-key"
          type="password"
          autoComplete="off"
          className={`${inputClass} font-mono`}
          aria-invalid={!!errors.apiKey}
          value={values.apiKey}
          placeholder={mode === "edit" ? "留空则不修改" : "sk-…"}
          onChange={(e) => set("apiKey", e.target.value)}
        />
      </Field>

      <fieldset className="col-span-2 flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          模型列表<span className="ml-0.5 text-red-500">*</span>
        </legend>
        {values.models.map((m, i) => (
          <div key={m.key} className="flex items-start gap-2">
            <div className="flex flex-1 flex-col gap-0.5">
              <input
                aria-label={`模型 ${i + 1} ID`}
                className={`${inputClass} font-mono`}
                aria-invalid={!!errors[`models.${i}.id`]}
                placeholder="模型 ID，如 gpt-5"
                value={m.id}
                onChange={(e) => updateModel(m.key, { id: e.target.value })}
              />
              {errors[`models.${i}.id`] && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {errors[`models.${i}.id`]}
                </p>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-0.5">
              <input
                aria-label={`模型 ${i + 1} 显示名`}
                className={inputClass}
                aria-invalid={!!errors[`models.${i}.displayName`]}
                placeholder="显示名"
                value={m.displayName}
                onChange={(e) =>
                  updateModel(m.key, { displayName: e.target.value })
                }
              />
              {errors[`models.${i}.displayName`] && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {errors[`models.${i}.displayName`]}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              aria-label={`删除模型 ${i + 1}`}
              onClick={() => removeModel(m.key)}
            >
              删除
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={addModel}>
            + 添加模型
          </Button>
        </div>
        {errors.models && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errors.models}
          </p>
        )}
      </fieldset>

      <Field
        label="默认模型"
        htmlFor="pf-default-model"
        required
        error={errors.defaultModel}
      >
        <select
          id="pf-default-model"
          className={inputClass}
          aria-invalid={!!errors.defaultModel}
          value={defaultValid ? values.defaultModel : ""}
          onChange={(e) => set("defaultModel", e.target.value)}
        >
          <option value="">请选择</option>
          {modelIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="每用户每日额度（tokens）"
        htmlFor="pf-limit"
        error={errors.dailyTokenLimitPerUser}
        hint="输入 + 输出 token，按 UTC 自然日计；留空 = 不限"
      >
        <input
          id="pf-limit"
          inputMode="numeric"
          className={inputClass}
          aria-invalid={!!errors.dailyTokenLimitPerUser}
          placeholder="不限"
          value={values.dailyLimit}
          onChange={(e) => set("dailyLimit", e.target.value)}
        />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          允许角色<span className="ml-0.5 text-red-500">*</span>
        </legend>
        <div className="flex h-8 items-center gap-4">
          {ROLES.map((r) => (
            <label key={r} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={values.allowedRoles.includes(r)}
                onChange={(e) => toggleRole(r, e.target.checked)}
              />
              {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
        {errors.allowedRoles ? (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errors.allowedRoles}
          </p>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            用户还需具备「使用模型」权限
          </p>
        )}
      </fieldset>
      <Field label="状态" htmlFor="pf-enabled">
        <div className="flex h-8 items-center gap-2">
          <Switch
            id="pf-enabled"
            label="启用"
            checked={values.enabled}
            onChange={(on) => set("enabled", on)}
          />
          <span className="text-sm">{values.enabled ? "启用" : "停用"}</span>
        </div>
      </Field>
    </form>
  );
}
