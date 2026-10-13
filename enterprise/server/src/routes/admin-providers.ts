import {
  type AdminProvider,
  CreateProviderRequestSchema,
  type GatewayKeyResponse,
  type ListProvidersResponse,
  ProviderIdSchema,
  UpdateProviderRequestSchema,
  UsageQuerySchema,
  type UsageResponse,
} from "@ccse/contracts";
import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { authOf, requirePermission } from "../auth/guard.ts";
import { gatewayKeys, providers, usageRecords, users } from "../db/schema.ts";
import { AppError, notFound, parseBody } from "../errors.ts";
import type { ProviderRow } from "../gateway/auth.ts";
import { generateGatewayKey, hashGatewayKey } from "../gateway/keys.ts";
import { encryptSecret, secretHint } from "../secrets.ts";

const IdParamSchema = z.object({ id: ProviderIdSchema });
const DAY_MS = 86_400_000;
/** Max inclusive span of GET /admin/usage. */
const MAX_USAGE_RANGE_DAYS = 92;

function isUniqueViolation(err: unknown): boolean {
  // Postgres unique_violation, possibly wrapped by drizzle in `cause`.
  const codeOf = (e: unknown) =>
    typeof e === "object" && e !== null && "code" in e
      ? (e as { code: unknown }).code
      : undefined;
  return (
    codeOf(err) === "23505" ||
    codeOf((err as { cause?: unknown } | null)?.cause) === "23505"
  );
}

function toAdminProvider(row: ProviderRow): AdminProvider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    wireApi: row.wireApi,
    apiKeyHint: row.apiKeyHint,
    models: row.models.map((m) => ({ id: m.id, displayName: m.displayName })),
    defaultModel: row.defaultModel,
    allowedRoles: [...row.allowedRoles],
    dailyTokenLimitPerUser: row.dailyTokenLimitPerUser,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** "YYYY-MM-DD" → UTC midnight; null for impossible dates like 2025-02-30. */
function parseUtcDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

const badRequest = (message: string) =>
  new AppError(400, "bad_request", message);

