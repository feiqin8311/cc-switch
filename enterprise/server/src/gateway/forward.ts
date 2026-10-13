import type { ServerResponse } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.ts";
import { usageRecords } from "../db/schema.ts";
import { AppError } from "../errors.ts";
import { decryptSecret } from "../secrets.ts";
import type { GatewayContext } from "./auth.ts";
import { SseUsageParser } from "./sse.ts";
import { readUsage, type TokenUsage, ZERO_USAGE } from "./usage.ts";
import {
  ChatToResponsesTransformer,
  convertChatJsonToResponsesJson,
  convertResponsesToChatRequest,
} from "./chat_convert.ts";

/** Max non-streaming upstream response that is buffered and relayed. */
export const MAX_BUFFERED_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Upstream must start responding (headers) within this time. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 5 * 60_000;
/** Client request headers copied to the upstream (never Authorization). */
const FORWARDED_CLIENT_HEADERS = ["accept", "openai-beta"] as const;
/** Pseudo status recorded when the client went away before completion. */
const CLIENT_CLOSED_STATUS = 499;

class ResponseTooLargeError extends Error {}

const upstreamError = (message: string) =>
  new AppError(502, "upstream_error", message);

export function upstreamUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

/**
 * Forwards a Responses API request to the provider's upstream and relays the
 * answer (SSE streamed as it arrives, anything else buffered), then records a
 * usage row. Never logs keys or bodies.
 */
export async function forwardResponses(
  db: Db,
  secretsKey: Buffer,
  ctx: GatewayContext,
  model: string,
  body: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { provider, user } = ctx;
  const started = Date.now();
  const log = req.log.child({ providerId: provider.id, userId: user.id });

  const record = async (status: number, usage: TokenUsage) => {
    try {
      await db.insert(usageRecords).values({
        userId: user.id,
        providerId: provider.id,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        status,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      log.error(
        { errMessage: (err as Error).message },
        "failed to record usage",
      );
    }
  };

  let apiKey: string;
  try {
    apiKey = decryptSecret(secretsKey, provider.apiKeyEnc);
  } catch {
    log.error("cannot decrypt provider api key");
    throw new AppError(500, "internal", "Provider is misconfigured");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  for (const name of FORWARDED_CLIENT_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }

  const controller = new AbortController();
  let clientGone = false;
  const onClientClose = () => {
    if (!reply.raw.writableFinished) {
      clientGone = true;
      controller.abort();
    }
  };
  reply.raw.on("close", onClientClose);
  const headersTimer = setTimeout(
    () => controller.abort(),
    UPSTREAM_HEADERS_TIMEOUT_MS,
  );

  const isChatCompletions = provider.wireApi === "chat_completions";
  const upstreamPath = isChatCompletions ? "/chat/completions" : "/responses";
  const upstreamBody = isChatCompletions
    ? convertResponsesToChatRequest(body, model)
    : body;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(provider.baseUrl, upstreamPath), {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (err) {
    reply.raw.off("close", onClientClose);
    await record(clientGone ? CLIENT_CLOSED_STATUS : 502, ZERO_USAGE);
    if (clientGone) {
      reply.hijack();
      return;
    }
    log.warn(
      { errName: (err as Error).name, cause: causeCode(err) },
      "upstream request failed",
    );
    throw upstreamError("Upstream provider is unreachable");
  } finally {
    clearTimeout(headersTimer);
  }

  const contentType = upstream.headers.get("content-type") ?? "";

  if (contentType.toLowerCase().includes("text/event-stream")) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(upstream.status, {
      "content-type": contentType || "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();

    let recordedUsage = ZERO_USAGE;
    let status = upstream.status;
    let failed = false;

    if (isChatCompletions) {
      const transformer = new ChatToResponsesTransformer();
      try {
        if (upstream.body) {
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const convertedChunks = transformer.push(value);
            for (const chunk of convertedChunks) {
              if (!res.write(chunk)) await waitForDrain(res);
            }
            if (clientGone) throw new Error("client closed");
          }
        }
        const finalChunks = transformer.end();
        for (const chunk of finalChunks) {
          if (!res.write(chunk)) await waitForDrain(res);
        }
        recordedUsage = transformer.usage;
      } catch {
        failed = true;
        status = clientGone ? CLIENT_CLOSED_STATUS : 502;
        controller.abort();
      }
    } else {
      const parser = new SseUsageParser();
      try {
        if (upstream.body) {
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(value);
            if (!res.write(value)) await waitForDrain(res);
            if (clientGone) throw new Error("client closed");
          }
        }
        parser.end();
        recordedUsage = parser.usage ?? ZERO_USAGE;
      } catch {
        failed = true;
        status = clientGone ? CLIENT_CLOSED_STATUS : 502;
        controller.abort();
      }
    }

    reply.raw.off("close", onClientClose);
    await record(status, recordedUsage);
    if (failed) {
      if (!clientGone) log.warn("upstream stream broke");
      res.destroy();
    } else {
      res.end();
    }
    return;
  }

  let payload: Buffer;
  try {
    payload = await readCapped(upstream.body, MAX_BUFFERED_RESPONSE_BYTES);
  } catch (err) {
    controller.abort();
    reply.raw.off("close", onClientClose);
    await record(clientGone ? CLIENT_CLOSED_STATUS : 502, ZERO_USAGE);
    if (clientGone) {
      reply.hijack();
      return;
    }
    throw upstreamError(
      err instanceof ResponseTooLargeError
        ? "Upstream response is too large"
        : "Upstream response failed",
    );
  }
  reply.raw.off("close", onClientClose);

  let usage: TokenUsage | null = null;
  let finalPayload = payload;
  let finalContentType = contentType;

  if (contentType.toLowerCase().includes("json")) {
    try {
      const parsed = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
      if (isChatCompletions && upstream.status === 200) {
        const converted = convertChatJsonToResponsesJson(parsed);
        usage = readUsage(converted.usage);
        finalPayload = Buffer.from(JSON.stringify(converted));
        finalContentType = "application/json; charset=utf-8";
      } else {
        usage = readUsage(parsed?.usage);
      }
    } catch {
      usage = null;
    }
  }
  await record(upstream.status, usage ?? ZERO_USAGE);

  reply.status(upstream.status);
  if (finalContentType) reply.header("content-type", finalContentType);
  reply.send(finalPayload);
}

function causeCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}
