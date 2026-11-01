import {
  v1StateChannel,
  v1StateRequestSchema,
  v1StateResponseSchema,
  type V1StateDesktopApi,
  type V1StateRequest,
  type V1StateResponse
} from "./v1-state-protocol.js";

export const createV1StatePreloadApi = (
  invoke: (channel: string, request: unknown) => Promise<unknown>
): V1StateDesktopApi => {
  const call = async <O extends V1StateRequest["operation"]>(
    request: V1StateRequest & { operation: O }
  ) => {
    const parsed = v1StateRequestSchema.parse(request);
    const result = v1StateResponseSchema.parse(
      await invoke(v1StateChannel, parsed)
    );
    if (result.operation !== parsed.operation)
      throw new Error("Invalid V1 state response correlation.");
    return result as Extract<V1StateResponse, { operation: O }>;
  };
  return Object.freeze({
    readIdentity: async () => {
      const result = await call({ operation: "identity_read" });
      return { ownerId: result.ownerId, scopeKey: result.scopeKey };
    },
    readProfile: async () =>
      (await call({ operation: "profile_read" })).profile,
    writeProfile: async (profile) =>
      (await call({ operation: "profile_write", profile })).profile,
    readProvenance: async () =>
      (await call({ operation: "provenance_read" })).provenance,
    putConversationIntent: async (intent) =>
      (await call({ operation: "conversation_intent_put", intent })).intent,
    saveInitialPrompt: async (input) =>
      (await call({ operation: "conversation_prompt", ...input })).intent,
    ackConversation: async (input) =>
      (await call({ operation: "conversation_ack", ...input })).intent,
    putProjectIntent: async (intent) =>
      (await call({ operation: "project_intent_put", intent })).intent,
    ackProjectFolder: async (requestId) =>
      (await call({ operation: "project_folder_ack", requestId })).intent,
    ackProject: async (input) =>
      (await call({ operation: "project_ack", ...input })).intent
  } as V1StateDesktopApi);
};
