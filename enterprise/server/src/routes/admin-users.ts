import {
  CreateUserRequestSchema,
  type ListUsersResponse,
  UpdateUserRequestSchema,
} from "@ccse/contracts";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { authOf, requirePermission } from "../auth/guard.ts";
import { hashPassword } from "../auth/password.ts";
import { revokeAllUserSessions } from "../auth/sessions.ts";
import { users } from "../db/schema.ts";
import { AppError, forbidden, notFound, parseBody } from "../errors.ts";
import { toUserDto } from "../users/dto.ts";

const IdParamSchema = z.object({ id: z.string().uuid() });

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

  app.get("/admin/users", guard, async () => {
    const rows = await db.select().from(users).orderBy(asc(users.createdAt));
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
          displayName: body.displayName,
          passwordHash: await hashPassword(body.password),
          role: body.role,
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

  app.patch("/admin/users/:id", guard, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const body = parseBody(UpdateUserRequestSchema, req.body);
    const actor = authOf(req).user;

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

    const [row] = await db
      .update(users)
      .set({
        displayName: body.displayName,
        role: body.role,
        disabled: body.disabled,
        passwordHash:
          body.password !== undefined
            ? await hashPassword(body.password)
            : undefined,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw notFound("User not found");

    const securityChanged =
      (body.disabled === true && !existing.disabled) ||
      (body.role !== undefined && body.role !== existing.role) ||
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
}
