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

export const RoleSchema = z.enum([
  "admin",
  "group_leader",
  "leader",
  "member",
  "viewer",
]);
export type Role = z.infer<typeof RoleSchema>;

export const PermissionSchema = z.enum([
  /** Create, edit and disable users. */
  "users.manage",
  /** Read own group and change its members between member and viewer. */
  "users.group.manage",
  /** Read usage for the current user's group only. */
  "usage.group.read",
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
  /** Independently delegated admin menu permissions. */
  "usage.read",
  "upstream.read",
  "conversations.read",
  "retention.manage",
  "mcp.manage",
  "connectors.manage",
  "skills.manage",
  "prompts.manage",
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
  group_leader: [
    "users.group.manage",
    "usage.group.read",
    "models.use",
    "market.install",
  ],
  /** Generic delegated role; all admin menus are explicitly selected per user. */
  leader: [],
  member: ["models.use", "market.install"],
  viewer: [],
};

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export const AdminMenuSchema = z.enum([
  "users",
  "devices",
  "usage",
  "upstream",
  "mcp",
  "connectors",
  "skills",
  "prompts",
  "conversations",
]);
export type AdminMenu = z.infer<typeof AdminMenuSchema>;

export const ADMIN_MENU_LABELS: Record<AdminMenu, string> = {
  users: "用户管理",
  devices: "设备管理",
  usage: "用量统计",
  upstream: "上游账号",
  mcp: "MCP",
  connectors: "连接器",
  skills: "Skills",
  prompts: "提示词",
  conversations: "会话",
};

/** null preserves the role defaults; [] explicitly closes every admin menu. */
export const AdminMenusSchema = z.array(AdminMenuSchema).max(9).nullable();

export function adminMenusForRole(role: Role): AdminMenu[] {
  return role === "admin"
    ? [...AdminMenuSchema.options]
    : role === "group_leader"
      ? ["users", "usage"]
      : [];
}

export function permissionsForUser(user: {
  role: Role;
  adminMenus?: AdminMenu[] | null;
}): Permission[] {
  if (user.role === "admin" || user.adminMenus == null) {
    return permissionsForRole(user.role);
  }
  const grants: Record<AdminMenu, Permission[]> = {
    // Delegated user management retains the existing group boundary.
    users: ["users.group.manage"],
    devices: ["settings.manage", "providers.manage"],
    usage: [user.role === "group_leader" ? "usage.group.read" : "usage.read"],
    upstream: ["upstream.read"],
    mcp: ["mcp.manage"],
    connectors: ["connectors.manage"],
    skills: ["skills.manage"],
    prompts: ["prompts.manage"],
    conversations: ["conversations.read", "retention.manage"],
  };
  const base = permissionsForRole(user.role).filter(
    (p) => p === "models.use" || p === "market.install",
  );
  return [
    ...new Set([...base, ...user.adminMenus.flatMap((menu) => grants[menu])]),
  ];
}

export function canManageMarketKind(
  permissions: readonly Permission[],
  kind: string,
): boolean {
  const permission: Record<string, Permission> = {
    mcp: "mcp.manage",
    connector: "connectors.manage",
    skill: "skills.manage",
    plugin: "skills.manage",
    prompt: "prompts.manage",
  };
  return (
    permissions.includes("market.manage") ||
    (permission[kind] !== undefined && permissions.includes(permission[kind]))
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const UsernameSchema = z
  .string()
  .trim()
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N}._-]{1,31}$/u,
    "2-32 chars: letters (any language), digits, '.', '_' or '-'",
  );

export const PasswordSchema = z.string().min(6).max(128);

export const DisplayNameSchema = z.string().trim().min(1).max(64);

/** Org group shown on the users table. Empty means the user is ungrouped. */
export const GroupNameSchema = z.string().trim().max(64);

export const UserSchema = z.object({
  id: z.string().uuid(),
  username: UsernameSchema,
  displayName: z.string(),
  role: RoleSchema,
  adminMenus: AdminMenusSchema.default(null),
  disabled: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  /** Sub2API ids plus CODING_PLAN_ACCOUNT_ID for desktop and web account visibility. Admins see all. */
  upstreamAccountIds: z.array(z.number().int()).default([]),
  /** Empty when the user is not in a group. */
  groupName: GroupNameSchema.default(""),
  /** Set when an admin offboarded the user; cleared again if they are re-enabled. */
  offboardedAt: z.string().nullable().default(null),
  /** Username of the admin who offboarded the user. */
  offboardedBy: z.string().nullable().default(null),
});
export type User = z.infer<typeof UserSchema>;

