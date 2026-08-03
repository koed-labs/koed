import type { FastifyInstance } from "fastify";
import type { CuratedMemorySourceRole } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import {
  curatedMemoryAssertionParamsSchema,
  curatedMemoryClaimSchema,
  curatedMemoryListQuerySchema,
  curatedMemoryProposalQuerySchema,
  curatedMemoryProposalParamsSchema,
  curatedMemoryProposalSchema,
  curatedMemoryReviewResultSchema,
  curatedMemoryReconcileSchema,
  curatedMemorySearchQuerySchema,
  curatedMemorySuppressSchema
} from "./curated-memory-schemas.js";

export const registerCuratedMemoryRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateApiToken },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryRecall: memoryRecallRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  app.post(
    "/v1/memory/curated/proposals",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = curatedMemoryProposalSchema.parse(request.body);
      const resolvedEvidence =
        input.evidence_conversation_item_ids.length === 0 &&
        input.evidence_memory_event_ids.length === 0
          ? await repo.resolveCuratedMemoryProposalEvidence(
              { userId: user.id },
              {
                projectId: input.source_project_id,
                sessionId: input.source_session_id,
                exactQuote: input.evidence_exact_quote
              }
            )
          : null;
      const proposal = await repo.createCuratedMemoryProposal(
        { userId: user.id },
        {
          proposedClaim: input.proposed_claim,
          proposedTopic: input.proposed_topic,
          rationale: input.rationale,
          tags: input.tags,
          sensitivityHint: input.sensitivity_hint,
          expiresAt: input.expires_at,
          evidenceConversationItemIds:
            resolvedEvidence?.evidenceConversationItemIds ??
            input.evidence_conversation_item_ids,
          evidenceMemoryEventIds:
            resolvedEvidence?.evidenceMemoryEventIds ??
            input.evidence_memory_event_ids,
          operation: input.operation,
          targetAssertionId: input.target_assertion_id ?? null,
          createdByModel: input.created_by_model,
          createdByPromptVersion: input.created_by_prompt_version
        }
      );
      const intake = {
        queued: true,
        inline: false,
        queue: "local_agent_review",
        proposalId: proposal.id
      };
      return { proposal, intake };
    }
  );

  app.post(
    "/v1/memory/curated/proposals/claim-pending",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = curatedMemoryClaimSchema.parse(request.body ?? {});
      const reviews = await repo.claimPendingCuratedMemoryProposals(
        { userId: user.id },
        {
          proposalId: input.proposal_id,
          limit: input.limit,
          leaseSeconds: input.lease_seconds
        }
      );
      return { reviews, count: reviews.length };
    }
  );

  app.patch(
    "/v1/memory/curated/proposals/:proposalId/review",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = curatedMemoryProposalParamsSchema.parse(request.params);
      const input = curatedMemoryReviewResultSchema.parse(request.body);
      if (input.outcome === "retry") {
        const proposal = await repo.releaseCuratedMemoryProposalReview(
          { userId: user.id },
          params.proposalId,
          {
            attemptCount: input.attempt_count,
            lastErrorMessage: input.error_message
          }
        );
        return proposal
          ? { proposal }
          : reply
              .status(409)
              .send({ error: "Curated Memory review lease is stale" });
      }
      const evidenceRevisions = input.evidence_revisions.map((revision) => ({
        sourceType: revision.source_type,
        sourceId: revision.source_id,
        sourceHash: revision.source_hash
      }));
      if (input.outcome === "rejected") {
        const proposal = await repo.processCuratedMemoryProposal(
          { userId: user.id },
          {
            proposalId: params.proposalId,
            decision: "skip",
            expectedAttemptCount: input.attempt_count,
            evidenceRevisions,
            selectedEvidenceIds: input.selected_evidence_ids,
            candidateAssertionIds: input.candidate_assertion_ids,
            decisionReason: input.decision_reason,
            workerResult: input.worker_result
          }
        );
        return { proposal };
      }

      const proposalRecord = await repo.getCuratedMemoryProposal(
        { userId: user.id },
        params.proposalId
      );
      if (!proposalRecord) {
        return reply
          .status(404)
          .send({ error: "Curated Memory proposal not found" });
      }
      const sensitivityRank = {
        normal: 0,
        sensitive: 1,
        review_required: 2
      } as const;
      const policyRejectionReason =
        proposalRecord.sensitivityHint === "review_required" ||
        input.sensitivity === "review_required"
          ? "Curated Memory requires explicit user review"
          : proposalRecord.sensitivityHint &&
              sensitivityRank[input.sensitivity] <
                sensitivityRank[proposalRecord.sensitivityHint]
            ? "Curated Memory reviewer cannot lower proposed sensitivity"
            : proposalRecord.expiresAt &&
                (!input.expires_at ||
                  Date.parse(input.expires_at) >
                    Date.parse(proposalRecord.expiresAt))
              ? "Curated Memory reviewer cannot remove or extend proposed expiry"
              : null;
      if (policyRejectionReason) {
        const proposal = await repo.processCuratedMemoryProposal(
          { userId: user.id },
          {
            proposalId: params.proposalId,
            decision: "skip",
            expectedAttemptCount: input.attempt_count,
            evidenceRevisions,
            selectedEvidenceIds: input.selected_evidence_ids,
            candidateAssertionIds: input.candidate_assertion_ids,
            decisionReason: policyRejectionReason,
            workerResult: {
              ...(input.worker_result ?? {}),
              policyRejected: true
            }
          }
        );
        return { proposal };
      }
      const sourceRole: CuratedMemorySourceRole =
        input.operation === "merge"
          ? "supporting_evidence"
          : input.operation === "supersede"
            ? "superseding_evidence"
            : input.operation === "conflict"
              ? "conflicting_evidence"
              : "primary_evidence";
      const selectedEvidenceIds = new Set(input.selected_evidence_ids);
      const proposal = await repo.processCuratedMemoryProposal(
        { userId: user.id },
        {
          proposalId: params.proposalId,
          decision: input.operation,
          targetAssertionId: input.target_assertion_id,
          expectedAttemptCount: input.attempt_count,
          evidenceRevisions,
          selectedEvidenceIds: input.selected_evidence_ids,
          candidateAssertionIds: input.candidate_assertion_ids,
          decisionReason: input.decision_reason,
          workerResult: input.worker_result,
          assertion: {
            assertionText: input.assertion_text,
            topicTitle: input.topic_title,
            tags: input.tags,
            sensitivity: input.sensitivity,
            confidence: input.confidence,
            expiresAt: input.expires_at,
            metadata: { proposalId: proposalRecord.id },
            sources: [
              ...proposalRecord.evidenceConversationItemIds
                .filter((id) => selectedEvidenceIds.has(id))
                .map((conversationItemId) => ({
                  sourceType: "conversation_item" as const,
                  sourceRole,
                  conversationItemId
                })),
              ...proposalRecord.evidenceMemoryEventIds
                .filter((id) => selectedEvidenceIds.has(id))
                .map((memoryEventId) => ({
                  sourceType: "memory_event" as const,
                  sourceRole,
                  memoryEventId
                }))
            ],
            createdByModel: input.reviewer_model,
            createdByPromptVersion: input.reviewer_prompt_version
          }
        }
      );
      return { proposal };
    }
  );

  app.get(
    "/v1/memory/curated/proposals",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = curatedMemoryProposalQuerySchema.parse(request.query);
      const proposals = await repo.listCuratedMemoryProposals(
        { userId: user.id },
        query
      );
      return { proposals, count: proposals.length };
    }
  );

  app.get(
    "/v1/memory/curated/assertions",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = curatedMemoryListQuerySchema.parse(request.query);
      const assertions = await repo.listCuratedMemoryAssertions(
        { userId: user.id },
        {
          status: query.status,
          topicId: query.topic_id,
          includeSources: query.include_sources,
          limit: query.limit
        }
      );
      return { assertions, count: assertions.length };
    }
  );

  app.post(
    "/v1/memory/curated/search",
    { preHandler: memoryRecallRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = curatedMemorySearchQuerySchema.parse(request.body);
      const assertions = await repo.searchCuratedMemoryAssertions(
        { userId: user.id },
        {
          query: input.query,
          searchDomain: input.search_domain,
          sessionId: input.session_id,
          projectId: input.project_id,
          currentOnly: input.current_only,
          limit: input.limit
        }
      );
      return { assertions, count: assertions.length };
    }
  );

  app.get(
    "/v1/memory/curated/assertions/:assertionId",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = curatedMemoryAssertionParamsSchema.parse(request.params);
      const assertion = await repo.getCuratedMemoryAssertion(
        { userId: user.id },
        params.assertionId
      );
      return assertion
        ? { assertion }
        : reply.status(404).send({ error: "Curated Memory not found" });
    }
  );

  app.post(
    "/v1/memory/curated/assertions/:assertionId/suppress",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = curatedMemoryAssertionParamsSchema.parse(request.params);
      const input = curatedMemorySuppressSchema.parse(request.body);
      const assertion = await repo.suppressCuratedMemoryAssertion(
        { userId: user.id },
        params.assertionId,
        {
          status: input.status,
          reason: input.reason
        }
      );
      return assertion
        ? { assertion }
        : reply.status(404).send({ error: "Curated Memory not found" });
    }
  );

  app.post(
    "/v1/memory/curated/reconcile",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = curatedMemoryReconcileSchema.parse(request.body ?? {});
      const reconciliation = await repo.reconcileCuratedMemorySources(
        { userId: user.id },
        input
      );
      return { reconciliation };
    }
  );
};
