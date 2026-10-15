import {
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
  const { authenticate, config } = deps;

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
    handler: listAll,
  });
  app.get("/client/upstream/accounts", {
    preHandler: [authenticate],
    handler: async (req) => {
      const all = await listAll();
      return {
        ...all,
        items: visibleUpstreamAccounts(authOf(req).user, all.items),
      };
    },
  });
}
