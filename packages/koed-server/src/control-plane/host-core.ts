import type { ControlStateStore, ControlIntent } from "./state.js";
import type { RuntimeSession, RuntimeCleanupOutcome } from "./runtime.js";

type RuntimeState =
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "needs_attention";
export interface HostSnapshot {
  instanceId: string;
  revision: number;
  state: RuntimeState;
  stopIntent: boolean;
  error?: string;
}
export interface HostCore {
  status(): HostSnapshot;
  start(explicit: boolean): HostSnapshot;
  stop(explicit: boolean): HostSnapshot;
}

export function createControlPlaneHostCore(input: {
  instanceId: string;
  store: ControlStateStore;
  startRuntime(callbacks: {
    onReady(): void;
    persistGenerationBeforeEffects(id: string): void;
  }): RuntimeSession;
}): HostCore {
  let state: RuntimeState = input.store.read().runtimeClean
    ? "stopped"
    : "needs_attention";
  let session: RuntimeSession | undefined;
  let error: string | undefined;
  let persistenceFailed = false;
  let stopPending = false;
  let serial = 0;

  const update = (
    change: (current: ControlIntent) => ControlIntent
  ): ControlIntent => {
    const current = input.store.read();
    const next = change(current);
    input.store.write(
      { ...next, revision: current.revision + 1 },
      current.revision
    );
    return input.store.read();
  };
  const status = (): HostSnapshot => {
    const current = input.store.read();
    return {
      instanceId: input.instanceId,
      revision: current.revision,
      state,
      stopIntent: current.stopIntent,
      ...(error ? { error } : {})
    };
  };
  const complete = (id: number, outcome: RuntimeCleanupOutcome): void => {
    if (id !== serial) return;
    session = undefined;
    if (persistenceFailed) {
      state = "needs_attention";
      return;
    }
    try {
      if (outcome.clean)
        update((current) => ({
          ...current,
          runtimeClean: true,
          protectedGenerationId: null
        }));
      error = outcome.error;
      state = outcome.clean && !outcome.error ? "stopped" : "needs_attention";
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      state = "needs_attention";
    }
  };
  const start = (explicit: boolean): HostSnapshot => {
    const current = input.store.read();
    if (!current.runtimeClean)
      throw new Error("Unclean runtime requires Operator attention");
    if (current.stopIntent && !explicit)
      throw new Error("Explicit Stop prevents automatic start");
    if (state !== "stopped" || session)
      throw new Error("Runtime is not stopped");
    update((previous) => ({
      ...previous,
      stopIntent: explicit ? false : previous.stopIntent,
      runtimeClean: false
    }));
    state = "starting";
    stopPending = false;
    error = undefined;
    const id = ++serial;
    try {
      session = input.startRuntime({
        onReady: () => {
          if (serial === id && state === "starting") state = "ready";
        },
        persistGenerationBeforeEffects: (generationId) => {
          if (serial !== id || state !== "starting")
            throw new Error("Start was cancelled");
          update((previous) => ({
            ...previous,
            protectedGenerationId: generationId
          }));
        }
      });
      if (stopPending || persistenceFailed) session.stop();
      void session.done.then(
        (outcome) => complete(id, outcome),
        (failure: unknown) =>
          complete(id, {
            clean: false,
            error: failure instanceof Error ? failure.message : String(failure)
          })
      );
    } catch (failure) {
      state = "needs_attention";
      error = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    }
    return status();
  };
  const stop = (explicit: boolean): HostSnapshot => {
    try {
      if (explicit) update((current) => ({ ...current, stopIntent: true }));
    } catch (failure) {
      persistenceFailed = true;
      error = failure instanceof Error ? failure.message : String(failure);
      state = "needs_attention";
      session?.stop();
      throw failure;
    }
    if (session || state === "starting") {
      stopPending = true;
      state = "stopping";
      session?.stop();
    }
    return status();
  };
  return { status, start, stop };
}
