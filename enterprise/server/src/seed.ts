import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { count, eq, sql } from "drizzle-orm";
import { hashPassword } from "./auth/password.ts";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db/client.ts";
import { users } from "./db/schema.ts";

export interface SeedResult {
  created: boolean;
  /** Set when a password was generated and written to disk. */
  passwordFile?: string;
}

/** Creates or updates the primary admin according to config. */
export async function seedInitialAdmin(
  db: Db,
  config: AppConfig,
): Promise<SeedResult> {
  const targetUsername = config.admin.username;
  let password = config.admin.password;
  let passwordFile: string | undefined;

  if (!password) {
    password = randomBytes(18).toString("base64url");
    mkdirSync(config.dataDir, { recursive: true });
    passwordFile = join(config.dataDir, "initial-admin-password.txt");
    writeFileSync(
      passwordFile,
      `username: ${targetUsername}\npassword: ${password}\n`,
      { mode: 0o600 },
    );
  }

  const passwordHash = await hashPassword(password);

  // 1. Check if configured admin already exists
  const [existingTarget] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${targetUsername})`)
    .limit(1);

  if (existingTarget) {
    await db
      .update(users)
      .set({
        passwordHash,
        role: "admin",
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingTarget.id));
    return { created: false, passwordFile };
  }

  // 2. Check if legacy 'admin' exists and migrate to configured admin
  if (targetUsername !== "admin") {
    const [legacyAdmin] = await db
      .select()
      .from(users)
      .where(eq(users.username, "admin"))
      .limit(1);

    if (legacyAdmin) {
      await db
        .update(users)
        .set({
          username: targetUsername,
          displayName: targetUsername,
          passwordHash,
          role: "admin",
          updatedAt: new Date(),
        })
        .where(eq(users.id, legacyAdmin.id));
      return { created: false, passwordFile };
    }
  }

  // 3. Otherwise insert fresh admin
  await db.insert(users).values({
    username: targetUsername,
    displayName: targetUsername,
    passwordHash,
    role: "admin",
  });
  return { created: true, passwordFile };
}
