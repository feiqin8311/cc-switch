import { lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversations } from "../db/schema.ts";
import { getRetentionPolicy } from "./policy.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * Deletes conversations idle longer than the policy's retentionDays (messages
 * cascade). Runs whether or not uploads are currently enabled, so data kept
 * from an earlier enabled period still expires. Returns the deleted count.
 */
export async function purgeExpired(db: Db, now = new Date()): Promise<number> {
  const policy = await getRetentionPolicy(db);
  const cutoff = new Date(now.getTime() - policy.retentionDays * DAY_MS);
  const deleted = await db
    .delete(conversations)
    .where(lt(conversations.lastMessageAt, cutoff))
    .returning({ id: conversations.id });
  return deleted.length;
}

/** Starts periodic retention jobs (purge). Returns a stop function. */
export function startRetentionJobs(db: Db): () => void {
  let stopped = false;
  let running = false;
  let interval: NodeJS.Timeout | undefined;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const count = await purgeExpired(db);
      if (count > 0) {
        console.info(`[retention] purged ${count} expired conversation(s)`);
      }
    } catch (err) {
      console.warn("[retention] purge failed", err);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => {
    void run();
    if (stopped) return;
    interval = setInterval(() => void run(), INTERVAL_MS);
    interval.unref();
  }, FIRST_RUN_DELAY_MS);
  first.unref();

  return () => {
    stopped = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
