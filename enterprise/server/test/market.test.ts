import { createHash } from "node:crypto";
import {
  ListMarketItemsResponseSchema,
  ListUsersResponseSchema,
  MarketItemSchema,
} from "@ccse/contracts";
import { strToU8, type Zippable, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { marketBlobs } from "../src/db/schema.ts";
import { seedBuiltinConnectors } from "../src/seed.ts";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let adminToken: string;
let memberToken: string;
let viewerToken: string;

async function createAndLogin(
  role: "member" | "viewer",
  username: string,
): Promise<string> {
  const password = `${username}-password-1`;
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: bearer(adminToken),
    payload: { username, displayName: username, password, role },
  });
  expect(res.statusCode).toBe(201);
  return (await login(ctx.app, username, password)).accessToken;
}

beforeEach(async () => {
  ctx = await setup();
  adminToken = (await login(ctx.app, ADMIN.username, ADMIN.password))
    .accessToken;
  memberToken = await createAndLogin("member", "mem");
  viewerToken = await createAndLogin("viewer", "view");
});
afterEach(async () => {
  await ctx.close();
});

const zip = (files: Record<string, string | Uint8Array>) => {
  const z: Zippable = {};
  for (const [name, content] of Object.entries(files)) {
    z[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return Buffer.from(zipSync(z));
};

const SKILL_MD = "---\nname: demo\ndescription: Demo skill\n---\nHello\n";

const pluginZip = (name: string, prefix = "") =>
  zip({
    [`${prefix}.codex-plugin/plugin.json`]: JSON.stringify({
      name,
      version: "1.0.0",
      skills: "./skills/",
    }),
    [`${prefix}skills/a/SKILL.md`]: SKILL_MD,
  });

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function upload(
  id: string,
  body: Buffer | string,
  opts: {
    kind?: string;
    version?: string;
    token?: string;
    contentType?: string;
    mandatory?: string;
  } = {},
) {
  const qs = new URLSearchParams({
    kind: opts.kind ?? "skill",
    name: `Item ${id}`,
    description: "desc",
    version: opts.version ?? "1.0.0",
    ...(opts.mandatory ? { mandatory: opts.mandatory } : {}),
  });
  return ctx.app.inject({
    method: "PUT",
    url: `/api/v1/admin/market/items/${id}?${qs}`,
    headers: {
      ...bearer(opts.token ?? adminToken),
      "content-type": opts.contentType ?? "application/zip",
    },
    payload: body,
  });
}

function memberUpload(
  id: string,
  body: Buffer | string,
  opts: { token?: string; version?: string; kind?: string } = {},
) {
  const qs = new URLSearchParams({
    kind: opts.kind ?? "skill",
    name: `Item ${id}`,
    description: "desc",
    version: opts.version ?? "1.0.0",
  });
  return ctx.app.inject({
    method: "PUT",
    url: `/api/v1/market/items/${id}?${qs}`,
    headers: {
      ...bearer(opts.token ?? memberToken),
      "content-type": "application/zip",
    },
    payload: body,
  });
}

const blobCount = async () => (await ctx.db.select().from(marketBlobs)).length;

describe("market upload validation", () => {
  it("accepts a skill at the zip root", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD, "scripts/run.sh": "echo hi" });
    const res = await upload("demo-skill", buf);
    expect(res.statusCode).toBe(200);
    const item = MarketItemSchema.parse(res.json());
    expect(item).toMatchObject({
      id: "demo-skill",
      kind: "skill",
      version: "1.0.0",
      mandatory: false,
      sha256: sha256(buf),
      sizeBytes: buf.length,
    });
  });

  it("accepts a skill inside a single top-level folder, ignoring macOS junk", async () => {
    const buf = zip({
      "demo/SKILL.md": SKILL_MD,
      "demo/ref/notes.md": "notes",
      "__MACOSX/demo/._SKILL.md": "x",
      ".DS_Store": "x",
    });
    expect((await upload("demo", buf)).statusCode).toBe(200);
  });

  it("accepts a plugin whose name matches the id", async () => {
    const res = await upload("my-plugin", pluginZip("my-plugin", "pkg/"), {
      kind: "plugin",
      mandatory: "true",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "plugin", mandatory: true });
  });

  it("rejects a plugin whose name differs from the id", async () => {
    const res = await upload("my-plugin", pluginZip("other"), {
      kind: "plugin",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("must equal the item id");
  });

  it("rejects packages missing their manifest", async () => {
    const noSkill = await upload("demo", zip({ "README.md": "x" }));
    expect(noSkill.statusCode).toBe(400);
    expect(noSkill.json().error.message).toContain("SKILL.md");

    const noPlugin = await upload("demo", zip({ "SKILL.md": SKILL_MD }), {
      kind: "plugin",
    });
    expect(noPlugin.statusCode).toBe(400);
    expect(noPlugin.json().error.message).toContain("plugin.json");

    // SKILL.md nested two levels deep does not count.
    const nested = await upload("demo", zip({ "a/b/SKILL.md": SKILL_MD }));
    expect(nested.statusCode).toBe(400);
  });

  it("rejects path traversal and absolute entries", async () => {
    for (const bad of ["../evil", "a/../../evil", "/etc/x", "C:/x"]) {
      const res = await upload(
        "demo",
        zip({ "SKILL.md": SKILL_MD, [bad]: "x" }),
      );
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.message, bad).toContain("unsafe entry path");
    }
  });

  it("rejects archives with too many entries", async () => {
    const files: Record<string, string> = { "SKILL.md": SKILL_MD };
    for (let i = 0; i < 5001; i++) files[`f/${i}.txt`] = "";
    const res = await upload("demo", zip(files));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("entries");
  });

  it("rejects bodies that are not zips or not a zip content type", async () => {
    expect((await upload("demo", Buffer.from("not a zip"))).statusCode).toBe(
      400,
    );
    const wrongType = await upload("demo", "{}", {
      contentType: "application/json",
    });
    expect([400, 415]).toContain(wrongType.statusCode);
    const other = await upload("demo", "x", { contentType: "text/plain" });
    expect([400, 415]).toContain(other.statusCode);
    expect(await blobCount()).toBe(0);
  });

  it("rejects bad ids and metadata", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD });
    expect((await upload("Bad_ID", buf)).statusCode).toBe(400);
    expect((await upload("demo", buf, { kind: "theme" })).statusCode).toBe(400);
  });

  it("rejects bodies larger than 20 MB with 413", async () => {
    const res = await upload("demo", Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("forbids members and viewers from uploading", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD });
    expect((await upload("demo", buf, { token: memberToken })).statusCode).toBe(
      403,
    );
    expect((await upload("demo", buf, { token: viewerToken })).statusCode).toBe(
      403,
    );
  });
});

