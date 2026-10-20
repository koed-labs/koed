import { describe, expect, it, vi } from "vitest";
import { createReviewRequestMergeProposalObserver } from "./review-request-merge-proposal.js";

const event = {
  execution: {
    id: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "owner",
    executionGeneration: 2
  },
  command: { id: "22222222-2222-4222-8222-222222222222", leaseToken: "lease" },
  providerTurnId: "turn",
  toolCallId: "tool",
  toolName: "review_request_merge_propose",
  arguments: { number: 212 },
  result: { structuredContent: { number: 212, status: "requested" } }
};

describe("merge proposal observer", () => {
  const liveCommand = {
    executionId: event.execution.id,
    commandKind: "prompt",
    executionGeneration: event.execution.executionGeneration,
    leaseToken: event.command.leaseToken,
    state: "dispatching"
  };
  it("records only a selector from a leased and matching tool completion", async () => {
    const putManagedConversationRuntimeItem = vi.fn(async () => undefined);
    const observe = createReviewRequestMergeProposalObserver({
      getManagedConversationCommand: vi.fn(async () => liveCommand),
      putManagedConversationRuntimeItem
    } as never);
    expect(await observe(event)).toBe(true);
    expect(putManagedConversationRuntimeItem).toHaveBeenCalledWith(
      { userId: "owner" },
      expect.objectContaining({
        payload: {
          text: expect.any(String),
          mergeProposal: { reviewRequestNumber: 212 }
        }
      })
    );
  });
  it("rejects forged receipts and missing leases", async () => {
    const putManagedConversationRuntimeItem = vi.fn(async () => undefined);
    const observe = createReviewRequestMergeProposalObserver({
      getManagedConversationCommand: vi.fn(async () => liveCommand),
      putManagedConversationRuntimeItem
    } as never);
    expect(
      await observe({
        ...event,
        command: { ...event.command, leaseToken: null }
      })
    ).toBe(false);
    expect(
      await observe({
        ...event,
        result: { structuredContent: { number: 213, status: "requested" } }
      })
    ).toBe(false);
    expect(putManagedConversationRuntimeItem).not.toHaveBeenCalled();
  });
  it("rejects a stale or different command lease", async () => {
    const putManagedConversationRuntimeItem = vi.fn(async () => undefined);
    const getManagedConversationCommand = vi.fn(async () => ({
      ...liveCommand,
      leaseToken: "different"
    }));
    const observe = createReviewRequestMergeProposalObserver({
      getManagedConversationCommand,
      putManagedConversationRuntimeItem
    } as never);
    expect(await observe(event)).toBe(false);
    getManagedConversationCommand.mockResolvedValue({
      ...liveCommand,
      leaseToken: "lease",
      executionId: "other"
    });
    expect(await observe(event)).toBe(false);
    expect(putManagedConversationRuntimeItem).not.toHaveBeenCalled();
  });
});
