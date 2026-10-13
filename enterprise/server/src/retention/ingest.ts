import type {
  ConversationUpload,
  RetentionUploadResponse,
} from "@ccse/contracts";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationMessages, conversations } from "../db/schema.ts";

/** Postgres `text` rejects NUL characters. */
export function stripNul(s: string): string {
  return s.includes("\u0000") ? s.replaceAll("\u0000", "") : s;
}

const stripNullable = (s: string | null) => (s === null ? null : stripNul(s));

const MIN_TS = Date.UTC(1970, 0, 1);
const MAX_TS = Date.UTC(9999, 11, 31);

/** Parses a client timestamp; unparseable or out-of-range values become null. */
function parseTimestamp(s: string | null): Date | null {
  if (s === null) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms) || ms < MIN_TS || ms > MAX_TS) return null;
  return new Date(ms);
}

export interface IngestOptions {
  userId: string;
  deviceName: string | null;
  now?: Date;
}

/**
 * Stores uploaded conversations for one user in a single transaction.
 * Idempotent: messages are keyed by (conversation, seq), so re-uploads only
 * count as duplicates. The user id always comes from the caller's session.
 */
export async function ingestConversations(
  db: Db,
  items: ConversationUpload[],
  opts: IngestOptions,
): Promise<RetentionUploadResponse> {
  // All timestamps are written from JS Dates (millisecond precision) so the
  // admin list's keyset cursor round-trips exactly.
  const now = opts.now ?? new Date();
  let accepted = 0;
  let duplicates = 0;

  await db.transaction(async (tx) => {
    for (const item of items) {
      const startedAt = parseTimestamp(item.startedAt) ?? now;
      const title = stripNullable(item.title);
      const projectDir = stripNullable(item.projectDir);

      const [conv] = await tx
        .insert(conversations)
        .values({
          userId: opts.userId,
          clientSessionId: stripNul(item.clientSessionId),
          deviceName: opts.deviceName,
          title,
          projectDir,
          startedAt,
          lastMessageAt: startedAt,
        })
        .onConflictDoUpdate({
          target: [conversations.userId, conversations.clientSessionId],
          set: {
            title: sql`coalesce(excluded.title, ${conversations.title})`,
            projectDir: sql`coalesce(excluded.project_dir, ${conversations.projectDir})`,
            deviceName: sql`coalesce(excluded.device_name, ${conversations.deviceName})`,
          },
        })
        .returning({ id: conversations.id });
      if (!conv) throw new Error("conversation upsert returned no row");

      let insertedSeqs = new Set<number>();
      if (item.messages.length > 0) {
        const rows = await tx
          .insert(conversationMessages)
          .values(
            item.messages.map((m) => ({
              conversationId: conv.id,
              seq: m.seq,
              role: m.role,
              kind: m.kind,
              content: stripNul(m.content),
              toolName: stripNullable(m.toolName),
              timestamp: parseTimestamp(m.timestamp),
              model: stripNullable(m.model),
              inputTokens: m.inputTokens,
              outputTokens: m.outputTokens,
            })),
          )
          .onConflictDoNothing({
            target: [
              conversationMessages.conversationId,
              conversationMessages.seq,
            ],
          })
          .returning({ seq: conversationMessages.seq });
        insertedSeqs = new Set(rows.map((r) => r.seq));
      }
      accepted += insertedSeqs.size;
      duplicates += item.messages.length - insertedSeqs.size;

      let lastMessageAt: Date | undefined;
      if (insertedSeqs.size > 0) {
        let maxTs: number | null = null;
        for (const m of item.messages) {
          if (!insertedSeqs.has(m.seq)) continue;
          const ts = parseTimestamp(m.timestamp)?.getTime();
          if (ts !== undefined && (maxTs === null || ts > maxTs)) maxTs = ts;
        }
        // Clamp to now so a skewed client clock cannot postpone expiry.
        lastMessageAt = new Date(
          maxTs === null ? now.getTime() : Math.min(maxTs, now.getTime()),
        );
      }

      const latestModel = tx
        .select({ model: conversationMessages.model })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, conv.id),
            isNotNull(conversationMessages.model),
          ),
        )
        .orderBy(desc(conversationMessages.seq))
        .limit(1);

      await tx
        .update(conversations)
        .set({
          messageCount: sql`(select count(*)::int from ${conversationMessages} where ${conversationMessages.conversationId} = ${conv.id})`,
          model: sql`coalesce((${latestModel}), ${conversations.model})`,
          lastMessageAt:
            lastMessageAt === undefined
              ? undefined
              : sql`greatest(${conversations.lastMessageAt}, ${lastMessageAt.toISOString()}::timestamptz)`,
        })
        .where(eq(conversations.id, conv.id));
    }
  });

  return { accepted, duplicates };
}
