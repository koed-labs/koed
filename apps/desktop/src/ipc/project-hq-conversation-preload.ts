import {
  projectHqConversationChannel,
  projectHqConversationRequestSchema,
  projectHqConversationResultSchema,
  type ProjectHqConversationDesktopApi,
  type ProjectHqConversationRequest
} from "./project-hq-conversation-protocol.js";

export const createProjectHqConversationPreloadApi = (
  invoke: (
    channel: string,
    request: ProjectHqConversationRequest
  ) => Promise<unknown>
): ProjectHqConversationDesktopApi => {
  const command = async (request: ProjectHqConversationRequest) => {
    const result = projectHqConversationResultSchema.parse(
      await invoke(
        projectHqConversationChannel,
        projectHqConversationRequestSchema.parse(request)
      )
    );
    if (result.operation !== request.operation)
      throw new Error("Invalid Project HQ Conversation correlation.");
    return result;
  };
  return Object.freeze({
    read: async (projectId: string) => {
      const result = await command({ operation: "read", projectId });
      if (
        result.operation !== "read" ||
        (result.value.conversation &&
          result.value.conversation.projectId !== projectId)
      )
        throw new Error("Invalid Project HQ Conversation identity.");
      return result.value;
    },
    reserve: async (projectId: string) => {
      const result = await command({ operation: "reserve", projectId });
      if (
        result.operation !== "reserve" ||
        result.value.projectId !== projectId
      )
        throw new Error("Invalid Project HQ Conversation identity.");
      return result.value;
    },
    start: async (
      projectId: string,
      prompt: string,
      permissionMode?: "supervised" | "auto_edit" | "auto" | "full_access",
      selectedDocumentSourceId?: string
    ) => {
      const result = await command({
        operation: "start",
        projectId,
        prompt,
        ...(permissionMode ? { permissionMode } : {}),
        ...(selectedDocumentSourceId ? { selectedDocumentSourceId } : {})
      });
      if (result.operation !== "start" || result.projectId !== projectId)
        throw new Error("Invalid Project HQ Conversation start.");
      return {
        projectId: result.projectId,
        executionId: result.executionId,
        commandId: result.commandId,
        commandState: result.commandState
      };
    }
  });
};
