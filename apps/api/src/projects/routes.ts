import type { FastifyInstance } from "fastify";
import type { ProjectApiRepository } from "@koed/db";
import type { ManagedConversationRepository } from "@koed/db";
import {
  ProjectCapabilityError,
  ProjectConflictError,
  ProjectNotFoundError
} from "@koed/db";
import {
  createProjectSchema,
  patchProjectSchema,
  projectDeleteSchema,
  projectDeletePreviewSchema,
  projectDeleteStatusSchema,
  projectHqSchema,
  projectHqConversationSchema,
  projectHqConversationReadSchema,
  projectListQuerySchema,
  projectListSchema,
  projectRestoreSchema,
  projectSchema
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import {
  ProjectNativeReviewDeclined,
  type ProjectSourceCoordinator
} from "./delete-coordinator.js";
import {
  authenticateProjectOperation,
  authenticateProjectRead
} from "./desktop-read-auth.js";

const paramsSchema = z.object({ id: z.uuid() }).strict();
const cancelSchema = z.object({ batchId: z.uuid() }).strict();
const optionalBatchSchema = z.object({ batchId: z.uuid().optional() }).strict();
const deleteStatusQuerySchema = z
  .object({ batchId: z.uuid().optional() })
  .strict();
const operationStatus = (
  operation: { batchId: string; state: string } | null
) =>
  operation
    ? {
        batchId: operation.batchId,
        state: operation.state as NonNullable<
          z.infer<typeof projectDeleteStatusSchema>["operation"]
        >["state"]
      }
    : null;

export function registerProjectRoutes(
  app: FastifyInstance,
  input: {
    repository: ProjectApiRepository | null;
    managedRepository: Pick<
      ManagedConversationRepository,
      "getManagedConversationExecution" | "enqueueManagedConversationControl"
    > | null;
    sourceCoordinator: ProjectSourceCoordinator | null;
    deploymentProfile: string;
    koedHome?: string;
    auth: ApiRouteContext["auth"];
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) {
  const repo = () => {
    if (
      input.deploymentProfile !== "local_personal" &&
      input.deploymentProfile !== "developer"
    )
      throw Object.assign(
        new Error("Personal Projects require a local deployment"),
        { statusCode: 403 }
      );
    if (!input.repository)
      throw Object.assign(new Error("Projects are unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const authenticate = (
    request: Parameters<typeof authenticateProjectOperation>[0],
    write: boolean
  ) => authenticateProjectOperation(request, input, write);
  const handle = (
    reply: { code: (status: number) => { send: (value: unknown) => unknown } },
    error: unknown
  ) => {
    if (error instanceof ProjectNotFoundError)
      return reply.code(404).send({ message: error.message });
    if (error instanceof ProjectCapabilityError)
      return reply.code(409).send({ message: error.message });
    if (error instanceof ProjectConflictError)
      return reply
        .code(409)
        .send({ message: error.message, current: error.current ?? null });
    throw error;
  };
  app.get(
    "/v1/projects",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectRead(request, input);
      const parsed = projectListQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ message: "Invalid Project page query" });
      try {
        return projectListSchema.parse(await repo().list(user.id, parsed.data));
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.post(
    "/v1/projects",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const body = createProjectSchema.parse(request.body);
      if (
        body.textActionId &&
        !request.headers.authorization?.trim().startsWith("Koed-Desktop ")
      )
        throw Object.assign(
          new Error("Text action requires Desktop authority"),
          { statusCode: 403 }
        );
      try {
        return reply
          .code(201)
          .send(projectSchema.parse(await repo().create(user.id, body)));
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.patch(
    "/v1/projects/:id",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = paramsSchema.parse(request.params);
      const body = patchProjectSchema.parse(request.body);
      try {
        return projectSchema.parse(await repo().patch(user.id, id, body));
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.delete(
    "/v1/projects/:id",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = paramsSchema.parse(request.params);
      const body = projectDeleteSchema.parse(request.body);
      try {
        if (!(await reconcileRestoredSources(user.id, id)))
          throw new ProjectConflictError(
            "Prior Project source release is pending"
          );
        await repo().beginDelete(user.id, id, body);
        return reply.code(202).send(await progress(user.id, id, body.batchId));
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  const reconcileRestoredSources = async (
    ownerUserId: string,
    id: string,
    batchId?: string
  ): Promise<boolean> => {
    const repository = repo();
    const pending = (
      await repository.listPendingReleaseOperations(ownerUserId, id)
    ).filter((operation) => !batchId || operation.batchId === batchId);
    for (const operation of pending) {
      if (operation.sources.some((source) => source.backends.length > 0)) {
        if (!input.sourceCoordinator) return false;
        const closed = await input.sourceCoordinator.cancel({
          ownerUserId,
          projectId: id,
          batchId: operation.batchId,
          operation
        });
        if (!closed) return false;
      }
      await repository.finishRestoreRelease(ownerUserId, id, operation.batchId);
    }
    return true;
  };
  const progress = async (
    ownerUserId: string,
    id: string,
    batchId?: string
  ) => {
    const repository = repo();
    const operation = await repository.getDeleteOperation(ownerUserId, id);
    if (!operation)
      throw new ProjectNotFoundError("Project deletion not found");
    if (batchId && operation.batchId !== batchId)
      throw new ProjectConflictError("Project delete batch changed");
    const before = await repository.get(ownerUserId, id);
    if (before.lifecycle === "deleted")
      return projectDeleteStatusSchema.parse({
        project: before,
        operation: operationStatus(operation),
        complete: true,
        retryable: false,
        pendingFreezeCount: 0,
        pendingExecutionCount: 0,
        pendingReviews: [],
        cancellationPending: false
      });
    const managed = input.managedRepository;
    if (!managed)
      throw new ProjectCapabilityError(
        "Project execution coordinator is unavailable"
      );
    for (const execution of operation.executions) {
      const current = await managed.getManagedConversationExecution(
        { userId: ownerUserId },
        execution.id
      );
      if (
        !current ||
        current.executionGeneration !== execution.executionGeneration
      )
        throw new ProjectConflictError("Confirmed Project execution changed");
      if (["stopped", "failed", "fenced"].includes(current.state)) {
        await repository.recordRuntimeAck(ownerUserId, id, operation.batchId, {
          executionId: execution.id,
          executionGeneration: execution.executionGeneration,
          state: current.state as "stopped" | "failed" | "fenced",
          stateVersion: current.stateVersion
        });
      } else if (
        [
          "starting",
          "running",
          "reconciling",
          "quiesce_requested",
          "quiesced",
          "stopping"
        ].includes(current.state)
      ) {
        await managed.enqueueManagedConversationControl(
          { userId: ownerUserId },
          {
            executionId: execution.id,
            executionGeneration: execution.executionGeneration,
            idempotencyKey: `project-delete:${operation.batchId}:${execution.id}`,
            commandKind: "stop"
          }
        );
      } else
        throw new ProjectConflictError(
          "Confirmed Project execution is unresolved"
        );
    }
    let remoteVerified = operation.sources.every(
      (source) => source.backends.length === 0
    );
    if (!remoteVerified) {
      if (!input.sourceCoordinator)
        throw new ProjectCapabilityError(
          "Project source coordinator is unavailable"
        );
      try {
        await input.sourceCoordinator.advance({
          ownerUserId,
          projectId: id,
          batchId: operation.batchId,
          operation
        });
        remoteVerified = true;
      } catch (error) {
        if (error instanceof ProjectNativeReviewDeclined) {
          const project = await repository.cancelDelete(
            ownerUserId,
            id,
            operation.batchId
          );
          const cancelled = await repository.getDeleteOperationByBatch(
            ownerUserId,
            id,
            operation.batchId
          );
          const closed =
            cancelled && input.sourceCoordinator
              ? await input.sourceCoordinator.cancel({
                  ownerUserId,
                  projectId: id,
                  batchId: operation.batchId,
                  operation: cancelled
                })
              : false;
          return projectDeleteStatusSchema.parse({
            project,
            operation: { batchId: operation.batchId, state: "cancelled" },
            complete: false,
            retryable: false,
            pendingFreezeCount: 0,
            pendingExecutionCount: 0,
            pendingReviews: [],
            cancellationPending: !closed
          });
        }
        // An uncertain remote response leaves the durable batch pending. A
        // later progress call reconciles Team state before any completion.
      }
    }
    const refreshed = await repository.getDeleteOperation(ownerUserId, id);
    if (!refreshed)
      throw new ProjectConflictError("Project deletion operation changed");
    if (refreshed.batchId !== operation.batchId)
      throw new ProjectConflictError("Project delete batch changed");
    if (
      remoteVerified &&
      refreshed.sources.every((source) =>
        source.backends.every((backend) =>
          refreshed.backendAcks.some(
            (ack) =>
              ack.backendId === backend.backendId &&
              ack.logicalMemoryId === source.logicalMemoryId &&
              ack.sealed
          )
        )
      ) &&
      refreshed.grantFreezeAcks.every(
        (ack) => ack.state === "frozen" || ack.state === "resolved"
      ) &&
      refreshed.runtimeAcks.length === refreshed.executions.length
    ) {
      await repository.markDeleteReady(ownerUserId, id, operation.batchId);
      const project = await repository.completeDelete(
        ownerUserId,
        id,
        operation.batchId
      );
      return projectDeleteStatusSchema.parse({
        project,
        operation: { batchId: operation.batchId, state: "complete" },
        complete: true,
        retryable: false,
        pendingFreezeCount: 0,
        pendingExecutionCount: 0,
        pendingReviews: [],
        cancellationPending: false
      });
    }
    const project = await repository.get(ownerUserId, id);
    return projectDeleteStatusSchema.parse({
      project,
      operation: operationStatus(refreshed),
      complete: false,
      retryable: true,
      pendingFreezeCount: refreshed.sources.reduce(
        (count, source) =>
          count +
          source.backends.filter(
            (backend) =>
              !refreshed.backendAcks.some(
                (ack) =>
                  ack.logicalMemoryId === source.logicalMemoryId &&
                  ack.backendId === backend.backendId &&
                  ack.sealed
              )
          ).length,
        0
      ),
      pendingExecutionCount:
        refreshed.executions.length - refreshed.runtimeAcks.length,
      pendingReviews: refreshed.grantFreezeAcks
        .filter((ack) => ack.state === "review_required" && ack.actionGrantId)
        .map((ack) => ({
          backendId: ack.backendId,
          shareGrantId: ack.shareGrantId,
          actionGrantId: ack.actionGrantId!
        })),
      cancellationPending: false
    });
  };
  app.post(
    "/v1/projects/:id/delete-progress",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = paramsSchema.parse(request.params);
      const { batchId } = optionalBatchSchema.parse(request.body ?? {});
      try {
        return await progress(user.id, id, batchId);
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.post(
    "/v1/projects/:id/delete-cancel",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = paramsSchema.parse(request.params);
      const { batchId } = cancelSchema.parse(request.body);
      try {
        const repository = repo();
        const operation = await repository.getDeleteOperationByBatch(
          user.id,
          id,
          batchId
        );
        if (!operation || operation.state === "complete")
          throw new ProjectConflictError(
            "Project delete batch cannot be cancelled"
          );
        const project =
          operation.state === "cancelled"
            ? await repository.get(user.id, id)
            : await repository.cancelDelete(user.id, id, batchId);
        const closed = input.sourceCoordinator
          ? await input.sourceCoordinator.cancel({
              ownerUserId: user.id,
              projectId: id,
              batchId,
              operation
            })
          : operation.sources.every((source) => source.backends.length === 0);
        return projectDeleteStatusSchema.parse({
          project,
          operation: operationStatus(
            operation.state === "cancelled"
              ? operation
              : { batchId, state: "cancelled" }
          ),
          complete: false,
          retryable: false,
          pendingFreezeCount: 0,
          pendingExecutionCount: 0,
          pendingReviews: [],
          cancellationPending: !closed
        });
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.get(
    "/v1/projects/:id/delete-status",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, false);
      const { id } = paramsSchema.parse(request.params);
      const query = deleteStatusQuerySchema.parse(request.query);
      try {
        const repository = repo();
        const project = await repository.get(user.id, id);
        const operation = query.batchId
          ? await repository.getDeleteOperationByBatch(
              user.id,
              id,
              query.batchId
            )
          : ((await repository.getDeleteOperation(user.id, id)) ??
            (await repository.listPendingReleaseOperations(user.id, id))[0] ??
            null);
        if (query.batchId && !operation)
          throw new ProjectNotFoundError("Project deletion batch not found");
        const activeOperation =
          operation !== null &&
          [
            "preparing",
            "freezing",
            "stopping",
            "ready",
            "needs_attention"
          ].includes(operation.state);
        const cancellationPending =
          (operation?.state === "cancelled" ||
            operation?.state === "restore_releasing") &&
          operation.sources.some((source) =>
            source.backends.some(
              (backend) =>
                !operation.backendAcks.some(
                  (ack) =>
                    ack.logicalMemoryId === source.logicalMemoryId &&
                    ack.backendId === backend.backendId &&
                    ack.cancelled
                )
            )
          );
        return projectDeleteStatusSchema.parse({
          project,
          operation: operationStatus(operation),
          complete: operation
            ? operation.state === "complete"
            : project.lifecycle === "deleted",
          retryable: activeOperation,
          pendingFreezeCount:
            operation?.sources.reduce(
              (count, source) =>
                count +
                source.backends.filter(
                  (backend) =>
                    !operation.backendAcks.some(
                      (ack) =>
                        ack.logicalMemoryId === source.logicalMemoryId &&
                        ack.backendId === backend.backendId &&
                        (operation.state === "restore_releasing" ||
                        operation.state === "restored" ||
                        operation.state === "cancelled"
                          ? ack.cancelled
                          : ack.sealed)
                    )
                ).length,
              0
            ) ?? 0,
          pendingExecutionCount:
            activeOperation && operation
              ? operation.executions.length - operation.runtimeAcks.length
              : 0,
          pendingReviews:
            (activeOperation && operation ? operation.grantFreezeAcks : [])
              .filter(
                (ack) => ack.state === "review_required" && ack.actionGrantId
              )
              .map((ack) => ({
                backendId: ack.backendId,
                shareGrantId: ack.shareGrantId,
                actionGrantId: ack.actionGrantId!
              })) ?? [],
          cancellationPending: Boolean(cancellationPending)
        });
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.get(
    "/v1/projects/:id/delete-preview",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, false);
      const { id } = paramsSchema.parse(request.params);
      try {
        return projectDeletePreviewSchema.parse(
          await repo().deletePreview(user.id, id)
        );
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.post(
    "/v1/projects/:id/restore",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = paramsSchema.parse(request.params);
      const body = projectRestoreSchema.parse(request.body);
      try {
        const project = await repo().restore(user.id, id, body);
        await reconcileRestoredSources(user.id, id);
        return projectSchema.parse(project);
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.post(
    "/v1/projects/:id/restore-reconcile",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = paramsSchema.parse(request.params);
      const { batchId } = optionalBatchSchema.parse(request.body ?? {});
      try {
        if (batchId) {
          const operation = await repo().getDeleteOperationByBatch(
            user.id,
            id,
            batchId
          );
          if (!operation)
            throw new ProjectNotFoundError("Project deletion batch not found");
          if (
            operation.state !== "restored" &&
            operation.state !== "restore_releasing"
          )
            throw new ProjectConflictError(
              "Project restore batch is not current"
            );
          const current = await repo().get(user.id, id);
          if (
            current.lifecycle !== "active" ||
            current.deletionPhase !== null ||
            current.deleteBatchId !== null
          )
            throw new ProjectConflictError(
              "Project restore is no longer current"
            );
        }
        const released = await reconcileRestoredSources(user.id, id, batchId);
        const project = projectSchema.parse(await repo().get(user.id, id));
        if (
          batchId &&
          (project.lifecycle !== "active" ||
            project.deletionPhase !== null ||
            project.deleteBatchId !== null)
        )
          throw new ProjectConflictError(
            "Project restore is no longer current"
          );
        return {
          project,
          released
        };
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.get(
    "/v1/projects/:id/hq",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectRead(request, input);
      const { id } = paramsSchema.parse(request.params);
      try {
        return projectHqSchema.parse(await repo().hq(user.id, id));
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.post(
    "/v1/projects/:id/hq/conversation",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const { id } = paramsSchema.parse(request.params);
      try {
        return projectHqConversationSchema.parse(
          await repo().reserveHqConversation(user.id, id)
        );
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
  app.get(
    "/v1/projects/:id/hq/conversation",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectRead(request, input);
      const { id } = paramsSchema.parse(request.params);
      try {
        return projectHqConversationReadSchema.parse(
          await repo().readHqConversation(user.id, id)
        );
      } catch (error) {
        return handle(reply, error);
      }
    }
  );
}
