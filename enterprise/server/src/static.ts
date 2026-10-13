import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { API_PREFIX, GATEWAY_PREFIX } from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import { notFound } from "./errors.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves the admin console build (single-page app) at "/". Unknown paths fall
 * back to index.html; API and gateway paths keep their JSON 404s.
 */
export function registerAdminStatic(
  app: FastifyInstance,
  distDir: string,
): boolean {
  const root = resolve(distDir);
  const indexFile = join(root, "index.html");
  if (!existsSync(indexFile)) return false;

  app.get("/*", async (req, reply) => {
    const path = decodeURIComponent(req.url.split("?")[0] ?? "/");
    if (
      path.startsWith(API_PREFIX) ||
      path.startsWith(GATEWAY_PREFIX) ||
      path === "/updates" ||
      path.startsWith("/updates/")
    ) {
      throw notFound("Route not found");
    }

    const candidate = normalize(join(root, path));
    let file = indexFile;
    if (candidate.startsWith(root + sep)) {
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) file = candidate;
    }

    const isAsset = file !== indexFile && path.startsWith("/assets/");
    return reply
      .header(
        "content-type",
        CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      )
      .header(
        "cache-control",
        isAsset ? "public, max-age=31536000, immutable" : "no-cache",
      )
      .header("x-content-type-options", "nosniff")
      .send(await readFile(file));
  });
  return true;
}
