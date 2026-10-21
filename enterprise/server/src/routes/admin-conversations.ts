import { ListConversationsQuerySchema } from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { requireAnyPermission } from "../auth/guard.ts";
import { notFound, parseBody } from "../errors.ts";
import {
  getConversationDetail,
  listConversations,
} from "../retention/query.ts";

const IdParamSchema = z.object({ id: z.string().uuid() });

export async function adminConversationRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, authenticate } = deps;
  const guard = {
    preHandler: [
      authenticate,
      requireAnyPermission("audit.read", "conversations.read"),
    ],
  };

  app.get("/admin/conversations", guard, async (req) => {
    const query = parseBody(ListConversationsQuerySchema, req.query);
    return listConversations(db, query);
  });

  app.get("/admin/conversations/:id", guard, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const detail = await getConversationDetail(db, id);
    if (!detail) throw notFound("Conversation not found");
    return detail;
  });
}
