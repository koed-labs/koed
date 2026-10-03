import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverPiResourcesInChild,
  type PiDiscoveryChild
} from "./ai-client-resource-pi-discovery-process.js";

class HeldPiChild extends EventEmitter implements PiDiscoveryChild {
  killed = false;

  constructor(
    private readonly onTerminated: () => void,
    private readonly onSend?: (child: HeldPiChild) => void
  ) {
    super();
  }

  send(): boolean {
    this.onSend?.(this);
    return true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    expect(signal).toBe("SIGKILL");
    this.killed = true;
    this.emit("exit", null, signal);
    this.onTerminated();
    return true;
  }
}

describe("Pi resource discovery process", () => {
  afterEach(() => vi.useRealTimers());

  it("kills a stuck loader at deadline so repeated retries do not leave children alive", async () => {
    vi.useFakeTimers();
    const children: HeldPiChild[] = [];
    let activeChildren = 0;
    const forkChild = vi.fn(() => {
      activeChildren += 1;
      const child = new HeldPiChild(() => {
        activeChildren -= 1;
      });
      children.push(child);
      return child;
    });
    const discoverOnce = () =>
      discoverPiResourcesInChild({
        cwd: "/private/project",
        executablePath: "/private/pi/bin/pi",
        configHome: "/private/pi/config",
        environment: { PATH: "/private/pi/bin" },
        timeoutMs: 1_000,
        forkChild,
        resolveInstallation: () => ({
          sdkEntryPath: "/private/pi/sdk.mjs",
          execPath: process.execPath,
          execArgv: [],
          environment: { PATH: "/private/pi/bin" }
        })
      });

    const first = discoverOnce();
    const firstRejection = expect(first).rejects.toThrow(
      "AiClientResourceDiscoveryTimedOut"
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await firstRejection;
    expect(children[0]?.killed).toBe(true);
    expect(activeChildren).toBe(0);

    const second = discoverOnce();
    const secondRejection = expect(second).rejects.toThrow(
      "AiClientResourceDiscoveryTimedOut"
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await secondRejection;
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.killed)).toBe(true);
    expect(activeChildren).toBe(0);
    expect(forkChild).toHaveBeenCalledTimes(2);
  });

  it("kills the child when its IPC response is malformed", async () => {
    const child = new HeldPiChild(
      () => undefined,
      (target) => queueMicrotask(() => target.emit("message", { ok: true }))
    );
    const operation = discoverPiResourcesInChild({
      cwd: "/private/project",
      executablePath: "/private/pi/bin/pi",
      configHome: "/private/pi/config",
      environment: { PATH: "/private/pi/bin" },
      forkChild: () => child,
      resolveInstallation: () => ({
        sdkEntryPath: "/private/pi/sdk.mjs",
        execPath: process.execPath,
        execArgv: [],
        environment: { PATH: "/private/pi/bin" }
      })
    });
    const rejection = expect(operation).rejects.toThrow(
      "AiClientPiUnavailable"
    );

    await rejection;
    expect(child.killed).toBe(true);
  });
});
