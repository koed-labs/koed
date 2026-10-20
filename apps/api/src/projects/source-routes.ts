import type { FastifyInstance } from "fastify";
import type {
  ProjectSourceRepository,
  ProjectSourceRemovalRepository
} from "@koed/db";
import {
  ProjectCapabilityError,
  ProjectConflictError,
  ProjectNotFoundError
} from "@koed/db";
import {
  createProjectSourceSchema,
  projectSourceReadSchema,
  projectSourceRemovalReviewReservationSchema,
  projectSourceRemovalStatusSchema,
  projectSourceSchema,
  projectSourceUploadSchema,
  projectSourcesSchema
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "./desktop-read-auth.js";
import {
  ProjectNativeReviewDeclined,
  type ProjectSourceCoordinator
} from "./delete-coordinator.js";

const projectParams = z.object({ id: z.uuid() }).strict();
const sourceParams = z.object({ id: z.uuid(), sourceId: z.uuid() }).strict();
const reviewParams = sourceParams.extend({ actionGrantId: z.uuid() }).strict();

export function registerProjectSourceRoutes(
  app: FastifyInstance,
  input: {
    repository: ProjectSourceRepository | null;
    removalRepository?: ProjectSourceRemovalRepository | null;
    sourceCoordinator?: ProjectSourceCoordinator | null;
    deploymentProfile: string;
    koedHome?: string;
    auth: ApiRouteContext["auth"];
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
    requestIngestion?: () => void;
  }
) {
  const repo = () => {
    if (
      !input.repository ||
      !["developer", "local_personal"].includes(input.deploymentProfile)
    )
      throw Object.assign(new Error("Project Sources are unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const handle = (error: unknown) => {
    if (error instanceof ProjectNotFoundError)
      return { statusCode: 404, message: error.message };
    if (error instanceof ProjectConflictError)
      return { statusCode: 409, message: error.message };
    if (error instanceof ProjectCapabilityError)
      return {
        statusCode:
          error.message.includes("ingestion") || error.message.includes("retry")
            ? 503
            : 409,
        message: error.message
      };
    throw error;
  };
  const removal = () => {
    if (!input.removalRepository)
      throw new ProjectCapabilityError(
        "Project Source removal coordinator is unavailable"
      );
    return input.removalRepository;
  };
  const removalProgress = async (
    ownerUserId: string,
    projectId: string,
    sourceId: string,
    batchId: string
  ) => {
    let operation = await removal().get(ownerUserId, projectId, batchId);
    if (operation.sourceId !== sourceId)
      throw new ProjectConflictError("Project Source removal batch changed");
    if (operation.state === "complete" || operation.state === "cancelled")
      return projectSourceRemovalStatusSchema.parse({
        batchId,
        state: operation.state,
        complete: operation.state === "complete",
        retryable: false,
        pendingFreezeCount: 0,
        pendingReviews: [],
        cancellationPending: false
      });
    if (operation.state === "cancel_requested") {
      const closed = input.sourceCoordinator
        ? await input.sourceCoordinator.cancel({
            ownerUserId,
            projectId,
            batchId,
            operation
          })
        : operation.sources.every((source) => source.backends.length === 0);
      if (closed) {
        await removal().cancel(ownerUserId, projectId, sourceId, batchId);
        return projectSourceRemovalStatusSchema.parse({
          batchId,
          state: "cancelled",
          complete: false,
          retryable: false,
          pendingFreezeCount: 0,
          pendingReviews: [],
          cancellationPending: false
        });
      }
      return projectSourceRemovalStatusSchema.parse({
        batchId,
        state: "cancel_requested",
        complete: false,
        retryable: true,
        pendingFreezeCount: 0,
        pendingReviews: [],
        cancellationPending: true
      });
    }
    if (operation.sources.some((source) => source.backends.length > 0)) {
      if (!input.sourceCoordinator)
        throw new ProjectCapabilityError(
          "Project Source coordinator is unavailable"
        );
      try {
        await input.sourceCoordinator.advance({
          ownerUserId,
          projectId,
          batchId,
          operation
        });
      } catch (error) {
        if (error instanceof ProjectNativeReviewDeclined) {
          await removal().requestCancel(
            ownerUserId,
            projectId,
            sourceId,
            batchId
          );
          return removalProgress(ownerUserId, projectId, sourceId, batchId);
        }
        // Remote uncertainty remains a durable retryable batch.
      }
    }
    operation = await removal().get(ownerUserId, projectId, batchId);
    const pendingFreezeCount = operation.sources.reduce(
      (count, source) =>
        count +
        source.backends.filter(
          (backend) =>
            !operation.backendAcks.some(
              (ack) =>
                ack.logicalMemoryId === source.logicalMemoryId &&
                ack.backendId === backend.backendId &&
                ack.sealed
            )
        ).length,
      0
    );
    if (
      pendingFreezeCount === 0 &&
      operation.grantFreezeAcks.every(
        (ack) => ack.state === "frozen" || ack.state === "resolved"
      )
    ) {
      await removal().complete(ownerUserId, projectId, sourceId, batchId);
      return projectSourceRemovalStatusSchema.parse({
        batchId,
        state: "complete",
        complete: true,
        retryable: false,
        pendingFreezeCount: 0,
        pendingReviews: [],
        cancellationPending: false
      });
    }
    return projectSourceRemovalStatusSchema.parse({
      batchId,
      state: operation.state,
      complete: false,
      retryable: true,
      pendingFreezeCount,
      pendingReviews: operation.grantFreezeAcks
        .filter((ack) => ack.state === "review_required" && ack.actionGrantId)
        .map((ack) => ({
          backendId: ack.backendId,
          shareGrantId: ack.shareGrantId,
          actionGrantId: ack.actionGrantId!
        })),
      cancellationPending: false
    });
  };
  app.get(
    "/v1/projects/:id/sources",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, false);
      const { id } = projectParams.parse(request.params);
      try {
        return projectSourcesSchema.parse({
          sources: await repo().list(user.id, id)
        });
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.post(
    "/v1/projects/:id/sources/upload",
    { preHandler: input.writeRateLimit, bodyLimit: 35 * 1024 * 1024 },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, true);
      const { id } = projectParams.parse(request.params);
      const parsed = projectSourceUploadSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ message: "Invalid Project Source upload" });
      try {
        const uploaded = await repo().uploadDocument(user.id, id, parsed.data);
        input.requestIngestion?.();
        return reply.code(202).send(projectSourceSchema.parse(uploaded.source));
      } catch (error) {
        if (error instanceof TypeError)
          return reply.code(400).send({ message: error.message });
        if (
          error instanceof ProjectCapabilityError &&
          error.message.includes("25 MB")
        )
          return reply
            .code(413)
            .send({ message: "Project Source exceeds 25 MB" });
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.get(
    "/v1/projects/:id/sources/:sourceId/content",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, false);
      const { id, sourceId } = sourceParams.parse(request.params);
      try {
        return projectSourceReadSchema.parse(
          await repo().readDocument(user.id, id, sourceId)
        );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.post(
    "/v1/projects/:id/sources",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, true);
      const { id } = projectParams.parse(request.params);
      const parsed = createProjectSourceSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ message: "Invalid Project Source" });
      try {
        return reply
          .code(201)
          .send(
            projectSourceSchema.parse(
              await repo().create(user.id, id, parsed.data)
            )
          );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.delete(
    "/v1/projects/:id/sources/:sourceId",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, true);
      const { id, sourceId } = sourceParams.parse(request.params);
      try {
        return projectSourceSchema.parse(
          await repo().remove(user.id, id, sourceId)
        );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.post(
    "/v1/projects/:id/sources/:sourceId/removal",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, true);
      const { id, sourceId } = sourceParams.parse(request.params);
      try {
        const last = await removal().latest(user.id, id, sourceId);
        const operation =
          last?.state === "complete"
            ? last
            : await removal().begin(user.id, id, sourceId);
        return reply
          .code(202)
          .send(
            await removalProgress(user.id, id, sourceId, operation.batchId)
          );
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.get(
    "/v1/projects/:id/sources/:sourceId/removal/reviews/:actionGrantId",
    { preHandler: input.readRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, false);
      const { id, sourceId, actionGrantId } = reviewParams.parse(
        request.params
      );
      try {
        const current = await removal().latest(user.id, id, sourceId);
        if (
          !current ||
          current.sourceId !== sourceId ||
          !["preparing", "freezing"].includes(current.state)
        )
          throw new ProjectConflictError(
            "Project Source removal review changed"
          );
        const ack = current.grantFreezeAcks.find(
          (item) =>
            item.actionGrantId === actionGrantId &&
            item.state === "review_required" &&
            current.sources.some(
              (source) =>
                source.logicalMemoryId === item.logicalMemoryId &&
                source.backends.some(
                  (backend) => backend.backendId === item.backendId
                )
            )
        );
        if (!ack)
          throw new ProjectConflictError(
            "Project Source review reservation changed"
          );
        return projectSourceRemovalReviewReservationSchema.parse({
          batchId: current.batchId,
          sourceId,
          backendId: ack.backendId,
          shareGrantId: ack.shareGrantId,
          actionGrantId,
          reviewedGrantVersion: ack.reviewedGrantVersion
        });
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
  app.post(
    "/v1/projects/:id/sources/:sourceId/retry",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const user = await authenticateProjectOperation(request, input, true);
      const { id, sourceId } = sourceParams.parse(request.params);
      try {
        const result = projectSourceSchema.parse(
          await repo().retry(user.id, id, sourceId)
        );
        input.requestIngestion?.();
        return result;
      } catch (error) {
        const result = handle(error);
        return reply.code(result.statusCode).send(result);
      }
    }
  );
}
