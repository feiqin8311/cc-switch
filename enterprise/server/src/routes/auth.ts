import {
  LoginRequestSchema,
  LogoutRequestSchema,
  type MeResponse,
  RefreshRequestSchema,
} from "@ccse/contracts";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf } from "../auth/guard.ts";
import { verifyAgainstDummy, verifyPassword } from "../auth/password.ts";
import { FailureLimiter } from "../auth/rate-limit.ts";
import {
  createSession,
  revokeSessionByRefreshToken,
  rotateSession,
} from "../auth/sessions.ts";
import { users } from "../db/schema.ts";
import { AppError, parseBody, unauthorized } from "../errors.ts";
import { toUserDto } from "../users/dto.ts";

const WINDOW_MS = 15 * 60 * 1000;

export async function authRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, config, authenticate } = deps;
  const perAccount = new FailureLimiter(5, WINDOW_MS);
  const perIp = new FailureLimiter(30, WINDOW_MS);

  app.post("/auth/login", async (req) => {
    const body = parseBody(LoginRequestSchema, req.body);
    const username = body.username.trim();
    const accountKey = `${req.ip}|${username.toLowerCase()}`;
    if (perIp.isBlocked(req.ip) || perAccount.isBlocked(accountKey)) {
      throw new AppError(
        429,
        "rate_limited",
        "Too many failed attempts, try again later",
      );
    }

    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .limit(1);
    let ok = false;
    if (user) {
      ok = await verifyPassword(user.passwordHash, body.password);
    } else {
      await verifyAgainstDummy(body.password);
    }

    if (!user || !ok || user.disabled) {
      perAccount.recordFailure(accountKey);
      perIp.recordFailure(req.ip);
      throw unauthorized("Invalid username or password");
    }

    perAccount.reset(accountKey);
    req.log.info({ userId: user.id }, "login");
    return createSession(db, config.jwtSecret, user, body.deviceName);
  });

  app.post("/auth/refresh", async (req) => {
    const body = parseBody(RefreshRequestSchema, req.body);
    const outcome = await rotateSession(
      db,
      config.jwtSecret,
      body.refreshToken,
    );
    if (outcome.kind === "reused") {
      req.log.warn(
        { sessionId: outcome.sessionId },
        "refresh token reuse detected; session revoked",
      );
      throw unauthorized("Session is no longer valid");
    }
    return outcome.session;
  });

  app.post("/auth/logout", async (req, reply) => {
    const body = parseBody(LogoutRequestSchema, req.body);
    await revokeSessionByRefreshToken(db, body.refreshToken);
    return reply.status(204).send();
  });

  app.get("/me", { preHandler: authenticate }, async (req) => {
    const auth = authOf(req);
    const res: MeResponse = {
      user: toUserDto(auth.user),
      permissions: auth.permissions,
    };
    return res;
  });
}
