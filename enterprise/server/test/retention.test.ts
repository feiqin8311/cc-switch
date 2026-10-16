import {
  ConversationDetailResponseSchema,
  type ConversationUpload,
  ListConversationsResponseSchema,
  type RetainedMessage,
  RetentionUploadResponseSchema,
} from "@ccse/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let adminToken: string;

beforeEach(async () => {
  ctx = await setup();
  adminToken = (await login(ctx.app, ADMIN.username, ADMIN.password))
    .accessToken;
});
afterEach(async () => {
  await ctx.close();
});

async function createMember(username: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: bearer(adminToken),
    payload: {
      username,
      displayName: username.toUpperCase(),
      password: `${username}-password-1`,
      role: "member",
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function loginMember(username: string, deviceName?: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: `${username}-password-1`, deviceName },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

async function putPolicy(
  token: string,
  policy: Record<string, unknown> = { enabled: true },
) {
  return ctx.app.inject({
    method: "PUT",
    url: "/api/v1/admin/retention-policy",
    headers: bearer(token),
    payload: policy,
  });
}

function msg(
  seq: number,
  over: Partial<RetainedMessage> = {},
): RetainedMessage {
  return {
    seq,
    role: seq % 2 === 0 ? "user" : "assistant",
    kind: "message",
    content: `message ${seq}`,
    toolName: null,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
    model: seq % 2 === 0 ? null : "gpt-5",
    inputTokens: null,
    outputTokens: null,
    ...over,
  };
}

function conv(
  clientSessionId: string,
  messages: RetainedMessage[],
  over: Partial<ConversationUpload> = {},
): ConversationUpload {
  return {
    clientSessionId,
    title: "Fix the build",
    projectDir: "/work/app",
    startedAt: "2026-01-01T00:00:00.000Z",
    messages,
    ...over,
  };
}

async function upload(token: string, items: ConversationUpload[]) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/retention/conversations",
    headers: bearer(token),
    payload: { items },
  });
}

async function list(query = "", token = adminToken) {
  const res = await ctx.app.inject({
    url: `/api/v1/admin/conversations${query}`,
    headers: bearer(token),
  });
  return res;
}

async function listOk(query = "") {
  const res = await list(query);
  expect(res.statusCode).toBe(200);
  return ListConversationsResponseSchema.parse(res.json());
}

describe("retention policy", () => {
  it("defaults to disabled and is admin-only to read and write", async () => {
    await createMember("alice");
    const member = await loginMember("alice");

    const initial = await ctx.app.inject({
      url: "/api/v1/admin/retention-policy",
      headers: bearer(adminToken),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ enabled: false });

    expect((await putPolicy(member)).statusCode).toBe(403);
    const memberGet = await ctx.app.inject({
      url: "/api/v1/admin/retention-policy",
      headers: bearer(member),
    });
    expect(memberGet.statusCode).toBe(403);

    const bad = await putPolicy(adminToken, { enabled: "yes" });
    expect(bad.statusCode).toBe(400);

    const put = await putPolicy(adminToken);
    expect(put.statusCode).toBe(200);
    // Upsert: a second PUT replaces the stored value. Fields from older
    // admin consoles (noticeText / retentionDays) are accepted and dropped.
    await putPolicy(adminToken, {
      enabled: true,
      noticeText: "Updated notice",
      retentionDays: 90,
    });
    const after = await ctx.app.inject({
      url: "/api/v1/admin/retention-policy",
      headers: bearer(adminToken),
    });
    expect(after.json()).toEqual({ enabled: true });

    const cfg = await ctx.app.inject({
      url: "/api/v1/client/config",
      headers: bearer(member),
    });
    expect(cfg.statusCode).toBe(200);
    // noticeText stays for desktop builds that still require it.
    expect(cfg.json().retention).toEqual({ enabled: true, noticeText: "" });
  });
});

