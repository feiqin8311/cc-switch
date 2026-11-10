import {
  type ReconciledUsageRow,
  UpstreamUsageSummaryQuerySchema,
  UsageQuerySchema,
} from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf, requireAnyPermission } from "../auth/guard.ts";
import { AppError, parseBody } from "../errors.ts";
import { estimateCostUsd } from "../gateway/pricing.ts";
import {
  emptyUsageSummary,
  readUpstreamSummary,
  readUpstreamUsageOptions,
} from "../usage/read-upstream-summary.ts";

const DAY = 86_400_000;

function usageRange(range: { from: string; to: string }) {
  const parse = (value: string) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value)
      throw new AppError(400, "bad_request", "Invalid date");
    return +date;
  };
  const from = parse(range.from);
  const to = parse(range.to) + DAY;
  if (to <= from || to - from > 92 * DAY)
    throw new AppError(400, "bad_request", "Invalid usage date range");
  return { from, to };
}

export async function reconciledUsageRoutes(
  app: FastifyInstance,
  { config, authenticate, syncUsage, readUpstreamUsage }: AppDeps,
) {
  const guard = [
    authenticate,
    requireAnyPermission("audit.read", "usage.read", "usage.group.read"),
  ];
  app.get(
    "/admin/usage/upstream/options",
    { preHandler: guard },
    async (req) => {
      if (!config.sub2api) return { users: [], groups: [], providers: [] };
      const actor = authOf(req).user;
      try {
        return await readUpstreamUsageOptions(
          config.sub2api,
          actor.role === "group_leader" ? actor.groupName : null,
          actor.role === "admin" ? null : actor.upstreamAccountIds,
        );
      } catch (error) {
        req.log.warn({ err: error }, "upstream usage filter options failed");
        throw new AppError(502, "upstream_error", "读取上游筛选列表失败");
      }
    },
  );
  app.post(
    "/admin/usage/upstream/summary",
    { preHandler: guard },
    async (req) => {
      const query = parseBody(UpstreamUsageSummaryQuerySchema, req.body);
      usageRange(query);
      if (!config.sub2api)
        return {
          totals: emptyUsageSummary(),
          configured: false,
          syncedAt: null,
        };
      const actor = authOf(req).user;
      if (actor.role === "group_leader") {
        if (
          !actor.groupName.trim() ||
          (query.groups.length > 0 && !query.groups.includes(actor.groupName))
        )
          return {
            totals: emptyUsageSummary(),
            configured: true,
            syncedAt: new Date().toISOString(),
          };
        query.groups = [actor.groupName];
      }
      try {
        return {
          totals: await readUpstreamSummary(config.sub2api, query),
          configured: true,
          syncedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        req.log.warn({ err: error }, "upstream usage summary failed");
        throw new AppError(
          502,
          "upstream_error",
          "读取上游概览失败，请稍后重试",
        );
      }
    },
  );
  app.get(
    "/admin/usage/upstream",
    {
      preHandler: guard,
    },
    async (req) => {
      const range = parseBody(UsageQuerySchema, req.query);
      const { from, to } = usageRange(range);
      const actor = authOf(req).user;
      if (readUpstreamUsage) {
        const items = await readUpstreamUsage(
          new Date(from),
          new Date(to),
          actor.role === "group_leader" ? actor.groupName : null,
        );
        return { items, configured: true, syncedAt: new Date().toISOString() };
      }
      if (!syncUsage || !config.sub2api)
        return { items: [], configured: false, syncedAt: null };
      const records = await syncUsage(range.from, range.to);
      const items = new Map<string, ReconciledUsageRow>();
      for (const record of records) {
        const timestamp = Date.parse(record.createdAt);
        if (timestamp < from || timestamp >= to) continue;
        if (
          actor.role === "group_leader" &&
          (!actor.groupName.trim() || record.groupName !== actor.groupName)
        )
          continue;
        const id = `upstream-key:${record.apiKeyId}`;
        const groupName = record.groupName ?? "";
        const providerId = record.accountName ?? "API Hub";
        const date = new Date(timestamp).toISOString().slice(0, 10);
        const key = JSON.stringify([
          date,
          record.apiKeyId,
          groupName,
          providerId,
          record.model,
        ]);
        let item = items.get(key);
        if (!item) {
          item = {
            source: "upstream",
            date,
            userId: id,
            username: record.apiKeyName ?? `API 密钥 #${record.apiKeyId}`,
            groupName,
            providerId,
            model: record.model,
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: null,
            actualRequests: 0,
            estimatedRequests: 0,
            unpricedRequests: 0,
            legacyRequests: 0,
          };
          items.set(key, item);
        }
        const cost =
          record.actualCost ??
          (record.imageCount ||
          record.imageInputTokens ||
          record.imageOutputTokens
            ? null
            : estimateCostUsd(
                record.model,
                record.inputTokens,
                record.outputTokens,
                record.cacheReadTokens,
                record.cacheCreationTokens,
              ));
        item.requests++;
        item.inputTokens +=
          record.inputTokens +
          record.cacheReadTokens +
          record.cacheCreationTokens;
        item.outputTokens += record.outputTokens;
        item.cachedTokens += record.cacheReadTokens;
        item.cacheCreationTokens += record.cacheCreationTokens;
        if (record.actualCost !== null) item.actualRequests++;
        else if (cost !== null) item.estimatedRequests++;
        else item.unpricedRequests = (item.unpricedRequests ?? 0) + 1;
        if (cost !== null)
          item.estimatedCostUsd = (item.estimatedCostUsd ?? 0) + cost;
      }
      return {
        items: [...items.values()],
        configured: true,
        syncedAt: new Date().toISOString(),
      };
    },
  );
}