/** Minimal identity fields for provider and marketplace audience selectors. */
export const UserOptionSchema = UserSchema.pick({
  id: true,
  username: true,
  displayName: true,
  groupName: true,
});
export type UserOption = z.infer<typeof UserOptionSchema>;
export const UserOptionsResponseSchema = z.object({
  items: z.array(UserOptionSchema),
});

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
  displayName: DisplayNameSchema.optional(),
  password: PasswordSchema,
  role: RoleSchema,
  upstreamAccountIds: z.array(z.number().int()).optional(),
  groupName: GroupNameSchema.optional(),
  adminMenus: AdminMenusSchema.optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

/**
 * PATCH /admin/users/:id → 200 User
 * Disabling a user or changing their password/role/admin menus revokes all their sessions.
 * Re-enabling an offboarded user clears `offboardedAt`.
 * Renaming keeps the user's sessions; a display name that still equals the
 * old username follows the rename. 409 when the username is taken.
 * An admin cannot disable or demote themselves.
 *
 * POST /admin/users/:id/offboard → 200 OffboardUserResponse
 * For departing staff: disables the account, revokes all its sessions,
 * disables its devices and writes an audit event. Usage and retained
 * conversations are kept. 409 when already offboarded; not allowed on yourself.
 *
 * DELETE /admin/users/:id → 204
 * Removes the account. Sessions, devices, usage and retained conversations
 * cascade, so the admin console offboards instead. An admin cannot delete themselves.
 */
export const UpdateUserRequestSchema = z
  .object({
    username: UsernameSchema.optional(),
    displayName: DisplayNameSchema.optional(),
    role: RoleSchema.optional(),
    disabled: z.boolean().optional(),
    password: PasswordSchema.optional(),
    upstreamAccountIds: z.array(z.number().int()).optional(),
    groupName: GroupNameSchema.optional(),
    adminMenus: AdminMenusSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const OffboardUserResponseSchema = z.object({
  user: UserSchema,
  revokedSessions: z.number().int(),
  disabledDevices: z.number().int(),
});
export type OffboardUserResponse = z.infer<typeof OffboardUserResponseSchema>;

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
  /** When true the client syncs all its Codex conversations to the server once a day. */
  enabled: z.boolean(),
  /**
   * Deprecated: the server always sends "" because desktop builds up to
   * 4.0.19 require the field. Newer clients ignore it.
   */
  noticeText: z.string().optional(),
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
  /** Users explicitly allowed to use it. */
  allowedUserIds: z.array(z.string().uuid()).default([]),
  /** Groups allowed to use it. */
  allowedGroups: z.array(GroupNameSchema).default([]),
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
  allowedUserIds: z.array(z.string().uuid()).default([]),
  allowedGroups: z.array(z.string().trim().min(1).max(64)).default([]),
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
    allowedUserIds: z.array(z.string().uuid()).optional(),
    allowedGroups: z.array(z.string().trim().min(1).max(64)).optional(),
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
/** Optional body. Send both fields to attribute later usage to that desktop. */
export const GatewayKeyRequestSchema = z
  .object({
    deviceId: z.string().uuid().optional(),
    deviceSecret: z.string().min(1).max(200).optional(),
  })
  .refine((v) => (v.deviceId == null) === (v.deviceSecret == null), {
    message: "deviceId and deviceSecret must be sent together",
  });
export type GatewayKeyRequest = z.infer<typeof GatewayKeyRequestSchema>;

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
  /** The user's current group; empty when ungrouped. */
  groupName: z.string().default(""),
  providerId: z.string(),
  model: z.string(),
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
});
export type UsageRow = z.infer<typeof UsageRowSchema>;
export const UsageResponseSchema = z.object({ items: z.array(UsageRowSchema) });
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