export async function adminProviderRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, authenticate, config } = deps;
  const guard = {
    preHandler: [authenticate, requirePermission("providers.manage")],
  };

  app.get("/admin/providers", guard, async () => {
    const rows = await db.select().from(providers).orderBy(asc(providers.id));
    const res: ListProvidersResponse = { items: rows.map(toAdminProvider) };
    return res;
  });

  app.post("/admin/providers", guard, async (req, reply) => {
    const body = parseBody(CreateProviderRequestSchema, req.body);
    try {
      const [row] = await db
        .insert(providers)
        .values({
          id: body.id,
          name: body.name,
          baseUrl: body.baseUrl,
          wireApi: body.wireApi,
          apiKeyEnc: encryptSecret(config.secretsKey, body.apiKey),
          apiKeyHint: secretHint(body.apiKey),
          models: body.models,
          defaultModel: body.defaultModel,
          allowedRoles: [...new Set(body.allowedRoles)],
          dailyTokenLimitPerUser: body.dailyTokenLimitPerUser,
          enabled: body.enabled,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      req.log.info(
        { actor: authOf(req).user.id, providerId: row.id },
        "provider created",
      );
      return reply.status(201).send(toAdminProvider(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, "conflict", "Provider id already exists");
      }
      throw err;
    }
  });

  app.patch("/admin/providers/:id", guard, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const body = parseBody(UpdateProviderRequestSchema, req.body);

    const [existing] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .limit(1);
    if (!existing) throw notFound("Provider not found");

    const models = body.models ?? existing.models;
    const defaultModel = body.defaultModel ?? existing.defaultModel;
    if (!models.some((m) => m.id === defaultModel)) {
      throw new AppError(
        400,
        "bad_request",
        "defaultModel must be one of models",
        [
          {
            path: "defaultModel",
            message: "defaultModel must be one of models",
          },
        ],
      );
    }

    const [row] = await db
      .update(providers)
      .set({
        name: body.name,
        baseUrl: body.baseUrl,
        wireApi: body.wireApi,
        apiKeyEnc:
          body.apiKey !== undefined
            ? encryptSecret(config.secretsKey, body.apiKey)
            : undefined,
        apiKeyHint:
          body.apiKey !== undefined ? secretHint(body.apiKey) : undefined,
        models: body.models,
        defaultModel: body.defaultModel,
        allowedRoles:
          body.allowedRoles !== undefined
            ? [...new Set(body.allowedRoles)]
            : undefined,
        dailyTokenLimitPerUser: body.dailyTokenLimitPerUser,
        enabled: body.enabled,
        updatedAt: new Date(),
      })
      .where(eq(providers.id, id))
      .returning();
    if (!row) throw notFound("Provider not found");

    req.log.info(
      {
        actor: authOf(req).user.id,
        providerId: id,
        fields: Object.keys(body).filter(
          (k) => body[k as keyof typeof body] !== undefined,
        ),
      },
      "provider updated",
    );
    return toAdminProvider(row);
  });

  app.delete("/admin/providers/:id", guard, async (req, reply) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const deleted = await db
      .delete(providers)
      .where(eq(providers.id, id))
      .returning({ id: providers.id });
    if (deleted.length === 0) throw notFound("Provider not found");
    req.log.info(
      { actor: authOf(req).user.id, providerId: id },
      "provider deleted",
    );
    return reply.status(204).send();
  });

  app.get(
    "/admin/usage",
    { preHandler: [authenticate, requirePermission("audit.read")] },
    async (req) => {
      const query = parseBody(UsageQuerySchema, req.query);
      const from = parseUtcDate(query.from);
      const to = parseUtcDate(query.to);
      if (!from || !to) throw badRequest("Invalid date");
      if (from > to) throw badRequest("`from` must not be after `to`");
      if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_USAGE_RANGE_DAYS) {
        throw badRequest(`Range must not exceed ${MAX_USAGE_RANGE_DAYS} days`);
      }

      const date = sql<string>`to_char(${usageRecords.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const rows = await db
        .select({
          date,
          userId: usageRecords.userId,
          username: users.username,
          providerId: usageRecords.providerId,
          model: usageRecords.model,
          requests: count(),
          inputTokens:
            sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(
              Number,
            ),
          outputTokens:
            sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(
              Number,
            ),
        })
        .from(usageRecords)
        .innerJoin(users, eq(users.id, usageRecords.userId))
        .where(
          and(
            gte(usageRecords.createdAt, from),
            lt(usageRecords.createdAt, new Date(to.getTime() + DAY_MS)),
          ),
        )
        .groupBy(
          date,
          usageRecords.userId,
          users.username,
          usageRecords.providerId,
          usageRecords.model,
        )
        .orderBy(
          date,
          asc(users.username),
          asc(usageRecords.providerId),
          asc(usageRecords.model),
        );
      const res: UsageResponse = { items: rows };
      return res;
    },
  );

  // Desktop client: issue the gateway key of the current login session.
  app.post(
    "/client/gateway-key",
    { preHandler: [authenticate, requirePermission("models.use")] },
    async (req) => {
      const auth = authOf(req);
      const key = generateGatewayKey();
      const now = new Date();
      const values = {
        keyHash: hashGatewayKey(key),
        sessionId: auth.sessionId,
        userId: auth.user.id,
        createdAt: now,
        lastUsedAt: null,
      };
      await db
        .insert(gatewayKeys)
        .values(values)
        .onConflictDoUpdate({ target: gatewayKeys.sessionId, set: values });
      req.log.info({ userId: auth.user.id }, "gateway key issued");
      const res: GatewayKeyResponse = { key, createdAt: now.toISOString() };
      return res;
    },
  );
}
