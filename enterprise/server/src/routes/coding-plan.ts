import {
  CODING_PLAN_ACCOUNT_ID,
  CodingPlanUsageResponseSchema,
} from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf, requireAnyPermission } from "../auth/guard.ts";
import { forbidden } from "../errors.ts";
import { canSeeUpstreamAccount } from "../users/upstream-access.ts";

export async function codingPlanRoutes(
  app: FastifyInstance,
  { authenticate, readCodingPlan }: AppDeps,
) {
  app.get("/admin/usage/coding-plan", {
    preHandler: [
      authenticate,
      requireAnyPermission("audit.read", "upstream.read"),
    ],
    handler: async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!canSeeUpstreamAccount(authOf(req).user, CODING_PLAN_ACCOUNT_ID))
        throw forbidden("未分配该上游账号");
      return CodingPlanUsageResponseSchema.parse(await readCodingPlan());
    },
  });
}