export const ManualAccountCostSchema = z.object({
  billingMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .nullable()
    .optional(),
  accountId: z.number().int(),
  platform: z.string().max(100),
  planType: z.string().max(200).nullable(),
  monthlyUsd: z.number().finite().min(0).max(1_000_000).nullable(),
});
export const ManualAccountCostsRequestSchema = z.object({
  items: z.array(ManualAccountCostSchema).min(1).max(1000),
});
export type ManualAccountCost = z.infer<typeof ManualAccountCostSchema>;
export const ManualAccountCostDetailSchema = ManualAccountCostSchema.extend({
  needsBillingMonth: z.boolean().default(false),
  automaticPricing: z.boolean().default(false),
  name: z.string(),
  department: z.string(),
});

/** Canonical department names, including names used by older group settings. */
export function normalizeAccountCostDepartment(name: string): string {
  const trimmed = name.trim();
  const aliases: Record<string, string> = {
    "运营部-ezarc": "运营部-EZARC",
    "运营部-yplus": "运营部-YPLUS",
    libraton组: "运营部-LIBRATON",
    "运营部-libraton": "运营部-LIBRATON",
    技术部: "技术部&独立站&TK",
    "技术部&独立站": "技术部&独立站&TK",
    "技术部&独立站&tk": "技术部&独立站&TK",
  };
  return Object.hasOwn(aliases, trimmed.toLowerCase())
    ? aliases[trimmed.toLowerCase()]!
    : trimmed;
}

const AccountCostBreakdownSchema = z.object({
  accountId: z.number().int(),
  platform: z.string(),
  name: z.string(),
  monthlyUsd: z.number().nonnegative(),
  unpricedCount: z.number().int().nonnegative(),
});
const AccountCostGroupSchema = z.object({
  accounts: z.array(AccountCostBreakdownSchema).default([]),
  department: z.string(),
  monthlyUsd: z.number().nonnegative(),
  accountCount: z.number().int().nonnegative(),
  unpricedCount: z.number().int().nonnegative(),
});

export const OfflineAccountCostInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    department: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .transform(normalizeAccountCostDepartment),
    charges: z
      .array(
        z.object({
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
          monthlyUsd: z.number().finite().min(0).max(1_000_000),
        }),
      )
      .min(1)
      .max(600),
  })
  .refine(
    (account) =>
      new Set(account.charges.map((charge) => charge.month)).size ===
      account.charges.length,
    {
      message: "同一账号每个月只能填写一条费用记录",
      path: ["charges"],
    },
  );
export const OfflineAccountCostSchema =
  OfflineAccountCostInputSchema.safeExtend({
    id: z.number().int().safe().negative(),
  });
export type OfflineAccountCost = z.infer<typeof OfflineAccountCostSchema>;
export type OfflineAccountCostInput = z.infer<
  typeof OfflineAccountCostInputSchema
>;

/** Period totals and recorded monthly history, grouped by department. */
export const UsageAccountCostsResponseSchema = z.object({
  departmentScope: z.string().nullable().default(null),
  pendingDateCount: z.number().int().nonnegative().default(0),
  legacySnapshotCount: z.number().int().nonnegative().default(0),
  demo: z.boolean().default(false),
  recordedMonths: z.array(z.string()).default([]),
  availableMonths: z.array(z.string()).default([]),
  history: z
    .array(
      z.object({ month: z.string(), items: z.array(AccountCostGroupSchema) }),
    )
    .default([]),
  manualAccounts: z.array(ManualAccountCostDetailSchema).default([]),
  offlineAccounts: z.array(OfflineAccountCostSchema).default([]),
  configured: z.boolean(),
  items: z.array(AccountCostGroupSchema),
  unpricedCount: z.number().int().nonnegative(),
});
export type UsageAccountCostsResponse = z.infer<
  typeof UsageAccountCostsResponseSchema
>;

