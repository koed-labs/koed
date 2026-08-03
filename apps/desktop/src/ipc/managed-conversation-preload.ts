import {
  managedConversationCommandChannel,
  parseManagedConversationRequest,
  parseManagedConversationResult,
  type ManagedConversationDesktopApi,
  type ManagedConversationResult
} from "./managed-conversation-protocol.js";

export type ManagedConversationIpcInvoke = (
  channel: string,
  value: unknown
) => Promise<unknown>;

const correlated = <Operation extends ManagedConversationResult["operation"]>(
  operation: Operation,
  value: unknown
): Extract<ManagedConversationResult, { operation: Operation }> => {
  const result = parseManagedConversationResult(value);
  if (result.operation !== operation) {
    throw new Error("Invalid Managed Conversation operation correlation.");
  }
  return result as Extract<ManagedConversationResult, { operation: Operation }>;
};

export const createManagedConversationPreloadApi = (
  invoke: ManagedConversationIpcInvoke
): ManagedConversationDesktopApi => {
  const api: ManagedConversationDesktopApi = {
    start: async (projectId: string, idempotencyKey: string) => {
      const request = parseManagedConversationRequest({
        operation: "start",
        projectId,
        idempotencyKey
      }) as Extract<
        ReturnType<typeof parseManagedConversationRequest>,
        { operation: "start" }
      >;
      return correlated(
        "start",
        await invoke(managedConversationCommandChannel, request)
      );
    },
    inspect: async (executionId: string) => {
      const request = parseManagedConversationRequest({
        operation: "inspect",
        executionId
      }) as Extract<
        ReturnType<typeof parseManagedConversationRequest>,
        { operation: "inspect" }
      >;
      const result = correlated(
        "inspect",
        await invoke(managedConversationCommandChannel, request)
      );
      if (result.executionId !== request.executionId) {
        throw new Error("Invalid Managed Conversation inspection correlation.");
      }
      return result;
    },
    resume: async (input) => {
      const request = parseManagedConversationRequest({
        operation: "resume",
        ...input
      }) as Extract<
        ReturnType<typeof parseManagedConversationRequest>,
        { operation: "resume" }
      >;
      return correlated(
        "resume",
        await invoke(managedConversationCommandChannel, request)
      );
    },
    send: async (input) => {
      const request = parseManagedConversationRequest({
        operation: "send",
        ...input
      }) as Extract<
        ReturnType<typeof parseManagedConversationRequest>,
        { operation: "send" }
      >;
      const result = correlated(
        "send",
        await invoke(managedConversationCommandChannel, request)
      );
      if (result.idempotencyKey !== request.idempotencyKey) {
        throw new Error("Invalid Managed Conversation send correlation.");
      }
      return result;
    },
    targets: async () => {
      const request = parseManagedConversationRequest({
        operation: "targets"
      });
      return correlated(
        "targets",
        await invoke(managedConversationCommandChannel, request)
      );
    },
    transferStatus: async (executionId: string) => {
      const request = parseManagedConversationRequest({
        operation: "transfer_status",
        executionId
      }) as Extract<
        ReturnType<typeof parseManagedConversationRequest>,
        { operation: "transfer_status" }
      >;
      const result = correlated(
        "transfer_status",
        await invoke(managedConversationCommandChannel, request)
      );
      if (result.executionId !== request.executionId) {
        throw new Error(
          "Invalid Managed Conversation transfer status correlation."
        );
      }
      return result;
    },
    handoff: async (input) => {
      const request = parseManagedConversationRequest({
        operation: "handoff",
        ...input
      }) as Extract<
        ReturnType<typeof parseManagedConversationRequest>,
        { operation: "handoff" }
      >;
      const result = correlated(
        "handoff",
        await invoke(managedConversationCommandChannel, request)
      );
      if (result.operationId !== request.operationId) {
        throw new Error("Invalid Managed Conversation handoff correlation.");
      }
      return result;
    },
    fork: async (input) => {
      const request = parseManagedConversationRequest({
        operation: "fork",
        ...input
      }) as Extract<
        ReturnType<typeof parseManagedConversationRequest>,
        { operation: "fork" }
      >;
      const result = correlated(
        "fork",
        await invoke(managedConversationCommandChannel, request)
      );
      if (result.operationId !== request.operationId) {
        throw new Error("Invalid Managed Conversation fork correlation.");
      }
      return result;
    }
  };
  return Object.freeze(api);
};
