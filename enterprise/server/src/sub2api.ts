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
  const u = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
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
  return {
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

async function login(cfg: Sub2ApiConfig): Promise<string> {
  const now = Date.now();
  if (cache && cache.exp > now + 30_000) return cache.token;
  const res = await fetch(`${cfg.url}/api/v1/auth/login`, {
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
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
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
    const res = await fetch(`${cfg.url}${path}`, {
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
  const list = (await authed(
    cfg,
    "/api/v1/admin/accounts?page=1&page_size=100",
  )) as Record<string, unknown>;
  const items = Array.isArray(list.items) ? list.items : [];
  const ids = items
    .map((it) =>
      it && typeof it === "object" ? Math.floor(num((it as { id: unknown }).id)) : 0,
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
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it) => {
      const id = String(Math.floor(num(it.id)));
      return accountFromSub2Api(it, usageMap[id]);
    });
}

/** Tests / login-failure recovery. */
export function clearSub2ApiTokenCache(): void {
  cache = null;
}
