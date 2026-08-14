import { answerMemory, searchMemory } from "@koed/core";
import type { SharedMemorySemanticCandidate } from "@koed/db";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import { searchMemorySchema } from "./recall-schemas.js";
import { canonicalEvidenceSourceIdentity } from "./evidence-source-contract.js";
import { embedTeamSemanticQuery } from "./team-semantic-embedding.js";
import {
  issueMemoryAnswerAuthorizationBoundary,
  MEMORY_ANSWER_AUTHORIZATION_BOUNDARY_MAX_GRANTS,
  memoryAnswerAuthorizationBoundarySecret,
  verifyMemoryAnswerAuthorizationBoundary
} from "./memory-answer-authorization-boundary.js";
import {
  registerRetrievalCapabilityRoute,
  resolveRetrievalCapability,
  retrievalIndexProof
} from "./retrieval-capability.js";

const teamSourceType = (
  representation: SharedMemorySemanticCandidate["representation"]
): "curated_memory" | "memory_event" | "memory_node" =>
  representation === "memory_events"
    ? "memory_event"
    : representation === "curated_assertions"
      ? "curated_memory"
      : "memory_node";

const teamRetrievalStage = (
  representation: SharedMemorySemanticCandidate["representation"]
):
  | "curated_memory_search"
  | "fresh_pending_search"
  | "rollup_search"
  | "scoped_leaf_search" =>
  representation === "lcm_rollups"
    ? "rollup_search"
    : representation === "lcm_leaves"
      ? "scoped_leaf_search"
      : representation === "curated_assertions"
        ? "curated_memory_search"
        : "fresh_pending_search";

const teamRepresentationsForStage = (
  stage: string | undefined
): SharedMemorySemanticCandidate["representation"][] | undefined => {
  if (!stage || stage === "score_scan") return undefined;
  if (stage === "rollup_search") return ["lcm_rollups"];
  if (stage === "scoped_leaf_search" || stage === "leaf_search") {
    return ["lcm_leaves"];
  }
  if (stage === "fresh_pending_search") return ["memory_events"];
  if (stage === "curated_memory_search") return ["curated_assertions"];
  return [];
};

const teamStageRan = (requested: string | undefined, stage: string): boolean =>
  !requested ||
  requested === "score_scan" ||
  requested === stage ||
  (requested === "leaf_search" && stage === "scoped_leaf_search");

const teamHit = (
  candidate: SharedMemorySemanticCandidate,
  includeBody = true,
  parentNodeIds: string[] = []
) => {
  const canonicalSourceIdentity = canonicalEvidenceSourceIdentity(
    teamSourceType(candidate.representation),
    candidate.pseudonymousSourceId,
    candidate.sourceItemIndex
  );
  return {
    nodeId: candidate.candidateId,
    sourceType: teamSourceType(candidate.representation),
    sourceId: candidate.pseudonymousSourceId,
    sourceChunkIndex: candidate.sourceItemIndex,
    sourceChunkCount: 1,
    canonicalSourceIdentity,
    retrievalStage: teamRetrievalStage(candidate.representation),
    parentNodeIds,
    visibility: "team",
    ...(includeBody
      ? {
          summaryText: candidate.text,
          lexicalAnchors: candidate.lexicalAnchors,
          exactAnchorMatches: candidate.exactAnchorMatches
        }
      : {}),
    score: candidate.score,
    freshness: candidate.freshness,
    sourceTime: candidate.occurredAt,
    sourceRevision: candidate.sourceRevision,
    visibilityProvenance: {
      shareGrantId: candidate.shareGrantId,
      representationId: candidate.representationId,
      representation: candidate.representation,
      provenanceHash: candidate.provenanceHash
    },
    generation: {
      representationPolicyRevision: candidate.representationPolicyRevision,
      contentPolicyVersion: candidate.contentPolicyVersion,
      classifierVersion: candidate.classifierVersion,
      embeddingModel: candidate.embeddingModel,
      embeddingDimensions: candidate.embeddingDimensions,
      embeddingVersion: candidate.embeddingVersion
    },
    citation: {
      nodeId: candidate.candidateId,
      sourceType: teamSourceType(candidate.representation),
      sourceId: candidate.pseudonymousSourceId,
      sourceChunkIndex: candidate.sourceItemIndex,
      sourceChunkCount: 1,
      canonicalSourceIdentity,
      retrievalStage: teamRetrievalStage(candidate.representation),
      parentNodeIds,
      visibility: "team"
    }
  };
};

