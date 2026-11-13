import type { KoedServerRuntimeLifecycle } from "../koed-server/manager.js";
import type { BackgroundAgentXpcClient } from "./xpc-transport.js";

export interface SwitchableBackgroundAgentRuntimeLifecycle extends KoedServerRuntimeLifecycle {
  isActive(): boolean;
  activate(client: BackgroundAgentXpcClient): void;
  activateUnavailable(reason: string): void;
  deactivate(): void;
}

export const createBackgroundAgentRuntimeLifecycle =
  (): SwitchableBackgroundAgentRuntimeLifecycle => {
    let client: BackgroundAgentXpcClient | null = null;
    let unavailableReason: string | null = null;

    const requireClient = () => {
      if (unavailableReason) throw new Error(unavailableReason);
      if (!client)
        throw new Error("Background Agent XPC client is not connected.");
      return client;
    };

    return {
      isActive: () => client !== null || unavailableReason !== null,
      activate: (nextClient) => {
        if (client && client !== nextClient) client.close();
        client = nextClient;
        unavailableReason = null;
      },
      activateUnavailable: (reason) => {
        client?.close();
        client = null;
        unavailableReason = reason;
      },
      deactivate: () => {
        client?.close();
        client = null;
        unavailableReason = null;
      },
      start: ({ explicit }) => requireClient().start(explicit),
      stop: ({ explicit }) => requireClient().stop(explicit),
      status: () => requireClient().status()
    };
  };
