import { Transform } from "node:stream";
import {
  type ListMarketItemsResponse,
  MAX_MARKET_PACKAGE_BYTES,
  MAX_MCP_DEFINITION_BYTES,
  MarketItemMetadataSchema,
  MarketItemPatchSchema,
  McpDefinitionSchema,
  type Permission,
  ProviderIdSchema,
} from "@ccse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { authOf, requirePermission } from "../auth/guard.ts";
import {
  AppError,
  forbidden,
  notFound,
  parseBody,
  unauthorized,
} from "../errors.ts";
import {
  deleteMarketItem,
  getMarketPackage,
  listMarketItems,
  patchMarketItem,
  publishMarketItem,
  toMarketItemDto,
} from "../market/store.ts";
import { validateMarketPackage } from "../market/validate.ts";

const IdParamSchema = z.object({ id: ProviderIdSchema });

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

/**
 * Raw cap for JSON (mcp) upload bodies. The route's bodyLimit stays at the zip
 * size, so JSON is capped separately before it is buffered and parsed; the
 * slack over MAX_MCP_DEFINITION_BYTES allows pretty-printed input.
 */
const MAX_MCP_JSON_BODY_BYTES = 4 * MAX_MCP_DEFINITION_BYTES;

const mcpBodyTooLarge = () =>
  new AppError(413, "payload_too_large", "MCP definition too large");

const isJsonRequest = (req: FastifyRequest) =>
  (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ===
  "application/json";

/** Fails the stream once more than `limit` bytes have passed through. */
function limitStream(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) cb(mcpBodyTooLarge());
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
      requireAnyPermission("market.install", "market.manage"),
    ],
  };
  const manageGuard = {
    preHandler: [authenticate, requirePermission("market.manage")],
  };

  app.get("/market/items", readGuard, async () => {
    const rows = await listMarketItems(db);
    const res: ListMarketItemsResponse = { items: rows.map(toMarketItemDto) };
    return res;
  });

  app.get("/market/items/:id/package", readGuard, async (req, reply) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const pkg = await getMarketPackage(db, id);
    if (!pkg) throw notFound("Market item not found");
    const isMcp = pkg.item.kind === "mcp";
    const ext = isMcp ? "json" : "zip";
    const filename = `${pkg.item.id}-${safeFilenamePart(pkg.item.version)}.${ext}`;
    return reply
      .status(200)
      .header("content-type", isMcp ? "application/json" : "application/zip")
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
        if (declared > MAX_MCP_JSON_BODY_BYTES) throw mcpBodyTooLarge();
        return payload.pipe(limitStream(MAX_MCP_JSON_BODY_BYTES));
      },
    },
    async (req) => {
      const { id } = parseBody(IdParamSchema, req.params);
      const meta = parseQuery(MarketItemMetadataSchema, req.query);
      const kind = meta.kind;
      const body = req.body;
      let data: Buffer;
      if (kind === "mcp") {
        if (Buffer.isBuffer(body)) {
          throw new AppError(
            400,
            "bad_request",
            "kind mcp expects application/json",
          );
        }
        const definition = parseBody(McpDefinitionSchema, body);
        data = Buffer.from(JSON.stringify(definition));
        if (data.length > MAX_MCP_DEFINITION_BYTES) throw mcpBodyTooLarge();
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
      const row = await publishMarketItem(db, {
        id,
        kind,
        name: meta.name,
        description: meta.description,
        version: meta.version,
        mandatory: meta.mandatory,
        data,
        publishedBy: actor.id,
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
      return toMarketItemDto(row);
    },
  );

  app.patch("/admin/market/items/:id", manageGuard, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const patch = parseBody(MarketItemPatchSchema, req.body);
    const row = await patchMarketItem(db, id, patch);
    if (!row) throw notFound("Market item not found");
    req.log.info(
      { actor: authOf(req).user.id, itemId: id },
      "market item updated",
    );
    return toMarketItemDto(row);
  });

  app.delete("/admin/market/items/:id", manageGuard, async (req, reply) => {
    const { id } = parseBody(IdParamSchema, req.params);
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
