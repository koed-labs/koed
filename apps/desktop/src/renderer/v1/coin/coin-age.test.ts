import { describe, expect, it } from "vitest";
import { coinAge } from "./coin-age.js";

describe("coin age", () => {
  const now = new Date("2026-11-26T15:00:00.000Z");
  it("gleams when active today and tarnishes after 30 days untouched", () => {
    expect(coinAge("2026-11-26T09:00:00.000Z", now)).toBe("fresh");
    expect(coinAge("2026-11-20T09:00:00.000Z", now)).toBe("current");
    expect(coinAge("2026-10-01T09:00:00.000Z", now)).toBe("aged");
  });
  it("treats an unreadable time as current", () => {
    expect(coinAge("not a date", now)).toBe("current");
  });
});
