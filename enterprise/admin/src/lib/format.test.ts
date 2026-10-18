import { describe, expect, it } from "vitest";
import {
  lastUtcDays,
  matchingUtcPreset,
  rangeForPreset,
} from "./format";

const now = new Date("2026-10-18T12:00:00.000Z");

describe("rangeForPreset", () => {
  it("maps named presets to UTC dates at a frozen now", () => {
    expect(rangeForPreset("today", now)).toEqual(["2026-10-18", "2026-10-18"]);
    expect(rangeForPreset("yesterday", now)).toEqual([
      "2026-10-17",
      "2026-10-17",
    ]);
    expect(rangeForPreset("last24h", now)).toEqual([
      "2026-10-17",
      "2026-10-18",
    ]);
    expect(rangeForPreset("last7d", now)).toEqual(["2026-10-12", "2026-10-18"]);
    expect(rangeForPreset("last14d", now)).toEqual([
      "2026-10-05",
      "2026-10-18",
    ]);
    expect(rangeForPreset("last30d", now)).toEqual([
      "2026-09-19",
      "2026-10-18",
    ]);
    expect(rangeForPreset("thisMonth", now)).toEqual([
      "2026-10-01",
      "2026-10-18",
    ]);
    expect(rangeForPreset("lastMonth", now)).toEqual([
      "2026-09-01",
      "2026-09-30",
    ]);
  });

  it("last7d matches lastUtcDays(7)", () => {
    expect(rangeForPreset("last7d", now)).toEqual(lastUtcDays(7, now));
  });
});

describe("matchingUtcPreset", () => {
  it("recognizes presets before falling back to custom", () => {
    expect(matchingUtcPreset("2026-10-18", "2026-10-18", now)).toBe("today");
    expect(matchingUtcPreset("2026-10-12", "2026-10-18", now)).toBe("last7d");
    expect(matchingUtcPreset("2026-10-01", "2026-10-10", now)).toBe("custom");
  });

  it("prefers today over thisMonth on the 1st", () => {
    const first = new Date("2026-10-01T08:00:00.000Z");
    expect(matchingUtcPreset("2026-10-01", "2026-10-01", first)).toBe("today");
  });
});
