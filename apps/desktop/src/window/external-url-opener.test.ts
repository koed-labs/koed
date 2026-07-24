import { describe, expect, it, vi } from "vitest";

import { createExternalUrlOpener } from "./external-url-opener.js";

describe("external URL opener", () => {
  it("uses the direct Windows URL handler under WSL", async () => {
    const runProcess = vi.fn(async () => undefined);
    const fallback = vi.fn(async () => undefined);
    const openExternal = createExternalUrlOpener({
      environment: { WSL_DISTRO_NAME: "Ubuntu" },
      existsSync: () => true,
      fallback,
      platform: "linux",
      runProcess
    });

    await openExternal("https://next.koed.ai/approve?challenge=one&step=2");

    expect(runProcess).toHaveBeenCalledWith(
      "/mnt/c/Windows/System32/rundll32.exe",
      [
        "url.dll,FileProtocolHandler",
        "https://next.koed.ai/approve?challenge=one&step=2"
      ],
      { cwd: "/mnt/c/Windows", timeout: 5_000 }
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it("keeps Electron's launcher on native platforms", async () => {
    const runProcess = vi.fn(async () => undefined);
    const fallback = vi.fn(async () => undefined);
    const openExternal = createExternalUrlOpener({
      environment: {},
      existsSync: () => true,
      fallback,
      platform: "darwin",
      runProcess
    });

    await openExternal("https://next.koed.ai/approve");

    expect(runProcess).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith("https://next.koed.ai/approve");
  });

  it("falls back when the WSL handoff fails", async () => {
    const fallback = vi.fn(async () => undefined);
    const openExternal = createExternalUrlOpener({
      environment: { WSL_INTEROP: "/run/WSL/interop" },
      existsSync: () => true,
      fallback,
      platform: "linux",
      runProcess: vi.fn(async () => {
        throw new Error("Windows handoff failed");
      })
    });

    await openExternal("mailto:member@example.test");

    expect(fallback).toHaveBeenCalledWith("mailto:member@example.test");
  });

  it("rejects untrusted schemes before either launcher runs", async () => {
    const runProcess = vi.fn(async () => undefined);
    const fallback = vi.fn(async () => undefined);
    const openExternal = createExternalUrlOpener({
      environment: { WSL_DISTRO_NAME: "Ubuntu" },
      existsSync: () => true,
      fallback,
      platform: "linux",
      runProcess
    });

    await expect(openExternal("file:///etc/passwd")).rejects.toThrow(
      "A supported external URL is required."
    );
    expect(runProcess).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});
