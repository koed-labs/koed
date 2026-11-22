import { describe, expect, it, vi } from "vitest";
import {
  createKinHandoff,
  resolveKinPlacement
} from "./floating-kin-placement.js";

describe("Chief of Staff placement", () => {
  it.each([
    [true, true, true, "home"],
    [true, true, false, "desktop"],
    [true, false, true, "desktop"],
    [true, false, false, "desktop"],
    [false, true, true, "home"],
    [false, true, false, "home"],
    [false, false, true, "sidebar"],
    [false, false, false, "sidebar"]
  ] as const)(
    "floating %s, Home %s, focused %s → %s",
    (floatingEnabled, home, mainFocused, placement) => {
      expect(resolveKinPlacement({ floatingEnabled, home, mainFocused })).toBe(
        placement
      );
    }
  );

  it("waits for the current renderer exit rather than counting from the placement change", () => {
    vi.useFakeTimers();
    try {
      const hide = vi.fn();
      const handoff = createKinHandoff({ show: vi.fn(), hide, slide: vi.fn() });
      handoff.setVisible(true, 0);
      handoff.setVisible(false, 1);
      vi.advanceTimersByTime(400);
      expect(hide).not.toHaveBeenCalled();
      handoff.completeExit(0);
      expect(hide).not.toHaveBeenCalled();
      handoff.completeExit(1);
      expect(hide).toHaveBeenCalledOnce();
      vi.runAllTimers();
      expect(hide).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides immediately when reduced motion is enabled", () => {
    const hide = vi.fn();
    const handoff = createKinHandoff({
      show: vi.fn(),
      hide,
      slide: vi.fn(),
      reducedMotion: () => true
    });
    handoff.setVisible(true, 0);
    handoff.setVisible(false, 1);
    expect(hide).toHaveBeenCalledOnce();
  });

  it("cancels a delayed hide when the overlay is needed again", () => {
    const show = vi.fn();
    const hide = vi.fn();
    const slide = vi.fn();
    vi.useFakeTimers();
    try {
      const handoff = createKinHandoff({ show, hide, slide });
      handoff.setVisible(true, 0);
      handoff.setVisible(false, 1);
      expect(slide).toHaveBeenLastCalledWith(false);
      expect(hide).not.toHaveBeenCalled();
      handoff.setVisible(true, 2);
      handoff.completeExit(1);
      vi.runAllTimers();
      expect(hide).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledTimes(2);
      handoff.setVisible(false, 3);
      handoff.completeExit(1);
      expect(hide).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(hide).toHaveBeenCalledOnce();
      handoff.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
