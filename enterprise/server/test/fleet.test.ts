import {
  AdminFleetSchema,
  DesiredFleetSchema,
  DeviceHeartbeatResponseSchema,
  ListDevicesResponseSchema,
} from "@ccse/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, bearer, login, setup, type TestContext } from "./helpers.ts";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const KEY = "sk-fleet-secret-key-1234";

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

async function createUser(role: "member" | "viewer", username: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: bearer(adminToken),
    payload: {
      username,
      displayName: username,
      password: `${username}-password-1`,
      role,
    },
  });
  expect(res.statusCode).toBe(201);
  return login(ctx.app, username, `${username}-password-1`);
}

function fleetBody(extra: Record<string, unknown> = {}) {
  return {
    mode: "stack",
    activeProviderId: "volcengine",
    stackMemberIds: ["yida"],
    providers: [
      {
        id: "volcengine",
        name: "火山 Coding Plan",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        apiKey: KEY,
        model: "doubao-seed-2-1-pro",
        models: [
          { id: "doubao-seed-2-1-pro", displayName: "Doubao Seed 2.1 Pro" },
        ],
      },
      {
        id: "yida",
        name: "Yida",
        baseUrl: "https://8885301.xyz/v1",
        apiKey: "sk-yida-secret-9999",
        model: "gpt-5.5",
      },
    ],
    ...extra,
  };
}

const reported = {
  mode: "direct" as const,
  activeProviderId: "codex-official",
  activeProviderName: "default",
  providers: [
    { id: "codex-official", name: "default", managed: false },
  ],
  stackMemberIds: [],
};

