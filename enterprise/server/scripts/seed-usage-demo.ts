import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inArray, sql } from "drizzle-orm";
import { hashPassword } from "../src/auth/password.ts";
import { openDatabase } from "../src/db/client.ts";
import { usageRecords, users } from "../src/db/schema.ts";

// Only this local PGlite database is used; DATABASE_URL and upstream APIs are ignored.
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "Demo usage may only be seeded in a local development database.",
  );
}
const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    days: { type: "string", default: "45" },
    to: { type: "string", default: new Date().toISOString().slice(0, 10) },
  },
});
const days = Number(values.days);
const to = new Date(`${values.to}T00:00:00Z`);
if (!Number.isInteger(days) || days < 1 || days > 92) {
  throw new Error("--days must be an integer from 1 to 92.");
}
if (
  !Number.isFinite(to.getTime()) ||
  to.toISOString().slice(0, 10) !== values.to
) {
  throw new Error("--to must be a valid YYYY-MM-DD UTC date.");
}
const serverDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = resolve(serverDir, values["data-dir"] ?? "data");
if (!existsSync(resolve(dataDir, "pglite", "PG_VERSION"))) {
  throw new Error(
    `No initialized local database at ${dataDir}; start the API once first.`,
  );
}

const departments = [
  "测试·产品部",
  "测试·运营部-LIBRATON",
  "测试·运营部-EZARC",
  "测试·运营部-YPLUS",
  "测试·技术部&独立站&TK",
  "测试·设计部",
  "测试·人力资源与行政部",
  "测试·客户成功与海外业务拓展部",
  "",
];
const models = [
  ["demo-openai", "gpt-6-luna"],
  ["demo-openai", "gpt-5.6-terra"],
  ["demo-openai", "gpt-6.1-sol"],
  ["demo-backup", "gpt-6-luna"],
  ["demo-backup", "gpt-5.6-terra"],
  ["demo-backup", "gpt-6.1-sol"],
  ["demo-claude", "claude-sonnet-4-6"],
  ["demo-claude", "claude-opus-4-6"],
  ["demo-mixed", "deepseek-v4-flash"],
  ["demo-mixed", "deepseek-v4-pro"],
  ["demo-mixed", "gemini-2.5-pro"],
  ["demo-mixed", "demo-unpriced-model"],
] as const;
function demoId(key: string) {
  const hex = createHash("sha256")
    .update(`ccse-demo-usage-v1:${key}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const database = await openDatabase({
  pgliteDataDir: resolve(dataDir, "pglite"),
});
try {
  const passwordHash = await hashPassword(
    randomBytes(32).toString("base64url"),
  );
  const members = departments.flatMap((groupName, department) =>
    Array.from({ length: 4 }, (_, member) => {
      const index = department * 4 + member;
      return {
        id: demoId(`user:${index}`),
        username: `demo_usage_${String(index + 1).padStart(2, "0")}`,
        displayName: `测试成员${String(index + 1).padStart(2, "0")}`,
        groupName,
        passwordHash,
        role: "member" as const,
        adminMenus: [],
      };
    }),
  );
  const records: (typeof usageRecords.$inferInsert)[] = [];
  for (let day = 0; day < days; day++) {
    const date = new Date(to.getTime() - day * 86_400_000);
    const dateKey = date.toISOString().slice(0, 10);
    for (const [member, user] of members.entries()) {
      for (let sample = 0; sample < 4; sample++) {
        const selectedModel =
          models[(member + day + sample * 3) % models.length];
        if (!selectedModel)
          throw new Error("Missing demo model configuration.");
        const [providerId, model] = selectedModel;
        const variation = (member * 17 + day * 11 + sample * 7) % 19;
        const scale = member % 11 === 0 ? 1 : ((member % 7) + 1) * 100;
        const inputTokens = (500 + variation * 97) * scale;
        const outputTokens =
          sample === 0 && member % 5 === 0 ? 0 : (25 + variation * 13) * scale;
        const legacy = (member + day + sample) % 17 === 0;
        records.push({
          id: demoId(`request:${user.id}:${dateKey}:${sample}`),
          userId: user.id,
          providerId,
          model,
          inputTokens,
          outputTokens,
          cachedTokens: Math.floor(inputTokens * (sample % 2 ? 0.65 : 0.1)),
          cacheCreationTokens: legacy ? null : Math.floor(inputTokens * 0.08),
          pricingModel: legacy
            ? null
            : day % 13 === 0 && sample === 2
              ? "demo-unpriced-model"
              : model,
          status: 200,
          latencyMs: 120 + variation * 240,
          // Completed requests on the current UTC date, including the near-24h preset.
          createdAt: new Date(
            date.getTime() + (sample * 12 + (member % 12)) * 60_000,
          ),
        });
      }
    }
  }
  const result = await database.db.transaction(async (tx) => {
    const insertedUsers = await tx
      .insert(users)
      .values(members)
      .onConflictDoNothing()
      .returning({ id: users.id });
    const knownMembers = await tx
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(
        inArray(
          users.id,
          members.map((member) => member.id),
        ),
      );
    if (
      knownMembers.length !== members.length ||
      knownMembers.some(
        (member) =>
          !members.some(
            (expected) =>
              expected.id === member.id &&
              expected.username === member.username,
          ),
      )
    ) {
      throw new Error("Demo user identity conflict; no usage was imported.");
    }
    let insertedRequests = 0;
    for (let offset = 0; offset < records.length; offset += 250) {
      const inserted = await tx
        .insert(usageRecords)
        .values(records.slice(offset, offset + 250))
        .onConflictDoNothing()
        .returning({ id: usageRecords.id });
      insertedRequests += inserted.length;
    }
    const totals = await tx
      .select({ requests: sql<number>`count(*)::int` })
      .from(usageRecords)
      .where(
        inArray(
          usageRecords.userId,
          members.map((member) => member.id),
        ),
      );
    return {
      insertedUsers: insertedUsers.length,
      insertedRequests,
      totalDemoRequests: totals[0]?.requests ?? 0,
    };
  });
  console.log(
    JSON.stringify(
      {
        dataDir,
        from: new Date(to.getTime() - (days - 1) * 86_400_000)
          .toISOString()
          .slice(0, 10),
        to: values.to,
        departments: departments.length - 1,
        ungroupedUsers: 4,
        users: members.length,
        providers: new Set(models.map(([provider]) => provider)).size,
        modelSeries: models.length,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
