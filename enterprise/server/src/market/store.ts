import { createHash } from "node:crypto";
import type { MarketItem, MarketItemKind } from "@ccse/contracts";
import { and, asc, eq, notExists } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { marketBlobs, marketItems } from "../db/schema.ts";

export type MarketItemRow = typeof marketItems.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function toMarketItemDto(row: MarketItemRow): MarketItem {
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
  };
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

export async function listMarketItems(db: Db): Promise<MarketItemRow[]> {
  return db
    .select()
    .from(marketItems)
    .orderBy(asc(marketItems.kind), asc(marketItems.name), asc(marketItems.id));
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
  patch: { name?: string; description?: string; mandatory?: boolean },
): Promise<MarketItemRow | null> {
  const [row] = await db
    .update(marketItems)
    .set({
      name: patch.name,
      description: patch.description,
      mandatory: patch.mandatory,
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
