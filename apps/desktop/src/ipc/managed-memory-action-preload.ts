import {
  managedMemoryActionChannel,
  managedMemoryActionRequestSchema,
  managedMemoryActionResultSchema,
  type ManagedMemoryActionDesktopApi,
  type ManagedMemoryActionRequest
} from "./managed-memory-action-protocol.js";

export const createManagedMemoryActionPreloadApi = (
  invoke: (
    channel: string,
    request: ManagedMemoryActionRequest
  ) => Promise<unknown>
): ManagedMemoryActionDesktopApi => {
  const command = async (request: ManagedMemoryActionRequest) => {
    const result = managedMemoryActionResultSchema.parse(
      await invoke(
        managedMemoryActionChannel,
        managedMemoryActionRequestSchema.parse(request)
      )
    );
    if (
      result.operation !== request.operation ||
      result.executionId !== request.executionId
    )
      throw new Error("Memory action response crossed Conversation identity.");
    return result;
  };
  return Object.freeze({
    list: async (executionId: string) => {
      const result = await command({ operation: "list", executionId });
      if (
        result.operation !== "list" ||
        result.actions.some((action) => action.executionId !== executionId)
      )
        throw new Error("Memory action list crossed Conversation identity.");
      return result.actions;
    },
    undo: async (executionId: string, actionId: string) => {
      const result = await command({
        operation: "undo",
        executionId,
        actionId
      });
      if (
        result.operation !== "undo" ||
        result.action.id !== actionId ||
        result.action.executionId !== executionId ||
        result.action.outcome !== "undone"
      )
        throw new Error("Memory action Undo returned a different action.");
      return result.action;
    }
  });
};
