import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";
import type { WeeklyUsageSample } from "../sub2api.ts";

const MeterSchema = z.object({
  lastPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  sampledAt: z.string(),
  months: z.record(z.string(), z.number().nonnegative()),
  incompleteMonths: z.array(z.string()),
  needsBaseline: z.boolean().optional(),
});
const StateSchema = z.object({
  assignments: z.record(z.string(), z.array(z.number().int().positive())),
  meters: z.record(z.string(), MeterSchema),
  error: z.string().nullable().default(null),
  counterVersion: z.string().optional(),
});
type State = z.infer<typeof StateSchema>;
const emptyState = (): State => ({ assignments: {}, meters: {}, error: null });
const COUNTER_VERSION = "increments-only-2026-11-10";

export function shanghaiMonth(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(date);
}

export function meterKey(origin: string): string {
  return `department-usage:${createHash("sha256").update(origin).digest("hex")}`;
}

/** Updates only from valid observations; a cross-month observation establishes a baseline. */
export function applyWeeklySample(
  state: State,
  sample: WeeklyUsageSample,
  at: Date,
): void {
  const id = String(sample.id);
  const month = shanghaiMonth(at);
  const current = state.meters[id];
  const mark = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value);
  };
  if (!current) {
    state.meters[id] = {
      lastPercent: sample.usedPercent,
      resetsAt: sample.resetsAt,
      sampledAt: at.toISOString(),
      months: { [month]: 0 },
      incompleteMonths: [],
    };
    return;
  }
  const previousTime = Date.parse(current.sampledAt);
  if (at.getTime() <= previousTime) return;
  const previousMonth = shanghaiMonth(new Date(previousTime));
  if (current.needsBaseline) {
    current.months[month] = 0;
    current.needsBaseline = false;
  } else if (month !== previousMonth) {
    current.months[month] ??= 0;
    // The interval around midnight cannot be attributed precisely from snapshots.
    mark(current.incompleteMonths, previousMonth);
    mark(current.incompleteMonths, month);
  } else {
    const dropped = sample.usedPercent < current.lastPercent;
    if (dropped || at.getTime() - previousTime > 2 * 60_000)
      mark(current.incompleteMonths, month);
    // A lower reading starts a new window; timestamps alone never add usage.
    const increase = dropped
      ? sample.usedPercent
      : sample.usedPercent - current.lastPercent;
    current.months[month] = (current.months[month] ?? 0) + increase / 4;
  }
  current.lastPercent = sample.usedPercent;
  current.resetsAt = sample.resetsAt;
  current.sampledAt = at.toISOString();
}

export async function readDepartmentState(db: Db, key: string): Promise<State> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  return row ? StateSchema.parse(row.value) : emptyState();
}

export async function updateDepartmentState(
  db: Db,
  key: string,
  update: (state: State) => void,
): Promise<State> {
  return db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key, value: emptyState() })
      .onConflictDoNothing();
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .for("update");
    if (!row) throw new Error("Missing department usage state");
    const state = StateSchema.parse(row.value);
    if (state.counterVersion !== COUNTER_VERSION) {
      const now = new Date();
      const month = shanghaiMonth(now);
      // Keep the old counters before the one-time restart. Baseline only from
      // a fresh successful sample, including accounts unavailable at startup.
      if (
        Object.keys(state.meters).length ||
        Object.keys(state.assignments).length
      )
        await tx
          .insert(settings)
          .values({
            key: `${key}:backup:${COUNTER_VERSION}`,
            value: { savedAt: now.toISOString(), state: row.value },
          })
          .onConflictDoNothing();
      for (const meter of Object.values(state.meters)) {
        meter.months[month] = 0;
        meter.needsBaseline = true;
        meter.incompleteMonths = meter.incompleteMonths.filter(
          (value) => value !== month,
        );
      }
      state.counterVersion = COUNTER_VERSION;
      state.error = null;
    }
    update(state);
    await tx
      .update(settings)
      .set({ value: state, updatedAt: new Date() })
      .where(eq(settings.key, key));
    return state;
  });
}

export function departmentUsageView(state: State, now: Date) {
  const month = shanghaiMonth(now);
  return {
    month,
    error: state.error,
    assignments: state.assignments,
    accounts: Object.entries(state.meters).map(([id, meter]) => ({
      id: Number(id),
      used: meter.months[month] ?? 0,
      sampledAt:
        !meter.needsBaseline &&
        shanghaiMonth(new Date(meter.sampledAt)) === month
          ? meter.sampledAt
          : null,
      incomplete:
        !!meter.needsBaseline ||
        meter.incompleteMonths.includes(month) ||
        shanghaiMonth(new Date(meter.sampledAt)) !== month,
    })),
  };
}
