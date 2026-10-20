import type { MemorySourceRepository } from "@koed/db";
import type { ManagedWorkItemToolCompletion } from "./work-item-completion.js";

/** Observe only a completed Koed tool call on the leased managed execution. */
export const createReviewRequestMergeProposalObserver =
  (
    repository: Pick<
      MemorySourceRepository,
      "putManagedConversationRuntimeItem" | "getManagedConversationCommand"
    >
  ) =>
  async (event: ManagedWorkItemToolCompletion): Promise<boolean> => {
    if (
      event.toolName !== "review_request_merge_propose" ||
      !event.command.leaseToken
    )
      return false;
    const args = event.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    const input = args as Record<string, unknown>;
    if (
      Object.keys(input).length !== 1 ||
      !Number.isSafeInteger(input.number) ||
      (input.number as number) < 1
    )
      return false;
    const number = input.number as number;
    const command = await repository.getManagedConversationCommand(
      { userId: event.execution.ownerUserId },
      event.command.id
    );
    if (
      !command ||
      command.executionId !== event.execution.id ||
      command.commandKind !== "prompt" ||
      command.executionGeneration !== event.execution.executionGeneration ||
      command.leaseToken !== event.command.leaseToken ||
      command.state !== "dispatching"
    )
      return false;
    const result = event.result;
    if (!result || typeof result !== "object" || Array.isArray(result))
      return false;
    const response = result as Record<string, unknown>;
    if (response.isError === true) return false;
    const structured = response.structuredContent ?? response.details;
    const receipt =
      structured && typeof structured === "object" && !Array.isArray(structured)
        ? (structured as Record<string, unknown>)
        : null;
    const content = Array.isArray(response.content) ? response.content : [];
    const textReceipt =
      content.length === 1 &&
      typeof content[0] === "object" &&
      content[0] !== null &&
      (content[0] as Record<string, unknown>).type === "text" &&
      (content[0] as Record<string, unknown>).text ===
        `Koed review_request_merge_propose request v1: {"number":${number},"status":"requested"}`;
    if (
      receipt
        ? receipt.number !== number || receipt.status !== "requested"
        : !textReceipt
    )
      return false;
    try {
      await repository.putManagedConversationRuntimeItem(
        { userId: event.execution.ownerUserId },
        {
          executionId: event.execution.id,
          executionGeneration: event.execution.executionGeneration,
          providerRequestId: `review-request-merge-propose:${event.command.id}:${event.toolCallId ?? "result"}`,
          ...(event.providerTurnId
            ? { providerTurnId: event.providerTurnId }
            : {}),
          ...(event.toolCallId ? { providerItemId: event.toolCallId } : {}),
          itemKind: "transient_output",
          payload: {
            text: `Merge of PR #${number} proposed. Koed will ask for Native review.`,
            mergeProposal: { reviewRequestNumber: number }
          }
        }
      );
      return true;
    } catch {
      return false;
    }
  };
