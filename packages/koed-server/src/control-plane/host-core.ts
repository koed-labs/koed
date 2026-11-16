import type { AvailabilityReason } from "@koed-labs/shared/local-control-protocol";
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
  backgroundEnabled: boolean;
  error?: string;
}
export interface HostCore {
  status(): HostSnapshot;
  start(explicit: boolean, persistentCli?: boolean): HostSnapshot;
  stop(explicit: boolean): HostSnapshot;
  attach(reason: AvailabilityReason): HostSnapshot;
  detach(reason: AvailabilityReason): HostSnapshot;
  openDesktopSession(identity?: string): { close(intentional: boolean): void };
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
  let desktopSessions = 0;
  const disconnected = new Map<
    ReturnType<typeof setTimeout>,
    string | undefined
  >();
  const activeDesktopIdentities = new Set<string>();
  const clearDisconnectGrace = (): void => {
    for (const timer of disconnected.keys()) clearTimeout(timer);
    disconnected.clear();
  };

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
      backgroundEnabled: current.backgroundEnabled,
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
  const start = (explicit: boolean, persistentCli = false): HostSnapshot => {
    const current = input.store.read();
    if (
      session &&
      !current.stopIntent &&
      (state === "starting" || state === "ready")
    ) {
      if (persistentCli && !current.persistentCli)
        update((previous) => ({ ...previous, persistentCli: true }));
      return status();
    }
    if (!current.runtimeClean)
      throw new Error("Unclean runtime requires Operator attention");
    if (current.stopIntent && !explicit)
      throw new Error("Explicit Stop prevents automatic start");
    if (state !== "stopped" || session)
      throw new Error("Runtime is not stopped");
    if (explicit) clearDisconnectGrace();
    update((previous) => ({
      ...previous,
      stopIntent: explicit ? false : previous.stopIntent,
      persistentCli: persistentCli || previous.persistentCli,
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
      if (explicit) clearDisconnectGrace();
      if (explicit)
        update((current) => ({
          ...current,
          stopIntent: true,
          persistentCli: false
        }));
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
  const reconcileDesktopDemand = (): void => {
    if (state === "needs_attention")
      throw new Error("Runtime requires Operator attention");
    const current = input.store.read();
    if (
      desktopSessions === 0 &&
      disconnected.size === 0 &&
      !current.backgroundEnabled &&
      !current.persistentCli &&
      (state === "ready" || state === "starting")
    )
      stop(false);
  };
  const openDesktopSession = (
    identity?: string
  ): { close(intentional: boolean): void } => {
    if (state === "stopping") throw new Error("Runtime is stopping");
    if (identity && activeDesktopIdentities.has(identity))
      throw new Error("Desktop session is already attached");
    if (identity) {
      for (const [timer, previous] of disconnected) {
        if (previous === identity) {
          clearTimeout(timer);
          disconnected.delete(timer);
        }
      }
      activeDesktopIdentities.add(identity);
    }
    desktopSessions++;
    let closed = false;
    return {
      close(intentional) {
        if (closed) return;
        closed = true;
        desktopSessions--;
        if (identity) activeDesktopIdentities.delete(identity);
        if (!intentional) {
          const timer = setTimeout(() => {
            disconnected.delete(timer);
            try {
              reconcileDesktopDemand();
            } catch (failure) {
              error =
                failure instanceof Error ? failure.message : String(failure);
              state = "needs_attention";
            }
          }, 30_000);
          timer.unref?.();
          disconnected.set(timer, identity);
        } else {
          try {
            reconcileDesktopDemand();
          } catch (failure) {
            desktopSessions++;
            if (identity) activeDesktopIdentities.add(identity);
            closed = false;
            error =
              failure instanceof Error ? failure.message : String(failure);
            state = "needs_attention";
            throw failure;
          }
        }
      }
    };
  };
  const setAgentAvailability = (
    reason: AvailabilityReason,
    enabled: boolean
  ): HostSnapshot => {
    if (reason === "persistent-cli") {
      if (state === "needs_attention" || state === "stopping")
        throw new Error("Runtime cannot change CLI availability");
      update((current) => ({ ...current, persistentCli: enabled }));
      if (!enabled) reconcileDesktopDemand();
      return status();
    }
    if (reason !== "background-agent")
      throw new Error("Availability reason is not supported");
    if (state !== "stopped" || !input.store.read().runtimeClean)
      throw new Error(
        "Stop Koed and confirm cleanup before changing Agent availability"
      );
    update((current) => ({ ...current, backgroundEnabled: enabled }));
    return status();
  };
  return {
    status,
    start,
    stop,
    attach: (reason) => setAgentAvailability(reason, true),
    detach: (reason) => setAgentAvailability(reason, false),
    openDesktopSession
  };
}
