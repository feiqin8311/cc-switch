import {
  API_PREFIX,
  type CodingPlanUsageResponse,
  GATEWAY_PREFIX,
  UsageQuerySchema,
} from "@ccse/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { createAuthenticate, requirePermission } from "./auth/guard.ts";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db/client.ts";
import { AppError, parseBody, registerErrorHandlers } from "./errors.ts";
import { accountCostsRoutes } from "./routes/account-costs.ts";
import { adminConversationRoutes } from "./routes/admin-conversations.ts";
import { adminProviderRoutes } from "./routes/admin-providers.ts";
import { adminUserRoutes } from "./routes/admin-users.ts";
import { authRoutes } from "./routes/auth.ts";
import { clientRoutes } from "./routes/client.ts";
import { codingPlanRoutes } from "./routes/coding-plan.ts";
import { departmentUsageRoutes } from "./routes/department-usage.ts";
import { fleetRoutes } from "./routes/fleet.ts";
import { gatewayRoutes } from "./routes/gateway.ts";
import { marketRoutes } from "./routes/market.ts";
import { reconciledUsageRoutes } from "./routes/reconciled-usage.ts";
import { retentionRoutes } from "./routes/retention.ts";
import { upstreamRoutes } from "./routes/upstream.ts";
import { closeSub2ApiConnections } from "./sub2api.ts";
import { registerUpdates } from "./updates.ts";
import { createUpstreamUsageSync } from "./usage/sync-upstream.ts";
import { createUpstreamUserSync } from "./users/upstream-sync.ts";
import { createCodingPlanReader } from "./volcengine.ts";

export interface AppDeps {
  db: Db;
  config: AppConfig;
  authenticate: (req: FastifyRequest) => Promise<void>;
  readCodingPlan: () => Promise<CodingPlanUsageResponse>;
  syncUsage: ReturnType<typeof createUpstreamUsageSync> | null;
}

function parseUsageSyncRange(body: unknown): { from: string; to: string } {
  const range = parseBody(UsageQuerySchema, body);
  const parseDate = (value: string): number => {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    )
      throw new AppError(400, "bad_request", "Invalid date");
    return date.getTime();
  };
  const from = parseDate(range.from);
  const to = parseDate(range.to);
  if (from > to || (to - from) / 86_400_000 + 1 > 92)
    throw new AppError(400, "bad_request", "Invalid usage date range");
  return range;
}

export async function buildApp(
  db: Db,
  config: AppConfig,
): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    logger:
      config.env === "test"
        ? false
        : {
            level: config.logLevel,
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers.set-cookie",
              "req.body.username",
              "req.body.password",
              "req.body.currentPassword",
              "req.body.newPassword",
              "req.body.refreshToken",
              "res.body.accessToken",
              "res.body.refreshToken",
              "req.body.apiKey",
              "req.body.providers[*].apiKey",
              "req.body.deviceSecret",
              "req.headers.x-device-secret",
            ],
            ...(config.env === "development"
              ? { transport: { target: "pino-pretty" } }
              : {}),
          },
  });

  app.decorateRequest("auth", null);
  app.addHook("onClose", async () => {
    if (config.sub2api) await closeSub2ApiConnections(config.sub2api);
  });
  registerErrorHandlers(app);

  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    if (req.url.startsWith(`${API_PREFIX}/`)) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }
  });

  const syncUsage = config.sub2api
    ? createUpstreamUsageSync(db, config.sub2api)
    : null;
  const deps: AppDeps = {
    db,
    config,
    authenticate: createAuthenticate(db, config.jwtSecret),
    readCodingPlan: createCodingPlanReader(config.volcengine),
    syncUsage,
  };
  const syncUsers = createUpstreamUserSync(db, config.sub2api);
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let backgroundSync: Promise<unknown> | undefined;
  let backgroundUsageSync: Promise<unknown> | undefined;
  if (config.sub2api && config.env !== "test") {
    const run = () => {
      backgroundSync = syncUsers().catch((err: unknown) =>
        app.log.error({ err }, "上游用户同步失败"),
      );
      if (syncUsage && !backgroundUsageSync) {
        const now = new Date();
        const to = now.toISOString().slice(0, 10);
        const from = new Date(now.getTime() - 2 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        backgroundUsageSync = syncUsage(from, to)
          .catch((err: unknown) => app.log.error({ err }, "上游用量同步失败"))
          .finally(() => {
            backgroundUsageSync = undefined;
          });
      }
    };
    app.addHook("onReady", async () => {
      run();
      syncTimer = setInterval(run, 5 * 60 * 1000);
      syncTimer.unref();
    });
  }
  app.addHook("onClose", async () => {
    if (syncTimer) clearInterval(syncTimer);
    await backgroundSync;
    await backgroundUsageSync;
  });

  await app.register(
    async (api) => {
      api.post(
        "/admin/users/sync-upstream",
        { preHandler: [deps.authenticate, requirePermission("users.manage")] },
        async () => {
          if (!config.sub2api)
            throw new AppError(400, "bad_request", "未配置上游地址及登录账号");
          return syncUsers();
        },
      );
      api.post(
        "/admin/usage/sync-upstream",
        {
          preHandler: [
            deps.authenticate,
            requirePermission("providers.manage"),
          ],
        },
        async (req) => {
          if (!syncUsage)
            throw new AppError(400, "bad_request", "未配置上游地址及登录账号");
          const { from, to } = parseUsageSyncRange(req.body);
          return { synced: (await syncUsage(from, to)).length };
        },
      );
      await authRoutes(api, deps);
      await adminUserRoutes(api, deps);
      await clientRoutes(api, deps);
      await adminProviderRoutes(api, deps);
      await reconciledUsageRoutes(api, deps);
      await accountCostsRoutes(api, deps);
      await departmentUsageRoutes(api, deps);
      await retentionRoutes(api, deps);
      await adminConversationRoutes(api, deps);
      await marketRoutes(api, deps);
      await fleetRoutes(api, deps);
      await upstreamRoutes(api, deps);
      await codingPlanRoutes(api, deps);
    },
    { prefix: API_PREFIX },
  );

  // OpenAI-compatible gateway for Codex; authenticated with gateway keys.
  await app.register((gw) => gatewayRoutes(gw, deps), {
    prefix: GATEWAY_PREFIX,
  });

  registerUpdates(app, config.updatesDir);

  return app;
}
