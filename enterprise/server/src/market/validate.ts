import type { MarketItemKind } from "@ccse/contracts";
import { type UnzipFileInfo, unzipSync } from "fflate";
import { AppError } from "../errors.ts";

export const MAX_ZIP_ENTRIES = 5000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

const invalid = (message: string) =>
  new AppError(400, "bad_request", `Invalid package: ${message}`);

/** Thrown from inside the fflate filter to abort the central-directory scan. */
class TooManyEntries extends Error {}

function isUnsafeName(name: string): boolean {
  if (name.length === 0) return true;
  if (name.includes("\\") || name.includes("\0")) return true;
  if (name.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(name)) return true;
  const segments = name.split("/");
  // Allow a single trailing "" for directory entries ("dir/"), nothing else.
  const body = name.endsWith("/") ? segments.slice(0, -1) : segments;
  return body.some((s) => s === "" || s === "." || s === "..");
}

function isJunk(name: string): boolean {
  if (name === "__MACOSX/" || name.startsWith("__MACOSX/")) return true;
  const base = name.endsWith("/") ? "" : name.slice(name.lastIndexOf("/") + 1);
  return base === ".DS_Store";
}

/** Lists entries from the central directory without inflating anything. */
function listEntries(buf: Uint8Array): UnzipFileInfo[] {
  const entries: UnzipFileInfo[] = [];
  try {
    unzipSync(buf, {
      filter: (info) => {
        entries.push({ ...info });
        if (entries.length > MAX_ZIP_ENTRIES) throw new TooManyEntries();
        return false;
      },
    });
  } catch (err) {
    if (err instanceof TooManyEntries) {
      throw invalid(`more than ${MAX_ZIP_ENTRIES} entries`);
    }
    throw invalid("not a readable zip archive");
  }
  return entries;
}

/** Inflates a single (small) entry. */
function readEntry(buf: Uint8Array, name: string): Uint8Array {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, { filter: (info) => info.name === name });
  } catch {
    throw invalid(`cannot read ${name}`);
  }
  const data = files[name];
  if (!data) throw invalid(`cannot read ${name}`);
  return data;
}

/** "" or "<folder>/" when every relevant entry lives inside one folder. */
function detectRoot(names: string[]): string {
  let first: string | null = null;
  for (const name of names) {
    const slash = name.indexOf("/");
    if (slash < 0) return ""; // a file at the archive root
    const top = name.slice(0, slash);
    if (first === null) first = top;
    else if (first !== top) return "";
  }
  return first === null ? "" : `${first}/`;
}

export interface ValidatedPackage {
  root: string;
  entryCount: number;
}

/**
 * Validates a market package zip for `kind` without inflating its content
 * (only the manifest is inflated). Throws 400 AppError on any problem.
 */
export function validateMarketPackage(
  buf: Uint8Array,
  kind: Exclude<MarketItemKind, "mcp">,
  id: string,
): ValidatedPackage {
  const entries = listEntries(buf);
  if (entries.length === 0) throw invalid("archive is empty");

  let total = 0;
  for (const e of entries) {
    if (isUnsafeName(e.name)) throw invalid("unsafe entry path");
    total += e.originalSize;
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw invalid(
        `uncompressed size exceeds ${MAX_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024} MB`,
      );
    }
  }

  const relevant = entries.filter((e) => !isJunk(e.name));
  if (relevant.length === 0) throw invalid("archive is empty");
  const root = detectRoot(relevant.map((e) => e.name));

  const manifestName =
    kind === "skill" ? `${root}SKILL.md` : `${root}.codex-plugin/plugin.json`;
  const manifest = relevant.find((e) => e.name === manifestName);
  if (!manifest) {
    throw invalid(
      kind === "skill"
        ? "a skill package must contain SKILL.md at its root"
        : "a plugin package must contain .codex-plugin/plugin.json at its root",
    );
  }
  if (
    manifest.originalSize > MAX_MANIFEST_BYTES ||
    manifest.size > MAX_MANIFEST_BYTES
  ) {
    throw invalid(`${manifestName} is too large`);
  }

  if (kind === "plugin") {
    const data = readEntry(buf, manifestName);
    if (data.length > MAX_MANIFEST_BYTES) {
      throw invalid(`${manifestName} is too large`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(data),
      );
    } catch {
      throw invalid("plugin.json is not valid JSON");
    }
    const name =
      typeof parsed === "object" && parsed !== null && "name" in parsed
        ? (parsed as { name: unknown }).name
        : undefined;
    if (typeof name !== "string") {
      throw invalid('plugin.json must have a string "name"');
    }
    if (name !== id) {
      throw invalid(
        `plugin.json "name" (${JSON.stringify(name.slice(0, 64))}) must equal the item id "${id}"`,
      );
    }
  }

  return { root, entryCount: entries.length };
}
