import { describe, expect, it } from "vitest";
import { canManageLocalProviders } from "@/contexts/AuthContext";

describe("canManageLocalProviders", () => {
  it("lets signed-out users add local cards", () => {
    expect(canManageLocalProviders(false, [])).toBe(true);
  });

  it("lets members add their own local cards", () => {
    expect(canManageLocalProviders(true, ["models.use", "market.install"])).toBe(
      true,
    );
  });

  it("lets admins add local cards via models.use", () => {
    expect(canManageLocalProviders(true, ["providers.manage", "models.use"])).toBe(
      true,
    );
  });

  it("keeps viewers read-only", () => {
    expect(canManageLocalProviders(true, [])).toBe(false);
  });

  it("does not treat providers.manage as the desktop add gate", () => {
    expect(canManageLocalProviders(true, ["providers.manage"])).toBe(false);
  });
});
