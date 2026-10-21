import { Transform } from "node:stream";
import {
  ConnectorDefinitionSchema,
  canManageMarketKind,
  type ListMarketItemsResponse,
  MAX_CONNECTOR_DEFINITION_BYTES,
  MAX_MARKET_PACKAGE_BYTES,
  MAX_MCP_DEFINITION_BYTES,
  MAX_PROMPT_DEFINITION_BYTES,
  type MarketItemKind,
  MarketItemMetadataSchema,
  MarketItemPatchSchema,
  McpDefinitionSchema,
  type Permission,
  PromptDefinitionSchema,
  ProviderIdSchema,
} from "@ccse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { authOf } from "../auth/guard.ts";
import {
  AppError,
  forbidden,
  notFound,
  parseBody,
  unauthorized,
} from "../errors.ts";
import {
  canSeeMarketItem,
  deleteMarketItem,
  findMarketItem,
  getMarketPackage,
  listMarketItems,
  patchMarketItem,
  publisherNameOf,
  publishMarketItem,
  toMarketItemDto,
} from "../market/store.ts";
import { validateMarketPackage } from "../market/validate.ts";
import { assertUsersExist } from "../users/dto.ts";

const IdParamSchema = z.object({ id: ProviderIdSchema });
const MARKET_MANAGE_PERMISSIONS: Permission[] = [
  "market.manage",
  "mcp.manage",
  "connectors.manage",
  "skills.manage",
  "prompts.manage",
];

function assertCanManageKind(req: FastifyRequest, kind: MarketItemKind) {
  if (!canManageMarketKind(authOf(req).permissions, kind)) throw forbidden();
}

/** Member skill publish: no mandatory flag, kind is skill only. */
const MemberSkillPublishSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(""),
  version: z.string().trim().min(1).max(50),
  kind: z.literal("skill").default("skill"),
});

function requireAnyPermission(...permissions: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.auth) throw unauthorized();
    const granted = req.auth.permissions;
    if (!permissions.some((p) => granted.includes(p))) throw forbidden();
  };
}

function parseQuery<S extends z.ZodType>(
  schema: S,
  query: unknown,
): z.infer<S> {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new AppError(
      400,
      "bad_request",
      "Invalid query parameters",
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return result.data;
}

/** Keeps Content-Disposition filenames to a safe ASCII subset. */
const safeFilenamePart = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

/** Kinds whose package is a JSON definition rather than a zip. */
type JsonKind = Extract<MarketItemKind, "mcp" | "prompt" | "connector">;

/** Schema and max stored (compact JSON) size per JSON kind. */
const JSON_KINDS: Record<JsonKind, { schema: z.ZodType; maxBytes: number }> = {
  mcp: { schema: McpDefinitionSchema, maxBytes: MAX_MCP_DEFINITION_BYTES },
  prompt: {
    schema: PromptDefinitionSchema,
    maxBytes: MAX_PROMPT_DEFINITION_BYTES,
  },
  connector: {
    schema: ConnectorDefinitionSchema,
    maxBytes: MAX_CONNECTOR_DEFINITION_BYTES,
  },
};

const isJsonKind = (kind: MarketItemKind): kind is JsonKind =>
  Object.hasOwn(JSON_KINDS, kind);

/**
 * Raw cap for JSON upload bodies. The route's bodyLimit stays at the zip size,
 * so JSON is capped separately before it is buffered and parsed; the slack
 * over the largest per-kind limit allows pretty-printed input. The handler
 * still enforces each kind's serialized limit.
 */
const MAX_JSON_BODY_BYTES =
  4 * Math.max(...Object.values(JSON_KINDS).map((k) => k.maxBytes));

const jsonBodyTooLarge = () =>
  new AppError(413, "payload_too_large", "Definition too large");

const isJsonRequest = (req: FastifyRequest) =>
  (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ===
  "application/json";

/** Fails the stream once more than `limit` bytes have passed through. */
function limitStream(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) cb(jsonBodyTooLarge());
      else cb(null, chunk);
    },
  });
}

