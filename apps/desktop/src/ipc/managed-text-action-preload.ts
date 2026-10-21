import {
  managedTextActionChannel,
  managedTextActionRequestSchema,
  managedTextActionResultSchema,
  type ManagedTextActionDesktopApi,
  type ManagedTextActionRequest
} from "./managed-text-action-protocol.js";

export const createManagedTextActionPreloadApi = (
  invoke: (
    channel: string,
    request: ManagedTextActionRequest
  ) => Promise<unknown>
): ManagedTextActionDesktopApi => {
  const command = async (request: ManagedTextActionRequest) => {
    const result = managedTextActionResultSchema.parse(
      await invoke(
        managedTextActionChannel,
        managedTextActionRequestSchema.parse(request)
      )
    );
    if (
      result.operation !== request.operation ||
      result.executionId !== request.executionId
    )
      throw new Error("Koed action response crossed Conversation identity.");
    if (
      request.operation !== "list" &&
      result.operation !== "list" &&
      result.action.id !== request.actionId
    )
      throw new Error("Koed action response crossed action identity.");
    return result;
  };
  return Object.freeze({
    list: async (executionId: string) => {
      const result = await command({ operation: "list", executionId });
      if (
        result.operation !== "list" ||
        result.actions.some((action) => action.executionId !== executionId)
      )
        throw new Error("Koed action list crossed Conversation identity.");
      return result.actions;
    },
    get: async (executionId: string, actionId: string) => {
      const result = await command({ operation: "get", executionId, actionId });
      if (
        result.operation !== "get" ||
        result.action.executionId !== executionId
      )
        throw new Error("Koed action read crossed Conversation identity.");
      return result.action;
    },
    review: async (
      executionId: string,
      actionId: string,
      expectedRevision: number,
      decision: "approve" | "decline"
    ) => {
      const result = await command({
        operation: "review",
        executionId,
        actionId,
        expectedRevision,
        decision
      });
      if (
        result.operation !== "review" ||
        result.action.executionId !== executionId
      )
        throw new Error("Koed action review crossed Conversation identity.");
      return result.action;
    },
    claim: async (
      executionId: string,
      actionId: string,
      expectedRevision: number
    ) => {
      const result = await command({
        operation: "claim",
        executionId,
        actionId,
        expectedRevision
      });
      if (
        result.operation !== "claim" ||
        result.action.executionId !== executionId
      )
        throw new Error("Koed action claim crossed Conversation identity.");
      return result.action;
    },
    complete: async (
      executionId: string,
      actionId: string,
      expectedRevision: number
    ) => {
      const result = await command({
        operation: "complete",
        executionId,
        actionId,
        expectedRevision
      });
      if (
        result.operation !== "complete" ||
        result.action.executionId !== executionId
      )
        throw new Error(
          "Koed action completion crossed Conversation identity."
        );
      return result.action;
    },
    applyTeamTodoAdd: async (
      executionId: string,
      actionId: string,
      expectedRevision: number
    ) => {
      const result = await command({
        operation: "apply-team-todo-add",
        executionId,
        actionId,
        expectedRevision
      });
      if (
        result.operation !== "apply-team-todo-add" ||
        result.action.executionId !== executionId
      )
        throw new Error("Koed Team action crossed Conversation identity.");
      return result.action;
    }
  });
};
