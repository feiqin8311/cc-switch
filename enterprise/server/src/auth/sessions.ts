import { permissionsForUser, type SessionResponse } from "@ccse/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { refreshTokens, sessions, type UserRow, users } from "../db/schema.ts";
import { unauthorized } from "../errors.ts";
import { toUserDto } from "../users/dto.ts";
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
} from "./tokens.ts";

async function buildResponse(
  db: Db,
  secret: Uint8Array,
  user: UserRow,
  sessionId: string,
  now: Date,
): Promise<SessionResponse> {
  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date(
    now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000,
  );
  await db
    .insert(refreshTokens)
    .values({ tokenHash: hashRefreshToken(refreshToken), sessionId });
  await db
    .update(sessions)
    .set({ expiresAt: refreshExpiresAt, lastUsedAt: now })
    .where(eq(sessions.id, sessionId));

  const access = await signAccessToken(
    secret,
    { userId: user.id, sessionId },
    now,
  );
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    user: toUserDto(user),
    permissions: permissionsForUser(user),
  };
}

export async function createSession(
  db: Db,
  secret: Uint8Array,
  user: UserRow,
  deviceName: string | undefined,
): Promise<SessionResponse> {
  const now = new Date();
  const [session] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      deviceName: deviceName ?? null,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("failed to create session");
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
  return buildResponse(
    db,
    secret,
    { ...user, lastLoginAt: now },
    session.id,
    now,
  );
}

export type RefreshOutcome =
  | { kind: "ok"; session: SessionResponse }
  | { kind: "reused"; sessionId: string };

/**
 * Consumes a refresh token and issues a new pair. A token that was already
 * used signals theft: the whole session is revoked.
 */
export async function rotateSession(
  db: Db,
  secret: Uint8Array,
  refreshToken: string,
): Promise<RefreshOutcome> {
  const now = new Date();
  const tokenHash = hashRefreshToken(refreshToken);

  // Atomic claim: only one concurrent caller can mark the token used.
  const [claimed] = await db
    .update(refreshTokens)
    .set({ usedAt: now })
    .where(
      and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.usedAt)),
    )
    .returning({ sessionId: refreshTokens.sessionId });

  if (!claimed) {
    const [existing] = await db
      .select({ sessionId: refreshTokens.sessionId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (existing) {
      await revokeSession(db, existing.sessionId);
      return { kind: "reused", sessionId: existing.sessionId };
    }
    throw unauthorized("Invalid refresh token");
  }

  const [row] = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, claimed.sessionId))
    .limit(1);
  if (
    !row ||
    row.session.revokedAt ||
    row.session.expiresAt <= now ||
    row.user.disabled
  ) {
    throw unauthorized("Session is no longer valid");
  }

  return {
    kind: "ok",
    session: await buildResponse(db, secret, row.user, claimed.sessionId, now),
  };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeSessionByRefreshToken(
  db: Db,
  refreshToken: string,
): Promise<void> {
  const [row] = await db
    .select({ sessionId: refreshTokens.sessionId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)))
    .limit(1);
  if (row) await revokeSession(db, row.sessionId);
}

export async function revokeAllUserSessions(
  db: Db,
  userId: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
