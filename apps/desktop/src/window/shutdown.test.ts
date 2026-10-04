import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopShutdown } from "./shutdown.js";

afterEach(() => vi.useRealTimers());

describe("Desktop shutdown", () => {
  it("cleans up once when Quit is requested repeatedly", async () => {
    const cleanup = vi.fn(async () => undefined);
    const finish = vi.fn();
    const quit = createDesktopShutdown({ cleanup, finish });
    const first = quit();
    expect(quit()).toBe(first);
    await first;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("finishes quitting when cleanup rejects", async () => {
    const finish = vi.fn();
    const quit = createDesktopShutdown({
      cleanup: async () => {
        throw new Error("Unavailable service");
      },
      finish
    });
    await quit();
    expect(finish).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("forces exit after the deadline and ignores late cleanup", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const finish = vi.fn();
    const quit = createDesktopShutdown({
      cleanup: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      finish,
      timeoutMs: 100
    });
    const pending = quit();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(finish).toHaveBeenCalledExactlyOnceWith(true);
    release();
    await vi.runAllTimersAsync();
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
