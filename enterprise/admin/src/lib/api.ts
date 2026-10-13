import {
  API_PREFIX,
  type ErrorCode,
  ErrorResponseSchema,
  type LoginRequest,
  type Permission,
  type SessionResponse,
  SessionResponseSchema,
  type User,
} from "@ccse/contracts";
import { z } from "zod";
import { sessionTokenStore, type TokenStore } from "./tokenStore";

/** Server error codes plus the two failures that never reach the server. */
export type ApiErrorCode = ErrorCode | "network_error" | "invalid_response";

export interface FieldIssue {
  path: string;
  message: string;
}

const FieldIssuesSchema = z.array(
  z.object({ path: z.string(), message: z.string() }),
);

export class ApiError extends Error {
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Validation issues of a 400 response (`details` = `[{ path, message }]`). */
  get fieldIssues(): FieldIssue[] {
    const parsed = FieldIssuesSchema.safeParse(this.details);
    return parsed.success ? parsed.data : [];
  }
}

export interface SessionInfo {
  user: User;
  permissions: Permission[];
}

export type SessionListener = (session: SessionInfo | null) => void;

export interface ApiClientOptions {
  /** Defaults to `API_PREFIX` (same origin; proxied by Vite in dev). */
  baseUrl?: string;
  fetch?: typeof fetch;
  tokenStore?: TokenStore;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type QueryParams = Record<
  string,
  string | number | boolean | null | undefined
>;

/** A non-JSON request body (e.g. a zip package). Must be re-sendable for the 401 retry. */
export interface RawBody {
  data: Blob | ArrayBuffer;
  contentType: string;
}

export interface RequestOptions<T> {
  method?: HttpMethod;
  /** JSON body. */
  body?: unknown;
  /** Raw body; takes precedence over `body`. */
  raw?: RawBody;
  /** Appended as a query string; `undefined`/`null`/"" values are skipped. */
  query?: QueryParams;
  /** Validates the JSON response; omit for 204 responses. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

export interface Download {
  blob: Blob;
  headers: Headers;
}

interface Outgoing {
  method: string;
  body?: unknown;
  raw?: RawBody;
  accept?: string;
  signal?: AbortSignal;
}

export function buildQuery(query: QueryParams | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function fallbackCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      return "internal";
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = ErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(res.status, code, message, details);
  }
  return new ApiError(
    res.status,
    fallbackCode(res.status),
    res.statusText || `HTTP ${res.status}`,
  );
}

async function parseJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, "invalid_response", "Response is not JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      "invalid_response",
      "Response does not match the API contract",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

const sessionExpired = () =>
  new ApiError(401, "unauthorized", "Session expired");

/**
 * Fetch wrapper for the enterprise API.
 *
 * - The access token lives in memory only; the refresh token in a
 *   `TokenStore` (sessionStorage by default) so a reload keeps the session.
 * - On 401 the client refreshes once and retries once. Refresh tokens rotate
 *   and replaying one revokes the session, so concurrent refreshes share a
 *   single in-flight promise.
 * - When the session cannot be refreshed it is cleared and listeners get `null`.
 */
export class ApiClient {
  #accessToken: string | null = null;
  #refreshing: Promise<SessionResponse | null> | null = null;
  readonly #listeners = new Set<SessionListener>();
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #tokens: TokenStore;

  constructor(options: ApiClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? API_PREFIX;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#tokens = options.tokenStore ?? sessionTokenStore;
  }

  hasStoredSession(): boolean {
    return this.#tokens.get() !== null;
  }

  onSessionChange(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async login(req: LoginRequest): Promise<SessionInfo> {
    const res = await this.#send(
      "/auth/login",
      { method: "POST", body: req },
      null,
    );
    if (!res.ok) throw await toApiError(res);
    const session = await parseJson(res, SessionResponseSchema);
    return this.#applySession(session);
  }

