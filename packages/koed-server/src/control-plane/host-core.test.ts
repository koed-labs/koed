import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { createControlStateStore } from "./state.js";
import { createControlPlaneHostCore } from "./host-core.js";
import type { ControlIntent, ControlStateStore } from "./state.js";

function fixture(initial: Partial<ControlIntent> = {}) {
  let state: ControlIntent = {
    schemaVersion: 1,
    revision: 0,
    stopIntent: false,
    backgroundEnabled: false,
    persistentCli: false,
    runtimeClean: true,
    protectedGenerationId: null,
    ...initial
  };
  const store: ControlStateStore = {
    read: () => ({ ...state }),
    initialize: vi.fn(),
    write: (next, expected) => {
      if (state.revision !== expected || next.revision !== expected + 1)
        throw new Error("stale");
      state = { ...next };
    }
  };
  let finish!: (result: { clean: boolean; error?: string }) => void;
  const stop = vi.fn();
  const startRuntime = vi.fn(() => ({
    stop,
    done: new Promise<{ clean: boolean; error?: string }>((resolve) => {
      finish = resolve;
    })
  }));
  const core = createControlPlaneHostCore({
    instanceId: "test",
    store,
    startRuntime
  });
  return {
    core,
    store,
    stop,
    startRuntime,
    finish: (outcome: { clean: boolean; error?: string }) => finish(outcome)
  };
}

