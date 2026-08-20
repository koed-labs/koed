import {
  localAiClientCommandSchema,
  parseLocalAiClientResponse,
  localAiClientCommandChannel,
  type LocalAiClientCommand,
  type LocalAiClientResponse
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
  invoke: (channel: string, value: unknown) => Promise<unknown>
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
