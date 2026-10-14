import {
  MAX_MARKET_PACKAGE_BYTES,
  MAX_MCP_DEFINITION_BYTES,
  MAX_PROMPT_DEFINITION_BYTES,
  type MarketItem,
  type MarketItemKind,
  MarketItemKindSchema,
  type McpDefinition,
  McpDefinitionSchema,
  type PromptDefinition,
  PromptDefinitionSchema,
} from "@ccse/contracts";
import { type FormEvent, useState } from "react";
import { Field, inputClass, Switch, textareaClass } from "../components/ui";
import { formatBytes } from "../lib/format";

const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

interface MarketUploadMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  mandatory: boolean;
}

/** skill / plugin upload a zip; mcp and prompt upload a JSON definition. */
export type MarketUploadValues = MarketUploadMetadata &
  (
    | { kind: Exclude<MarketItemKind, "mcp" | "prompt">; file: File }
    | { kind: "mcp"; definition: McpDefinition }
    | { kind: "prompt"; definition: PromptDefinition }
  );

export const KIND_LABELS: Record<MarketItemKind, string> = {
  skill: "技能 (Skill)",
  plugin: "插件 (Plugin)",
  mcp: "MCP",
  prompt: "提示词",
};

/** Kinds whose package is a JSON definition rather than a zip. */
export function isJsonKind(kind: MarketItemKind): kind is "mcp" | "prompt" {
  return kind === "mcp" || kind === "prompt";
}

const ALL_KINDS: readonly MarketItemKind[] = MarketItemKindSchema.options;

export const DEFAULT_MCP_DEFINITION = `{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
}`;

const MCP_HINT =
  "stdio 填 command/args/env，http/sse 填 url/headers。env 和 headers 会下发给所有有安装权限的员工，不要放个人密钥。";

/** Parses and validates the MCP JSON text; returns the definition or a message. */
export function parseMcpDefinition(
  text: string,
): { definition: McpDefinition } | { error: string } {
  if (!text.trim()) return { error: "请填写 MCP 配置" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "JSON 格式不正确" };
  }
  const parsed = McpDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    return {
      error: `MCP 配置不符合要求：${path ? `${path} ` : ""}${issue?.message ?? ""}`,
    };
  }
  const size = new TextEncoder().encode(JSON.stringify(parsed.data)).length;
  if (size > MAX_MCP_DEFINITION_BYTES)
    return {
      error: `MCP 配置 ${formatBytes(size)}，超过 ${formatBytes(MAX_MCP_DEFINITION_BYTES)} 上限`,
    };
  return { definition: parsed.data };
}

const PROMPT_PLACEHOLDER = `# 团队约定
- 回答使用中文
- 修改代码前先阅读相关模块
- 提交前运行测试`;

const PROMPT_HINT =
  "必装的提示词会自动启用并覆盖员工当前的 AGENTS.md（原内容会在本机备份）。";

/** Validates the prompt Markdown; returns the definition or a message. */
export function parsePromptDefinition(
  text: string,
): { definition: PromptDefinition } | { error: string } {
  if (!text.trim()) return { error: "请填写提示词内容" };
  const parsed = PromptDefinitionSchema.safeParse({ content: text });
  if (!parsed.success) return { error: "请填写提示词内容" };
  const size = new TextEncoder().encode(JSON.stringify(parsed.data)).length;
  if (size > MAX_PROMPT_DEFINITION_BYTES)
    return {
      error: `提示词 ${formatBytes(size)}，超过 ${formatBytes(MAX_PROMPT_DEFINITION_BYTES)} 上限`,
    };
  return { definition: parsed.data };
}

export function validatePackageFile(file: File | null): string | null {
  if (!file) return "请选择 .zip 文件";
  if (!file.name.toLowerCase().endsWith(".zip")) return "只支持 .zip 文件";
  if (file.size === 0) return "文件为空";
  if (file.size > MAX_MARKET_PACKAGE_BYTES)
    return `文件大小 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_MARKET_PACKAGE_BYTES)} 上限`;
  return null;
}

