import type { UserRow } from "../db/schema.ts";

/** Shared by desktop and web; menu permissions do not grant account access. */
export function canSeeUpstreamAccount(
  user: UserRow,
  accountId: number,
): boolean {
  return user.role === "admin" || user.upstreamAccountIds.includes(accountId);
}
