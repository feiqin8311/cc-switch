import { CodingPlanUsageResponseSchema } from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { requirePermission } from "../auth/guard.ts";

export async function codingPlanRoutes(
  app: FastifyInstance,
  { authenticate, readCodingPlan }: AppDeps,
) {
  app.get("/admin/usage/coding-plan", {
    preHandler: [authenticate, requirePermission("audit.read")],
    handler: async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
      return CodingPlanUsageResponseSchema.parse(await readCodingPlan());
    },
  });
}
