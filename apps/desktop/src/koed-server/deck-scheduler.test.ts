import { describe, expect, it } from "vitest";
import { nextDeckProgress } from "./deck-scheduler.js";

describe("Deck study schedule", () => {
  it("uses the approved Good and Easy ladder and resets on Again", () => {
    const now = new Date("2026-10-21T12:00:00.000Z");
    const good = [1, 3, 7, 14, 30];
    const easy = [3, 7, 14, 30, 60];
    for (let box = 0; box < 5; box++) {
      const g = nextDeckProgress({ box, misses: 2 }, "good", now);
      const e = nextDeckProgress({ box, misses: 2 }, "easy", now);
      expect(g.box).toBe(box + 1);
      expect(e.box).toBe(box + 1);
      expect(
        Math.round(
          (Date.parse(g.nextAt) - new Date(2026, 9, 21).getTime()) / 86_400_000
        )
      ).toBe(good[box]);
      expect(
        Math.round(
          (Date.parse(e.nextAt) - new Date(2026, 9, 21).getTime()) / 86_400_000
        )
      ).toBe(easy[box]);
    }
    expect(nextDeckProgress({ box: 4, misses: 2 }, "again", now)).toEqual({
      box: 0,
      misses: 3,
      nextAt: now.toISOString()
    });
    expect(nextDeckProgress({ box: 5, misses: 2 }, "good", now).box).toBe(5);
  });
});
