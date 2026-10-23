import { randomInt } from "node:crypto";
import {
  OfflineAccountCostSchema,
  type OfflineAccountCost,
  type OfflineAccountCostInput,
} from "@ccse/contracts";
import { eq, like } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";
import { AppError, notFound } from "../errors.ts";
import { currentCostMonth } from "./account-costs.ts";
import type { LedgerAccount } from "./subscription-ledger.ts";

const prefix = (demo: boolean) =>
  demo ? "demo-offline-account-cost:" : "offline-account-cost:";

export async function readOfflineAccountCosts(
  db: Db,
  demo: boolean,
): Promise<OfflineAccountCost[]> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(like(settings.key, `${prefix(demo)}%`));
  return rows
    .map((row) => OfflineAccountCostSchema.parse(row.value))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** Manual accounts have explicit paid months; no inferred or automatic renewals. */
export function offlineAccountLedger(
  accounts: OfflineAccountCost[],
): LedgerAccount[] {
  return accounts.map((account) => ({
    accountId: account.id,
    platform: "manual",
    cycles: account.charges.map((charge) => ({
      expires: null,
      month: charge.month,
      name: account.name,
      department: account.department,
      planType: null,
      amount: charge.monthlyUsd,
      automaticPricing: false,
    })),
  }));
}

export async function saveOfflineAccountCost(
  db: Db,
  demo: boolean,
  input: OfflineAccountCostInput,
  id?: number,
) {
  if (input.charges.some((charge) => charge.month > currentCostMonth()))
    throw new AppError(400, "bad_request", "请填写已发生费用的入账月份");
  return db.transaction(async (tx) => {
    const accountId = id ?? -randomInt(1, 2 ** 47);
    const key = prefix(demo) + accountId;
    if (id !== undefined) {
      const [row] = await tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .for("update");
      if (!row) throw notFound("手动账号不存在");
    }
    const account = OfflineAccountCostSchema.parse({
      ...input,
      id: accountId,
      charges: [...input.charges].sort((a, b) =>
        a.month.localeCompare(b.month),
      ),
    });
    if (id === undefined)
      await tx.insert(settings).values({ key, value: account });
    else
      await tx
        .update(settings)
        .set({ value: account, updatedAt: new Date() })
        .where(eq(settings.key, key));
    return account;
  });
}

export async function deleteOfflineAccountCost(
  db: Db,
  demo: boolean,
  id: number,
) {
  const removed = await db
    .delete(settings)
    .where(eq(settings.key, prefix(demo) + id))
    .returning({ key: settings.key });
  if (!removed.length) throw notFound("手动账号不存在");
}
