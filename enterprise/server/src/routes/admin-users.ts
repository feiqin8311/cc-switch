import {
  CreateUserRequestSchema,
  type ListUsersResponse,
  type OffboardUserResponse,
  UpdateUserRequestSchema,
} from "@ccse/contracts";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import {
  authOf,
  requireAnyPermission,
  requirePermission,
} from "../auth/guard.ts";
import { hashPassword } from "../auth/password.ts";
import { revokeAllUserSessions } from "../auth/sessions.ts";
import { auditEvents, devices, sessions, users } from "../db/schema.ts";
import { AppError, forbidden, notFound, parseBody } from "../errors.ts";
import { toUserDto } from "../users/dto.ts";
import { groupScope } from "../users/scope.ts";

const IdParamSchema = z.object({ id: z.string().uuid() });
const GroupRoleUpdateSchema = z
  .object({ role: z.enum(["member", "viewer"]) })
  .strict();

function uniqueAccountIds(ids: number[] | undefined): number[] {
  if (!ids) return [];
  return [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres unique_violation, possibly wrapped by drizzle in `cause`.
  const codeOf = (e: unknown) =>
    typeof e === "object" && e !== null && "code" in e
      ? (e as { code: unknown }).code
      : undefined;
  return (
    codeOf(err) === "23505" ||
    codeOf((err as { cause?: unknown } | null)?.cause) === "23505"
  );
}

export async function adminUserRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, authenticate } = deps;
  const guard = {
    preHandler: [authenticate, requirePermission("users.manage")],
  };
  const groupGuard = {
    preHandler: [
      authenticate,
      requireAnyPermission("users.manage", "users.group.manage"),
    ],
  };

  app.get("/admin/users", groupGuard, async (req) => {
    const actor = authOf(req).user;
    const rows = await db
      .select()
      .from(users)
      .where(actor.role === "group_leader" ? groupScope(actor) : undefined)
      .orderBy(asc(users.createdAt));
    const res: ListUsersResponse = { items: rows.map(toUserDto) };
    return res;
  });

  app.post("/admin/users", guard, async (req, reply) => {
    const body = parseBody(CreateUserRequestSchema, req.body);
    try {
      const [row] = await db
        .insert(users)
        .values({
          username: body.username,
          displayName: body.displayName ?? body.username,
          passwordHash: await hashPassword(body.password),
          role: body.role,
          upstreamAccountIds: uniqueAccountIds(body.upstreamAccountIds),
          groupName: body.groupName ?? "",
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      req.log.info(
        { actor: authOf(req).user.id, userId: row.id, role: row.role },
        "user created",
      );
      return reply.status(201).send(toUserDto(row));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, "conflict", "Username already exists");
      }
      throw err;
    }
  });

  app.patch("/admin/users/:id", groupGuard, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const body = parseBody(UpdateUserRequestSchema, req.body);
    const actor = authOf(req).user;
    const isGroupLeader = actor.role === "group_leader";
    if (isGroupLeader) parseBody(GroupRoleUpdateSchema, req.body);

    if (id === actor.id) {
      if (body.disabled === true)
        throw forbidden("You cannot disable yourself");
      if (body.role !== undefined && body.role !== "admin") {
        throw forbidden("You cannot remove your own admin role");
      }
    }

    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!existing) throw notFound("User not found");
    if (
      isGroupLeader &&
      (!actor.groupName.trim() ||
        existing.groupName !== actor.groupName ||
        (existing.role !== "member" && existing.role !== "viewer"))
    )
      throw forbidden("只能修改本组成员或只读用户的角色");

    const renamed =
      body.username !== undefined && body.username !== existing.username;
    const [row] = await db
      .update(users)
      .set({
        username: renamed ? body.username : undefined,
        displayName:
          body.displayName ??
          (renamed && existing.displayName === existing.username
            ? body.username
            : undefined),
        role: body.role,
        disabled: body.disabled,
        passwordHash:
          body.password !== undefined
            ? await hashPassword(body.password)
            : undefined,
        upstreamAccountIds:
          body.upstreamAccountIds !== undefined
            ? uniqueAccountIds(body.upstreamAccountIds)
            : undefined,
        groupName: body.groupName,
        ...(body.disabled === false && existing.offboardedAt
          ? { offboardedAt: null, offboardedBy: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(users.id, id),
          isGroupLeader
            ? and(groupScope(actor), inArray(users.role, ["member", "viewer"]))
            : undefined,
        ),
      )
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new AppError(409, "conflict", "Username already exists");
        }
        throw err;
      });
    if (!row) throw notFound("User not found");

    const securityChanged =
      (body.disabled === true && !existing.disabled) ||
      (body.role !== undefined && body.role !== existing.role) ||
      (existing.role === "group_leader" &&
        body.groupName !== undefined &&
        body.groupName !== existing.groupName) ||
      body.password !== undefined;
    if (securityChanged && id !== actor.id) {
      await revokeAllUserSessions(db, id);
    }

    req.log.info(
      {
        actor: actor.id,
        userId: id,
        fields: Object.keys(body).filter(
          (k) => body[k as keyof typeof body] !== undefined,
        ),
      },
      "user updated",
    );
    return toUserDto(row);
  });

  app.post("/admin/users/:id/offboard", guard, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const actor = authOf(req).user;
    if (id === actor.id) throw forbidden("You cannot offboard yourself");

    const res = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (!existing) throw notFound("User not found");
      if (existing.offboardedAt) {
        throw new AppError(409, "conflict", "User is already offboarded");
      }

      const now = new Date();
      const [row] = await tx
        .update(users)
        .set({
          disabled: true,
          offboardedAt: now,
          offboardedBy: actor.username,
          updatedAt: now,
        })
        .where(eq(users.id, id))
        .returning();
      if (!row) throw notFound("User not found");
      // Revoking the sessions also invalidates their gateway keys.
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      const disabledDevices = await tx
        .update(devices)
        .set({ disabled: true })
        .where(and(eq(devices.userId, id), eq(devices.disabled, false)))
        .returning({ id: devices.id });
      await tx.insert(auditEvents).values({
        action: "user.offboard",
        actorId: actor.id,
        actorUsername: actor.username,
        targetUserId: id,
        targetUsername: existing.username,
        detail: {
          revokedSessions: revoked.length,
          disabledDeviceIds: disabledDevices.map((d) => d.id),
        },
      });
      const out: OffboardUserResponse = {
        user: toUserDto(row),
        revokedSessions: revoked.length,
        disabledDevices: disabledDevices.length,
      };
      return out;
    });

    req.log.info(
      {
        actor: actor.id,
        userId: id,
        revokedSessions: res.revokedSessions,
        disabledDevices: res.disabledDevices,
      },
      "user offboarded",
    );
    return res;
  });

  app.delete("/admin/users/:id", guard, async (req, reply) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const actor = authOf(req).user;
    if (id === actor.id) throw forbidden("You cannot delete yourself");

    const deleted = await db
      .delete(users)
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (deleted.length === 0) throw notFound("User not found");

    req.log.info({ actor: actor.id, userId: id }, "user deleted");
    return reply.status(204).send();
  });
}
