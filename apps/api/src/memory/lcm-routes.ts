import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  lcmPendingSummariesQuerySchema,
  nodeIdParamsSchema,
  submitLcmSummarySchema
} from "./lcm-schemas.js";

export const registerLcmRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateApiToken },
    jobs: { enqueueEmbedding },
    rateLimit: {
      memoryRecall: memoryRecallRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  app.get(
    "/v1/memory/lcm/summaries/pending",
    { preHandler: memoryRecallRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = lcmPendingSummariesQuerySchema.parse(request.query);
      const nodes = await repo.listLcmNodesNeedingSummaries(
        { userId: user.id },
        { limit: query.limit }
      );

      return {
        nodes,
        count: nodes.length,
        localOnly: true,
        instructions:
          "Run LCM summarisation locally through the user's Codex subscription, then submit each summary back to /v1/memory/lcm/summaries/{nodeId}. Backend workers do not call LLMs for LCM summaries."
      };
    }
  );

  app.post(
    "/v1/memory/lcm/summaries/:nodeId",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const input = submitLcmSummarySchema.parse(request.body);
      const node = await repo.getVisibleLcmNodeForSummarization(
        { userId: user.id },
        params.nodeId
      );
      if (!node) {
        return reply
          .status(404)
          .send({ error: "LCM node not found or not visible" });
      }

      await repo.updateLcmNodeSummary({
        nodeId: params.nodeId,
        summaryText: input.summaryText,
        summaryModel: input.summaryModel,
        summaryPromptVersion: input.summaryPromptVersion,
        summaryTokenEstimate: input.summaryTokenEstimate,
        summaryStructuredJson: input.summaryStructuredJson,
        summaryStructuredSchemaVersion: input.summaryStructuredSchemaVersion
      });
      const embedding = await enqueueEmbedding("memory_node", params.nodeId);

      return {
        nodeId: params.nodeId,
        kind: node.kind,
        depth: node.depth,
        summaryModel: input.summaryModel,
        summaryPromptVersion: input.summaryPromptVersion,
        summaryTokenEstimate: input.summaryTokenEstimate,
        summaryStructuredSchemaVersion: input.summaryStructuredSchemaVersion,
        embedding
      };
    }
  );
};