export async function marketRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, authenticate } = deps;

  // Registered on the shared /api/v1 instance; other routes ignore zip bodies.
  app.addContentTypeParser(
    "application/zip",
    { parseAs: "buffer", bodyLimit: MAX_MARKET_PACKAGE_BYTES },
    (_req, body, done) => done(null, body),
  );

  const readGuard = {
    preHandler: [
      authenticate,
      requireAnyPermission("market.install", ...MARKET_MANAGE_PERMISSIONS),
    ],
  };
  const manageGuard = {
    preHandler: [
      authenticate,
      requireAnyPermission(...MARKET_MANAGE_PERMISSIONS),
    ],
  };

  app.get("/market/items", readGuard, async (req) => {
    const actor = authOf(req);
    let items = await listMarketItems(db);
    items = items.filter(
      (item) =>
        canManageMarketKind(actor.permissions, item.kind) ||
        (actor.permissions.includes("market.install") &&
          canSeeMarketItem(item, actor.user)),
    );
    const res: ListMarketItemsResponse = { items };
    return res;
  });

  app.put(
    "/market/items/:id",
    {
      preHandler: readGuard.preHandler,
      bodyLimit: MAX_MARKET_PACKAGE_BYTES,
    },
    async (req) => {
      const { id } = parseBody(IdParamSchema, req.params);
      const meta = parseQuery(MemberSkillPublishSchema, req.query);
      if (!authOf(req).permissions.includes("market.install")) {
        assertCanManageKind(req, "skill");
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new AppError(
          400,
          "bad_request",
          "Content-Type must be application/zip",
        );
      }
      validateMarketPackage(body, "skill", id);
      const actor = authOf(req).user;
      const existing = await findMarketItem(db, id);
      if (existing) {
        if (existing.kind !== "skill") {
          throw new AppError(
            409,
            "conflict",
            "A marketplace item with this id already exists",
          );
        }
        const own = existing.publishedBy === actor.id;
        if (!own && actor.role !== "admin") {
          throw forbidden(
            "Only the publisher or an admin can replace this item",
          );
        }
      }
      const row = await publishMarketItem(db, {
        id,
        kind: "skill",
        name: meta.name,
        description: meta.description,
        version: meta.version,
        mandatory: false,
        data: body,
        publishedBy: existing?.publishedBy ?? actor.id,
      });
      req.log.info(
        {
          actor: actor.id,
          itemId: id,
          version: row.version,
          sha256: row.sha256,
        },
        "market skill published by member",
      );
      return toMarketItemDto(row, await publisherNameOf(db, row.publishedBy));
    },
  );

  app.get("/market/items/:id/package", readGuard, async (req, reply) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const pkg = await getMarketPackage(db, id);
    if (!pkg) throw notFound("Market item not found");
    const actor = authOf(req);
    if (
      !canManageMarketKind(actor.permissions, pkg.item.kind) &&
      !(
        actor.permissions.includes("market.install") &&
        canSeeMarketItem(pkg.item, actor.user)
      )
    ) {
      throw notFound("Market item not found");
    }
    const isJson = isJsonKind(pkg.item.kind);
    const ext = isJson ? "json" : "zip";
    const filename = `${pkg.item.id}-${safeFilenamePart(pkg.item.version)}.${ext}`;
    return reply
      .status(200)
      .header("content-type", isJson ? "application/json" : "application/zip")
      .header("x-content-sha256", pkg.item.sha256)
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("cache-control", "no-store")
      .send(pkg.data);
  });

  app.put(
    "/admin/market/items/:id",
    {
      ...manageGuard,
      bodyLimit: MAX_MARKET_PACKAGE_BYTES,
      preParsing: async (req, _reply, payload) => {
        if (!isJsonRequest(req)) return payload;
        const declared = Number(req.headers["content-length"]);
        if (declared > MAX_JSON_BODY_BYTES) throw jsonBodyTooLarge();
        return payload.pipe(limitStream(MAX_JSON_BODY_BYTES));
      },
    },
    async (req) => {
      const { id } = parseBody(IdParamSchema, req.params);
      const meta = parseQuery(MarketItemMetadataSchema, req.query);
      const kind = meta.kind;
      assertCanManageKind(req, kind);
      const previous = await findMarketItem(db, id);
      if (previous) assertCanManageKind(req, previous.kind);
      const body = req.body;
      let data: Buffer;
      if (isJsonKind(kind)) {
        if (Buffer.isBuffer(body)) {
          throw new AppError(
            400,
            "bad_request",
            `kind ${kind} expects application/json`,
          );
        }
        const { schema, maxBytes } = JSON_KINDS[kind];
        const definition = parseBody(schema, body);
        data = Buffer.from(JSON.stringify(definition));
        if (data.length > maxBytes) throw jsonBodyTooLarge();
      } else {
        if (!Buffer.isBuffer(body)) {
          throw new AppError(
            415,
            "bad_request",
            "Content-Type must be application/zip",
          );
        }
        if (body.length === 0) {
          throw new AppError(400, "bad_request", "Package body is empty");
        }
        validateMarketPackage(body, kind, id);
        data = body;
      }

      const actor = authOf(req).user;
      const existing = await findMarketItem(db, id);
      const row = await publishMarketItem(db, {
        id,
        kind,
        name: meta.name,
        description: meta.description,
        version: meta.version,
        mandatory: meta.mandatory,
        data,
        publishedBy: existing?.publishedBy ?? actor.id,
      });
      req.log.info(
        {
          actor: actor.id,
          itemId: id,
          kind: row.kind,
          version: row.version,
          sha256: row.sha256,
          sizeBytes: row.sizeBytes,
        },
        "market item published",
      );
      return toMarketItemDto(row, await publisherNameOf(db, row.publishedBy));
    },
  );

  app.patch("/admin/market/items/:id", manageGuard, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const existing = await findMarketItem(db, id);
    if (!existing) throw notFound("Market item not found");
    assertCanManageKind(req, existing.kind);
    const patch = parseBody(MarketItemPatchSchema, req.body);
    const visibleUserIds = patch.visibleUserIds && [
      ...new Set(patch.visibleUserIds),
    ];
    if (visibleUserIds) await assertUsersExist(db, visibleUserIds);
    const visibleGroups = patch.visibleGroups && [
      ...new Set(patch.visibleGroups),
    ];
    if (patch.publishedBy) {
      const name = await publisherNameOf(db, patch.publishedBy);
      if (name === null) {
        throw new AppError(400, "bad_request", "Publisher not found", [
          { path: "publishedBy", message: "User not found" },
        ]);
      }
    }
    const row = await patchMarketItem(db, id, {
      ...patch,
      visibleUserIds,
      visibleGroups,
    });
    if (!row) throw notFound("Market item not found");
    req.log.info(
      { actor: authOf(req).user.id, itemId: id },
      "market item updated",
    );
    return toMarketItemDto(row, await publisherNameOf(db, row.publishedBy));
  });

  app.delete("/admin/market/items/:id", manageGuard, async (req, reply) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const existing = await findMarketItem(db, id);
    if (!existing) throw notFound("Market item not found");
    assertCanManageKind(req, existing.kind);
    if (!(await deleteMarketItem(db, id))) {
      throw notFound("Market item not found");
    }
    req.log.info(
      { actor: authOf(req).user.id, itemId: id },
      "market item deleted",
    );
    return reply.status(204).send();
  });
}
