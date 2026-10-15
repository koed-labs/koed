import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { ApiRouteContext } from "../server/context.js";
import type { RecurringAgentTask } from "@koed/shared";
import { registerRecurringAgentTaskRoutes } from "./routes.js";

const ownerId = randomUUID();
const agentId = randomUUID();
const taskId = randomUUID();
const deviceId = randomUUID();
const deploymentId = randomUUID();
const now = new Date().toISOString();

const task = (
  overrides: Partial<RecurringAgentTask> = {}
): RecurringAgentTask => ({
  id: taskId,
  agentId,
  title: "Weekly review",
  prompt: "Review the week's notes.",
  schedule: {
    kind: "weekly",
    localTime: "09:00",
    timeZone: "UTC",
    weekdays: [1]
  },
  context: { projectId: null, contextKind: "independent" },
  execution: {
    provider: "codex",
    aiClientInstanceId: "codex.hosted-alias",
    targetDeviceId: deviceId,
    model: "gpt-5",
    reasoningEffort: null,
    permissionMode: "supervised"
  },
  status: "active",
  revision: 1,
  nextRunAt: now,
  lastRunAt: null,
  lastErrorCode: null,
  createdAt: now,
  updatedAt: now,
  ...overrides
});

const occurrence = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  taskId,
  taskRevision: 1,
  trigger: "scheduled" as const,
  scheduledAt: now,
  status: "reserved" as const,
  conversationId: randomUUID(),
  messageId: null,
  deliveryId: null,
  executionId: null,
  errorCode: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  ...overrides
});

const nativeResponse = (input: {
  conversationId: string;
  requestId: string;
  agentId: string;
  agentVersion: number;
}) => {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const turnId = randomUUID();
  const nativeExecutionId = randomUUID();
  const nativeCommandId = randomUUID();
  return {
    response: {
      conversation: {
        contractVersion: 1 as const,
        conversationId: input.conversationId,
        title: "Weekly review",
        projectId: null,
        contextKind: "independent" as const,
        status: "queued" as const,
        activeAgentId: input.agentId,
        activeExecutionId: nativeExecutionId,
        activeProvider: "codex",
        sourceExecutionIds: [],
        childExecutionIds: [],
        capturedSessionIds: [],
        participants: [],
        messages: [],
        deliveries: [],
        createdAt: now,
        updatedAt: now
      },
      message: {
        id: messageId,
        sequence: 1,
        turnId,
        requestId: input.requestId,
        kind: "user" as const,
        text: "Review the week's notes.",
        authorAgentId: null,
        authorAgentVersion: null,
        authorName: null,
        provider: "codex",
        aiClientInstanceId: "codex.canonical",
        executionId: null,
        sourceExecutionId: null,
        sourceCommandId: null,
        jobId: null,
        truncated: false,
        state: "pending" as const,
        createdAt: now
      },
      deliveries: [
        {
          id: deliveryId,
          turnId,
          messageId,
          recipientKind: "agent" as const,
          agentId: input.agentId,
          agentVersion: input.agentVersion,
          agentName: "Review Agent",
          ordinal: 0,
          executionId: nativeExecutionId,
          commandId: nativeCommandId,
          jobId: null,
          provider: "codex",
          aiClientInstanceId: "codex.canonical",
          model: "gpt-5",
          status: "queued" as const,
          errorCode: null,
          canContinue: false,
          progress: { stage: null, summary: null, observedAt: null },
          contextTransfer: null,
          diffAvailable: false,
          startedAt: null,
          completedAt: null,
          updatedAt: now
        }
      ]
    },
    deliveryId,
    messageId,
    nativeExecutionId,
    nativeCommandId
  };
};

