import { permissionsForRole } from "@ccse/contracts";
import { describe, expect, it } from "vitest";
import { CONVERSATION_TABS, DEVICE_TABS, navItemsFor, tabsFor } from "./nav";

describe("navItemsFor", () => {
  it("shows every page to admins", () => {
    expect(
      navItemsFor(permissionsForRole("admin")).map((i) => i.label),
    ).toEqual([
      "用户管理",
      "设备管理",
      "用量统计",
      "上游账号",
      "MCP",
      "连接器",
      "Skills",
      "提示词",
      "会话",
    ]);
  });

  it("shows nothing to members and viewers", () => {
    expect(navItemsFor(permissionsForRole("member"))).toEqual([]);
    expect(navItemsFor(permissionsForRole("viewer"))).toEqual([]);
  });

  it("shows audit pages for audit.read only", () => {
    expect(navItemsFor(["audit.read"]).map((i) => i.path)).toEqual([
      "/usage",
      "/upstream",
      "/conversations",
    ]);
  });

  it("shows device management for either settings or providers", () => {
    expect(navItemsFor(["settings.manage"]).map((i) => i.path)).toEqual([
      "/devices",
    ]);
    expect(navItemsFor(["providers.manage"]).map((i) => i.path)).toEqual([
      "/devices",
    ]);
  });

  it("shows the market pages for market.manage", () => {
    expect(navItemsFor(["market.manage"]).map((i) => i.path)).toEqual([
      "/mcp",
      "/connectors",
      "/skills",
      "/prompts",
    ]);
  });
});

describe("tabsFor", () => {
  it("filters device tabs by permission", () => {
    const ids = (p: Parameters<typeof tabsFor>[0]) =>
      tabsFor(p, DEVICE_TABS).map((t) => t.id);
    expect(ids(permissionsForRole("admin"))).toEqual([
      "devices",
      "profiles",
      "providers",
    ]);
    expect(ids(["settings.manage"])).toEqual(["devices", "profiles"]);
    expect(ids(["providers.manage"])).toEqual(["providers"]);
    expect(ids([])).toEqual([]);
  });

  it("shows both conversation tabs for audit.read", () => {
    expect(tabsFor(["audit.read"], CONVERSATION_TABS).map((t) => t.id)).toEqual(
      ["records", "retention"],
    );
  });
});
