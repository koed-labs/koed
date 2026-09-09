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
    launchOptions: async () =>
      correlated(
        "launch_options",
        await invoke(
          managedConversationCommandChannel,
          parseManagedConversationRequest({ operation: "launch_options" })
        )
      ),
    start: async (input) => {
      const request = parseManagedConversationRequest({
        operation: "start",
        ...input
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
        ...input,
        fileMentionCommandIds: input.fileMentionCommandIds ?? [],
        terminalContextReferences: input.terminalContextReferences ?? []
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
      if (result.clientUserMessageId !== request.clientUserMessageId) {
        throw new Error(
          "Invalid Managed Conversation user message correlation."
        );
      }
      return result;
    },
    readDraft: async (input) =>
      correlated(
        "draft_read",
        await invoke(
          managedConversationCommandChannel,
          parseManagedConversationRequest({ operation: "draft_read", ...input })
        )
      ),
    writeDraft: async (input) =>
      correlated(
        "draft_write",
        await invoke(
          managedConversationCommandChannel,
          parseManagedConversationRequest({
            operation: "draft_write",
            ...input
          })
        )
      ),
    deleteDraft: async (input) =>
      correlated(
        "draft_delete",
        await invoke(
          managedConversationCommandChannel,
          parseManagedConversationRequest({
            operation: "draft_delete",
            ...input
          })
        )
      ),
    targets: async () => {
      const request = parseManagedConversationRequest({
        operation: "targets"
      });
      return correlated(
        "targets",
        await invoke(managedConversationCommandChannel, request)
      );
    },
    usage: async (executionId: string) => {
      const request = parseManagedConversationRequest({
        operation: "usage",
        executionId
      }) as Extract<
        ReturnType<typeof parseManagedConversationRequest>,
        { operation: "usage" }
      >;
      const result = correlated(
        "usage",
        await invoke(managedConversationCommandChannel, request)
      );
      if (result.executionId !== request.executionId) {
        throw new Error("Invalid Managed Conversation usage correlation.");
      }
      return result;
    },
    runtime: async (executionId: string) => {
      const request = parseManagedConversationRequest({
        operation: "runtime",
        executionId
      });
      const result = correlated(
        "runtime",
        await invoke(managedConversationCommandChannel, request)
      );
      if (result.executionId !== executionId) {
        throw new Error("Invalid Managed Conversation runtime correlation.");
      }
      return result;
    },
    respond: async (input) => {
      const request = parseManagedConversationRequest({
        operation: "runtime_respond",
        ...input
      });
      const result = correlated(
        "runtime_respond",
        await invoke(managedConversationCommandChannel, request)
      );
      if (result.itemId !== input.itemId) {
        throw new Error("Invalid Managed Conversation response correlation.");
      }
      return result;
    },
    interrupt: async (input) => {
      const request = parseManagedConversationRequest({
        operation: "interrupt",
        ...input
      });
      return correlated(
        "interrupt",
        await invoke(managedConversationCommandChannel, request)
      );
    },
    stop: async (input) => {
      const request = parseManagedConversationRequest({
        operation: "stop",
        ...input
      });
      return correlated(
        "stop",
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
