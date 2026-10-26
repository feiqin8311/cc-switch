import { z } from "zod";
import { eq, like } from "drizzle-orm";
import type {
  ManualAccountCost,
  UsageAccountCostsResponse,
} from "@ccse/contracts";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";
import {
  accountDepartment,
  monthlySubscriptionUsd,
  manualCostKey,
} from "./account-costs.ts";

const CycleSchema = z.object({
  expires: z.string().nullable(),
  month: z.string().nullable(),
  name: z.string(),
  department: z.string(),
  planType: z.string().nullable(),
  amount: z.number().nonnegative().nullable(),
  automaticPricing: z.boolean(),
});
const AccountSchema = z.object({
  accountId: z.number(),
  platform: z.string(),
  // Keep the latest display name separate from the historical charge snapshots.
  currentName: z.string().optional(),
  cycles: z.array(CycleSchema),
});
export type LedgerAccount = z.infer<typeof AccountSchema>;
export type ChargeSource = {
  id: number;
  platform: string;
  name: string;
  planType: string | null;
  subscriptionExpiresAt?: string | null;
};
const prefix = (demo: boolean) =>
  demo ? "demo-subscription-ledger:" : "subscription-ledger:";

export function subscriptionCycle(
  expiresAt?: string | null,
): { expires: string; month: string } | null {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  const expires = new Date(expiresAt).toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  const year = Number(expires.slice(0, 4)),
    month = Number(expires.slice(5, 7));
  return {
    expires,
    month: `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, "0")}`,
  };
}
export async function readLedger(
  db: Db,
  demo = false,
): Promise<LedgerAccount[]> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(like(settings.key, `${prefix(demo)}%`));
  return rows.map((row) => AccountSchema.parse(row.value));
}

/** Refresh account names while retaining recorded cycles and charge assignments. */
export async function recordSubscriptions(
  db: Db,
  sources: ChargeSource[],
  overrides: Map<string, ManualAccountCost>,
  demo = false,
) {
  const existing = await readLedger(db, demo);
  const sourceMap = new Map(
    sources.map((source) => [
      JSON.stringify([source.platform, source.id]),
      source,
    ]),
  );
  const identities = new Map(
    existing.map((account) => [
      JSON.stringify([account.platform, account.accountId]),
      { accountId: account.accountId, platform: account.platform },
    ]),
  );
  for (const [key, source] of sourceMap)
    if (accountDepartment(source.name))
      identities.set(key, { accountId: source.id, platform: source.platform });
  for (const [identity, account] of identities) {
    const key = prefix(demo) + identity;
    await db.transaction(async (tx) => {
      await tx
        .insert(settings)
        .values({ key, value: { ...account, cycles: [] } })
        .onConflictDoNothing();
      const [row] = await tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .for("update");
      const stored = AccountSchema.parse(row!.value);
      const source = sourceMap.get(identity);
      if (source) stored.currentName = source.name;
      if (source && accountDepartment(source.name)) {
        const inferred = subscriptionCycle(source.subscriptionExpiresAt);
        let cycle = inferred
          ? stored.cycles.find((cycle) => cycle.expires === inferred.expires)
          : stored.cycles.at(-1);
        if (!cycle) {
          cycle = stored.cycles.find((cycle) => cycle.expires === null);
          if (cycle && inferred) {
            cycle.expires = inferred.expires;
            cycle.month ??= inferred.month;
          }
        }
        if (!cycle)
          stored.cycles.push({
            expires: inferred?.expires ?? null,
            month: inferred?.month ?? null,
            name: source.name,
            department: accountDepartment(source.name)!,
            planType: source.planType,
            amount: monthlySubscriptionUsd(source),
            automaticPricing: monthlySubscriptionUsd(source) !== null,
          });
      }
      for (const cycle of stored.cycles) {
        const manual = overrides.get(
          manualCostKey({ ...account, planType: cycle.planType }),
        );
        // Paid amounts and month/department assignments never change on later polls or price edits.
        if (cycle.amount === null && manual?.monthlyUsd != null)
          cycle.amount = manual.monthlyUsd;
        if (cycle.month === null && manual?.billingMonth)
          cycle.month = manual.billingMonth;
      }
      await tx
        .update(settings)
        .set({ value: stored, updatedAt: new Date() })
        .where(eq(settings.key, key));
    });
  }
  return readLedger(db, demo);
}

export function ledgerMonths(accounts: LedgerAccount[]) {
  const months = new Map<
    string,
    Map<string, UsageAccountCostsResponse["items"][number]>
  >();
  for (const account of accounts)
    for (const cycle of account.cycles) {
      if (!cycle.month) continue;
      const groups: Map<string, UsageAccountCostsResponse["items"][number]> =
        months.get(cycle.month) ?? new Map();
      const group = groups.get(cycle.department) ?? {
        accounts: [],
        department: cycle.department,
        monthlyUsd: 0,
        accountCount: 0,
        unpricedCount: 0,
      };
      const identity = group.accounts.find(
        (item) =>
          item.accountId === account.accountId &&
          item.platform === account.platform,
      );
      const detail = identity ?? {
        accountId: account.accountId,
        platform: account.platform,
        name: cycle.name,
        monthlyUsd: 0,
        unpricedCount: 0,
      };
      if (!identity) group.accounts.push(detail);
      if (cycle.amount === null) detail.unpricedCount++;
      else detail.monthlyUsd += cycle.amount;
      group.accountCount++;
      if (cycle.amount === null) group.unpricedCount++;
      else group.monthlyUsd += cycle.amount;
      groups.set(cycle.department, group);
      months.set(cycle.month, groups);
    }
  return [...months]
    .map(([month, groups]) => ({ month, items: [...groups.values()] }))
    .sort((a, b) => a.month.localeCompare(b.month));
}
export function mergeAccountBreakdowns(
  items: UsageAccountCostsResponse["items"][number]["accounts"],
) {
  const result = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const key = JSON.stringify([item.platform, item.accountId]);
    const existing = result.get(key);
    if (!existing) result.set(key, { ...item });
    else {
      existing.monthlyUsd += item.monthlyUsd;
      existing.unpricedCount += item.unpricedCount;
    }
  }
  return [...result.values()].sort(
    (a, b) =>
      b.monthlyUsd - a.monthlyUsd || a.name.localeCompare(b.name, "zh-CN"),
  );
}

export function ledgerManualAccounts(accounts: LedgerAccount[]) {
  const result: UsageAccountCostsResponse["manualAccounts"] = [];
  for (const account of accounts)
    for (const cycle of account.cycles) {
      if (cycle.amount !== null && cycle.month !== null) continue;
      const key = manualCostKey({ ...account, planType: cycle.planType });
      if (result.some((item) => manualCostKey(item) === key)) continue;
      result.push({
        accountId: account.accountId,
        platform: account.platform,
        planType: cycle.planType,
        name: account.currentName ?? cycle.name,
        department: cycle.department,
        monthlyUsd: cycle.amount,
        billingMonth: cycle.month,
        needsBillingMonth: cycle.month === null,
        automaticPricing: cycle.automaticPricing,
      } as UsageAccountCostsResponse["manualAccounts"][number]);
    }
  return result;
}
