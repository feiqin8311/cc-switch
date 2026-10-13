import {
  MAX_MARKET_PACKAGE_BYTES,
  type MarketItem,
  type MarketItemKind,
} from "@ccse/contracts";
import { type FormEvent, useState } from "react";
import { Field, inputClass, Switch, textareaClass } from "../components/ui";
import { formatBytes } from "../lib/format";

const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export interface MarketUploadValues {
  id: string;
  kind: MarketItemKind;
  name: string;
  description: string;
  version: string;
  mandatory: boolean;
  file: File;
}

export const KIND_LABELS: Record<MarketItemKind, string> = {
  skill: "技能 (Skill)",
  plugin: "插件 (Plugin)",
};

export function validatePackageFile(file: File | null): string | null {
  if (!file) return "请选择 .zip 文件";
  if (!file.name.toLowerCase().endsWith(".zip")) return "只支持 .zip 文件";
  if (file.size === 0) return "文件为空";
  if (file.size > MAX_MARKET_PACKAGE_BYTES)
    return `文件大小 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_MARKET_PACKAGE_BYTES)} 上限`;
  return null;
}

/**
 * Metadata + package picker. `existing` switches to "publish a new version":
 * the id and kind are fixed and the other fields are prefilled.
 */
export function MarketUploadForm({
  formId,
  existing,
  serverErrors,
  onSubmit,
}: {
  formId: string;
  existing?: MarketItem;
  serverErrors?: Record<string, string>;
  onSubmit(values: MarketUploadValues): void;
}) {
  const [id, setId] = useState(existing?.id ?? "");
  const [kind, setKind] = useState<MarketItemKind>(existing?.kind ?? "skill");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [version, setVersion] = useState("");
  const [mandatory, setMandatory] = useState(existing?.mandatory ?? false);
  const [file, setFile] = useState<File | null>(null);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const errors = { ...serverErrors, ...localErrors };

  const pickFile = (f: File | null) => {
    setFile(f);
    const problem = f ? validatePackageFile(f) : null;
    setLocalErrors(({ file: _old, ...rest }) =>
      problem ? { ...rest, file: problem } : rest,
    );
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
    const fileProblem = validatePackageFile(file);
    if (fileProblem) next.file = fileProblem;
    setLocalErrors(next);
    if (Object.keys(next).length > 0 || !file) return;
    onSubmit({
      id: id.trim(),
      kind,
      name: name.trim(),
      description,
      version: version.trim(),
      mandatory,
      file,
    });
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
        hint={
          kind === "plugin"
            ? "插件 ID 同时作为 Codex 插件名"
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
      <Field label="类型" htmlFor="mu-kind" required error={errors.kind}>
        <select
          id="mu-kind"
          className={inputClass}
          disabled={!!existing}
          value={kind}
          onChange={(e) => setKind(e.target.value as MarketItemKind)}
        >
          <option value="skill">{KIND_LABELS.skill}</option>
          <option value="plugin">{KIND_LABELS.plugin}</option>
        </select>
      </Field>
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
      <Field label="必装" htmlFor="mu-mandatory" className="col-span-2">
        <div className="flex h-8 items-center gap-2">
          <Switch
            id="mu-mandatory"
            label="必装"
            checked={mandatory}
            onChange={setMandatory}
          />
          <span className="text-xs text-muted-foreground">
            必装项会由客户端自动安装
          </span>
        </div>
      </Field>
    </form>
  );
}
