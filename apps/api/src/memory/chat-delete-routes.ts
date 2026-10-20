import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { personalDesktopChatDeleteReviewReservationSchema } from "@koed/shared/personal-desktop";
import {
  ChatDeleteConflictError,
  ChatDeleteNotFoundError,
  ChatForgetConflictError,
  ChatForgetNotFoundError,
  type ChatDeleteRepository,
  type ChatForgetRepository,
  type MemorySourceRepository
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import type { createChatDeleteCoordinator } from "./chat-delete-coordinator.js";
import { ProjectNativeReviewDeclined } from "../projects/delete-coordinator.js";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";

const paramsSchema = z.object({ sessionId: z.uuid() });
const reviewParamsSchema = paramsSchema.extend({ actionGrantId: z.uuid() });
const deleteBodySchema = z.object({ batchId: z.uuid().optional() }).strict();
const status = (
  operation: NonNullable<
    Awaited<ReturnType<ChatDeleteRepository["getChatDeleteOperation"]>>
  >
) => ({
  sessionId: operation.sessionId,
  batchId: operation.batchId,
  state: operation.state,
  complete: operation.state === "complete",
  pending: operation.state !== "complete",
  pendingReviews: operation.grantFreezeAcks
    .filter((ack) => ack.state === "review_required" && ack.actionGrantId)
    .map((ack) => ({
      backendId: ack.backendId,
      shareGrantId: ack.shareGrantId,
      actionGrantId: ack.actionGrantId!
    }))
});

export const registerChatDeleteRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  input: {
    repository: ChatDeleteRepository | null;
    forgetRepository: ChatForgetRepository | null;
    managedRepository: MemorySourceRepository | null;
    coordinator: ReturnType<typeof createChatDeleteCoordinator> | null;
  }
) => {
  const { authenticate } = context.auth;
  const authenticateChatDelete = (
    request: Parameters<typeof authenticate>[0],
    write: boolean
  ) =>
    request.headers.authorization?.trim().startsWith("Koed-Desktop")
      ? authenticateProjectOperation(
          request,
          {
            deploymentProfile: context.config.deploymentProfile,
            koedHome: context.config.koedHome,
            auth: context.auth
          },
          write
        )
      : authenticate(request);
  const requireRepo = () => {
    if (!input.repository)
      throw Object.assign(new Error("Conversation deletion is unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const requireManaged = () => {
    if (!input.managedRepository)
      throw Object.assign(new Error("Conversation runtime is unavailable"), {
        statusCode: 503
      });
    return input.managedRepository;
  };
  const handle = (
    reply: { status(code: number): { send(body: unknown): unknown } },
    error: unknown
  ) => {
    if (error instanceof ChatDeleteNotFoundError)
      return reply.status(404).send({ error: error.message });
    if (error instanceof ChatForgetNotFoundError)
      return reply.status(404).send({ error: error.message });
    if (error instanceof ChatDeleteConflictError)
      return reply.status(409).send({ error: error.message });
    if (error instanceof ChatForgetConflictError)
      return reply.status(409).send({ error: error.message });
    throw error;
  };
  const progress = async (
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) => {
    const repository = requireRepo();
    const managedRepository = requireManaged();
    const operation = await repository.getChatDeleteOperation(
      ownerUserId,
      sessionId,
      batchId
    );
    if (!operation)
      throw new ChatDeleteNotFoundError("Conversation deletion not found");
    if (operation.state === "complete") return status(operation);
    if (["cancelled", "restored"].includes(operation.state))
      throw new ChatDeleteConflictError(
        "Conversation deletion operation has ended"
      );
    for (const execution of operation.executions) {
      const current = await managedRepository.getManagedConversationExecution(
        { userId: ownerUserId },
        execution.id
      );
      if (
        !current ||
        current.executionGeneration !== execution.executionGeneration
      )
        throw new ChatDeleteConflictError(
          "Confirmed Conversation execution changed"
        );
      if (["stopped", "failed", "fenced"].includes(current.state)) {
        await repository.recordChatRuntimeAck(ownerUserId, sessionId, batchId, {
          executionId: execution.id,
          executionGeneration: execution.executionGeneration,
          state: current.state as "stopped" | "failed" | "fenced",
          stateVersion: current.stateVersion
        });
      } else {
        await managedRepository.enqueueManagedConversationControl(
          { userId: ownerUserId },
          {
            executionId: execution.id,
            executionGeneration: execution.executionGeneration,
            idempotencyKey: `chat-delete:${batchId}:${execution.id}`,
            commandKind: "stop"
          }
        );
      }
    }
    let remoteVerified = operation.sources.every(
      (source) => source.backends.length === 0
    );
    if (!remoteVerified && input.coordinator) {
      try {
        await input.coordinator.advance(operation);
        remoteVerified = true;
      } catch (error) {
        if (error instanceof ProjectNativeReviewDeclined) {
          const released = await input.coordinator.cancel(operation);
          if (released) {
            await repository.cancelChatDelete(ownerUserId, sessionId, batchId);
            throw new ChatDeleteConflictError(
              "Conversation deletion was cancelled"
            );
          }
        }
        // Offline, uncertain dispatch and pending Native review are durable
        // pending states. A retry reconciles the same batch before completion.
      }
    }
    const refreshed = await repository.getChatDeleteOperation(
      ownerUserId,
      sessionId,
      batchId
    );
    if (!refreshed)
      throw new ChatDeleteConflictError("Conversation deletion changed");
    if (
      remoteVerified &&
      refreshed.runtimeAcks.length === refreshed.executions.length &&
      refreshed.sources.every((source) =>
        source.backends.every((backend) =>
          refreshed.backendAcks.some(
            (ack) =>
              ack.logicalMemoryId === source.logicalMemoryId &&
              ack.backendId === backend.backendId &&
              ack.sealed
          )
        )
      ) &&
      refreshed.grantFreezeAcks.every((ack) =>
        ["frozen", "resolved"].includes(ack.state)
      )
    ) {
      await repository.markChatDeleteReady(ownerUserId, sessionId, batchId);
      const completed = await repository.completeChatDelete(
        ownerUserId,
        sessionId,
        batchId
      );
      await context.graph.cacheProvider.deleteByPrefix("koed:graph:");
      return status(completed);
    }
    return status(refreshed);
  };
  const progressForget = async (
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) => {
    if (!input.forgetRepository)
      throw Object.assign(new Error("Conversation Forget is unavailable"), {
        statusCode: 503
      });
    const repository = input.forgetRepository;
    const operation = await repository.getForgetChatOperation(
      ownerUserId,
      sessionId,
      batchId
    );
    if (!operation)
      throw new ChatForgetNotFoundError("Forget operation not found");
    if (operation.state === "undone")
      throw new ChatForgetConflictError("Forget operation was undone");
    if (operation.state === "complete")
      return {
        pending: false as const,
        batchId,
        forgottenAt: operation.forgotten_at!.toISOString(),
        suppressedAssertionIds: operation.assertion_snapshots.map(
          (item) => item.id
        )
      };
    const managedRepository = requireManaged();
    for (const execution of operation.execution_manifest) {
      const current = await managedRepository.getManagedConversationExecution(
        { userId: ownerUserId },
        execution.id
      );
      if (
        !current ||
        current.executionGeneration !== execution.executionGeneration
      )
        throw new ChatForgetConflictError(
          "Confirmed Conversation execution changed"
        );
      if (["stopped", "failed", "fenced"].includes(current.state)) {
        await repository.recordForgetRuntimeAck(
          ownerUserId,
          sessionId,
          batchId,
          {
            executionId: execution.id,
            executionGeneration: execution.executionGeneration,
            state: current.state as "stopped" | "failed" | "fenced",
            stateVersion: current.stateVersion
          }
        );
      } else {
        await managedRepository.enqueueManagedConversationControl(
          { userId: ownerUserId },
          {
            executionId: execution.id,
            executionGeneration: execution.executionGeneration,
            idempotencyKey: `chat-forget:${batchId}:${execution.id}`,
            commandKind: "stop"
          }
        );
      }
    }
    const refreshed = await repository.getForgetChatOperation(
      ownerUserId,
      sessionId,
      batchId
    );
    if (!refreshed)
      throw new ChatForgetConflictError("Forget operation changed");
    if (refreshed.runtime_acks.length !== refreshed.execution_manifest.length)
      return { pending: true as const, batchId };
    try {
      const complete = await repository.completeForgetChat(
        ownerUserId,
        sessionId,
        batchId
      );
      await context.graph.cacheProvider.deleteByPrefix("koed:graph:");
      return { pending: false as const, ...complete };
    } catch (error) {
      if (error instanceof ChatForgetConflictError)
        return { pending: true as const, batchId };
      throw error;
    }
  };

  app.delete(
    "/v1/memory/graph/sessions/:sessionId",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const user = await authenticateChatDelete(request, true);
      const { sessionId } = paramsSchema.parse(request.params);
      const { batchId = randomUUID() } = deleteBodySchema.parse(
        request.body ?? {}
      );
      try {
        await requireRepo().beginChatDelete(user.id, sessionId, batchId);
        const result = await progress(user.id, sessionId, batchId);
        return reply.status(result.complete ? 200 : 202).send(result);
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.post(
    "/v1/memory/graph/sessions/:sessionId/delete-progress",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const user = await authenticateChatDelete(request, true);
      const { sessionId } = paramsSchema.parse(request.params);
      const { batchId } = z
        .object({ batchId: z.uuid() })
        .strict()
        .parse(request.body);
      try {
        const result = await progress(user.id, sessionId, batchId);
        return reply.status(result.complete ? 200 : 202).send(result);
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.get(
    "/v1/memory/graph/sessions/:sessionId/delete-reviews/:actionGrantId",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      const user = await authenticateChatDelete(request, false);
      const { sessionId, actionGrantId } = reviewParamsSchema.parse(
        request.params
      );
      const { batchId } = z
        .object({ batchId: z.uuid() })
        .strict()
        .parse(request.query);
      try {
        const operation = await requireRepo().getChatDeleteOperation(
          user.id,
          sessionId,
          batchId
        );
        if (
          !operation ||
          !["preparing", "freezing", "stopping"].includes(operation.state)
        )
          throw new ChatDeleteConflictError(
            "Conversation deletion review changed"
          );
        const ack = operation.grantFreezeAcks.find(
          (item) =>
            item.actionGrantId === actionGrantId &&
            item.state === "review_required" &&
            operation.sources.some(
              (source) =>
                source.logicalMemoryId === item.logicalMemoryId &&
                source.backends.some(
                  (backend) => backend.backendId === item.backendId
                )
            )
        );
        if (!ack)
          throw new ChatDeleteConflictError(
            "Conversation deletion review reservation changed"
          );
        return personalDesktopChatDeleteReviewReservationSchema.parse({
          sessionId,
          batchId,
          backendId: ack.backendId,
          shareGrantId: ack.shareGrantId,
          actionGrantId,
          reviewedGrantVersion: ack.reviewedGrantVersion
        });
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.get(
    "/v1/memory/graph/sessions/deleted",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const user = await authenticateChatDelete(request, false);
      const { cursor } = z
        .object({ cursor: z.string().max(512).optional() })
        .strict()
        .parse(request.query);
      let before: { trashedAt: string; sessionId: string } | undefined;
      if (cursor) {
        try {
          before = z
            .object({
              trashedAt: z.iso.datetime({ offset: true }),
              sessionId: z.uuid()
            })
            .strict()
            .parse(
              JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
            );
        } catch {
          throw Object.assign(new Error("Invalid Deleted chats cursor"), {
            statusCode: 400
          });
        }
      }
      const page = await context
        .requireRepository()
        .listTrashedCapturedSessions({ userId: user.id }, before);
      return {
        sessions: page.sessions,
        nextCursor: page.nextBefore
          ? Buffer.from(JSON.stringify(page.nextBefore)).toString("base64url")
          : null
      };
    }
  );
  app.get(
    "/v1/memory/graph/sessions/delete-pending",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const user = await authenticateChatDelete(request, false);
      return {
        operations: (await requireRepo().listPendingChatDeletes(user.id)).map(
          status
        )
      };
    }
  );
  app.post(
    "/v1/memory/graph/sessions/:sessionId/restore",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const user = await authenticateChatDelete(request, true);
      const { sessionId } = paramsSchema.parse(request.params);
      try {
        const { batchId } = z
          .object({ batchId: z.uuid().optional() })
          .strict()
          .parse(request.body ?? {});
        const operation = await requireRepo().getChatDeleteOperation(
          user.id,
          sessionId,
          batchId
        );
        if (operation?.state === "complete") {
          await requireRepo().restoreChat(user.id, sessionId, batchId);
        } else {
          if (batchId) {
            if (
              !(await requireRepo().getChatDeleteOperation(user.id, sessionId))
            )
              throw new ChatDeleteNotFoundError(
                "Deleted Conversation not found"
              );
            throw new ChatDeleteConflictError(
              "Conversation deletion batch changed"
            );
          }
          const outcome = await context
            .requireRepository()
            .restoreTrashedCapturedSession({ userId: user.id }, sessionId);
          if (outcome === "not_found")
            throw new ChatDeleteNotFoundError("Deleted Conversation not found");
          if (outcome === "expired")
            throw new ChatDeleteConflictError(
              "Conversation restore window expired"
            );
        }
        await context.graph.cacheProvider.deleteByPrefix("koed:graph:");
        return { outcome: "restored" };
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.post(
    "/v1/memory/graph/sessions/:sessionId/forget",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const user = await authenticateChatDelete(request, true);
      const { sessionId } = paramsSchema.parse(request.params);
      if (!input.forgetRepository)
        return reply
          .status(503)
          .send({ error: "Conversation Forget is unavailable" });
      try {
        const { batchId = randomUUID() } = deleteBodySchema.parse(
          request.body ?? {}
        );
        await input.forgetRepository.beginForgetChat(
          user.id,
          sessionId,
          batchId
        );
        const result = await progressForget(user.id, sessionId, batchId);
        return reply.status(result.pending ? 202 : 200).send(result);
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.post(
    "/v1/memory/graph/sessions/:sessionId/forget-progress",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const user = await authenticateChatDelete(request, true);
      const { sessionId } = paramsSchema.parse(request.params);
      const { batchId } = z
        .object({ batchId: z.uuid() })
        .strict()
        .parse(request.body);
      try {
        const result = await progressForget(user.id, sessionId, batchId);
        return reply.status(result.pending ? 202 : 200).send(result);
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.get(
    "/v1/memory/graph/sessions/forget-pending",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const user = await authenticateChatDelete(request, false);
      if (!input.forgetRepository) return { operations: [] };
      return {
        operations: (
          await input.forgetRepository.listPendingForgetChats(user.id)
        ).map((item) => ({
          sessionId: item.session_id,
          batchId: item.batch_id
        }))
      };
    }
  );
  app.post(
    "/v1/memory/graph/sessions/:sessionId/forget-undo",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const user = await authenticateChatDelete(request, true);
      const { sessionId } = paramsSchema.parse(request.params);
      const { batchId } = z
        .object({ batchId: z.uuid() })
        .strict()
        .parse(request.body);
      if (!input.forgetRepository)
        return reply
          .status(503)
          .send({ error: "Conversation Forget is unavailable" });
      try {
        const result = await input.forgetRepository.undoForgetChat(
          user.id,
          sessionId,
          batchId
        );
        await context.graph.cacheProvider.deleteByPrefix("koed:graph:");
        return result;
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
};
