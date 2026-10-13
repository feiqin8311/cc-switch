import type { SessionResponse } from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { type AppConfig, loadConfig } from "../src/config.ts";
import { type Db, openDatabase } from "../src/db/client.ts";
import { seedInitialAdmin } from "../src/seed.ts";

export const ADMIN = { username: "admin", password: "admin-password-123" };

export interface TestContext {
  app: FastifyInstance;
  config: AppConfig;
  db: Db;
  close(): Promise<void>;
}

export async function setup(
  extra: NodeJS.ProcessEnv = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret-test-secret-test-secret-123",
    SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_USERNAME: ADMIN.username,
    ADMIN_PASSWORD: ADMIN.password,
    ...extra,
  });
  const database = await openDatabase({ pgliteDataDir: "memory://" });
  await seedInitialAdmin(database.db, config);
  const app = await buildApp(database.db, config);
  return {
    app,
    config,
    db: database.db,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

export async function login(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<SessionResponse> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  }
  return res.json();
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
