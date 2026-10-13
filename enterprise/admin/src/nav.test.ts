import { permissionsForRole } from "@ccse/contracts";
import { describe, expect, it } from "vitest";
import { navItemsFor } from "./nav";

describe("navItemsFor", () => {
  it("shows every page to admins", () => {
    expect(
      navItemsFor(permissionsForRole("admin")).map((i) => i.label),
    ).toEqual([
      "用户管理",
      "模型与网关",
      "用量统计",
      "对话审计",
      "留存策略",
      "技能与插件市场",
    ]);
  });

  it("shows nothing to members and viewers", () => {
    expect(navItemsFor(permissionsForRole("member"))).toEqual([]);
    expect(navItemsFor(permissionsForRole("viewer"))).toEqual([]);
  });

  it("shows audit pages for audit.read only", () => {
    expect(navItemsFor(["audit.read"]).map((i) => i.path)).toEqual([
      "/usage",
      "/conversations",
      "/retention",
    ]);
  });
});
