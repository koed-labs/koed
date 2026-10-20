import type { MemorySourceRepository } from "@koed/db";

export type ManagedWorkItemToolCompletion = {
  execution: { id: string; ownerUserId: string; executionGeneration: number };
  command: { id: string; leaseToken: string | null };
  providerTurnId?: string;
  toolCallId?: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
};

/** Called only by the trusted provider transport after a Koed MCP tool completes. */
export const createWorkItemCompletionObserver =
  (
    repository: Pick<
      MemorySourceRepository,
      "completeForManagedExecutionLease" | "putManagedConversationRuntimeItem"
    >
  ) =>
  async (event: ManagedWorkItemToolCompletion): Promise<boolean> => {
    if (event.toolName !== "work_item_complete" || !event.command.leaseToken)
      return false;
    const args = event.arguments;
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).length !== 0
    )
      return false;
    const result = event.result;
    if (!result || typeof result !== "object" || Array.isArray(result))
      return false;
    const response = result as {
      isError?: unknown;
      structuredContent?: unknown;
      details?: unknown;
    };
    const receipt = response.structuredContent ?? response.details;
    if (
      response.isError === true ||
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      (receipt as { status?: unknown }).status !== "requested"
    )
      return false;
    let accepted = false;
    try {
      await repository.completeForManagedExecutionLease({
        ownerUserId: event.execution.ownerUserId,
        executionId: event.execution.id,
        commandId: event.command.id,
        leaseToken: event.command.leaseToken
      });
      accepted = true;
    } catch {
      // A stale or duplicate request is a Work Item outcome, not a provider turn failure.
    }
    try {
      await repository.putManagedConversationRuntimeItem(
        { userId: event.execution.ownerUserId },
        {
          executionId: event.execution.id,
          executionGeneration: event.execution.executionGeneration,
          providerRequestId: `work-item-complete:${event.command.id}:${event.toolCallId ?? "result"}`,
          ...(event.providerTurnId
            ? { providerTurnId: event.providerTurnId }
            : {}),
          ...(event.toolCallId ? { providerItemId: event.toolCallId } : {}),
          itemKind: "transient_output",
          payload: {
            text: accepted
              ? "Work Item completion accepted."
              : "Work Item completion rejected: its execution or status changed."
          }
        }
      );
    } catch {
      // A retired generation cannot receive a runtime item; the worker remains usable.
    }
    return accepted;
  };
