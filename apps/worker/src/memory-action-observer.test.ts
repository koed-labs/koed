import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManagedMemoryActionObserver,
  createManagedMemoryActionProcessor
} from "./memory-action-observer.js";

const owner = "11111111-1111-4111-8111-111111111111";
const executionId = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";
const leaseToken = "44444444-4444-4444-8444-444444444444";
const alias = `r${"a".repeat(32)}c1`;
const oldAlias = `r${"b".repeat(32)}c1`;
const actor = { userId: owner };
const event = (toolName: string, arguments_: unknown = {}) => ({
  execution: { id: executionId, ownerUserId: owner, executionGeneration: 1 },
  command: { id: commandId, leaseToken },
  providerTurnId: "current-turn",
  toolCallId: "tool-1",
  toolName,
  arguments: arguments_,
  result: { structuredContent: { status: "requested" } }
});
const repository = {
  getManagedConversationCommand: vi.fn(),
  getManagedConversationExecution: vi.fn(),
  getManagedConversationRuntimeBinding: vi.fn(),
  enqueueManagedMemoryAction: vi.fn(),
  listManagedMemoryActionsForCommand: vi.fn(),
  withManagedMemoryActionLease: vi.fn(),
  listLcmGraphEvents: vi.fn(),
  listManagedConversationCitationsByAliases: vi.fn(),
  getManagedConversationCitationLocator: vi.fn(),
  getManagedPersonalQuestionCitation: vi.fn(),
  getCuratedMemoryAssertion: vi.fn(),
  suppressCuratedMemoryAssertion: vi.fn(),
  resolveCuratedMemoryProposalEvidence: vi.fn(),
  getManagedMemoryActionUserSource: vi.fn(),
  findManagedMemoryCorrectionProposal: vi.fn(),
  createCuratedMemoryProposal: vi.fn(),
  putManagedConversationRuntimeItem: vi.fn()
};
const command = (prompt: string) => ({
  id: commandId,
  executionId,
  commandKind: "prompt",
  leaseToken,
  state: "dispatching",
  executionGeneration: 1,
  clientUserMessageId: "55555555-5555-4555-8555-555555555555",
  payload: { prompt },
  createdAt: "2026-10-20T10:02:00Z"
});
const action = (
  prompt: string,
  actionKind: "forget" | "correct" = "forget"
) => ({
  id: "66666666-6666-4666-8666-666666666666",
  state: "pending",
  providerTurnId: "current-turn",
  toolCallId: "tool-1",
  actionKind,
  request: { userPrompt: prompt }
});
const run = () =>
  createManagedMemoryActionProcessor(
    repository as never,
    "deployment-1"
  )({
    ownerUserId: owner,
    executionId,
    commandId,
    leaseToken,
    executionGeneration: 1
  });

