import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
});

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "member", "viewer"] }).notNull(),
  disabled: boolean("disabled").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/** One row per login (device). Revoking it invalidates its access and refresh tokens. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceName: text("device_name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/**
 * Refresh tokens are single-use. Rotated tokens are kept (with `used_at`) so a
 * replayed token can be detected and its whole session revoked.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("refresh_tokens_session_id_idx").on(t.sessionId)],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

// ---------------------------------------------------------------------------
// Phase 2 — gateway
// ---------------------------------------------------------------------------

export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  wireApi: text("wire_api", {
    enum: ["responses", "chat_completions"],
  }).notNull(),
  /** AES-256-GCM ciphertext (see src/secrets.ts). */
  apiKeyEnc: text("api_key_enc").notNull(),
  apiKeyHint: text("api_key_hint").notNull(),
  models: jsonb("models")
    .$type<{ id: string; displayName: string }[]>()
    .notNull(),
  defaultModel: text("default_model").notNull(),
  allowedRoles: jsonb("allowed_roles")
    .$type<("admin" | "member" | "viewer")[]>()
    .notNull(),
  dailyTokenLimitPerUser: integer("daily_token_limit_per_user"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** One gateway key per login session; dies with the session. */
export const gatewayKeys = pgTable(
  "gateway_keys",
  {
    keyHash: text("key_hash").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Desktop that requested this key. Null for keys issued before device binding. */
    deviceId: uuid("device_id"),
  },
  (t) => [uniqueIndex("gateway_keys_session_id_uq").on(t.sessionId)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    status: integer("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    deviceId: uuid("device_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_user_provider_time_idx").on(
      t.userId,
      t.providerId,
      t.createdAt,
    ),
    index("usage_time_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Settings (key → JSON). Keys: "retention" (AdminRetentionPolicy).
// ---------------------------------------------------------------------------

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Phase 3 — retention
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientSessionId: text("client_session_id").notNull(),
    deviceName: text("device_name"),
    title: text("title"),
    projectDir: text("project_dir"),
    model: text("model"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastMessageAt: timestamp("last_message_at", {
      withTimezone: true,
    }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("conversations_user_session_uq").on(
      t.userId,
      t.clientSessionId,
    ),
    index("conversations_last_message_idx").on(t.lastMessageAt),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    kind: text("kind", {
      enum: ["message", "reasoning", "tool_call", "tool_result"],
    }).notNull(),
    content: text("content").notNull(),
    toolName: text("tool_name"),
    timestamp: timestamp("timestamp", { withTimezone: true }),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  },
  (t) => [
    uniqueIndex("conversation_messages_seq_uq").on(t.conversationId, t.seq),
  ],
);

// ---------------------------------------------------------------------------
// Phase 4 — marketplace
// ---------------------------------------------------------------------------

export const marketBlobs = pgTable("market_blobs", {
  sha256: text("sha256").primaryKey(),
  data: bytea("data").notNull(),
  createdAt: createdAt(),
});

/**
 * A desktop that has heartbeated. `id` is generated on the machine
 * (`~/.cc-switch/fleet-device.json`) and stays with that install.
 */
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hostname: text("hostname").notNull().default(""),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reported: jsonb("reported").notNull(),
    appliedRevision: integer("applied_revision").notNull().default(0),
    applyError: text("apply_error"),
    /** Null means "use the default profile". */
    profileId: uuid("profile_id"),
    /** Profile the desktop last reported as applied. */
    appliedProfileId: uuid("applied_profile_id"),
    note: text("note").notNull().default(""),
    disabled: boolean("disabled").notNull().default(false),
    /** SHA-256 of the device secret. Null until the first heartbeat enrolls it. */
    secretHash: text("secret_hash"),
    /** Login session of the latest heartbeat, revoked when the device is disabled. */
    sessionId: uuid("session_id"),
    previousUserId: uuid("previous_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    userChangedAt: timestamp("user_changed_at", { withTimezone: true }),
    /** Set by an admin "sync now"; cleared when the desktop reports success. */
    forceSyncAt: timestamp("force_sync_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("devices_user_id_idx").on(t.userId),
    index("devices_last_seen_idx").on(t.lastSeenAt),
  ],
);

export const fleetProfiles = pgTable(
  "fleet_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    revision: integer("revision").notNull().default(0),
    mode: text("mode", { enum: ["direct", "route", "stack"] })
      .notNull()
      .default("direct"),
    activeProviderId: text("active_provider_id").notNull().default(""),
    stackMemberIds: jsonb("stack_member_ids").$type<string[]>().notNull(),
    providers: jsonb("providers").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("fleet_profiles_one_default")
      .on(t.isDefault)
      .where(sql`${t.isDefault} = true`),
  ],
);

/** Daily Codex usage reported by a desktop. One row per device, user, day, provider and model. */
export const deviceUsageDaily = pgTable(
  "device_usage_daily",
  {
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** USD * 1_000_000, so sums stay exact. */
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.deviceId, t.userId, t.date, t.providerId, t.model],
    }),
    index("device_usage_daily_date_idx").on(t.date),
  ],
);

export const marketItems = pgTable("market_items", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["skill", "plugin"] }).notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  version: text("version").notNull(),
  mandatory: boolean("mandatory").notNull().default(false),
  sha256: text("sha256")
    .notNull()
    .references(() => marketBlobs.sha256),
  sizeBytes: integer("size_bytes").notNull(),
  publishedBy: uuid("published_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