/** Account-wide, live Volcengine Coding Plan quotas; unrelated to gateway date/user filters. */
export const CodingPlanWindowSchema = z.object({
  id: z.enum(["fiveHour", "weekly", "monthly"]),
  usedPercent: z.number().min(0),
  resetsAt: z.string().datetime().nullable(),
});
export type CodingPlanWindow = z.infer<typeof CodingPlanWindowSchema>;
export const CodingPlanSubscriptionSchema = z.object({
  planType: z.string().nullable(),
  status: z.string().nullable(),
  startsAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  autoRenew: z.boolean().nullable(),
});
export const CodingPlanUsageResponseSchema = z.object({
  configured: z.boolean(),
  providerId: z.string(),
  fetchedAt: z.string().datetime().nullable(),
  sourceUpdatedAt: z.string().datetime().nullable(),
  stale: z.boolean(),
  error: z.string().nullable(),
  warning: z.string().nullable(),
  status: z.string().nullable(),
  subscription: CodingPlanSubscriptionSchema.nullable(),
  windows: z.array(CodingPlanWindowSchema),
});
export type CodingPlanUsageResponse = z.infer<
  typeof CodingPlanUsageResponseSchema
>;

// ---------------------------------------------------------------------------
// Phase 3 — conversation retention
// ---------------------------------------------------------------------------

/**
 * GET /admin/retention-policy (audit.read), PUT (settings.manage) → policy.
 * While enabled, every signed-in desktop syncs all of its Codex sessions
 * (history included) once a day. The server keeps uploaded conversations
 * permanently.
 */
export const AdminRetentionPolicySchema = z.object({
  enabled: z.boolean(),
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
// Phase 4 — skill / plugin / MCP / prompt marketplace
// ---------------------------------------------------------------------------

export const MarketItemKindSchema = z.enum([
  "skill",
  "plugin",
  "mcp",
  "prompt",
  "connector",
]);
export type MarketItemKind = z.infer<typeof MarketItemKindSchema>;

/** Max package size accepted by the server. */
export const MAX_MARKET_PACKAGE_BYTES = 20 * 1024 * 1024;
/** Max size of an MCP definition (JSON). */
export const MAX_MCP_DEFINITION_BYTES = 64 * 1024;

const StringMapSchema = z.record(
  z.string().min(1).max(200),
  z.string().max(4000),
);

/**
 * The package of an `mcp` item: one MCP server definition, the same shape as
 * an entry of `.mcp.json` / Codex `[mcp_servers.<id>]`. The desktop installs it
 * under the item id and enables it for Codex. `env` / `headers` reach every
 * user with `market.install` — do not put personal secrets in them.
 */
export const McpDefinitionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("stdio"),
      command: z.string().trim().min(1).max(1000),
      args: z.array(z.string().max(4000)).max(100).optional(),
      env: StringMapSchema.optional(),
      cwd: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["http", "sse"]),
      url: z
        .string()
        .trim()
        .url()
        .refine((u) => /^https?:\/\//i.test(u), "url must be http(s)"),
      headers: StringMapSchema.optional(),
    })
    .strict(),
]);
export type McpDefinition = z.infer<typeof McpDefinitionSchema>;

/** Max size of a prompt definition (JSON). */
export const MAX_PROMPT_DEFINITION_BYTES = 256 * 1024;

/**
 * The package of a `prompt` item: Codex global instructions (Markdown). The
 * desktop adds it to its Codex prompts; a mandatory prompt is also enabled,
 * which writes it to ~/.codex/AGENTS.md (the previous content is kept as a
 * backup prompt on the device).
 */
export const PromptDefinitionSchema = z
  .object({
    content: z
      .string()
      .refine((c) => c.trim().length > 0, "content must not be empty"),
  })
  .strict();
export type PromptDefinition = z.infer<typeof PromptDefinitionSchema>;

/** Max size of a connector definition (JSON). */
export const MAX_CONNECTOR_DEFINITION_BYTES = 16 * 1024;

/**
 * The package of a `connector` item. `dws` is DingTalk Workspace CLI; the
 * desktop installs the official binary and Codex skills. Employees still sign
 * in with `dws auth login` themselves.
 */
export const ConnectorDefinitionSchema = z
  .object({
    type: z.literal("dws"),
  })
  .strict();
export type ConnectorDefinition = z.infer<typeof ConnectorDefinitionSchema>;

