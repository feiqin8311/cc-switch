import type {
  ManualAccountCost,
  UpstreamAccount,
  UsageAccountCostsResponse,
} from "@ccse/contracts";
import { ManualAccountCostSchema } from "@ccse/contracts";
import { like } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";

const MANUAL_PREFIX = "usage-account-cost:";
const SNAPSHOT_PREFIX = "usage-account-month:";
export function currentCostMonth(): string {
  return new Date()
    .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
    .slice(0, 7);
}
export async function saveCostMonth(
  db: Db,
  month: string,
  items: UsageAccountCostsResponse["items"],
) {
  const value = { month, items };
  const updatedAt = new Date();
  await db
    .insert(settings)
    .values({ key: SNAPSHOT_PREFIX + month, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } });
}
export async function readCostMonths(db: Db) {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(like(settings.key, `${SNAPSHOT_PREFIX}%`));
  return rows.map(
    (row) =>
      row.value as { month: string; items: UsageAccountCostsResponse["items"] },
  );
}
export function manualCostKey(account: {
  accountId: number;
  platform: string;
  planType: string | null;
}): string {
  return (
    MANUAL_PREFIX +
    JSON.stringify([account.accountId, account.platform, account.planType])
  );
}
export async function readManualCosts(
  db: Db,
): Promise<Map<string, ManualAccountCost>> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(like(settings.key, `${MANUAL_PREFIX}%`));
  const result = new Map<string, ManualAccountCost>();
  for (const row of rows) {
    const parsed = ManualAccountCostSchema.safeParse(row.value);
    if (parsed.success) result.set(manualCostKey(parsed.data), parsed.data);
  }
  return result;
}
export async function saveManualCosts(
  db: Db,
  items: ManualAccountCost[],
): Promise<void> {
  const unique = new Map(items.map((item) => [manualCostKey(item), item]));
  await db.transaction(async (tx) => {
    for (const [key, value] of unique) {
      const updatedAt = new Date();
      await tx
        .insert(settings)
        .values({ key, value, updatedAt })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt },
        });
    }
  });
}

export function accountDepartment(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.startsWith("kevin")) return null;
  if (normalized.startsWith("ezarc")) return "运营部-EZARC";
  if (normalized.startsWith("libraton")) return "Libraton组";
  if (normalized.startsWith("yplus")) return "运营部-YPLUS";
  if (normalized.startsWith("产品部")) return "产品部";
  return "技术部&独立站";
}

/** Subscription estimates, never API usage charges. Unknown SKUs stay unpriced. */
export function monthlySubscriptionUsd(
  account: Pick<UpstreamAccount, "platform" | "planType">,
): number | null {
  if (account.platform.toLowerCase() !== "openai") return null;
  const plan = (account.planType ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const estimates: Record<string, number> = {
    free: 0,
    plus: 20,
    prolite: 100,
    pro100: 100,
    pro: 200,
    chatgptpro: 200,
    pro200: 200,
    promax: 500,
    pro500: 500,
  };
  return Object.hasOwn(estimates, plan) ? estimates[plan]! : null;
}

export function aggregateAccountCosts(
  accounts: (Pick<UpstreamAccount, "name" | "platform" | "planType"> & {
    id?: number;
  })[],
  overrides: Map<string, ManualAccountCost> = new Map(),
): UsageAccountCostsResponse["items"] {
  const groups = new Map<string, UsageAccountCostsResponse["items"][number]>();
  for (const account of accounts) {
    const department = accountDepartment(account.name);
    if (!department) continue;
    const group = groups.get(department) ?? {
      department,
      monthlyUsd: 0,
      accountCount: 0,
      unpricedCount: 0,
    };
    const automatic = monthlySubscriptionUsd(account);
    const manual =
      account.id === undefined
        ? null
        : overrides.get(
            manualCostKey({
              accountId: account.id,
              platform: account.platform,
              planType: account.planType,
            }),
          )?.monthlyUsd;
    const cost = automatic ?? manual ?? null;
    group.accountCount++;
    if (cost === null) group.unpricedCount++;
    else group.monthlyUsd += cost;
    groups.set(department, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.monthlyUsd - a.monthlyUsd ||
      a.department.localeCompare(b.department, "zh-CN"),
  );
}
