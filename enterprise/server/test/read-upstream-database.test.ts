import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryUpstreamUsage } from "../src/usage/read-upstream-database.ts";

let db: PGlite;
beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(`
    CREATE TABLE api_keys (id bigint PRIMARY KEY, name text);
    CREATE TABLE groups (id bigint PRIMARY KEY, name text);
    CREATE TABLE accounts (id bigint PRIMARY KEY, name text);
    CREATE TABLE usage_logs (
      api_key_id bigint, group_id bigint, account_id bigint, model text,
      created_at timestamptz, input_tokens int, output_tokens int,
      cache_read_tokens int, cache_creation_tokens int, actual_cost numeric,
      image_count int, image_input_tokens int, image_output_tokens int
    );
    INSERT INTO api_keys VALUES (1, 'key-1'), (2, 'key-2');
    INSERT INTO groups VALUES (1, 'group-a'), (2, 'group-b');
    INSERT INTO accounts VALUES (1, 'account-a');
    INSERT INTO usage_logs VALUES
      (1, 1, 1, 'gpt-5', '2026-11-06T00:00:00Z', 80, 10, 20, 5, 0.12, 0, 0, 0),
      (1, 1, 1, 'gpt-5', '2026-11-06T23:59:59Z', 10, 5, 2, 0, 0, 0, 0, 0),
      (2, 2, 1, 'gpt-5', '2026-11-06T12:00:00Z', 20, 1, 0, 0, 0.02, 0, 0, 0),
      (1, 1, 1, 'gpt-5', '2026-11-07T00:00:00Z', 40, 2, 0, 0, 0.03, 0, 0, 0);
  `);
});
afterEach(async () => db.close());

describe("API Hub database aggregation", () => {
  const from = new Date("2026-11-06T00:00:00Z");
  const to = new Date("2026-11-07T00:00:00Z");

  it("aggregates the selected UTC day without losing cache tokens", async () => {
    const rows = await queryUpstreamUsage(db, from, to, null);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.username === "key-1")).toMatchObject({
      date: "2026-11-06",
      groupName: "group-a",
      providerId: "account-a",
      requests: 2,
      inputTokens: 117,
      outputTokens: 15,
      cachedTokens: 22,
      cacheCreationTokens: 5,
      estimatedCostUsd: 0.12,
      actualRequests: 2,
    });
    const next = await queryUpstreamUsage(
      db,
      to,
      new Date("2026-11-08T00:00:00Z"),
      null,
    );
    expect(next).toMatchObject([{ date: "2026-11-07", requests: 1 }]);
  });

  it("restricts group leaders in the database and rejects empty groups", async () => {
    expect(await queryUpstreamUsage(db, from, to, "group-a")).toMatchObject([
      { groupName: "group-a", requests: 2 },
    ]);
    expect(await queryUpstreamUsage(db, from, to, " ")).toEqual([]);
    expect(await queryUpstreamUsage(db, from, to, "missing")).toEqual([]);
  });

  it("preserves missing cost and image pricing behavior", async () => {
    await db.exec(`INSERT INTO usage_logs VALUES
      (1, 1, 1, 'unknown-model', '2026-11-06T10:00:00Z', 3, 4, 0, 0, NULL, 0, 0, 0),
      (1, 1, 1, 'gpt-5', '2026-11-06T10:00:00Z', 3, 4, 0, 0, NULL, 1, 0, 0)`);
    const rows = await queryUpstreamUsage(db, from, to, "group-a");
    expect(rows.find((row) => row.model === "unknown-model")).toMatchObject({
      estimatedCostUsd: null,
      actualRequests: 0,
      unpricedRequests: 1,
    });
    expect(rows.find((row) => row.model === "gpt-5")).toMatchObject({
      actualRequests: 2,
      unpricedRequests: 1,
    });
  });
});
