import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  aiClientIdentifierPattern,
  aiClientPermissionModes,
  personalAgentChatContextTransferSchema,
  personalAgentExecutionContextSchema
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";

type RunnerIdentity = {
  userId: string;
  deviceId: string;
  deploymentId: string;
};
type AuthenticateRunner = (
  request: FastifyRequest,
  context: ApiRouteContext
) => Promise<RunnerIdentity>;
const uuid = z.uuid();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const leaseMs = z.number().int().safe().min(5_000).max(300_000);
const params = z.object({ deliveryId: uuid }).strict();
const fence = { claimToken: uuid };
const prepare = z
  .object({
    ...fence,
    conversationId: uuid,
    provider: boundedText(96).regex(aiClientIdentifierPattern),
    aiClientInstanceId: boundedText(128).regex(aiClientIdentifierPattern),
    model: boundedText(512),
    reasoningEffort: boundedText(64).nullable(),
    permissionMode: z.enum(aiClientPermissionModes),
    prompt: boundedText(256_000),
    contextText: z
      .string()
      .max(24 * 1024)
      .nullable(),
    contextTransfer: personalAgentChatContextTransferSchema.nullable(),
    clientUserMessageId: uuid,
    selectedResourceIds: z.array(boundedText(160)).max(32),
    selectedResourceHostedInstanceId: boundedText(160).optional(),
    agentId: uuid.optional(),
    agentVersion: z.number().int().positive().optional(),
    personalAgentContext: personalAgentExecutionContextSchema
      .nullable()
      .optional(),
    idempotencyKey: boundedText(255)
  })
  .strict()
  .refine(
    (value) =>
      value.contextText === null ||
      Buffer.byteLength(value.contextText, "utf8") <= 24 * 1024,
    { message: "Public context exceeds its byte budget" }
  );

