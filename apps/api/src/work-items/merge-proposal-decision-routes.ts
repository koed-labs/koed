import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateWorkItemSourceControl } from "./pr-reconciliation-routes.js";

/** A Native decline conveys no approval or provider mutation authority. */
export const registerMergeProposalDecisionRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  app.post(
    "/v1/managed-conversations/:executionId/merge-proposals/:itemId/decline",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const user = await authenticateWorkItemSourceControl(request, context);
      const params = z
        .object({ executionId: z.uuid(), itemId: z.uuid() })
        .strict()
        .parse(request.params);
      const body = z
        .object({ executionGeneration: z.number().int().positive() })
        .strict()
        .parse(request.body);
      const accepted = await context
        .requireRepository()
        .declineManagedMergeProposal(
          { userId: user.id },
          { ...params, ...body }
        );
      if (!accepted)
        return reply
          .code(409)
          .send({ message: "The merge proposal or Conversation changed" });
      return { accepted: true };
    }
  );
};
