import {
  CODING_PLAN_ACCOUNT_ID,
  type UpstreamAccount,
  type UpstreamAccountsResponse,
  UpstreamAccountsResponseSchema,
} from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf, requireAnyPermission } from "../auth/guard.ts";
import type { UserRow } from "../db/schema.ts";
import { demoUpstreamAccounts } from "../demo-upstream.ts";
import { listUpstreamAccounts } from "../sub2api.ts";
import { canSeeUpstreamAccount } from "../users/upstream-access.ts";

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
    if (config.demoUpstreamAccounts)
      return UpstreamAccountsResponseSchema.parse({
        configured: true,
        demo: true,
        error: null,
        items: demoUpstreamAccounts(),
      });
    const cfg = config.sub2api;
    if (!cfg) {
      const empty: UpstreamAccountsResponse = {
        demo: false,
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
    preHandler: [
      authenticate,
      requireAnyPermission("audit.read", "upstream.read", "users.manage"),
    ],
    handler: async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const user = authOf(req).user;
      const all = await listAll();
      return {
        ...all,
        items: visibleUpstreamAccounts(user, all.items),
        codingPlanAvailable:
          !config.demoUpstreamAccounts &&
          !!config.volcengine &&
          canSeeUpstreamAccount(user, CODING_PLAN_ACCOUNT_ID),
      };
    },
  });
  app.get("/client/upstream/accounts", {
    preHandler: [authenticate],
    handler: async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const user = authOf(req).user;
      const canSeeCodingPlan =
        !config.demoUpstreamAccounts &&
        !!config.volcengine &&
        canSeeUpstreamAccount(user, CODING_PLAN_ACCOUNT_ID);
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
