import { createHash } from "node:crypto";
import type { MarketItem, MarketItemKind } from "@ccse/contracts";
import { and, asc, eq, notExists } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { marketBlobs, marketItems, users } from "../db/schema.ts";

export type MarketItemRow = typeof marketItems.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function publisherLabel(
  displayName: string | null | undefined,
  username: string | null | undefined,
): string | null {
  const n = displayName?.trim() || username?.trim();
  return n || null;
}

export function toMarketItemDto(
  row: MarketItemRow,
  publishedByName: string | null = null,
): MarketItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    version: row.version,
    mandatory: row.mandatory,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt.toISOString(),
    publishedBy: row.publishedBy,
    publishedByName,
  };
}

export async function publisherNameOf(
  db: Db,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db
    .select({ displayName: users.displayName, username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u ? publisherLabel(u.displayName, u.username) : null;
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Deletes the blob when no item references it any more. */
async function deleteBlobIfOrphan(tx: Tx | Db, sha: string): Promise<void> {
  await tx
    .delete(marketBlobs)
    .where(
      and(
        eq(marketBlobs.sha256, sha),
        notExists(
          tx
            .select({ id: marketItems.id })
            .from(marketItems)
            .where(eq(marketItems.sha256, sha)),
        ),
      ),
    );
}

export interface PublishInput {
  id: string;
  kind: MarketItemKind;
  name: string;
  description: string;
  version: string;
  mandatory: boolean;
  data: Buffer;
  publishedBy: string;
}

/** Creates or replaces an item and its package blob atomically. */
export async function publishMarketItem(
  db: Db,
  input: PublishInput,
): Promise<MarketItemRow> {
  const sha = sha256Hex(input.data);
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ sha256: marketItems.sha256 })
      .from(marketItems)
      .where(eq(marketItems.id, input.id))
      .for("update")
      .limit(1);

    await tx
      .insert(marketBlobs)
      .values({ sha256: sha, data: input.data })
      .onConflictDoNothing();

    const now = new Date();
    const values = {
      kind: input.kind,
      name: input.name,
      description: input.description,
      version: input.version,
      mandatory: input.mandatory,
      sha256: sha,
      sizeBytes: input.data.length,
      publishedBy: input.publishedBy,
      updatedAt: now,
    };
    const [row] = await tx
      .insert(marketItems)
      .values({ id: input.id, ...values })
      .onConflictDoUpdate({ target: marketItems.id, set: values })
      .returning();
    if (!row) throw new Error("upsert returned no row");

    if (previous && previous.sha256 !== sha) {
      await deleteBlobIfOrphan(tx, previous.sha256);
    }
    return row;
  });
}

export async function listMarketItems(db: Db): Promise<MarketItem[]> {
  const rows = await db
    .select({
      item: marketItems,
      displayName: users.displayName,
      username: users.username,
    })
    .from(marketItems)
    .leftJoin(users, eq(users.id, marketItems.publishedBy))
    .orderBy(asc(marketItems.kind), asc(marketItems.name), asc(marketItems.id));
  return rows.map((r) =>
    toMarketItemDto(r.item, publisherLabel(r.displayName, r.username)),
  );
}

export async function findMarketItem(
  db: Db,
  id: string,
): Promise<MarketItemRow | null> {
  const [row] = await db
    .select()
    .from(marketItems)
    .where(eq(marketItems.id, id))
    .limit(1);
  return row ?? null;
}

export async function getMarketPackage(
  db: Db,
  id: string,
): Promise<{ item: MarketItemRow; data: Buffer } | null> {
  const [row] = await db
    .select({ item: marketItems, data: marketBlobs.data })
    .from(marketItems)
    .innerJoin(marketBlobs, eq(marketBlobs.sha256, marketItems.sha256))
    .where(eq(marketItems.id, id))
    .limit(1);
  return row ?? null;
}

export async function patchMarketItem(
  db: Db,
  id: string,
  patch: {
    name?: string;
    description?: string;
    mandatory?: boolean;
    publishedBy?: string | null;
  },
): Promise<MarketItemRow | null> {
  const [row] = await db
    .update(marketItems)
    .set({
      name: patch.name,
      description: patch.description,
      mandatory: patch.mandatory,
      publishedBy: patch.publishedBy,
      updatedAt: new Date(),
    })
    .where(eq(marketItems.id, id))
    .returning();
  return row ?? null;
}

/** Deletes an item and its blob when orphaned. Returns false if missing. */
export async function deleteMarketItem(db: Db, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(marketItems)
      .where(eq(marketItems.id, id))
      .returning({ sha256: marketItems.sha256 });
    if (!row) return false;
    await deleteBlobIfOrphan(tx, row.sha256);
    return true;
  });
}
