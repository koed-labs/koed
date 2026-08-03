import type pg from "pg";
import type { ExpandedMemoryNode } from "@koed/core";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import { createCuratedMemoryPolicyMethods } from "./curated-memory-policy.js";
import { createCuratedMemoryProposalTransitionMethods } from "./curated-memory-proposal-transitions.js";
import { createCuratedMemoryRecallMethods } from "./curated-memory-recall.js";
import { createCuratedMemoryRecordMethods } from "./curated-memory-records.js";
import { createCuratedMemorySourceReconciliationMethods } from "./curated-memory-source-reconciliation.js";
import type {
  ActorContext,
  CuratedMemoryAssertionRecord,
  CuratedMemoryCreateAssertionInput,
  CuratedMemoryExportRecords,
  CuratedMemoryListInput,
  CuratedMemoryProposalInput,
  CuratedMemoryProposalOperation,
  CuratedMemoryProposalRecord,
  CuratedMemoryReviewBundle,
  CuratedMemoryProposalStatus,
  CuratedMemoryProposalUserEvidenceResult,
  CuratedMemoryReconciliationResult,
  CuratedMemoryResolvedEvidence,
  CuratedMemoryRetrievalCandidate,
  CuratedMemorySearchInput
} from "./types.js";

export { suppressCuratedMemoryWithoutActiveEvidenceWithClient } from "./curated-memory-policy.js";

export interface CuratedMemoryRepository {
  createCuratedMemoryProposal(
    actor: ActorContext,
    input: CuratedMemoryProposalInput
  ): Promise<CuratedMemoryProposalRecord>;
  listCuratedMemoryProposals(
    actor: ActorContext,
    input?: { status?: CuratedMemoryProposalStatus; limit?: number }
  ): Promise<CuratedMemoryProposalRecord[]>;
  getCuratedMemoryProposal(
    actor: ActorContext,
    proposalId: string
  ): Promise<CuratedMemoryProposalRecord | null>;
  getCuratedMemoryProposalUserEvidenceSources(
    actor: ActorContext,
    proposalId: string
  ): Promise<CuratedMemoryProposalUserEvidenceResult>;
  claimPendingCuratedMemoryProposals(
    actor: ActorContext,
    input?: { proposalId?: string; limit?: number; leaseSeconds?: number }
  ): Promise<CuratedMemoryReviewBundle[]>;
  releaseCuratedMemoryProposalReview(
    actor: ActorContext,
    proposalId: string,
    input: { attemptCount: number; lastErrorMessage: string }
  ): Promise<CuratedMemoryProposalRecord | null>;
  resolveCuratedMemoryProposalEvidence(
    actor: ActorContext,
    input: { projectId?: string; sessionId?: string; exactQuote?: string }
  ): Promise<CuratedMemoryResolvedEvidence>;
  processCuratedMemoryProposal(
    actor: ActorContext,
    input: {
      proposalId: string;
      decision: CuratedMemoryProposalOperation | "skip";
      targetAssertionId?: string | null;
      expectedAttemptCount?: number;
      evidenceRevisions?: Array<{
        sourceType: "conversation_item" | "memory_event";
        sourceId: string;
        sourceHash: string;
      }>;
      selectedEvidenceIds?: string[];
      candidateAssertionIds?: string[];
      assertion?: CuratedMemoryCreateAssertionInput;
      decisionReason?: string | null;
      workerResult?: Record<string, unknown>;
    }
  ): Promise<CuratedMemoryProposalRecord>;
  listCuratedMemoryAssertions(
    actor: ActorContext,
    input?: CuratedMemoryListInput
  ): Promise<CuratedMemoryAssertionRecord[]>;
  getCuratedMemoryAssertion(
    actor: ActorContext,
    assertionId: string
  ): Promise<CuratedMemoryAssertionRecord | null>;
  searchCuratedMemoryAssertions(
    actor: ActorContext,
    input: CuratedMemorySearchInput
  ): Promise<CuratedMemoryAssertionRecord[]>;
  searchCuratedMemoryRetrievalCandidates(
    actor: ActorContext,
    input: CuratedMemorySearchInput
  ): Promise<CuratedMemoryRetrievalCandidate[]>;
  expandCuratedMemoryRetrieval(
    actor: ActorContext,
    assertionId: string
  ): Promise<ExpandedMemoryNode | null>;
  suppressCuratedMemoryAssertion(
    actor: ActorContext,
    assertionId: string,
    input: { reason?: string | null; status?: "suppressed" }
  ): Promise<CuratedMemoryAssertionRecord | null>;
  reconcileCuratedMemorySources(
    actor: ActorContext,
    input?: { limit?: number }
  ): Promise<CuratedMemoryReconciliationResult>;
  reconcileCuratedMemoryLifecycle(
    actor: ActorContext
  ): Promise<{ assertionsSuppressed: number }>;
  exportCuratedMemoryRecords(
    actor: ActorContext
  ): Promise<CuratedMemoryExportRecords>;
}

export interface CuratedMemoryRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

export const createCuratedMemoryRepository = (
  pool: pg.Pool,
  options: CuratedMemoryRepositoryOptions = {}
): CuratedMemoryRepository => {
  const context = {
    pool,
    envelopeEncryptionProvider: options.envelopeEncryptionProvider
  };
  return {
    ...createCuratedMemoryRecordMethods(context),
    ...createCuratedMemoryProposalTransitionMethods(context),
    ...createCuratedMemoryRecallMethods(context),
    ...createCuratedMemoryPolicyMethods(context),
    ...createCuratedMemorySourceReconciliationMethods(context)
  };
};