describe("fleet profile", () => {
  it("stores keys encrypted and returns them only to the owning desktop", async () => {
    const member = await createUser("member", "alice");
    const viewer = await createUser("viewer", "vera");

    const missingKey = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/admin/fleet",
      headers: bearer(adminToken),
      payload: fleetBody({
        providers: [
          {
            id: "volcengine",
            name: "火山",
            baseUrl: "https://example.com/v1",
            model: "m",
          },
        ],
        activeProviderId: "volcengine",
        stackMemberIds: [],
        mode: "direct",
      }),
    });
    expect(missingKey.statusCode).toBe(400);

    const saved = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/admin/fleet",
      headers: bearer(adminToken),
      payload: fleetBody(),
    });
    expect(saved.statusCode).toBe(200);
    const fleet = AdminFleetSchema.parse(saved.json());
    expect(fleet.revision).toBe(1);
    expect(fleet.providers[0]?.apiKeyHint).toContain("…");
    expect(saved.body).not.toContain(KEY);

    const httpUrl = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/admin/fleet",
      headers: bearer(adminToken),
      payload: fleetBody({
        providers: [
          {
            ...fleetBody().providers[0],
            baseUrl: "http://evil.example/v1",
          },
          fleetBody().providers[1],
        ],
      }),
    });
    expect(httpUrl.statusCode).toBe(400);

    const kept = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/admin/fleet",
      headers: bearer(adminToken),
      payload: fleetBody({
        providers: fleetBody().providers.map((p) => ({ ...p, apiKey: "" })),
      }),
    });
    expect(kept.statusCode).toBe(200);
    expect(AdminFleetSchema.parse(kept.json()).revision).toBe(2);

    const denied = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/admin/fleet",
      headers: bearer(member.accessToken),
      payload: fleetBody(),
    });
    expect(denied.statusCode).toBe(403);

    const beat = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/devices/heartbeat",
      headers: bearer(member.accessToken),
      payload: {
        deviceId: DEVICE,
        name: "Alice-Mac",
        hostname: "alice-mac",
        reported,
      },
    });
    expect(beat.statusCode).toBe(200);
    const hb = DeviceHeartbeatResponseSchema.parse(beat.json());
    expect(hb).toMatchObject({
      desiredRevision: 2,
      mode: "stack",
      activeProviderId: "volcengine",
      stackMemberIds: ["yida"],
    });
    expect(hb.deviceSecret).toMatch(/^ds_/);
    const deviceHeaders = {
      ...bearer(member.accessToken),
      "x-device-secret": hb.deviceSecret ?? "",
    };

    const desired = await ctx.app.inject({
      url: `/api/v1/devices/me/desired?deviceId=${DEVICE}`,
      headers: deviceHeaders,
    });
    expect(desired.statusCode).toBe(200);
    const doc = DesiredFleetSchema.parse(desired.json());
    expect(doc.providers.find((p) => p.id === "volcengine")?.apiKey).toBe(KEY);
    expect(doc.providers.find((p) => p.id === "yida")?.model).toBe("gpt-5.5");

    const viewerDesired = await ctx.app.inject({
      url: `/api/v1/devices/me/desired?deviceId=${DEVICE}`,
      headers: bearer(viewer.accessToken),
    });
    expect(viewerDesired.statusCode).toBe(403);

    const stranger = await ctx.app.inject({
      url: `/api/v1/devices/me/desired?deviceId=${DEVICE}`,
      headers: bearer(adminToken),
    });
    expect(stranger.statusCode).toBe(404);

    const failed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/devices/me/applied",
      headers: bearer(member.accessToken),
      payload: {
        deviceId: DEVICE,
        deviceSecret: hb.deviceSecret,
        profileId: hb.profileId,
        revision: 2,
        error: "codex busy",
      },
    });
    expect(failed.statusCode).toBe(204);

    const list = await ctx.app.inject({
      url: "/api/v1/admin/devices",
      headers: bearer(adminToken),
    });
    const devices = ListDevicesResponseSchema.parse(list.json());
    expect(devices.items).toHaveLength(1);
    expect(devices.items[0]).toMatchObject({
      name: "Alice-Mac",
      username: "alice",
      online: true,
      appliedRevision: 0,
      applyError: "codex busy",
      desiredRevision: 2,
      reported: { mode: "direct", activeProviderName: "default" },
    });

    const ok = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/devices/me/applied",
      headers: bearer(member.accessToken),
      payload: {
        deviceId: DEVICE,
        deviceSecret: hb.deviceSecret,
        profileId: hb.profileId,
        revision: 2,
      },
    });
    expect(ok.statusCode).toBe(204);
    const after = ListDevicesResponseSchema.parse(
      (
        await ctx.app.inject({
          url: "/api/v1/admin/devices",
          headers: bearer(adminToken),
        })
      ).json(),
    );
    expect(after.items[0]).toMatchObject({
      appliedRevision: 2,
      applyError: null,
      sync: "synced",
    });

    const spoof = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/devices/heartbeat",
      headers: bearer(member.accessToken),
      payload: {
        deviceId: DEVICE,
        name: "Alice-Mac",
        hostname: "alice-mac",
        reported,
      },
    });
    expect(spoof.statusCode).toBe(401);

    const uploaded = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/devices/me/usage",
      headers: bearer(member.accessToken),
      payload: {
        deviceId: DEVICE,
        deviceSecret: hb.deviceSecret,
        items: [
          {
            date: "2026-10-13",
            providerId: "codex-official",
            model: "gpt-5.5",
            requests: 2,
            inputTokens: 10,
            outputTokens: 4,
            costUsd: 0.5,
          },
        ],
      },
    });
    expect(uploaded.statusCode).toBe(204);
    const again = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/devices/me/usage",
      headers: bearer(member.accessToken),
      payload: {
        deviceId: DEVICE,
        deviceSecret: hb.deviceSecret,
        items: [
          {
            date: "2026-10-13",
            providerId: "codex-official",
            model: "gpt-5.5",
            requests: 3,
            inputTokens: 12,
            outputTokens: 5,
            costUsd: 0.25,
          },
        ],
      },
    });
    expect(again.statusCode).toBe(204);

    const other = "22222222-2222-4222-8222-222222222222";
    const bob = await createUser("member", "bob");
    const bobBeat = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/devices/heartbeat",
      headers: bearer(bob.accessToken),
      payload: {
        deviceId: other,
        name: "Bob-Mini",
        hostname: "bob",
        reported,
      },
    });
    const bobHb = DeviceHeartbeatResponseSchema.parse(bobBeat.json());
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/admin/profiles",
      headers: bearer(adminToken),
      payload: {
        name: "Bob only",
        mode: "direct",
        activeProviderId: "yida",
        stackMemberIds: [],
        providers: [fleetBody().providers[1]],
      },
    });
    expect(created.statusCode).toBe(201);
    const profileId = created.json().id as string;
    const assigned = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/devices/${other}`,
      headers: bearer(adminToken),
      payload: { profileId },
    });
    expect(assigned.statusCode).toBe(200);
    const bobDesired = await ctx.app.inject({
      url: `/api/v1/devices/me/desired?deviceId=${other}`,
      headers: {
        ...bearer(bob.accessToken),
        "x-device-secret": bobHb.deviceSecret ?? "",
      },
    });
    const bobDoc = DesiredFleetSchema.parse(bobDesired.json());
    expect(bobDoc.profileId).toBe(profileId);
    expect(bobDoc.providers.map((p) => p.id)).toEqual(["yida"]);
    expect(bobDoc.providers[0]?.apiKey).toBe("sk-yida-secret-9999");

    const usage = await ctx.app.inject({
      url: "/api/v1/admin/usage/devices?from=2026-10-01&to=2026-10-13",
      headers: bearer(adminToken),
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().items).toEqual([
      expect.objectContaining({
        deviceId: DEVICE,
        username: "alice",
        requests: 3,
        inputTokens: 12,
        costUsd: 0.25,
      }),
    ]);
  });
});