export const registerRecallRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: {
      authenticate,
      authenticateApiToken,
      authenticateSessionOrDeviceCredential
    },
    rateLimit: { memoryRecall: memoryRecallRateLimit }
  } = context;

  registerRetrievalCapabilityRoute(app, {
    authenticate: authenticateApiToken,
    runtimeEmbeddingModel: context.config.embeddingModel,
    runtimeIndexProof: (input) =>
      requireRepository().getRetrievalArenaIndexProof(input)
  });

  app.post(
    "/v1/memory/search",
    { preHandler: memoryRecallRateLimit },
    async (request) => {
      const repo = requireRepository();
      const input = searchMemorySchema.parse(request.body);
      const user = input.team_workspace_id
        ? await authenticateSessionOrDeviceCredential(
            request,
            "team_workspace_read",
            {
              apiTokenError:
                "Session cookie or scoped device credential required for Team Workspace recall"
            }
          )
        : await authenticateApiToken(request);
      if (input.team_workspace_id) {
        const retrievalStartedAt = performance.now();
        const authorizationBoundary = input.authorization_boundary
          ? verifyMemoryAnswerAuthorizationBoundary({
              token: input.authorization_boundary,
              secret: memoryAnswerAuthorizationBoundarySecret(
                context.config.apiTokenPepper
              ),
              subjectUserId: user.id,
              teamWorkspaceId: input.team_workspace_id
            })
          : await repo.freezeSharedMemorySemanticRecallBoundary(
              { userId: user.id },
              {
                teamWorkspaceId: input.team_workspace_id,
                maximumGrantCount:
                  MEMORY_ANSWER_AUTHORIZATION_BOUNDARY_MAX_GRANTS
              }
            );
        const embedding = await embedTeamSemanticQuery(
          input.query,
          context.internalServices.fetch
        );
        const semanticInput = {
          teamWorkspaceId: input.team_workspace_id,
          queryVector: embedding.vector,
          model: embedding.model,
          dimensions: embedding.dimensions,
          version: embedding.version,
          limit: input.limit,
          searchDomain: input.search_domain,
          sessionId: input.session_id,
          projectId: input.project_id,
          recentDays: input.recent_days,
          sourceAfter: input.source_after?.toISOString(),
          sourceBefore: input.source_before?.toISOString(),
          exactHints: input.exact_hints,
          representations: teamRepresentationsForStage(input.retrieval_stage),
          parentCandidateIds: input.parent_node_ids,
          authorizationBoundary
        };
        const scoreScan = input.retrieval_stage === "score_scan";
        const stageScans = scoreScan
          ? await repo.scanAuthorizedSharedMemorySemanticItems(
              { userId: user.id },
              semanticInput
            )
          : [];
        const candidates = scoreScan
          ? []
          : await repo.searchAuthorizedSharedMemorySemanticItems(
              { userId: user.id },
              { ...semanticInput, strictLimit: input.strict_limit }
            );
        const hits = candidates.map((candidate) =>
          teamHit(candidate, true, input.parent_node_ids)
        );
        const candidateCount = scoreScan
          ? stageScans.reduce((sum, scan) => sum + scan.candidateCount, 0)
          : candidates.length;
        const stages = (
          [
            ["rollup_search", "lcm_rollups"],
            ["scoped_leaf_search", "lcm_leaves"],
            ["curated_memory_search", "curated_assertions"],
            ["fresh_pending_search", "memory_events"]
          ] as const
        ).map(([name, representation]) => {
          const selected = candidates.filter(
            (candidate) => candidate.representation === representation
          );
          const scan = stageScans.find(
            (candidate) => candidate.representation === representation
          );
          const ran = teamStageRan(input.retrieval_stage, name);
          return {
            name,
            ran,
            used:
              input.retrieval_stage !== "score_scan" &&
              ran &&
              selected.length > 0,
            candidateCount: ran ? (scan?.candidateCount ?? selected.length) : 0,
            selectedCount:
              input.retrieval_stage !== "score_scan" && ran
                ? selected.length
                : 0,
            durationMs: Math.max(0, performance.now() - retrievalStartedAt),
            parallelGroup: "team_shared_semantic_first_pass",
            temporalFilterApplied: Boolean(
              input.source_after || input.source_before || input.recent_days
            ),
            topScore: scan?.topScore ?? selected[0]?.score,
            countAboveThreshold: ran
              ? (scan?.candidateCount ?? selected.length)
              : 0,
            maxAllowed: ran ? input.limit : 0
          };
        });
        return {
          hits,
          rawHitsCount: hits.length,
          lcmHitsCount: hits.filter((hit) => hit.sourceType === "memory_node")
            .length,
          retrieval: {
            retrievalMode: "semantic_vector",
            vectorHitsCount: candidateCount,
            textHitsCount: 0,
            embeddingModel: embedding.model,
            embeddingDimensions: embedding.dimensions,
            vectorCandidateCount: candidateCount,
            stages
          },
          retrievalMode: "semantic_vector",
          vectorHitsCount: candidateCount,
          textHitsCount: 0,
          embeddingModel: embedding.model,
          embeddingDimensions: embedding.dimensions,
          semanticRetrievalComplete: true,
          vectorCandidateCount: candidateCount,
          rerankedCount: 0,
          rerankerModel: null,
          rerankingEnabled: false,
          rerankingUnavailable: false,
          visibilityLabels: ["team"]
        };
      }
      const result = await searchMemory({
        repository: repo,
        requesterContext: { userId: user.id },
        query: input.query,
        scope: input.retrieval_scope,
        searchDomain: input.search_domain,
        sessionId: input.session_id,
        projectId: input.project_id,
        limit: input.limit,
        recentDays: input.recent_days,
        sourceAfter: input.source_after?.toISOString(),
        sourceBefore: input.source_before?.toISOString(),
        exactHints: input.exact_hints,
        retrievalStage: input.retrieval_stage,
        parentNodeIds: input.parent_node_ids,
        strictLimit: input.strict_limit
      });
      const indexProof = retrievalIndexProof(
        await resolveRetrievalCapability({
          runtimeEmbeddingModel: context.config.embeddingModel,
          ownerUserId: user.id,
          runtimeIndexProof: (proofInput) =>
            repo.getRetrievalArenaIndexProof(proofInput)
        })
      );

      return {
        hits: result.results,
        rawHitsCount: result.results.length,
        lcmHitsCount: result.results.length,
        retrieval: { ...result.metadata, ...indexProof },
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
      const input = searchMemorySchema.parse(request.body);
      const user = input.team_workspace_id
        ? await authenticateSessionOrDeviceCredential(
            request,
            "team_workspace_read",
            {
              apiTokenError:
                "Session cookie or scoped device credential required for Team Workspace recall"
            }
          )
        : await authenticate(request);
      if (input.team_workspace_id) {
        const retrievalStartedAt = performance.now();
        const authorizationBoundary =
          await repo.freezeSharedMemorySemanticRecallBoundary(
            { userId: user.id },
            {
              teamWorkspaceId: input.team_workspace_id,
              maximumGrantCount: MEMORY_ANSWER_AUTHORIZATION_BOUNDARY_MAX_GRANTS
            }
          );
        const authorizationBoundaryToken =
          issueMemoryAnswerAuthorizationBoundary({
            secret: memoryAnswerAuthorizationBoundarySecret(
              context.config.apiTokenPepper
            ),
            subjectUserId: user.id,
            boundary: authorizationBoundary
          });
        const embedding = await embedTeamSemanticQuery(
          input.query,
          context.internalServices.fetch
        );
        const semanticInput = {
          teamWorkspaceId: input.team_workspace_id,
          queryVector: embedding.vector,
          model: embedding.model,
          dimensions: embedding.dimensions,
          version: embedding.version,
          limit: input.limit,
          searchDomain: input.search_domain,
          sessionId: input.session_id,
          projectId: input.project_id,
          recentDays: input.recent_days,
          sourceAfter: input.source_after?.toISOString(),
          sourceBefore: input.source_before?.toISOString(),
          exactHints: input.exact_hints,
          representations: teamRepresentationsForStage(input.retrieval_stage),
          parentCandidateIds: input.parent_node_ids,
          authorizationBoundary
        };
        const scoreScan = input.retrieval_stage === "score_scan";
        const stageScans = scoreScan
          ? await repo.scanAuthorizedSharedMemorySemanticItems(
              { userId: user.id },
              semanticInput
            )
          : [];
        const candidates = scoreScan
          ? []
          : await repo.searchAuthorizedSharedMemorySemanticItems(
              { userId: user.id },
              { ...semanticInput, strictLimit: input.strict_limit }
            );
        const evidence = candidates.map((candidate) =>
          teamHit(candidate, true, input.parent_node_ids)
        );
        const candidateCount = scoreScan
          ? stageScans.reduce((sum, scan) => sum + scan.candidateCount, 0)
          : candidates.length;
        const stages = (
          [
            ["rollup_search", "lcm_rollups"],
            ["scoped_leaf_search", "lcm_leaves"],
            ["curated_memory_search", "curated_assertions"],
            ["fresh_pending_search", "memory_events"]
          ] as const
        ).map(([name, representation]) => {
          const selected = candidates.filter(
            (candidate) => candidate.representation === representation
          );
          const scan = stageScans.find(
            (candidate) => candidate.representation === representation
          );
          const ran = teamStageRan(input.retrieval_stage, name);
          return {
            name,
            ran,
            used:
              input.retrieval_stage !== "score_scan" &&
              ran &&
              selected.length > 0,
            candidateCount: ran ? (scan?.candidateCount ?? selected.length) : 0,
            selectedCount:
              input.retrieval_stage !== "score_scan" && ran
                ? selected.length
                : 0,
            durationMs: Math.max(0, performance.now() - retrievalStartedAt),
            parallelGroup: "team_shared_semantic_first_pass",
            topScore: scan?.topScore ?? selected[0]?.score,
            countAboveThreshold: ran
              ? (scan?.candidateCount ?? selected.length)
              : 0,
            maxAllowed: ran ? input.limit : 0
          };
        });
        const retrieval = {
          retrievalMode: "semantic_vector" as const,
          vectorHitsCount: candidateCount,
          textHitsCount: 0,
          embeddingModel: embedding.model,
          embeddingDimensions: embedding.dimensions,
          vectorCandidateCount: candidateCount,
          rerankedCount: 0,
          rerankerModel: null,
          rerankingEnabled: false,
          rerankingUnavailable: false,
          stages
        };
        const instructions =
          "Use only this authorized Team Shared Memory evidence. Treat stale evidence as historical and report uncertainty.";
        return {
          markdown: evidence.map((hit) => hit.summaryText).join("\n\n"),
          instructions,
          evidenceBundle: {
            query: input.query,
            instructions,
            evidence,
            retrieval
          },
          evidence,
          citations: evidence.map((hit) => hit.citation),
          rawHitsCount: candidateCount,
          lcmHitsCount: candidates.filter(
            (candidate) =>
              teamSourceType(candidate.representation) === "memory_node"
          ).length,
          retrieval,
          ...retrieval,
          expandedNodeIds: [],
          visibilityLabels: ["team"],
          memoryIndexVersion: "team-shared-semantic-v1",
          lcmVersion: "team-shared-semantic-v1",
          authorizationBoundary: authorizationBoundaryToken
        };
      }
      const result = await answerMemory({
        repository: repo,
        requesterContext: { userId: user.id },
        query: input.query,
        scope: input.retrieval_scope,
        searchDomain: input.search_domain,
        sessionId: input.session_id,
        projectId: input.project_id,
        limit: input.limit,
        recentDays: input.recent_days,
        sourceAfter: input.source_after?.toISOString(),
        sourceBefore: input.source_before?.toISOString(),
        exactHints: input.exact_hints,
        retrievalStage: input.retrieval_stage,
        parentNodeIds: input.parent_node_ids,
        strictLimit: input.strict_limit
      });
      const indexProof = retrievalIndexProof(
        await resolveRetrievalCapability({
          runtimeEmbeddingModel: context.config.embeddingModel,
          ownerUserId: user.id,
          runtimeIndexProof: (proofInput) =>
            repo.getRetrievalArenaIndexProof(proofInput)
        })
      );
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
        evidenceBundle: {
          ...result.evidenceBundle,
          retrieval: { ...result.evidenceBundle.retrieval, ...indexProof }
        },
        evidence: result.evidenceBundle.evidence,
        citations: result.citations,
        rawHitsCount: result.citations.length,
        lcmHitsCount: result.citations.length,
        retrieval: { ...result.evidenceBundle.retrieval, ...indexProof },
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
