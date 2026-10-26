import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { usageRecords } from "../db/schema.ts";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  model?: string;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
};

export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** input + output tokens per provider used by the user since UTC midnight. */
export async function tokensUsedTodayByProvider(
  db: Db,
  userId: string,
  providerId?: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      providerId: usageRecords.providerId,
      total:
        sql<number>`coalesce(sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens}), 0)`.mapWith(
          Number,
        ),
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.userId, userId),
        gte(usageRecords.createdAt, startOfUtcDay()),
        providerId === undefined
          ? undefined
          : eq(usageRecords.providerId, providerId),
      ),
    )
    .groupBy(usageRecords.providerId);
  return new Map(rows.map((r) => [r.providerId, r.total]));
}

export async function tokensUsedToday(
  db: Db,
  userId: string,
  providerId: string,
): Promise<number> {
  const map = await tokensUsedTodayByProvider(db, userId, providerId);
  return map.get(providerId) ?? 0;
}

const toCount = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

/** Reads an OpenAI Responses API `usage` object; null when absent/malformed. */
export function readUsage(value: unknown, model?: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const u = value as Record<string, unknown>;
  if (
    typeof u.input_tokens !== "number" &&
    typeof u.output_tokens !== "number" &&
    typeof u.prompt_tokens !== "number" &&
    typeof u.completion_tokens !== "number"
  )
    return null;
  const details = (u.input_tokens_details ?? u.prompt_tokens_details) as
    | Record<string, unknown>
    | null
    | undefined;
  return {
    inputTokens: toCount(u.input_tokens ?? u.prompt_tokens),
    outputTokens: toCount(u.output_tokens ?? u.completion_tokens),
    cachedTokens:
      toCount(details?.cached_tokens) ||
      toCount(u.cache_read_input_tokens) ||
      toCount(u.prompt_cache_hit_tokens),
    cacheCreationTokens:
      toCount(details?.cache_write_tokens) ||
      toCount(u.cache_write_input_tokens) ||
      toCount(u.cache_creation_input_tokens),
    ...(typeof model === "string" && model.trim()
      ? { model: model.trim() }
      : {}),
  };
}
