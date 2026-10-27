/** Talk to an unmodified Sub2API admin API. Tokens stay in this process. */

export interface Sub2ApiConfig {
  url: string;
  email: string;
  password: string;
}

export interface UpstreamWindow {
  id: "5h" | "7d";
  usedPercent: number;
  remainingSeconds: number;
  resetsAt: string | null;
  requests: number;
  tokens: number;
  accountCost: number;
  userCost: number;
}

export interface UpstreamAccount {
  subscriptionExpiresAt: string | null;
  planType: string | null;
  id: number;
  name: string;
  email: string | null;
  platform: string;
  type: string;
  status: string;
  schedulable: boolean;
  groups: string[];
  currentConcurrency: number;
  maxConcurrency: number;
  windows: UpstreamWindow[];
}

interface CachedToken {
  token: string;
  exp: number;
}

let cache: CachedToken | null = null;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function groupNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const g of raw) {
    if (typeof g === "string" && g.trim()) names.push(g);
    else if (g && typeof g === "object" && "name" in g) {
      const n = str((g as { name: unknown }).name);
      if (n) names.push(n);
    }
  }
  return names;
}

function windowFromUsage(
  id: "5h" | "7d",
  raw: unknown,
  extra: Record<string, unknown>,
): UpstreamWindow {
  const u =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const stats =
    u.window_stats && typeof u.window_stats === "object"
      ? (u.window_stats as Record<string, unknown>)
      : {};
  const extraPct =
    id === "5h" ? extra.codex_5h_used_percent : extra.codex_7d_used_percent;
  const extraReset =
    id === "5h" ? extra.codex_5h_reset_at : extra.codex_7d_reset_at;
  const extraRemain =
    id === "5h"
      ? extra.codex_5h_reset_after_seconds
      : extra.codex_7d_reset_after_seconds;
  return {
    id,
    usedPercent: num(u.utilization) || num(extraPct),
    remainingSeconds: Math.max(
      0,
      Math.floor(num(u.remaining_seconds) || num(extraRemain)),
    ),
    resetsAt: str(u.resets_at) ?? str(extraReset),
    requests: Math.max(0, Math.floor(num(stats.requests))),
    tokens: Math.max(0, Math.floor(num(stats.tokens))),
    accountCost: num(stats.cost),
    userCost: num(stats.user_cost),
  };
}

