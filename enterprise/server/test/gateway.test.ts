import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  ClientConfigResponseSchema,
  ErrorResponseSchema,
  GatewayKeyResponseSchema,
  type SessionResponse,
} from "@ccse/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usageRecords, users } from "../src/db/schema.ts";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

const UPSTREAM_KEY = "sk-upstream-secret-abcd1234";

// ---------------------------------------------------------------------------
// Fake upstream (OpenAI Responses API)
// ---------------------------------------------------------------------------

const completedEvent = {
  type: "response.completed",
  response: {
    id: "resp_1",
    model: "gpt-5",
    status: "completed",
    output: [{ type: "message", content: [{ text: "Hé🙂llo" }] }],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
      output_tokens: 30,
      total_tokens: 150,
    },
  },
};

const SSE_BODY = Buffer.from(
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hé🙂llo"}\n\n' +
    `event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`,
);

interface Received {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface Upstream {
  baseUrl: string;
  received: Received[];
  /** When set, the SSE response pauses before its last chunk until called. */
  holdLastChunk: Promise<void> | null;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startUpstream(): Promise<Upstream> {
  const up: Upstream = {
    baseUrl: "",
    received: [],
    holdLastChunk: null,
    close: async () => {},
  };
  const server = createServer((req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      up.received.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/v1/chat/completions") {
        if (body.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"DeepSeek "}}]}\n\n',
          );
          await sleep(5);
          res.write(
            'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":25,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
          );
          await sleep(5);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-nonstream",
            choices: [
              {
                message: { role: "assistant", content: "Non-streaming answer" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
        );
        return;
      }
      if (
        req.url === "/v1/images/generations" ||
        req.url === "/v1/images/edits"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            created: 1,
            data: [{ b64_json: "aaaa" }],
            usage: { input_tokens: 8, output_tokens: 100 },
          }),
        );
        return;
      }
      if (req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Odd-sized chunks split lines, JSON and multi-byte characters.
        const size = 37;
        for (let i = 0; i < SSE_BODY.length; i += size) {
          if (i + size >= SSE_BODY.length && up.holdLastChunk) {
            await up.holdLastChunk;
          }
          res.write(SSE_BODY.subarray(i, i + size));
          await sleep(1);
        }
        res.end();
        return;
      }
      if (body.model === "gpt-error") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad things" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_2",
          object: "response",
          usage: { input_tokens: 60, output_tokens: 50, total_tokens: 110 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  up.baseUrl = `http://127.0.0.1:${port}/v1/`;
  up.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return up;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let ctx: TestContext;
let upstream: Upstream;
let adminToken: string;

beforeEach(async () => {
  ctx = await setup();
  upstream = await startUpstream();
  adminToken = (await login(ctx.app, ADMIN.username, ADMIN.password))
    .accessToken;
});
afterEach(async () => {
  await ctx.close();
  await upstream.close();
});

async function createProvider(overrides: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/providers",
    headers: bearer(adminToken),
    payload: {
      id: "openai-main",
      name: "OpenAI",
      baseUrl: upstream.baseUrl,
      apiKey: UPSTREAM_KEY,
      models: [
        { id: "gpt-5", displayName: "GPT-5" },
        { id: "gpt-error", displayName: "Always fails" },
      ],
      defaultModel: "gpt-5",
      allowedGroups: ["test-group"],
      allowedUserIds: [],
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
}

async function patchProvider(id: string, payload: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/admin/providers/${id}`,
    headers: bearer(adminToken),
    payload,
  });
  expect(res.statusCode).toBe(200);
}

async function loginAs(
  role: "admin" | "member" | "viewer",
  username = `${role}-user`,
  groupName: string | null = "test-group",
): Promise<SessionResponse> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: bearer(adminToken),
    payload: {
      username,
      displayName: username,
      password: "password-123",
      role,
      groupName: groupName ?? "",
    },
  });
  expect(res.statusCode).toBe(201);
  return login(ctx.app, username, "password-123");
}

async function issueKey(accessToken: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/client/gateway-key",
    headers: bearer(accessToken),
  });
  expect(res.statusCode).toBe(200);
  return GatewayKeyResponseSchema.parse(res.json()).key;
}

function callResponses(
  key: string,
  payload: Record<string, unknown>,
  provider = "openai-main",
  extraHeaders: Record<string, string> = {},
) {
  return ctx.app.inject({
    method: "POST",
    url: `/gateway/${provider}/v1/responses`,
    headers: { ...bearer(key), ...extraHeaders },
    payload,
  });
}

async function usageRows() {
  return ctx.db.select().from(usageRecords);
}

function errorCode(res: { json(): unknown }) {
  return ErrorResponseSchema.parse(res.json()).error.code;
}

// ---------------------------------------------------------------------------

describe("gateway keys", () => {
  it("issues gk_ keys and replaces the session's previous key", async () => {
    await createProvider();
    const member = await loginAs("member");
    const first = await issueKey(member.accessToken);
    expect(first).toMatch(/^gk_[A-Za-z0-9_-]{43}$/);

    const ok = await ctx.app.inject({
      url: "/gateway/openai-main/v1/models",
      headers: bearer(first),
    });
    expect(ok.statusCode).toBe(200);

    const second = await issueKey(member.accessToken);
    expect(second).not.toBe(first);
    const old = await ctx.app.inject({
      url: "/gateway/openai-main/v1/models",
      headers: bearer(first),
    });
    expect(old.statusCode).toBe(401);
    const fresh = await ctx.app.inject({
      url: "/gateway/openai-main/v1/models",
      headers: bearer(second),
    });
    expect(fresh.statusCode).toBe(200);
  });

  it("viewers cannot get a key", async () => {
    const viewer = await loginAs("viewer");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/client/gateway-key",
      headers: bearer(viewer.accessToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects missing, malformed and unknown keys with 401", async () => {
    await createProvider();
    for (const headers of [
      {},
      { authorization: "Bearer nope" },
      { authorization: `Bearer gk_${"A".repeat(43)}` },
      bearer(adminToken), // an access token is not a gateway key
    ]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/gateway/openai-main/v1/responses",
        headers,
        payload: { model: "gpt-5" },
      });
      expect(res.statusCode).toBe(401);
      expect(errorCode(res)).toBe("unauthorized");
    }
    expect(upstream.received).toHaveLength(0);
  });

  it("logout kills the key", async () => {
    await createProvider();
    const member = await loginAs("member");
    const key = await issueKey(member.accessToken);
    const logout = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refreshToken: member.refreshToken },
    });
    expect(logout.statusCode).toBe(204);
    const res = await callResponses(key, { model: "gpt-5" });
    expect(res.statusCode).toBe(401);
  });

  it("a viewer's key (role changed after issue) is forbidden", async () => {
    await createProvider();
    const member = await loginAs("member");
    const key = await issueKey(member.accessToken);
    // Demote without revoking sessions, to exercise the gateway's own check.
    await ctx.db
      .update(users)
      .set({ role: "viewer" })
      .where(eq(users.id, member.user.id));
    const res = await callResponses(key, { model: "gpt-5" });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe("forbidden");
  });
});

describe("gateway authorization", () => {
  it("403 when empty, group/user mismatch, or disabled; 404 when unknown; admin also forbidden unless allowed", async () => {
    await createProvider();
    const member = await loginAs("member");
    const key = await issueKey(member.accessToken);

    expect(
      (await callResponses(key, { model: "gpt-5" }, "nope")).statusCode,
    ).toBe(404);

    // 1. Empty allowedUserIds and allowedGroups -> 403 (全员不可用)
    await patchProvider("openai-main", { allowedUserIds: [], allowedGroups: [] });
    const emptyNotAllowed = await callResponses(key, { model: "gpt-5" });
    expect(emptyNotAllowed.statusCode).toBe(403);
    expect(errorCode(emptyNotAllowed)).toBe("forbidden");

    // 2. Admin is also not allowed when empty or not matching ("admin也不允许")
    const adminUser = await loginAs("admin", "admin-for-gw", "other-group");
    const adminKey = await issueKey(adminUser.accessToken);
    const adminBlocked = await callResponses(adminKey, { model: "gpt-5" });
    expect(adminBlocked.statusCode).toBe(403);
    expect(errorCode(adminBlocked)).toBe("forbidden");

    // 3. Different group -> 403
    await patchProvider("openai-main", {
      allowedUserIds: [],
      allowedGroups: ["finance"],
    });
    const notInGroup = await callResponses(key, { model: "gpt-5" });
    expect(notInGroup.statusCode).toBe(403);

    // 4. Allowed by user ID -> succeeds
    await patchProvider("openai-main", {
      allowedUserIds: [member.user.id],
      allowedGroups: [],
    });
    const userAllowed = await callResponses(key, { model: "gpt-5" });
    expect(userAllowed.statusCode).toBe(200);

    // 5. Disabled -> 403 even if user ID is in allowedUserIds
    await patchProvider("openai-main", {
      allowedUserIds: [member.user.id],
      enabled: false,
    });
    const disabled = await callResponses(key, { model: "gpt-5" });
    expect(disabled.statusCode).toBe(403);
    expect(errorCode(disabled)).toBe("forbidden");
    expect(upstream.received).toHaveLength(1);
  });

  it("400 for models outside the allowlist or malformed bodies", async () => {
    await createProvider();
    const key = await issueKey((await loginAs("member")).accessToken);
    for (const payload of [
      { model: "gpt-4o" },
      { input: "hi" },
      { model: 5 },
    ]) {
      const res = await callResponses(key, payload);
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe("bad_request");
    }
    const arr = await ctx.app.inject({
      method: "POST",
      url: "/gateway/openai-main/v1/responses",
      headers: { ...bearer(key), "content-type": "application/json" },
      payload: "[1,2]",
    });
    expect(arr.statusCode).toBe(400);
    expect(upstream.received).toHaveLength(0);
  });
});

describe("gateway forwarding", () => {
  it("streams SSE byte-identically and records usage", async () => {
    await createProvider();
    const member = await loginAs("member");
    const key = await issueKey(member.accessToken);

    const res = await callResponses(
      key,
      { model: "gpt-5", stream: true, input: "hello" },
      "openai-main",
      {
        "openai-beta": "responses=v1",
        "x-secret-header": "nope",
        accept: "text/event-stream",
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(Buffer.compare(res.rawPayload, SSE_BODY)).toBe(0);

    const [received] = upstream.received;
    expect(received?.url).toBe("/v1/responses");
    expect(received?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(received?.headers["openai-beta"]).toBe("responses=v1");
    expect(received?.headers.accept).toBe("text/event-stream");
    expect(received?.headers["x-secret-header"]).toBeUndefined();
    expect(received?.body).toEqual({
      model: "gpt-5",
      stream: true,
      input: "hello",
    });

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: member.user.id,
      providerId: "openai-main",
      model: "gpt-5",
      status: 200,
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 20,
      cacheCreationTokens: 5,
      pricingModel: "gpt-5",
    });
  });

  it("delivers SSE chunks before the upstream finishes (no buffering)", async () => {
    await createProvider();
    const key = await issueKey((await loginAs("member")).accessToken);
    let release = () => {};
    upstream.holdLastChunk = new Promise<void>((r) => {
      release = r;
    });
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/gateway/openai-main/v1/responses`, {
      method: "POST",
      headers: { ...bearer(key), "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", stream: true }),
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const parts: Uint8Array[] = [];
    let received = 0;
    // Everything but the held last chunk arrives while upstream is paused.
    const lastChunk = SSE_BODY.length % 37 || 37;
    while (received < SSE_BODY.length - lastChunk) {
      const { done, value } = await reader.read();
      if (done) throw new Error("ended early");
      parts.push(value);
      received += value.byteLength;
    }
    expect(await usageRows()).toHaveLength(0);
    release();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    expect(Buffer.compare(Buffer.concat(parts), SSE_BODY)).toBe(0);
    expect((await usageRows())[0]?.inputTokens).toBe(120);
  });

  it("relays JSON responses and upstream error statuses", async () => {
    await createProvider();
    const key = await issueKey((await loginAs("member")).accessToken);
    const res = await callResponses(key, { model: "gpt-5", input: "hi" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.json()).toMatchObject({
      id: "resp_2",
      usage: { input_tokens: 60 },
    });

    const failed = await callResponses(key, { model: "gpt-error" });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: { message: "bad things" } });

    const rows = (await usageRows()).sort((a, b) => a.status - b.status);
    expect(rows.map((r) => [r.status, r.inputTokens, r.outputTokens])).toEqual([
      [200, 60, 50],
      [400, 0, 0],
    ]);
  });

  it("returns 429 once the daily quota is used up", async () => {
    await createProvider({ dailyTokenLimitPerUser: 100 });
    const key = await issueKey((await loginAs("member")).accessToken);
    expect((await callResponses(key, { model: "gpt-5" })).statusCode).toBe(200);
    const res = await callResponses(key, { model: "gpt-5" });
    expect(res.statusCode).toBe(429);
    expect(errorCode(res)).toBe("rate_limited");
    expect(upstream.received).toHaveLength(1);
  });

  it("returns 502 upstream_error when the upstream is down", async () => {
    await createProvider();
    const key = await issueKey((await loginAs("member")).accessToken);
    await upstream.close();
    const res = await callResponses(key, { model: "gpt-5", stream: true });
    expect(res.statusCode).toBe(502);
    expect(errorCode(res)).toBe("upstream_error");
    expect(res.body).not.toContain(UPSTREAM_KEY);
    const rows = await usageRows();
    expect(rows.map((r) => [r.status, r.inputTokens])).toEqual([[502, 0]]);
  });

  it("lists models", async () => {
    await createProvider();
    const key = await issueKey((await loginAs("member")).accessToken);
    const res = await ctx.app.inject({
      url: "/gateway/openai-main/v1/models",
      headers: bearer(key),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      object: "list",
      data: [
        { id: "gpt-5", object: "model", owned_by: "openai-main" },
        { id: "gpt-error", object: "model", owned_by: "openai-main" },
      ],
    });
  });

  it("bridges Responses API to Chat Completions SSE streaming", async () => {
    await createProvider({
      id: "deepseek-main",
      wireApi: "chat_completions",
      models: [{ id: "deepseek-chat", displayName: "DeepSeek V3" }],
      defaultModel: "deepseek-chat",
    });
    const member = await loginAs("member");
    const key = await issueKey(member.accessToken);

    const res = await callResponses(
      key,
      {
        model: "deepseek-chat",
        stream: true,
        instructions: "Be helpful",
        input: ["Hello world"],
      },
      "deepseek-main",
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const [received] = upstream.received;
    expect(received?.url).toBe("/v1/chat/completions");
    expect(received?.body).toMatchObject({
      model: "deepseek-chat",
      stream: true,
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello world" },
      ],
    });

    const bodyText = res.body;
    expect(bodyText).toContain("event: response.created");
    expect(bodyText).toContain("event: response.output_text.delta");
    expect(bodyText).toContain("DeepSeek ");
    expect(bodyText).toContain("answer");
    expect(bodyText).toContain("event: response.completed");

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: member.user.id,
      providerId: "deepseek-main",
      model: "deepseek-chat",
      status: 200,
      inputTokens: 15,
      outputTokens: 25,
      cachedTokens: 5,
    });
  });

  it("bridges Responses API to Chat Completions non-streaming", async () => {
    await createProvider({
      id: "deepseek-main",
      wireApi: "chat_completions",
      models: [{ id: "deepseek-chat", displayName: "DeepSeek V3" }],
      defaultModel: "deepseek-chat",
    });
    const key = await issueKey((await loginAs("member")).accessToken);

    const res = await callResponses(
      key,
      {
        model: "deepseek-chat",
        stream: false,
        input: "Hi",
      },
      "deepseek-main",
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const [received] = upstream.received;
    expect(received?.url).toBe("/v1/chat/completions");
    expect(received?.body).toMatchObject({
      model: "deepseek-chat",
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(res.json()).toMatchObject({
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Non-streaming answer" }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    });

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: "deepseek-main",
      model: "deepseek-chat",
      status: 200,
      inputTokens: 10,
      outputTokens: 20,
    });
  });
});

describe("client config", () => {
  it("lists usable providers with today's usage", async () => {
    await createProvider({ dailyTokenLimitPerUser: 1000 });
    await createProvider({
      id: "other-group-only",
      allowedGroups: ["other-group"],
      allowedUserIds: [],
    });
    await createProvider({ id: "off", enabled: false });
    const member = await loginAs("member");
    const key = await issueKey(member.accessToken);
    await callResponses(key, { model: "gpt-5" });
    // Yesterday's usage does not count.
    await ctx.db.insert(usageRecords).values({
      userId: member.user.id,
      providerId: "openai-main",
      model: "gpt-5",
      inputTokens: 500,
      outputTokens: 0,
      status: 200,
      latencyMs: 1,
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });

    const res = await ctx.app.inject({
      url: "/api/v1/client/config",
      headers: bearer(member.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const config = ClientConfigResponseSchema.parse(res.json());
    expect(config.providers).toEqual([
      {
        id: "openai-main",
        name: "OpenAI",
        kind: "gateway",
        gatewayPath: "/gateway/openai-main/v1",
        wireApi: "responses",
        models: [
          { id: "gpt-5", displayName: "GPT-5" },
          { id: "gpt-error", displayName: "Always fails" },
        ],
        defaultModel: "gpt-5",
        dailyTokenLimit: 1000,
        usedTokensToday: 110,
      },
    ]);
    expect(res.body).not.toContain(UPSTREAM_KEY);

    const viewer = await loginAs("viewer");
    const viewerRes = await ctx.app.inject({
      url: "/api/v1/client/config",
      headers: bearer(viewer.accessToken),
    });
    expect(viewerRes.json().providers).toEqual([]);
  });
});

describe("gateway images", () => {
  function callImages(
    key: string,
    path: "generations" | "edits",
    payload: Record<string, unknown> = { prompt: "a dog" },
  ) {
    return ctx.app.inject({
      method: "POST",
      url: `/gateway/openai-main/v1/images/${path}`,
      headers: bearer(key),
      payload,
    });
  }

  it("forwards generations and edits to the upstream Images API", async () => {
    await createProvider();
    const key = await issueKey((await loginAs("member")).accessToken);

    const gen = await callImages(key, "generations", {
      prompt: "a dog",
      model: "gpt-image-1",
    });
    expect(gen.statusCode).toBe(200);
    expect(gen.json()).toMatchObject({
      data: [{ b64_json: "aaaa" }],
      usage: { input_tokens: 8, output_tokens: 100 },
    });

    const edit = await callImages(key, "edits", { prompt: "make it blue" });
    expect(edit.statusCode).toBe(200);

    expect(upstream.received.map((r) => r.url)).toEqual([
      "/v1/images/generations",
      "/v1/images/edits",
    ]);
    expect(upstream.received[0]?.headers.authorization).toBe(
      `Bearer ${UPSTREAM_KEY}`,
    );
    expect(upstream.received[0]?.body).toMatchObject({
      prompt: "a dog",
      model: "gpt-image-1",
    });

    const rows = await usageRows();
    expect(rows.map((r) => [r.model, r.inputTokens, r.outputTokens])).toEqual([
      ["gpt-image-1", 8, 100],
      ["gpt-5", 8, 100],
    ]);
  });

  it("rejects missing keys with 401", async () => {
    await createProvider();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/gateway/openai-main/v1/images/generations",
      payload: { prompt: "a dog" },
    });
    expect(res.statusCode).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });
});