const setup = (
  input: {
    repository?: Record<string, ReturnType<typeof vi.fn>>;
    validateLaunch?: ReturnType<typeof vi.fn>;
    submitNativeMessage?: ReturnType<typeof vi.fn>;
    runner?: boolean;
    reservedOccurrence?: ReturnType<typeof occurrence>;
  } = {}
) => {
  const reserved = input.reservedOccurrence ?? occurrence();
  const claim = {
    occurrence: reserved,
    ownerUserId: ownerId,
    agentId,
    agentVersion: 4,
    canonicalAiClientInstanceId: "codex.canonical",
    prompt: "Review the week's notes.",
    launchSnapshot: task().execution,
    context: task().context,
    targetDeviceId: deviceId,
    targetDeploymentId: deploymentId,
    runnerId: "recurring-task-runner",
    leaseToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    writeDispatched: false
  };
  // The occurrence conversation id is deliberately the idempotency UUID.
  claim.occurrence.conversationId = claim.occurrence.id;
  const native = nativeResponse({
    conversationId: reserved.conversationId,
    requestId: reserved.id,
    agentId,
    agentVersion: claim.agentVersion
  });
  const repository = {
    listRecurringAgentTasks: vi.fn(async () => ({
      tasks: [],
      nextCursor: null
    })),
    getRecurringAgentTask: vi.fn(async () => task()),
    createRecurringAgentTask: vi.fn(async () => task()),
    updateRecurringAgentTask: vi.fn(async () => task()),
    controlRecurringAgentTask: vi.fn(async () => task()),
    listRecurringAgentTaskOccurrences: vi.fn(async () => ({
      occurrences: [],
      nextCursor: null
    })),
    reserveRecurringAgentTaskRunNow: vi.fn(async () => reserved),
    getNextRecurringAgentTaskOccurrenceForReconciliation: vi.fn(
      async () => null
    ),
    settleRecurringAgentTaskOccurrence: vi.fn(async () => reserved),
    claimNextDueRecurringAgentTaskOccurrence: vi.fn(async () => claim),
    renewRecurringAgentTaskOccurrenceLease: vi.fn(async () => true),
    markRecurringAgentTaskOccurrenceSubmissionStarted: vi.fn(async () => true),
    linkRecurringAgentTaskOccurrenceNativeResult: vi.fn(async () => ({
      ...reserved,
      status: "dispatched" as const,
      messageId: native.messageId,
      deliveryId: native.deliveryId,
      executionId: native.nativeExecutionId
    })),
    ...input.repository
  };
  const validateLaunch =
    input.validateLaunch ??
    vi.fn(async (_request, _owner, _execution, _context, expectedTarget) => ({
      targetDeploymentId: expectedTarget ?? deploymentId,
      canonicalAiClientInstanceId: "codex.canonical"
    }));
  const submitNativeMessage =
    input.submitNativeMessage ?? vi.fn(async () => native.response);
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const typed = error as Error & {
      code?: string;
      statusCode?: number;
      name: string;
    };
    reply
      .status(typed.statusCode ?? (typed.name === "ZodError" ? 400 : 500))
      .send({
        error: typed.message,
        ...(typed.code ? { code: typed.code } : {})
      });
  });
  registerRecurringAgentTaskRoutes(
    app,
    {
      rateLimit: {
        managedConversationRead: async () => undefined,
        managedConversationWrite: async () => undefined,
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      requireRepository: () => repository
    } as unknown as ApiRouteContext,
    {
      authenticateOwner: vi.fn(async () => ({ userId: ownerId })),
      authenticateRunner: vi.fn(async () => ({
        userId: ownerId,
        deviceId,
        deploymentId
      })),
      submitNativeMessage,
      validateLaunch,
      proxyManaged: vi.fn(async () => null)
    }
  );
  return {
    app,
    repository,
    reserved,
    claim,
    native,
    validateLaunch,
    submitNativeMessage
  };
};

