import { randomUUID } from "node:crypto";
import type { createOperationReceipt } from "./operation-receipt.js";

import type {
  DesktopSetupSnapshot,
  DesktopSetupStage,
  DesktopSetupStageId
} from "../types.js";

export const desktopSetupStageIds: DesktopSetupStageId[] = [
  "package",
  "runtime",
  "model",
  "services",
  "integration",
  "verification"
];

export type DesktopSetupCheck = {
  complete: boolean;
  detectedAiClients?: readonly string[];
  message: string;
};

export type DesktopSetupActionResult = {
  message: string;
  ok: boolean;
};

export type DesktopSetupStageProgress = {
  progressPhase?: "downloading" | "verifying" | "complete";
  completedBytes: number | null;
  message: string;
  totalBytes: number | null;
};

export type DesktopSetupWorkflowDependencies = {
  receipt?: ReturnType<typeof createOperationReceipt>;
  stageIds?: () => readonly DesktopSetupStageId[];
  inspectStage: (stage: DesktopSetupStageId) => Promise<DesktopSetupCheck>;
  randomId?: () => string;
  runStage: (
    stage: DesktopSetupStageId,
    onProgress: (progress: DesktopSetupStageProgress) => void
  ) => Promise<DesktopSetupActionResult>;
};

const pendingStage = (
  id: DesktopSetupStageId,
  check: DesktopSetupCheck
): DesktopSetupStage => ({
  completedBytes: null,
  ...(check.detectedAiClients
    ? { detectedAiClients: check.detectedAiClients }
    : {}),
  id,
  message: check.message,
  state: check.complete ? "complete" : "pending",
  totalBytes: null
});

const cloneSnapshot = (
  snapshot: DesktopSetupSnapshot
): DesktopSetupSnapshot => ({
  ...snapshot,
  stages: snapshot.stages.map((stage) => ({ ...stage }))
});

export const createDesktopSetupWorkflow = ({
  receipt,
  inspectStage,
  randomId = randomUUID,
  runStage,
  stageIds = () => desktopSetupStageIds
}: DesktopSetupWorkflowDependencies) => {
  let activeRun: Promise<DesktopSetupSnapshot> | null = null;
  let activeSnapshot: DesktopSetupSnapshot | null = null;
  let interrupted = receipt?.previous?.state === "running";

  const inspect = async (forRun = false): Promise<DesktopSetupSnapshot> => {
    if (activeRun && activeSnapshot) return cloneSnapshot(activeSnapshot);
    // A reopened window sees the failed attempt and its recovery controls.
    // An explicit retry still re-inspects every prerequisite before any work.
    if (!forRun && activeSnapshot?.state === "failed")
      return cloneSnapshot(activeSnapshot);
    const runId = randomId();
    const checks = await Promise.all(
      stageIds().map(async (stage) => ({
        stage,
        check: await inspectStage(stage)
      }))
    );
    const stages = checks.map(({ stage, check }) => pendingStage(stage, check));
    const verificationIndex = stages.findIndex(
      ({ id }) => id === "verification"
    );
    const prerequisitesComplete = stages.every(
      ({ id, state }) => id === "verification" || state === "complete"
    );
    if (verificationIndex >= 0 && !prerequisitesComplete) {
      const verification = stages[verificationIndex]!;
      stages[verificationIndex] = {
        ...verification,
        message:
          verification.state === "complete"
            ? "Complete the preceding setup steps before final verification."
            : verification.message,
        state: "pending"
      };
    }
    return {
      activeStage: null,
      error:
        interrupted && !forRun
          ? "Setup was interrupted. Current prerequisites have been checked. Review your processing choice before continuing; no installation has resumed."
          : null,
      runId,
      sequence: 1,
      stages,
      state:
        interrupted && !forRun
          ? "failed"
          : stages.every(({ state }) => state === "complete")
            ? "complete"
            : "ready"
    };
  };

  const execute = async (
    emit: (snapshot: DesktopSetupSnapshot) => void,
    signal?: AbortSignal
  ): Promise<DesktopSetupSnapshot> => {
    const initial = await inspect(true);
    receipt?.save({
      id: initial.runId,
      sequence: initial.sequence,
      state: "running"
    });
    interrupted = false;
    let sequence = initial.sequence;
    let snapshot: DesktopSetupSnapshot = {
      ...initial,
      state: "running"
    };
    const publish = () => {
      sequence += 1;
      snapshot = { ...snapshot, sequence };
      activeSnapshot = cloneSnapshot(snapshot);
      if (snapshot.state !== "running") {
        try {
          receipt?.save({
            id: snapshot.runId,
            sequence,
            state: snapshot.state === "complete" ? "complete" : "failed"
          });
        } catch {
          /* Retain the initial interrupted-work receipt. */
        }
      }
      emit(cloneSnapshot(snapshot));
    };
    publish();

    for (const { id: stageId } of initial.stages) {
      if (signal?.aborted) {
        snapshot = {
          ...snapshot,
          activeStage: null,
          error: "Setup was interrupted.",
          state: "failed"
        };
        publish();
        return snapshot;
      }
      const index = snapshot.stages.findIndex(({ id }) => id === stageId);
      const current = snapshot.stages[index]!;
      if (current.state === "complete") continue;

      snapshot.stages[index] = {
        ...current,
        message: "Starting…",
        state: "running"
      };
      snapshot = { ...snapshot, activeStage: stageId };
      publish();

      let result: DesktopSetupActionResult;
      try {
        result = await runStage(stageId, (progress) => {
          snapshot.stages[index] = {
            ...snapshot.stages[index]!,
            ...progress,
            state: "running"
          };
          publish();
        });
      } catch (error) {
        result = {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : `${stageId} setup failed unexpectedly.`
        };
      }
      if (!result.ok) {
        snapshot.stages[index] = {
          ...snapshot.stages[index]!,
          message: result.message,
          state: "failed"
        };
        snapshot = {
          ...snapshot,
          activeStage: stageId,
          error: result.message,
          state: "failed"
        };
        publish();
        return snapshot;
      }

      snapshot.stages[index] = {
        ...snapshot.stages[index]!,
        completedBytes:
          snapshot.stages[index]!.totalBytes ??
          snapshot.stages[index]!.completedBytes,
        message: result.message,
        state: "complete"
      };
      publish();
    }

    snapshot = {
      ...snapshot,
      activeStage: null,
      error: null,
      state: "complete"
    };
    publish();
    return snapshot;
  };

  return {
    inspect,
    isRunning: () => activeRun !== null,
    run(
      emit: (snapshot: DesktopSetupSnapshot) => void,
      signal?: AbortSignal
    ): Promise<DesktopSetupSnapshot> {
      if (!activeRun) {
        activeRun = execute(emit, signal).finally(() => {
          activeRun = null;
          if (activeSnapshot?.state !== "failed") activeSnapshot = null;
        });
      }
      return activeRun;
    }
  };
};
