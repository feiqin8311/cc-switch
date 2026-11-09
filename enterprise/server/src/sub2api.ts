/** Talk to an unmodified Sub2API admin API. Tokens stay in this process. */
import { ProxyAgent } from "undici";

export interface Sub2ApiConfig {
  url: string;
  email: string;
  password: string;
  /** HTTP(S) proxy for Sub2API admin and model requests; may include encoded credentials. */
  proxyUrl?: string;
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
const proxyAgents = new WeakMap<Sub2ApiConfig, ProxyAgent>();

/** Share the proxy with gateway providers hosted at the configured Sub2API origin. */
export function fetchWithSub2ApiProxy(
  cfg: Sub2ApiConfig | null,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const request: RequestInit & { dispatcher?: ProxyAgent } = { ...init };
  if (cfg?.proxyUrl && new URL(url).origin === new URL(cfg.url).origin) {
    let agent = proxyAgents.get(cfg);
    if (!agent) {
      agent = new ProxyAgent(cfg.proxyUrl);
      proxyAgents.set(cfg, agent);
    }
    request.dispatcher = agent;
  }
  return fetch(url, request);
}

export async function closeSub2ApiConnections(
  cfg: Sub2ApiConfig,
): Promise<void> {
  const agent = proxyAgents.get(cfg);
  proxyAgents.delete(cfg);
  await agent?.close();
}

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
    return await fetchWithSub2ApiProxy(cfg, `${cfg.url}${path}`, init);
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

export interface UpstreamUsageRecord {
  id: number;
  apiKeyId: number;
  apiKeyName?: string | null;
  accountName?: string | null;
  groupName?: string | null;
  requestId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  imageCount: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  actualCost: number | null;
  totalCost: number | null;
  createdAt: string;
}

/** Read all pages; the upstream can report an approximate total. */
export async function listUpstreamUsage(
  cfg: Sub2ApiConfig,
  from: string,
  to: string,
): Promise<UpstreamUsageRecord[]> {
  const result = new Map<number, UpstreamUsageRecord>();
  const count = (value: unknown, field: string): number => {
    const n = Number(value ?? 0);
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error(`上游用量记录 ${field} 格式不正确`);
    return n;
  };
  const cost = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0)
      throw new Error("上游用量记录费用格式不正确");
    return n;
  };
  for (let page = 1; page <= 10000; page++) {
    const query = new URLSearchParams({
      page: String(page),
      page_size: "100",
      start_date: from,
      end_date: to,
      timezone: "UTC",
    });
    const raw = await authed(cfg, `/api/v1/admin/usage?${query}`);
    if (
      !raw ||
      typeof raw !== "object" ||
      !Array.isArray((raw as Record<string, unknown>).items)
    )
      throw new Error("上游用量列表格式不正确");
    const batch = (raw as { items: unknown[] }).items;
    let added = 0;
    for (const value of batch) {
      if (!value || typeof value !== "object")
        throw new Error("上游用量记录格式不正确");
      const row = value as Record<string, unknown>;
      const id = count(row.id, "id");
      const apiKeyId = count(row.api_key_id, "api_key_id");
      const model = str(row.model);
      const createdAt = str(row.created_at);
      if (
        !id ||
        !apiKeyId ||
        !model ||
        !createdAt ||
        !Number.isFinite(Date.parse(createdAt))
      )
        throw new Error("上游用量记录缺少必要字段");
      if (!result.has(id)) added++;
      const nameOf = (value: unknown) =>
        value && typeof value === "object"
          ? str((value as Record<string, unknown>).name)
          : null;
      result.set(id, {
        id,
        apiKeyId,
        apiKeyName: nameOf(row.api_key),
        accountName: nameOf(row.account),
        groupName: nameOf(row.group),
        requestId: str(row.request_id),
        model,
        inputTokens: count(row.input_tokens, "input_tokens"),
        outputTokens: count(row.output_tokens, "output_tokens"),
        cacheReadTokens: count(row.cache_read_tokens, "cache_read_tokens"),
        cacheCreationTokens: count(
          row.cache_creation_tokens,
          "cache_creation_tokens",
        ),
        imageCount: count(row.image_count, "image_count"),
        imageInputTokens: count(row.image_input_tokens, "image_input_tokens"),
        imageOutputTokens: count(
          row.image_output_tokens,
          "image_output_tokens",
        ),
        actualCost: cost(row.actual_cost),
        totalCost: cost(row.total_cost),
        createdAt,
      });
    }
    if (batch.length < 100) return [...result.values()];
    if (!added) throw new Error("上游用量分页重复，无法确认同步完整");
  }
  throw new Error("上游用量页数超过限制");
}

