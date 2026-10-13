import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAdminStatic } from "../src/static.ts";
import { setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let dist: string;

beforeEach(async () => {
  dist = mkdtempSync(join(tmpdir(), "ccse-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<html>admin</html>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  ctx = await setup();
  expect(registerAdminStatic(ctx.app, dist)).toBe(true);
});
afterEach(async () => {
  await ctx.close();
  rmSync(dist, { recursive: true, force: true });
});

describe("admin static", () => {
  it("serves assets with long cache and index for SPA routes", async () => {
    const asset = await ctx.app.inject({ url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");

    const page = await ctx.app.inject({ url: "/users/123" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe("<html>admin</html>");
    expect(page.headers["cache-control"]).toBe("no-cache");
  });

  it("does not escape the dist directory", async () => {
    const res = await ctx.app.inject({ url: "/..%2f..%2fetc%2fpasswd" });
    expect(res.body).toBe("<html>admin</html>");
  });

  it("keeps JSON 404s for API and gateway paths", async () => {
    for (const url of ["/api/v1/nope", "/gateway/x/v1/nope"]) {
      const res = await ctx.app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("is skipped when the build is missing", async () => {
    expect(registerAdminStatic(ctx.app, join(dist, "missing"))).toBe(false);
  });
});
