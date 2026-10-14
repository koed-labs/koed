import type { ClaimedPersonalAgentChatDelivery } from "@koed/db";
import type { PersonalAgentChatContextTransfer } from "@koed/shared";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createLocalPersonalAgentChatRunnerAuthority,
  createPersonalAgentChatDispatcher,
  type PersonalAgentChatChildResult,
  type PersonalAgentChatRunnerAuthority
} from "./personal-agent-chat-dispatcher.js";

const id = (tail: string): string =>
  `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const conversationId = id("1");
const deliveryId = id("2");
const messageId = id("3");
const executionId = id("4");
const startCommandId = id("5");
const promptCommandId = id("6");
const claimToken = id("7");

const contextTransfer: PersonalAgentChatContextTransfer = {
  cursorBeforeSequence: 1,
  cursorThroughSequence: 3,
  lastContextMessageSequence: 3,
  transferredExchanges: 1,
  transferredMessages: 2,
  omittedExchanges: 0,
  omittedMessages: 0,
  includedUtf8Bytes: 24,
  omittedUtf8Bytes: 0,
  omittedUtf8BytesKnown: true,
  truncated: false,
  omissionsStatus: "not_provided",
  omittedSequenceRange: null
};

const delivery = (
  overrides: Partial<ClaimedPersonalAgentChatDelivery> = {}
): ClaimedPersonalAgentChatDelivery =>
  ({
    deliveryId,
    conversationId,
    ownerUserId: id("8"),
    turnId: id("9"),
    messageId,
    ordinal: 0,
    claimToken,
    targetDeviceId: id("10"),
    targetDeploymentId: id("11"),
    launch: {
      kind: "generic",
      agentId: null,
      agentVersion: null,
      provider: "codex",
      aiClientInstanceId: "codex-personal",
      targetDeviceId: id("10"),
      model: "gpt-test",
      reasoningEffort: null,
      permissionMode: "supervised",
      selectedResourceIds: []
    },
    prompt: "Answer the user's question once.",
    personalAgentContext: null,
    conversationContextText: '{"messages":[{"text":"public context"}]}',
    contextTransfer,
    executionId: null,
    commandId: null,
    ...overrides
  }) as ClaimedPersonalAgentChatDelivery;

const childResult = (
  overrides: Partial<PersonalAgentChatChildResult> = {}
): PersonalAgentChatChildResult => ({
  status: "pending",
  messageId,
  executionId,
  executionGeneration: 1,
  startCommandId,
  promptCommandId,
  assistantOutput: null,
  jobId: null,
  errorCode: null,
  cancelRequested: false,
  terminal: false,
  ...overrides
});

const makeAuthority = (
  overrides: Partial<PersonalAgentChatRunnerAuthority> = {}
): PersonalAgentChatRunnerAuthority => ({
  claimDelivery: vi.fn(async () => delivery()),
  renewDeliveryClaim: vi.fn(async () => true),
  prepareChild: vi.fn(async () => ({
    execution: { id: executionId } as never,
    command: { id: startCommandId } as never
  })),
  getChildResult: vi.fn(async () => null),
  cancelChild: vi.fn(async () => ({ state: "canceled" })),
  cancelBatch: vi.fn(async () => ({})),
  completeDelivery: vi.fn(async () => true),
  failDelivery: vi.fn(async () => true),
  ...overrides
});

const createDispatcher = (
  authority: PersonalAgentChatRunnerAuthority,
  processManagedCommands = vi.fn(async () => ({ completed: 0, failed: 0 }))
) =>
  createPersonalAgentChatDispatcher({
    authority,
    processManagedCommands,
    ownerUserId: id("8"),
    targetDeviceId: id("10"),
    targetDeploymentId: id("11"),
    runnerId: "personal-chat:test",
    logger: pino({ enabled: false }),
    claimRenewIntervalMs: 60_000,
    terminalPollIntervalMs: 1
  });

describe("Personal Agent chat dispatcher", () => {
  it("prepares one child with direct prompt and bounded public context, then settles captured output", async () => {
    const getChildResult = vi
      .fn<PersonalAgentChatRunnerAuthority["getChildResult"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(
        childResult({
          status: "completed",
          terminal: true,
          assistantOutput: { text: "A public answer", truncated: false },
          jobId: id("12")
        })
      );
    const authority = makeAuthority({ getChildResult });
    const dispatcher = createDispatcher(authority);

    await dispatcher.processOnce();

    expect(authority.prepareChild).toHaveBeenCalledOnce();
    expect(authority.prepareChild).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Answer the user's question once.",
        contextText: delivery().conversationContextText,
        contextTransfer,
        idempotencyKey: `personal-agent-chat-delivery:${deliveryId}`
      })
    );
    expect(authority.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId,
        commandId: promptCommandId,
        reply: "A public answer",
        contextTransfer
      })
    );
    expect(authority.failDelivery).not.toHaveBeenCalled();
  });

  it("reconciles an attached child after restart without creating another execution", async () => {
    const authority = makeAuthority({
      claimDelivery: vi.fn(async () =>
        delivery({ executionId, commandId: startCommandId })
      ),
      getChildResult: vi.fn(async () =>
        childResult({
          status: "completed",
          terminal: true,
          assistantOutput: { text: "Recovered output", truncated: false }
        })
      )
    });
    const dispatcher = createDispatcher(authority);

    await dispatcher.processOnce();

    expect(authority.prepareChild).not.toHaveBeenCalled();
    expect(authority.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ reply: "Recovered output" })
    );
  });

  it("normalizes a legacy Agent delivery and ignores its stored Memory envelope", async () => {
    const agentId = id("14");
    const identityVersionId = id("15");
    const authority = makeAuthority({
      claimDelivery: vi.fn(async () =>
        delivery({
          launch: {
            ...delivery().launch,
            kind: "agent",
            agentId,
            agentVersion: 4
          } as never,
          personalAgentContext: {
            context: {
              schemaVersion: 1,
              identity: {
                agentId,
                version: 4,
                identityVersionId,
                name: "Mira",
                role: "Reviewer",
                avatarReference: null,
                soulInstructions: "Legacy instructions are ignored."
              },
              project: { projectId: "project-legacy", name: "Koed" },
              activeJob: { id: id("16") },
              pendingTeamRequestId: id("17"),
              memory: { evidence: ["private legacy envelope"] }
            },
            memoryContext: { evidence: ["old memory envelope"] }
          }
        })
      ),
      getChildResult: vi
        .fn<PersonalAgentChatRunnerAuthority["getChildResult"]>()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(
          childResult({
            status: "completed",
            terminal: true,
            assistantOutput: { text: "A public answer", truncated: false }
          })
        )
    });
    const dispatcher = createDispatcher(authority);

    await dispatcher.processOnce();

    const prepared = vi.mocked(authority.prepareChild).mock.calls[0]?.[0];
    expect(prepared?.personalAgentContext).toEqual({
      schemaVersion: 1,
      identity: {
        agentId,
        version: 4,
        identityVersionId,
        name: "Mira",
        role: "Reviewer",
        avatarReference: null
      },
      project: { projectId: "project-legacy", name: "Koed" }
    });
    expect(prepared).not.toHaveProperty("personalMemoryContext");
    expect(JSON.stringify(prepared)).not.toContain("Legacy instructions");
    expect(JSON.stringify(prepared)).not.toContain("private legacy envelope");
    expect(authority.failDelivery).not.toHaveBeenCalled();
  });

  it("reconciles a reused execution through its linked prompt command", async () => {
    const authority = makeAuthority({
      claimDelivery: vi.fn(async () =>
        delivery({ executionId, commandId: promptCommandId })
      ),
      getChildResult: vi.fn(async () =>
        childResult({
          status: "completed",
          terminal: true,
          startCommandId: null,
          assistantOutput: { text: "Reused execution output", truncated: false }
        })
      )
    });
    const dispatcher = createDispatcher(authority);

    await dispatcher.processOnce();

    expect(authority.prepareChild).not.toHaveBeenCalled();
    expect(authority.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId,
        commandId: promptCommandId,
        reply: "Reused execution output"
      })
    );
  });

  it("reads an expired attached child without dispatching commands, then settles captured output", async () => {
    const claimDelivery = vi.fn(async () =>
      delivery({
        executionId,
        commandId: startCommandId,
        reconciliationOnly: true
      } as never)
    );
    const authority = makeAuthority({
      claimDelivery,
      getChildResult: vi.fn(async () =>
        childResult({
          status: "completed",
          terminal: true,
          assistantOutput: { text: "Reconciled output", truncated: false }
        })
      )
    });
    const processManagedCommands = vi.fn(async () => ({
      completed: 0,
      failed: 0
    }));
    const dispatcher = createDispatcher(authority, processManagedCommands);

    await dispatcher.processOnce();

    expect(authority.prepareChild).not.toHaveBeenCalled();
    expect(processManagedCommands).not.toHaveBeenCalled();
    expect(authority.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ reply: "Reconciled output" })
    );
  });

  it("runs only checkpoint recovery for a reconciliation-only child", async () => {
    const authority = makeAuthority({
      claimDelivery: vi.fn(async () =>
        delivery({
          executionId,
          commandId: startCommandId,
          reconciliationOnly: true
        } as never)
      ),
      getChildResult: vi
        .fn<PersonalAgentChatRunnerAuthority["getChildResult"]>()
        .mockResolvedValueOnce(childResult({ checkpointPending: true }))
        .mockResolvedValue(
          childResult({
            status: "completed",
            terminal: true,
            assistantOutput: { text: "Checkpoint recovered", truncated: false }
          })
        )
    });
    const processManagedCommands = vi.fn(async () => ({
      completed: 0,
      failed: 0
    }));
    const dispatcher = createDispatcher(authority, processManagedCommands);

    await dispatcher.processOnce();

    expect(authority.prepareChild).not.toHaveBeenCalled();
    expect(processManagedCommands).toHaveBeenCalledOnce();
    expect(authority.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ reply: "Checkpoint recovered" })
    );
  });

  it("records confirmed provider failure and leaves continuation to explicit user action", async () => {
    const authority = makeAuthority({
      getChildResult: vi.fn(async () =>
        childResult({
          status: "confirmed_failure",
          terminal: true,
          errorCode: "provider_unavailable"
        })
      )
    });
    const dispatcher = createDispatcher(authority);

    await dispatcher.processOnce();

    expect(authority.failDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        certainty: "confirmed_failure",
        errorCode: "provider_unavailable"
      })
    );
    expect(authority.claimDelivery).toHaveBeenCalledOnce();
    expect(authority.completeDelivery).not.toHaveBeenCalled();
  });

  it("does not settle an indeterminate provider outcome as a confirmed failure", async () => {
    const authority = makeAuthority({
      getChildResult: vi.fn(async () =>
        childResult({
          status: "indeterminate",
          terminal: true,
          errorCode: "provider_outcome_uncertain"
        })
      )
    });
    const dispatcher = createDispatcher(authority);

    await dispatcher.processOnce();

    expect(authority.failDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        certainty: "indeterminate",
        errorCode: "provider_outcome_uncertain"
      })
    );
    expect(authority.completeDelivery).not.toHaveBeenCalled();
  });

  it("keeps result and cancellation polling live while native command processing is pending", async () => {
    let resolveNative!: () => void;
    const pendingNative = new Promise<{ completed: number; failed: number }>(
      (resolve) => {
        resolveNative = () => resolve({ completed: 0, failed: 0 });
      }
    );
    const processManagedCommands = vi.fn(() => pendingNative);
    const getChildResult = vi
      .fn<PersonalAgentChatRunnerAuthority["getChildResult"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(childResult({ cancelRequested: true }))
      .mockResolvedValueOnce(
        childResult({
          status: "stopped",
          terminal: true,
          cancelRequested: true
        })
      );
    const authority = makeAuthority({ getChildResult });
    const dispatcher = createDispatcher(authority, processManagedCommands);

    await dispatcher.processOnce();

    expect(processManagedCommands).toHaveBeenCalledOnce();
    expect(authority.cancelChild).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId,
        promptCommandId,
        executionGeneration: 1
      })
    );
    expect(authority.cancelBatch).toHaveBeenCalledOnce();
    expect(authority.completeDelivery).not.toHaveBeenCalled();
    resolveNative();
  });

  it("cancels a pending local start and enqueues an interrupt under a stable key", async () => {
    const cancelManagedConversationStart = vi.fn(async () => ({
      state: "dispatching"
    }));
    const enqueueManagedConversationControl = vi.fn(async () => ({
      id: id("13")
    }));
    const repository = {
      getPersonalAgentChatChildResult: vi.fn(async () =>
        childResult({
          promptCommandId: null,
          cancelRequested: true
        })
      ),
      cancelManagedConversationStart,
      enqueueManagedConversationControl
    } as never;
    const authority = createLocalPersonalAgentChatRunnerAuthority({
      repository,
      ownerUserId: id("8"),
      targetDeviceId: id("10"),
      targetDeploymentId: id("11")
    });

    await authority.cancelChild({
      deliveryId,
      conversationId,
      claimToken,
      executionId,
      promptCommandId: null,
      startCommandId,
      executionGeneration: 1
    });

    expect(cancelManagedConversationStart).toHaveBeenCalledWith(
      { userId: id("8") },
      { executionId, executionGeneration: 1 }
    );
    expect(enqueueManagedConversationControl).toHaveBeenCalledWith(
      { userId: id("8") },
      {
        executionId,
        executionGeneration: 1,
        commandKind: "interrupt",
        idempotencyKey: `personal-chat-cancel:${deliveryId}:${startCommandId}`
      }
    );
  });

  it("settles a cancel requested before child preparation without launching a provider", async () => {
    const authority = makeAuthority({
      getChildResult: vi.fn(async () =>
        childResult({
          status: "stopped",
          terminal: true,
          executionId: null,
          executionGeneration: null,
          startCommandId: null,
          promptCommandId: null,
          cancelRequested: true
        })
      )
    });
    const dispatcher = createDispatcher(authority);

    await dispatcher.processOnce();

    expect(authority.prepareChild).not.toHaveBeenCalled();
    expect(authority.cancelBatch).toHaveBeenCalledOnce();
  });

  it("freezes a delivery when the persisted child identity does not match the linked child", async () => {
    const authority = makeAuthority({
      getChildResult: vi.fn(async () =>
        childResult({
          status: "completed",
          terminal: true,
          executionId: id("99"),
          assistantOutput: { text: "Wrong child", truncated: false }
        })
      )
    });
    const dispatcher = createDispatcher(authority);

    await dispatcher.processOnce();

    expect(authority.failDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        certainty: "indeterminate",
        errorCode: "personal_agent_chat_child_identity_mismatch"
      })
    );
    expect(authority.completeDelivery).not.toHaveBeenCalled();
  });
});
