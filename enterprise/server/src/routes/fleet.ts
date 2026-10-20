import {
  CreateProfileRequestSchema,
  DeviceAppliedRequestSchema,
  type DeviceDetailResponse,
  DeviceDetailResponseSchema,
  DeviceHeartbeatRequestSchema,
  type DeviceReported,
  DeviceReportedSchema,
  type DeviceUsageResponse,
  DeviceUsageResponseSchema,
  DeviceUsageUploadRequestSchema,
  type ListDevicesResponse,
  ListProfilesResponseSchema,
  PatchDeviceRequestSchema,
  PutFleetRequestSchema,
  UsageQuerySchema,
} from "@ccse/contracts";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import {
  authOf,
  requireAnyPermission,
  requirePermission,
} from "../auth/guard.ts";
import { revokeSession } from "../auth/sessions.ts";
import {
  devices,
  deviceUsageDaily,
  gatewayKeys,
  usageRecords,
  users,
} from "../db/schema.ts";
import { AppError, forbidden, notFound, parseBody } from "../errors.ts";
import {
  copyProfileForDevice,
  createProfile,
  deleteProfile,
  desiredFor,
  effectiveProfile,
  ensureDefault,
  generateDeviceSecret,
  getProfile,
  hashDeviceSecret,
  listProfiles,
  profileById,
  saveDefaultFleet,
  summaryOf,
  updateProfile,
} from "../fleet/store.ts";
import { groupScope } from "../users/scope.ts";

const ONLINE_MS = 2 * 60 * 1000;
const DAY_MS = 86_400_000;
const USAGE_DAYS = 7;

const IdParamSchema = z.object({ id: z.string().uuid() });
const DeviceQuerySchema = z.object({ deviceId: z.string().uuid() });

const EMPTY_REPORTED: DeviceReported = {
  mode: "direct",
  activeProviderId: null,
  activeProviderName: null,
  providers: [],
  stackMemberIds: [],
};

