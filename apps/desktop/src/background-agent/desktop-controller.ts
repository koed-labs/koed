import type { DesktopBackgroundAgentState } from "../types.js";
import type { KoedServerManager } from "../koed-server/manager.js";
import type {
  BackgroundAgentState,
  BackgroundAgentStateRead,
  BackgroundAgentStateStore
} from "./state.js";
import type { BackgroundAgentLaunchConfigurationStore } from "./launch-configuration.js";
import type { BackgroundAgentLaunchService } from "./launch-service.js";
import type { SwitchableBackgroundAgentRuntimeLifecycle } from "./runtime-lifecycle.js";
import type { BackgroundAgentXpcClient } from "./xpc-transport.js";

export async function readLaunchStateOrBlockRuntime(
  launchService: Pick<BackgroundAgentLaunchService, "get">,
  runtimeLifecycle: Pick<
    SwitchableBackgroundAgentRuntimeLifecycle,
    "activateUnavailable"
  >
): Promise<DesktopBackgroundAgentState | null> {
  try {
    return await launchService.get();
  } catch {
    runtimeLifecycle.activateUnavailable(
      "Background Agent registration status is unavailable."
    );
    return null;
  }
}

export interface DesktopBackgroundAgentController {
  initialize(): Promise<DesktopBackgroundAgentState>;
  get(): Promise<DesktopBackgroundAgentState>;
  set(enabled: boolean): Promise<DesktopBackgroundAgentState>;
  close(): void;
}

export const createDesktopBackgroundAgentController = (input: {
  launchService: BackgroundAgentLaunchService;
  store: BackgroundAgentStateStore | (() => BackgroundAgentStateStore);
  launchConfiguration: Pick<BackgroundAgentLaunchConfigurationStore, "write">;
  manager: {
    lifecycle: Pick<KoedServerManager["lifecycle"], "refresh">;
  };
  runtimeLifecycle: SwitchableBackgroundAgentRuntimeLifecycle;
  initialRegistrationUnavailable?: boolean;
  createClient(state: BackgroundAgentState): BackgroundAgentXpcClient;
}): DesktopBackgroundAgentController => {
  let client: BackgroundAgentXpcClient | null = null;
  let unavailableReason: string | null = input.initialRegistrationUnavailable
    ? "Background Agent registration status is unavailable."
    : null;
  const getStore = () =>
    typeof input.store === "function" ? input.store() : input.store;

  const activateRegisteredAgent = () => {
    let state: BackgroundAgentStateRead;
    try {
      state = getStore().read();
    } catch {
      unavailableReason =
        "Background Agent launch configuration is invalid. Restore the Background Agent configuration before changing registration.";
      input.runtimeLifecycle.activateUnavailable(unavailableReason);
      return;
    }
    if (state.kind !== "valid") {
      unavailableReason =
        state.kind === "missing"
          ? "Background Agent state is missing. Restore the Background Agent state before changing registration."
          : "Background Agent state is invalid. Restore the Background Agent state before changing registration.";
      input.runtimeLifecycle.activateUnavailable(unavailableReason);
      return;
    }
    client = input.createClient(state.state);
    input.runtimeLifecycle.activate(client);
    unavailableReason = null;
  };

  const mayBeRegistered = (state: DesktopBackgroundAgentState) =>
    state.enabled || state.status === "requires-approval";

  const readLaunchState = async () => {
    try {
      const state = await input.launchService.get();
      if (
        (mayBeRegistered(state) && !input.runtimeLifecycle.isActive()) ||
        unavailableReason
      )
        activateRegisteredAgent();
      if (state.status === "disabled" && input.runtimeLifecycle.isActive())
        return {
          ...state,
          runtimeState: "needs_attention" as const,
          message:
            "The Background Agent is no longer registered, but Koed shutdown is not confirmed."
        };
      return state;
    } catch (error) {
      if (!input.runtimeLifecycle.isActive()) {
        unavailableReason =
          "Background Agent registration status is unavailable.";
        input.runtimeLifecycle.activateUnavailable(unavailableReason);
      }
      throw error;
    }
  };

  let operation = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = operation.then(action);
    operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const set = async (
    enabled: boolean
  ): Promise<DesktopBackgroundAgentState> => {
    const current = await readLaunchState();
    if (!current.supported) return current;
    if (current.status === "requires-approval")
      return enabled ? current : disable();
    if (current.enabled === enabled) {
      if (!enabled && input.runtimeLifecycle.isActive()) return disable();
      if (enabled && !input.runtimeLifecycle.isActive())
        activateRegisteredAgent();
      return current.enabled
        ? { ...current, runtimeState: "starting" }
        : current;
    }
    if (enabled && unavailableReason) throw new Error(unavailableReason);
    return enabled ? await enable() : await disable();
  };

  const enable = async (): Promise<DesktopBackgroundAgentState> => {
    assertDesktopRuntimeStopped();
    const state = getOrInitializeState();
    try {
      input.launchConfiguration.write({
        installationId: state.installationId,
        bundlePath: state.bundlePath,
        koedHome: state.koedHome
      });
      client = input.createClient(state);
      input.runtimeLifecycle.activate(client);
      assertDesktopRuntimeStopped();
      const enabled = await input.launchService.set(true);
      if (!mayBeRegistered(enabled) && enabled.status === "disabled") {
        input.runtimeLifecycle.deactivate();
        client = null;
        return enabled;
      }
      return enabled.enabled
        ? { ...enabled, runtimeState: "starting" }
        : enabled;
    } catch (error) {
      const current = await readLaunchState().catch(() => null);
      if (
        current &&
        !mayBeRegistered(current) &&
        current.status === "disabled"
      ) {
        input.runtimeLifecycle.deactivate();
        client = null;
      }
      throw error;
    }
  };

  const disable = async (): Promise<DesktopBackgroundAgentState> => {
    if (!client && !unavailableReason) activateRegisteredAgent();
    if (!client)
      throw new Error(unavailableReason ?? "Background Agent is unavailable.");
    const stopped = await client.stop(true);
    if (!stopped.ok || stopped.state !== "stopped")
      throw new Error(
        stopped.message ?? "Background Agent could not stop Koed."
      );
    const disabled = await input.launchService.set(false);
    if (disabled.enabled || disabled.status !== "disabled")
      throw new Error("Background Agent could not be unregistered.");
    input.runtimeLifecycle.deactivate();
    client = null;
    unavailableReason = null;
    return { ...disabled, runtimeState: "stopped" };
  };

  return {
    initialize: () => serialize(readLaunchState),
    get: () => serialize(readLaunchState),
    set: (enabled) => serialize(() => set(enabled)),
    close: () => {
      client?.close();
      client = null;
    }
  };

  function assertDesktopRuntimeStopped() {
    const observation = input.manager.lifecycle.refresh();
    if (observation.state !== "stopped")
      throw new Error("Stop Koed before enabling the Background Agent.");
  }

  function getOrInitializeState() {
    const current = getStore().read();
    if (current.kind === "valid") return current.state;
    if (current.kind === "invalid")
      throw new Error("Background Agent state is invalid.");
    return getStore().initialize();
  }
};
