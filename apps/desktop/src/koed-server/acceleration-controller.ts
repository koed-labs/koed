import { randomUUID } from "node:crypto";
import type { createOperationReceipt } from "./operation-receipt.js";
import { DesktopSupervisorRequestInterruptedError } from "./private-supervisor.js";
import type {
  AccelerationChoice,
  AccelerationOperation,
  AccelerationSnapshot,
  AccelerationInstallProgress,
  AccelerationInstallResult,
  DesktopAccelerationApi,
  DesktopAccelerationState
} from "@koed-labs/server";

type Lifecycle = {
  state: "stopped" | "starting" | "running" | "unavailable";
  epoch: string;
};
export interface AccelerationControllerDependencies {
  receipt?: ReturnType<typeof createOperationReceipt>;
  inspect: (refresh: boolean) => Promise<AccelerationSnapshot>;
  save: (
    choice: Pick<AccelerationChoice, "preference" | "expectedRevision">
  ) => Promise<AccelerationSnapshot>;
  install: (
    expectedRevision: string,
    signal: AbortSignal,
    progress: (event: AccelerationInstallProgress) => void
  ) => Promise<AccelerationInstallResult>;
  exclusive: <T>(action: () => Promise<T>) => Promise<T>;
  observe: () => Lifecycle;
  explicitStopGeneration: () => number;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  assertAvailable: (origin: "settings" | "setup") => void;
}

