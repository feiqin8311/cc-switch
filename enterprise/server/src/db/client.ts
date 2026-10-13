import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema.ts";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  kind: "postgres" | "pglite";
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export interface OpenDatabaseOptions {
  /** postgres:// URL. When absent an embedded PGlite database is used. */
  databaseUrl?: string;
  /** PGlite data directory, or "memory://" for an in-memory database. */
  pgliteDataDir?: string;
}

/** Opens the database and applies pending migrations. */
export async function openDatabase(
  opts: OpenDatabaseOptions,
): Promise<Database> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder });
    return { db, kind: "postgres", close: () => pool.end() };
  }

  const dataDir = opts.pgliteDataDir ?? "memory://";
  if (!dataDir.startsWith("memory://")) {
    mkdirSync(dataDir, { recursive: true });
  }
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db, kind: "pglite", close: () => client.close() };
}