/** The credential fixes owner and runner target; request bodies never select them. */
export const registerPersonalAgentChatRunnerRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  authenticateRunner: AuthenticateRunner
): void => {
  const preHandler =
    context.rateLimit.managedConversationWrite ?? context.rateLimit.memoryWrite;
  const prefix = "/v1/managed-conversation-runner/personal-agent-chats";
  const target = (auth: RunnerIdentity) => ({
    targetDeviceId: auth.deviceId,
    targetDeploymentId: auth.deploymentId
  });
  app.post(`${prefix}/claim`, { preHandler }, async (request) => {
    const auth = await authenticateRunner(request, context);
    const input = z
      .object({ runnerId: boundedText(160), leaseMs })
      .strict()
      .parse(request.body);
    return {
      delivery: await context
        .requireRepository()
        .claimNextPersonalAgentChatDelivery({
          ...input,
          ownerUserId: auth.userId,
          targetDeviceId: auth.deviceId,
          deploymentId: auth.deploymentId
        })
    };
  });
  app.post(
    `${prefix}/deliveries/:deliveryId/renew`,
    { preHandler },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { deliveryId } = params.parse(request.params);
      const input = z
        .object({ ...fence, leaseMs })
        .strict()
        .parse(request.body);
      return {
        renewed: await context
          .requireRepository()
          .renewPersonalAgentChatDeliveryClaim({
            ...input,
            deliveryId,
            ownerUserId: auth.userId,
            ...target(auth)
          })
      };
    }
  );
  app.post(
    `${prefix}/deliveries/:deliveryId/prepare`,
    { preHandler },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { deliveryId } = params.parse(request.params);
      const input = prepare.parse(request.body);
      return context.requireRepository().preparePersonalAgentChatChild({
        ...input,
        deliveryId,
        actor: { userId: auth.userId },
        ...target(auth)
      });
    }
  );
  app.post(
    `${prefix}/deliveries/:deliveryId/result`,
    {
      preHandler:
        context.rateLimit.managedConversationRead ??
        context.rateLimit.memoryRead
    },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { deliveryId } = params.parse(request.params);
      const input = z
        .object({ ...fence, conversationId: uuid })
        .strict()
        .parse(request.body);
      return {
        result: await context
          .requireRepository()
          .getPersonalAgentChatChildResult({
            ...input,
            deliveryId,
            actor: { userId: auth.userId },
            ...target(auth)
          })
      };
    }
  );
  app.post(
    `${prefix}/deliveries/:deliveryId/cancel-child`,
    { preHandler },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { deliveryId } = params.parse(request.params);
      const input = z
        .object({
          ...fence,
          conversationId: uuid,
          executionId: uuid,
          promptCommandId: uuid.nullable(),
          startCommandId: uuid.optional(),
          executionGeneration: z.number().int().positive()
        })
        .refine(
          (value) =>
            value.promptCommandId !== null ||
            value.startCommandId !== undefined,
          { message: "A linked prompt or start command is required" }
        )
        .strict()
        .parse(request.body);
      const repository = context.requireRepository();
      const result = await repository.getPersonalAgentChatChildResult({
        actor: { userId: auth.userId },
        deliveryId,
        conversationId: input.conversationId,
        claimToken: input.claimToken,
        ...target(auth)
      });
      if (
        !result ||
        !result.cancelRequested ||
        result.executionId !== input.executionId ||
        result.promptCommandId !== input.promptCommandId ||
        (input.promptCommandId === null &&
          result.startCommandId !== input.startCommandId)
      ) {
        throw Object.assign(
          new Error("Cancellation does not match this stopped Agent delivery"),
          { statusCode: 409 }
        );
      }
      const cancellation =
        input.promptCommandId === null
          ? await repository.cancelManagedConversationStart(
              { userId: auth.userId },
              {
                executionId: input.executionId,
                executionGeneration: input.executionGeneration
              }
            )
          : await repository.cancelManagedConversationPrompt(
              { userId: auth.userId },
              {
                executionId: input.executionId,
                commandId: input.promptCommandId,
                executionGeneration: input.executionGeneration
              }
            );
      const controlCommand =
        cancellation &&
        ["queued", "dispatching", "blocked", "indeterminate"].includes(
          cancellation.state
        )
          ? await repository.enqueueManagedConversationControl(
              { userId: auth.userId },
              {
                executionId: input.executionId,
                executionGeneration: input.executionGeneration,
                commandKind: "interrupt",
                idempotencyKey: `personal-chat-cancel:${deliveryId}:${input.promptCommandId ?? input.startCommandId}`
              }
            )
          : null;
      return { cancellation, controlCommand };
    }
  );
  app.post(
    `${prefix}/deliveries/:deliveryId/cancel`,
    { preHandler },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { deliveryId } = params.parse(request.params);
      const input = z
        .object({
          ...fence,
          conversationId: uuid,
          messageId: uuid,
          requestId: uuid
        })
        .strict()
        .parse(request.body);
      const repository = context.requireRepository();
      const result = await repository.getPersonalAgentChatChildResult({
        actor: { userId: auth.userId },
        deliveryId,
        conversationId: input.conversationId,
        claimToken: input.claimToken,
        ...target(auth)
      });
      if (
        !result ||
        !result.cancelRequested ||
        !result.terminal ||
        result.status !== "stopped" ||
        result.messageId !== input.messageId
      ) {
        throw Object.assign(
          new Error("Agent stop has not been confirmed for this batch"),
          { statusCode: 409 }
        );
      }
      return {
        cancellation: await repository.cancelPersonalAgentChatBatch(
          { userId: auth.userId },
          {
            conversationId: input.conversationId,
            messageId: input.messageId,
            requestId: input.requestId,
            confirmedStopped: true
          }
        )
      };
    }
  );
  app.post(
    `${prefix}/deliveries/:deliveryId/complete`,
    { preHandler },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { deliveryId } = params.parse(request.params);
      const input = z
        .object({
          ...fence,
          executionId: uuid,
          commandId: uuid,
          jobId: uuid.nullable(),
          reply: z.string().max(65_536),
          truncated: z.boolean().default(false),
          contextTransfer: personalAgentChatContextTransferSchema.nullable()
        })
        .strict()
        .parse(request.body);
      return {
        completed: await context
          .requireRepository()
          .completePersonalAgentChatDelivery({
            ...input,
            deliveryId,
            ownerUserId: auth.userId,
            ...target(auth)
          })
      };
    }
  );
  app.post(
    `${prefix}/deliveries/:deliveryId/fail`,
    { preHandler },
    async (request) => {
      const auth = await authenticateRunner(request, context);
      const { deliveryId } = params.parse(request.params);
      const input = z
        .object({
          ...fence,
          certainty: z.enum(["confirmed_failure", "indeterminate"]),
          errorCode: boundedText(120)
        })
        .strict()
        .parse(request.body);
      return {
        failed: await context
          .requireRepository()
          .failPersonalAgentChatDelivery({
            ...input,
            deliveryId,
            ownerUserId: auth.userId,
            ...target(auth)
          })
      };
    }
  );
};
