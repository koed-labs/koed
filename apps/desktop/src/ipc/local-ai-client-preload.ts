import {
  localAiClientCommandSchema,
  parseLocalAiClientResponse,
  localAiClientCommandChannel,
  localAiClientUsageChangedChannel,
  localAiClientUsageChangedSchema,
  type LocalAiClientCommand,
  type LocalAiClientResponse,
  type LocalAiClientUsageChanged
} from "./local-ai-client-protocol.js";

type LocalAiClientInvoke = (
  command: LocalAiClientCommand
) => Promise<LocalAiClientResponse>;

const correlated = <Operation extends LocalAiClientCommand["operation"]>(
  operation: Operation,
  value: unknown
): LocalAiClientResponse => {
  const response = parseLocalAiClientResponse(value);
  if (response.operation !== operation) {
    throw new Error("Invalid Local AI Client operation correlation.");
  }
  return response;
};

export const createLocalAiClientPreloadApi = (
  invoke: (channel: string, value: unknown) => Promise<unknown>,
  events?: {
    on(
      channel: string,
      listener: (_event: unknown, value: unknown) => void
    ): void;
    removeListener(
      channel: string,
      listener: (_event: unknown, value: unknown) => void
    ): void;
  }
) => {
  const invokeCommand: LocalAiClientInvoke = async (command) =>
    correlated(
      command.operation,
      await invoke(localAiClientCommandChannel, command)
    );
  const api = {
    list: async (): Promise<LocalAiClientResponse> =>
      invokeCommand({ operation: "list" }),
    refresh: async (): Promise<LocalAiClientResponse> =>
      invokeCommand({ operation: "refresh" }),
    usage: async (instanceId?: string): Promise<LocalAiClientResponse> =>
      invokeCommand(
        instanceId
          ? { operation: "usage", action: "refresh", instanceId }
          : { operation: "usage", action: "read" }
      ),
    onUsageChanged: (
      listener: (change: LocalAiClientUsageChanged) => void
    ): (() => void) => {
      if (!events) return () => undefined;
      const wrapped = (_event: unknown, value: unknown) => {
        const parsed = localAiClientUsageChangedSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
      };
      events.on(localAiClientUsageChangedChannel, wrapped);
      return () =>
        events.removeListener(localAiClientUsageChangedChannel, wrapped);
    },
    set: async (
      flowKey: Extract<LocalAiClientCommand, { operation: "set" }>["flowKey"],
      assignment: Extract<
        LocalAiClientCommand,
        { operation: "set" }
      >["assignment"]
    ): Promise<LocalAiClientResponse> => {
      const command = localAiClientCommandSchema.parse({
        operation: "set",
        flowKey,
        assignment
      });
      return invokeCommand(command);
    },
    reset: async (
      flowKey: Extract<LocalAiClientCommand, { operation: "reset" }>["flowKey"]
    ): Promise<LocalAiClientResponse> => {
      const command = localAiClientCommandSchema.parse({
        operation: "reset",
        flowKey
      });
      return invokeCommand(command);
    }
  };
  return Object.freeze(api);
};
