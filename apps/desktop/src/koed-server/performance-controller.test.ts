import { describe, expect, it, vi } from "vitest";
import {
  PerformanceChoiceRejectedError,
  type PerformanceSnapshot
} from "@koed-labs/server";
import { createPerformanceController } from "./performance-controller.js";
function fixture(running = true) {
  const calls: string[] = [];
  const value = {
    state: running ? "running" : "stopped",
    epoch: "one",
    stop: 0
  };
  const snapshot: PerformanceSnapshot = {
    revision: "a".repeat(64),
    runtimeEpoch: value.epoch,
    runtimeState: running ? "running" : "stopped",
    cpuCount: 12,
    preference: { profile: "balanced", overrides: {} },
    effective: {
      backgroundNice: 10,
      embeddingThreads: 6,
      transcriptPollMs: 1000
    },
    managed: {},
    invalid: {},
    profileManaged: false,
    readOnlyReason: null
  };
  const deps = {
    inspect: vi.fn(async () => ({
      ...snapshot,
      runtimeEpoch: value.epoch,
      runtimeState: value.state as PerformanceSnapshot["runtimeState"]
    })),
    save: vi.fn(async () => {
      calls.push("save");
      return snapshot;
    }),
    exclusive: async <T>(run: () => Promise<T>) => run(),
    observe: () => ({ state: value.state, epoch: value.epoch }),
    explicitStopGeneration: () => value.stop,
    assertAvailable: vi.fn(),
    stop: vi.fn(async () => {
      calls.push("stop");
      value.state = "stopped";
      value.epoch = "stopped";
    }),
    start: vi.fn(async () => {
      calls.push("start");
      value.state = "running";
    })
  };
  const controller = createPerformanceController(deps);
  const choice = {
    profile: "low" as const,
    overrides: {},
    expectedRevision: snapshot.revision
  };
  return { calls, value, snapshot, deps, controller, choice };
}
describe("performance lifecycle", () => {
  it("stops, saves, then restarts under one lifecycle operation", async () => {
    const f = fixture();
    await f.controller.apply(f.choice);
    expect(f.controller.isRunning()).toBe(true);
    const result = await f.controller.wait();
    expect(f.calls).toEqual(["stop", "save", "start"]);
    expect(result.operation?.state).toBe("complete");
  });
  it("saves without starting a stopped runtime", async () => {
    const f = fixture(false);
    await f.controller.apply(f.choice);
    await f.controller.wait();
    expect(f.calls).toEqual(["save"]);
  });
  it("rejects stale configuration before stopping", async () => {
    const f = fixture();
    await f.controller.apply({ ...f.choice, expectedRevision: "b".repeat(64) });
    expect((await f.controller.wait()).operation?.state).toBe("failed");
    expect(f.calls).toEqual([]);
  });
  it("does not write or restart after a stop failure", async () => {
    const f = fixture();
    f.deps.stop.mockRejectedValue(new Error("stop failed"));
    await f.controller.apply(f.choice);
    await f.controller.wait();
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.start).not.toHaveBeenCalled();
  });
  it("a newer explicit stop prevents both save and automatic restart", async () => {
    const f = fixture();
    f.deps.stop.mockImplementation(async () => {
      f.value.state = "stopped";
      f.value.stop++;
    });
    await f.controller.apply(f.choice);
    expect((await f.controller.wait()).operation?.state).toBe("interrupted");
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.start).not.toHaveBeenCalled();
  });
  it("does not restart after an ambiguous save or hide a failed restart", async () => {
    const f = fixture();
    f.deps.save.mockRejectedValue(new Error("connection lost"));
    await f.controller.apply(f.choice);
    expect((await f.controller.wait()).operation?.message).toBe(
      "connection lost"
    );
    expect(f.deps.start).not.toHaveBeenCalled();
    const g = fixture();
    g.deps.start.mockRejectedValue(new Error("not ready"));
    await g.controller.apply(g.choice);
    const failed = (await g.controller.wait()).operation;
    expect(failed?.state).toBe("failed");
    expect(failed?.message).toBe("Performance settings were saved. not ready");
    expect(g.deps.save).toHaveBeenCalledOnce();
    const h = fixture();
    h.deps.start.mockRejectedValue(
      new Error(
        "Performance settings were saved, but local services could not restart. Check service status."
      )
    );
    await h.controller.apply(h.choice);
    expect((await h.controller.wait()).operation?.message).toBe(
      "Performance settings were saved, but local services could not restart. Check service status."
    );
  });
  it("restarts services when the save is rejected without writing", async () => {
    const f = fixture();
    f.deps.save.mockRejectedValue(
      new PerformanceChoiceRejectedError(
        "Choose no more embedding threads than the available logical CPUs."
      )
    );
    await f.controller.apply(f.choice);
    const result = await f.controller.wait();
    expect(result.operation?.state).toBe("failed");
    expect(f.calls).toEqual(["stop", "start"]);
  });
  it("excludes concurrent apply and rejects a queued runtime epoch change", async () => {
    const f = fixture();
    let release!: () => void;
    f.deps.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...f.snapshot, runtimeEpoch: "two" });
        })
    );
    await f.controller.apply(f.choice);
    await expect(f.controller.apply(f.choice)).rejects.toThrow(
      "already running"
    );
    release();
    expect((await f.controller.wait()).operation?.state).toBe("failed");
    expect(f.calls).toEqual([]);
  });
});
