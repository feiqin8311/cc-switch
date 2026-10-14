import { permissionsForRole } from "@ccse/contracts";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  devices,
  gatewayKeys,
  providers,
  sessions,
  type UserRow,
  users,
} from "../db/schema.ts";
import { forbidden, notFound, unauthorized } from "../errors.ts";
import { GATEWAY_KEY_PREFIX, hashGatewayKey } from "./keys.ts";

export type ProviderRow = typeof providers.$inferSelect;

export interface GatewayContext {
  user: UserRow;
  sessionId: string;
  provider: ProviderRow;
  deviceId: string | null;
}

/** last_used_at is written at most this often per key. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Resolves `Authorization: Bearer gk_…` to a live session/user and checks
 * that the user may use the provider. Throws 401/403/404 AppErrors.
 */
export async function authenticateGatewayRequest(
  db: Db,
  authorization: string | undefined,
  providerId: string,
): Promise<GatewayContext> {
  if (!authorization?.startsWith("Bearer ")) throw unauthorized();
  const key = authorization.slice(7).trim();
  if (!key.startsWith(GATEWAY_KEY_PREFIX) || key.length > 128) {
    throw unauthorized("Invalid gateway key");
  }
  const keyHash = hashGatewayKey(key);
  const now = new Date();

  const [row] = await db
    .select({
      user: users,
      sessionId: gatewayKeys.sessionId,
      lastUsedAt: gatewayKeys.lastUsedAt,
      deviceId: gatewayKeys.deviceId,
    })
    .from(gatewayKeys)
    .innerJoin(
      sessions,
      and(
        eq(sessions.id, gatewayKeys.sessionId),
        eq(sessions.userId, gatewayKeys.userId),
      ),
    )
    .innerJoin(users, eq(users.id, gatewayKeys.userId))
    .where(
      and(
        eq(gatewayKeys.keyHash, keyHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row || row.user.disabled) throw unauthorized("Invalid gateway key");
  if (row.deviceId) {
    const [device] = await db
      .select({ disabled: devices.disabled })
      .from(devices)
      .where(eq(devices.id, row.deviceId))
      .limit(1);
    if (device?.disabled) throw unauthorized("Device is disabled");
  }

  if (
    !row.lastUsedAt ||
    now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS
  ) {
    await db
      .update(gatewayKeys)
      .set({ lastUsedAt: now })
      .where(eq(gatewayKeys.keyHash, keyHash));
  }

  if (!permissionsForRole(row.user.role).includes("models.use")) {
    throw forbidden();
  }

  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  if (!provider) throw notFound("Provider not found");
  if (!provider.enabled || !provider.allowedRoles.includes(row.user.role)) {
    throw forbidden("Provider is not available to you");
  }

  return {
    user: row.user,
    sessionId: row.sessionId,
    provider,
    deviceId: row.deviceId,
  };
}
