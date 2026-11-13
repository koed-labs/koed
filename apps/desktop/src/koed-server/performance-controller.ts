import { randomUUID } from "node:crypto";
import {
  isPerformanceChoiceRejection,
  type DesktopPerformanceState,
  type PerformanceChoice,
  type PerformanceSnapshot
} from "@koed-labs/server";
import type { createOperationReceipt } from "./operation-receipt.js";

// Main owns the operation, including when Settings closes or its renderer reloads.
export function createPerformanceController(deps: {
  inspect: () => Promise<PerformanceSnapshot>;
  save: (choice: PerformanceChoice) => Promise<PerformanceSnapshot>;
  exclusive: <T>(action: () => Promise<T>) => Promise<T>;
  observe: () => { state: string; epoch: string };
  explicitStopGeneration: () => number;
  assertAvailable: () => void;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  receipt?: ReturnType<typeof createOperationReceipt>;
}) {
  let snapshot: PerformanceSnapshot | null = null;
  const previous = deps.receipt?.previous;
  let sequence = previous?.sequence ?? 0;
  let operation: DesktopPerformanceState["operation"] =
    previous?.state === "running" || previous?.state === "interrupted"
      ? {
          id: previous.id,
          state: "interrupted",
          message:
            "The previous performance change was interrupted. Check the saved settings and service status before trying again."
        }
      : null;
  let pending: Promise<void> | null = null;
  const state = (): DesktopPerformanceState => ({
    snapshot,
    operation: operation && { ...operation }
  });
  const running = () => operation?.state === "running";
  const update = (
    message: string,
    status: NonNullable<typeof operation>["state"] = "running"
  ) => {
    operation = { id: operation!.id, state: status, message };
    if (status !== "running") {
      try {
        deps.receipt?.save({ id: operation.id, sequence, state: status });
      } catch {
        /* The initial receipt still records interrupted work. */
      }
    }
  };
  return {
    isRunning: running,
    wait: async () => {
      await pending;
      return state();
    },
    inspect: async () => {
      if (!running())
        await deps.exclusive(async () => {
          snapshot = await deps.inspect();
        });
      return state();
    },
    apply: async (choice: PerformanceChoice) => {
      if (running())
        throw new Error("A performance change is already running.");
      deps.assertAvailable();
      const observed = deps.observe();
      const stopGeneration = deps.explicitStopGeneration();
      const authorized = () => stopGeneration === deps.explicitStopGeneration();
      const assertAuthorized = () => {
        if (!authorized())
          throw new Error(
            "Performance change interrupted by a stop request. Services were left stopped."
          );
      };
      operation = {
        id: randomUUID(),
        state: "running",
        message: "Checking performance settings…"
      };
      sequence += 1;
      try {
        deps.receipt?.save({ id: operation.id, sequence, state: "running" });
      } catch (error) {
        operation = null;
        throw error;
      }
      pending = deps
        .exclusive(async () => {
          let stopped = false;
          let attemptedSave = false;
          let saved = false;
          try {
            deps.assertAvailable();
            assertAuthorized();
            snapshot = await deps.inspect();
            if (snapshot.readOnlyReason)
              throw new Error(snapshot.readOnlyReason);
            if (snapshot.revision !== choice.expectedRevision)
              throw new Error(
                "Performance settings changed. Discard your draft and try again."
              );
            if (
              snapshot.runtimeEpoch !== observed.epoch ||
              !["running", "stopped"].includes(snapshot.runtimeState)
            )
              throw new Error(
                "Service status changed. Check again before applying performance settings."
              );
            if (observed.state === "running") {
              update("Stopping local services…");
              await deps.stop();
              stopped = true;
              if (deps.observe().state !== "stopped")
                throw new Error(
                  "Local services did not stop. Performance settings were not saved."
                );
            }
            assertAuthorized();
            update("Saving performance settings…");
            attemptedSave = true;
            snapshot = await deps.save(choice);
            saved = true;
            assertAuthorized();
            if (stopped) {
              update("Restarting local services…");
              await deps.start();
              assertAuthorized();
            }
            snapshot = await deps.inspect();
            update(
              stopped
                ? "Performance settings applied."
                : "Performance settings saved. They will apply when local services start.",
              "complete"
            );
          } catch (error) {
            // If saving was attempted, its result could be ambiguous after a
            // disconnect. Do not silently start a possibly changed configuration.
            // A rejected choice wrote nothing, so restarting is safe.
            if (
              stopped &&
              !saved &&
              (!attemptedSave || isPerformanceChoiceRejection(error)) &&
              authorized() &&
              deps.observe().state === "stopped"
            ) {
              try {
                await deps.start();
              } catch {
                /* Report the original failure. */
              }
            }
            try {
              snapshot = await deps.inspect();
            } catch {
              snapshot = null;
            }
            const message =
              error instanceof Error
                ? error.message
                : "Performance settings could not be applied.";
            // Restart failures already say the settings were saved.
            const savedPrefix =
              saved && !message.startsWith("Performance settings were saved")
                ? "Performance settings were saved. "
                : "";
            update(
              `${savedPrefix}${message}`,
              authorized() ? "failed" : "interrupted"
            );
          }
        })
        .catch((error: unknown) => {
          // Includes queue or receipt failures. Never leave the renderer polling forever.
          operation = {
            id: operation!.id,
            state: "failed",
            message:
              error instanceof Error
                ? error.message
                : "Performance change failed."
          };
        })
        .finally(() => {
          pending = null;
        });
      return state();
    }
  };
}