/**
 * Package formats:
 * - skill:  zip of a single skill directory (contains SKILL.md), either at the
 *           zip root or as the only top-level folder.
 * - plugin: zip of a Codex plugin directory (contains .codex-plugin/plugin.json),
 *           either at the zip root or as the only top-level folder.
 * - mcp:    JSON, an McpDefinitionSchema object (≤ MAX_MCP_DEFINITION_BYTES).
 * - prompt: JSON, a PromptDefinitionSchema object (≤ MAX_PROMPT_DEFINITION_BYTES).
 * - connector: JSON, a ConnectorDefinitionSchema object
 *   (≤ MAX_CONNECTOR_DEFINITION_BYTES).
 * For the JSON kinds sha256 is over the stored (compact) JSON bytes.
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
  /** User id of the publisher; null if the user was deleted. */
  publishedBy: z.string().uuid().nullable(),
  /** Display name of the publisher; null if the user was deleted. */
  publishedByName: z.string().nullable(),
  /**
   * Allowlist. Both empty means every member with market.install can see the
   * item. Otherwise the caller must be in `visibleUserIds` or their group
   * must be in `visibleGroups`. Admins always see every item.
   */
  visibleUserIds: z.array(z.string().uuid()).default([]),
  visibleGroups: z.array(z.string()).default([]),
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
 *   → application/zip (skill, plugin) or application/json (mcp, prompt),
 *   header `X-Content-SHA256: <sha256>`; the client must verify it.
 *
 * PUT /market/items/:id (market.install or market.manage) — members publish a
 *   local skill. kind is always skill, mandatory is always false. Replacing an
 *   existing item is allowed when the caller published it, or is an admin;
 *   otherwise 403. A different kind at the same id is 409.
 * PUT /admin/market/items/:id (market.manage) — create or replace.
 *   skill / plugin: Content-Type application/zip, body = package bytes
 *   (≤ MAX_MARKET_PACKAGE_BYTES). mcp / prompt: Content-Type application/json,
 *   body = McpDefinitionSchema / PromptDefinitionSchema; the server stores it
 *   re-serialized (compact JSON).
 *   Metadata in query string: kind, name, description, version, mandatory=true|false
 *   (validated with MarketItemMetadataSchema). The server validates the package
 *   for the kind; a body that does not match the kind is 400. → 200 MarketItem
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
    /** Reassign (or clear) the publisher. Unknown user ids are 400. */
    publishedBy: z.string().uuid().nullable().optional(),
    /** Empty array plus empty groups means everyone. Unknown user ids are 400. */
    visibleUserIds: z.array(z.string().uuid()).optional(),
    visibleGroups: z.array(z.string().trim().min(1).max(64)).optional(),
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

// ---------------------------------------------------------------------------
// Device fleet — one Codex profile applied by every signed-in desktop
// ---------------------------------------------------------------------------

/** `direct` writes the provider into Codex. `route` / `stack` need the desktop app running. */
export const FleetModeSchema = z.enum(["direct", "route", "stack"]);
export type FleetMode = z.infer<typeof FleetModeSchema>;

const FleetModelSchema = z.object({
  id: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(128),
});

/** https, or http only when the host is the machine itself. */
export function isFleetBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const FleetBaseUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(isFleetBaseUrl, "http is only allowed for localhost");

const DirectProviderWriteSchema = z.object({
  kind: z.literal("direct"),
  id: ProviderIdSchema,
  name: z.string().trim().min(1).max(64),
  baseUrl: FleetBaseUrlSchema,
  /** Omit or "" to keep the stored key. Required when the id is new. */
  apiKey: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(1).max(512).optional(),
  ),
  model: z.string().trim().min(1).max(128),
  models: z.array(FleetModelSchema).min(1).max(50).optional(),
});

const GatewayProviderWriteSchema = z.object({
  kind: z.literal("gateway"),
  /** Id of a provider on the 模型与网关 page. The upstream key stays on the server. */
  id: ProviderIdSchema,
});

/**
 * A direct provider omits `kind` (older clients). A gateway provider is only
 * a reference: the desktop uses its existing enterprise gateway card.
 */
export const FleetProviderWriteSchema = z.preprocess(
  (value) => {
    if (value && typeof value === "object" && !("kind" in value)) {
      return { ...value, kind: "direct" };
    }
    return value;
  },
  z.discriminatedUnion("kind", [
    DirectProviderWriteSchema,
    GatewayProviderWriteSchema,
  ]),
);
export type FleetProviderWrite = z.infer<typeof FleetProviderWriteSchema>;

