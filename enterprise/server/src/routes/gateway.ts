import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.ts";
import { AppError, unauthorized } from "../errors.ts";
import {
  authenticateGatewayRequest,
  type GatewayContext,
} from "../gateway/auth.ts";
import { forwardPassthrough, forwardResponses } from "../gateway/forward.ts";
import { tokensUsedToday } from "../gateway/usage.ts";

/** Codex request bodies carry the whole conversation; allow large ones here only. */
const RESPONSES_BODY_LIMIT = 32 * 1024 * 1024;

/**
 * OpenAI Responses API compatible gateway (prefix /gateway, not under
 * /api/v1). Authenticated with per-session gateway keys.
 */
export async function gatewayRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, config } = deps;
  const contexts = new WeakMap<FastifyRequest, GatewayContext>();

  // Runs before the body is read, so unauthenticated uploads are rejected early.
  const onRequest = async (req: FastifyRequest) => {
    const { providerId } = req.params as { providerId: string };
    contexts.set(
      req,
      await authenticateGatewayRequest(
        db,
        req.headers.authorization,
        providerId,
      ),
    );
  };
  const contextOf = (req: FastifyRequest): GatewayContext => {
    const ctx = contexts.get(req);
    if (!ctx) throw unauthorized();
    return ctx;
  };

  const enforceQuota = async (ctx: GatewayContext) => {
    const limit = ctx.provider.dailyTokenLimitPerUser;
    if (limit === null) return;
    const used = await tokensUsedToday(db, ctx.user.id, ctx.provider.id);
    if (used >= limit) {
      throw new AppError(
        429,
        "rate_limited",
        "Daily token limit reached for this provider",
        { limit, used },
      );
    }
  };

  const jsonBody = (req: FastifyRequest): Record<string, unknown> => {
    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new AppError(
        400,
        "bad_request",
        "Request body must be a JSON object",
      );
    }
    return body as Record<string, unknown>;
  };

  app.get("/:providerId/v1/models", { onRequest }, async (req) => {
    const { provider } = contextOf(req);
    return {
      object: "list",
      data: provider.models.map((m) => ({
        id: m.id,
        object: "model",
        owned_by: provider.id,
      })),
    };
  });

  app.post(
    "/:providerId/v1/responses",
    { onRequest, bodyLimit: RESPONSES_BODY_LIMIT },
    async (req, reply) => {
      const ctx = contextOf(req);
      const body = jsonBody(req);
      const model = body.model;
      if (typeof model !== "string") {
        throw new AppError(400, "bad_request", "`model` is required");
      }
      if (!ctx.provider.models.some((m) => m.id === model)) {
        throw new AppError(
          400,
          "bad_request",
          "Model is not allowed for this provider",
        );
      }
      await enforceQuota(ctx);
      await forwardResponses(
        db,
        config.secretsKey,
        ctx,
        model,
        body,
        req,
        reply,
      );
      return reply;
    },
  );

  const imagesHandler =
    (upstreamPath: "/images/generations" | "/images/edits") =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = contextOf(req);
      const body = jsonBody(req);
      // ImageGen often sends a dedicated image model, not the chat catalog.
      const model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : ctx.provider.defaultModel;
      await enforceQuota(ctx);
      await forwardPassthrough(
        db,
        config.secretsKey,
        ctx,
        model,
        body,
        req,
        reply,
        upstreamPath,
      );
      return reply;
    };

  app.post(
    "/:providerId/v1/images/generations",
    { onRequest, bodyLimit: RESPONSES_BODY_LIMIT },
    imagesHandler("/images/generations"),
  );
  app.post(
    "/:providerId/v1/images/edits",
    { onRequest, bodyLimit: RESPONSES_BODY_LIMIT },
    imagesHandler("/images/edits"),
  );
}