describe("conversation upload", () => {
  it("is forbidden while the policy is disabled and requires auth", async () => {
    await createMember("alice");
    const member = await loginMember("alice");
    const res = await upload(member, [conv("s1", [msg(0)])]);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");

    await putPolicy(adminToken);
    const anon = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/retention/conversations",
      payload: { items: [conv("s1", [msg(0)])] },
    });
    expect(anon.statusCode).toBe(401);

    const invalid = await upload(member, []);
    expect(invalid.statusCode).toBe(400);
  });

  it("stores conversations idempotently and appends incrementally", async () => {
    const aliceId = await createMember("alice");
    const member = await loginMember("alice", "Alice-MacBook");
    await putPolicy(adminToken);

    const first = await upload(member, [
      conv(
        "s1",
        [0, 1, 2].map((i) => msg(i)),
      ),
    ]);
    expect(first.statusCode).toBe(200);
    expect(RetentionUploadResponseSchema.parse(first.json())).toEqual({
      accepted: 3,
      duplicates: 0,
    });

    const again = await upload(member, [
      conv(
        "s1",
        [0, 1, 2].map((i) => msg(i)),
      ),
    ]);
    expect(again.json()).toEqual({ accepted: 0, duplicates: 3 });

    // Overlapping incremental batch: seq 2 is a duplicate, 3-5 are new.
    const more = await upload(member, [
      conv(
        "s1",
        [2, 3, 4, 5].map((i) => msg(i, i === 5 ? { model: null } : {})),
        {
          title: null,
          projectDir: null,
          startedAt: "2026-06-01T00:00:00.000Z",
        },
      ),
    ]);
    expect(more.json()).toEqual({ accepted: 3, duplicates: 1 });

    const page = await listOk();
    expect(page.items).toHaveLength(1);
    const summary = page.items[0];
    expect(summary).toMatchObject({
      user: { id: aliceId, username: "alice", displayName: "ALICE" },
      clientSessionId: "s1",
      deviceName: "Alice-MacBook",
      title: "Fix the build",
      projectDir: "/work/app",
      model: "gpt-5",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastMessageAt: msg(5).timestamp,
      messageCount: 6,
    });

    const detailRes = await ctx.app.inject({
      url: `/api/v1/admin/conversations/${summary?.id}`,
      headers: bearer(adminToken),
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = ConversationDetailResponseSchema.parse(detailRes.json());
    expect(detail.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(detail.messages[1]).toEqual(msg(1));
    expect(detail.conversation.id).toBe(summary?.id);

    // Title updates when a later upload provides one.
    await upload(member, [conv("s1", [], { title: "Renamed" })]);
    expect((await listOk()).items[0]?.title).toBe("Renamed");
  });

  it("strips NUL characters and falls back to now without timestamps", async () => {
    await createMember("alice");
    const member = await loginMember("alice");
    await putPolicy(adminToken);
    const before = Date.now();

    const res = await upload(member, [
      conv(
        "s\u0000nul",
        [
          msg(0, {
            content: "a\u0000b",
            toolName: "sh\u0000ell",
            model: "m\u0000x",
            timestamp: null,
          }),
        ],
        { title: "t\u0000itle", projectDir: "/p\u0000" },
      ),
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0 });

    const page = await listOk();
    const item = page.items[0];
    expect(item).toMatchObject({
      clientSessionId: "snul",
      title: "title",
      projectDir: "/p",
      model: "mx",
      deviceName: null,
    });
    expect(Date.parse(item?.lastMessageAt ?? "")).toBeGreaterThanOrEqual(
      before,
    );
    const detail = await ctx.app.inject({
      url: `/api/v1/admin/conversations/${item?.id}`,
      headers: bearer(adminToken),
    });
    expect(detail.json().messages[0]).toMatchObject({
      content: "ab",
      toolName: "shell",
    });
  });

  it("keeps different users' conversations separate", async () => {
    const aliceId = await createMember("alice");
    const bobId = await createMember("bob");
    const alice = await loginMember("alice", "A-Laptop");
    const bob = await loginMember("bob", "B-Laptop");
    await putPolicy(adminToken);

    await upload(alice, [conv("same", [msg(0), msg(1)])]);
    const bobRes = await upload(bob, [conv("same", [msg(0), msg(1), msg(2)])]);
    // Not counted as duplicates of alice's messages.
    expect(bobRes.json()).toEqual({ accepted: 3, duplicates: 0 });

    const page = await listOk();
    expect(page.items).toHaveLength(2);
    const byUser = new Map(page.items.map((i) => [i.user.id, i]));
    expect(byUser.get(aliceId)).toMatchObject({
      messageCount: 2,
      deviceName: "A-Laptop",
    });
    expect(byUser.get(bobId)).toMatchObject({
      messageCount: 3,
      deviceName: "B-Laptop",
    });

    const onlyBob = await listOk(`?userId=${bobId}`);
    expect(onlyBob.items.map((i) => i.user.id)).toEqual([bobId]);
  });
});

describe("admin conversation browsing", () => {
  async function seed() {
    await createMember("alice");
    const member = await loginMember("alice");
    await putPolicy(adminToken);
    // Conversation k has its last message on 2026-01-0k.
    const items = [1, 2, 3, 4, 5].map((k) =>
      conv(
        `s${k}`,
        [
          msg(0, {
            content: k === 2 ? "Uses 100%_DONE marker" : `plain text ${k}`,
            timestamp: `2026-01-0${k}T12:00:00.000Z`,
          }),
        ],
        { title: k === 4 ? "Deploy PIPELINE" : `chat ${k}` },
      ),
    );
    const res = await upload(member, items);
    expect(res.json()).toEqual({ accepted: 5, duplicates: 0 });
    return member;
  }

  it("lists newest first with cursor pagination", async () => {
    await seed();
    const p1 = await listOk("?limit=2");
    expect(p1.items.map((i) => i.clientSessionId)).toEqual(["s5", "s4"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listOk(`?limit=2&cursor=${p1.nextCursor}`);
    expect(p2.items.map((i) => i.clientSessionId)).toEqual(["s3", "s2"]);
    const p3 = await listOk(`?limit=2&cursor=${p2.nextCursor}`);
    expect(p3.items.map((i) => i.clientSessionId)).toEqual(["s1"]);
    expect(p3.nextCursor).toBeNull();

    expect((await list("?cursor=garbage")).statusCode).toBe(400);
    expect((await list("?limit=500")).statusCode).toBe(400);
  });

  it("filters by date range and searches title and content", async () => {
    await seed();
    const range = await listOk("?from=2026-01-02&to=2026-01-04");
    expect(range.items.map((i) => i.clientSessionId)).toEqual([
      "s4",
      "s3",
      "s2",
    ]);
    expect((await list("?from=2026-02-30")).statusCode).toBe(400);

    const byTitle = await listOk("?q=pipeline");
    expect(byTitle.items.map((i) => i.clientSessionId)).toEqual(["s4"]);

    const byContent = await listOk(`?q=${encodeURIComponent("100%_done")}`);
    expect(byContent.items.map((i) => i.clientSessionId)).toEqual(["s2"]);

    // % and _ are literal, not wildcards.
    expect(
      (await listOk("?q=%25")).items.map((i) => i.clientSessionId),
    ).toEqual(["s2"]);
    expect((await listOk("?q=_")).items.map((i) => i.clientSessionId)).toEqual([
      "s2",
    ]);
    expect((await listOk("?q=nothing-matches")).items).toEqual([]);
  });

  it("returns 404/400 for missing or malformed ids and forbids members", async () => {
    const member = await seed();
    const missing = await ctx.app.inject({
      url: "/api/v1/admin/conversations/00000000-0000-4000-8000-000000000000",
      headers: bearer(adminToken),
    });
    expect(missing.statusCode).toBe(404);
    const malformed = await ctx.app.inject({
      url: "/api/v1/admin/conversations/not-a-uuid",
      headers: bearer(adminToken),
    });
    expect(malformed.statusCode).toBe(400);

    expect((await list("", member)).statusCode).toBe(403);
    const id = (await listOk()).items[0]?.id;
    const detail = await ctx.app.inject({
      url: `/api/v1/admin/conversations/${id}`,
      headers: bearer(member),
    });
    expect(detail.statusCode).toBe(403);
  });
});
