import {
  CODING_PLAN_ACCOUNT_ID,
  CODING_PLAN_ACCOUNT_NAME,
  ManualAccountCostsRequestSchema,
  UsageAccountCostsResponseSchema,
} from "@ccse/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { authOf, requireAnyPermission } from "../auth/guard.ts";
import { forbidden, parseBody } from "../errors.ts";
import { listUpstreamAccounts } from "../sub2api.ts";
import {
  accountDepartment,
  aggregateAccountCosts,
  monthlySubscriptionUsd,
  manualCostKey,
  readManualCosts,
  saveManualCosts,
} from "../usage/account-costs.ts";

export async function accountCostsRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  const { authenticate, config, readCodingPlan, db } = deps;
  const liveAccounts = async () => {
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
      const [accounts, overrides] = await Promise.all([
        liveAccounts(),
        readManualCosts(db),
      ]);
      const items = aggregateAccountCosts(accounts, overrides);
      const manualAccounts =
        role === "admin"
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
        configured: !!config.sub2api || !!config.volcengine,
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
      req.log.info(
        { actor: authOf(req).user.id, accounts: body.items.length },
        "manual subscription costs updated",
      );
      return reply.status(204).send();
    },
  );
}
