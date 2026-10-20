import { CodingPlanUsageResponseSchema } from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { requirePermission } from "../auth/guard.ts";
import { createCodingPlanReader } from "../volcengine.ts";

export async function codingPlanRoutes(
  app: FastifyInstance,
  { authenticate, config }: AppDeps,
) {
  const read = createCodingPlanReader(config.volcengine);
  app.get("/admin/usage/coding-plan", {
    preHandler: [authenticate, requirePermission("audit.read")],
    handler: async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
      return CodingPlanUsageResponseSchema.parse(await read());
    },
  });
}