  /**
   * Restores the session from the stored refresh token (after a reload).
   * Resolves `null` when there is no usable session; throws only on
   * transient failures (network, 5xx), keeping the stored token.
   */
  async restore(): Promise<SessionInfo | null> {
    if (!this.hasStoredSession()) return null;
    const session = await this.#refresh();
    return session
      ? { user: session.user, permissions: session.permissions }
      : null;
  }

  async logout(): Promise<void> {
    const refreshToken = this.#tokens.get();
    this.#clear();
    if (!refreshToken) return;
    try {
      await this.#send(
        "/auth/logout",
        { method: "POST", body: { refreshToken } },
        null,
      );
    } catch {
      // Best effort: the local session is gone either way.
    }
  }

  get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
    return this.request(path, { schema, signal });
  }

  async request<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    const { method = "GET", body, raw, query, schema, signal } = options;
    const res = await this.#authorized(`${path}${buildQuery(query)}`, {
      method,
      body,
      raw,
      signal,
    });
    if (!schema || res.status === 204) return undefined as T;
    return parseJson(res, schema);
  }

  /** GET a binary response (e.g. a zip package). */
  async download(path: string, signal?: AbortSignal): Promise<Download> {
    const res = await this.#authorized(path, {
      method: "GET",
      accept: "*/*",
      signal,
    });
    return { blob: await res.blob(), headers: res.headers };
  }

  /** Sends with the access token; on 401 refreshes once and retries once. */
  async #authorized(path: string, req: Outgoing): Promise<Response> {
    let token = this.#accessToken;
    if (!token) {
      token = (await this.#refresh())?.accessToken ?? null;
      if (!token) throw sessionExpired();
    }

    let res = await this.#send(path, req, token);
    if (res.status === 401) {
      // Another request may already have refreshed while this one was in flight.
      const current = this.#accessToken;
      const next =
        current && current !== token
          ? current
          : ((await this.#refresh())?.accessToken ?? null);
      if (!next) throw sessionExpired();
      res = await this.#send(path, req, next);
      if (res.status === 401) {
        const err = await toApiError(res);
        this.#clear();
        throw err;
      }
    }

    if (!res.ok) throw await toApiError(res);
    return res;
  }

  #refresh(): Promise<SessionResponse | null> {
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<SessionResponse | null> {
    const refreshToken = this.#tokens.get();
    if (!refreshToken) {
      this.#clear();
      return null;
    }
    const res = await this.#send(
      "/auth/refresh",
      { method: "POST", body: { refreshToken } },
      null,
    );
    // 400/401/403: the token is invalid, reused or the user was disabled.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      this.#clear();
      return null;
    }
    // Anything else (5xx, 429) is transient: keep the stored token.
    if (!res.ok) throw await toApiError(res);
    try {
      const session = await parseJson(res, SessionResponseSchema);
      this.#applySession(session);
      return session;
    } catch (err) {
      // The server has rotated the token already; the old one is useless.
      this.#clear();
      throw err;
    }
  }

  async #send(
    path: string,
    req: Outgoing,
    token: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: req.accept ?? "application/json",
    };
    let body: BodyInit | undefined;
    if (req.raw) {
      headers["Content-Type"] = req.raw.contentType;
      body = req.raw.data;
    } else if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method: req.method,
        headers,
        body,
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw new ApiError(0, "network_error", "Network request failed", err);
    }
  }

  #applySession(session: SessionResponse): SessionInfo {
    this.#accessToken = session.accessToken;
    this.#tokens.set(session.refreshToken);
    const info = { user: session.user, permissions: session.permissions };
    this.#emit(info);
    return info;
  }

  #clear(): void {
    const hadSession =
      this.#accessToken !== null || this.#tokens.get() !== null;
    this.#accessToken = null;
    this.#tokens.set(null);
    if (hadSession) this.#emit(null);
  }

  #emit(session: SessionInfo | null): void {
    for (const listener of this.#listeners) listener(session);
  }
}

export const api = new ApiClient();