describe("control-plane host core", () => {
  it("reuses a running runtime on Desktop start without creating CLI demand", () => {
    const f = fixture();
    f.core.start(true);
    expect(f.core.start(true).state).toBe("starting");
    expect(f.store.read().persistentCli).toBe(false);
    expect(f.startRuntime).toHaveBeenCalledOnce();
  });
  it("allows a CLI start to add persistent demand to an existing runtime", () => {
    const f = fixture();
    const desktop = f.core.openDesktopSession();
    f.core.start(true);
    f.core.start(true, true);
    expect(f.store.read().persistentCli).toBe(true);
    expect(f.startRuntime).toHaveBeenCalledOnce();
    desktop.close(true);
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("stops on last intentional Desktop detach without setting explicit Stop", () => {
    const f = fixture();
    const desktop = f.core.openDesktopSession();
    f.core.start(true);
    desktop.close(true);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.store.read().stopIntent).toBe(false);
  });
  it("preserves Agent and persistent CLI availability on Desktop detach", () => {
    for (const reason of [
      { backgroundEnabled: true },
      { persistentCli: true }
    ]) {
      const f = fixture(reason);
      const desktop = f.core.openDesktopSession();
      f.core.start(true);
      desktop.close(true);
      expect(f.stop).not.toHaveBeenCalled();
    }
  });
  it("waits for reconnect after unexpected Desktop disconnect", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const desktop = f.core.openDesktopSession();
      f.core.start(true);
      desktop.close(false);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(f.stop).not.toHaveBeenCalled();
      const reconnected = f.core.openDesktopSession();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.stop).not.toHaveBeenCalled();
      reconnected.close(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("clears only its own reconnect grace before intentional detach", () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const first = f.core.openDesktopSession("desktop-one");
      f.core.start(true);
      first.close(false);
      const reconnected = f.core.openDesktopSession("desktop-one");
      reconnected.close(true);
      expect(f.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not let an unrelated session consume disconnected Desktop grace", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const original = f.core.openDesktopSession();
      f.core.start(true);
      original.close(false);
      const other = f.core.openDesktopSession();
      other.close(true);
      expect(f.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("invalidates old grace after explicit stop and restart", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const desktop = f.core.openDesktopSession();
      f.core.start(true);
      desktop.close(false);
      f.core.stop(true);
      f.finish({ clean: true });
      await Promise.resolve();
      f.core.start(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects Desktop attachment while shutdown is in progress", () => {
    const f = fixture();
    const desktop = f.core.openDesktopSession();
    f.core.start(true);
    desktop.close(true);
    expect(() => f.core.openDesktopSession()).toThrow("stopping");
  });
  it("surfaces an intentional detach when demand cannot be checked", () => {
    const f = fixture();
    const desktop = f.core.openDesktopSession();
    vi.spyOn(f.store, "read").mockImplementation(() => {
      throw new Error("disk failure");
    });
    expect(() => desktop.close(true)).toThrow("disk failure");
  });
  it("stops after persistent CLI demand is removed and no Desktop demand remains", () => {
    const f = fixture({ persistentCli: true });
    const desktop = f.core.openDesktopSession();
    f.core.start(true);
    desktop.close(true);
    expect(f.stop).not.toHaveBeenCalled();
    f.core.detach("persistent-cli");
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it("persists CLI availability and clears it on explicit Stop", () => {
    const f = fixture();
    f.core.attach("persistent-cli");
    expect(f.store.read().persistentCli).toBe(true);
    f.core.start(true);
    f.core.stop(true);
    expect(f.store.read()).toMatchObject({
      persistentCli: false,
      stopIntent: true
    });
  });
  it("persists Agent availability only while stopped without clearing explicit Stop", () => {
    const f = fixture({ stopIntent: true });
    f.core.attach("background-agent");
    expect(f.store.read()).toMatchObject({
      backgroundEnabled: true,
      stopIntent: true
    });
    expect(f.core.status()).toMatchObject({
      backgroundEnabled: true,
      stopIntent: true
    });
    f.core.detach("background-agent");
    expect(f.store.read()).toMatchObject({
      backgroundEnabled: false,
      stopIntent: true
    });
  });
  it("refuses Agent availability changes until runtime cleanup is confirmed", () => {
    const f = fixture();
    f.core.start(true);
    expect(() => f.core.attach("background-agent")).toThrow();
    expect(() => f.core.detach("background-agent")).toThrow();
    expect(f.store.read().backgroundEnabled).toBe(false);
  });
  it("durably records Stop before cancelling an in-flight start", async () => {
    const f = fixture();
    expect(f.core.start(true).state).toBe("starting");
    expect(f.store.read().runtimeClean).toBe(false);
    expect(f.core.stop(true).state).toBe("stopping");
    expect(f.store.read().stopIntent).toBe(true);
    expect(f.stop).toHaveBeenCalledOnce();
    f.finish({ clean: true });
    await Promise.resolve();
    expect(f.core.status()).toMatchObject({
      state: "stopped",
      stopIntent: true
    });
    expect(f.store.read().runtimeClean).toBe(true);
  });
  it("marks generation persistence rejected by Stop as startup cancellation", () => {
    const f = fixture();
    let persist!: (id: string) => void;
    f.startRuntime.mockImplementationOnce(
      (callbacks?: { persistGenerationBeforeEffects(id: string): void }) => {
        persist = callbacks!.persistGenerationBeforeEffects;
        return { stop: f.stop, done: new Promise(() => {}) };
      }
    );
    f.core.start(true);
    f.core.stop(true);
    expect(() => persist("generation")).toThrow(
      expect.objectContaining({ name: "StartupCancellationError" })
    );
    expect(f.store.read().protectedGenerationId).toBeNull();
  });

  it("cancels startup even when persisting Stop fails", () => {
    const f = fixture();
    f.core.start(true);
    vi.spyOn(f.store, "write").mockImplementation(() => {
      throw new Error("disk failure");
    });
    expect(() => f.core.stop(true)).toThrow("disk failure");
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.core.status().state).toBe("needs_attention");
  });

  it("cancels a runtime when Stop is received during synchronous session creation", () => {
    const f = fixture();
    f.startRuntime.mockImplementationOnce(() => {
      f.core.stop(true);
      return { stop: f.stop, done: new Promise(() => {}) };
    });
    expect(f.core.start(true).state).toBe("stopping");
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.store.read().stopIntent).toBe(true);
  });

  it("exercises durable intent in a controlled never-used home without creating a production clean-state bypass", async () => {
    const scratch = resolve(import.meta.dirname, "../../../../scratch");
    mkdirSync(scratch, { recursive: true });
    const parent = mkdtempSync(resolve(scratch, "control-first-run-"));
    const home = resolve(parent, "brand-new-home");
    mkdirSync(home, { mode: 0o700 });
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.configDir, { mode: 0o700 });
    const admission = acquireControlPlaneAdmission(paths)!;
    try {
      const store = createControlStateStore(paths, admission);
      store.initialize({ kind: "absent" });
      const initial = store.read();
      expect(initial.runtimeClean).toBe(false);
      // Test harness owns the exclusively created home and has never started a runtime there.
      store.write(
        { ...initial, revision: initial.revision + 1, runtimeClean: true },
        initial.revision
      );
      let finish!: (result: { clean: boolean }) => void;
      const core = createControlPlaneHostCore({
        instanceId: "test",
        store,
        startRuntime: () => ({
          stop() {},
          done: new Promise((resolveDone) => {
            finish = resolveDone;
          })
        })
      });
      expect(core.start(true).state).toBe("starting");
      core.stop(true);
      finish({ clean: true });
      await Promise.resolve();
      expect(store.read()).toMatchObject({
        stopIntent: true,
        runtimeClean: true
      });
    } finally {
      releaseControlPlaneAdmission(admission);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("cannot automatically restart after an explicit Stop", () => {
    const f = fixture({ stopIntent: true });
    expect(() => f.core.start(false)).toThrow(/stop/i);
    expect(f.startRuntime).not.toHaveBeenCalled();
  });
  it("allows restart after a historical unclean runtime without claiming cleanup", () => {
    const f = fixture({ runtimeClean: false });
    expect(f.core.status().state).toBe("needs_attention");
    expect(f.core.start(true).state).toBe("starting");
    expect(f.store.read().runtimeClean).toBe(false);
  });
  it("retains historical generation protection after a later clean session", async () => {
    const f = fixture({
      runtimeClean: false,
      protectedGenerationId: "old-generation"
    });
    f.core.start(true);
    f.finish({ clean: true });
    await Promise.resolve();
    expect(f.store.read()).toMatchObject({
      runtimeClean: false,
      protectedGenerationId: "old-generation"
    });
    expect(f.core.status()).toMatchObject({
      state: "stopped",
      error: "Previous runtime cleanup was not confirmed"
    });
  });
  it("does not report confirmed Stop for an unclean historical runtime", () => {
    const f = fixture({ runtimeClean: false });
    expect(f.core.stop(true).state).toBe("needs_attention");
    expect(f.store.read().stopIntent).toBe(true);
  });
  it("does not promote uncertain cleanup to clean", async () => {
    const f = fixture();
    f.core.start(true);
    f.finish({ clean: false, error: "uncertain" });
    await Promise.resolve();
    expect(f.core.status().state).toBe("needs_attention");
    expect(f.store.read().runtimeClean).toBe(false);
  });
  it("does not persist a clean exit that also reported an error as clean", async () => {
    const f = fixture();
    f.core.start(true);
    f.finish({ clean: true, error: "startup failed" });
    await Promise.resolve();
    expect(f.core.status()).toMatchObject({
      state: "needs_attention",
      error: "startup failed"
    });
    expect(f.store.read().runtimeClean).toBe(false);
    expect(f.core.settled()).toBe(true);
  });
  it("is not settled while a session is running", () => {
    const f = fixture();
    expect(f.core.settled()).toBe(true);
    f.core.start(true);
    expect(f.core.settled()).toBe(false);
  });
});
