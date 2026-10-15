import type { Permission } from "@ccse/contracts";

export interface NavItem {
  path: string;
  label: string;
  /** Any of these grants access to the page. */
  anyOf: readonly Permission[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/users", label: "用户管理", anyOf: ["users.manage"] },
  // The union of the tab permissions below (DEVICE_TABS).
  {
    path: "/devices",
    label: "设备管理",
    anyOf: ["settings.manage", "providers.manage"],
  },
  { path: "/usage", label: "用量统计", anyOf: ["audit.read"] },
  { path: "/upstream", label: "上游账号", anyOf: ["audit.read"] },
  { path: "/mcp", label: "MCP", anyOf: ["market.manage"] },
  { path: "/connectors", label: "连接器", anyOf: ["market.manage"] },
  { path: "/skills", label: "Skills", anyOf: ["market.manage"] },
  { path: "/prompts", label: "提示词", anyOf: ["market.manage"] },
  { path: "/conversations", label: "会话", anyOf: ["audit.read"] },
];

/** A tab inside a page; `id` is the value of the `?tab=` query parameter. */
export interface TabItem {
  id: string;
  label: string;
  /** Any of these shows the tab. */
  anyOf: readonly Permission[];
}

export const DEVICE_TABS: readonly TabItem[] = [
  { id: "devices", label: "设备", anyOf: ["settings.manage"] },
  { id: "profiles", label: "配置方案", anyOf: ["settings.manage"] },
  { id: "providers", label: "模型与网关", anyOf: ["providers.manage"] },
];

export const CONVERSATION_TABS: readonly TabItem[] = [
  { id: "records", label: "对话记录", anyOf: ["audit.read"] },
  // Viewing needs audit.read (server GET); editing additionally settings.manage.
  { id: "retention", label: "留存策略", anyOf: ["audit.read"] },
];

export function canAccess(
  permissions: readonly Permission[],
  item: { anyOf: readonly Permission[] },
): boolean {
  return item.anyOf.some((p) => permissions.includes(p));
}

export function navItemsFor(permissions: readonly Permission[]): NavItem[] {
  return NAV_ITEMS.filter((item) => canAccess(permissions, item));
}

export function tabsFor<T extends TabItem>(
  permissions: readonly Permission[],
  tabs: readonly T[],
): T[] {
  return tabs.filter((tab) => canAccess(permissions, tab));
}
