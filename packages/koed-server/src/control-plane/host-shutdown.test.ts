import { describe, expect, it, vi } from "vitest";
import { createControlPlaneShutdown } from "./host-shutdown.js";
import type { HostCore } from "./host-core.js";

function fixture(initial: string, settled = true) {
  let state = initial;
  let isSettled = settled;
  const core = {
    status: () => ({ state }),
    stop: vi.fn(),
    settled: () => isSettled
  } as unknown as HostCore;
  const close = vi.fn(async () => {});
  const closeUncertain = vi.fn(async () => {});
  const log = vi.fn();
  const shutdown = createControlPlaneShutdown({
    core,
    close,
    closeUncertain,
    fatal: () => undefined,
    log,
    pollMs: 5
  });
  return {
    shutdown,
    core,
    close,
    closeUncertain,
    log,
    set: (next: string, nextSettled = true) => {
      state = next;
      isSettled = nextSettled;
    }
  };
}

describe("control-plane shutdown", () => {
  it("closes the host and exits 0 once stopped", async () => {
    const f = fixture("stopped");
    f.shutdown.request();
    expect(await f.shutdown.done).toBe(0);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("exits non-zero on SIGTERM when already in needs_attention", async () => {
    const f = fixture("needs_attention");
    f.shutdown.request();
    expect(await f.shutdown.done).toBe(1);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.closeUncertain).toHaveBeenCalledOnce();
    expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/uncertain/));
  });
  it("waits for a still-running session before exiting from needs_attention", async () => {
    const f = fixture("needs_attention", false);
    f.shutdown.request();
    await new Promise((r) => setTimeout(r, 30));
    let exited = false;
    void f.shutdown.done.then(() => (exited = true));
    await Promise.resolve();
    expect(exited).toBe(false);
    f.set("needs_attention", true);
    expect(await f.shutdown.done).toBe(1);
  });
  it("exits non-zero when a stopping runtime ends uncertain", async () => {
    const f = fixture("stopping", false);
    f.shutdown.request();
    f.set("needs_attention");
    expect(await f.shutdown.done).toBe(1);
  });
  it("closes uncertain transport once settled if status can no longer be read", async () => {
    const f = fixture("stopping", false);
    const status = vi.spyOn(f.core, "status").mockImplementation(() => {
      throw new Error("state unreadable");
    });
    f.shutdown.request();
    expect(status).not.toHaveBeenCalled();
    f.set("needs_attention");
    expect(await f.shutdown.done).toBe(1);
    expect(f.closeUncertain).toHaveBeenCalledOnce();
    expect(f.close).not.toHaveBeenCalled();
  });
  it("ignores repeated requests", () => {
    const f = fixture("stopped");
    f.shutdown.request();
    f.shutdown.request();
    expect(f.core.stop).toHaveBeenCalledOnce();
  });
});