/**
 * PUT /admin/fleet. Replaces the profile and bumps `revision`. An empty
 * `providers` list removes the managed cards; it does not by itself pick a
 * local provider.
 */
export const PutFleetRequestSchema = z
  .object({
    mode: FleetModeSchema,
    activeProviderId: z.string().max(32).default(""),
    stackMemberIds: z.array(ProviderIdSchema).max(50).default([]),
    providers: z.array(FleetProviderWriteSchema).max(30),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.providers.forEach((p, i) => {
      if (seen.has(p.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", i, "id"],
          message: "duplicate provider id",
        });
      }
      seen.add(p.id);
      if (p.kind === "direct") {
        const models = p.models ?? [{ id: p.model, displayName: p.model }];
        if (!models.some((m) => m.id === p.model)) {
          ctx.addIssue({
            code: "custom",
            path: ["providers", i, "model"],
            message: "model must be one of models",
          });
        }
      }
    });
    if (v.providers.length === 0) {
      if (v.activeProviderId !== "") {
        ctx.addIssue({
          code: "custom",
          path: ["activeProviderId"],
          message: "must be empty when there are no providers",
        });
      }
      if (v.stackMemberIds.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["stackMemberIds"],
          message: "must be empty when there are no providers",
        });
      }
      return;
    }
    if (!seen.has(v.activeProviderId)) {
      ctx.addIssue({
        code: "custom",
        path: ["activeProviderId"],
        message: "must be one of providers",
      });
    }
    if (v.mode !== "stack" && v.stackMemberIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["stackMemberIds"],
        message: "only used in stack mode",
      });
    }
    v.stackMemberIds.forEach((id, i) => {
      if (!seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["stackMemberIds", i],
          message: "unknown provider",
        });
      }
    });
  });
export type PutFleetRequest = z.infer<typeof PutFleetRequestSchema>;

export const AdminFleetProviderSchema = z.object({
  kind: z.enum(["direct", "gateway"]),
  id: ProviderIdSchema,
  name: z.string(),
  baseUrl: z.string(),
  /** Masked. Empty for a gateway reference. The key itself is never returned. */
  apiKeyHint: z.string(),
  model: z.string(),
  models: z.array(FleetModelSchema),
});
export type AdminFleetProvider = z.infer<typeof AdminFleetProviderSchema>;

/** GET /admin/fleet */
export const AdminFleetSchema = z.object({
  revision: z.number().int().nonnegative(),
  mode: FleetModeSchema,
  activeProviderId: z.string(),
  stackMemberIds: z.array(z.string()),
  providers: z.array(AdminFleetProviderSchema),
  updatedAt: z.string().nullable(),
});
export type AdminFleet = z.infer<typeof AdminFleetSchema>;

/** What the desktop last observed. No secrets. */
export const DeviceReportedSchema = z.object({
  mode: FleetModeSchema,
  activeProviderId: z.string().max(80).nullable(),
  activeProviderName: z.string().max(100).nullable(),
  providers: z
    .array(
      z.object({
        id: z.string().max(80),
        name: z.string().max(100),
        managed: z.boolean(),
      }),
    )
    .max(200),
  /** Fleet provider ids (without the `fleet-` prefix) currently in the stack list. */
  stackMemberIds: z.array(z.string().max(80)).max(50),
});
export type DeviceReported = z.infer<typeof DeviceReportedSchema>;

/** POST /devices/heartbeat — any signed-in desktop. */
export const DeviceHeartbeatRequestSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  hostname: z.string().trim().max(100).default(""),
  reported: DeviceReportedSchema,
  /**
   * Required after the first heartbeat. The first response returns
   * `deviceSecret` once; later heartbeats must send it back.
   */
  deviceSecret: z.string().min(1).max(200).optional(),
});
export type DeviceHeartbeatRequest = z.infer<
  typeof DeviceHeartbeatRequestSchema
>;

/**
 * Summary only: no API keys. The desktop compares this with what it just
 * applied and, on a miss, calls GET /devices/me/desired.
 */
