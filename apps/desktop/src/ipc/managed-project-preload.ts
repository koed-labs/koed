import {
  managedProjectCommandChannel,
  managedProjectEventChannel,
  managedProjectEventSchema,
  managedProjectRequestSchema,
  managedProjectResultSchema,
  type ManagedProjectDesktopApi,
  type ManagedProjectEvent,
  type ManagedProjectRequest
} from "./managed-project-protocol.js";

type Invoke = (channel: string, value: unknown) => Promise<unknown>;
type Events = {
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
};

export const createManagedProjectPreloadApi = (
  invoke: Invoke,
  events: Events
): ManagedProjectDesktopApi =>
  Object.freeze({
    command: async (input: ManagedProjectRequest) => {
      const request = managedProjectRequestSchema.parse(input);
      const result = managedProjectResultSchema.parse(
        await invoke(managedProjectCommandChannel, request)
      );
      if (
        result.requestId !== request.requestId ||
        result.executionId !== request.executionId ||
        result.operation !== request.operation
      ) {
        throw new Error("Invalid managed Project command correlation.");
      }
      return result;
    },
    subscribe: (listener: (event: ManagedProjectEvent) => void) => {
      if (typeof listener !== "function") {
        throw new TypeError("Managed Project listener is required.");
      }
      let active = true;
      const wrapped = (_event: unknown, value: unknown) => {
        if (active) listener(managedProjectEventSchema.parse(value));
      };
      events.on(managedProjectEventChannel, wrapped);
      return () => {
        active = false;
        events.removeListener(managedProjectEventChannel, wrapped);
      };
    }
  });
