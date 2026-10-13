import type { ManagedProvider } from "@ccse/contracts";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { providers, type UserRow } from "../db/schema.ts";
import { tokensUsedTodayByProvider } from "./usage.ts";

export function gatewayPathFor(providerId: string): string {
  return `/gateway/${providerId}/v1`;
}

/** Gateway providers the user may use, for GET /client/config. Owned by the gateway module. */
export async function listManagedProviders(
  db: Db,
  user: UserRow,
): Promise<ManagedProvider[]> {
  const rows = (
    await db
      .select()
      .from(providers)
      .where(eq(providers.enabled, true))
      .orderBy(asc(providers.id))
  ).filter((p) => p.allowedRoles.includes(user.role));
  if (rows.length === 0) return [];

  const used = await tokensUsedTodayByProvider(db, user.id);
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: "gateway",
    gatewayPath: gatewayPathFor(p.id),
    wireApi: "responses",
    models: p.models.map((m) => ({ id: m.id, displayName: m.displayName })),
    defaultModel: p.defaultModel,
    dailyTokenLimit: p.dailyTokenLimitPerUser,
    usedTokensToday: used.get(p.id) ?? 0,
  }));
}
