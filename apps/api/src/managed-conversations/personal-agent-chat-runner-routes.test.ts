import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { registerManagedConversationRunnerRoutes } from "./runner-routes.js";

const ids = {
  user: randomUUID(),
  device: randomUUID(),
  deployment: randomUUID(),
  delivery: randomUUID(),
  conversation: randomUUID(),
  claim: randomUUID()
};
const prefix = "/v1/managed-conversation-runner/personal-agent-chats";
const authorization = "Koed-Device disposable-runner:disposable-secret";
const setup = async (
  families = ["managed_execution"],
  deployment: string | null = ids.deployment
) => {
  const repository = {
    claimNextPersonalAgentChatDelivery: vi.fn(async () => null),
    renewPersonalAgentChatDeliveryClaim: vi.fn(async () => true),
    preparePersonalAgentChatChild: vi.fn(async () => ({
      execution: {},
      command: {}
    })),
    getPersonalAgentChatChildResult: vi.fn(async () => null),
    cancelManagedConversationPrompt: vi.fn(async () => ({ state: "canceled" })),
    cancelManagedConversationStart: vi.fn(async () => ({ state: "canceled" })),
    cancelPersonalAgentChatBatch: vi.fn(async () => ({
      canceledDeliveryIds: []
    })),
    enqueueManagedConversationControl: vi.fn(async () => ({
      id: randomUUID(),
      state: "queued"
    })),
    completePersonalAgentChatDelivery: vi.fn(async () => true),
    failPersonalAgentChatDelivery: vi.fn(async () => true)
  };
  const readLimit = vi.fn(async () => undefined);
  const writeLimit = vi.fn(async () => undefined);
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const typed = error as Error & { statusCode?: number };
    reply
      .status(error instanceof z.ZodError ? 400 : (typed.statusCode ?? 500))
      .send({ error: typed.message });
  });
  registerManagedConversationRunnerRoutes(app, {
    auth: {
      authenticateDeviceCredential: async (request: FastifyRequest) => {
        if (request.headers.authorization !== authorization)
          throw Object.assign(new Error("Device credential required"), {
            statusCode: 401
          });
        return {
          user: { id: ids.user },
          credential: {
            id: randomUUID(),
            deviceInstanceId: ids.device,
            operationFamilies: families,
            metadata: { protocolDeploymentId: deployment }
          }
        };
      }
    },
    rateLimit: {
      managedConversationRead: readLimit,
      managedConversationWrite: writeLimit,
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    requireRepository: () => repository
  } as unknown as ApiRouteContext);
  await app.ready();
  return { app, repository, readLimit, writeLimit };
};

