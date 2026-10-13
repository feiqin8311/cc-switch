import type { Permission } from "@ccse/contracts";

export interface NavItem {
  path: string;
  label: string;
  /** Any of these grants access to the page. */
  anyOf: readonly Permission[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/users", label: "用户管理", anyOf: ["users.manage"] },
  { path: "/providers", label: "模型与网关", anyOf: ["providers.manage"] },
  { path: "/usage", label: "用量统计", anyOf: ["audit.read"] },
  { path: "/conversations", label: "对话审计", anyOf: ["audit.read"] },
  // Viewing needs audit.read (server GET); editing additionally settings.manage.
  { path: "/retention", label: "留存策略", anyOf: ["audit.read"] },
  { path: "/market", label: "技能与插件市场", anyOf: ["market.manage"] },
];

export function canAccess(
  permissions: readonly Permission[],
  item: NavItem,
): boolean {
  return item.anyOf.some((p) => permissions.includes(p));
}

export function navItemsFor(permissions: readonly Permission[]): NavItem[] {
  return NAV_ITEMS.filter((item) => canAccess(permissions, item));
}
