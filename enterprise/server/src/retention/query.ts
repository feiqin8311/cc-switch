import type {
  ConversationDetailResponse,
  ConversationSummary,
  ListConversationsResponse,
  RetainedMessage,
} from "@ccse/contracts";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationMessages, conversations, users } from "../db/schema.ts";
import { AppError } from "../errors.ts";
import { stripNul } from "./ingest.ts";

export interface ListConversationsFilter {
  userId?: string;
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const badQuery = (message: string) => new AppError(400, "bad_request", message);

/** Parses a YYYY-MM-DD (already regex-checked) as a UTC midnight; rejects e.g. 2025-02-30. */
function parseUtcDate(s: string, field: string): Date {
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw badQuery(`Invalid ${field} date`);
  }
  return d;
}

export function encodeCursor(lastMessageAt: Date, id: string): string {
  return Buffer.from(`${lastMessageAt.toISOString()}|${id}`).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { ts: string; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = raw.indexOf("|");
  const ts = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (sep < 0 || !UUID_RE.test(id) || Number.isNaN(Date.parse(ts))) {
    throw badQuery("Invalid cursor");
  }
  return { ts: new Date(ts).toISOString(), id };
}

/** Escapes LIKE metacharacters (backslash is Postgres' default escape). */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const summaryColumns = {
  id: conversations.id,
  userId: users.id,
  username: users.username,
  displayName: users.displayName,
  clientSessionId: conversations.clientSessionId,
  deviceName: conversations.deviceName,
  title: conversations.title,
  projectDir: conversations.projectDir,
  model: conversations.model,
  startedAt: conversations.startedAt,
  lastMessageAt: conversations.lastMessageAt,
  messageCount: conversations.messageCount,
};

type SummaryRow = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  clientSessionId: string;
  deviceName: string | null;
  title: string | null;
  projectDir: string | null;
  model: string | null;
  startedAt: Date;
  lastMessageAt: Date;
  messageCount: number;
};

function toSummary(r: SummaryRow): ConversationSummary {
  return {
    id: r.id,
    user: { id: r.userId, username: r.username, displayName: r.displayName },
    clientSessionId: r.clientSessionId,
    deviceName: r.deviceName,
    title: r.title,
    projectDir: r.projectDir,
    model: r.model,
    startedAt: r.startedAt.toISOString(),
    lastMessageAt: r.lastMessageAt.toISOString(),
    messageCount: r.messageCount,
  };
}

export async function listConversations(
  db: Db,
  f: ListConversationsFilter,
): Promise<ListConversationsResponse> {
  const conds: SQL[] = [];
  if (f.userId) conds.push(eq(conversations.userId, f.userId));
  if (f.from) {
    conds.push(gte(conversations.lastMessageAt, parseUtcDate(f.from, "from")));
  }
  if (f.to) {
    const end = new Date(parseUtcDate(f.to, "to").getTime() + DAY_MS);
    conds.push(lt(conversations.lastMessageAt, end));
  }
  const q = f.q === undefined ? "" : stripNul(f.q).trim();
  if (q) {
    const pattern = likeContains(q);
    const match = or(
      ilike(conversations.title, pattern),
      exists(
        db
          .select({ one: sql`1` })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.conversationId, conversations.id),
              ilike(conversationMessages.content, pattern),
            ),
          ),
      ),
    );
    if (match) conds.push(match);
  }
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    conds.push(
      sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${c.ts}::timestamptz, ${c.id}::uuid)`,
    );
  }

  const rows = await db
    .select(summaryColumns)
    .from(conversations)
    .innerJoin(users, eq(users.id, conversations.userId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(f.limit + 1);

  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    items: page.map(toSummary),
    nextCursor:
      rows.length > f.limit && last
        ? encodeCursor(last.lastMessageAt, last.id)
        : null,
  };
}

export async function getConversationDetail(
  db: Db,
  id: string,
): Promise<ConversationDetailResponse | null> {
  const [row] = await db
    .select(summaryColumns)
    .from(conversations)
    .innerJoin(users, eq(users.id, conversations.userId))
    .where(eq(conversations.id, id))
    .limit(1);
  if (!row) return null;

  const msgs = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(asc(conversationMessages.seq));

  return {
    conversation: toSummary(row),
    messages: msgs.map(
      (m): RetainedMessage => ({
        seq: m.seq,
        role: m.role,
        kind: m.kind,
        content: m.content,
        toolName: m.toolName,
        timestamp: m.timestamp?.toISOString() ?? null,
        model: m.model,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
      }),
    ),
  };
}