export const DeviceHeartbeatResponseSchema = z.object({
  desiredRevision: z.number().int().nonnegative(),
  profileId: z.string().uuid(),
  mode: FleetModeSchema,
  activeProviderId: z.string(),
  stackMemberIds: z.array(z.string()),
  /** Ask the desktop to pull and apply even when the revision matches. */
  forceSync: z.boolean(),
  /** Present only on the heartbeat that enrolls the device. */
  deviceSecret: z.string().optional(),
});
export type DeviceHeartbeatResponse = z.infer<
  typeof DeviceHeartbeatResponseSchema
>;

const DesiredFleetProviderSchema = z.object({
  kind: z.enum(["direct", "gateway"]),
  id: z.string(),
  name: z.string(),
  /** Upstream URL for `direct`. Empty for `gateway` (the desktop already has the gateway card). */
  baseUrl: z.string(),
  /** Plain key for `direct`. Empty for `gateway`. */
  apiKey: z.string(),
  model: z.string(),
  models: z.array(FleetModelSchema),
});

/** GET /devices/me/desired?deviceId= — requires models.use, header `x-device-secret`. */
export const DesiredFleetSchema = z.object({
  revision: z.number().int().nonnegative(),
  profileId: z.string().uuid(),
  mode: FleetModeSchema,
  activeProviderId: z.string(),
  stackMemberIds: z.array(z.string()),
  providers: z.array(DesiredFleetProviderSchema),
});
export type DesiredFleet = z.infer<typeof DesiredFleetSchema>;

/** POST /devices/me/applied → 204. `error` set means the revision was not applied. */
export const DeviceAppliedRequestSchema = z.object({
  deviceId: z.string().uuid(),
  deviceSecret: z.string().min(1).max(200),
  profileId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  error: z.string().max(500).nullable().optional(),
});
export type DeviceAppliedRequest = z.infer<typeof DeviceAppliedRequestSchema>;

export const AdminDeviceSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  name: z.string(),
  hostname: z.string(),
  note: z.string(),
  lastSeenAt: z.string(),
  /** Heartbeat within the last 2 minutes. */
  online: z.boolean(),
  disabled: z.boolean(),
  reported: DeviceReportedSchema,
  profileId: z.string().uuid().nullable(),
  profileName: z.string(),
  appliedRevision: z.number().int(),
  applyError: z.string().nullable(),
  desiredRevision: z.number().int(),
  /** `synced` when the applied profile and revision match. */
  sync: z.enum(["synced", "pending", "failed"]),
  userChangedAt: z.string().nullable(),
  tokensToday: z.number().int(),
  tokens7d: z.number().int(),
  cost7d: z.number(),
});
export type AdminDevice = z.infer<typeof AdminDeviceSchema>;

/** GET /admin/devices */
export const ListDevicesResponseSchema = z.object({
  items: z.array(AdminDeviceSchema),
  serverTime: z.string(),
});
export type ListDevicesResponse = z.infer<typeof ListDevicesResponseSchema>;

export const ProfileSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  revision: z.number().int().nonnegative(),
  mode: FleetModeSchema,
  providerCount: z.number().int(),
  deviceCount: z.number().int(),
  updatedAt: z.string(),
});
export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;

export const ListProfilesResponseSchema = z.object({
  items: z.array(ProfileSummarySchema),
});

/** GET/PUT /admin/profiles/:id. Providers never include raw keys. */
export const AdminProfileSchema = AdminFleetSchema.extend({
  id: z.string().uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  deviceCount: z.number().int(),
});
export type AdminProfile = z.infer<typeof AdminProfileSchema>;

export const CreateProfileRequestSchema = PutFleetRequestSchema.and(
  z.object({
    name: z.string().trim().min(1).max(64),
    isDefault: z.boolean().optional(),
  }),
);
export type CreateProfileRequest = z.infer<typeof CreateProfileRequestSchema>;

export const PatchDeviceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    note: z.string().max(500).optional(),
    /** Null clears the assignment and the device follows the default profile. */
    profileId: z.string().uuid().nullable().optional(),
    disabled: z.boolean().optional(),
    /** Ask the desktop to apply on its next heartbeat. */
    forceSync: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });
export type PatchDeviceRequest = z.infer<typeof PatchDeviceRequestSchema>;

