import { describe, expect, it, vi } from "vitest";

import {
  consumeDesktopActivation,
  createDesktopWindowActivator,
  shouldQuitAfterAllWindowsClosed,
  type DesktopWindowHandle
} from "./lifecycle.js";

describe("Desktop window lifecycle", () => {
  it("keeps the app running on Linux so the tray can reopen the window", () => {
    expect(shouldQuitAfterAllWindowsClosed("linux")).toBe(false);
  });

  it("keeps the existing macOS window lifecycle", () => {
    expect(shouldQuitAfterAllWindowsClosed("darwin")).toBe(false);
  });

  it("keeps the app running on Windows so the tray can reopen the window", () => {
    expect(shouldQuitAfterAllWindowsClosed("win32")).toBe(false);
  });

  it("suppresses only the initial macOS background activation", () => {
    const initial = consumeDesktopActivation(true);
    expect(initial).toEqual({
      backgroundLaunchPending: false,
      openWindow: false
    });

    expect(consumeDesktopActivation(initial.backgroundLaunchPending)).toEqual({
      backgroundLaunchPending: false,
      openWindow: true
    });
  });

  it("waits for bootstrap before creating a window", async () => {
    let finishBootstrap!: () => void;
    const bootstrap = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    const createWindow = vi.fn(async () => undefined);
    const activate = createDesktopWindowActivator({
      createWindow,
      getWindow: () => null,
      waitForBootstrap: () => bootstrap
    });

    const activation = activate();
    await Promise.resolve();
    expect(createWindow).not.toHaveBeenCalled();

    finishBootstrap();
    await activation;
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent window creation", async () => {
    let finishCreation!: () => void;
    const creation = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    const createWindow = vi.fn(() => creation);
    const activate = createDesktopWindowActivator({
      createWindow,
      getWindow: () => null,
      waitForBootstrap: async () => undefined
    });

    const firstActivation = activate();
    const secondActivation = activate();
    await Promise.resolve();
    await Promise.resolve();
    expect(createWindow).toHaveBeenCalledOnce();

    finishCreation();
    await Promise.all([firstActivation, secondActivation]);
  });

  it("restores and focuses an existing window", async () => {
    const window: DesktopWindowHandle = {
      focus: vi.fn(),
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn()
    };
    const createWindow = vi.fn(async () => undefined);
    const activate = createDesktopWindowActivator({
      createWindow,
      getWindow: () => window,
      waitForBootstrap: async () => undefined
    });

    await activate();

    expect(createWindow).not.toHaveBeenCalled();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("restores app-level visibility before opening a window", async () => {
    const order: string[] = [];
    const activate = createDesktopWindowActivator({
      beforeOpen: () => {
        order.push("app");
      },
      createWindow: async () => {
        order.push("window");
      },
      getWindow: () => null,
      waitForBootstrap: async () => undefined
    });

    await activate();

    expect(order).toEqual(["app", "window"]);
  });
});
