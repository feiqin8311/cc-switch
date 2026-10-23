import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { openDatabase } from "../src/db/client.ts";
import {
  marketBlobs,
  marketItems,
  providers,
  settings,
  users,
} from "../src/db/schema.ts";
import { canUserAccessProvider } from "../src/gateway/managed.ts";
import { canSeeMarketItem } from "../src/market/store.ts";

it.each([
  ["Libraton组", "运营部-LIBRATON", "0010_rename_libraton_group"],
  ["技术部&独立站", "技术部&独立站&TK", "0011_rename_technical_group"],
])(
  "renames %s, permissions and cost history without changing totals",
  async (legacy, renamed, migrationName) => {
    const database = await openDatabase({ pgliteDataDir: "memory://" });
    const { db } = database;
    try {
      await db.insert(users).values({
        username: "libraton-member",
        displayName: "Member",
        passwordHash: "unused",
        role: "member",
        groupName: legacy,
      });
      await db.insert(providers).values({
        id: "provider",
        name: "Provider",
        baseUrl: "https://example.com/v1",
        wireApi: "responses",
        apiKeyEnc: "unused",
        apiKeyHint: "unused",
        models: [],
        defaultModel: "model",
        allowedGroups: [legacy, "产品部"],
      });
      await db
        .insert(marketBlobs)
        .values({ sha256: "blob", data: Buffer.alloc(0) });
      await db.insert(marketItems).values({
        id: "item",
        kind: "skill",
        name: "Item",
        version: "1.0.0",
        sha256: "blob",
        sizeBytes: 0,
        visibleGroups: [legacy, "产品部"],
      });
      const items = [
        {
          department: legacy,
          monthlyUsd: 47.4,
          accountCount: 3,
          unpricedCount: 0,
        },
        {
          department: "产品部",
          monthlyUsd: 20,
          accountCount: 1,
          unpricedCount: 0,
        },
      ];
      const keys = [
        "usage-account-month:2026-09",
        "demo-account-month:2026-09",
      ];
      await db.insert(settings).values([
        ...keys.map((key) => ({ key, value: { month: "2026-09", items } })),
        {
          key: "usage-account-month:2026-08",
          value: { month: "2026-08", items: [] },
        },
        { key: "unrelated", value: { items } },
      ]);

      const migration = await readFile(
        new URL(`../drizzle/${migrationName}.sql`, import.meta.url),
        "utf8",
      );
      // Reapplying must also be safe for empty snapshots and unrelated settings.
      for (let run = 0; run < 2; run++) {
        await db.transaction(async (tx) => {
          for (const statement of migration.split("--> statement-breakpoint")) {
            await tx.execute(sql.raw(statement));
          }
        });
      }

      const [user] = await db.select().from(users);
      const [provider] = await db.select().from(providers);
      const [item] = await db.select().from(marketItems);
      if (!user || !provider || !item)
        throw new Error("Missing migrated fixtures");
      expect(user.groupName).toBe(renamed);
      expect(provider.allowedGroups).toEqual([renamed, "产品部"]);
      expect(item.visibleGroups).toEqual([renamed, "产品部"]);
      expect(canUserAccessProvider(provider, user)).toBe(true);
      expect(canSeeMarketItem(item, user)).toBe(true);
      const rows = new Map(
        (await db.select().from(settings)).map((row) => [row.key, row.value]),
      );
      for (const key of keys) {
        expect(rows.get(key)).toEqual({
          month: "2026-09",
          items: [{ ...items[0], department: renamed }, items[1]],
        });
      }
      expect(rows.get("usage-account-month:2026-08")).toEqual({
        month: "2026-08",
        items: [],
      });
      expect(rows.get("unrelated")).toEqual({ items });
    } finally {
      await database.close();
    }
  },
);
