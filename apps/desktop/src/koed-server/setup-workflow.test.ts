import { describe, expect, it, vi } from "vitest";
import type { DesktopSetupStageId } from "../types.js";
import {
  createDesktopSetupWorkflow,
  desktopSetupStageIds
} from "./setup-workflow.js";

describe("desktop setup workflow", () => {
  it("reports an interrupted main process using fresh prerequisites and never resumes a lost CUDA intent", async () => {
    const runStage = vi.fn(async () => ({ ok: true, message: "Complete" }));
    const workflow = createDesktopSetupWorkflow({
      receipt: {
        previous: {
          id: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
          sequence: 3,
          state: "running"
        },
        save: vi.fn()
      },
      inspectStage: async (id) => ({
        complete: ["package", "runtime", "model"].includes(id),
        message: "Current state"
      }),
      runStage
    });
    const state = await workflow.inspect();
    expect(state.state).toBe("failed");
    expect(state.error).toContain("interrupted");
    expect(state.stages.find((s) => s.id === "model")?.state).toBe("complete");
    expect(state.stages.some((s) => s.id === "acceleration")).toBe(false);
    expect(runStage).not.toHaveBeenCalled();
    expect((await workflow.run(() => {})).state).toBe("complete");
    expect(runStage).toHaveBeenCalledTimes(3);
  });
  it("clears an interrupted receipt once every prerequisite is complete", async () => {
    const save = vi.fn();
    const workflow = createDesktopSetupWorkflow({
      receipt: {
        previous: {
          id: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
          sequence: 3,
          state: "running"
        },
        save
      },
      inspectStage: async () => ({ complete: true, message: "Current state" }),
      runStage: vi.fn()
    });
    const state = await workflow.inspect();
    expect(state).toMatchObject({ state: "complete", error: null });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ state: "complete" })
    );
    expect((await workflow.inspect()).state).toBe("complete");
  });
  it("requires a fresh processing choice after an interrupted CUDA run, even when other steps are complete", async () => {
    const save = vi.fn();
    const interrupted = createDesktopSetupWorkflow({
      receipt: {
        previous: {
          id: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
          sequence: 3,
          state: "running",
          reviewProcessing: true
        },
        save
      },
      inspectStage: async () => ({ complete: true, message: "Current state" }),
      runStage: vi.fn()
    });
    expect(interrupted.requiresProcessingChoice()).toBe(true);
    expect(await interrupted.inspect()).toMatchObject({
      state: "failed",
      reviewProcessing: true
    });
    expect(save).not.toHaveBeenCalled();

    const saves: unknown[] = [];
    const withCuda = createDesktopSetupWorkflow({
      receipt: { previous: null, save: (value) => saves.push(value) },
      stageIds: () => [...desktopSetupStageIds.slice(0, 3), "acceleration"],
      inspectStage: async () => ({ complete: false, message: "Pending" }),
      runStage: async () => ({ ok: true, message: "Complete" })
    });
    await withCuda.run(() => {});
    expect(saves[0]).toMatchObject({
      state: "running",
      reviewProcessing: true
    });
    expect(withCuda.requiresProcessingChoice()).toBe(false);
  });
  it("places opted-in acceleration after the model and before services, retaining failure for reopened windows", async () => {
    const completed = new Set<DesktopSetupStageId>();
    const ids: DesktopSetupStageId[] = [
      "package",
      "runtime",
      "model",
      "acceleration",
      "services",
      "integration",
      "verification"
    ];
    const run = vi.fn(async (stage: DesktopSetupStageId) => {
      if (stage === "acceleration")
        return { ok: false, message: "CUDA verification failed" };
      completed.add(stage);
      return { ok: true, message: "Complete" };
    });
    const workflow = createDesktopSetupWorkflow({
      stageIds: () => ids,
      inspectStage: async (id) => ({
        complete: completed.has(id),
        message: "Inspect"
      }),
      runStage: run
    });
    const failed = await workflow.run(() => {});
    expect(run.mock.calls.map(([stage]) => stage)).toEqual(ids.slice(0, 4));
    expect(await workflow.inspect()).toEqual(failed);
    ids.splice(3, 1); // Explicit CPU recovery removes only the optional stage.
    run.mockClear();
    expect((await workflow.run(() => {})).state).toBe("complete");
    expect(run.mock.calls.map(([stage]) => stage)).toEqual([
      "services",
      "integration",
      "verification"
    ]);
  });
  it("does not mark final verification complete before its prerequisites", async () => {
    const workflow = createDesktopSetupWorkflow({
      randomId: () => "setup-run",
      inspectStage: async (stage) => ({
        complete:
          stage === "package" ||
          stage === "runtime" ||
          stage === "verification",
        message:
          stage === "verification"
            ? "Setup verification passed."
            : stage === "package" || stage === "runtime"
              ? "Already complete"
              : "Needs setup"
      }),
      runStage: async (stage) => ({ ok: true, message: `${stage} complete` })
    });

    const snapshot = await workflow.inspect();

    expect(snapshot.state).toBe("ready");
    expect(
      snapshot.stages.find(({ id }) => id === "verification")
    ).toMatchObject({
      message: "Complete the preceding setup steps before final verification.",
      state: "pending"
    });
  });

  it("skips completed stages and runs the remainder in order", async () => {
    const completed = new Set<DesktopSetupStageId>(["package", "runtime"]);
    const runStage = vi.fn(async (stage: DesktopSetupStageId) => ({
      ok: true,
      message: `${stage} complete`
    }));
    const workflow = createDesktopSetupWorkflow({
      randomId: () => "setup-run",
      inspectStage: async (stage) => ({
        complete: completed.has(stage),
        message: completed.has(stage) ? "Already complete" : "Needs setup"
      }),
      runStage
    });
    const snapshots: unknown[] = [];

    const result = await workflow.run((snapshot) => snapshots.push(snapshot));

    expect(runStage.mock.calls.map(([stage]) => stage)).toEqual(
      desktopSetupStageIds.slice(2)
    );
    expect(result.state).toBe("complete");
    expect(result.stages.every(({ state }) => state === "complete")).toBe(true);
    expect(snapshots.length).toBeGreaterThan(1);
  });

  it("publishes byte progress and stops at the first failed stage", async () => {
    const workflow = createDesktopSetupWorkflow({
      randomId: () => "setup-run",
      inspectStage: async () => ({
        complete: false,
        message: "Needs setup"
      }),
      runStage: async (stage, onProgress) => {
        if (stage === "model") {
          onProgress({
            completedBytes: 25,
            message: "Downloading embedding model…",
            totalBytes: 100
          });
          return { ok: false, message: "Download failed" };
        }
        return { ok: true, message: `${stage} complete` };
      }
    });
    const snapshots: Array<{
      stages: Array<{
        completedBytes: number | null;
        id: DesktopSetupStageId;
      }>;
    }> = [];

    const result = await workflow.run((snapshot) => snapshots.push(snapshot));

    expect(
      snapshots.some(
        ({ stages }) =>
          stages.find(({ id }) => id === "model")?.completedBytes === 25
      )
    ).toBe(true);
    expect(result.state).toBe("failed");
    expect(result.activeStage).toBe("model");
    expect(result.stages.find(({ id }) => id === "services")?.state).toBe(
      "pending"
    );
  });

  it("re-inspects reality when a failed workflow is retried", async () => {
    const completed = new Set<DesktopSetupStageId>();
    let failModel = true;
    const runStage = vi.fn(async (stage: DesktopSetupStageId) => {
      if (stage === "model" && failModel) {
        failModel = false;
        completed.add("package");
        completed.add("runtime");
        return { ok: false, message: "Download failed" };
      }
      completed.add(stage);
      return { ok: true, message: `${stage} complete` };
    });
    const workflow = createDesktopSetupWorkflow({
      inspectStage: async (stage) => ({
        complete: completed.has(stage),
        message: completed.has(stage) ? "Already complete" : "Needs setup"
      }),
      runStage
    });

    expect((await workflow.run(() => undefined)).state).toBe("failed");
    runStage.mockClear();
    expect((await workflow.run(() => undefined)).state).toBe("complete");
    expect(runStage.mock.calls.map(([stage]) => stage)).toEqual(
      desktopSetupStageIds.slice(2)
    );
  });

  it("turns thrown stage errors into a retryable failed snapshot", async () => {
    const workflow = createDesktopSetupWorkflow({
      inspectStage: async () => ({ complete: false, message: "Needs setup" }),
      runStage: async (stage) => {
        if (stage === "services") throw new Error("Service startup timed out");
        return { ok: true, message: `${stage} complete` };
      }
    });

    const result = await workflow.run(() => undefined);

    expect(result).toMatchObject({
      activeStage: "services",
      error: "Service startup timed out",
      state: "failed"
    });
    expect(result.stages.find(({ id }) => id === "services")).toMatchObject({
      message: "Service startup timed out",
      state: "failed"
    });
  });
  it("returns the active run on reopen without re-inspecting or restarting it", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspectStage = vi.fn(async () => ({
      complete: false,
      message: "Needs setup"
    }));
    const runStage = vi.fn(async (stage: DesktopSetupStageId) => {
      if (stage === "package") {
        started();
        await pause;
      }
      return { ok: true, message: "Done" };
    });
    const workflow = createDesktopSetupWorkflow({ inspectStage, runStage });
    const firstRun = workflow.run(() => {});
    await entered;
    const reopened = await workflow.inspect();
    expect(reopened).toMatchObject({
      state: "running",
      activeStage: "package"
    });
    reopened.stages[0]!.state = "complete";
    expect((await workflow.inspect()).stages[0]!.state).toBe("running");
    expect(inspectStage).toHaveBeenCalledTimes(6);
    const duplicateRun = workflow.run(() => {});
    release();
    expect((await firstRun).state).toBe("complete");
    expect(await duplicateRun).toEqual(await firstRun);
    expect(runStage).toHaveBeenCalledTimes(6);
  });
});
