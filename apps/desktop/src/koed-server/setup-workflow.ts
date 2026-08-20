import { randomUUID } from "node:crypto";

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
  completedBytes: number | null;
  message: string;
  totalBytes: number | null;
};

export type DesktopSetupWorkflowDependencies = {
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
  inspectStage,
  randomId = randomUUID,
  runStage
}: DesktopSetupWorkflowDependencies) => {
  let activeRun: Promise<DesktopSetupSnapshot> | null = null;

  const inspect = async (): Promise<DesktopSetupSnapshot> => {
    const runId = randomId();
    const checks = await Promise.all(
      desktopSetupStageIds.map(async (stage) => ({
        stage,
        check: await inspectStage(stage)
      }))
    );
    const stages = checks.map(({ stage, check }) => pendingStage(stage, check));
    return {
      activeStage: null,
      error: null,
      runId,
      sequence: 1,
      stages,
      state: stages.every(({ state }) => state === "complete")
        ? "complete"
        : "ready"
    };
  };

  const execute = async (
    emit: (snapshot: DesktopSetupSnapshot) => void,
    signal?: AbortSignal
  ): Promise<DesktopSetupSnapshot> => {
    const initial = await inspect();
    let sequence = initial.sequence;
    let snapshot: DesktopSetupSnapshot = {
      ...initial,
      state: "running"
    };
    const publish = () => {
      sequence += 1;
      snapshot = { ...snapshot, sequence };
      emit(cloneSnapshot(snapshot));
    };
    publish();

    for (const stageId of desktopSetupStageIds) {
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
    run(
      emit: (snapshot: DesktopSetupSnapshot) => void,
      signal?: AbortSignal
    ): Promise<DesktopSetupSnapshot> {
      if (!activeRun) {
        activeRun = execute(emit, signal).finally(() => {
          activeRun = null;
        });
      }
      return activeRun;
    }
  };
};