describe("managed memory action capture boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.getManagedConversationCommand.mockResolvedValue(
      command("Forget that")
    );
    repository.getManagedConversationExecution.mockResolvedValue({
      id: executionId,
      executionGeneration: 1,
      providerThreadId: "thread-1"
    });
    repository.getManagedConversationRuntimeBinding.mockResolvedValue({
      localSessionId: "local-session-1",
      executionGeneration: 1
    });
    repository.enqueueManagedMemoryAction.mockResolvedValue(
      action("Forget that")
    );
    repository.listManagedMemoryActionsForCommand.mockResolvedValue([
      action("Forget that")
    ]);
    repository.withManagedMemoryActionLease.mockImplementation(
      async (_actor, _input, process) => {
        const result = await process(action("Forget that"), {
          localSessionId: "local-session-1",
          clientUserMessageId: command("Forget that").clientUserMessageId
        });
        return { ...action("Forget that"), result };
      }
    );
    repository.listLcmGraphEvents.mockResolvedValue([
      {
        actor: "agent",
        content: `Older [m:${oldAlias}]`,
        timestamp: "2026-10-20T10:00:00Z",
        sourceSequence: 1,
        sessionId: "local-session-1"
      },
      {
        actor: "agent",
        content: `Latest [m:${alias}]`,
        timestamp: "2026-10-20T10:01:00Z",
        sourceSequence: 2,
        sessionId: "local-session-1"
      }
    ]);
    repository.listManagedConversationCitationsByAliases.mockResolvedValue([
      {
        alias: oldAlias,
        visibility: "personal",
        sourceType: "curated_memory",
        sourceId: "older",
        providerTurnId: "old"
      },
      {
        alias,
        visibility: "team",
        sourceType: "curated_memory",
        sourceId: "team",
        providerTurnId: "latest"
      }
    ]);
    repository.putManagedConversationRuntimeItem.mockResolvedValue({});
  });

  it("queues only after a trusted receipt and affirmative User prompt", async () => {
    const observe = createManagedMemoryActionObserver(repository as never);
    expect(await observe(event("memory_forget"))).toBe(true);
    expect(repository.enqueueManagedMemoryAction).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        commandId,
        actionKind: "forget",
        request: { userPrompt: "Forget that" }
      })
    );
    expect(repository.suppressCuratedMemoryAssertion).not.toHaveBeenCalled();
    repository.getManagedConversationCommand.mockResolvedValue(
      command("Do not forget that")
    );
    expect(await observe(event("memory_forget"))).toBe(false);
    expect(repository.enqueueManagedMemoryAction).toHaveBeenCalledTimes(1);
    repository.getManagedConversationCommand.mockResolvedValue(
      command("Can you please forget that?")
    );
    expect(await observe(event("memory_forget"))).toBe(true);
    repository.getManagedConversationCommand.mockResolvedValue(
      command("What does 'forget that' mean?")
    );
    expect(await observe(event("memory_forget"))).toBe(false);
    repository.getManagedConversationCommand.mockResolvedValue(
      command("'Forget that' is a quote from the source")
    );
    expect(await observe(event("memory_forget"))).toBe(false);
    repository.getManagedConversationCommand.mockResolvedValue(
      command("Could you please not forget that?")
    );
    expect(await observe(event("memory_forget"))).toBe(false);
    repository.getManagedConversationCommand.mockResolvedValue(
      command("That's outdated; the correct value is blue")
    );
    expect(
      await observe(
        event("memory_correct", {
          correction: "blue",
          user_statement: "That's outdated; the correct value is blue"
        })
      )
    ).toBe(true);
    repository.getManagedConversationCommand.mockResolvedValue(
      command("That's outdated")
    );
    expect(
      await observe(
        event("memory_correct", {
          correction: "blue",
          user_statement: "That's outdated"
        })
      )
    ).toBe(true);
  });

  it("keeps latest cited teammate ownership and never mutates the older owned source", async () => {
    await run();
    expect(
      repository.getManagedConversationCitationLocator
    ).not.toHaveBeenCalled();
    expect(repository.suppressCuratedMemoryAssertion).not.toHaveBeenCalled();
    expect(repository.putManagedConversationRuntimeItem).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: "ask_owner" })
      })
    );
  });

  it("rejects a model-selected older alias against an unqualified User prompt", async () => {
    repository.listManagedMemoryActionsForCommand.mockResolvedValue([
      {
        ...action("Forget that"),
        request: { userPrompt: "Forget that", requestedAlias: oldAlias }
      }
    ]);
    repository.withManagedMemoryActionLease.mockImplementation(
      async (_actor, _input, process) => ({
        ...action("Forget that"),
        result: await process(
          {
            ...action("Forget that"),
            request: { userPrompt: "Forget that", requestedAlias: oldAlias }
          },
          {
            localSessionId: "local-session-1",
            clientUserMessageId: command("Forget that").clientUserMessageId
          }
        )
      })
    );
    await run();
    expect(repository.suppressCuratedMemoryAssertion).not.toHaveBeenCalled();
    expect(repository.putManagedConversationRuntimeItem).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        payload: expect.objectContaining({ outcome: "ask_reference" })
      })
    );
  });

  it("suppresses only the current owned Curated assertion with an action-bound reason", async () => {
    repository.listManagedConversationCitationsByAliases.mockResolvedValue([
      {
        alias,
        visibility: "personal",
        sourceType: "curated_memory",
        sourceId: "77777777-7777-4777-8777-777777777777",
        providerTurnId: "latest"
      }
    ]);
    repository.getManagedConversationCitationLocator.mockResolvedValue({
      backendId: "deployment-1",
      sourceNamespace: "deployment-1",
      sourceOwnerPrincipalId: owner,
      visibility: "personal",
      sourceType: "curated_memory",
      sourceId: "77777777-7777-4777-8777-777777777777",
      questionId: "88888888-8888-4888-8888-888888888888",
      ordinal: 0
    });
    repository.getManagedPersonalQuestionCitation.mockResolvedValue({
      sourceType: "curated_memory",
      sourceId: "77777777-7777-4777-8777-777777777777",
      sourceOwnerPrincipalId: owner
    });
    repository.getCuratedMemoryAssertion.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      ownerUserId: owner,
      visibility: "personal",
      status: "current",
      suppressedAt: null
    });
    repository.suppressCuratedMemoryAssertion.mockResolvedValue({
      suppressionToken: "stored-only-token"
    });
    await run();
    expect(repository.suppressCuratedMemoryAssertion).toHaveBeenCalledWith(
      actor,
      "77777777-7777-4777-8777-777777777777",
      { reason: `managed-memory-action:${action("Forget that").id}` }
    );
    expect(repository.putManagedConversationRuntimeItem).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        payload: expect.not.objectContaining({
          suppressionToken: expect.anything()
        })
      })
    );
  });

  it("creates a reviewed correction only from the exact captured User item", async () => {
    const prompt = "Correct citation 1 to new wording";
    const correctionAction = {
      ...action(prompt, "correct"),
      request: {
        userPrompt: prompt,
        correction: "new wording",
        userStatement: prompt
      }
    };
    repository.getManagedConversationCommand.mockResolvedValue(command(prompt));
    repository.listManagedMemoryActionsForCommand.mockResolvedValue([
      correctionAction
    ]);
    repository.withManagedMemoryActionLease.mockImplementation(
      async (_actor, _input, process) => ({
        ...correctionAction,
        result: await process(correctionAction, {
          localSessionId: "local-session-1",
          clientUserMessageId: command(prompt).clientUserMessageId
        })
      })
    );
    repository.listManagedConversationCitationsByAliases.mockResolvedValue([
      {
        alias,
        visibility: "personal",
        sourceType: "curated_memory",
        sourceId: "77777777-7777-4777-8777-777777777777",
        providerTurnId: "latest"
      }
    ]);
    repository.getManagedConversationCitationLocator.mockResolvedValue({
      backendId: "deployment-1",
      sourceNamespace: "deployment-1",
      sourceOwnerPrincipalId: owner,
      visibility: "personal",
      sourceType: "curated_memory",
      sourceId: "77777777-7777-4777-8777-777777777777",
      questionId: "88888888-8888-4888-8888-888888888888",
      ordinal: 0
    });
    repository.getManagedPersonalQuestionCitation.mockResolvedValue({
      sourceType: "curated_memory",
      sourceId: "77777777-7777-4777-8777-777777777777",
      sourceOwnerPrincipalId: owner
    });
    repository.getCuratedMemoryAssertion.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      ownerUserId: owner,
      visibility: "personal",
      status: "current",
      suppressedAt: null
    });
    const sourceId = "99999999-9999-4999-8999-999999999999";
    repository.getManagedMemoryActionUserSource.mockResolvedValue(sourceId);
    repository.resolveCuratedMemoryProposalEvidence.mockResolvedValue({
      evidenceConversationItemIds: [sourceId],
      evidenceMemoryEventIds: []
    });
    repository.findManagedMemoryCorrectionProposal.mockResolvedValue(null);
    repository.createCuratedMemoryProposal.mockResolvedValue({
      id: "proposal-id"
    });
    await run();
    expect(repository.createCuratedMemoryProposal).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        operation: "supersede",
        proposedClaim: "new wording",
        evidenceConversationItemIds: [sourceId],
        targetAssertionId: "77777777-7777-4777-8777-777777777777"
      })
    );
    repository.getManagedMemoryActionUserSource.mockResolvedValue(null);
    repository.createCuratedMemoryProposal.mockClear();
    await run();
    expect(repository.createCuratedMemoryProposal).not.toHaveBeenCalled();
  });
});
