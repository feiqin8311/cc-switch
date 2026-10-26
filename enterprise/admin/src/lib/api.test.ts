import type { SessionResponse } from "@ccse/contracts";
import { ListUsersResponseSchema } from "@ccse/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./api";
import { memoryTokenStore } from "./tokenStore";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "admin",
  displayName: "Admin",
  role: "admin" as const,
  adminMenus: null,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  upstreamAccountIds: [] as number[],
  groupName: "",
  offboardedAt: null,
  offboardedBy: null,
};

function session(n: number): SessionResponse {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: "2026-01-01T00:15:00.000Z",
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: "2026-02-01T00:00:00.000Z",
    user,
    permissions: ["users.manage"],
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const unauthorized = () =>
  json(401, { error: { code: "unauthorized", message: "Token expired" } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(handler: Handler, refreshToken: string | null = "refresh-0") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return handler(url, init ?? {});
    },
  );
  const tokens = memoryTokenStore(refreshToken);
  const client = new ApiClient({
    fetch: fetchMock as unknown as typeof fetch,
    tokenStore: tokens,
  });
  const auth = (i: number) =>
    (calls[i]?.init.headers as Record<string, string> | undefined)
      ?.Authorization;
  return { client, calls, tokens, auth };
}

const usersOk = () => json(200, { items: [user] });

describe("ApiClient", () => {
  it("refreshes once on 401 and retries with the new token", async () => {
    let refreshed = 0;
    const { client, calls, tokens, auth } = setup((url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshed += 1;
        expect(JSON.parse(String(init.body))).toEqual({
          refreshToken: `refresh-${refreshed - 1}`,
        });
        return json(200, session(refreshed));
      }
      const header = (init.headers as Record<string, string>).Authorization;
      // The first access token is "expired"; only the second one works.
      return header === "Bearer access-2" ? usersOk() : unauthorized();
    });

    // No access token in memory yet → refresh before the first request.
    const res = await client.get("/admin/users", ListUsersResponseSchema);
    expect(res.items).toHaveLength(1);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/v1/auth/refresh",
      "/api/v1/admin/users",
      "/api/v1/auth/refresh",
      "/api/v1/admin/users",
    ]);
    expect(auth(1)).toBe("Bearer access-1");
    expect(auth(3)).toBe("Bearer access-2");
    expect(tokens.get()).toBe("refresh-2");
    expect(calls.every((call) => call.init.cache === "no-store")).toBe(true);
  });

  it("shares one refresh between concurrent 401s", async () => {
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const gate = new Promise<void>((r) => {
      releaseRefresh = r;
    });
    const { client, tokens } = setup(async (url, init) => {
      if (url.endsWith("/auth/login")) return json(200, session(1));
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        await gate;
        return json(200, session(2));
      }
      const header = (init.headers as Record<string, string>).Authorization;
      return header === "Bearer access-2" ? usersOk() : unauthorized();
    }, null);

    await client.login({ username: "admin", password: "x" });
    const pending = Promise.all([
      client.get("/admin/users", ListUsersResponseSchema),
      client.get("/admin/users", ListUsersResponseSchema),
      client.get("/admin/users", ListUsersResponseSchema),
    ]);
    // Let all three requests receive their 401 before the refresh resolves.
    await new Promise((r) => setTimeout(r, 0));
    releaseRefresh();
    const results = await pending;

    expect(results.every((r) => r.items.length === 1)).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(tokens.get()).toBe("refresh-2");
  });

  it("clears the session when the refresh is rejected", async () => {
    const { client, tokens, calls } = setup((url) => {
      if (url.endsWith("/auth/login")) return json(200, session(1));
      if (url.endsWith("/auth/refresh")) {
        return json(401, {
          error: { code: "unauthorized", message: "Refresh token reused" },
        });
      }
      return unauthorized();
    }, null);
    const listener = vi.fn();
    client.onSessionChange(listener);

    await client.login({ username: "admin", password: "x" });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ user }),
    );

    const err = await client
      .get("/admin/users", ListUsersResponseSchema)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("unauthorized");
    expect(tokens.get()).toBeNull();
    expect(client.hasStoredSession()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(null);

    // Without a session no further request reaches the server.
    const before = calls.length;
    await expect(
      client.get("/admin/users", ListUsersResponseSchema),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls.length).toBe(before);
  });

  it("keeps the stored token when the refresh fails transiently", async () => {
    const { client, tokens } = setup(() =>
      json(503, { error: { code: "internal", message: "down" } }),
    );
    await expect(client.restore()).rejects.toMatchObject({ code: "internal" });
    expect(tokens.get()).toBe("refresh-0");
  });

  it("parses error bodies into ApiError with field issues", async () => {
    const { client } = setup((url) => {
      if (url.endsWith("/auth/refresh")) return json(200, session(1));
      return json(400, {
        error: {
          code: "bad_request",
          message: "Invalid request body",
          details: [{ path: "username", message: "too short" }],
        },
      });
    });
    const err = (await client
      .request("/admin/users", { method: "POST", body: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("bad_request");
    expect(err.fieldIssues).toEqual([
      { path: "username", message: "too short" },
    ]);
  });

  it("sends raw bodies with a query string and downloads blobs", async () => {
    const { client, calls } = setup((url) => {
      if (url.endsWith("/auth/refresh")) return json(200, session(1));
      if (url.includes("/package")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "X-Content-SHA256": "abc" },
        });
      }
      return new Response(null, { status: 204 });
    });
    const zip = new Blob([new Uint8Array([80, 75])], {
      type: "application/zip",
    });
    await client.request("/admin/market/items/demo", {
      method: "PUT",
      query: {
        kind: "skill",
        name: "演示",
        description: "",
        mandatory: "false",
      },
      raw: { data: zip, contentType: "application/zip" },
    });
    const put = calls[1];
    expect(put?.url).toBe(
      "/api/v1/admin/market/items/demo?kind=skill&name=%E6%BC%94%E7%A4%BA&mandatory=false",
    );
    if (!put) throw new Error("PUT request not captured");
    expect((put.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/zip",
    );
    expect(put?.init.body).toBe(zip);

    const dl = await client.download("/market/items/demo/package");
    expect(dl.headers.get("X-Content-SHA256")).toBe("abc");
    expect(new Uint8Array(await dl.blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
