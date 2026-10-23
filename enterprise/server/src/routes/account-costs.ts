import {
  CODING_PLAN_ACCOUNT_ID,
  CODING_PLAN_ACCOUNT_NAME,
  normalizeAccountCostDepartment,
  ManualAccountCostsRequestSchema,
  OfflineAccountCostInputSchema,
  UsageAccountCostsResponseSchema,
} from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { authOf, requireAnyPermission } from "../auth/guard.ts";
import { forbidden, parseBody } from "../errors.ts";
import {
  recordSubscriptions,
  ledgerMonths,
  ledgerManualAccounts,
  mergeAccountBreakdowns,
  readLedger,
} from "../usage/subscription-ledger.ts";
import {
  readOfflineAccountCosts,
  offlineAccountLedger,
  saveOfflineAccountCost,
  deleteOfflineAccountCost,
} from "../usage/offline-account-costs.ts";
import { demoUpstreamAccounts } from "../demo-upstream.ts";
import { listUpstreamAccounts } from "../sub2api.ts";
import {
  aggregateAccountCosts,
  manualCostKey,
  readManualCosts,
  saveManualCosts,
  currentCostMonth,
  readCostMonths,
} from "../usage/account-costs.ts";

export async function accountCostsRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { authenticate, config, readCodingPlan, db } = deps;
  const liveAccounts = async () => {
    if (config.demoUpstreamAccounts) return demoUpstreamAccounts();
    const [accounts, codingPlan] = await Promise.all([
      config.sub2api ? listUpstreamAccounts(config.sub2api) : [],
      config.volcengine ? readCodingPlan() : undefined,
    ]);
    return [
      ...accounts,
      ...(codingPlan?.configured
        ? [
            {
              id: CODING_PLAN_ACCOUNT_ID,
              name: CODING_PLAN_ACCOUNT_NAME,
              platform: "volcengine",
              planType: codingPlan.subscription?.planType ?? null,
              subscriptionExpiresAt: codingPlan.subscription?.expiresAt ?? null,
            },
          ]
        : []),
    ];
  };
  const refreshLedger = async () => {
    const [accounts, overrides] = await Promise.all([
      liveAccounts(),
      readManualCosts(db),
    ]);
    const ledger = await recordSubscriptions(
      db,
      accounts,
      overrides,
      config.demoUpstreamAccounts,
    );
    return { ledger, overrides };
  };

  // Observe renewal cycles independently of dashboard visits; existing charges are retained.
  if (config.env !== "test") {
    let running = false;
    const record = async () => {
      if (running) return;
      running = true;
      try {
        await refreshLedger();
      } catch (error) {
        app.log.error({ err: error }, "subscription ledger sync failed");
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void record(), 60_000);
    timer.unref();
    app.addHook("onReady", async () => {
      void record();
    });
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }
  app.get(
    "/admin/usage/account-costs",
    {
      preHandler: [
        authenticate,
        requireAnyPermission("audit.read", "usage.read", "usage.group.read"),
      ],
    },
    async (req, reply) => {
      const actor = authOf(req).user;
      const role = actor.role;
      if (role !== "admin" && role !== "leader" && role !== "group_leader")
        throw forbidden();
      const departmentScope =
        role === "group_leader"
          ? normalizeAccountCostDepartment(actor.groupName ?? "")
          : null;
      if (departmentScope === "")
        throw forbidden("尚未分配所属组，无法查看账户统计");
      reply.header("Cache-Control", "no-store");
      const query = parseBody(
        z
          .object({
            period: z.enum(["month", "year"]).default("month"),
            value: z.string().optional(),
          })
          .refine(
            (q) =>
              !q.value ||
              (q.period === "month"
                ? /^\d{4}-(0[1-9]|1[0-2])$/
                : /^\d{4}$/
              ).test(q.value),
          ),
        req.query,
      );
      const current = currentCostMonth();
      const value =
        query.value ??
        (query.period === "month" ? current : current.slice(0, 4));
      // Refresh even for past-month views: a newly discovered cycle may belong to last month.
      const [{ ledger }, offlineAccounts] = await Promise.all([
        refreshLedger().catch(async (error) => {
          app.log.warn(
            { err: error },
            "upstream refresh failed; showing recorded subscription costs",
          );
          return { ledger: await readLedger(db, config.demoUpstreamAccounts) };
        }),
        readOfflineAccountCosts(db, config.demoUpstreamAccounts),
      ]);
      const combinedLedger = [
        ...ledger,
        ...offlineAccountLedger(offlineAccounts),
      ];
      const visibleLedger =
        departmentScope === null
          ? combinedLedger
          : combinedLedger
              .map((account) => ({
                ...account,
                cycles: account.cycles
                  .filter(
                    (cycle) =>
                      normalizeAccountCostDepartment(cycle.department) ===
                      departmentScope,
                  )
                  .map((cycle) => ({ ...cycle, department: departmentScope })),
              }))
              .filter((account) => account.cycles.length > 0);
      const snapshots = ledgerMonths(visibleLedger);
      const legacy =
        role === "admin"
          ? await readCostMonths(db, config.demoUpstreamAccounts)
          : [];
      const selected = snapshots.filter((s) =>
        query.period === "month"
          ? s.month === value
          : s.month.startsWith(value + "-"),
      );
      const groups = new Map<
        string,
        ReturnType<typeof aggregateAccountCosts>[number]
      >();
      for (const snapshot of selected)
        for (const row of snapshot.items) {
          const group = groups.get(row.department) ?? {
            accounts: [],
            department: row.department,
            monthlyUsd: 0,
            accountCount: 0,
            unpricedCount: 0,
          };
          group.monthlyUsd += row.monthlyUsd;
          group.accounts = mergeAccountBreakdowns([
            ...group.accounts,
            ...row.accounts,
          ]);
          group.accountCount += row.accountCount;
          group.unpricedCount += row.unpricedCount;
          groups.set(row.department, group);
        }
      const items = [...groups.values()].sort(
        (a, b) =>
          b.monthlyUsd - a.monthlyUsd ||
          a.department.localeCompare(b.department, "zh-CN"),
      );
      const manualAccounts =
        role === "admin" ? ledgerManualAccounts(ledger) : [];
      return UsageAccountCostsResponseSchema.parse({
        departmentScope,
        pendingDateCount: visibleLedger
          .flatMap((account) => account.cycles)
          .filter((cycle) => cycle.month === null).length,
        legacySnapshotCount: role === "admin" ? legacy.length : 0,
        history: snapshots.sort((a, b) => a.month.localeCompare(b.month)),
        recordedMonths: selected.map((s) => s.month).sort(),
        availableMonths: snapshots.map((s) => s.month).sort(),
        demo: config.demoUpstreamAccounts,
        configured:
          config.demoUpstreamAccounts ||
          !!config.sub2api ||
          !!config.volcengine ||
          offlineAccounts.length > 0,
        items,
        manualAccounts,
        offlineAccounts: role === "admin" ? offlineAccounts : [],
        unpricedCount: items.reduce((sum, item) => sum + item.unpricedCount, 0),
      });
    },
  );
  const offlineAdminOnly = [
    authenticate,
    async (req: Parameters<typeof authOf>[0]) => {
      if (authOf(req).user.role !== "admin") throw forbidden();
    },
  ];
  app.post(
    "/admin/usage/account-costs/accounts",
    { preHandler: offlineAdminOnly },
    async (req, reply) => {
      const input = parseBody(OfflineAccountCostInputSchema, req.body);
      const account = await saveOfflineAccountCost(
        db,
        config.demoUpstreamAccounts,
        input,
      );
      req.log.info(
        { actor: authOf(req).user.id, accountId: account.id },
        "manual account added",
      );
      return reply.status(201).send(account);
    },
  );
  app.put(
    "/admin/usage/account-costs/accounts/:id",
    { preHandler: offlineAdminOnly },
    async (req) => {
      const { id } = parseBody(
        z.object({ id: z.coerce.number().int().safe().negative() }),
        req.params,
      );
      const input = parseBody(OfflineAccountCostInputSchema, req.body);
      const account = await saveOfflineAccountCost(
        db,
        config.demoUpstreamAccounts,
        input,
        id,
      );
      req.log.info(
        { actor: authOf(req).user.id, accountId: account.id },
        "manual account updated",
      );
      return account;
    },
  );
  app.delete(
    "/admin/usage/account-costs/accounts/:id",
    { preHandler: offlineAdminOnly },
    async (req, reply) => {
      const { id } = parseBody(
        z.object({ id: z.coerce.number().int().safe().negative() }),
        req.params,
      );
      await deleteOfflineAccountCost(db, config.demoUpstreamAccounts, id);
      req.log.info(
        { actor: authOf(req).user.id, accountId: id },
        "manual account and charges deleted",
      );
      return reply.status(204).send();
    },
  );
  app.put(
    "/admin/usage/account-costs/manual",
    {
      preHandler: [
        authenticate,
        async (req) => {
          if (authOf(req).user.role !== "admin") throw forbidden();
        },
      ],
    },
    async (req, reply) => {
      const body = parseBody(ManualAccountCostsRequestSchema, req.body);
      const { ledger } = await refreshLedger();
      const allowed = new Set(ledgerManualAccounts(ledger).map(manualCostKey));
      if (body.items.some((item) => !allowed.has(manualCostKey(item))))
        throw forbidden("Only pending subscription charges can be completed");
      await saveManualCosts(db, body.items);
      await refreshLedger();
      req.log.info(
        { actor: authOf(req).user.id, accounts: body.items.length },
        "manual subscription costs updated",
      );
      return reply.status(204).send();
    },
  );
}
