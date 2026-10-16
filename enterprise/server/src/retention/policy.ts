import {
  type AdminRetentionPolicy,
  AdminRetentionPolicySchema,
} from "@ccse/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";

export const RETENTION_SETTINGS_KEY = "retention";

export const DEFAULT_RETENTION_POLICY: AdminRetentionPolicy = {
  enabled: false,
};

/**
 * Current retention policy (settings key "retention"), or the default. Rows
 * saved before noticeText / retentionDays were dropped still parse: the extra
 * keys are stripped.
 */
export async function getRetentionPolicy(
  db: Db,
): Promise<AdminRetentionPolicy> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, RETENTION_SETTINGS_KEY))
    .limit(1);
  if (!row) return { ...DEFAULT_RETENTION_POLICY };
  const parsed = AdminRetentionPolicySchema.safeParse(row.value);
  return parsed.success ? parsed.data : { ...DEFAULT_RETENTION_POLICY };
}

export async function saveRetentionPolicy(
  db: Db,
  policy: AdminRetentionPolicy,
): Promise<AdminRetentionPolicy> {
  const now = new Date();
  await db
    .insert(settings)
    .values({ key: RETENTION_SETTINGS_KEY, value: policy, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: policy, updatedAt: now },
    });
  return policy;
}
