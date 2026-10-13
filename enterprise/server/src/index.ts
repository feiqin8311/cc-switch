import { join } from "node:path";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { startRetentionJobs } from "./retention/jobs.ts";
import { seedInitialAdmin } from "./seed.ts";
import { registerAdminStatic } from "./static.ts";

const config = loadConfig();
const database = await openDatabase({
  databaseUrl: config.databaseUrl,
  pgliteDataDir: join(config.dataDir, "pglite"),
});
const app = await buildApp(database.db, config);
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

const stopJobs = startRetentionJobs(database.db);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  stopJobs();
  await app.close();
  await database.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info(`Database: ${database.kind}`);
