/**
 * CC Switch Enterprise API contract (v1).
 *
 * Single source of truth for the enterprise server, the admin console and the
 * desktop client. The server validates every request body with these schemas;
 * clients import the inferred types (`import type`) only.
 *
 * Conventions:
 * - All routes live under `API_PREFIX`.
 * - Timestamps are ISO-8601 strings in UTC.
 * - Authenticated routes take `Authorization: Bearer <accessToken>`.
 * - Every non-2xx response has the `ErrorResponse` shape.
 */
import { z } from "zod";

export const API_PREFIX = "/api/v1";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "payload_too_large",
  /** Gateway could not reach the upstream model provider (HTTP 502). */
  "upstream_error",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum(["admin", "member", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const PermissionSchema = z.enum([
  /** Create, edit and disable users. */
  "users.manage",
  /** Manage gateway providers, model allowlists and quotas. */
  "providers.manage",
  /** Read retained conversations of all users. */
  "audit.read",
  /** Publish skills / plugins to the enterprise marketplace. */
  "market.manage",
  /** Use enterprise-managed models through the gateway. */
  "models.use",
  /** Install skills / plugins from the enterprise marketplace. */
  "market.install",
  /** Edit server-wide settings such as the retention policy. */
  "settings.manage",
]);
export type Permission = z.infer<typeof PermissionSchema>;

/** Role → permission mapping. Enforced on the server; clients only use it for UI. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: [
    "users.manage",
    "providers.manage",
    "audit.read",
    "market.manage",
    "models.use",
    "market.install",
    "settings.manage",
  ],
  member: ["models.use", "market.install"],
  viewer: [],
};

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const UsernameSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/,
    "3-32 chars: letters, digits, '.', '_' or '-'",
  );

export const PasswordSchema = z.string().min(10).max(128);

export const DisplayNameSchema = z.string().trim().min(1).max(64);

export const UserSchema = z.object({
  id: z.string().uuid(),
  username: UsernameSchema,
  displayName: z.string(),
  role: RoleSchema,
  disabled: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** POST /auth/login */
export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  /** Free-form label shown in the admin console, e.g. "MacBook-Pro (CC Switch 4.0.10)". */
  deviceName: z.string().max(100).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SessionResponseSchema = z.object({
  /** Short-lived JWT (15 min). */
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  /** Opaque, single-use; every refresh returns a new one. */
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string(),
  user: UserSchema,
  permissions: z.array(PermissionSchema),
});
/** Response of login and refresh. */
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** POST /auth/refresh — rotates the refresh token. Reusing an old one revokes the whole session. */
export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** POST /auth/logout — revokes the session the refresh token belongs to. Always 204. */
export const LogoutRequestSchema = RefreshRequestSchema;
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

/** GET /me */
export const MeResponseSchema = z.object({
  user: UserSchema,
  permissions: z.array(PermissionSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------------------------------------------------------------------------
// Admin: users (requires users.manage)
// ---------------------------------------------------------------------------

/** GET /admin/users */
export const ListUsersResponseSchema = z.object({
  items: z.array(UserSchema),
});
export type ListUsersResponse = z.infer<typeof ListUsersResponseSchema>;

/** POST /admin/users → 201 User */
export const CreateUserRequestSchema = z.object({
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  password: PasswordSchema,
  role: RoleSchema,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

/**
 * PATCH /admin/users/:id → 200 User
 * Disabling a user or changing their password/role revokes all their sessions.
 * An admin cannot disable or demote themselves.
 */
export const UpdateUserRequestSchema = z
  .object({
    displayName: DisplayNameSchema.optional(),
    role: RoleSchema.optional(),
    disabled: z.boolean().optional(),
    password: PasswordSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

// ---------------------------------------------------------------------------
// Desktop client
// ---------------------------------------------------------------------------

export const ManagedModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});
export type ManagedModel = z.infer<typeof ManagedModelSchema>;

/**
 * A Codex provider pushed by the enterprise, reached through the enterprise
 * gateway (upstream API keys never leave the server). The client builds the
 * Codex `base_url` as `<serverUrl><gatewayPath>` and authenticates with its
 * gateway key (see `GatewayKeyResponse`).
 */
export const WireApiSchema = z.enum(["responses", "chat_completions"]);
export type WireApi = z.infer<typeof WireApiSchema>;

export const ManagedProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.literal("gateway"),
  /** e.g. "/gateway/openai-main/v1" — OpenAI Responses API compatible. */
  gatewayPath: z.string(),
  wireApi: WireApiSchema,
  models: z.array(ManagedModelSchema),
  defaultModel: z.string(),
  /** Per-user daily token limit (input + output, UTC day); null = unlimited. */
  dailyTokenLimit: z.number().int().nullable(),
  usedTokensToday: z.number().int(),
});
export type ManagedProvider = z.infer<typeof ManagedProviderSchema>;

export const RetentionPolicySchema = z.object({
  /** When true the client uploads Codex conversations to the server. */
  enabled: z.boolean(),
  /** Text the client must show the user before uploading anything. */
  noticeText: z.string(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

/** GET /client/config */
export const ClientConfigResponseSchema = z.object({
  user: UserSchema,
  permissions: z.array(PermissionSchema),
  providers: z.array(ManagedProviderSchema),
  retention: RetentionPolicySchema,
  serverTime: z.string(),
});
export type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 2 — model gateway
// ---------------------------------------------------------------------------

export const ProviderIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,31}$/,
    "2-32 chars: lowercase letters, digits or '-'",
  );

const ModelListSchema = z
  .array(
    z.object({
      id: z.string().trim().min(1).max(128),
      displayName: z.string().trim().min(1).max(128),
    }),
  )
  .min(1)
  .max(100);

/** Upstream base URL, e.g. "https://api.openai.com/v1" (the gateway appends "/responses"). */
const UpstreamBaseUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "must be http(s)");

/** Admin view of a gateway provider. The API key is never returned. */
export const AdminProviderSchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  baseUrl: z.string(),
  wireApi: WireApiSchema,
  /** e.g. "sk-…a1b2" */
  apiKeyHint: z.string(),
  models: z.array(ManagedModelSchema),
  defaultModel: z.string(),
  /** Roles allowed to use it (the user also needs `models.use`). */
  allowedRoles: z.array(RoleSchema),
  dailyTokenLimitPerUser: z.number().int().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminProvider = z.infer<typeof AdminProviderSchema>;

/** GET /admin/providers (providers.manage) */
export const ListProvidersResponseSchema = z.object({
  items: z.array(AdminProviderSchema),
});
export type ListProvidersResponse = z.infer<typeof ListProvidersResponseSchema>;

const providerFields = {
  name: z.string().trim().min(1).max(64),
  baseUrl: UpstreamBaseUrlSchema,
  wireApi: WireApiSchema.default("responses"),
  apiKey: z.string().min(1).max(512),
  models: ModelListSchema,
  defaultModel: z.string().min(1),
  allowedRoles: z.array(RoleSchema).min(1),
  dailyTokenLimitPerUser: z.number().int().positive().nullable().default(null),
  enabled: z.boolean().default(true),
};

/** POST /admin/providers → 201 AdminProvider; 409 if the id exists. */
export const CreateProviderRequestSchema = z
  .object({ id: ProviderIdSchema, ...providerFields })
  .refine((v) => v.models.some((m) => m.id === v.defaultModel), {
    message: "defaultModel must be one of models",
    path: ["defaultModel"],
  });
export type CreateProviderRequest = z.input<typeof CreateProviderRequestSchema>;

/**
 * PATCH /admin/providers/:id → 200 AdminProvider. Omit `apiKey` to keep the
 * stored key. If `models` changes, `defaultModel` must still be one of them
 * (send both when needed; 400 otherwise).
 */
export const UpdateProviderRequestSchema = z
  .object({
    name: providerFields.name.optional(),
    baseUrl: providerFields.baseUrl.optional(),
    wireApi: WireApiSchema.optional(),
    apiKey: providerFields.apiKey.optional(),
    models: providerFields.models.optional(),
    defaultModel: z.string().min(1).optional(),
    allowedRoles: providerFields.allowedRoles.optional(),
    dailyTokenLimitPerUser: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });
export type UpdateProviderRequest = z.infer<typeof UpdateProviderRequestSchema>;

/* DELETE /admin/providers/:id → 204 */

/**
 * POST /client/gateway-key (any signed-in user with `models.use`) → 200.
 * One key per login session; requesting again replaces the previous key of
 * this session. The key dies with the session (logout, disable, expiry).
 */
export const GatewayKeyResponseSchema = z.object({
  /** "gk_…" — send as `Authorization: Bearer <key>` to the gateway. */
  key: z.string(),
  createdAt: z.string(),
});
export type GatewayKeyResponse = z.infer<typeof GatewayKeyResponseSchema>;

/*
 * Gateway (OpenAI Responses API compatible; auth: Bearer gateway key):
 *   POST /gateway/:providerId/v1/responses  — body forwarded as-is, `model`
 *        must be one of the provider's models. Streams (SSE) or JSON back with
 *        the upstream status. Usage is recorded from `response.completed`.
 *   GET  /gateway/:providerId/v1/models     — { object: "list", data: [{ id, object: "model", owned_by }] }
 * Errors: 401 bad key, 403 provider not allowed / disabled, 400 model not
 * allowed, 429 daily limit reached, 502 upstream unreachable. Same ErrorResponse shape.
 * Note: gateway routes are NOT under API_PREFIX.
 */
export const GATEWAY_PREFIX = "/gateway";

/** GET /admin/usage?from=YYYY-MM-DD&to=YYYY-MM-DD (audit.read). Dates are UTC, inclusive; max 92 days. */
export const UsageQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const UsageRowSchema = z.object({
  date: z.string(),
  userId: z.string(),
  username: z.string(),
  providerId: z.string(),
  model: z.string(),
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
});
export type UsageRow = z.infer<typeof UsageRowSchema>;
export const UsageResponseSchema = z.object({ items: z.array(UsageRowSchema) });
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 3 — conversation retention
// ---------------------------------------------------------------------------

/**
 * GET /admin/retention-policy (audit.read), PUT (settings.manage) → policy.
 * The client only uploads Codex sessions that START after the user
 * acknowledged `noticeText` on that device; history before that is never sent.
 */
export const AdminRetentionPolicySchema = z.object({
  enabled: z.boolean(),
  noticeText: z.string().max(2000),
  /** Conversations idle longer than this are deleted by the server. */
  retentionDays: z.number().int().min(1).max(3650),
});
export type AdminRetentionPolicy = z.infer<typeof AdminRetentionPolicySchema>;

export const MessageRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
]);
export const MessageKindSchema = z.enum([
  "message",
  "reasoning",
  "tool_call",
  "tool_result",
]);

/** Max content length per message; clients truncate and append "…[truncated]". */
export const MAX_MESSAGE_CONTENT = 256 * 1024;

export const RetainedMessageSchema = z.object({
  /** Position in the Codex rollout; (conversation, seq) is the idempotency key. */
  seq: z.number().int().min(0),
  role: MessageRoleSchema,
  kind: MessageKindSchema,
  content: z.string().max(MAX_MESSAGE_CONTENT + 64),
  toolName: z.string().max(200).nullable(),
  timestamp: z.string().nullable(),
  model: z.string().max(200).nullable(),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
});
export type RetainedMessage = z.infer<typeof RetainedMessageSchema>;

export const ConversationUploadSchema = z.object({
  /** Codex session id (rollout `session_meta.id`). */
  clientSessionId: z.string().min(1).max(200),
  title: z.string().max(500).nullable(),
  projectDir: z.string().max(1000).nullable(),
  startedAt: z.string(),
  /** New messages only (already-uploaded seqs are ignored server-side). */
  messages: z.array(RetainedMessageSchema).max(2000),
});
export type ConversationUpload = z.infer<typeof ConversationUploadSchema>;

/**
 * POST /retention/conversations (any signed-in user; 403 when the policy is
 * disabled). Body limit 16 MB.
 */
export const RetentionUploadRequestSchema = z.object({
  items: z.array(ConversationUploadSchema).min(1).max(50),
});
export type RetentionUploadRequest = z.infer<
  typeof RetentionUploadRequestSchema
>;
export const RetentionUploadResponseSchema = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
});
export type RetentionUploadResponse = z.infer<
  typeof RetentionUploadResponseSchema
>;

export const ConversationSummarySchema = z.object({
  id: z.string(),
  user: z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
  }),
  clientSessionId: z.string(),
  deviceName: z.string().nullable(),
  title: z.string().nullable(),
  projectDir: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.string(),
  lastMessageAt: z.string(),
  messageCount: z.number().int(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

/**
 * GET /admin/conversations?userId=&q=&from=&to=&cursor=&limit= (audit.read)
 * Newest first by lastMessageAt; `q` matches title or message content
 * (case-insensitive substring); limit default 50, max 200.
 */
export const ListConversationsQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const ListConversationsResponseSchema = z.object({
  items: z.array(ConversationSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListConversationsResponse = z.infer<
  typeof ListConversationsResponseSchema
>;

/** GET /admin/conversations/:id (audit.read) */
export const ConversationDetailResponseSchema = z.object({
  conversation: ConversationSummarySchema,
  messages: z.array(RetainedMessageSchema),
});
export type ConversationDetailResponse = z.infer<
  typeof ConversationDetailResponseSchema
>;

// ---------------------------------------------------------------------------
// Phase 4 — skill / plugin marketplace
// ---------------------------------------------------------------------------

export const MarketItemKindSchema = z.enum(["skill", "plugin"]);
export type MarketItemKind = z.infer<typeof MarketItemKindSchema>;

/** Max package size accepted by the server. */
export const MAX_MARKET_PACKAGE_BYTES = 20 * 1024 * 1024;

/**
 * Package formats (zip):
 * - skill:  a single skill directory (contains SKILL.md), either at the zip root
 *           or as the only top-level folder.
 * - plugin: a Codex plugin directory (contains .codex-plugin/plugin.json),
 *           either at the zip root or as the only top-level folder.
 */
export const MarketItemSchema = z.object({
  /** Slug; for plugins it is also the Codex plugin name. */
  id: ProviderIdSchema,
  kind: MarketItemKindSchema,
  name: z.string(),
  description: z.string(),
  version: z.string(),
  /** Mandatory items are installed automatically by the client. */
  mandatory: z.boolean(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  updatedAt: z.string(),
});
export type MarketItem = z.infer<typeof MarketItemSchema>;

/** GET /market/items (market.install or market.manage) */
export const ListMarketItemsResponseSchema = z.object({
  items: z.array(MarketItemSchema),
});
export type ListMarketItemsResponse = z.infer<
  typeof ListMarketItemsResponseSchema
>;

/*
 * GET /market/items/:id/package (market.install or market.manage)
 *   → application/zip, header `X-Content-SHA256: <sha256>`; the client must verify it.
 *
 * PUT /admin/market/items/:id (market.manage) — create or replace.
 *   Content-Type: application/zip, body = package bytes (≤ MAX_MARKET_PACKAGE_BYTES).
 *   Metadata in query string: kind, name, description, version, mandatory=true|false
 *   (validated with MarketItemMetadataSchema). The server validates the zip
 *   layout for the kind. → 200 MarketItem
 * PATCH /admin/market/items/:id (market.manage) body MarketItemPatchSchema → 200 MarketItem
 * DELETE /admin/market/items/:id (market.manage) → 204
 */
export const MarketItemMetadataSchema = z.object({
  kind: MarketItemKindSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(""),
  version: z.string().trim().min(1).max(50),
  mandatory: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export const MarketItemPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(1000).optional(),
    mandatory: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });
export type MarketItemPatch = z.infer<typeof MarketItemPatchSchema>;

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** GET /health (no auth) */
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
