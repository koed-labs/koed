import type pg from "pg";
import type { ExpandedMemoryNode } from "@koed/core";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import { createCuratedMemoryPolicyMethods } from "./curated-memory-policy.js";
import { createCuratedMemoryProposalTransitionMethods } from "./curated-memory-proposal-transitions.js";
import { createCuratedMemoryRecallMethods } from "./curated-memory-recall.js";
import { createCuratedMemoryRecordMethods } from "./curated-memory-records.js";
import { createCuratedMemorySourceReconciliationMethods } from "./curated-memory-source-reconciliation.js";
import { createCuratedMemoryClassificationMethods } from "./curated-memory-classification.js";
import { createCuratedMemorySourceEvidenceMethods } from "./curated-memory-source-evidence.js";
import { verifyCuratedMemorySourcesWithClient } from "./curated-memory-policy.js";
import {
  ENCRYPTED_CURATED_MEMORY_TEXT,
  hydrateProposalRow,
  mapProposal,
  persistCuratedMemoryPayload,
  proposalSelect,
  protectedCuratedMemoryPayloadsRequired,
  requireEncryptionProvider,
  type ProposalRow
} from "./curated-memory-support.js";
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
  CuratedMemorySearchInput
} from "./types.js";

export { suppressCuratedMemoryWithoutActiveEvidenceWithClient } from "./curated-memory-policy.js";