describe("market listing, download and lifecycle", () => {
  it("lists items sorted by kind then name for members, not viewers", async () => {
    await upload("zeta", zip({ "SKILL.md": SKILL_MD }));
    await upload("alpha", zip({ "SKILL.md": `${SKILL_MD}!` }));
    await upload("my-plugin", pluginZip("my-plugin"), { kind: "plugin" });

    const res = await ctx.app.inject({
      url: "/api/v1/market/items",
      headers: bearer(memberToken),
    });
    expect(res.statusCode).toBe(200);
    const list = ListMarketItemsResponseSchema.parse(res.json());
    expect(list.items.map((i) => i.id)).toEqual(["my-plugin", "alpha", "zeta"]);
    expect(list.items.every((i) => i.publishedByName === "admin")).toBe(true);
    expect(list.items.every((i) => i.publishedBy !== null)).toBe(true);

    const admin = await ctx.app.inject({
      url: "/api/v1/market/items",
      headers: bearer(adminToken),
    });
    expect(admin.statusCode).toBe(200);

    const viewer = await ctx.app.inject({
      url: "/api/v1/market/items",
      headers: bearer(viewerToken),
    });
    expect(viewer.statusCode).toBe(403);
    const anon = await ctx.app.inject({ url: "/api/v1/market/items" });
    expect(anon.statusCode).toBe(401);
  });

  it("downloads identical bytes with a matching sha header", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD, "data.bin": new Uint8Array(4096) });
    await upload("demo", buf, { version: "2.0 beta/1" });

    const res = await ctx.app.inject({
      url: "/api/v1/market/items/demo/package",
      headers: bearer(memberToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(Buffer.compare(res.rawPayload, buf)).toBe(0);
    expect(res.headers["x-content-sha256"]).toBe(sha256(res.rawPayload));
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="demo-2.0_beta_1.zip"',
    );

    const missing = await ctx.app.inject({
      url: "/api/v1/market/items/nope/package",
      headers: bearer(memberToken),
    });
    expect(missing.statusCode).toBe(404);
    const viewer = await ctx.app.inject({
      url: "/api/v1/market/items/demo/package",
      headers: bearer(viewerToken),
    });
    expect(viewer.statusCode).toBe(403);
  });

  it("replaces a package and removes the orphaned blob", async () => {
    const v1 = zip({ "SKILL.md": SKILL_MD });
    const v2 = zip({ "SKILL.md": `${SKILL_MD}v2\n` });
    const first = MarketItemSchema.parse((await upload("demo", v1)).json());
    // A second item sharing the same bytes keeps the blob deduplicated.
    await upload("shared", v1);
    expect(await blobCount()).toBe(1);

    const second = await upload("demo", v2, { version: "2.0.0" });
    expect(second.statusCode).toBe(200);
    const item = MarketItemSchema.parse(second.json());
    expect(item.version).toBe("2.0.0");
    expect(item.sha256).toBe(sha256(v2));
    expect(item.sha256).not.toBe(first.sha256);
    // v1 still referenced by "shared".
    expect(await blobCount()).toBe(2);

    const third = await upload("shared", v2, { version: "2.0.0" });
    expect(third.statusCode).toBe(200);
    expect(await blobCount()).toBe(1);

    const dl = await ctx.app.inject({
      url: "/api/v1/market/items/demo/package",
      headers: bearer(adminToken),
    });
    expect(Buffer.compare(dl.rawPayload, v2)).toBe(0);
  });

  it("patches mandatory and metadata", async () => {
    await upload("demo", zip({ "SKILL.md": SKILL_MD }));
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/demo",
      headers: bearer(adminToken),
      payload: { mandatory: true, name: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(MarketItemSchema.parse(res.json())).toMatchObject({
      mandatory: true,
      name: "Renamed",
      version: "1.0.0",
    });

    const empty = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/demo",
      headers: bearer(adminToken),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const missing = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/nope",
      headers: bearer(adminToken),
      payload: { mandatory: true },
    });
    expect(missing.statusCode).toBe(404);
    const member = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/demo",
      headers: bearer(memberToken),
      payload: { mandatory: false },
    });
    expect(member.statusCode).toBe(403);
  });

  it("lets an admin reassign the publisher", async () => {
    await upload("demo", zip({ "SKILL.md": SKILL_MD }));
    const users = ListUsersResponseSchema.parse(
      (
        await ctx.app.inject({
          url: "/api/v1/admin/users",
          headers: bearer(adminToken),
        })
      ).json(),
    );
    const mem = users.items.find((u) => u.username === "mem");
    expect(mem).toBeDefined();

    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/demo",
      headers: bearer(adminToken),
      payload: { publishedBy: mem!.id },
    });
    expect(res.statusCode).toBe(200);
    expect(MarketItemSchema.parse(res.json())).toMatchObject({
      publishedBy: mem!.id,
      publishedByName: "mem",
    });

    const missing = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/demo",
      headers: bearer(adminToken),
      payload: { publishedBy: "00000000-0000-4000-8000-000000000000" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("bad_request");
  });

  it("deletes an item and its orphaned blob", async () => {
    await upload("demo", zip({ "SKILL.md": SKILL_MD }));
    expect(await blobCount()).toBe(1);

    const member = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/market/items/demo",
      headers: bearer(memberToken),
    });
    expect(member.statusCode).toBe(403);

    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/market/items/demo",
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(204);
    expect(await blobCount()).toBe(0);

    const again = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/market/items/demo",
      headers: bearer(adminToken),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe("mcp market items", () => {
  const STDIO = {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: { LOG_LEVEL: "info" },
  };

  const uploadJson = (id: string, def: unknown, opts = {}) =>
    upload(id, JSON.stringify(def, null, 2), {
      kind: "mcp",
      contentType: "application/json",
      ...opts,
    });

  it("publishes a stdio definition and serves it back as compact JSON", async () => {
    const res = await uploadJson("fs-mcp", STDIO, { version: "1.2 rc" });
    expect(res.statusCode).toBe(200);
    const compact = Buffer.from(JSON.stringify(STDIO));
    expect(MarketItemSchema.parse(res.json())).toMatchObject({
      id: "fs-mcp",
      kind: "mcp",
      version: "1.2 rc",
      sha256: sha256(compact),
      sizeBytes: compact.length,
    });

    const list = await ctx.app.inject({
      url: "/api/v1/market/items",
      headers: bearer(memberToken),
    });
    const items = ListMarketItemsResponseSchema.parse(list.json()).items;
    expect(items.find((i) => i.id === "fs-mcp")?.kind).toBe("mcp");

    const dl = await ctx.app.inject({
      url: "/api/v1/market/items/fs-mcp/package",
      headers: bearer(memberToken),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/json");
    expect(dl.headers["content-disposition"]).toBe(
      'attachment; filename="fs-mcp-1.2_rc.json"',
    );
    expect(dl.rawPayload.toString("utf8")).toBe(compact.toString("utf8"));
    expect(dl.headers["x-content-sha256"]).toBe(sha256(dl.rawPayload));
  });

  it("accepts http and sse definitions", async () => {
    const http = await uploadJson("remote", {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Team": "core" },
    });
    expect(http.statusCode).toBe(200);
    const sse = await uploadJson("remote-sse", {
      type: "sse",
      url: "http://10.0.0.5:8080/sse",
    });
    expect(sse.statusCode).toBe(200);
  });

  it("rejects invalid definitions with 400 details", async () => {
    const bad: unknown[] = [
      { type: "stdio", args: ["x"] },
      { type: "stdio", command: "npx", extra: true },
      { type: "http", url: "ftp://example.com/mcp" },
      { type: "websocket", url: "https://example.com" },
      ["not", "an", "object"],
    ];
    for (const def of bad) {
      const res = await uploadJson("demo", def);
      expect(res.statusCode, JSON.stringify(def)).toBe(400);
      expect(res.json().error.code).toBe("bad_request");
      expect(Array.isArray(res.json().error.details)).toBe(true);
    }
    const malformed = await upload("demo", "{not json", {
      kind: "mcp",
      contentType: "application/json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(await blobCount()).toBe(0);
  });

  it("rejects a body that does not match the kind", async () => {
    const zipped = await upload("demo", zip({ "SKILL.md": SKILL_MD }), {
      kind: "mcp",
    });
    expect(zipped.statusCode).toBe(400);
    expect(zipped.json().error.message).toContain("application/json");

    const asSkill = await uploadJson("demo", STDIO, { kind: "skill" });
    expect([400, 415]).toContain(asSkill.statusCode);
    expect(await blobCount()).toBe(0);
  });

  it("rejects oversized definitions with 413", async () => {
    const big = {
      type: "stdio",
      command: "node",
      args: Array.from({ length: 20 }, () => "x".repeat(4000)),
    };
    const res = await uploadJson("demo", big);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");

    // Above the raw JSON body cap (4 × the largest JSON-kind limit = 1 MB).
    const huge = await upload("demo", `"${"x".repeat(1100 * 1024)}"`, {
      kind: "mcp",
      contentType: "application/json",
    });
    expect(huge.statusCode).toBe(413);
    expect(await blobCount()).toBe(0);
  });

  it("can be made mandatory via PATCH", async () => {
    await uploadJson("fs-mcp", STDIO);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/fs-mcp",
      headers: bearer(adminToken),
      payload: { mandatory: true },
    });
    expect(res.statusCode).toBe(200);
    expect(MarketItemSchema.parse(res.json())).toMatchObject({
      kind: "mcp",
      mandatory: true,
    });
  });
});

describe("connector market items", () => {
  const DWS = { type: "dws" };

  it("seeds the built-in DingTalk connector once", async () => {
    expect(await seedBuiltinConnectors(ctx.db)).toBe(true);
    expect(await seedBuiltinConnectors(ctx.db)).toBe(false);
    const list = await ctx.app.inject({
      url: "/api/v1/market/items",
      headers: bearer(memberToken),
    });
    const items = ListMarketItemsResponseSchema.parse(list.json()).items;
    expect(items.find((i) => i.id === "dws")).toMatchObject({
      kind: "connector",
      name: "钉钉 Workspace CLI",
    });
  });

  it("publishes a dws definition as compact JSON", async () => {
    const res = await upload("dws", JSON.stringify(DWS, null, 2), {
      kind: "connector",
      contentType: "application/json",
    });
    expect(res.statusCode).toBe(200);
    const compact = Buffer.from(JSON.stringify(DWS));
    expect(MarketItemSchema.parse(res.json())).toMatchObject({
      id: "dws",
      kind: "connector",
      sha256: sha256(compact),
    });
  });

  it("rejects unknown connector types", async () => {
    const res = await upload("feishu", JSON.stringify({ type: "feishu" }), {
      kind: "connector",
      contentType: "application/json",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("prompt market items", () => {
  const PROMPT = {
    content: "# Team rules\n\n- Write tests.\n- 用中文回复。\n",
  };

  const uploadJson = (id: string, def: unknown, opts = {}) =>
    upload(id, JSON.stringify(def, null, 2), {
      kind: "prompt",
      contentType: "application/json",
      ...opts,
    });

  it("publishes a prompt and serves it back as compact JSON", async () => {
    const res = await uploadJson("team-rules", PROMPT, { version: "2.0 beta" });
    expect(res.statusCode).toBe(200);
    const compact = Buffer.from(JSON.stringify(PROMPT));
    expect(MarketItemSchema.parse(res.json())).toMatchObject({
      id: "team-rules",
      kind: "prompt",
      version: "2.0 beta",
      sha256: sha256(compact),
      sizeBytes: compact.length,
    });

    const list = await ctx.app.inject({
      url: "/api/v1/market/items",
      headers: bearer(memberToken),
    });
    const items = ListMarketItemsResponseSchema.parse(list.json()).items;
    expect(items.find((i) => i.id === "team-rules")?.kind).toBe("prompt");

    const dl = await ctx.app.inject({
      url: "/api/v1/market/items/team-rules/package",
      headers: bearer(memberToken),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/json");
    expect(dl.headers["content-disposition"]).toBe(
      'attachment; filename="team-rules-2.0_beta.json"',
    );
    expect(dl.rawPayload.toString("utf8")).toBe(compact.toString("utf8"));
    expect(dl.headers["x-content-sha256"]).toBe(sha256(dl.rawPayload));
  });

  it("rejects invalid definitions with 400 details", async () => {
    const bad: unknown[] = [
      { content: "" },
      { content: "  \n\t " },
      { content: "hi", extra: true },
      {},
      { content: 42 },
      ["not", "an", "object"],
    ];
    for (const def of bad) {
      const res = await uploadJson("demo", def);
      expect(res.statusCode, JSON.stringify(def)).toBe(400);
      expect(res.json().error.code).toBe("bad_request");
      expect(Array.isArray(res.json().error.details)).toBe(true);
    }
    const malformed = await upload("demo", "{not json", {
      kind: "prompt",
      contentType: "application/json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(await blobCount()).toBe(0);
  });

  it("rejects a zip body", async () => {
    const zipped = await upload("demo", zip({ "SKILL.md": SKILL_MD }), {
      kind: "prompt",
    });
    expect(zipped.statusCode).toBe(400);
    expect(zipped.json().error.message).toBe(
      "kind prompt expects application/json",
    );
    expect(await blobCount()).toBe(0);
  });

  it("accepts prompts larger than the MCP limit", async () => {
    const res = await uploadJson("big", { content: "x".repeat(200 * 1024) });
    expect(res.statusCode).toBe(200);
  });

  it("rejects prompts over 256 KB with 413", async () => {
    const res = await uploadJson("demo", {
      content: "x".repeat(256 * 1024),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");

    const huge = await uploadJson("demo", {
      content: "x".repeat(1100 * 1024),
    });
    expect(huge.statusCode).toBe(413);
    expect(await blobCount()).toBe(0);
  });

  it("can be made mandatory via PATCH", async () => {
    await uploadJson("team-rules", PROMPT);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/team-rules",
      headers: bearer(adminToken),
      payload: { mandatory: true },
    });
    expect(res.statusCode).toBe(200);
    expect(MarketItemSchema.parse(res.json())).toMatchObject({
      kind: "prompt",
      mandatory: true,
    });
  });
});

describe("member skill publish", () => {
  it("lets a member create and replace their own skill", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD });
    const created = await memberUpload("team-skill", buf);
    expect(created.statusCode).toBe(200);
    expect(MarketItemSchema.parse(created.json())).toMatchObject({
      id: "team-skill",
      kind: "skill",
      mandatory: false,
      publishedByName: "mem",
    });

    const again = await memberUpload("team-skill", buf, { version: "1.0.1" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ version: "1.0.1", mandatory: false });
  });

  it("blocks another member from replacing, and a viewer from publishing", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD });
    expect((await memberUpload("owned", buf)).statusCode).toBe(200);

    const other = await createAndLogin("member", "mem2");
    const stolen = await memberUpload("owned", buf, { token: other });
    expect(stolen.statusCode).toBe(403);

    expect((await memberUpload("v", buf, { token: viewerToken })).statusCode).toBe(
      403,
    );
  });

  it("lets an admin replace a member skill via the same route", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD });
    expect((await memberUpload("shared", buf)).statusCode).toBe(200);
    const res = await memberUpload("shared", buf, { token: adminToken });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ publishedByName: "mem" });
  });

  it("rejects a plugin kind and an id that already holds a plugin", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD });
    expect(
      (await memberUpload("x", buf, { kind: "plugin" })).statusCode,
    ).toBe(400);

    await upload("plug", pluginZip("plug"), { kind: "plugin" });
    const clash = await memberUpload("plug", buf);
    expect(clash.statusCode).toBe(409);
  });
});

