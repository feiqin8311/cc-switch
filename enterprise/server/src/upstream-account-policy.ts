/** Shared exclusion for live synchronization and previously recorded subscriptions. */
export function isGrokAccount(account: {
  platform?: unknown;
  name?: unknown;
  groups?: unknown;
  account_groups?: unknown;
}): boolean {
  const platform =
    typeof account.platform === "string"
      ? account.platform.trim().toLowerCase()
      : "";
  if (platform === "xai" || platform === "x.ai") return true;
  const groups = account.groups ?? account.account_groups;
  const names = Array.isArray(groups)
    ? groups.map((group: unknown) =>
        group && typeof group === "object" && "name" in group
          ? group.name
          : group,
      )
    : [];
  return [account.platform, account.name, ...names].some(
    (value) => typeof value === "string" && /grok/i.test(value),
  );
}
