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
  createClient(state: BackgroundAgentState): BackgroundAgentXpcClient;
}): DesktopBackgroundAgentController => {
  let client: BackgroundAgentXpcClient | null = null;
  let unavailableReason: string | null = null;
  const getStore = () =>
    typeof input.store === "function" ? input.store() : input.store;

  const activateRegisteredAgent = () => {
    let state: BackgroundAgentStateRead;
    try {
      state = getStore().read();
    } catch {
      unavailableReason = "Background Agent launch configuration is invalid.";
      input.runtimeLifecycle.activateUnavailable(unavailableReason);
      return;
    }
    if (state.kind !== "valid") {
      unavailableReason =
        state.kind === "missing"
          ? "Background Agent state is missing."
          : "Background Agent state is invalid.";
      input.runtimeLifecycle.activateUnavailable(unavailableReason);
      return;
    }
    client = input.createClient(state.state);
    input.runtimeLifecycle.activate(client);
  };

  const initialize = async () => {
    const state = await input.launchService.get();
    if (state.enabled && !input.runtimeLifecycle.isActive())
      activateRegisteredAgent();
    return state;
  };

  const get = async (): Promise<DesktopBackgroundAgentState> => {
    const state = await input.launchService.get();
    if (state.enabled && !input.runtimeLifecycle.isActive())
      activateRegisteredAgent();
    return state;
  };

  const set = async (
    enabled: boolean
  ): Promise<DesktopBackgroundAgentState> => {
    const current = await input.launchService.get();
    if (!current.supported) return current;
    if (current.enabled === enabled) {
      if (!enabled && input.runtimeLifecycle.isActive()) return disable();
      if (enabled && !input.runtimeLifecycle.isActive())
        activateRegisteredAgent();
      return current.enabled
        ? { ...current, runtimeState: "starting" }
        : current;
    }
    return enabled
      ? await enable()
      : await disable(current.status === "requires-approval");
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
      if (!enabled.enabled) {
        input.runtimeLifecycle.deactivate();
        client = null;
        return enabled;
      }
      return { ...enabled, runtimeState: "starting" };
    } catch (error) {
      const current = await input.launchService.get().catch(() => null);
      if (!current?.enabled) {
        input.runtimeLifecycle.deactivate();
        client = null;
      }
      throw error;
    }
  };

  const disable = async (
    requiresApproval = false
  ): Promise<DesktopBackgroundAgentState> => {
    if (!requiresApproval) {
      if (!client && !unavailableReason) activateRegisteredAgent();
      if (!client)
        throw new Error(
          unavailableReason ?? "Background Agent is unavailable."
        );
      const stopped = await client.stop(true);
      if (!stopped.ok || stopped.state !== "stopped")
        throw new Error(
          stopped.message ?? "Background Agent could not stop Koed."
        );
    }
    const disabled = await input.launchService.set(false);
    if (disabled.enabled)
      throw new Error("Background Agent could not be unregistered.");
    input.runtimeLifecycle.deactivate();
    client = null;
    unavailableReason = null;
    return { ...disabled, runtimeState: "stopped" };
  };

  return {
    initialize,
    get,
    set,
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