describe("Recurring Agent task routes", () => {
  it("uses the owner-scoped Agent path and checks launch settings before creating a task", async () => {
    const fixture = setup();
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: `/v1/personal-agents/${agentId}/recurring-tasks`,
        payload: {
          title: "Weekly review",
          prompt: "Review the week's notes.",
          schedule: task().schedule,
          context: task().context,
          execution: task().execution,
          requestId: randomUUID()
        }
      });
      expect(result.statusCode).toBe(200);
      expect(fixture.validateLaunch).toHaveBeenCalledWith(
        expect.anything(),
        ownerId,
        task().execution,
        task().context
      );
      expect(fixture.repository.createRecurringAgentTask).toHaveBeenCalledWith(
        { userId: ownerId },
        expect.objectContaining({ agentId })
      );
    } finally {
      await fixture.app.close();
    }
  });

  it("submits one reserved occurrence through the native Personal Agent path with stable ids and the public instance alias", async () => {
    const fixture = setup();
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
        payload: { runnerId: "recurring-task-runner", leaseMs: 120_000 }
      });
      expect(result.statusCode).toBe(200);
      expect(
        fixture.repository.claimNextDueRecurringAgentTaskOccurrence
      ).toHaveBeenCalledWith({
        ownerUserId: ownerId,
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentId,
        runnerId: "recurring-task-runner",
        leaseMs: 120_000
      });
      expect(fixture.submitNativeMessage).toHaveBeenCalledWith(
        expect.anything(),
        ownerId,
        fixture.reserved.id,
        expect.objectContaining({
          requestId: fixture.reserved.id,
          text: fixture.claim.prompt,
          recipients: [
            expect.objectContaining({
              kind: "agent",
              agentId,
              agentVersion: 4,
              aiClientInstanceId: "codex.hosted-alias"
            })
          ]
        })
      );
      expect(
        fixture.repository.markRecurringAgentTaskOccurrenceSubmissionStarted
      ).toHaveBeenCalled();
      expect(
        fixture.repository.linkRecurringAgentTaskOccurrenceNativeResult
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: ownerId,
          occurrenceId: fixture.reserved.id,
          requestId: fixture.reserved.id,
          deliveryId: fixture.native.deliveryId,
          messageId: fixture.native.messageId
        })
      );
    } finally {
      await fixture.app.close();
    }
  });

  it("rejects runner-supplied owner and binding scope before repository access", async () => {
    const fixture = setup();
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
        payload: {
          runnerId: "recurring-task-runner",
          leaseMs: 120_000,
          ownerUserId: randomUUID(),
          targetDeviceId: randomUUID(),
          targetDeploymentId: randomUUID()
        }
      });
      expect(result.statusCode).toBe(400);
      expect(
        fixture.repository.getNextRecurringAgentTaskOccurrenceForReconciliation
      ).not.toHaveBeenCalled();
      expect(
        fixture.repository.claimNextDueRecurringAgentTaskOccurrence
      ).not.toHaveBeenCalled();
      expect(fixture.submitNativeMessage).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("marks canonical launch binding drift for owner review without native submission", async () => {
    const fixture = setup({
      validateLaunch: vi.fn(async () => ({
        targetDeploymentId: deploymentId,
        canonicalAiClientInstanceId: "codex.replaced-instance"
      }))
    });
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
        payload: { runnerId: "recurring-task-runner", leaseMs: 120_000 }
      });
      expect(result.statusCode).toBe(409);
      expect(fixture.submitNativeMessage).not.toHaveBeenCalled();
      expect(
        fixture.repository.markRecurringAgentTaskOccurrenceSubmissionStarted
      ).not.toHaveBeenCalled();
      expect(
        fixture.repository.settleRecurringAgentTaskOccurrence
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: ownerId,
          occurrenceId: fixture.reserved.id,
          runnerId: fixture.claim.runnerId,
          leaseToken: fixture.claim.leaseToken,
          outcome: "needs_review",
          errorCode: "recurring_task_binding_mismatch"
        })
      );
    } finally {
      await fixture.app.close();
    }
  });

  it.each([
    ["renewing", false, true],
    ["marking submission intent", true, false]
  ] as const)(
    "does not submit or settle a stale claim when its fence is lost while %s",
    async (_step, renews, marks) => {
      const fixture = setup({
        repository: {
          renewRecurringAgentTaskOccurrenceLease: vi.fn(async () => renews),
          markRecurringAgentTaskOccurrenceSubmissionStarted: vi.fn(
            async () => marks
          )
        }
      });
      try {
        const result = await fixture.app.inject({
          method: "POST",
          url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
          payload: { runnerId: "recurring-task-runner", leaseMs: 120_000 }
        });
        expect(result.statusCode).toBe(409);
        expect(fixture.submitNativeMessage).not.toHaveBeenCalled();
        expect(
          fixture.repository.settleRecurringAgentTaskOccurrence
        ).not.toHaveBeenCalled();
      } finally {
        await fixture.app.close();
      }
    }
  );

  it("does not replay an uncertain native submit and marks it for owner review", async () => {
    const fixture = setup({
      submitNativeMessage: vi.fn(async () => {
        throw Object.assign(new Error("submission response lost"), {
          code: "native_submission_uncertain"
        });
      })
    });
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
        payload: { runnerId: "recurring-task-runner", leaseMs: 120_000 }
      });
      expect(result.statusCode).toBe(500);
      expect(fixture.submitNativeMessage).toHaveBeenCalledTimes(1);
      expect(
        fixture.repository.settleRecurringAgentTaskOccurrence
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: ownerId,
          occurrenceId: fixture.reserved.id,
          runnerId: fixture.claim.runnerId,
          leaseToken: fixture.claim.leaseToken,
          outcome: "needs_review",
          errorCode: "native_submission_uncertain"
        })
      );
    } finally {
      await fixture.app.close();
    }
  });

  it("returns a typed conflict and preserves intent when accepted native work cannot be linked", async () => {
    const fixture = setup({
      repository: {
        getNextRecurringAgentTaskOccurrenceForReconciliation: vi.fn(
          async () => null
        ),
        linkRecurringAgentTaskOccurrenceNativeResult: vi.fn(async () => null)
      }
    });
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
        payload: { runnerId: "recurring-task-runner", leaseMs: 120_000 }
      });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({
        code: "recurring_task_native_result_unlinked"
      });
      expect(fixture.submitNativeMessage).toHaveBeenCalledTimes(1);
      expect(
        fixture.repository.getNextRecurringAgentTaskOccurrenceForReconciliation
      ).toHaveBeenCalledTimes(2);
      expect(
        fixture.repository.settleRecurringAgentTaskOccurrence
      ).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("returns a typed conflict when response-loss reconciliation finds native work but cannot link it", async () => {
    const reserved = occurrence();
    reserved.conversationId = reserved.id;
    const nativeMessageId = randomUUID();
    const nativeDeliveryId = randomUUID();
    const fixture = setup({
      reservedOccurrence: reserved,
      submitNativeMessage: vi.fn(async () => {
        throw Object.assign(new Error("submission response lost"), {
          code: "native_submission_uncertain"
        });
      }),
      repository: {
        getNextRecurringAgentTaskOccurrenceForReconciliation: vi
          .fn(async () => null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            occurrence: reserved,
            nativeState: "queued" as const,
            nativeMessageId,
            nativeDeliveryId,
            nativeExecutionId: randomUUID(),
            nativeCommandId: randomUUID(),
            nativeErrorCode: null
          }),
        linkRecurringAgentTaskOccurrenceNativeResult: vi.fn(async () => null)
      }
    });
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
        payload: { runnerId: "recurring-task-runner", leaseMs: 120_000 }
      });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({
        code: "recurring_task_native_result_unlinked"
      });
      expect(fixture.submitNativeMessage).toHaveBeenCalledTimes(1);
      expect(
        fixture.repository.linkRecurringAgentTaskOccurrenceNativeResult
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: ownerId,
          occurrenceId: fixture.reserved.id,
          messageId: nativeMessageId,
          deliveryId: nativeDeliveryId
        })
      );
      expect(
        fixture.repository.settleRecurringAgentTaskOccurrence
      ).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("leaves a native approval-blocked delivery dispatched for the existing approval flow", async () => {
    const dispatched = occurrence({ status: "dispatched" });
    const fixture = setup({
      repository: {
        getNextRecurringAgentTaskOccurrenceForReconciliation: vi.fn(
          async () => ({
            occurrence: dispatched,
            nativeState: "blocked" as const,
            nativeMessageId: randomUUID(),
            nativeDeliveryId: randomUUID(),
            nativeExecutionId: randomUUID(),
            nativeCommandId: randomUUID(),
            nativeErrorCode: null
          })
        ),
        claimNextDueRecurringAgentTaskOccurrence: vi.fn(async () => null)
      }
    });
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
        payload: { runnerId: "recurring-task-runner", leaseMs: 120_000 }
      });
      expect(result.statusCode).toBe(200);
      expect(
        fixture.repository.settleRecurringAgentTaskOccurrence
      ).not.toHaveBeenCalled();
      expect(fixture.submitNativeMessage).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("links an accepted but expired native submission without replaying it", async () => {
    const reserved = occurrence();
    reserved.conversationId = reserved.id;
    const nativeDeliveryId = randomUUID();
    const nativeMessageId = randomUUID();
    const nativeExecutionId = randomUUID();
    const fixture = setup({
      repository: {
        getNextRecurringAgentTaskOccurrenceForReconciliation: vi.fn(
          async () => ({
            occurrence: reserved,
            nativeState: "blocked" as const,
            nativeMessageId,
            nativeDeliveryId,
            nativeExecutionId,
            nativeCommandId: randomUUID(),
            nativeErrorCode: null
          })
        ),
        claimNextDueRecurringAgentTaskOccurrence: vi.fn(async () => null)
      }
    });
    try {
      const result = await fixture.app.inject({
        method: "POST",
        url: "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
        payload: { runnerId: "recurring-task-runner", leaseMs: 120_000 }
      });
      expect(result.statusCode).toBe(200);
      expect(
        fixture.repository.linkRecurringAgentTaskOccurrenceNativeResult
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: ownerId,
          occurrenceId: reserved.id,
          requestId: reserved.id,
          messageId: nativeMessageId,
          deliveryId: nativeDeliveryId
        })
      );
      expect(
        fixture.repository.settleRecurringAgentTaskOccurrence
      ).not.toHaveBeenCalled();
      expect(fixture.submitNativeMessage).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });
});
