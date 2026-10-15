import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "./auth/password.ts";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { findMarketItem, publishMarketItem } from "./market/store.ts";

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

const DWS_CONNECTOR_ID = "dws";
const DWS_CONNECTOR_BODY = Buffer.from(JSON.stringify({ type: "dws" }));

/**
 * Ensures the built-in DingTalk Workspace CLI connector exists in the market.
 * Does not overwrite an existing row (admins may have edited name/version).
 */
export async function seedBuiltinConnectors(db: Db): Promise<boolean> {
  if (await findMarketItem(db, DWS_CONNECTOR_ID)) return false;

  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  if (!admin) return false;

  await publishMarketItem(db, {
    id: DWS_CONNECTOR_ID,
    kind: "connector",
    name: "钉钉 Workspace CLI",
    description:
      "官方 dws 命令行。员工安装后会把日历、文档、AI 表格等 Skill 接到 Codex；登录需本人扫码。",
    version: "1.0.0",
    mandatory: false,
    data: DWS_CONNECTOR_BODY,
    publishedBy: admin.id,
  });
  return true;
}