describe("market visibility", () => {
  it("shows a restricted skill only to the chosen person or group", async () => {
    const buf = zip({ "SKILL.md": SKILL_MD });
    expect((await upload("secret-skill", buf)).statusCode).toBe(200);

    const users = ListUsersResponseSchema.parse(
      (
        await ctx.app.inject({
          url: "/api/v1/admin/users",
          headers: bearer(adminToken),
        })
      ).json(),
    ).items;
    const mem = users.find((u) => u.username === "mem");
    if (!mem) throw new Error("missing member");

    const otherToken = await createAndLogin("member", "other");
    const hidden = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/market/items/secret-skill",
      headers: bearer(adminToken),
      payload: { visibleUserIds: [mem.id], visibleGroups: [] },
    });
    expect(hidden.statusCode).toBe(200);
    expect(MarketItemSchema.parse(hidden.json()).visibleUserIds).toEqual([
      mem.id,
    ]);

    const seenBy = async (token: string) =>
      ListMarketItemsResponseSchema.parse(
        (
          await ctx.app.inject({
            url: "/api/v1/market/items",
            headers: bearer(token),
          })
        ).json(),
      ).items.map((i) => i.id);

    expect(await seenBy(memberToken)).toContain("secret-skill");
    expect(await seenBy(otherToken)).not.toContain("secret-skill");
    expect(await seenBy(adminToken)).toContain("secret-skill");

    const denied = await ctx.app.inject({
      url: "/api/v1/market/items/secret-skill/package",
      headers: bearer(otherToken),
    });
    expect(denied.statusCode).toBe(404);

    const others = ListUsersResponseSchema.parse(
      (
        await ctx.app.inject({
          url: "/api/v1/admin/users",
          headers: bearer(adminToken),
        })
      ).json(),
    ).items.find((u) => u.username === "other");
    if (!others) throw new Error("missing other");
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url: `/api/v1/admin/users/${others.id}`,
          headers: bearer(adminToken),
          payload: { groupName: "Libraton组" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url: "/api/v1/admin/market/items/secret-skill",
          headers: bearer(adminToken),
          payload: { visibleUserIds: [], visibleGroups: ["Libraton组"] },
        })
      ).statusCode,
    ).toBe(200);
    expect(await seenBy(otherToken)).toContain("secret-skill");
    expect(await seenBy(memberToken)).not.toContain("secret-skill");
  });
});
