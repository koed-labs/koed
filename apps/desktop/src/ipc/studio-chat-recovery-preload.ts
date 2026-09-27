import {
  parseStudioChatRecoveryRequest,
  parseStudioChatRecoveryResult,
  studioChatRecoveryCommandChannel
} from "./studio-chat-recovery-protocol.js";

export type StudioChatRecoveryInvoke = (
  channel: string,
  value: unknown
) => Promise<unknown>;

export const createStudioChatRecoveryPreloadApi = (
  invoke: StudioChatRecoveryInvoke
) => {
  const invokeFor = async (request: unknown, expected: string) => {
    const result = parseStudioChatRecoveryResult(
      await invoke(
        studioChatRecoveryCommandChannel,
        parseStudioChatRecoveryRequest(request)
      )
    );
    if (result.operation !== expected) {
      throw new Error("Invalid Studio chat recovery operation correlation.");
    }
    return result;
  };

  return Object.freeze({
    read: async (input: { ownerId: string; executionId: string }) => {
      const result = await invokeFor({ operation: "read", ...input }, "read");
      if (result.operation !== "read") {
        throw new Error("Invalid Studio chat recovery operation correlation.");
      }
      return result.value;
    },
    write: async (input: {
      ownerId: string;
      executionId: string;
      value: string;
    }) => {
      await invokeFor({ operation: "write", ...input }, "write");
    },
    delete: async (input: { ownerId: string; executionId: string }) => {
      await invokeFor({ operation: "delete", ...input }, "delete");
    }
  });
};
