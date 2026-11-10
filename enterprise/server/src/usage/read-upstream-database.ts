import type { ReconciledUsageRow } from "@ccse/contracts";
import pg from "pg";
import { estimateCostUsd } from "../gateway/pricing.ts";

interface Queryable {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

// Keep one row per existing UI dimension so filters and tables use the same data.
const QUERY = `
  SELECT to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
    l.api_key_id, k.name AS key_name, g.name AS group_name,
    a.name AS account_name, l.model,
    count(*) AS requests,
    coalesce(sum(l.input_tokens), 0) AS input_tokens,
    coalesce(sum(l.output_tokens), 0) AS output_tokens,
    coalesce(sum(l.cache_read_tokens), 0) AS cache_read_tokens,
    coalesce(sum(l.cache_creation_tokens), 0) AS cache_creation_tokens,
    count(*) FILTER (WHERE l.actual_cost IS NOT NULL) AS actual_requests,
    sum(l.actual_cost) AS actual_cost,
    count(*) FILTER (WHERE l.actual_cost IS NULL AND coalesce(l.image_count, 0) = 0
      AND coalesce(l.image_input_tokens, 0) = 0 AND coalesce(l.image_output_tokens, 0) = 0) AS estimable_requests,
    coalesce(sum(l.input_tokens) FILTER (WHERE l.actual_cost IS NULL AND coalesce(l.image_count, 0) = 0
      AND coalesce(l.image_input_tokens, 0) = 0 AND coalesce(l.image_output_tokens, 0) = 0), 0) AS estimate_input,
    coalesce(sum(l.output_tokens) FILTER (WHERE l.actual_cost IS NULL AND coalesce(l.image_count, 0) = 0
      AND coalesce(l.image_input_tokens, 0) = 0 AND coalesce(l.image_output_tokens, 0) = 0), 0) AS estimate_output,
    coalesce(sum(l.cache_read_tokens) FILTER (WHERE l.actual_cost IS NULL AND coalesce(l.image_count, 0) = 0
      AND coalesce(l.image_input_tokens, 0) = 0 AND coalesce(l.image_output_tokens, 0) = 0), 0) AS estimate_cache_read,
    coalesce(sum(l.cache_creation_tokens) FILTER (WHERE l.actual_cost IS NULL AND coalesce(l.image_count, 0) = 0
      AND coalesce(l.image_input_tokens, 0) = 0 AND coalesce(l.image_output_tokens, 0) = 0), 0) AS estimate_cache_creation
  FROM public.usage_logs l
  LEFT JOIN public.api_keys k ON k.id = l.api_key_id
  LEFT JOIN public.groups g ON g.id = l.group_id
  LEFT JOIN public.accounts a ON a.id = l.account_id
  WHERE l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz
    AND ($3::text IS NULL OR g.name = $3)
  GROUP BY 1, l.api_key_id, k.name, g.name, a.name, l.model
`;

function number(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new Error("Invalid upstream usage aggregate");
  return n;
}

export async function queryUpstreamUsage(
  db: Queryable,
  from: Date,
  to: Date,
  groupName: string | null,
): Promise<ReconciledUsageRow[]> {
  // A group leader without a group must never receive unrestricted data.
  if (groupName !== null && !groupName.trim()) return [];
  const result = await db.query(QUERY, [
    from.toISOString(),
    to.toISOString(),
    groupName,
  ]);
  return result.rows.map((r) => {
    const requests = number(r.requests);
    const actualRequests = number(r.actual_requests);
    const estimableRequests = number(r.estimable_requests);
    const model = String(r.model);
    const estimate = estimableRequests
      ? estimateCostUsd(
          model,
          number(r.estimate_input),
          number(r.estimate_output),
          number(r.estimate_cache_read),
          number(r.estimate_cache_creation),
        )
      : null;
    const estimatedRequests = estimate === null ? 0 : estimableRequests;
    const actual = r.actual_cost === null ? null : number(r.actual_cost);
    const apiKeyId = String(r.api_key_id);
    return {
      source: "upstream" as const,
      date: String(r.date),
      userId: `upstream-key:${apiKeyId}`,
      username: r.key_name ? String(r.key_name) : `API key #${apiKeyId}`,
      groupName: r.group_name ? String(r.group_name) : "",
      providerId: r.account_name ? String(r.account_name) : "API Hub",
      model,
      requests,
      inputTokens:
        number(r.input_tokens) +
        number(r.cache_read_tokens) +
        number(r.cache_creation_tokens),
      outputTokens: number(r.output_tokens),
      cachedTokens: number(r.cache_read_tokens),
      cacheCreationTokens: number(r.cache_creation_tokens),
      estimatedCostUsd:
        actual === null && estimate === null
          ? null
          : (actual ?? 0) + (estimate ?? 0),
      actualRequests,
      estimatedRequests,
      unpricedRequests: requests - actualRequests - estimatedRequests,
      legacyRequests: 0,
    };
  });
}

export function createUpstreamDatabaseReader(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5000,
    options: "-c default_transaction_read_only=on -c statement_timeout=15000",
  });
  // An idle connection can fail after a network interruption; subsequent
  // queries will acquire a fresh connection instead of terminating the server.
  pool.on("error", () => {});
  return {
    read: (from: Date, to: Date, groupName: string | null) =>
      queryUpstreamUsage(pool, from, to, groupName),
    close: () => pool.end(),
  };
}
