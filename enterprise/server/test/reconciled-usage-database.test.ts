import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.ts";
import { users } from "../src/db/schema.ts";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

const mocks = vi.hoisted(() => ({ read: vi.fn(), close: vi.fn() }));
vi.mock("../src/usage/read-upstream-database.ts", () => ({
  createUpstreamDatabaseReader: () => ({
    read: mocks.read,
    close: mocks.close,
  }),
}));

let ctx: TestContext;
beforeEach(async () => {
  mocks.read.mockReset().mockResolvedValue([]);
  mocks.close.mockReset().mockResolvedValue(undefined);
  ctx = await setup({
    SUB2API_URL: "https://upstream.test",
    SUB2API_EMAIL: "x@example.test",
    SUB2API_PASSWORD: "test",
    SUB2API_USAGE_DATABASE_URL: "postgres://readonly@localhost/upstream",
  });
});
afterEach(async () => ctx.close());

it("queries only the requested UTC interval without contacting the upstream API", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const session = await login(ctx.app, ADMIN.username, ADMIN.password);
  const response = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/admin/usage/upstream?from=2026-11-01&to=2026-11-07",
    headers: bearer(session.accessToken),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ items: [], configured: true });
  expect(mocks.read).toHaveBeenCalledWith(
    new Date("2026-11-01T00:00:00Z"),
    new Date("2026-11-08T00:00:00Z"),
    null,
  );
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it("passes the authenticated group to the database reader", async () => {
  await ctx.db.insert(users).values({
    username: "leader",
    displayName: "leader",
    passwordHash: await hashPassword("password-123"),
    role: "group_leader",
    groupName: "group-a",
  });
  const session = await login(ctx.app, "leader", "password-123");
  const response = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/admin/usage/upstream?from=2026-11-01&to=2026-11-01",
    headers: bearer(session.accessToken),
  });
  expect(response.statusCode).toBe(200);
  expect(mocks.read).toHaveBeenCalledWith(
    expect.any(Date),
    expect.any(Date),
    "group-a",
  );
});

it("reports a database failure without falling back to a slow scan", async () => {
  mocks.read.mockRejectedValue(new Error("database unavailable"));
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const session = await login(ctx.app, ADMIN.username, ADMIN.password);
  const response = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/admin/usage/upstream?from=2026-11-01&to=2026-11-01",
    headers: bearer(session.accessToken),
  });
  expect(response.statusCode).toBe(500);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