export const DeviceUsageDaySchema = z.object({
  date: z.string(),
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});

export const DeviceUsageBreakdownSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});

/** GET /admin/devices/:id */
export const DeviceDetailResponseSchema = z.object({
  device: AdminDeviceSchema,
  days: z.array(DeviceUsageDaySchema),
  byProvider: z.array(DeviceUsageBreakdownSchema),
  /** Gateway-metered totals for this device over the same 7 days. */
  gateway: z.object({
    requests: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  }),
});
export type DeviceDetailResponse = z.infer<typeof DeviceDetailResponseSchema>;

export const DeviceUsageUploadItemSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerId: z.string().min(1).max(80),
  model: z.string().min(1).max(128),
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

/** POST /devices/me/usage → 204. Replaces the stored rows for the dates included. */
export const DeviceUsageUploadRequestSchema = z.object({
  deviceId: z.string().uuid(),
  deviceSecret: z.string().min(1).max(200),
  items: z.array(DeviceUsageUploadItemSchema).max(2000),
});
export type DeviceUsageUploadRequest = z.infer<
  typeof DeviceUsageUploadRequestSchema
>;

/** One row per device, user and provider; the admin console sums them per device. */
export const DeviceUsageRowSchema = z.object({
  deviceId: z.string().uuid(),
  deviceName: z.string(),
  userId: z.string().uuid(),
  username: z.string(),
  /** The user's current group; empty when ungrouped. */
  groupName: z.string().default(""),
  /** Provider id as reported by the desktop. */
  providerId: z.string().default(""),
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});
export const DeviceUsageResponseSchema = z.object({
  items: z.array(DeviceUsageRowSchema),
});
export type DeviceUsageResponse = z.infer<typeof DeviceUsageResponseSchema>;

// ---------------------------------------------------------------------------
// Upstream accounts and desktop usage-window assignments
// ---------------------------------------------------------------------------

/** Reserved assignment id; Sub2API account ids are positive. No credentials are stored here. */
export const CODING_PLAN_ACCOUNT_ID = -1;
/** Shared display name for the synthetic Volcano Engine Coding Plan account. */
export const CODING_PLAN_ACCOUNT_NAME = "Libraton-火山方舟Codin Plan";

export const UpstreamWindowSchema = z.object({
  id: z.enum(["5h", "7d"]),
  usedPercent: z.number(),
  remainingSeconds: z.number().int(),
  resetsAt: z.string().nullable(),
  requests: z.number().int(),
  tokens: z.number().int(),
  accountCost: z.number(),
  userCost: z.number(),
});
export type UpstreamWindow = z.infer<typeof UpstreamWindowSchema>;

export const UpstreamAccountSchema = z.object({
  subscriptionExpiresAt: z.string().nullable().default(null),
  /** Subscription SKU only; no credentials are exposed. */
  planType: z.string().nullable().default(null),
  id: z.number().int(),
  name: z.string(),
  email: z.string().nullable(),
  platform: z.string(),
  type: z.string(),
  status: z.string(),
  schedulable: z.boolean(),
  groups: z.array(z.string()),
  /** In-flight requests on this Sub2API account (Redis). */
  currentConcurrency: z.number().int().nonnegative().default(0),
  /** Account concurrency cap (`concurrency` on the Sub2API account). */
  maxConcurrency: z.number().int().nonnegative().default(0),
  windows: z.array(UpstreamWindowSchema),
});
export type UpstreamAccount = z.infer<typeof UpstreamAccountSchema>;

/** GET /admin/upstream/accounts (audit.read) and /client/upstream/accounts. */
export const UpstreamAccountsResponseSchema = z.object({
  demo: z.boolean().default(false),
  configured: z.boolean(),
  error: z.string().nullable(),
  items: z.array(UpstreamAccountSchema),
  /** Coding Plan is configured and visible to this user, independent of Sub2API connectivity. */
  codingPlanAvailable: z.boolean().optional(),
  /** Only returned to an admin or a user assigned CODING_PLAN_ACCOUNT_ID. */
  codingPlan: CodingPlanUsageResponseSchema.optional(),
});
export type UpstreamAccountsResponse = z.infer<
  typeof UpstreamAccountsResponseSchema
>;