describe("Multi-Agent runner authority", () => {
  it("interrupts an accepted running prompt with a stable control identity", async () => {
    const { app, repository } = await setup();
    const executionId = randomUUID();
    const promptCommandId = randomUUID();
    repository.getPersonalAgentChatChildResult.mockResolvedValue({
      executionId,
      promptCommandId,
      cancelRequested: true
    } as never);
    repository.cancelManagedConversationPrompt.mockResolvedValue({
      state: "dispatching"
    });
    const payload = {
      conversationId: ids.conversation,
      claimToken: ids.claim,
      executionId,
      promptCommandId,
      executionGeneration: 1
    };
    try {
      for (let retry = 0; retry < 2; retry += 1) {
        const response = await app.inject({
          method: "POST",
          url: `${prefix}/deliveries/${ids.delivery}/cancel-child`,
          headers: { authorization },
          payload
        });
        expect(response.statusCode).toBe(200);
      }
      expect(
        repository.enqueueManagedConversationControl
      ).toHaveBeenCalledTimes(2);
      const expected = {
        executionId,
        executionGeneration: 1,
        commandKind: "interrupt",
        idempotencyKey: `personal-chat-cancel:${ids.delivery}:${promptCommandId}`
      };
      expect(
        repository.enqueueManagedConversationControl
      ).toHaveBeenNthCalledWith(1, { userId: ids.user }, expected);
      expect(
        repository.enqueueManagedConversationControl
      ).toHaveBeenNthCalledWith(2, { userId: ids.user }, expected);
    } finally {
      await app.close();
    }
  });
  it("can stop a linked deferred start before a prompt exists", async () => {
    const { app, repository } = await setup();
    const executionId = randomUUID();
    const startCommandId = randomUUID();
    repository.getPersonalAgentChatChildResult.mockResolvedValue({
      executionId,
      promptCommandId: null,
      startCommandId,
      cancelRequested: true
    } as never);
    try {
      const result = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/cancel-child`,
        headers: { authorization },
        payload: {
          conversationId: ids.conversation,
          claimToken: ids.claim,
          executionId,
          promptCommandId: null,
          startCommandId,
          executionGeneration: 1
        }
      });
      expect(result.statusCode).toBe(200);
      expect(repository.cancelManagedConversationStart).toHaveBeenCalledWith(
        { userId: ids.user },
        { executionId, executionGeneration: 1 }
      );
      expect(repository.cancelManagedConversationPrompt).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("releases a stopped batch only after terminal native stop confirmation", async () => {
    const { app, repository } = await setup();
    const messageId = randomUUID();
    const payload = {
      conversationId: ids.conversation,
      claimToken: ids.claim,
      messageId,
      requestId: randomUUID()
    };
    repository.getPersonalAgentChatChildResult.mockResolvedValue({
      messageId,
      status: "indeterminate",
      terminal: true,
      cancelRequested: true
    } as never);
    try {
      const uncertain = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/cancel`,
        headers: { authorization },
        payload
      });
      expect(uncertain.statusCode).toBe(409);
      expect(repository.cancelPersonalAgentChatBatch).not.toHaveBeenCalled();
      repository.getPersonalAgentChatChildResult.mockResolvedValue({
        messageId,
        status: "stopped",
        terminal: true,
        cancelRequested: true
      } as never);
      const stopped = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/cancel`,
        headers: { authorization },
        payload
      });
      expect(stopped.statusCode).toBe(200);
      expect(repository.cancelPersonalAgentChatBatch).toHaveBeenCalledWith(
        { userId: ids.user },
        {
          conversationId: ids.conversation,
          messageId,
          requestId: payload.requestId,
          confirmedStopped: true
        }
      );
    } finally {
      await app.close();
    }
  });
  it("cancels only the linked prompt of a stopped delivery", async () => {
    const { app, repository } = await setup();
    const executionId = randomUUID();
    const promptCommandId = randomUUID();
    repository.getPersonalAgentChatChildResult.mockResolvedValue({
      executionId,
      promptCommandId,
      cancelRequested: true
    } as never);
    const body = {
      conversationId: ids.conversation,
      claimToken: ids.claim,
      executionId,
      promptCommandId,
      executionGeneration: 1
    };
    try {
      const mismatch = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/cancel-child`,
        headers: { authorization },
        payload: { ...body, promptCommandId: randomUUID() }
      });
      expect(mismatch.statusCode).toBe(409);
      expect(repository.cancelManagedConversationPrompt).not.toHaveBeenCalled();
      const result = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/cancel-child`,
        headers: { authorization },
        payload: body
      });
      expect(result.statusCode).toBe(200);
      expect(repository.cancelManagedConversationPrompt).toHaveBeenCalledWith(
        { userId: ids.user },
        { executionId, commandId: promptCommandId, executionGeneration: 1 }
      );
    } finally {
      await app.close();
    }
  });
  it.each([
    {
      header: false,
      families: ["managed_execution"],
      deployment: ids.deployment,
      status: 401
    },
    {
      header: true,
      families: ["managed_file_read"],
      deployment: ids.deployment,
      status: 403
    },
    {
      header: true,
      families: ["managed_execution"],
      deployment: null,
      status: 409
    }
  ])(
    "requires a scoped runner with a verified target ($status)",
    async (input) => {
      const { app, repository } = await setup(input.families, input.deployment);
      try {
        const result = await app.inject({
          method: "POST",
          url: `${prefix}/claim`,
          headers: input.header ? { authorization } : {},
          payload: { runnerId: "runner-test", leaseMs: 30000 }
        });
        expect(result.statusCode).toBe(input.status);
        expect(
          repository.claimNextPersonalAgentChatDelivery
        ).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("derives the owner, device and deployment from the credential on claim", async () => {
    const { app, repository } = await setup();
    try {
      const result = await app.inject({
        method: "POST",
        url: `${prefix}/claim`,
        headers: { authorization },
        payload: { runnerId: "runner-test", leaseMs: 30000 }
      });
      expect(result.statusCode).toBe(200);
      expect(
        repository.claimNextPersonalAgentChatDelivery
      ).toHaveBeenCalledWith({
        ownerUserId: ids.user,
        targetDeviceId: ids.device,
        deploymentId: ids.deployment,
        runnerId: "runner-test",
        leaseMs: 30000
      });
      const override = await app.inject({
        method: "POST",
        url: `${prefix}/claim`,
        headers: { authorization },
        payload: {
          runnerId: "runner-test",
          leaseMs: 30000,
          ownerUserId: randomUUID()
        }
      });
      expect(override.statusCode).toBe(400);
      expect(
        repository.claimNextPersonalAgentChatDelivery
      ).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("passes the exact delivery fence and authenticated target to result and renewal", async () => {
    const { app, repository } = await setup();
    try {
      const result = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/result`,
        headers: { authorization },
        payload: { conversationId: ids.conversation, claimToken: ids.claim }
      });
      expect(result.statusCode).toBe(200);
      expect(repository.getPersonalAgentChatChildResult).toHaveBeenCalledWith({
        actor: { userId: ids.user },
        conversationId: ids.conversation,
        deliveryId: ids.delivery,
        claimToken: ids.claim,
        targetDeviceId: ids.device,
        targetDeploymentId: ids.deployment
      });
      const renewed = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/renew`,
        headers: { authorization },
        payload: { claimToken: ids.claim, leaseMs: 30000 }
      });
      expect(renewed.statusCode).toBe(200);
      expect(
        repository.renewPersonalAgentChatDeliveryClaim
      ).toHaveBeenCalledWith({
        ownerUserId: ids.user,
        deliveryId: ids.delivery,
        claimToken: ids.claim,
        leaseMs: 30000,
        targetDeviceId: ids.device,
        targetDeploymentId: ids.deployment
      });
    } finally {
      await app.close();
    }
  });

  it("uses the read budget for polling and preserves reply truncation on completion", async () => {
    const { app, repository, readLimit, writeLimit } = await setup();
    try {
      await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/result`,
        headers: { authorization },
        payload: { conversationId: ids.conversation, claimToken: ids.claim }
      });
      expect(readLimit).toHaveBeenCalledTimes(1);
      expect(writeLimit).not.toHaveBeenCalled();
      const completed = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/complete`,
        headers: { authorization },
        payload: {
          claimToken: ids.claim,
          executionId: randomUUID(),
          commandId: randomUUID(),
          jobId: null,
          reply: "Partial public reply",
          truncated: true,
          contextTransfer: null
        }
      });
      expect(completed.statusCode).toBe(200);
      expect(writeLimit).toHaveBeenCalledTimes(1);
      expect(repository.completePersonalAgentChatDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          truncated: true,
          reply: "Partial public reply",
          ownerUserId: ids.user
        })
      );
    } finally {
      await app.close();
    }
  });

  it("rejects public context exceeding the UTF-8 budget before creating a child", async () => {
    const { app, repository } = await setup();
    try {
      const result = await app.inject({
        method: "POST",
        url: `${prefix}/deliveries/${ids.delivery}/prepare`,
        headers: { authorization },
        payload: {
          conversationId: ids.conversation,
          claimToken: ids.claim,
          provider: "codex",
          aiClientInstanceId: "codex.default",
          model: "test-model",
          reasoningEffort: null,
          permissionMode: "supervised",
          prompt: "Test request",
          contextText: "😀".repeat(7000),
          contextTransfer: null,
          clientUserMessageId: randomUUID(),
          selectedResourceIds: [],
          idempotencyKey: randomUUID()
        }
      });
      expect(result.statusCode).toBe(400);
      expect(repository.preparePersonalAgentChatChild).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
