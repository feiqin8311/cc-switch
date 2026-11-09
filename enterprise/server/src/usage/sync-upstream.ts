import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { upstreamUsageRecords } from "../db/schema.ts";
import { listUpstreamUsage, type Sub2ApiConfig } from "../sub2api.ts";

/**
 * A failed page never commits a partial snapshot. Overlapping ranges and
 * repeated runs update the same upstream identity.
 */
export function createUpstreamUsageSync(db: Db, config: Sub2ApiConfig) {
  const active = new Map<
    string,
    Promise<Awaited<ReturnType<typeof listUpstreamUsage>>>
  >();
  return (
    from: string,
    to: string,
  ): Promise<Awaited<ReturnType<typeof listUpstreamUsage>>> => {
    const key = `${from}/${to}`;
    const existing = active.get(key);
    if (existing) return existing;
    const run = (async () => {
      // Offset pagination can shift while new usage is being written. Compare
      // consecutive scans of a fixed cutoff and fail instead of committing a
      // visibly inconsistent result. A later run can collect late arrivals.
      const cutoff = Date.now();
      let previous: Set<number> | undefined;
      let rows: Awaited<ReturnType<typeof listUpstreamUsage>> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const scan = (await listUpstreamUsage(config, from, to)).filter(
          (row) => Date.parse(row.createdAt) <= cutoff,
        );
        const ids = new Set(scan.map((row) => row.id));
        if (
          previous &&
          ids.size === previous.size &&
          [...ids].every((id) => previous?.has(id))
        ) {
          rows = scan;
          break;
        }
        previous = ids;
      }
      if (!rows) throw new Error("上游用量分页未稳定，未保存同步结果");
      const stableRows = rows;
      const origin = new URL(config.url).origin;
      await db.transaction(async (tx) => {
        for (let i = 0; i < stableRows.length; i += 200) {
          const batch = stableRows.slice(i, i + 200);
          await tx
            .insert(upstreamUsageRecords)
            .values(
              batch.map((row) => ({
                origin,
                upstreamId: row.id,
                createdAt: new Date(row.createdAt),
                payload: row,
                syncedAt: new Date(),
              })),
            )
            .onConflictDoUpdate({
              target: [
                upstreamUsageRecords.origin,
                upstreamUsageRecords.upstreamId,
              ],
              set: {
                createdAt: sql`excluded.created_at`,
                payload: sql`excluded.payload`,
                syncedAt: sql`excluded.synced_at`,
              },
            });
        }
      });
      return stableRows;
    })().finally(() => active.delete(key));
    active.set(key, run);
    return run;
  };
}