// One operation belongs to the main process, not a renderer or its subscription.
// Lifecycle serialization encloses inspection, confirmed stop, mutation and start.
export function createAccelerationController(
  deps: AccelerationControllerDependencies
): DesktopAccelerationApi & {
  isRunning: () => boolean;
  supersede: () => void;
  subscribe: (
    listener: (state: DesktopAccelerationState) => void
  ) => () => void;
  wait: () => Promise<DesktopAccelerationState>;
  applyForSetup: (
    choice: AccelerationChoice
  ) => Promise<DesktopAccelerationState>;
} {
  let snapshot: AccelerationSnapshot | null = null;
  const previous = deps.receipt?.previous;
  // Finished receipts are history, not a new failure in this main process.
  // Only unfinished work needs reconciliation after an application restart.
  let operation: AccelerationOperation | null =
    previous &&
    (previous.state === "running" || previous.state === "interrupted")
      ? {
          ...previous,
          sequence: previous.sequence + 1,
          state: "interrupted",
          phase: "checking",
          cancellable: false,
          completedBytes: null,
          totalBytes: null,
          message: "The change was interrupted; check settings before retrying."
        }
      : null;
  let controller: AbortController | null = null;
  let active: Promise<void> | null = null;
  let choiceInFlight: string | null = null;
  const listeners = new Set<(state: DesktopAccelerationState) => void>();
  const state = (): DesktopAccelerationState => ({
    snapshot,
    operation: operation ? { ...operation } : null
  });
  const publish = (update: Partial<AccelerationOperation>) => {
    if (operation) {
      operation = { ...operation, ...update, sequence: operation.sequence + 1 };
      if (operation.state !== "running") {
        try {
          deps.receipt?.save({
            id: operation.id,
            sequence: operation.sequence,
            state: operation.state
          });
        } catch {
          /* The initial running receipt still records interrupted work. */
        }
      }
      for (const listener of listeners) {
        try {
          listener(state());
        } catch {
          /* Observation cannot fail an operation. */
        }
      }
    }
  };
  const refresh = async (force: boolean) => {
    snapshot = await deps.inspect(force);
    return snapshot;
  };

  async function execute(
    choice: AccelerationChoice,
    operationId: string,
    abort: AbortController,
    stopGeneration: number,
    origin: "settings" | "setup"
  ) {
    let stopped = false;
    let saved = false;
    let runningBefore = false;
    const stillAuthorized = () =>
      deps.explicitStopGeneration() === stopGeneration;
    const check = () => {
      abort.signal.throwIfAborted();
      if (!stillAuthorized())
        throw new Error(
          "A newer stop request superseded this change. Koed remains stopped."
        );
    };
    await deps.exclusive(async () => {
      try {
        deps.assertAvailable(origin);
        check();
        const before = await refresh(true);
        check();
        if (before.readOnlyReason) throw new Error(before.readOnlyReason);
        if (before.revision !== choice.expectedRevision)
          throw new Error(
            "Processing configuration changed. Check again before applying your choice."
          );
        if (
          choice.installCuda &&
          (choice.preference !== "auto" || before.hardware.backend !== "cuda")
        )
          throw new Error(
            "CUDA installation requires an explicit CUDA processing choice."
          );
        const live = deps.observe();
        if (live.epoch !== before.runtimeEpoch)
          throw new Error(
            "The running Koed instance changed. Check again before changing processing."
          );
        if (live.state !== "running" && live.state !== "stopped")
          throw new Error(
            "Wait for Koed's current lifecycle operation to finish, then check again."
          );
        runningBefore = live.state === "running";
        if (choice.preference === before.preference && !choice.installCuda) {
          publish({
            state: "complete",
            phase: "ready",
            cancellable: false,
            message: "The processing preference is already saved."
          });
          return;
        }
        if (choice.preference === "auto") {
          if (before.hardware.state !== "available")
            throw new Error(before.hardware.reason);
          if (
            before.hardware.backend === "cuda" &&
            !choice.installCuda &&
            !["installed", "outdated"].includes(before.cuda.state)
          )
            throw new Error(
              "Install a compatible CUDA add-on before enabling GPU processing."
            );
        }
        if (runningBefore) {
          publish({ phase: "stopping", message: "Stopping local services…" });
          // The manager's internal stop does not count as a new explicit User stop.
          await deps.stop();
          stopped = true;
        }
        check();
        if (deps.observe().state !== "stopped")
          throw new Error(
            "Koed did not stop. The processing preference was not changed."
          );
        let expectedRevision = choice.expectedRevision;
        if (choice.installCuda) {
          const installed = await deps.install(
            expectedRevision,
            abort.signal,
            (progress) => {
              if (
                operation?.id !== operationId ||
                operation.state !== "running"
              )
                return;
              if (!stillAuthorized()) abort.abort();
              publish({
                ...progress,
                cancellable: progress.phase !== "activating"
              });
            }
          );
          snapshot = installed.snapshot;
          if (installed.validation !== "inference")
            throw new Error(
              "CUDA device discovery is incomplete without verified model inference. Continue with CPU or retry verification."
            );
          expectedRevision = installed.snapshot.revision;
          check();
        }
        publish({
          phase: "saving",
          cancellable: false,
          message: "Saving the processing preference…"
        });
        snapshot = await deps.save({
          preference: choice.preference,
          expectedRevision
        });
        saved = true;
        if (runningBefore && stillAuthorized()) {
          publish({
            phase: "starting",
            message: "Starting local services and checking the active backend…"
          });
          await deps.start();
        }
        await refresh(true);
        publish({
          state: "complete",
          phase: "ready",
          cancellable: false,
          message: !stillAuthorized()
            ? "Preference saved. Koed remains stopped after your newer stop request."
            : !runningBefore
              ? "Preference saved. Koed will use it the next time services start."
              : snapshot?.embedding.state !== "ready"
                ? "Preference saved. The active embedding backend could not be verified. Check service status."
                : choice.preference === "auto" &&
                    snapshot.embedding.backend === "cpu"
                  ? "Koed is ready using CPU fallback."
                  : `Koed is ready using ${snapshot.embedding.backend?.toUpperCase()}.`
        });
      } catch (error) {
        let recovery = "";
        const interrupted =
          error instanceof DesktopSupervisorRequestInterruptedError ||
          (abort.signal.aborted &&
            !saved &&
            ["activating", "saving", "starting"].includes(
              operation?.phase ?? ""
            ));
        // Restore a prior running state only before a successful preference save.
        // A later explicit stop always wins. There is no pointer/config rollback.
        if (
          stopped &&
          !interrupted &&
          runningBefore &&
          !saved &&
          stillAuthorized() &&
          deps.observe().state === "stopped"
        ) {
          try {
            await deps.start();
          } catch {
            recovery =
              " Previous services could not restart; check service status.";
          }
        }
        await refresh(true).catch(() => {
          snapshot = null;
        });
        publish({
          state: interrupted
            ? "interrupted"
            : abort.signal.aborted && !saved
              ? "cancelled"
              : "failed",
          cancellable: false,
          message: interrupted
            ? "The processing change was interrupted. Review the current runtime and preference before retrying or choosing CPU."
            : `${abort.signal.aborted && !saved ? "Processing change cancelled." : error instanceof Error ? error.message : "Processing change failed."}${recovery}`
        });
      }
    });
  }

  const apply = async (
    choice: AccelerationChoice,
    origin: "settings" | "setup"
  ) => {
    if (active) {
      if (choiceInFlight === JSON.stringify(choice)) return state();
      throw new Error(
        "A processing change is already running. Wait for it to finish or cancel it first."
      );
    }
    deps.assertAvailable(origin);
    const abort = new AbortController();
    controller = abort;
    choiceInFlight = JSON.stringify(choice);
    operation = {
      id: randomUUID(),
      sequence: 1,
      state: "running",
      phase: "checking",
      cancellable: true,
      completedBytes: null,
      totalBytes: null,
      message: "Checking configuration and runtime ownership…"
    };
    // Record before entering the lifecycle queue or performing a mutation.
    try {
      deps.receipt?.save({
        id: operation.id,
        sequence: operation.sequence,
        state: "running"
      });
    } catch {
      controller = null;
      choiceInFlight = null;
      operation = {
        ...operation,
        state: "failed",
        cancellable: false,
        message:
          "The processing operation could not be recorded. Check local disk access before retrying."
      };
      throw new Error(operation.message);
    }
    const stopGeneration = deps.explicitStopGeneration();
    active = execute(choice, operation.id, abort, stopGeneration, origin)
      .catch((error: unknown) => {
        publish({
          state: "failed",
          cancellable: false,
          message:
            error instanceof Error ? error.message : "Processing change failed."
        });
      })
      .finally(() => {
        active = null;
        controller = null;
        choiceInFlight = null;
      });
    return state();
  };
  return {
    async inspect(force = false) {
      if (!active) await deps.exclusive(() => refresh(force));
      return state();
    },
    apply: (choice) => apply(choice, "settings"),
    applyForSetup: (choice) => apply(choice, "setup"),
    supersede: () => controller?.abort(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async cancel(id) {
      if (
        operation?.id === id &&
        operation.state === "running" &&
        operation.cancellable
      )
        controller?.abort();
      return state();
    },
    isRunning: () => active !== null,
    async wait() {
      await active;
      return state();
    }
  };
}
