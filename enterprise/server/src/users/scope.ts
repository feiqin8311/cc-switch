import { eq, sql } from "drizzle-orm";
import { type UserRow, users } from "../db/schema.ts";

/** Ungrouped leaders must never gain access to every ungrouped account. */
export function groupScope(actor: UserRow) {
  return actor.groupName.trim()
    ? eq(users.groupName, actor.groupName)
    : sql`false`;
}