function secretOf(req: FastifyRequest): string | undefined {
  const header = req.headers["x-device-secret"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

function parseReported(value: unknown): DeviceReported {
  const parsed = DeviceReportedSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_REPORTED;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function fleetRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, authenticate, config } = deps;
  const admin = {
    preHandler: [authenticate, requirePermission("settings.manage")],
  };
  const usageGuard = {
    preHandler: [
      authenticate,
      requireAnyPermission("audit.read", "usage.group.read"),
    ],
  };

  app.get("/admin/profiles", admin, async () => {
    const res = { items: await listProfiles(db) };
    return ListProfilesResponseSchema.parse(res);
  });

  app.post("/admin/profiles", admin, async (req, reply) => {
    const body = parseBody(CreateProfileRequestSchema, req.body);
    const saved = await createProfile(db, body, config.secretsKey);
    req.log.info(
      { actor: authOf(req).user.id, profileId: saved.id },
      "profile created",
    );
    return reply.status(201).send(saved);
  });

  app.get("/admin/profiles/:id", admin, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    return getProfile(db, id);
  });

  app.put("/admin/profiles/:id", admin, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const body = parseBody(CreateProfileRequestSchema, req.body);
    return updateProfile(db, id, body, config.secretsKey);
  });

  app.delete("/admin/profiles/:id", admin, async (req, reply) => {
    const { id } = parseBody(IdParamSchema, req.params);
    await deleteProfile(db, id);
    return reply.status(204).send();
  });

  app.get("/admin/fleet", admin, async () => {
    const row = await ensureDefault(db);
    const profile = await getProfile(db, row.id);
    const {
      id: _id,
      name: _name,
      isDefault: _flag,
      deviceCount: _count,
      ...fleet
    } = profile;
    return fleet;
  });

  app.put("/admin/fleet", admin, async (req) => {
    const body = parseBody(PutFleetRequestSchema, req.body);
    return saveDefaultFleet(db, body, config.secretsKey);
  });

  app.get("/admin/devices", admin, async () => {
    const res: ListDevicesResponse = {
      serverTime: new Date().toISOString(),
      items: await listDeviceRows(db),
    };
    return res;
  });

  app.get("/admin/devices/:id", admin, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const [device] = (await listDeviceRows(db)).filter((row) => row.id === id);
    if (!device) throw notFound("Device not found");
    const since = utcDay(new Date(Date.now() - (USAGE_DAYS - 1) * DAY_MS));
    const rows = await db
      .select()
      .from(deviceUsageDaily)
      .where(
        and(
          eq(deviceUsageDaily.deviceId, id),
          gte(deviceUsageDaily.date, since),
        ),
      );
    const days = new Map<
      string,
      {
        requests: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
      }
    >();
    const byProvider = new Map<
      string,
      {
        providerId: string;
        model: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
      }
    >();
    for (const row of rows) {
      const cost = row.costMicroUsd / 1_000_000;
      const day = days.get(row.date) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      day.requests += row.requests;
      day.inputTokens += row.inputTokens;
      day.outputTokens += row.outputTokens;
      day.costUsd += cost;
      days.set(row.date, day);
      const key = `${row.providerId}\0${row.model}`;
      const item = byProvider.get(key) ?? {
        providerId: row.providerId,
        model: row.model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      item.requests += row.requests;
      item.inputTokens += row.inputTokens;
      item.outputTokens += row.outputTokens;
      item.costUsd += cost;
      byProvider.set(key, item);
    }
    const gatewaySince = new Date(Date.now() - (USAGE_DAYS - 1) * DAY_MS);
    const [gateway] = await db
      .select({
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::int`,
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.deviceId, id),
          gte(usageRecords.createdAt, gatewaySince),
        ),
      );
    const detail: DeviceDetailResponse = {
      device,
      days: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, totals]) => ({ date, ...totals })),
      byProvider: [...byProvider.values()].sort(
        (a, b) =>
          b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
      ),
      gateway: {
        requests: gateway?.requests ?? 0,
        inputTokens: gateway?.inputTokens ?? 0,
        outputTokens: gateway?.outputTokens ?? 0,
      },
    };
    return DeviceDetailResponseSchema.parse(detail);
  });

  app.patch("/admin/devices/:id", admin, async (req) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const body = parseBody(PatchDeviceRequestSchema, req.body);
    const [existing] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, id))
      .limit(1);
    if (!existing) throw notFound("Device not found");
    if (body.profileId) {
      const profile = await profileById(db, body.profileId);
      if (!profile) throw new AppError(400, "bad_request", "Unknown profile");
    }
    await db
      .update(devices)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.profileId !== undefined ? { profileId: body.profileId } : {}),
        ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
        ...(body.forceSync ? { forceSyncAt: new Date() } : {}),
      })
      .where(eq(devices.id, id));
    if (body.disabled) {
      if (existing.sessionId) await revokeSession(db, existing.sessionId);
      await db.delete(gatewayKeys).where(eq(gatewayKeys.deviceId, id));
    }
    const [device] = (await listDeviceRows(db)).filter((row) => row.id === id);
    if (!device) throw notFound("Device not found");
    return device;
  });

  app.post("/admin/devices/:id/personal-profile", admin, async (req, reply) => {
    const { id } = parseBody(IdParamSchema, req.params);
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, id))
      .limit(1);
    if (!device) throw notFound("Device not found");
    const source = await effectiveProfile(db, device.profileId);
    const copy = await copyProfileForDevice(db, device.name, source);
    await db
      .update(devices)
      .set({ profileId: copy.id })
      .where(eq(devices.id, id));
    return reply.status(201).send(await getProfile(db, copy.id));
  });

  app.get("/admin/usage/devices", usageGuard, async (req) => {
    const query = parseBody(UsageQuerySchema, req.query);
    const actor = authOf(req).user;
    const rows = await db
      .select({
        deviceId: deviceUsageDaily.deviceId,
        deviceName: devices.name,
        userId: deviceUsageDaily.userId,
        username: users.username,
        groupName: users.groupName,
        providerId: deviceUsageDaily.providerId,
        requests: sql<number>`sum(${deviceUsageDaily.requests})::int`,
        inputTokens: sql<number>`sum(${deviceUsageDaily.inputTokens})::int`,
        outputTokens: sql<number>`sum(${deviceUsageDaily.outputTokens})::int`,
        costMicro: sql<number>`sum(${deviceUsageDaily.costMicroUsd})::int`,
      })
      .from(deviceUsageDaily)
      .innerJoin(devices, eq(devices.id, deviceUsageDaily.deviceId))
      .innerJoin(users, eq(users.id, deviceUsageDaily.userId))
      .where(
        and(
          gte(deviceUsageDaily.date, query.from),
          actor.role === "group_leader" ? groupScope(actor) : undefined,
          lt(deviceUsageDaily.date, nextDay(query.to)),
        ),
      )
      .groupBy(
        deviceUsageDaily.deviceId,
        devices.name,
        deviceUsageDaily.userId,
        users.username,
        users.groupName,
        deviceUsageDaily.providerId,
      );
    const res: DeviceUsageResponse = {
      items: rows.map((row) => ({
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        userId: row.userId,
        username: row.username,
        groupName: row.groupName,
        providerId: row.providerId,
        requests: row.requests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.costMicro / 1_000_000,
      })),
    };
    return DeviceUsageResponseSchema.parse(res);
  });

  app.post("/devices/heartbeat", { preHandler: authenticate }, async (req) => {
    const body = parseBody(DeviceHeartbeatRequestSchema, req.body);
    const auth = authOf(req);
    const now = new Date();
    const [existing] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, body.deviceId))
      .limit(1);
    let deviceSecret: string | undefined;
    if (!existing) {
      deviceSecret = generateDeviceSecret();
      await db.insert(devices).values({
        id: body.deviceId,
        userId: auth.user.id,
        name: body.name,
        hostname: body.hostname,
        lastSeenAt: now,
        reported: body.reported,
        secretHash: hashDeviceSecret(deviceSecret),
        sessionId: auth.sessionId,
      });
    } else {
      if (existing.disabled) throw forbidden("Device is disabled");
      if (existing.secretHash) {
        if (
          !body.deviceSecret ||
          hashDeviceSecret(body.deviceSecret) !== existing.secretHash
        ) {
          throw new AppError(401, "unauthorized", "Invalid device secret");
        }
      } else {
        deviceSecret = generateDeviceSecret();
      }
      const userChanged = existing.userId !== auth.user.id;
      await db
        .update(devices)
        .set({
          userId: auth.user.id,
          name: body.name,
          hostname: body.hostname,
          lastSeenAt: now,
          reported: body.reported,
          sessionId: auth.sessionId,
          ...(deviceSecret
            ? { secretHash: hashDeviceSecret(deviceSecret) }
            : {}),
          ...(userChanged
            ? { previousUserId: existing.userId, userChangedAt: now }
            : {}),
        })
        .where(eq(devices.id, body.deviceId));
    }
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, body.deviceId))
      .limit(1);
    if (!device) throw notFound("Device not found");
    const profile = await effectiveProfile(db, device.profileId);
    return {
      ...summaryOf(profile),
      forceSync: device.forceSyncAt != null,
      ...(deviceSecret ? { deviceSecret } : {}),
    };
  });

  app.get(
    "/devices/me/desired",
    { preHandler: [authenticate, requirePermission("models.use")] },
    async (req) => {
      const { deviceId } = parseBody(DeviceQuerySchema, req.query);
      const device = await requireLiveDevice(
        db,
        authOf(req).user.id,
        deviceId,
        secretOf(req),
      );
      const profile = await effectiveProfile(db, device.profileId);
      return desiredFor(db, profile, config.secretsKey);
    },
  );

  app.post(
    "/devices/me/applied",
    { preHandler: authenticate },
    async (req, reply) => {
      const body = parseBody(DeviceAppliedRequestSchema, req.body);
      const auth = authOf(req);
      await requireLiveDevice(
        db,
        auth.user.id,
        body.deviceId,
        body.deviceSecret,
      );
      const failed = typeof body.error === "string" && body.error.length > 0;
      await db
        .update(devices)
        .set(
          failed
            ? { applyError: body.error }
            : {
                appliedRevision: body.revision,
                appliedProfileId: body.profileId,
                applyError: null,
                forceSyncAt: null,
              },
        )
        .where(
          and(eq(devices.id, body.deviceId), eq(devices.userId, auth.user.id)),
        );
      return reply.status(204).send();
    },
  );

  app.post(
    "/devices/me/usage",
    { preHandler: authenticate },
    async (req, reply) => {
      const body = parseBody(DeviceUsageUploadRequestSchema, req.body);
      const auth = authOf(req);
      await requireLiveDevice(
        db,
        auth.user.id,
        body.deviceId,
        body.deviceSecret,
      );
      const now = new Date();
      for (const item of body.items) {
        const values = {
          deviceId: body.deviceId,
          userId: auth.user.id,
          date: item.date,
          providerId: item.providerId,
          model: item.model,
          requests: item.requests,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
          costMicroUsd: Math.round(item.costUsd * 1_000_000),
          updatedAt: now,
        };
        await db
          .insert(deviceUsageDaily)
          .values(values)
          .onConflictDoUpdate({
            target: [
              deviceUsageDaily.deviceId,
              deviceUsageDaily.userId,
              deviceUsageDaily.date,
              deviceUsageDaily.providerId,
              deviceUsageDaily.model,
            ],
            set: values,
          });
      }
      return reply.status(204).send();
    },
  );
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function listDeviceRows(db: AppDeps["db"]) {
  await ensureDefault(db);
  const rows = await db
    .select({
      device: devices,
      username: users.username,
      displayName: users.displayName,
    })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .orderBy(desc(devices.lastSeenAt));
  const since7 = utcDay(new Date(Date.now() - (USAGE_DAYS - 1) * DAY_MS));
  const today = utcDay(new Date());
  const usage = await db
    .select({
      deviceId: deviceUsageDaily.deviceId,
      date: deviceUsageDaily.date,
      tokens: sql<number>`sum(${deviceUsageDaily.inputTokens} + ${deviceUsageDaily.outputTokens})::int`,
      cost: sql<number>`sum(${deviceUsageDaily.costMicroUsd})::int`,
    })
    .from(deviceUsageDaily)
    .where(gte(deviceUsageDaily.date, since7))
    .groupBy(deviceUsageDaily.deviceId, deviceUsageDaily.date);
  const totals = new Map<
    string,
    { today: number; week: number; cost: number }
  >();
  for (const row of usage) {
    const item = totals.get(row.deviceId) ?? { today: 0, week: 0, cost: 0 };
    item.week += row.tokens;
    item.cost += row.cost;
    if (row.date === today) item.today += row.tokens;
    totals.set(row.deviceId, item);
  }
  const now = Date.now();
  const items = [];
  for (const row of rows) {
    const profile = await effectiveProfile(db, row.device.profileId);
    const stat = totals.get(row.device.id) ?? { today: 0, week: 0, cost: 0 };
    const synced =
      row.device.appliedProfileId === profile.id &&
      row.device.appliedRevision >= profile.revision &&
      row.device.forceSyncAt == null;
    items.push({
      id: row.device.id,
      userId: row.device.userId,
      username: row.username,
      displayName: row.displayName,
      name: row.device.name,
      hostname: row.device.hostname,
      note: row.device.note,
      lastSeenAt: row.device.lastSeenAt.toISOString(),
      online: now - row.device.lastSeenAt.getTime() <= ONLINE_MS,
      disabled: row.device.disabled,
      reported: parseReported(row.device.reported),
      profileId: row.device.profileId,
      profileName: profile.name,
      appliedRevision: row.device.appliedRevision,
      applyError: row.device.applyError,
      desiredRevision: profile.revision,
      sync: row.device.applyError
        ? ("failed" as const)
        : synced
          ? ("synced" as const)
          : ("pending" as const),
      userChangedAt: row.device.userChangedAt?.toISOString() ?? null,
      tokensToday: stat.today,
      tokens7d: stat.week,
      cost7d: stat.cost / 1_000_000,
    });
  }
  return items;
}

async function requireLiveDevice(
  db: AppDeps["db"],
  userId: string,
  deviceId: string,
  secret: string | undefined,
) {
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Device not found");
  if (row.disabled) throw forbidden("Device is disabled");
  if (
    !row.secretHash ||
    !secret ||
    hashDeviceSecret(secret) !== row.secretHash
  ) {
    throw new AppError(401, "unauthorized", "Invalid device secret");
  }
  return row;
}
