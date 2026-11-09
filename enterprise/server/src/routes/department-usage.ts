import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { authOf, requirePermission } from "../auth/guard.ts";
import { users } from "../db/schema.ts";
import { demoUpstreamAccounts } from "../demo-upstream.ts";
import { AppError, forbidden, parseBody } from "../errors.ts";
import { listUpstreamAccounts, readWeeklyUsageSamples } from "../sub2api.ts";
import {
  applyWeeklySample,
  departmentUsageView,
  meterKey,
  readDepartmentState,
  updateDepartmentState,
} from "../usage/department-usage.ts";

const AssignmentSchema = z.object({
  department: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (name) => !["__proto__", "constructor", "prototype"].includes(name),
    ),
  accountIds: z.array(z.number().int().positive()).max(500),
});

export async function departmentUsageRoutes(
  app: FastifyInstance,
  deps: AppDeps,
) {
  const { db, config, authenticate } = deps;
  const origin = config.demoUpstreamAccounts
    ? "demo"
    : `${config.sub2api?.url ?? "unconfigured"}\n${config.sub2api?.email ?? ""}`;
  const key = meterKey(origin);
  const checkAdmin = (req: Parameters<typeof authOf>[0]) => {
    if (authOf(req).user.role !== "admin") throw forbidden();
  };
  let running: Promise<void> | undefined;
  const refresh = async () => {
    if (running) return running;
    running = (async () => {
      const state = await readDepartmentState(db, key);
      const ids = [...new Set(Object.values(state.assignments).flat())];
      if (!ids.length) return;
      try {
        const samples = config.demoUpstreamAccounts
          ? demoUpstreamAccounts().flatMap((account) => {
              const window = account.windows.find((item) => item.id === "7d");
              return window && ids.includes(account.id)
                ? [
                    {
                      id: account.id,
                      usedPercent: window.usedPercent,
                      resetsAt: window.resetsAt,
                    },
                  ]
                : [];
            })
          : config.sub2api
            ? await readWeeklyUsageSamples(config.sub2api, ids)
            : (() => {
                throw new Error("未配置上游服务");
              })();
        const now = new Date();
        await updateDepartmentState(db, key, (next) => {
          for (const sample of samples) applyWeeklySample(next, sample, now);
          next.error =
            samples.length < ids.length
              ? "部分账号没有可用的 7d 用量，等待下次采集"
              : null;
        });
      } catch (error) {
        app.log.warn({ err: error }, "department usage sampling failed");
        await updateDepartmentState(db, key, (next) => {
          next.error = "采集失败，显示上次成功数据";
        });
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  const view = async () =>
    departmentUsageView(await readDepartmentState(db, key), new Date());
  const guard = [authenticate, requirePermission("users.manage")];

  app.get("/admin/usage/departments", { preHandler: guard }, async (req) => {
    checkAdmin(req);
    return view();
  });
  app.put("/admin/usage/departments", { preHandler: guard }, async (req) => {
    checkAdmin(req);
    const { department, accountIds } = parseBody(AssignmentSchema, req.body);
    const [group] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.groupName, department))
      .limit(1);
    if (!group) throw new AppError(400, "bad_request", "用户组不存在");
    const accounts = config.demoUpstreamAccounts
      ? demoUpstreamAccounts()
      : config.sub2api
        ? await listUpstreamAccounts(config.sub2api)
        : [];
    const valid = new Set(accounts.map((account) => account.id));
    if (accountIds.some((id) => !valid.has(id)))
      throw new AppError(400, "bad_request", "选择的上游账号不存在");
    if (running) await running;
    await updateDepartmentState(db, key, (state) => {
      state.assignments[department] = [...new Set(accountIds)];
      if (Object.values(state.assignments).every((ids) => ids.length === 0))
        state.error = null;
    });
    await refresh();
    return view();
  });
  app.post(
    "/admin/usage/departments/refresh",
    { preHandler: guard },
    async (req) => {
      checkAdmin(req);
      await refresh();
      return view();
    },
  );

  if (config.env !== "test") {
    let timer: ReturnType<typeof setInterval> | undefined;
    let monthTimer: ReturnType<typeof setTimeout> | undefined;
    let closing = false;
    const run = () =>
      void refresh().catch((error: unknown) => {
        app.log.error(
          { err: error },
          "department usage background sync failed",
        );
      });
    const scheduleMonthBoundary = () => {
      if (closing) return;
      const local = new Date(Date.now() + 8 * 60 * 60_000);
      const nextMonth =
        Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) -
        8 * 60 * 60_000;
      monthTimer = setTimeout(
        () => {
          if (Date.now() < nextMonth) {
            scheduleMonthBoundary();
            return;
          }
          void (async () => {
            if (running) await running;
            await refresh();
          })()
            .catch((error: unknown) => {
              app.log.error(
                { err: error },
                "department usage month boundary sync failed",
              );
            })
            .finally(scheduleMonthBoundary);
        },
        Math.min(86_400_000, Math.max(1, nextMonth - Date.now() + 1_000)),
      );
      monthTimer.unref();
    };
    app.addHook("onReady", async () => {
      run();
      timer = setInterval(run, 60_000);
      timer.unref();
      scheduleMonthBoundary();
    });
    app.addHook("onClose", async () => {
      closing = true;
      if (timer) clearInterval(timer);
      if (monthTimer) clearTimeout(monthTimer);
      await running;
    });
  }
}
