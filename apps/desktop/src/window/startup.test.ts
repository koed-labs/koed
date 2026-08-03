import { describe, expect, it, vi } from "vitest";

import { startDesktopWindowAndRuntime } from "./startup.js";

describe("Desktop startup", () => {
  it("shows the window without waiting for runtime recovery", async () => {
    let releaseRuntime!: () => void;
    const runtime = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const order: string[] = [];
    const createWindow = vi.fn(async () => {
      order.push("window");
    });
    const resumeRuntime = vi.fn(async () => {
      order.push("resume-started");
      await runtime;
      order.push("resume-complete");
    });

    await expect(
      startDesktopWindowAndRuntime({ createWindow, resumeRuntime })
    ).resolves.toBeUndefined();
    expect(order).toEqual(["window", "resume-started"]);

    releaseRuntime();
    await runtime;
  });

  it("contains background runtime failures after the window is available", async () => {
    const createWindow = vi.fn(async () => undefined);
    const resumeRuntime = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });

    await expect(
      startDesktopWindowAndRuntime({ createWindow, resumeRuntime })
    ).resolves.toBeUndefined();
    expect(createWindow).toHaveBeenCalledOnce();
    expect(resumeRuntime).toHaveBeenCalledOnce();
  });
});
