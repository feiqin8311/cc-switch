import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDatabase } from "../src/db/client.ts";

test("a persistent database has one owner and survives a clean close/reopen", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ccse-db-lifecycle-"));
  let database;
  try {
    database = await openDatabase({ pgliteDataDir: dataDir });
    await database.db.execute(sql`create table lifecycle_probe (value text)`);
    await database.db.execute(
      sql`insert into lifecycle_probe values ('preserved')`,
    );
    await expect(openDatabase({ pgliteDataDir: dataDir })).rejects.toThrow(
      "Database is already open in another process",
    );
    await Promise.all([database.close(), database.close()]);
    database = await openDatabase({ pgliteDataDir: dataDir });
    const result = await database.db
      .select({ value: sql<string>`value` })
      .from(sql`lifecycle_probe`);
    expect(result).toEqual([{ value: "preserved" }]);
  } finally {
    await database?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
