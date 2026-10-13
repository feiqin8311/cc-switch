import type { ErrorCode, ErrorResponse } from "@ccse/contracts";
import type { FastifyError, FastifyInstance } from "fastify";
import type { z } from "zod";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const unauthorized = (message = "Authentication required") =>
  new AppError(401, "unauthorized", message);
export const forbidden = (message = "Permission denied") =>
  new AppError(403, "forbidden", message);
export const notFound = (message = "Not found") =>
  new AppError(404, "not_found", message);

/** Validates a request body; issues never echo the submitted values. */
export function parseBody<S extends z.ZodType>(
  schema: S,
  body: unknown,
): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      400,
      "bad_request",
      "Invalid request body",
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return result.data;
}

function body(code: ErrorCode, message: string, details?: unknown) {
  const res: ErrorResponse = { error: { code, message } };
  if (details !== undefined) res.error.details = details;
  return res;
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.status)
        .send(body(err.code, err.message, err.details));
    }
    const status = err.statusCode ?? 500;
    if (status === 413) {
      return reply
        .status(413)
        .send(body("payload_too_large", "Request body too large"));
    }
    if (status >= 400 && status < 500) {
      return reply.status(400).send(body("bad_request", err.message));
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send(body("internal", "Internal server error"));
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send(body("not_found", "Route not found")),
  );
}
