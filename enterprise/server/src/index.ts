import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { seedBuiltinConnectors, seedInitialAdmin } from "./seed.ts";
import { registerAdminStatic } from "./static.ts";

// Resolve independently of the shell's working directory; OS/Docker env wins.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
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
if (await seedBuiltinConnectors(database.db)) {
  app.log.info('Seeded built-in connector "钉钉 Workspace CLI" (dws)');
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await database.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info(`Database: ${database.kind}`);
