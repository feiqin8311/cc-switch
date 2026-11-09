import { type ReconciledUsageRow, UsageQuerySchema } from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf, requireAnyPermission } from "../auth/guard.ts";
import { AppError, parseBody } from "../errors.ts";
import { estimateCostUsd } from "../gateway/pricing.ts";

const DAY = 86_400_000;

export async function reconciledUsageRoutes(
  app: FastifyInstance,
  { config, authenticate, syncUsage }: AppDeps,
) {
  app.get(
    "/admin/usage/upstream",
    {
      preHandler: [
        authenticate,
        requireAnyPermission("audit.read", "usage.read", "usage.group.read"),
      ],
    },
    async (req) => {
      const range = parseBody(UsageQuerySchema, req.query);
      const parse = (value: string) => {
        const date = new Date(`${value}T00:00:00.000Z`);
        if (
          !Number.isFinite(+date) ||
          date.toISOString().slice(0, 10) !== value
        )
          throw new AppError(400, "bad_request", "Invalid date");
        return +date;
      };
      const from = parse(range.from),
        to = parse(range.to) + DAY;
      if (to <= from || to - from > 92 * DAY)
        throw new AppError(400, "bad_request", "Invalid usage date range");
      if (!syncUsage || !config.sub2api)
        return { items: [], configured: false, syncedAt: null };
      const actor = authOf(req).user;
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
