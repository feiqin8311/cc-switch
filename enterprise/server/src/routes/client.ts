import type { ClientConfigResponse, HealthResponse } from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf } from "../auth/guard.ts";
import { listManagedProviders } from "../gateway/managed.ts";
import { getRetentionPolicy } from "../retention/policy.ts";
import { toUserDto } from "../users/dto.ts";

export async function clientRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { authenticate, config, db } = deps;

  app.get("/health", async () => {
    const res: HealthResponse = { status: "ok", version: config.version };
    return res;
  });

  app.get("/client/config", { preHandler: authenticate }, async (req) => {
    const auth = authOf(req);
    const retention = await getRetentionPolicy(db);
    const res: ClientConfigResponse = {
      user: toUserDto(auth.user),
      permissions: auth.permissions,
      providers: auth.permissions.includes("models.use")
        ? await listManagedProviders(db, auth.user)
        : [],
      retention: {
        enabled: retention.enabled,
        noticeText: retention.noticeText,
      },
      serverTime: new Date().toISOString(),
    };
    return res;
  });
}
