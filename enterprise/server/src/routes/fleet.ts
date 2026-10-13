import {
  DeviceAppliedRequestSchema,
  DeviceHeartbeatRequestSchema,
  DeviceReportedSchema,
  type DeviceReported,
  type ListDevicesResponse,
  PutFleetRequestSchema,
} from "@ccse/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { authOf, requirePermission } from "../auth/guard.ts";
import { devices, users } from "../db/schema.ts";
import { notFound, parseBody } from "../errors.ts";
import {
  fleetSummary,
  getAdminFleet,
  getDesiredFleet,
  saveFleet,
} from "../fleet/store.ts";

/** A desktop that heartbeated within this window is "online". */
const ONLINE_MS = 2 * 60 * 1000;

const DeviceQuerySchema = z.object({ deviceId: z.string().uuid() });

const EMPTY_REPORTED: DeviceReported = {
  mode: "direct",
  activeProviderId: null,
  activeProviderName: null,
  providers: [],
  stackMemberIds: [],
};

export async function fleetRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { db, authenticate, config } = deps;
  const admin = {
    preHandler: [authenticate, requirePermission("settings.manage")],
  };

  app.get("/admin/fleet", admin, async () => getAdminFleet(db));

  app.put("/admin/fleet", admin, async (req) => {
    const body = parseBody(PutFleetRequestSchema, req.body);
    const saved = await saveFleet(db, body, config.secretsKey);
    req.log.info(
      {
        actor: authOf(req).user.id,
        revision: saved.revision,
        mode: saved.mode,
        providers: saved.providers.map((p) => p.id),
      },
      "fleet profile updated",
    );
    return saved;
  });

  app.get("/admin/devices", admin, async () => {
    const fleet = await fleetSummary(db);
    const rows = await db
      .select({
        id: devices.id,
        userId: devices.userId,
        username: users.username,
        displayName: users.displayName,
        name: devices.name,
        hostname: devices.hostname,
        lastSeenAt: devices.lastSeenAt,
        reported: devices.reported,
        appliedRevision: devices.appliedRevision,
        applyError: devices.applyError,
      })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .orderBy(desc(devices.lastSeenAt));
    const now = Date.now();
    const res: ListDevicesResponse = {
      serverTime: new Date(now).toISOString(),
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        username: row.username,
        displayName: row.displayName,
        name: row.name,
        hostname: row.hostname,
        lastSeenAt: row.lastSeenAt.toISOString(),
        online: now - row.lastSeenAt.getTime() <= ONLINE_MS,
        reported: parseReported(row.reported),
        appliedRevision: row.appliedRevision,
        applyError: row.applyError,
        desiredRevision: fleet.desiredRevision,
      })),
    };
    return res;
  });

  app.post("/devices/heartbeat", { preHandler: authenticate }, async (req) => {
    const body = parseBody(DeviceHeartbeatRequestSchema, req.body);
    const auth = authOf(req);
    const now = new Date();
    await db
      .insert(devices)
      .values({
        id: body.deviceId,
        userId: auth.user.id,
        name: body.name,
        hostname: body.hostname,
        lastSeenAt: now,
        reported: body.reported,
      })
      .onConflictDoUpdate({
        target: devices.id,
        set: {
          userId: auth.user.id,
          name: body.name,
          hostname: body.hostname,
          lastSeenAt: now,
          reported: body.reported,
        },
      });
    return fleetSummary(db);
  });

  app.get(
    "/devices/me/desired",
    { preHandler: [authenticate, requirePermission("models.use")] },
    async (req) => {
      const { deviceId } = parseBody(DeviceQuerySchema, req.query);
      await requireOwnDevice(db, authOf(req).user.id, deviceId);
      return getDesiredFleet(db, config.secretsKey);
    },
  );

  app.post(
    "/devices/me/applied",
    { preHandler: authenticate },
    async (req, reply) => {
      const body = parseBody(DeviceAppliedRequestSchema, req.body);
      const auth = authOf(req);
      await requireOwnDevice(db, auth.user.id, body.deviceId);
      const failed = typeof body.error === "string" && body.error.length > 0;
      await db
        .update(devices)
        .set(
          failed
            ? { applyError: body.error }
            : { appliedRevision: body.revision, applyError: null },
        )
        .where(
          and(eq(devices.id, body.deviceId), eq(devices.userId, auth.user.id)),
        );
      req.log.info(
        { userId: auth.user.id, revision: body.revision, failed },
        "fleet apply reported",
      );
      return reply.status(204).send();
    },
  );
}

function parseReported(value: unknown): DeviceReported {
  const parsed = DeviceReportedSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_REPORTED;
}

async function requireOwnDevice(
  db: AppDeps["db"],
  userId: string,
  deviceId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Device not found");
}
