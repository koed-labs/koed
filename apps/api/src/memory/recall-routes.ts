import { answerMemory, searchMemory } from "@koed/core";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import { searchMemorySchema } from "./recall-schemas.js";

export const registerRecallRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate, authenticateApiToken },
    rateLimit: { memoryRecall: memoryRecallRateLimit }
  } = context;

  app.post(
    "/v1/memory/search",
    { preHandler: memoryRecallRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = searchMemorySchema.parse(request.body);
      const result = await searchMemory({
        repository: repo,
        requesterContext: { userId: user.id },
        query: input.query,
        scope: input.retrieval_scope,
        searchDomain: input.search_domain,
        sessionId: input.session_id,
        workspaceId: input.workspace_id,
        limit: input.limit,
        recentDays: input.recent_days,
        sourceAfter: input.source_after?.toISOString(),
        sourceBefore: input.source_before?.toISOString(),
        retrievalStage: input.retrieval_stage,
        parentNodeIds: input.parent_node_ids,
        strictLimit: input.strict_limit
      });

      return {
        hits: result.results,
        rawHitsCount: result.results.length,
        lcmHitsCount: result.results.length,
        retrieval: result.metadata,
        retrievalMode: result.metadata.retrievalMode,
        vectorHitsCount: result.metadata.vectorHitsCount,
        textHitsCount: result.metadata.textHitsCount,
        embeddingModel: result.metadata.embeddingModel,
        embeddingDimensions: result.metadata.embeddingDimensions,
        vectorCandidateCount: result.metadata.vectorCandidateCount,
        rerankedCount: result.metadata.rerankedCount,
        rerankerModel: result.metadata.rerankerModel,
        rerankingEnabled: result.metadata.rerankingEnabled,
        rerankingUnavailable: result.metadata.rerankingUnavailable,
        rerankingError: result.metadata.rerankingError,
        visibilityLabels: [
          ...new Set(result.results.map((hit) => hit.visibility))
        ]
      };
    }
  );

  app.post(
    "/v1/memory/answer",
    { preHandler: memoryRecallRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = searchMemorySchema.parse(request.body);
      const result = await answerMemory({
        repository: repo,
        requesterContext: { userId: user.id },
        query: input.query,
        scope: input.retrieval_scope,
        searchDomain: input.search_domain,
        sessionId: input.session_id,
        workspaceId: input.workspace_id,
        limit: input.limit,
        recentDays: input.recent_days,
        sourceAfter: input.source_after?.toISOString(),
        sourceBefore: input.source_before?.toISOString(),
        retrievalStage: input.retrieval_stage,
        parentNodeIds: input.parent_node_ids,
        strictLimit: input.strict_limit
      });
      const expandedNodeIds = [
        ...new Set(
          result.citations
            .filter(
              (citation) =>
                !citation.sourceType || citation.sourceType === "memory_node"
            )
            .map((citation) => citation.nodeId)
        )
      ];
      const visibilityLabels = [
        ...new Set(result.citations.map((citation) => citation.visibility))
      ];

      return {
        markdown: result.answer,
        instructions: result.evidenceBundle.instructions,
        evidenceBundle: result.evidenceBundle,
        evidence: result.evidenceBundle.evidence,
        citations: result.citations,
        rawHitsCount: result.citations.length,
        lcmHitsCount: result.citations.length,
        retrieval: result.evidenceBundle.retrieval,
        retrievalMode: result.evidenceBundle.retrieval.retrievalMode,
        vectorHitsCount: result.evidenceBundle.retrieval.vectorHitsCount,
        textHitsCount: result.evidenceBundle.retrieval.textHitsCount,
        embeddingModel: result.evidenceBundle.retrieval.embeddingModel,
        embeddingDimensions:
          result.evidenceBundle.retrieval.embeddingDimensions,
        vectorCandidateCount:
          result.evidenceBundle.retrieval.vectorCandidateCount,
        rerankedCount: result.evidenceBundle.retrieval.rerankedCount,
        rerankerModel: result.evidenceBundle.retrieval.rerankerModel,
        rerankingEnabled: result.evidenceBundle.retrieval.rerankingEnabled,
        rerankingUnavailable:
          result.evidenceBundle.retrieval.rerankingUnavailable,
        rerankingError: result.evidenceBundle.retrieval.rerankingError,
        expandedNodeIds,
        visibilityLabels,
        memoryIndexVersion: "lcm-depth0-contiguous-v1",
        lcmVersion: "depth0-contiguous-v1"
      };
    }
  );
};
