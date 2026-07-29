import { describe, expect, it, vi } from "vitest";
import type { DesktopSetupStageId } from "../types.js";
import {
  createDesktopSetupWorkflow,
  desktopSetupStageIds
} from "./setup-workflow.js";

describe("desktop setup workflow", () => {
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
});
