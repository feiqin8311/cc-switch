import {
  API_PREFIX,
  type CodingPlanUsageResponse,
  GATEWAY_PREFIX,
} from "@ccse/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { createAuthenticate } from "./auth/guard.ts";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db/client.ts";
import { registerErrorHandlers } from "./errors.ts";
import { adminConversationRoutes } from "./routes/admin-conversations.ts";
import { adminProviderRoutes } from "./routes/admin-providers.ts";
import { adminUserRoutes } from "./routes/admin-users.ts";
import { authRoutes } from "./routes/auth.ts";
import { clientRoutes } from "./routes/client.ts";
import { codingPlanRoutes } from "./routes/coding-plan.ts";
import { fleetRoutes } from "./routes/fleet.ts";
import { gatewayRoutes } from "./routes/gateway.ts";
import { marketRoutes } from "./routes/market.ts";
import { retentionRoutes } from "./routes/retention.ts";
import { upstreamRoutes } from "./routes/upstream.ts";
import { registerUpdates } from "./updates.ts";
import { createCodingPlanReader } from "./volcengine.ts";

export interface AppDeps {
  db: Db;
  config: AppConfig;
  authenticate: (req: FastifyRequest) => Promise<void>;
  readCodingPlan: () => Promise<CodingPlanUsageResponse>;
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
              "req.body.password",
              "req.body.refreshToken",
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
  registerErrorHandlers(app);

  const deps: AppDeps = {
    db,
    config,
    authenticate: createAuthenticate(db, config.jwtSecret),
    readCodingPlan: createCodingPlanReader(config.volcengine),
  };

  await app.register(
    async (api) => {
      await authRoutes(api, deps);
      await adminUserRoutes(api, deps);
      await clientRoutes(api, deps);
      await adminProviderRoutes(api, deps);
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