/**
 * Metadata + package picker (zip, MCP JSON or prompt Markdown). `kinds` limits
 * the offered kinds; with a single kind there is no kind select. `existing`
 * switches to "publish a new version": the id and kind are fixed and the other
 * fields are prefilled; `initialDefinition` prefills the MCP JSON / prompt
 * Markdown of an existing item.
 */
export function MarketUploadForm({
  formId,
  kinds = ALL_KINDS,
  existing,
  initialDefinition,
  serverErrors,
  onSubmit,
}: {
  formId: string;
  kinds?: readonly MarketItemKind[];
  existing?: MarketItem;
  initialDefinition?: string;
  serverErrors?: Record<string, string>;
  onSubmit(values: MarketUploadValues): void;
}) {
  const [id, setId] = useState(existing?.id ?? "");
  const [kind, setKind] = useState<MarketItemKind>(
    existing?.kind ?? kinds[0] ?? "skill",
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [version, setVersion] = useState("");
  const [mandatory, setMandatory] = useState(existing?.mandatory ?? false);
  const [file, setFile] = useState<File | null>(null);
  const [definitionText, setDefinitionText] = useState(
    existing
      ? existing.kind === "mcp"
        ? (initialDefinition ?? "")
        : ""
      : DEFAULT_MCP_DEFINITION,
  );
  const [promptText, setPromptText] = useState(
    existing?.kind === "prompt" ? (initialDefinition ?? "") : "",
  );
  const showKindSelect = kinds.length > 1;
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const errors = { ...serverErrors, ...localErrors };

  const pickFile = (f: File | null) => {
    setFile(f);
    const problem = f ? validatePackageFile(f) : null;
    setLocalErrors(({ file: _old, ...rest }) =>
      problem ? { ...rest, file: problem } : rest,
    );
  };

  // The zip picker and the definition fields swap; drop their errors.
  const changeKind = (next: MarketItemKind) => {
    setKind(next);
    setFile(null);
    setLocalErrors(({ file: _f, definition: _d, ...rest }) => rest);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!ITEM_ID_RE.test(id.trim()))
      next.id = "2-32 位，仅限小写字母、数字和 '-'，且以字母或数字开头";
    if (!name.trim()) next.name = "请输入名称";
    else if (name.trim().length > 100) next.name = "名称最多 100 个字符";
    if (description.length > 1000) next.description = "描述最多 1000 个字符";
    if (!version.trim()) next.version = "请输入版本号";
    else if (version.trim().length > 50) next.version = "版本号最多 50 个字符";
    let mcp: McpDefinition | null = null;
    let prompt: PromptDefinition | null = null;
    if (kind === "mcp") {
      const result = parseMcpDefinition(definitionText);
      if ("error" in result) next.definition = result.error;
      else mcp = result.definition;
    } else if (kind === "prompt") {
      const result = parsePromptDefinition(promptText);
      if ("error" in result) next.definition = result.error;
      else prompt = result.definition;
    } else {
      const fileProblem = validatePackageFile(file);
      if (fileProblem) next.file = fileProblem;
    }
    setLocalErrors(next);
    if (Object.keys(next).length > 0) return;
    const meta = {
      id: id.trim(),
      name: name.trim(),
      description,
      version: version.trim(),
      mandatory,
    };
    if (kind === "mcp") {
      if (mcp) onSubmit({ ...meta, kind, definition: mcp });
    } else if (kind === "prompt") {
      if (prompt) onSubmit({ ...meta, kind, definition: prompt });
    } else if (file) {
      onSubmit({ ...meta, kind, file });
    }
  };

  return (
    <form
      id={formId}
      noValidate
      onSubmit={handleSubmit}
      className="grid grid-cols-2 gap-3"
    >
      <Field
        label="ID"
        htmlFor="mu-id"
        required
        error={errors.id}
        className={showKindSelect ? undefined : "col-span-2"}
        hint={
          kind === "plugin"
            ? "插件 ID 同时作为 Codex 插件名"
            : kind === "mcp"
              ? "ID 同时作为客户端中的 MCP 服务器名"
              : "唯一标识，发布后不可修改"
        }
      >
        <input
          id="mu-id"
          className={`${inputClass} font-mono`}
          aria-invalid={!!errors.id}
          disabled={!!existing}
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
      </Field>
      {showKindSelect && (
        <Field label="类型" htmlFor="mu-kind" required error={errors.kind}>
          <select
            id="mu-kind"
            className={inputClass}
            disabled={!!existing}
            value={kind}
            onChange={(e) => changeKind(e.target.value as MarketItemKind)}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="名称" htmlFor="mu-name" required error={errors.name}>
        <input
          id="mu-name"
          className={inputClass}
          aria-invalid={!!errors.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field
        label="版本"
        htmlFor="mu-version"
        required
        error={errors.version}
        hint={existing ? `当前版本：${existing.version}` : undefined}
      >
        <input
          id="mu-version"
          className={`${inputClass} font-mono`}
          aria-invalid={!!errors.version}
          placeholder="1.0.0"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        />
      </Field>
      <Field
        label="描述"
        htmlFor="mu-description"
        error={errors.description}
        className="col-span-2"
      >
        <textarea
          id="mu-description"
          rows={3}
          className={textareaClass}
          aria-invalid={!!errors.description}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      {kind === "mcp" ? (
        <Field
          label="MCP 配置（JSON）"
          htmlFor="mu-definition"
          required
          error={errors.definition}
          hint={MCP_HINT}
          className="col-span-2"
        >
          <textarea
            id="mu-definition"
            rows={10}
            spellCheck={false}
            className={`${textareaClass} font-mono`}
            aria-invalid={!!errors.definition}
            value={definitionText}
            onChange={(e) => setDefinitionText(e.target.value)}
          />
        </Field>
      ) : kind === "prompt" ? (
        <Field
          label="提示词内容（Markdown）"
          htmlFor="mu-prompt"
          required
          error={errors.definition}
          hint={PROMPT_HINT}
          className="col-span-2"
        >
          <textarea
            id="mu-prompt"
            rows={16}
            spellCheck={false}
            className={`${textareaClass} font-mono`}
            aria-invalid={!!errors.definition}
            placeholder={PROMPT_PLACEHOLDER}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
          />
        </Field>
      ) : (
        <Field
          label="安装包（.zip）"
          htmlFor="mu-file"
          required
          error={errors.file}
          hint={
            file
              ? `${file.name}（${formatBytes(file.size)}）`
              : kind === "skill"
                ? "包含 SKILL.md 的技能目录（zip 根目录或唯一顶层文件夹），不超过 20 MB"
                : "包含 .codex-plugin/plugin.json 的插件目录（zip 根目录或唯一顶层文件夹），不超过 20 MB"
          }
          className="col-span-2"
        >
          <input
            id="mu-file"
            type="file"
            accept=".zip,application/zip"
            aria-invalid={!!errors.file}
            className="text-xs file:mr-3 file:rounded-lg file:border file:border-border/80 file:bg-secondary file:px-2.5 file:py-1 file:text-xs file:text-secondary-foreground file:font-medium hover:file:bg-secondary/80 file:cursor-pointer"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </Field>
      )}
      <Field label="必装" htmlFor="mu-mandatory" className="col-span-2">
        <div className="flex h-8 items-center gap-2">
          <Switch
            id="mu-mandatory"
            label="必装"
            checked={mandatory}
            onChange={setMandatory}
          />
          <span className="text-xs text-muted-foreground">
            {kind === "prompt"
              ? "必装的提示词会由客户端自动安装并启用"
              : "必装项会由客户端自动安装"}
          </span>
        </div>
      </Field>
    </form>
  );
}
