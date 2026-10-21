import type { User } from "@ccse/contracts";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type UserRow, users } from "../db/schema.ts";
import { AppError } from "../errors.ts";

export function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    adminMenus: row.adminMenus ?? null,
    disabled: row.disabled,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    upstreamAccountIds: row.upstreamAccountIds ?? [],
    groupName: row.groupName ?? "",
    offboardedAt: row.offboardedAt?.toISOString() ?? null,
    offboardedBy: row.offboardedBy ?? null,
  };
}

export async function assertUsersExist(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids));
  if (rows.length !== ids.length) {
    throw new AppError(400, "bad_request", "User not found");
  }
}
