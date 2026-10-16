import type { User } from "@ccse/contracts";
import type { UserRow } from "../db/schema.ts";

export function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    disabled: row.disabled,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    upstreamAccountIds: row.upstreamAccountIds ?? [],
    groupName: row.groupName ?? "",
  };
}
