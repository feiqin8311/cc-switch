import {
  GroupNameSchema,
  permissionsForUser,
  UsernameSchema,
} from "@ccse/contracts";
import { eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.ts";
import { revokeAllUserSessions } from "../auth/sessions.ts";
import type { Db } from "../db/client.ts";
import { users } from "../db/schema.ts";
import { listUpstreamUserEntries, type Sub2ApiConfig } from "../sub2api.ts";

export function createUpstreamUserSync(db: Db, config: Sub2ApiConfig | null) {
  let running:
    | Promise<{ created: number; updated: number; skipped: number }>
    | undefined;
  const sync = async () => {
    if (!config) throw new Error("未配置上游地址及登录账号");
    const origin = new URL(config.url).origin;
    const entries = await listUpstreamUserEntries(config);
    const counts = new Map<string, number>();
    for (const entry of entries)
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    let created = 0,
      updated = 0,
      skipped = 0;
    for (const entry of entries) {
      if (
        counts.get(entry.name) !== 1 ||
        !UsernameSchema.safeParse(entry.name).success ||
        !GroupNameSchema.safeParse(entry.groupName).success
      ) {
        skipped++;
        continue;
      }
      const rows = await db.select().from(users);
      const linked = rows.find(
        (u) => u.upstreamKeyId === entry.id && u.upstreamKeyOrigin === origin,
      );
      const named = rows.find((u) => u.username === entry.name);
      if (
        (linked && named && linked.id !== named.id) ||
        (!linked &&
          named &&
          (named.role === "admin" || named.upstreamKeyId !== null))
      ) {
        skipped++;
        continue;
      }
      const existing = linked ?? named;
      if (!existing) {
        const inserted = await db
          .insert(users)
          .values({
            username: entry.name,
            displayName: entry.name,
            passwordHash: await hashPassword("123456"),
            role: "member",
            groupName: entry.groupName,
            upstreamKeyId: entry.id,
            upstreamKeyOrigin: origin,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length) created++;
        else skipped++;
      } else if (
        existing.username !== entry.name ||
        existing.groupName !== entry.groupName ||
        existing.upstreamKeyId === null
      ) {
        const groupChanged = existing.groupName !== entry.groupName;
        await db
          .update(users)
          .set({
            username: entry.name,
            displayName:
              existing.displayName === existing.username
                ? entry.name
                : existing.displayName,
            groupName: entry.groupName,
            upstreamKeyId: entry.id,
            upstreamKeyOrigin: origin,
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id));
        if (
          groupChanged &&
          (permissionsForUser(existing).includes("users.group.manage") ||
            permissionsForUser(existing).includes("usage.group.read"))
        )
          await revokeAllUserSessions(db, existing.id);
        updated++;
      }
    }
    return { created, updated, skipped };
  };
  return () => {
    if (!running)
      running = sync().finally(() => {
        running = undefined;
      });
    return running;
  };
}
