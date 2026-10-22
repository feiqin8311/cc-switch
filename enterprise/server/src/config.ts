import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(28473),
  /** postgres://… — required in production; unset in dev uses embedded PGlite. */
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default("./data"),
  /** HS256 secret for access tokens, ≥ 32 chars. Required in production. */
  JWT_SECRET: z.string().min(32).optional(),
  /** base64 of 32 random bytes; encrypts upstream API keys at rest. Required in production. */
  SECRETS_KEY: z.string().optional(),
  /** Set when running behind a reverse proxy so client IPs come from X-Forwarded-For. */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Admin console build to serve at "/" (skipped when missing). */
  ADMIN_DIST_DIR: z.string().default("../admin/dist"),
  ADMIN_USERNAME: z.string().default("admin"),
  /** Development default; production must provide an explicit password. */
  ADMIN_PASSWORD: z.string().min(6).default("123456"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  /** Sub2API admin panel, used to list ChatGPT/Codex 5h/7d windows. */
  SUB2API_URL: z.string().optional(),
  SUB2API_EMAIL: z.string().optional(),
  SUB2API_PASSWORD: z.string().optional(),
  VOLCENGINE_ACCESS_KEY_ID: z.string().optional(),
  VOLCENGINE_SECRET_ACCESS_KEY: z.string().optional(),
  VOLCENGINE_REGION: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+(?:-\d+)?$/)
    .default("cn-beijing"),
  VOLCENGINE_PROVIDER_ID: z.string().default("volcengine-coding"),
});

export interface AppConfig {
  env: "development" | "production" | "test";
  host: string;
  port: number;
  databaseUrl?: string;
  dataDir: string;
  jwtSecret: Uint8Array;
  /** 32-byte AES-256-GCM key. */
  secretsKey: Buffer;
  trustProxy: boolean;
  adminDistDir: string;
  /** Desktop updater manifest and artifacts (`latest.json` plus signed bundles). */
  updatesDir: string;
  admin: { username: string; password?: string };
  /** Present when SUB2API_URL + email + password are all set. */
  sub2api: { url: string; email: string; password: string } | null;
  volcengine: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    providerId: string;
  } | null;
  logLevel: string;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;

  if (e.NODE_ENV === "production") {
    if (!e.DATABASE_URL)
      throw new Error("DATABASE_URL is required in production");
    if (!e.JWT_SECRET) throw new Error("JWT_SECRET is required in production");
    if (!e.SECRETS_KEY)
      throw new Error("SECRETS_KEY is required in production");
    if (!env.ADMIN_PASSWORD)
      throw new Error("ADMIN_PASSWORD is required in production");
  }

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    dataDir: e.DATA_DIR,
    jwtSecret: new TextEncoder().encode(
      e.JWT_SECRET ?? loadOrCreateDevSecret(join(e.DATA_DIR, "dev-jwt-secret")),
    ),
    secretsKey: parseSecretsKey(
      e.SECRETS_KEY ??
        loadOrCreateDevSecret(join(e.DATA_DIR, "dev-secrets-key"), () =>
          randomBytes(32).toString("base64"),
        ),
    ),
    trustProxy: e.TRUST_PROXY,
    adminDistDir: e.ADMIN_DIST_DIR,
    updatesDir: join(e.DATA_DIR, "updates"),
    admin: { username: e.ADMIN_USERNAME, password: e.ADMIN_PASSWORD },
    sub2api: (() => {
      const url = e.SUB2API_URL?.trim();
      const email = e.SUB2API_EMAIL?.trim();
      const password = e.SUB2API_PASSWORD;
      if (!url || !email || !password) return null;
      return { url: url.replace(/\/$/, ""), email, password };
    })(),
    logLevel: e.LOG_LEVEL,
    volcengine: (() => {
      const accessKeyId = e.VOLCENGINE_ACCESS_KEY_ID?.trim();
      const secretAccessKey = e.VOLCENGINE_SECRET_ACCESS_KEY?.trim();
      if (!accessKeyId || !secretAccessKey) return null;
      return {
        accessKeyId,
        secretAccessKey,
        region: e.VOLCENGINE_REGION,
        providerId: e.VOLCENGINE_PROVIDER_ID,
      };
    })(),
    version: pkg.version,
  };
}

/** Dev only: keep a generated secret on disk so tokens survive restarts. */
function loadOrCreateDevSecret(
  file: string,
  generate: () => string = () => randomBytes(48).toString("base64url"),
): string {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = generate();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function parseSecretsKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("SECRETS_KEY must be base64 of exactly 32 bytes");
  }
  return key;
}