export interface CuratedMemoryRepository {
  resolveActivityDecisions(
    actor: ActorContext,
    projectId: string,
    assertionIds: readonly string[]
  ): Promise<
    Array<{
      assertionId: string;
      text: string;
      classificationVersion: number;
      updatedAt: string;
      at: string;
    }>
  >;
  hydrateCuratedProjectSourceEvidence(
    actor: ActorContext,
    input:
      | { sourceType: "project_source_note_revision"; sourceId: string }
      | { sourceType: "project_work_item"; sourceId: string }
  ): Promise<{
    sourceType: "project_source_note_revision" | "project_work_item";
    sourceId: string;
    projectId: string;
    text: string;
  } | null>;
  prepareCuratedClassification(
    actor: ActorContext,
    input: {
      assertionId: string;
      expectedVersion: number;
      scope: "me" | "project" | "unscoped";
      projectId?: string | null;
    }
  ): Promise<CuratedClassificationOperation>;
  listPendingCuratedClassifications(
    actor: ActorContext
  ): Promise<CuratedClassificationOperation[]>;
  listPendingCuratedClassificationWork(): Promise<
    CuratedClassificationOperation[]
  >;
  prepareLegacyCuratedActivationBatch(
    limit?: number
  ): Promise<CuratedClassificationOperation[]>;
  deferCuratedClassificationRetry(
    actor: ActorContext,
    operationId: string
  ): Promise<void>;
  recordCuratedClassificationAck(
    actor: ActorContext,
    operationId: string,
    backendId: string,
    sourceLogicalMemoryId: string,
    receipt: {
      mutationId: string;
      manifestHash: string;
      appliedVersion: number;
    },
    expectedManifestHash: string
  ): Promise<CuratedClassificationOperation>;
  commitCuratedClassification(
    actor: ActorContext,
    operationId: string
  ): Promise<CuratedClassificationOperation>;
  createCuratedMemoryProposal(
    actor: ActorContext,
    input: CuratedMemoryProposalInput
  ): Promise<CuratedMemoryProposalRecord>;
  createOnboardingPreferenceProposal(
    actor: ActorContext,
    input: { noteId: string; memoryEventId: string; claim: string }
  ): Promise<CuratedMemoryProposalRecord>;
  createDeckLearningProposal(
    actor: ActorContext,
    input: { noteId: string; memoryEventId: string; claim: string }
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
  getCuratedMemoryReplacementChain(
    actor: ActorContext,
    assertionId: string
  ): Promise<CuratedMemoryAssertionRecord[]>;
  searchCuratedMemoryAssertions(
    actor: ActorContext,
    input: CuratedMemorySearchInput
  ): Promise<CuratedMemoryAssertionRecord[]>;
  expandCuratedMemoryRetrieval(
    actor: ActorContext,
    assertionId: string
  ): Promise<ExpandedMemoryNode | null>;
  suppressCuratedMemoryAssertion(
    actor: ActorContext,
    assertionId: string,
    input: { reason?: string | null; status?: "suppressed" }
  ): Promise<CuratedMemoryAssertionRecord | null>;
  unsuppressCuratedMemoryAssertion(
    actor: ActorContext,
    assertionId: string,
    input: { suppressionToken: string }
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

export interface CuratedClassificationOperation {
  id: string;
  ownerUserId: string;
  assertionId: string;
  expectedVersion: number;
  nextVersion: number;
  scope: "me" | "project" | "unscoped";
  projectId: string | null;
  manifest: Array<{
    backendId: string;
    source: {
      kind: "captured_session";
      sessionId: string;
      logicalMemoryId: string;
    };
    items: Array<{ shareGrantId: string; pseudonymousSourceId: string }>;
  }>;
  backendAcks: Array<{
    backendId: string;
    logicalMemoryId: string;
    manifestHash: string;
  }>;
  state: "pending" | "ready" | "complete" | "conflict";
}

export interface CuratedMemoryRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  onCuratedMemoryChanged?: (
    actor: ActorContext,
    client: pg.PoolClient,
    assertionIds: readonly string[]
  ) => Promise<void>;
}

export const createCuratedMemoryRepository = (
  pool: pg.Pool,
  options: CuratedMemoryRepositoryOptions = {}
): CuratedMemoryRepository => {
  const context = {
    pool,
    envelopeEncryptionProvider: options.envelopeEncryptionProvider,
    onCuratedMemoryChanged: options.onCuratedMemoryChanged
  };
  const records = createCuratedMemoryRecordMethods(context);
  const createNoteEvidenceProposal = async (
    actor: ActorContext,
    input: { noteId: string; memoryEventId: string; claim: string },
    kind: "preference" | "learning"
  ): Promise<CuratedMemoryProposalRecord> => {
    // The Personal Note's event is the durable retry key. Keep the lock,
    // evidence check, and insert on one client so parallel retries cannot
    // consume the pool while waiting for each other.
    const client = await pool.connect();
    const lockKey = `personal-note-proposal:${actor.userId}:${input.memoryEventId}`;
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey]
      );
      const source = await client.query(
        `select 1 from personal_notes note
             join personal_note_revisions revision
               on revision.note_id=note.id
              and revision.owner_user_id=note.owner_user_id
              and revision.revision=note.current_revision
            where note.id=$1 and note.owner_user_id=$2
              and note.lifecycle='active'
              and revision.projection_state='available'
              and revision.forgotten_at is null
              and revision.memory_event_id=$3
            for share of note,revision`,
        [input.noteId, actor.userId, input.memoryEventId]
      );
      if (!source.rows[0])
        throw Object.assign(
          new Error("Current Personal Note evidence changed"),
          {
            statusCode: 409
          }
        );
      const existing = await client.query<ProposalRow>(
        `select ${proposalSelect} from curated_memory_proposals
            where owner_user_id=$1 and visibility='personal'
              and scope_hint='me' and kind_hint=$3
              and evidence_conversation_item_ids='{}'::uuid[]
              and evidence_memory_event_ids=array[$2::uuid]
            order by created_at limit 1`,
        [actor.userId, input.memoryEventId, kind]
      );
      if (existing.rows[0]) {
        const proposal = mapProposal(
          await hydrateProposalRow(
            client,
            actor,
            options.envelopeEncryptionProvider,
            existing.rows[0]
          )
        );
        if (
          kind === "learning" &&
          proposal.createdByPromptVersion !== "deck-first-again-v1"
        )
          throw Object.assign(
            new Error("Personal Note evidence has another proposal"),
            { statusCode: 409 }
          );
        if (proposal.proposedClaim !== input.claim)
          throw Object.assign(
            new Error("Personal Note evidence already has another proposal"),
            { statusCode: 409 }
          );
        await client.query("commit");
        return proposal;
      }
      await verifyCuratedMemorySourcesWithClient(client, actor, [
        {
          sourceType: "memory_event",
          sourceRole: "primary_evidence",
          memoryEventId: input.memoryEventId
        }
      ]);
      const protectPayload = protectedCuratedMemoryPayloadsRequired();
      if (protectPayload)
        requireEncryptionProvider(options.envelopeEncryptionProvider);
      const result = await client.query<ProposalRow>(
        `insert into curated_memory_proposals (
             owner_user_id, visibility, proposed_claim, scope_hint, kind_hint,
             evidence_conversation_item_ids, evidence_memory_event_ids, operation, tags,
             created_by_prompt_version
           ) values ($1, 'personal', $2, 'me', $4::curated_memory_kind, '{}'::uuid[],
             array[$3::uuid], 'store', case when $4::text='learning' then array['koed_deck_first_again']::text[] else '{}'::text[] end,
             case when $4::text='learning' then 'deck-first-again-v1' else null end) returning ${proposalSelect}`,
        [
          actor.userId,
          protectPayload ? ENCRYPTED_CURATED_MEMORY_TEXT : input.claim,
          input.memoryEventId,
          kind
        ]
      );
      const row = result.rows[0]!;
      if (protectPayload) {
        await persistCuratedMemoryPayload(
          client,
          actor,
          options.envelopeEncryptionProvider,
          {
            sourceTable: "curated_memory_proposals",
            sourceId: row.id,
            plaintext: {
              proposedClaim: input.claim,
              proposedTopic: null,
              rationale: null,
              tags: kind === "learning" ? ["koed_deck_first_again"] : [],
              expiresAt: null,
              decisionReason: null,
              workerResult: null
            }
          }
        );
      }
      const proposal = mapProposal(
        await hydrateProposalRow(
          client,
          actor,
          options.envelopeEncryptionProvider,
          row
        )
      );
      await client.query("commit");
      return proposal;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    ...records,
    createOnboardingPreferenceProposal: (actor, input) =>
      createNoteEvidenceProposal(actor, input, "preference"),
    createDeckLearningProposal: (actor, input) =>
      createNoteEvidenceProposal(actor, input, "learning"),
    ...createCuratedMemoryProposalTransitionMethods(context),
    ...createCuratedMemoryRecallMethods(context),
    ...createCuratedMemoryPolicyMethods(context),
    ...createCuratedMemorySourceReconciliationMethods(context),
    ...createCuratedMemorySourceEvidenceMethods(context),
    ...createCuratedMemoryClassificationMethods(context)
  };
};
