import { describe, expect, it, vi } from "vitest";
import type {
  AccelerationSnapshot,
  AccelerationChoice
} from "@koed-labs/server";
import {
  createAccelerationController,
  type AccelerationControllerDependencies
} from "./acceleration-controller.js";
import { DesktopSupervisorRequestInterruptedError } from "./private-supervisor.js";

const initial = (): AccelerationSnapshot => ({
  observedAt: "2026-11-09T00:00:00Z",
  revision: "a".repeat(64),
  configurationRevision: "a".repeat(64),
  runtimeEpoch: "runtime-1",
  preference: "auto",
  recommendedPreference: "auto",
  effectivePolicy: "auto",
  source: "saved",
  readOnlyReason: null,
  runtimeReadOnlyReason: null,
  hardware: {
    state: "available",
    backend: "metal",
    name: "Apple Silicon",
    memoryBytes: null,
    reason: "Available",
    verification: "host"
  },
  cuda: {
    validation: "unknown",
    state: "not-applicable",
    selectionId: null,
    canInstall: false,
    downloadBytes: null,
    requiredFreeBytes: null,
    availableFreeBytes: null,
    reason: "Not needed"
  },
  model: {
    key: "qwen3-0.6b",
    label: "Qwen3 Embedding · 0.6B",
    filename: "model.gguf",
    present: true
  },
  embedding: { state: "stopped", backend: null, fallbackReason: null },
  privacy: { state: "absent", provider: null, fallbackReason: null }
});
const choice: AccelerationChoice = {
  preference: "cpu",
  installCuda: false,
  expectedRevision: "a".repeat(64)
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixture = (running = false) => {
  const value = {
    snapshot: initial(),
    live: running ? ("running" as const) : ("stopped" as const),
    generation: 0
  };
  const calls: string[] = [];
  const deps: AccelerationControllerDependencies = {
    inspect: vi.fn(async () => value.snapshot),
    save: vi.fn(async (next) => {
      calls.push("save");
      value.snapshot = {
        ...value.snapshot,
        preference: next.preference,
        effectivePolicy: next.preference,
        revision: "b".repeat(64)
      };
      return value.snapshot;
    }),
    install: vi.fn(async () => {
      calls.push("install");
      value.snapshot = {
        ...value.snapshot,
        revision: "c".repeat(64),
        cuda: {
          ...value.snapshot.cuda,
          state: "installed",
          validation: "inference"
        }
      };
      return {
        snapshot: value.snapshot,
        validation: "inference" as const,
        changed: true
      };
    }),
    exclusive: async (run) => run(),
    observe: () => ({ state: value.live, epoch: "runtime-1" }),
    explicitStopGeneration: () => value.generation,
    stop: vi.fn(async () => {
      calls.push("stop");
      value.live = "stopped";
    }),
    start: vi.fn(async () => {
      calls.push("start");
      value.live = "running";
      value.snapshot = {
        ...value.snapshot,
        embedding: { state: "ready", backend: "cpu", fallbackReason: null }
      };
    }),
    assertAvailable: vi.fn()
  };
  const controller = createAccelerationController(deps);
  return {
    value,
    deps,
    controller,
    calls,
    run: async (input = choice) => {
      await controller.apply(input);
      return controller.wait();
    }
  };
};

describe("Desktop processing lifecycle", () => {
  it("ignores progress delivered after its operation has completed", async () => {
    const f = fixture();
    f.value.snapshot.preference = "cpu";
    f.value.snapshot.hardware.backend = "cuda";
    const install = f.deps.install;
    let late!: Parameters<AccelerationControllerDependencies["install"]>[2];
    f.deps.install = async (revision, signal, progress) => {
      late = progress;
      return install(revision, signal, progress);
    };
    await f.run({ ...choice, preference: "auto", installCuda: true });
    const completed = await f.run({
      ...choice,
      expectedRevision: f.value.snapshot.revision
    });
    late({
      phase: "downloading",
      completedBytes: 1,
      totalBytes: 10,
      message: "Stale progress"
    });
    expect((await f.controller.inspect()).operation).toEqual(
      completed.operation
    );
  });
  it("reconciles a lost installer response without claiming cancellation or restarting from uncertain state", async () => {
    const f = fixture(true);
    f.value.snapshot.preference = "cpu";
    f.value.snapshot.hardware.backend = "cuda";
    f.deps.install = vi.fn(async () => {
      f.value.snapshot.cuda.state = "installed";
      throw new DesktopSupervisorRequestInterruptedError("Disconnected");
    });
    const state = await f.run({
      ...choice,
      preference: "auto",
      installCuda: true
    });
    expect(state.operation?.state).toBe("interrupted");
    expect(state.snapshot?.cuda.state).toBe("installed");
    expect(state.snapshot?.preference).toBe("cpu");
    expect(f.calls).toEqual(["stop"]);
    expect(f.deps.start).not.toHaveBeenCalled();
  });
  it("reconciles interrupted work from live state without replaying its installation or preference", async () => {
    const f = fixture();
    const save = vi.fn();
    const controller = createAccelerationController({
      ...f.deps,
      receipt: {
        previous: {
          id: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
          sequence: 4,
          state: "running"
        },
        save
      }
    });
    const state = await controller.inspect(true);
    expect(state.operation).toMatchObject({
      state: "interrupted",
      sequence: 5,
      cancellable: false
    });
    expect(state.snapshot).toEqual(f.value.snapshot);
    expect(f.calls).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    await controller.cancel(state.operation!.id);
    expect(f.calls).toEqual([]);
    await controller.apply(choice);
    await controller.wait();
    expect(
      save.mock.calls.map(([value]) => (value as { state: string }).state)
    ).toEqual(["running", "complete"]);
  });
  it.each(["failed", "complete", "cancelled"] as const)(
    "does not replay a finished %s receipt as a current operation after restart",
    async (previousState) => {
      const f = fixture();
      const save = vi.fn();
      const controller = createAccelerationController({
        ...f.deps,
        receipt: {
          previous: {
            id: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
            sequence: 4,
            state: previousState
          },
          save
        }
      });
      const state = await controller.inspect(true);
      expect(state.operation).toBeNull();
      expect(state.snapshot).toEqual(f.value.snapshot);
      expect(f.calls).toEqual([]);
      expect(save).not.toHaveBeenCalled();
    }
  );
  it("does not mutate when the interruption receipt cannot be saved", async () => {
    const f = fixture();
    const controller = createAccelerationController({
      ...f.deps,
      receipt: {
        previous: null,
        save: () => {
          throw new Error("Disk unavailable");
        }
      }
    });
    await expect(controller.apply(choice)).rejects.toThrow(
      "could not be recorded"
    );
    expect(f.calls).toEqual([]);
    expect(controller.isRunning()).toBe(false);
  });
  it("reuses installed CUDA through CPU → GPU → CPU → GPU without another installation", async () => {
    const f = fixture();
    f.value.snapshot.preference = "cpu";
    f.value.snapshot.hardware.backend = "cuda";
    f.value.snapshot.cuda.state = "installed";
    for (const preference of ["auto", "cpu", "auto"] as const) {
      expect(
        (
          await f.run({
            preference,
            installCuda: false,
            expectedRevision: f.value.snapshot.revision
          })
        ).operation?.state
      ).toBe("complete");
    }
    expect(f.calls).toEqual(["save", "save", "save"]);
    expect(f.value.snapshot.model).toEqual(initial().model);
  });
  it("installs only after explicit CUDA consent, then saves the validated revision", async () => {
    const f = fixture(true);
    f.value.snapshot.preference = "cpu";
    f.value.snapshot.hardware.backend = "cuda";
    f.value.snapshot.cuda.state = "missing";
    const result = await f.run({
      ...choice,
      preference: "auto",
      installCuda: true
    });
    expect(result.operation?.state).toBe("complete");
    expect(f.calls).toEqual(["stop", "install", "save", "start"]);
    expect(f.deps.save).toHaveBeenCalledWith({
      preference: "auto",
      expectedRevision: "c".repeat(64)
    });
  });
  it("does not enable CUDA from device-only validation", async () => {
    const f = fixture();
    f.value.snapshot.preference = "cpu";
    f.value.snapshot.hardware.backend = "cuda";
    f.deps.install = vi.fn(async () => ({
      snapshot: f.value.snapshot,
      validation: "device-only" as const,
      changed: false
    }));
    expect(
      (await f.run({ ...choice, preference: "auto", installCuda: true }))
        .operation?.state
    ).toBe("failed");
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.start).not.toHaveBeenCalled();
  });
  it("saves on a stopped runtime without starting it or changing model identity", async () => {
    const f = fixture();
    const model = f.value.snapshot.model;
    const result = await f.run();
    expect(result.operation?.state).toBe("complete");
    expect(f.calls).toEqual(["save"]);
    expect(result.snapshot?.model).toEqual(model);
    expect(result.snapshot?.embedding.state).toBe("stopped");
  });
  it("confirms stop before save and restarts a previously running runtime", async () => {
    const f = fixture(true);
    const result = await f.run();
    expect(f.calls).toEqual(["stop", "save", "start"]);
    expect(result.snapshot?.embedding.backend).toBe("cpu");
  });
  it("does not save or restart after a failed stop", async () => {
    const f = fixture(true);
    f.deps.stop = vi.fn(async () => {
      throw new Error("stop failed");
    });
    const result = await f.run();
    expect(result.operation).toMatchObject({
      state: "failed",
      message: "stop failed"
    });
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.start).not.toHaveBeenCalled();
  });
  it("refuses a stop response that leaves services running", async () => {
    const f = fixture(true);
    f.deps.stop = vi.fn(async () => undefined);
    expect((await f.run()).operation?.state).toBe("failed");
    expect(f.deps.save).not.toHaveBeenCalled();
  });
  it.each(["stale", "managed"])(
    "rejects %s choices before stopping anything",
    async (kind) => {
      const f = fixture(true);
      if (kind === "stale") f.value.snapshot.revision = "c".repeat(64);
      else f.value.snapshot.readOnlyReason = "Operator managed";
      expect((await f.run()).operation?.state).toBe("failed");
      expect(f.calls).toEqual([]);
    }
  );
  it("a newer explicit stop wins while the operation is stopping", async () => {
    const f = fixture(true);
    const stop = deferred();
    f.deps.stop = vi.fn(async () => {
      await stop.promise;
      f.value.live = "stopped";
    });
    await f.controller.apply(choice);
    await vi.waitFor(() => expect(f.deps.stop).toHaveBeenCalled());
    f.value.generation++;
    stop.resolve();
    const result = await f.controller.wait();
    expect(result.operation?.state).toBe("failed");
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.start).not.toHaveBeenCalled();
  });
  it("restores the previous running state after a pre-save failure", async () => {
    const f = fixture(true);
    f.deps.save = vi.fn(async () => {
      throw new Error("configuration changed");
    });
    expect((await f.run()).operation?.state).toBe("failed");
    expect(f.deps.start).toHaveBeenCalledOnce();
    expect(f.value.snapshot.preference).toBe("auto");
  });
  it("does not undo a saved preference when restart fails", async () => {
    const f = fixture(true);
    f.deps.start = vi.fn(async () => {
      throw new Error("readiness failed");
    });
    const result = await f.run();
    expect(result.operation?.state).toBe("failed");
    expect(result.snapshot?.preference).toBe("cpu");
    expect(f.deps.save).toHaveBeenCalledOnce();
    expect(f.deps.start).toHaveBeenCalledOnce();
  });
  it("cancels a queued operation without a mutation", async () => {
    const f = fixture();
    const queue = deferred();
    f.deps.exclusive = async (run) => {
      await queue.promise;
      return run();
    };
    const active = await f.controller.apply(choice);
    await f.controller.cancel(active.operation!.id);
    queue.resolve();
    expect((await f.controller.wait()).operation?.state).toBe("cancelled");
    expect(f.calls).toEqual([]);
  });
  it("deduplicates an in-flight choice and keeps progress inspectable without a renderer", async () => {
    const f = fixture();
    const saving = deferred();
    const save = f.deps.save;
    f.deps.save = vi.fn(async (input) => {
      await saving.promise;
      return save(input);
    });
    const a = await f.controller.apply(choice);
    const b = await f.controller.apply(choice);
    expect(b.operation?.id).toBe(a.operation?.id);
    await vi.waitFor(() => expect(f.deps.save).toHaveBeenCalled());
    expect((await f.controller.inspect()).operation?.state).toBe("running");
    await expect(
      f.controller.apply({ ...choice, preference: "auto" })
    ).rejects.toThrow("already running");
    saving.resolve();
    expect((await f.controller.wait()).operation?.state).toBe("complete");
    expect(f.deps.save).toHaveBeenCalledOnce();
  });
  it("cannot enable missing CUDA through a normal preference change", async () => {
    const f = fixture();
    f.value.snapshot.preference = "cpu";
    f.value.snapshot.hardware.backend = "cuda";
    f.value.snapshot.cuda.state = "missing";
    expect(
      (await f.run({ ...choice, preference: "auto" })).operation?.message
    ).toContain("Install a compatible CUDA");
    expect(f.calls).toEqual([]);
  });
  it("does not accept cancellation after installer activation begins", async () => {
    const f = fixture(true);
    f.value.snapshot.preference = "cpu";
    f.value.snapshot.hardware.backend = "cuda";
    const activation = deferred();
    const install = f.deps.install;
    let signal!: AbortSignal;
    f.deps.install = vi.fn(async (revision, abort, progress) => {
      signal = abort;
      progress({ phase: "activating", message: "Activating" });
      await activation.promise;
      return install(revision, abort, progress);
    });
    const active = await f.controller.apply({
      ...choice,
      preference: "auto",
      installCuda: true
    });
    await vi.waitFor(() => expect(f.deps.install).toHaveBeenCalled());
    expect(
      (await f.controller.cancel(active.operation!.id)).operation?.cancellable
    ).toBe(false);
    expect(signal.aborted).toBe(false);
    activation.resolve();
    const result = await f.controller.wait();
    expect(result.operation?.state).toBe("complete");
    expect(result.snapshot?.preference).toBe("auto");
  });
  it("a newer explicit stop prevents recovery after installation failure", async () => {
    const f = fixture(true);
    f.value.snapshot.preference = "cpu";
    f.value.snapshot.hardware.backend = "cuda";
    f.deps.install = vi.fn(async () => {
      f.value.generation++;
      throw new Error("Download failed after a newer stop request");
    });
    const result = await f.run({
      ...choice,
      preference: "auto",
      installCuda: true
    });
    expect(result.operation?.state).toBe("failed");
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.start).not.toHaveBeenCalled();
    expect(result.snapshot?.preference).toBe("cpu");
    expect(f.value.live).toBe("stopped");
  });
});
