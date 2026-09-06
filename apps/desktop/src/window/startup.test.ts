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
    const onRuntimeSettled = vi.fn();

    await expect(
      startDesktopWindowAndRuntime({
        background: false,
        createWindow,
        resumeRuntime,
        onRuntimeSettled
      })
    ).resolves.toBeUndefined();
    expect(order).toEqual(["window", "resume-started"]);
    expect(onRuntimeSettled).not.toHaveBeenCalled();

    releaseRuntime();
    await vi.waitFor(() => expect(onRuntimeSettled).toHaveBeenCalledOnce());
  });

  it("contains background runtime failures after the window is available", async () => {
    const createWindow = vi.fn(async () => undefined);
    const resumeRuntime = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });
    const onRuntimeSettled = vi.fn();

    await expect(
      startDesktopWindowAndRuntime({
        background: false,
        createWindow,
        resumeRuntime,
        onRuntimeSettled
      })
    ).resolves.toBeUndefined();
    expect(createWindow).toHaveBeenCalledOnce();
    expect(resumeRuntime).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(onRuntimeSettled).toHaveBeenCalledOnce());
  });

  it("resumes the runtime without creating a background startup window", async () => {
    const createWindow = vi.fn(async () => undefined);
    const resumeRuntime = vi.fn(async () => undefined);

    await expect(
      startDesktopWindowAndRuntime({
        background: true,
        createWindow,
        resumeRuntime
      })
    ).resolves.toBeUndefined();

    expect(createWindow).not.toHaveBeenCalled();
    expect(resumeRuntime).toHaveBeenCalledOnce();
  });
});
