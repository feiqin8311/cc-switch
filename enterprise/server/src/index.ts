import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase, type Database } from "./db/client.ts";
import { seedBuiltinConnectors, seedInitialAdmin } from "./seed.ts";
import { registerAdminStatic } from "./static.ts";

// Resolve independently of the shell's working directory; OS/Docker env wins.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
let database: Database | undefined;
let app: FastifyInstance | undefined;
let stopping = false;

async function closeResources() {
  try {
    await app?.close();
  } finally {
    await database?.close();
  }
}

async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log(
    `[enterprise-api] ${reason}: closing HTTP server and database...`,
  );
  try {
    await startup.catch(() => {});
    await closeResources();
    process.exit(0);
  } catch (error) {
    console.error("Enterprise API shutdown failed:", error);
    process.exit(1);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
// IPC works on Windows, where child.kill() would forcibly terminate Node.
process.on("message", (message) => {
  if (message === "shutdown") void shutdown("development launcher shutdown");
});
process.once(
  "disconnect",
  () => void shutdown("development launcher disconnected"),
);

async function start() {
  database = await openDatabase({
    databaseUrl: config.databaseUrl,
    pgliteDataDir: join(config.dataDir, "pglite"),
  });
  if (stopping) return;
  app = await buildApp(database.db, config);
  if (!registerAdminStatic(app, config.adminDistDir)) {
    app.log.warn(
      `Admin console not found at ${config.adminDistDir}; build it with \`pnpm --filter @ccse/admin build\``,
    );
  }

  const seed = await seedInitialAdmin(database.db, config);
  if (seed.created) {
    app.log.info(
      seed.passwordFile
        ? `Created admin "${config.admin.username}"; password written to ${seed.passwordFile}`
        : `Created admin "${config.admin.username}" from ADMIN_PASSWORD`,
    );
  }
  if (await seedBuiltinConnectors(database.db)) {
    app.log.info('Seeded built-in connector "钉钉 Workspace CLI" (dws)');
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Database: ${database.kind}`);
}

const startup = start();
startup.catch(async (error) => {
  console.error("Enterprise API failed to start:", error);
  if (stopping) return;
  stopping = true;
  try {
    await closeResources();
  } finally {
    process.exit(1);
  }
});
