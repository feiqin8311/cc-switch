import {
  CODING_PLAN_ACCOUNT_ID,
  type UpstreamAccount,
  type UpstreamAccountsResponse,
  UpstreamAccountsResponseSchema,
} from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf, requirePermission } from "../auth/guard.ts";
import type { UserRow } from "../db/schema.ts";
import { listUpstreamAccounts } from "../sub2api.ts";

export function visibleUpstreamAccounts(
  user: UserRow,
  items: UpstreamAccount[],
): UpstreamAccount[] {
  if (user.role === "admin") return items;
  const allow = new Set(user.upstreamAccountIds ?? []);
  return items.filter((a) => allow.has(a.id));
}

export async function upstreamRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { authenticate, config, readCodingPlan } = deps;

  const listAll = async () => {
    const cfg = config.sub2api;
    if (!cfg) {
      const empty: UpstreamAccountsResponse = {
        configured: false,
        error: "未配置 SUB2API_URL / SUB2API_EMAIL / SUB2API_PASSWORD",
        items: [],
      };
      return UpstreamAccountsResponseSchema.parse(empty);
    }
    try {
      const items = await listUpstreamAccounts(cfg);
      return UpstreamAccountsResponseSchema.parse({
        configured: true,
        error: null,
        items,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return UpstreamAccountsResponseSchema.parse({
        configured: true,
        error: message,
        items: [],
      });
    }
  };

  app.get("/admin/upstream/accounts", {
    preHandler: [authenticate, requirePermission("audit.read")],
    handler: async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
      return { ...(await listAll()), codingPlanAvailable: !!config.volcengine };
    },
  });
  app.get("/client/upstream/accounts", {
    preHandler: [authenticate],
    handler: async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const user = authOf(req).user;
      const canSeeCodingPlan =
        !!config.volcengine &&
        (user.role === "admin" ||
          user.upstreamAccountIds?.includes(CODING_PLAN_ACCOUNT_ID));
      const [all, codingPlan] = await Promise.all([
        listAll(),
        canSeeCodingPlan ? readCodingPlan() : undefined,
      ]);
      return {
        ...all,
        configured: all.configured || !!codingPlan,
        // Sub2API configuration should not obscure an assigned Coding Plan card.
        error: !all.configured && codingPlan ? null : all.error,
        items: visibleUpstreamAccounts(user, all.items),
        ...(codingPlan ? { codingPlan } : {}),
      };
    },
  });
}
