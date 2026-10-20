import { type Permission, permissionsForRole } from "@ccse/contracts";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.ts";
import { sessions, type UserRow, users } from "../db/schema.ts";
import { forbidden, unauthorized } from "../errors.ts";
import { verifyAccessToken } from "./tokens.ts";

export interface AuthContext {
  user: UserRow;
  sessionId: string;
  permissions: Permission[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/**
 * Builds the `authenticate` preHandler. The user and session are re-read on
 * every request so disabling a user or revoking a session takes effect
 * immediately, not when the access token expires.
 */
export function createAuthenticate(db: Db, secret: Uint8Array) {
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    const claims = await verifyAccessToken(secret, header.slice(7).trim());
    if (!claims) throw unauthorized("Invalid or expired access token");

    const [row] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, claims.sessionId),
          eq(sessions.userId, claims.userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row || row.user.disabled)
      throw unauthorized("Session is no longer valid");

    req.auth = {
      user: row.user,
      sessionId: claims.sessionId,
      permissions: permissionsForRole(row.user.role),
    };
  };
}

export function requirePermission(permission: Permission) {
  return requireAnyPermission(permission);
}

export function requireAnyPermission(...permissions: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.auth) throw unauthorized();
    if (
      !permissions.some((permission) =>
        req.auth?.permissions.includes(permission),
      )
    )
      throw forbidden();
  };
}

/** Narrows `req.auth` inside handlers that run after `authenticate`. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