/** Read only the current upstream login's key list; never return key material. */
export async function listUpstreamUserEntries(
  cfg: Sub2ApiConfig,
): Promise<Array<{ id: number; name: string; groupName: string }>> {
  const result: Array<{ id: number; name: string; groupName: string }> = [];
  for (let page = 1; page <= 10000; page++) {
    const raw = await authed(cfg, `/api/v1/keys?page=${page}&page_size=100`);
    if (
      !raw ||
      typeof raw !== "object" ||
      !Array.isArray((raw as Record<string, unknown>).items)
    ) {
      throw new Error("上游密钥列表格式不正确");
    }
    const list = raw as { items: unknown[]; total?: number };
    for (const value of list.items) {
      if (!value || typeof value !== "object")
        throw new Error("上游密钥记录格式不正确");
      const entry = value as Record<string, unknown>;
      const id = Number(entry.id);
      const name = str(entry.name)?.trim();
      if (!Number.isSafeInteger(id) || id <= 0 || !name)
        throw new Error("上游密钥记录缺少名称或 ID");
      const group = entry.group;
      const groupName =
        group && typeof group === "object"
          ? str((group as Record<string, unknown>).name)?.trim()
          : null;
      if (entry.group_id != null && !groupName)
        throw new Error("上游密钥分组信息不完整");
      result.push({ id, name, groupName: groupName ?? "" });
    }
    const total = Number(list.total);
    if (Number.isFinite(total) && total >= 0 && list.total != null) {
      if (result.length >= total) return result;
      if (list.items.length === 0) throw new Error("上游密钥列表分页不完整");
    } else if (list.items.length < 100) return result;
  }
  throw new Error("上游密钥列表页数超过限制");
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
  const syncedItems = items.filter(
    (it): it is Record<string, unknown> => !!it && typeof it === "object",
  );
  const ids = syncedItems
    .map((it) => Math.floor(num(it.id)))
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
  return syncedItems.map((it) => {
    const id = String(Math.floor(num(it.id)));
    return accountFromSub2Api(it, usageMap[id]);
  });
}

export interface WeeklyUsageSample {
  id: number;
  usedPercent: number;
  resetsAt: string | null;
}

/** Unlike the display adapter, missing usage is not treated as zero. */
export async function readWeeklyUsageSamples(
  cfg: Sub2ApiConfig,
  ids: number[],
): Promise<WeeklyUsageSample[]> {
  if (ids.length === 0) return [];
  const result = await authed(cfg, "/api/v1/admin/accounts/usage/batch", {
    method: "POST",
    body: JSON.stringify({ account_ids: ids, force: false }),
  });
  if (!result || typeof result !== "object" || !("usage" in result))
    throw new Error("上游未返回账号用量");
  const usage = (result as { usage: unknown }).usage;
  if (!usage || typeof usage !== "object")
    throw new Error("上游账号用量格式不正确");
  const samples: WeeklyUsageSample[] = [];
  for (const id of ids) {
    const entry = (usage as Record<string, unknown>)[String(id)];
    if (!entry || typeof entry !== "object") continue;
    const weekly = (entry as Record<string, unknown>).seven_day;
    if (!weekly || typeof weekly !== "object") continue;
    const data = weekly as Record<string, unknown>;
    const value = data.utilization;
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim())
    )
      continue;
    const usedPercent = Number(value);
    if (!Number.isFinite(usedPercent) || usedPercent < 0) continue;
    const reset = str(data.resets_at);
    samples.push({
      id,
      usedPercent,
      resetsAt:
        reset && Number.isFinite(Date.parse(reset))
          ? new Date(reset).toISOString()
          : null,
    });
  }
  return samples;
}

/** Tests / login-failure recovery. */
export function clearSub2ApiTokenCache(): void {
  cache = null;
}
