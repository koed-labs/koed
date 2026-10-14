import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  repositoryChangeInputSchema,
  repositoryReviewOptionsSchema,
  repositoryReviewActionSchema
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
export const registerRepositoryReviewRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit: { memoryRead, memoryWrite },
    graph: { cacheProvider }
  } = context;
  app.post(
    "/v1/memory/repository-changes",
    { preHandler: memoryWrite },
    async (request) => {
      const user = await authenticate(request);
      const input = repositoryChangeInputSchema.parse(request.body);
      return {
        event: await requireRepository().recordRepositoryChange(
          { userId: user.id },
          input
        )
      };
    }
  );
  app.get(
    "/v1/memory/repository-changes",
    { preHandler: memoryRead },
    async (request) => {
      const user = await authenticate(request);
      const query = z
        .object({ checkoutId: z.string().min(1).max(160).optional() })
        .strict()
        .parse(request.query);
      return {
        events: await requireRepository().listRepositoryChanges(
          { userId: user.id },
          query.checkoutId
        )
      };
    }
  );
  app.post(
    "/v1/memory/repository-changes/:eventId/reviews",
    { preHandler: memoryWrite },
    async (request) => {
      const user = await authenticate(request);
      const { eventId } = z
        .object({ eventId: z.string().uuid() })
        .parse(request.params);
      const options = repositoryReviewOptionsSchema.parse(request.body);
      return {
        review: await requireRepository().createRepositoryAssignmentReview(
          { userId: user.id },
          eventId,
          options
        )
      };
    }
  );
  app.get(
    "/v1/memory/repository-reviews/:reviewId",
    { preHandler: memoryRead },
    async (request) => {
      const user = await authenticate(request);
      const { reviewId } = z
        .object({ reviewId: z.string().uuid() })
        .parse(request.params);
      return {
        review: await requireRepository().getRepositoryAssignmentReview(
          { userId: user.id },
          reviewId
        )
      };
    }
  );
  app.post(
    "/v1/memory/repository-reviews/:reviewId",
    { preHandler: memoryWrite },
    async (request) => {
      const user = await authenticate(request);
      const { reviewId } = z
        .object({ reviewId: z.string().uuid() })
        .parse(request.params);
      const action = repositoryReviewActionSchema.parse(request.body);
      const review =
        await requireRepository().executeRepositoryAssignmentReview(
          { userId: user.id },
          reviewId,
          action
        );
      if (action.action === "apply")
        await cacheProvider.deleteByPrefix("koed:graph:");
      return { review };
    }
  );
};
