import {
  managedWorkspaceCommandChannel,
  managedWorkspaceEventChannel,
  managedWorkspaceEventSchema,
  managedWorkspaceRequestSchema,
  managedWorkspaceResultSchema,
  type ManagedWorkspaceDesktopApi,
  type ManagedWorkspaceEvent,
  type ManagedWorkspaceRequest
} from "./managed-workspace-protocol.js";

type Invoke = (channel: string, value: unknown) => Promise<unknown>;
type Events = {
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
};

export const createManagedWorkspacePreloadApi = (
  invoke: Invoke,
  events: Events
): ManagedWorkspaceDesktopApi =>
  Object.freeze({
    command: async (input: ManagedWorkspaceRequest) => {
      const request = managedWorkspaceRequestSchema.parse(input);
      const result = managedWorkspaceResultSchema.parse(
        await invoke(managedWorkspaceCommandChannel, request)
      );
      if (
        result.requestId !== request.requestId ||
        result.executionId !== request.executionId ||
        result.operation !== request.operation
      ) {
        throw new Error("Invalid managed workspace command correlation.");
      }
      return result;
    },
    subscribe: (listener: (event: ManagedWorkspaceEvent) => void) => {
      if (typeof listener !== "function") {
        throw new TypeError("Managed workspace listener is required.");
      }
      let active = true;
      const wrapped = (_event: unknown, value: unknown) => {
        if (active) listener(managedWorkspaceEventSchema.parse(value));
      };
      events.on(managedWorkspaceEventChannel, wrapped);
      return () => {
        active = false;
        events.removeListener(managedWorkspaceEventChannel, wrapped);
      };
    }
  });
