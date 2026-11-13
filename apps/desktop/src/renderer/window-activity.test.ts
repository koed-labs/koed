// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOW_INACTIVE_ATTRIBUTE,
  installWindowActivity
} from "./window-activity.js";

afterEach(() => vi.restoreAllMocks());

describe("window activity", () => {
  it("marks the root inactive while another app has focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const uninstall = installWindowActivity();
    const root = document.documentElement;
    try {
      expect(root.hasAttribute(WINDOW_INACTIVE_ATTRIBUTE)).toBe(false);
      window.dispatchEvent(new Event("blur"));
      expect(root.hasAttribute(WINDOW_INACTIVE_ATTRIBUTE)).toBe(true);
      window.dispatchEvent(new Event("focus"));
      expect(root.hasAttribute(WINDOW_INACTIVE_ATTRIBUTE)).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("starts inactive when the window opens without focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const uninstall = installWindowActivity();
    try {
      expect(
        document.documentElement.hasAttribute(WINDOW_INACTIVE_ATTRIBUTE)
      ).toBe(true);
    } finally {
      uninstall();
    }
    expect(
      document.documentElement.hasAttribute(WINDOW_INACTIVE_ATTRIBUTE)
    ).toBe(false);
  });

  it("pauses only looping animations and resumes them on focus", () => {
    const animation = (iterations: number) => {
      const value = {
        playState: "running",
        effect: { getTiming: () => ({ iterations }) },
        pause: vi.fn(() => {
          value.playState = "paused";
        }),
        play: vi.fn(() => {
          value.playState = "running";
        })
      };
      return value;
    };
    const spinner = animation(Infinity);
    const exit = animation(1);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "getAnimations", {
      configurable: true,
      value: () => [spinner, exit]
    });
    const uninstall = installWindowActivity();
    try {
      window.dispatchEvent(new Event("blur"));
      expect(spinner.pause).toHaveBeenCalledOnce();
      expect(exit.pause).not.toHaveBeenCalled();
      window.dispatchEvent(new Event("focus"));
      expect(spinner.play).toHaveBeenCalledOnce();
      expect(exit.play).not.toHaveBeenCalled();
    } finally {
      uninstall();
      delete (document as { getAnimations?: unknown }).getAnimations;
    }
  });
});
