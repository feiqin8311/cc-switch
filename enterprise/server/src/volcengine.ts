import { createHash, createHmac } from "node:crypto";
import {
  CodingPlanSubscriptionSchema,
  type CodingPlanUsageResponse,
  type CodingPlanWindow,
} from "@ccse/contracts";
import { z } from "zod";
import type { AppConfig } from "./config.ts";

type Credentials = NonNullable<AppConfig["volcengine"]>;
const HOST = "open.volcengineapi.com";
const CONTENT_TYPE = "application/json; charset=utf-8";
const SIGNED_HEADERS = "content-type;host;x-content-sha256;x-date";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();

/** Volcengine Signature V4. Inference Bearer API keys cannot query this OpenAPI. */
export function signVolcengineRequest(
  config: Credentials,
  action: "GetCodingPlanUsage" | "GetPersonalPlan",
  body: string,
  now = new Date(),
) {
  const query = new URLSearchParams({
    Action: action,
    Region: config.region,
    Version: "2024-01-01",
  }).toString();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = date.slice(0, 8);
  const digest = sha256(body);
  const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${HOST}\nx-content-sha256:${digest}\nx-date:${date}\n`;
  const canonicalRequest = [
    "POST",
    "/",
    query,
    canonicalHeaders,
    SIGNED_HEADERS,
    digest,
  ].join("\n");
  const scope = `${shortDate}/${config.region}/ark/request`;
  const toSign = ["HMAC-SHA256", date, scope, sha256(canonicalRequest)].join(
    "\n",
  );
  const dateKey = hmac(config.secretAccessKey, shortDate);
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, "ark");
  const signature = hmac(hmac(serviceKey, "request"), toSign).toString("hex");
  return {
    url: `https://${HOST}/?${query}`,
    headers: {
      "Content-Type": CONTENT_TYPE,
      "X-Date": date,
      "X-Content-Sha256": digest,
      Authorization: `HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    },
  };
}

const EnvelopeSchema = z.object({
  ResponseMetadata: z
    .object({
      Error: z.object({ Code: z.string() }).optional(),
    })
    .optional(),
  Result: z.unknown().optional(),
});

async function call(
  config: Credentials,
  action: "GetCodingPlanUsage" | "GetPersonalPlan",
  fetcher: typeof fetch,
) {
  const body =
    action === "GetPersonalPlan" ? JSON.stringify({ Plan: "CodingPlan" }) : "";
  const request = signVolcengineRequest(config, action, body);
  let response: Response;
  try {
    response = await fetcher(request.url, {
      method: "POST",
      headers: request.headers,
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new Error("连接火山方舟超时或网络不可用，请稍后重试");
  }
  let envelope: z.infer<typeof EnvelopeSchema>;
  try {
    envelope = EnvelopeSchema.parse(await response.json());
  } catch {
    throw new Error(`火山方舟返回了无法识别的响应（HTTP ${response.status}）`);
  }
  const code = envelope.ResponseMetadata?.Error?.Code;
  if (code || !response.ok) {
    // Do not relay upstream response bodies/messages: they may echo credentials.
    const safeCode =
      code &&
      /^[a-zA-Z0-9_.-]{1,100}$/.test(code) &&
      !code.includes(config.accessKeyId) &&
      !code.includes(config.secretAccessKey)
        ? code
        : `HTTP ${response.status}`;
    const auth =
      response.status === 401 ||
      response.status === 403 ||
      /auth|signature|access|credential|denied/i.test(safeCode);
    throw new Error(
      auth
        ? `火山方舟鉴权失败（${safeCode}），请检查服务端 AK/SK 与方舟查询权限`
        : `火山方舟查询失败（${safeCode}）`,
    );
  }
  return envelope.Result;
}

/** Never invent reset times for inactive sessions (ResetTimestamp = -1). */
export function volcengineDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date =
    typeof value === "number"
      ? new Date(value > 0 ? (value < 1e12 ? value * 1000 : value) : NaN)
      : typeof value === "string"
        ? new Date(value)
        : new Date(NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const UsageSchema = z.object({
  Status: z.string().optional(),
  UpdateTimestamp: z.number().optional(),
  QuotaUsage: z.array(
    z.object({
      Level: z.string(),
      Percent: z.number().min(0),
      ResetTimestamp: z.number().optional(),
    }),
  ),
});
const WINDOW_IDS: Record<string, CodingPlanWindow["id"] | undefined> = {
  session: "fiveHour",
  weekly: "weekly",
  monthly: "monthly",
};

export function parseCodingPlanUsage(raw: unknown) {
  const parsed = UsageSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error("火山方舟套餐用量响应格式已变化，请检查接口");
  const data = parsed.data;
  const windows = new Map<CodingPlanWindow["id"], CodingPlanWindow>();
  for (const row of data.QuotaUsage) {
    const id = WINDOW_IDS[row.Level.toLowerCase()];
    if (id)
      windows.set(id, {
        id,
        usedPercent: row.Percent,
        resetsAt: volcengineDate(row.ResetTimestamp),
      });
  }
  if (windows.size === 0)
    throw new Error("当前账号没有可读取的 Coding Plan 额度窗口");
  return {
    status: data.Status ?? null,
    sourceUpdatedAt: volcengineDate(data.UpdateTimestamp),
    windows: (["fiveHour", "weekly", "monthly"] as const).flatMap((id) => {
      const window = windows.get(id);
      return window ? [window] : [];
    }),
  };
}

const PersonalPlanSchema = z.object({
  PlanType: z.string().optional(),
  Status: z.string().optional(),
  StartTime: z.string().optional(),
  EndTime: z.string().optional(),
  AutoRenew: z.boolean().optional(),
});

/** Per-app cache + request coalescing. A failed refresh keeps the last good snapshot visibly stale. */
export function createCodingPlanReader(
  config: AppConfig["volcengine"],
  fetcher: typeof fetch = fetch,
  now = Date.now,
) {
  let snapshot: CodingPlanUsageResponse | null = null;
  let pending: Promise<CodingPlanUsageResponse> | null = null;
  let expires = 0;
  const empty = (): CodingPlanUsageResponse => ({
    configured: !!config,
    providerId: config?.providerId ?? "volcengine-coding",
    fetchedAt: null,
    sourceUpdatedAt: null,
    stale: false,
    error: null,
    warning: null,
    status: null,
    subscription: null,
    windows: [],
  });
  const refresh = async (): Promise<CodingPlanUsageResponse> => {
    if (!config) return empty();
    try {
      const [usageResult, planResult] = await Promise.allSettled([
        call(config, "GetCodingPlanUsage", fetcher),
        call(config, "GetPersonalPlan", fetcher),
      ]);
      if (usageResult.status === "rejected") throw usageResult.reason;
      const usage = parseCodingPlanUsage(usageResult.value);
      const plan =
        planResult.status === "fulfilled"
          ? PersonalPlanSchema.safeParse(planResult.value)
          : null;
      const subscription = plan?.success
        ? CodingPlanSubscriptionSchema.parse({
            planType: plan.data.PlanType ?? null,
            status: plan.data.Status ?? null,
            startsAt: volcengineDate(plan.data.StartTime),
            expiresAt: volcengineDate(plan.data.EndTime),
            autoRenew: plan.data.AutoRenew ?? null,
          })
        : null;
      snapshot = {
        ...empty(),
        ...usage,
        fetchedAt: new Date(now()).toISOString(),
        subscription,
        warning: subscription
          ? null
          : "套餐详情暂不可用；下方额度仍为火山方舟返回的实时数据。",
      };
      expires = now() + 30_000;
    } catch (e) {
      snapshot = {
        ...(snapshot ?? empty()),
        stale: !!snapshot?.fetchedAt,
        error:
          e instanceof Error ? e.message : "火山方舟用量查询失败，请稍后重试",
      };
      expires = now() + 10_000;
    }
    return snapshot;
  };
  return async (): Promise<CodingPlanUsageResponse> => {
    if (snapshot && now() < expires) return snapshot;
    if (!pending)
      pending = refresh().finally(() => {
        pending = null;
      });
    return pending;
  };
}
