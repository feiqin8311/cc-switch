import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ccse-updates-"));
  ctx = await setup({ DATA_DIR: dataDir });
});
afterEach(async () => {
  await ctx.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("desktop updates", () => {
  it("answers 204 when no manifest has been published", async () => {
    const res = await ctx.app.inject({ url: "/updates/latest.json" });
    expect(res.statusCode).toBe(204);
  });

  it("serves the manifest and a bundle file", async () => {
    const dir = join(dataDir, "updates");
    mkdirSync(dir);
    writeFileSync(join(dir, "latest.json"), '{"version":"9.9.9"}\n');
    writeFileSync(join(dir, "app.tar.gz"), "bundle");

    const manifest = await ctx.app.inject({ url: "/updates/latest.json" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["cache-control"]).toBe("no-cache");
    expect(manifest.json()).toEqual({ version: "9.9.9" });

    const file = await ctx.app.inject({ url: "/updates/files/app.tar.gz" });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe("bundle");
  });

  it("rejects names that leave the updates directory", async () => {
    const res = await ctx.app.inject({ url: "/updates/files/..%2Fsecret" });
    expect(res.statusCode).toBe(404);
  });
});
