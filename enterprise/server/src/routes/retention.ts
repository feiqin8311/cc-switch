import {
  AdminRetentionPolicySchema,
  RetentionUploadRequestSchema,
} from "@ccse/contracts";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf, requirePermission } from "../auth/guard.ts";
import { sessions } from "../db/schema.ts";
import { forbidden, parseBody } from "../errors.ts";
import { ingestConversations } from "../retention/ingest.ts";
import {
  getRetentionPolicy,
  saveRetentionPolicy,
} from "../retention/policy.ts";

const UPLOAD_BODY_LIMIT = 16 * 1024 * 1024;

export async function retentionRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, authenticate } = deps;

  app.get(
    "/admin/retention-policy",
    { preHandler: [authenticate, requirePermission("audit.read")] },
    async () => getRetentionPolicy(db),
  );

  app.put(
    "/admin/retention-policy",
    { preHandler: [authenticate, requirePermission("settings.manage")] },
    async (req) => {
      const body = parseBody(AdminRetentionPolicySchema, req.body);
      const saved = await saveRetentionPolicy(db, body);
      req.log.info(
        {
          actor: authOf(req).user.id,
          enabled: saved.enabled,
          retentionDays: saved.retentionDays,
        },
        "retention policy updated",
      );
      return saved;
    },
  );

  app.post(
    "/retention/conversations",
    {
      bodyLimit: UPLOAD_BODY_LIMIT,
      // onRequest runs before the (up to 16 MB) body is read, so anonymous
      // callers and disabled-policy uploads are rejected without parsing it.
      onRequest: [
        authenticate,
        async () => {
          if (!(await getRetentionPolicy(db)).enabled) {
            throw forbidden("Conversation retention is disabled");
          }
        },
      ],
    },
    async (req) => {
      const auth = authOf(req);
      const body = parseBody(RetentionUploadRequestSchema, req.body);
      const [session] = await db
        .select({ deviceName: sessions.deviceName })
        .from(sessions)
        .where(eq(sessions.id, auth.sessionId))
        .limit(1);
      const res = await ingestConversations(db, body.items, {
        userId: auth.user.id,
        deviceName: session?.deviceName ?? null,
      });
      req.log.info(
        { userId: auth.user.id, items: body.items.length, ...res },
        "conversations retained",
      );
      return res;
    },
  );
}
