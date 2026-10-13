import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";

/** Bundle filenames only. Rejects `..`, slashes and empty names. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

/**
 * Public updater files. The desktop client fetches `/updates/latest.json`
 * (Tauri's static manifest). Missing manifest is 204, which the client treats
 * as "no update". Artifacts live beside the manifest as `/updates/files/:name`.
 */
export function registerUpdates(app: FastifyInstance, updatesDir: string): void {
  const root = resolve(updatesDir);

  app.get("/updates/latest.json", async (_req, reply) => {
    const file = join(root, "latest.json");
    if (!existsSync(file)) return reply.code(204).send();
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(await readFile(file));
  });

  app.get<{ Params: { name: string } }>(
    "/updates/files/:name",
    async (req, reply) => {
      const { name } = req.params;
      if (!SAFE_NAME.test(name)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const file = join(root, name);
      if (!file.startsWith(`${root}${sep}`) || !existsSync(file)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const type = name.endsWith(".json")
        ? "application/json"
        : name.endsWith(".gz")
          ? "application/gzip"
          : "application/octet-stream";
      return reply
        .header("content-type", type)
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(createReadStream(file));
    },
  );
}