export function accountFromSub2Api(
  item: Record<string, unknown>,
  usage: Record<string, unknown> | undefined,
): UpstreamAccount {
  const extra =
    item.extra && typeof item.extra === "object"
      ? (item.extra as Record<string, unknown>)
      : {};
  const credentials =
    item.credentials && typeof item.credentials === "object"
      ? (item.credentials as Record<string, unknown>)
      : {};
  return {
    subscriptionExpiresAt:
      str(credentials.subscription_expires_at) ??
      str(item.parent_subscription_expires_at),
    planType: str(credentials.plan_type) ?? str(item.parent_plan_type),
    id: Math.floor(num(item.id)),
    name: str(item.name) ?? `#${item.id}`,
    email: str(extra.email),
    platform: str(item.platform) ?? "",
    type: str(item.type) ?? "",
    status: str(item.status) ?? "",
    schedulable: Boolean(item.schedulable),
    groups: groupNames(item.groups ?? item.account_groups),
    currentConcurrency: Math.max(0, Math.floor(num(item.current_concurrency))),
    maxConcurrency: Math.max(0, Math.floor(num(item.concurrency))),
    windows: [
      windowFromUsage("5h", usage?.five_hour, extra),
      windowFromUsage("7d", usage?.seven_day, extra),
    ],
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Sub2API returned non-JSON (${res.status})`);
  }
}

function envelopeData(body: unknown): unknown {
  if (body && typeof body === "object" && "data" in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

function connectionFailure(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const reasons = new Set<string>();
  const descriptions: Record<string, string> = {
    ECONNREFUSED: "连接被拒绝，请检查上游服务和端口",
    ENOTFOUND: "无法解析上游域名",
    EAI_AGAIN: "上游域名解析暂时失败",
    ETIMEDOUT: "连接上游超时",
    UND_ERR_CONNECT_TIMEOUT: "连接上游超时",
    UND_ERR_HEADERS_TIMEOUT: "等待上游响应超时",
    UND_ERR_BODY_TIMEOUT: "读取上游响应超时",
    ECONNRESET: "上游连接被中断",
    EPIPE: "上游连接被中断",
    UND_ERR_SOCKET: "上游连接被中断",
    ENETUNREACH: "无法访问上游网络",
    EHOSTUNREACH: "无法访问上游主机",
    CERT_HAS_EXPIRED: "上游 HTTPS 证书已过期",
    DEPTH_ZERO_SELF_SIGNED_CERT: "上游 HTTPS 证书不受信任",
    SELF_SIGNED_CERT_IN_CHAIN: "上游 HTTPS 证书不受信任",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "无法验证上游 HTTPS 证书",
    ERR_TLS_CERT_ALTNAME_INVALID: "上游 HTTPS 证书与域名不匹配",
    ERR_INVALID_URL: "上游地址格式无效",
  };
  while (pending.length > 0 && seen.size < 20) {
    const entry = pending.shift();
    if (!entry || typeof entry !== "object" || seen.has(entry)) continue;
    seen.add(entry);
    const detail = entry as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (
      typeof detail.code === "string" &&
      Object.hasOwn(descriptions, detail.code)
    )
      reasons.add(`${descriptions[detail.code]}（${detail.code}）`);
    else if (detail.name === "TimeoutError") reasons.add("请求上游超时");
    else if (detail.name === "AbortError") reasons.add("请求上游已中止");
    pending.push(detail.cause);
    if (Array.isArray(detail.errors)) pending.push(...detail.errors);
  }
  return [...reasons].join("；") || "无法建立上游连接";
}

async function fetchSub2Api(
  cfg: Sub2ApiConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(`${cfg.url}${path}`, init);
  } catch (error) {
    let origin = "地址格式无效";
    try {
      // Exclude user info, paths and query strings from the public diagnostic.
      origin = new URL(cfg.url).origin;
    } catch {
      // The request error still carries the original cause for server logs.
    }
    const stage = path.startsWith("/api/v1/auth/login")
      ? "登录上游"
      : path.startsWith("/api/v1/admin/accounts/usage/")
        ? "读取账号用量"
        : "读取账号列表";
    throw new Error(
      `${stage}失败：${connectionFailure(error)}；连接地址：${origin}`,
      { cause: error },
    );
  }
}

async function login(cfg: Sub2ApiConfig): Promise<string> {
  const now = Date.now();
  if (cache && cache.exp > now + 30_000) return cache.token;
  const res = await fetchSub2Api(cfg, "/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: cfg.email, password: cfg.password }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = envelopeData(await readJson(res));
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `login failed (${res.status})`;
    throw new Error(msg);
  }
  const rec =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const token = str(rec.access_token);
  if (!token) throw new Error("Sub2API login returned no access_token");
  const expiresIn = num(rec.expires_in) || 3600;
  cache = { token, exp: now + expiresIn * 1000 };
  return token;
}

async function authed(
  cfg: Sub2ApiConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const once = async (token: string) => {
    const res = await fetchSub2Api(cfg, path, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readJson(res);
    return { res, body };
  };
  let token = await login(cfg);
  let { res, body } = await once(token);
  if (res.status === 401) {
    cache = null;
    token = await login(cfg);
    ({ res, body } = await once(token));
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `Sub2API ${path} failed (${res.status})`;
    throw new Error(msg);
  }
  return envelopeData(body);
}

export async function listUpstreamAccounts(
  cfg: Sub2ApiConfig,
): Promise<UpstreamAccount[]> {
  const items: unknown[] = [];
  for (let page = 1; ; page++) {
    const list = (await authed(
      cfg,
      `/api/v1/admin/accounts?page=${page}&page_size=100`,
    )) as Record<string, unknown>;
    const batch = Array.isArray(list.items) ? list.items : [];
    items.push(...batch);
    if (
      batch.length < 100 ||
      (num(list.total) > 0 && items.length >= num(list.total))
    )
      break;
  }
  const ids = items
    .map((it) =>
      it && typeof it === "object"
        ? Math.floor(num((it as { id: unknown }).id))
        : 0,
    )
    .filter((id) => id > 0);
  let usageMap: Record<string, Record<string, unknown>> = {};
  if (ids.length > 0) {
    try {
      const batch = (await authed(cfg, "/api/v1/admin/accounts/usage/batch", {
        method: "POST",
        body: JSON.stringify({ account_ids: ids, force: false }),
      })) as Record<string, unknown>;
      const usage = batch.usage;
      if (usage && typeof usage === "object") {
        usageMap = usage as Record<string, Record<string, unknown>>;
      }
    } catch {
      // List extra still has cached 5h/7d percents.
    }
  }
  return items
    .filter(
      (it): it is Record<string, unknown> => !!it && typeof it === "object",
    )
    .map((it) => {
      const id = String(Math.floor(num(it.id)));
      return accountFromSub2Api(it, usageMap[id]);
    });
}

/** Tests / login-failure recovery. */
export function clearSub2ApiTokenCache(): void {
  cache = null;
}
