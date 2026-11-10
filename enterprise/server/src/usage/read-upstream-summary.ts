import {
  type UpstreamUsageSummaryQuery,
  type UsageSummary,
  UsageSummarySchema,
} from "@ccse/contracts";
import { z } from "zod";
import { AppError } from "../errors.ts";
import {
  listUpstreamUserEntries,
  readSub2Api,
  type Sub2ApiConfig,
} from "../sub2api.ts";

const StatsSchema = z.object({
  total_requests: z.number().int().nonnegative(),
  total_input_tokens: z.number().int().nonnegative(),
  total_output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
const NamedItemSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
});
const ListSchema = z.object({
  items: z.array(NamedItemSchema),
  total: z.number().int().nonnegative(),
});

export const emptyUsageSummary = (): UsageSummary => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

async function namedItems(cfg: Sub2ApiConfig, path: string) {
  const items: z.infer<typeof NamedItemSchema>[] = [];
  for (let page = 1; page <= 100; page++) {
    const list = ListSchema.parse(
      await readSub2Api(cfg, `${path}?page=${page}&page_size=100`),
    );
    items.push(...list.items);
    if (items.length >= list.total) return items;
    if (list.items.length === 0) break;
  }
  throw new Error("上游筛选列表分页不完整");
}

export async function readUpstreamUsageOptions(
  cfg: Sub2ApiConfig,
  groupName: string | null,
  accountIds: number[] | null,
) {
  const [keys, accounts, groups] = await Promise.all([
    listUpstreamUserEntries(cfg),
    namedItems(cfg, "/api/v1/admin/accounts"),
    namedItems(cfg, "/api/v1/admin/groups"),
  ]);
  return {
    users: keys
      .filter((key) => groupName === null || key.groupName === groupName)
      .map((key) => ({ id: `upstream-key:${key.id}`, username: key.name })),
    groups:
      groupName === null
        ? [...new Set(["", ...groups.map((group) => group.name)])]
        : groupName.trim()
          ? [groupName]
          : [],
    providers: [
      ...new Set(
        accounts
          .filter(
            (account) => accountIds === null || accountIds.includes(account.id),
          )
          .map((account) => account.name),
      ),
    ],
  };
}

/** Read server-side aggregates only; never fetch usage log pages. */
export async function readUpstreamSummary(
  cfg: Sub2ApiConfig,
  query: UpstreamUsageSummaryQuery,
): Promise<UsageSummary> {
  const users = [...new Set(query.userIds)];
  const keys = users.length
    ? users.flatMap((id) => {
        const match = /^upstream-key:([1-9]\d*)$/.exec(id);
        const key = match ? Number(match[1]) : NaN;
        return Number.isSafeInteger(key) ? [key] : [];
      })
    : [undefined];
  if (keys.length === 0) return emptyUsageSummary();

  let accounts: (number | undefined)[] = [undefined];
  if (query.providerIds.length) {
    const names = new Set(query.providerIds);
    accounts = (await namedItems(cfg, "/api/v1/admin/accounts"))
      .filter((account) => names.has(account.name))
      .map((account) => account.id);
    if (accounts.length === 0) return emptyUsageSummary();
  }

  let groups: { id?: number; sign: number }[] = [{ sign: 1 }];
  if (query.groups.length) {
    const names = new Set(query.groups);
    const all = await namedItems(cfg, "/api/v1/admin/groups");
    // The upstream API uses group_id=0 for "all". Ungrouped usage is
    // therefore the all-groups aggregate minus the other named groups.
    groups = names.has("")
      ? [
          { sign: 1 },
          ...all
            .filter((group) => !names.has(group.name))
            .map((group) => ({ id: group.id, sign: -1 })),
        ]
      : all
          .filter((group) => names.has(group.name))
          .map((group) => ({ id: group.id, sign: 1 }));
    if (groups.length === 0) return emptyUsageSummary();
  }

  const count = keys.length * accounts.length * groups.length;
  if (count > 200)
    throw new AppError(400, "bad_request", "筛选组合过多，请缩小筛选范围");
  const requests = keys.flatMap((key) =>
    accounts.flatMap((account) =>
      groups.map((group) => ({ key, account, group })),
    ),
  );
  const totals = emptyUsageSummary();
  for (let offset = 0; offset < requests.length; offset += 4) {
    const batch = await Promise.all(
      requests
        .slice(offset, offset + 4)
        .map(async ({ key, account, group }) => {
          const params = new URLSearchParams({
            start_date: query.from,
            end_date: query.to,
            timezone: "UTC",
          });
          if (key !== undefined) params.set("api_key_id", String(key));
          if (account !== undefined) params.set("account_id", String(account));
          if (group.id !== undefined) params.set("group_id", String(group.id));
          return {
            sign: group.sign,
            stats: StatsSchema.parse(
              await readSub2Api(cfg, `/api/v1/admin/usage/stats?${params}`),
            ),
          };
        }),
    );
    for (const { sign, stats } of batch) {
      totals.requests += sign * stats.total_requests;
      totals.inputTokens += sign * stats.total_input_tokens;
      totals.outputTokens += sign * stats.total_output_tokens;
      totals.totalTokens += sign * stats.total_tokens;
    }
  }
  return UsageSummarySchema.parse(totals);
}
