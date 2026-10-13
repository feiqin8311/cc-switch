import type {
  AdminFleet,
  DesiredFleet,
  DeviceHeartbeatResponse,
  PutFleetRequest,
} from "@ccse/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";
import { AppError } from "../errors.ts";
import { decryptSecret, encryptSecret, secretHint } from "../secrets.ts";

export const FLEET_SETTINGS_KEY = "fleet";

interface StoredProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnc: string;
  apiKeyHint: string;
  model: string;
  models: { id: string; displayName: string }[];
}

interface StoredFleet {
  revision: number;
  mode: "direct" | "route" | "stack";
  activeProviderId: string;
  stackMemberIds: string[];
  providers: StoredProvider[];
}

const EMPTY: StoredFleet = {
  revision: 0,
  mode: "direct",
  activeProviderId: "",
  stackMemberIds: [],
  providers: [],
};

function modelsOf(
  provider: PutFleetRequest["providers"][number],
): { id: string; displayName: string }[] {
  return provider.models ?? [{ id: provider.model, displayName: provider.model }];
}

function toAdmin(stored: StoredFleet, updatedAt: string | null): AdminFleet {
  return {
    revision: stored.revision,
    mode: stored.mode,
    activeProviderId: stored.activeProviderId,
    stackMemberIds: stored.stackMemberIds,
    providers: stored.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKeyHint: p.apiKeyHint,
      model: p.model,
      models: p.models,
    })),
    updatedAt,
  };
}

async function readRow(
  db: Db,
): Promise<{ stored: StoredFleet; updatedAt: string | null }> {
  const [row] = await db
    .select({ value: settings.value, updatedAt: settings.updatedAt })
    .from(settings)
    .where(eq(settings.key, FLEET_SETTINGS_KEY))
    .limit(1);
  if (!row) return { stored: EMPTY, updatedAt: null };
  const value = row.value;
  if (
    typeof value !== "object" ||
    value === null ||
    !("revision" in value) ||
    !Array.isArray((value as { providers?: unknown }).providers)
  ) {
    throw new AppError(500, "internal", "Stored fleet config is unreadable");
  }
  return {
    stored: value as StoredFleet,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getAdminFleet(db: Db): Promise<AdminFleet> {
  const { stored, updatedAt } = await readRow(db);
  return toAdmin(stored, updatedAt);
}

/** Fields the desktop can compare without receiving API keys. */
export async function fleetSummary(db: Db): Promise<DeviceHeartbeatResponse> {
  const { stored } = await readRow(db);
  return {
    desiredRevision: stored.revision,
    mode: stored.mode,
    activeProviderId: stored.activeProviderId,
    stackMemberIds: stored.stackMemberIds,
  };
}

/** Decrypts keys. Caller must already have checked `models.use`. */
export async function getDesiredFleet(
  db: Db,
  secretsKey: Buffer,
): Promise<DesiredFleet> {
  const { stored } = await readRow(db);
  return {
    revision: stored.revision,
    mode: stored.mode,
    activeProviderId: stored.activeProviderId,
    stackMemberIds: stored.stackMemberIds,
    providers: stored.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: decryptSecret(secretsKey, p.apiKeyEnc),
      model: p.model,
      models: p.models,
    })),
  };
}

export async function saveFleet(
  db: Db,
  body: PutFleetRequest,
  secretsKey: Buffer,
): Promise<AdminFleet> {
  return db.transaction(async (tx) => {
    const { stored } = await readRow(tx as unknown as Db);
    const previous = new Map(stored.providers.map((p) => [p.id, p]));
    const providers: StoredProvider[] = [];
    for (const [index, provider] of body.providers.entries()) {
      const old = previous.get(provider.id);
      let apiKeyEnc: string;
      let apiKeyHint: string;
      if (provider.apiKey) {
        apiKeyEnc = encryptSecret(secretsKey, provider.apiKey);
        apiKeyHint = secretHint(provider.apiKey);
      } else if (old) {
        apiKeyEnc = old.apiKeyEnc;
        apiKeyHint = old.apiKeyHint;
      } else {
        throw new AppError(
          400,
          "bad_request",
          "Invalid request body",
          [
            {
              path: `providers.${index}.apiKey`,
              message: "apiKey is required for a new provider",
            },
          ],
        );
      }
      providers.push({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKeyEnc,
        apiKeyHint,
        model: provider.model,
        models: modelsOf(provider),
      });
    }
    const next: StoredFleet = {
      revision: stored.revision + 1,
      mode: body.mode,
      activeProviderId: body.activeProviderId,
      stackMemberIds: body.stackMemberIds,
      providers,
    };
    const now = new Date();
    await tx
      .insert(settings)
      .values({ key: FLEET_SETTINGS_KEY, value: next, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedAt: now },
      });
    return toAdmin(next, now.toISOString());
  });
}
