import { createHash, randomBytes } from "node:crypto";
import type {
  AdminFleet,
  AdminFleetProvider,
  AdminProfile,
  CreateProfileRequest,
  DesiredFleet,
  DeviceHeartbeatResponse,
  ProfileSummary,
  PutFleetRequest,
} from "@ccse/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { devices, fleetProfiles, providers, settings } from "../db/schema.ts";
import { AppError } from "../errors.ts";
import { decryptSecret, encryptSecret, secretHint } from "../secrets.ts";

export const FLEET_SETTINGS_KEY = "fleet";

type DirectStored = {
  kind: "direct";
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnc: string;
  apiKeyHint: string;
  model: string;
  models: { id: string; displayName: string }[];
};

type GatewayStored = { kind: "gateway"; id: string };
type StoredProvider = DirectStored | GatewayStored;

interface LegacyFleet {
  revision: number;
  mode: "direct" | "route" | "stack";
  activeProviderId: string;
  stackMemberIds: string[];
  providers: Array<DirectStored & { kind?: "direct" }>;
}

type ProfileRow = typeof fleetProfiles.$inferSelect;

export function generateDeviceSecret(): string {
  return `ds_${randomBytes(32).toString("base64url")}`;
}

export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown) =>
    typeof e === "object" && e !== null && "code" in e
      ? (e as { code: unknown }).code
      : undefined;
  return (
    codeOf(err) === "23505" ||
    codeOf((err as { cause?: unknown } | null)?.cause) === "23505"
  );
}

function modelsOf(
  provider: Extract<PutFleetRequest["providers"][number], { kind: "direct" }>,
) {
  return provider.models ?? [{ id: provider.model, displayName: provider.model }];
}

async function readLegacy(db: Db): Promise<LegacyFleet | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, FLEET_SETTINGS_KEY))
    .limit(1);
  if (!row || typeof row.value !== "object" || row.value === null) return null;
  const value = row.value as Partial<LegacyFleet>;
  if (!Array.isArray(value.providers)) return null;
  return {
    revision: typeof value.revision === "number" ? value.revision : 0,
    mode: value.mode === "route" || value.mode === "stack" ? value.mode : "direct",
    activeProviderId: value.activeProviderId ?? "",
    stackMemberIds: value.stackMemberIds ?? [],
    providers: value.providers.map((p) => ({ ...p, kind: "direct" as const })),
  };
}

/** The one default profile. The legacy settings document becomes it on first use. */
export async function ensureDefault(db: Db): Promise<ProfileRow> {
  const [current] = await db
    .select()
    .from(fleetProfiles)
    .where(eq(fleetProfiles.isDefault, true))
    .limit(1);
  if (current) return current;
  const legacy = await readLegacy(db);
  try {
    const [created] = await db
      .insert(fleetProfiles)
      .values({
        name: "默认方案",
        isDefault: true,
        revision: legacy?.revision ?? 0,
        mode: legacy?.mode ?? "direct",
        activeProviderId: legacy?.activeProviderId ?? "",
        stackMemberIds: legacy?.stackMemberIds ?? [],
        providers: legacy?.providers ?? [],
      })
      .returning();
    if (!created) throw new Error("insert returned no row");
    return created;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const [winner] = await db
      .select()
      .from(fleetProfiles)
      .where(eq(fleetProfiles.isDefault, true))
      .limit(1);
    if (!winner) throw err;
    return winner;
  }
}

async function decorate(
  db: Db,
  stored: StoredProvider[],
): Promise<AdminFleetProvider[]> {
  const gatewayIds = stored.filter((p) => p.kind === "gateway").map((p) => p.id);
  const listed = gatewayIds.length
    ? await db.select().from(providers).where(inArray(providers.id, gatewayIds))
    : [];
  const byId = new Map(listed.map((row) => [row.id, row]));
  return stored.map((provider) => {
    if (provider.kind === "gateway") {
      const row = byId.get(provider.id);
      return {
        kind: "gateway" as const,
        id: provider.id,
        name: row?.name ?? provider.id,
        baseUrl: row?.baseUrl ?? "",
        apiKeyHint: "",
        model: row?.defaultModel ?? "",
        models: row?.models ?? [],
      };
    }
    return {
      kind: "direct" as const,
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKeyHint: provider.apiKeyHint,
      model: provider.model,
      models: provider.models,
    };
  });
}

function asStored(value: unknown): StoredProvider[] {
  return Array.isArray(value) ? (value as StoredProvider[]) : [];
}

