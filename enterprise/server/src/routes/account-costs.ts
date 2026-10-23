import {
  CODING_PLAN_ACCOUNT_ID,
  CODING_PLAN_ACCOUNT_NAME,
  ManualAccountCostsRequestSchema,
  UsageAccountCostsResponseSchema,
} from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { authOf, requireAnyPermission } from "../auth/guard.ts";
import { forbidden, parseBody } from "../errors.ts";
import { demoUpstreamAccounts } from "../demo-upstream.ts";
import { listUpstreamAccounts } from "../sub2api.ts";
import {
  accountDepartment,
  aggregateAccountCosts,
  monthlySubscriptionUsd,
  manualCostKey,
  readManualCosts,
  saveManualCosts,
  currentCostMonth,
  saveCostMonth,
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
            },
          ]
        : []),
    ];
  };
  const refreshSnapshot = async () => {
    const month = currentCostMonth();
    const [accounts, overrides] = await Promise.all([
      liveAccounts(),
      readManualCosts(db),
    ]);
    const items = aggregateAccountCosts(accounts, overrides);
    if (config.demoUpstreamAccounts || config.sub2api || config.volcengine)
      await saveCostMonth(db, month, items, config.demoUpstreamAccounts);
    return { accounts, overrides };
  };
  // Record independently of dashboard visits. Closed months are never rewritten.
  if (config.env !== "test") {
    let running = false;
    const record = async () => {
      if (running) return;
      running = true;
      try {
        await refreshSnapshot();
      } catch (error) {
        app.log.error({ err: error }, "subscription snapshot failed");
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
      const role = authOf(req).user.role;
      if (role !== "admin" && role !== "leader") throw forbidden();
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
      const isCurrent =
        query.period === "month"
          ? value === current
          : value === current.slice(0, 4);
      const { accounts, overrides } = isCurrent
        ? await refreshSnapshot()
        : { accounts: [], overrides: new Map() };
      const snapshots = await readCostMonths(db, config.demoUpstreamAccounts);
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
            department: row.department,
            monthlyUsd: 0,
            accountCount: 0,
            unpricedCount: 0,
          };
          group.monthlyUsd += row.monthlyUsd;
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
        role === "admin" && isCurrent
          ? accounts.flatMap((account) => {
              const department = accountDepartment(account.name);
              if (!department || monthlySubscriptionUsd(account) !== null)
                return [];
              const identity = {
                accountId: account.id,
                platform: account.platform,
                planType: account.planType,
              };
              return [
                {
                  ...identity,
                  name: account.name,
                  department,
                  monthlyUsd:
                    overrides.get(manualCostKey(identity))?.monthlyUsd ?? null,
                },
              ];
            })
          : [];
      return UsageAccountCostsResponseSchema.parse({
        history: snapshots.sort((a, b) => a.month.localeCompare(b.month)),
        recordedMonths: selected.map((s) => s.month).sort(),
        availableMonths: snapshots.map((s) => s.month).sort(),
        demo: config.demoUpstreamAccounts,
        configured:
          config.demoUpstreamAccounts ||
          !!config.sub2api ||
          !!config.volcengine,
        items,
        manualAccounts,
        unpricedCount: items.reduce((sum, item) => sum + item.unpricedCount, 0),
      });
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
      const accounts = await liveAccounts();
      const allowed = new Set(
        accounts
          .filter(
            (account) =>
              accountDepartment(account.name) &&
              monthlySubscriptionUsd(account) === null,
          )
          .map((account) =>
            manualCostKey({
              accountId: account.id,
              platform: account.platform,
              planType: account.planType,
            }),
          ),
      );
      if (body.items.some((item) => !allowed.has(manualCostKey(item))))
        throw forbidden(
          "Only current unrecognized subscriptions can be edited",
        );
      await saveManualCosts(db, body.items);
      await refreshSnapshot();
      req.log.info(
        { actor: authOf(req).user.id, accounts: body.items.length },
        "manual subscription costs updated",
      );
      return reply.status(204).send();
    },
  );
}
