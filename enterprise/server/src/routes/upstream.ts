import {
  type UpstreamAccountsResponse,
  UpstreamAccountsResponseSchema,
} from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { requirePermission } from "../auth/guard.ts";
import { listUpstreamAccounts } from "../sub2api.ts";

export async function upstreamRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { authenticate, config } = deps;

  const list = async () => {
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
    handler: list,
  });
  app.get("/client/upstream/accounts", {
    preHandler: [authenticate],
    handler: list,
  });
}