async function toAdminBody(
  db: Db,
  row: ProfileRow,
): Promise<AdminFleet & { id: string; name: string; isDefault: boolean }> {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    revision: row.revision,
    mode: row.mode,
    activeProviderId: row.activeProviderId,
    stackMemberIds: row.stackMemberIds,
    providers: await decorate(db, asStored(row.providers)),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function deviceCountFor(db: Db, row: ProfileRow): Promise<number> {
  const [assigned] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(devices)
    .where(eq(devices.profileId, row.id));
  if (!row.isDefault) return assigned?.n ?? 0;
  const [fallback] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(devices)
    .where(sql`${devices.profileId} is null`);
  return (assigned?.n ?? 0) + (fallback?.n ?? 0);
}

export async function listProfiles(db: Db): Promise<ProfileSummary[]> {
  await ensureDefault(db);
  const rows = await db.select().from(fleetProfiles).orderBy(fleetProfiles.name);
  const summaries: ProfileSummary[] = [];
  for (const row of rows) {
    summaries.push({
      id: row.id,
      name: row.name,
      isDefault: row.isDefault,
      revision: row.revision,
      mode: row.mode,
      providerCount: asStored(row.providers).length,
      deviceCount: await deviceCountFor(db, row),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return summaries;
}

export async function getProfile(db: Db, id: string): Promise<AdminProfile> {
  const [row] = await db
    .select()
    .from(fleetProfiles)
    .where(eq(fleetProfiles.id, id))
    .limit(1);
  if (!row) throw new AppError(404, "not_found", "Profile not found");
  const body = await toAdminBody(db, row);
  return { ...body, deviceCount: await deviceCountFor(db, row) };
}

async function storeProviders(
  db: Db,
  body: PutFleetRequest,
  previous: StoredProvider[],
  secretsKey: Buffer,
): Promise<StoredProvider[]> {
  const prev = new Map(
    previous.filter((p) => p.kind === "direct").map((p) => [p.id, p]),
  );
  const next: StoredProvider[] = [];
  for (const [index, provider] of body.providers.entries()) {
    if (provider.kind === "gateway") {
      const [row] = await db
        .select({ id: providers.id })
        .from(providers)
        .where(eq(providers.id, provider.id))
        .limit(1);
      if (!row) {
        throw new AppError(400, "bad_request", "Invalid request body", [
          {
            path: `providers.${index}.id`,
            message: "unknown gateway provider",
          },
        ]);
      }
      next.push({ kind: "gateway", id: provider.id });
      continue;
    }
    const old = prev.get(provider.id);
    let apiKeyEnc: string;
    let apiKeyHint: string;
    if (provider.apiKey) {
      apiKeyEnc = encryptSecret(secretsKey, provider.apiKey);
      apiKeyHint = secretHint(provider.apiKey);
    } else if (old) {
      apiKeyEnc = old.apiKeyEnc;
      apiKeyHint = old.apiKeyHint;
    } else {
      throw new AppError(400, "bad_request", "Invalid request body", [
        {
          path: `providers.${index}.apiKey`,
          message: "apiKey is required for a new provider",
        },
      ]);
    }
    next.push({
      kind: "direct",
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKeyEnc,
      apiKeyHint,
      model: provider.model,
      models: modelsOf(provider),
    });
  }
  return next;
}

async function clearOtherDefaults(db: Db, keepId: string): Promise<void> {
  await db
    .update(fleetProfiles)
    .set({ isDefault: false })
    .where(and(eq(fleetProfiles.isDefault, true), sql`${fleetProfiles.id} <> ${keepId}`));
}

export async function createProfile(
  db: Db,
  body: CreateProfileRequest,
  secretsKey: Buffer,
): Promise<AdminProfile> {
  await ensureDefault(db);
  const stored = await storeProviders(db, body, [], secretsKey);
  const [row] = await db
    .insert(fleetProfiles)
    .values({
      name: body.name,
      isDefault: false,
      revision: 1,
      mode: body.mode,
      activeProviderId: body.activeProviderId,
      stackMemberIds: body.stackMemberIds,
      providers: stored,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  if (body.isDefault) {
    await clearOtherDefaults(db, row.id);
    await db
      .update(fleetProfiles)
      .set({ isDefault: true })
      .where(eq(fleetProfiles.id, row.id));
    row.isDefault = true;
  }
  const admin = await toAdminBody(db, row);
  return { ...admin, deviceCount: 0 };
}

export async function updateProfile(
  db: Db,
  id: string,
  body: CreateProfileRequest,
  secretsKey: Buffer,
): Promise<AdminProfile> {
  const [existing] = await db
    .select()
    .from(fleetProfiles)
    .where(eq(fleetProfiles.id, id))
    .limit(1);
  if (!existing) throw new AppError(404, "not_found", "Profile not found");
  if (existing.isDefault && body.isDefault === false) {
    throw new AppError(400, "bad_request", "Choose another default profile first");
  }
  const stored = await storeProviders(
    db,
    body,
    asStored(existing.providers),
    secretsKey,
  );
  const now = new Date();
  if (body.isDefault) await clearOtherDefaults(db, id);
  const [row] = await db
    .update(fleetProfiles)
    .set({
      name: body.name,
      isDefault: body.isDefault ?? existing.isDefault,
      revision: existing.revision + 1,
      mode: body.mode,
      activeProviderId: body.activeProviderId,
      stackMemberIds: body.stackMemberIds,
      providers: stored,
      updatedAt: now,
    })
    .where(eq(fleetProfiles.id, id))
    .returning();
  if (!row) throw new AppError(404, "not_found", "Profile not found");
  const admin = await toAdminBody(db, row);
  return { ...admin, deviceCount: await deviceCountFor(db, row) };
}

/** Keeps the default profile's name. Used by the original single-profile endpoint. */
export async function saveDefaultFleet(
  db: Db,
  body: PutFleetRequest,
  secretsKey: Buffer,
): Promise<AdminFleet> {
  const current = await ensureDefault(db);
  const saved = await updateProfile(
    db,
    current.id,
    { ...body, name: current.name, isDefault: true },
    secretsKey,
  );
  const { id: _id, name: _name, isDefault: _flag, deviceCount: _count, ...fleet } =
    saved;
  return fleet;
}

export async function deleteProfile(db: Db, id: string): Promise<void> {
  const [row] = await db
    .select()
    .from(fleetProfiles)
    .where(eq(fleetProfiles.id, id))
    .limit(1);
  if (!row) throw new AppError(404, "not_found", "Profile not found");
  if (row.isDefault) {
    throw new AppError(400, "bad_request", "The default profile cannot be deleted");
  }
  await db
    .update(devices)
    .set({ profileId: null })
    .where(eq(devices.profileId, id));
  await db.delete(fleetProfiles).where(eq(fleetProfiles.id, id));
}

export async function copyProfileForDevice(
  db: Db,
  deviceName: string,
  source: ProfileRow,
): Promise<ProfileRow> {
  const [row] = await db
    .insert(fleetProfiles)
    .values({
      name: `${deviceName} 的方案`.slice(0, 64),
      isDefault: false,
      revision: 1,
      mode: source.mode,
      activeProviderId: source.activeProviderId,
      stackMemberIds: source.stackMemberIds,
      providers: source.providers,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function profileById(db: Db, id: string): Promise<ProfileRow | null> {
  const [row] = await db
    .select()
    .from(fleetProfiles)
    .where(eq(fleetProfiles.id, id))
    .limit(1);
  return row ?? null;
}

export async function effectiveProfile(
  db: Db,
  profileId: string | null,
): Promise<ProfileRow> {
  if (profileId) {
    const row = await profileById(db, profileId);
    if (row) return row;
  }
  return ensureDefault(db);
}

export async function desiredFor(
  db: Db,
  row: ProfileRow,
  secretsKey: Buffer,
): Promise<DesiredFleet> {
  const providersOut: DesiredFleet["providers"] = [];
  for (const provider of asStored(row.providers)) {
    if (provider.kind === "gateway") {
      const [gateway] = await db
        .select()
        .from(providers)
        .where(eq(providers.id, provider.id))
        .limit(1);
      providersOut.push({
        kind: "gateway",
        id: provider.id,
        name: gateway?.name ?? provider.id,
        baseUrl: "",
        apiKey: "",
        model: gateway?.defaultModel ?? "",
        models: gateway?.models ?? [],
      });
      continue;
    }
    providersOut.push({
      kind: "direct",
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: decryptSecret(secretsKey, provider.apiKeyEnc),
      model: provider.model,
      models: provider.models,
    });
  }
  return {
    revision: row.revision,
    profileId: row.id,
    mode: row.mode,
    activeProviderId: row.activeProviderId,
    stackMemberIds: row.stackMemberIds,
    providers: providersOut,
  };
}

export function summaryOf(
  row: ProfileRow,
): Omit<DeviceHeartbeatResponse, "deviceSecret"> {
  return {
    desiredRevision: row.revision,
    profileId: row.id,
    mode: row.mode,
    activeProviderId: row.activeProviderId,
    stackMemberIds: row.stackMemberIds,
    forceSync: false,
  };
}
