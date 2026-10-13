import { createHash } from "node:crypto";
import {
  ListMarketItemsResponseSchema,
  MarketItemSchema,
} from "@ccse/contracts";
import { strToU8, type Zippable, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { marketBlobs } from "../src/db/schema.ts";
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
