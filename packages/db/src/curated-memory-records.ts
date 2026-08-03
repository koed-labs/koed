import { codexIdePromptUserText } from "@koed/core";
import { CURATED_MEMORY_REVIEW_MAX_EVIDENCE } from "@koed/shared";
import { decryptAuthorizedEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
import type { CuratedMemoryRepository } from "./curated-memory-repository.js";
import {
  activeCuratedMemoryEvidencePredicate,
  verifyCuratedMemorySourcesWithClient
} from "./curated-memory-policy.js";
import {
  ENCRYPTED_CURATED_MEMORY_TEXT,
  assertionSelect,
  dedupeStrings,
  getAssertionByIdWithClient,
  hydrateAssertionRow,
  hydrateProposalRow,
  hydrateTopicRow,
  loadSources,
  mapAssertion,
  mapProposal,
  mapTopic,
  positiveLimit,
  persistCuratedMemoryPayload,
  proposalSelect,
  protectedCuratedMemoryPayloadsRequired,
  recordValue,
  requireEncryptionProvider,
  visibilityError,
  type AssertionRow,
  type CuratedMemoryRepositoryContext,
  type ProposalRow,
  type TopicRow
} from "./curated-memory-support.js";
import type {
  CuratedMemoryReviewEvidence,
  CuratedMemorySourceInput,
  CuratedMemorySourceRecord
} from "./types.js";

export const createCuratedMemoryRecordMethods = ({
  pool,
  envelopeEncryptionProvider
}: CuratedMemoryRepositoryContext): Pick<
  CuratedMemoryRepository,
  | "createCuratedMemoryProposal"
  | "listCuratedMemoryProposals"
  | "getCuratedMemoryProposal"
  | "resolveCuratedMemoryProposalEvidence"
  | "getCuratedMemoryProposalUserEvidenceSources"
  | "claimPendingCuratedMemoryProposals"
  | "releaseCuratedMemoryProposalReview"
  | "exportCuratedMemoryRecords"
  | "listCuratedMemoryAssertions"
  | "getCuratedMemoryAssertion"
> => ({
  async createCuratedMemoryProposal(actor, input) {
    const proposedClaim = input.proposedClaim.trim();
    if (!proposedClaim) {
      throw new Error("Curated Memory proposal claim is required");
    }
    const evidenceConversationItemIds = [
      ...new Set(input.evidenceConversationItemIds ?? [])
    ];
    const evidenceMemoryEventIds = [
      ...new Set(input.evidenceMemoryEventIds ?? [])
    ];
    if (
      evidenceConversationItemIds.length + evidenceMemoryEventIds.length >
      CURATED_MEMORY_REVIEW_MAX_EVIDENCE
    ) {
      throw Object.assign(
        new Error(
          `Curated Memory proposal accepts at most ${CURATED_MEMORY_REVIEW_MAX_EVIDENCE} evidence sources`
        ),
        { statusCode: 400 }
      );
    }
    const operation = input.operation ?? "store";
    const targetAssertionId = input.targetAssertionId ?? null;
    if (
      evidenceConversationItemIds.length === 0 &&
      evidenceMemoryEventIds.length === 0
    ) {
      throw new Error("Curated Memory proposal requires source evidence");
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await verifyCuratedMemorySourcesWithClient(client, actor, [
        ...evidenceConversationItemIds.map((conversationItemId) => ({
          sourceType: "conversation_item" as const,
          sourceRole: "primary_evidence" as const,
          conversationItemId
        })),
        ...evidenceMemoryEventIds.map((memoryEventId) => ({
          sourceType: "memory_event" as const,
          sourceRole: "primary_evidence" as const,
          memoryEventId
        }))
      ]);
      if (targetAssertionId) {
        const target = await client.query<{ id: string }>(
          `
            select id
            from curated_memory_assertions
            where id = $1
              and owner_user_id = $2
              and visibility = 'personal'
              and status = 'current'
              and suppressed_at is null
              and (expires_at is null or expires_at > now())
              and ${activeCuratedMemoryEvidencePredicate("curated_memory_assertions")}
          `,
          [targetAssertionId, actor.userId]
        );
        if (!target.rows[0]) {
          throw visibilityError(
            "Curated Memory target assertion not found or not current"
          );
        }
      }
      const protectPayload = protectedCuratedMemoryPayloadsRequired();
      if (protectPayload) {
        requireEncryptionProvider(envelopeEncryptionProvider);
      }
      const result = await client.query<ProposalRow>(
        `
        insert into curated_memory_proposals (
          owner_user_id,
          visibility,
          proposed_claim,
          proposed_topic,
          rationale,
          tags,
          sensitivity_hint,
          expires_at_hint,
          evidence_conversation_item_ids,
          evidence_memory_event_ids,
          operation,
          target_assertion_id,
          created_by_model,
          created_by_prompt_version
        )
        values (
          $1,
          'personal',
          $2,
          $3,
          $4,
          $5::text[],
          $6,
          $7,
          $8::uuid[],
          $9::uuid[],
          $10::curated_memory_proposal_operation,
          $11::uuid,
          $12,
          $13
        )
        returning ${proposalSelect}
        `,
        [
          actor.userId,
          protectPayload ? ENCRYPTED_CURATED_MEMORY_TEXT : proposedClaim,
          protectPayload ? null : input.proposedTopic?.trim() || null,
          protectPayload ? null : input.rationale?.trim() || null,
          protectPayload ? [] : dedupeStrings(input.tags),
          input.sensitivityHint ?? null,
          input.expiresAt ?? null,
          evidenceConversationItemIds,
          evidenceMemoryEventIds,
          operation,
          targetAssertionId,
          input.createdByModel ?? null,
          input.createdByPromptVersion ?? null
        ]
      );
      const row = result.rows[0]!;
      if (protectPayload) {
        await persistCuratedMemoryPayload(
          client,
          actor,
          envelopeEncryptionProvider,
          {
            sourceTable: "curated_memory_proposals",
            sourceId: row.id,
            plaintext: {
              proposedClaim,
              proposedTopic: input.proposedTopic?.trim() || null,
              rationale: input.rationale?.trim() || null,
              tags: dedupeStrings(input.tags),
              expiresAt: input.expiresAt ?? null,
              decisionReason: null,
              workerResult: null
            }
          }
        );
      }
      const hydrated = await hydrateProposalRow(
        client,
        actor,
        envelopeEncryptionProvider,
        row
      );
      await client.query("commit");
      return mapProposal(hydrated);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async listCuratedMemoryProposals(actor, input = {}) {
    const result = await pool.query<ProposalRow>(
      `
        select ${proposalSelect}
        from curated_memory_proposals
        where owner_user_id = $1
          and visibility = 'personal'
          and ($2::text is null or status = $2::curated_memory_proposal_status)
        order by created_at desc, id desc
        limit $3
      `,
      [actor.userId, input.status ?? null, positiveLimit(input.limit)]
    );
    return Promise.all(
      result.rows.map(async (row) =>
        mapProposal(
          await hydrateProposalRow(pool, actor, envelopeEncryptionProvider, row)
        )
      )
    );
  },

  async getCuratedMemoryProposal(actor, proposalId) {
    const result = await pool.query<ProposalRow>(
      `
        select ${proposalSelect}
        from curated_memory_proposals
        where id = $1
          and owner_user_id = $2
          and visibility = 'personal'
      `,
      [proposalId, actor.userId]
    );
    return result.rows[0]
      ? mapProposal(
          await hydrateProposalRow(
            pool,
            actor,
            envelopeEncryptionProvider,
            result.rows[0]
          )
        )
      : null;
  },

  async resolveCuratedMemoryProposalEvidence(actor, input) {
    const exactQuote = input.exactQuote?.trim() || null;
    if (!input.sessionId && !exactQuote) {
      throw Object.assign(
        new Error(
          "Curated Memory evidence resolution requires source_session_id or an exact user quote"
        ),
        { statusCode: 400 }
      );
    }
    const normalizeEvidenceText = (value: string): string =>
      codexIdePromptUserText(value).trim().replace(/\r\n/g, "\n");
    const normalizedQuote = exactQuote
      ? normalizeEvidenceText(exactQuote)
      : null;
    const conversationItems = await pool.query<{
      id: string;
      raw_json: unknown;
      raw_text: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        select ci.id, ci.raw_json, ci.raw_text, ci.metadata
        from conversation_items ci
        left join sessions s on s.id = ci.session_id
        where ci.owner_user_id = $1
          and ci.visibility = 'personal'
          and ci.personal_deleted_at is null
          and ci.memory_excluded_at is null
          and (ci.source_event_type in ('user_message', 'UserPromptSubmit')
            or ci.metadata ->> 'transcriptType' = 'user_message')
          and ($2::uuid is null or ci.session_id = $2)
          and ($3::text is null or s.cwd = $3)
        order by coalesce(ci.event_time, ci.observed_at, ci.created_at) desc, ci.id desc
        limit $4
      `,
      [
        actor.userId,
        input.sessionId ?? null,
        input.projectId ?? null,
        normalizedQuote ? null : 1
      ]
    );
    const matchingConversationItemIds: string[] = [];
    for (const row of conversationItems.rows) {
      const encryptedColumns = Array.isArray(
        row.metadata?.encryptedConversationItemColumns
      )
        ? row.metadata.encryptedConversationItemColumns.filter(
            (column): column is string => typeof column === "string"
          )
        : [];
      const decryptColumn = async (sourceColumn: "raw_json" | "raw_text") =>
        (
          await decryptAuthorizedEncryptedFieldPayloadWithClient(
            pool,
            actor,
            requireEncryptionProvider(envelopeEncryptionProvider),
            {
              sourceTable: "conversation_items",
              sourceId: row.id,
              sourceColumn
            }
          )
        )?.plaintext;
      const rawMarker = recordValue(row.raw_json, null);
      const rawJson =
        encryptedColumns.includes("raw_json") ||
        (rawMarker?.contentEncrypted === true &&
          rawMarker.encryptedSourceTable === "conversation_items")
          ? await decryptColumn("raw_json")
          : row.raw_json;
      const rawText = encryptedColumns.includes("raw_text")
        ? await decryptColumn("raw_text")
        : row.raw_text;
      const rawRecord = recordValue(rawJson, null);
      const payload = recordValue(rawRecord?.payload, rawRecord);
      const text =
        (typeof rawText === "string" && rawText.trim()) ||
        (typeof payload?.content === "string" && payload.content.trim()) ||
        "";
      if (!normalizedQuote || normalizeEvidenceText(text) === normalizedQuote) {
        matchingConversationItemIds.push(row.id);
      }
    }
    if (matchingConversationItemIds.length > 1) {
      throw Object.assign(
        new Error(
          "Curated Memory exact quote matched multiple conversation items; source_session_id or explicit evidence IDs are required"
        ),
        { statusCode: 409 }
      );
    }
    if (matchingConversationItemIds[0]) {
      return {
        evidenceConversationItemIds: [matchingConversationItemIds[0]],
        evidenceMemoryEventIds: []
      };
    }

    const memoryEvents = await pool.query<{
      id: string;
      payload: Record<string, unknown>;
    }>(
      `
        select me.id, me.payload
        from memory_events me
        left join encrypted_field_payloads encrypted
          on encrypted.owner_user_id = me.owner_user_id
          and encrypted.visibility = 'personal'
          and encrypted.encryption_scope = 'personal'
          and encrypted.source_table = 'memory_events'
          and encrypted.source_id = me.id
          and encrypted.source_column = 'payload'
          and encrypted.invalidated_at is null
        where me.owner_user_id = $1
          and me.visibility = 'personal'
          and me.invalidated_at is null
          and me.personal_deleted_at is null
          and ($2::uuid is null or me.session_id = $2)
          and (
            $3::text is null
            or me.payload ->> 'projectId' = $3
            or (
              me.payload ->> 'contentEncrypted' = 'true'
              and encrypted.scope ->> 'projectId' = $3
            )
          )
          and (
            me.payload ->> 'actor' = 'user'
            or (
              me.payload ->> 'contentEncrypted' = 'true'
              and encrypted.aad ->> 'actor' = 'user'
            )
          )
        order by me.captured_at desc, me.id desc
        limit $4
      `,
      [
        actor.userId,
        input.sessionId ?? null,
        input.projectId ?? null,
        normalizedQuote ? null : 1
      ]
    );
    const matchingMemoryEventIds: string[] = [];
    for (const memoryEvent of memoryEvents.rows) {
      let payload = memoryEvent.payload;
      if (payload.contentEncrypted === true) {
        const decrypted =
          await decryptAuthorizedEncryptedFieldPayloadWithClient(
            pool,
            actor,
            requireEncryptionProvider(envelopeEncryptionProvider),
            {
              sourceTable: "memory_events",
              sourceId: memoryEvent.id,
              sourceColumn: "payload"
            }
          );
        payload = recordValue(decrypted?.plaintext, null) ?? {};
      }
      if (
        payload.actor !== "user" ||
        (input.projectId !== undefined && payload.projectId !== input.projectId)
      ) {
        throw new Error(
          "Curated Memory evidence metadata did not match its authenticated payload"
        );
      }
      const content =
        typeof payload.content === "string" ? payload.content : "";
      if (
        !normalizedQuote ||
        normalizeEvidenceText(content) === normalizedQuote
      ) {
        matchingMemoryEventIds.push(memoryEvent.id);
      }
    }
    if (matchingMemoryEventIds.length > 1) {
      throw Object.assign(
        new Error(
          "Curated Memory exact quote matched multiple Memory Events; source_session_id or explicit evidence IDs are required"
        ),
        { statusCode: 409 }
      );
    }
    if (matchingMemoryEventIds[0]) {
      return {
        evidenceConversationItemIds: [],
        evidenceMemoryEventIds: [matchingMemoryEventIds[0]]
      };
    }
    throw Object.assign(
      new Error("No current user evidence was found in the supplied scope"),
      { statusCode: 404 }
    );
  },

  async getCuratedMemoryProposalUserEvidenceSources(actor, proposalId) {
    const proposalResult = await pool.query<{
      evidence_conversation_item_ids: string[];
      evidence_memory_event_ids: string[];
    }>(
      `
        select evidence_conversation_item_ids, evidence_memory_event_ids
        from curated_memory_proposals
        where id = $1
          and owner_user_id = $2
          and visibility = 'personal'
      `,
      [proposalId, actor.userId]
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) {
      return { sources: [], evidence: [], rejectedSourceCount: 0 };
    }

    const conversationItems = await pool.query<{
      id: string;
      raw_text: string | null;
      metadata: Record<string, unknown> | null;
      source_hash: string;
      session_id: string | null;
      occurred_at: Date;
      source_event_type: string | null;
      source_order: number;
    }>(
      `
        select ci.id, ci.raw_text, ci.metadata, ci.source_hash, ci.session_id,
          coalesce(ci.event_time, ci.observed_at, ci.created_at) as occurred_at,
          ci.source_event_type,
          evidence.source_order::integer as source_order
        from unnest($2::uuid[]) with ordinality as evidence(id, source_order)
        join conversation_items ci
          on ci.id = evidence.id
          and ci.owner_user_id = $1
          and ci.visibility = 'personal'
          and ci.personal_deleted_at is null
          and ci.memory_excluded_at is null
        where ci.source_event_type in ('user_message', 'UserPromptSubmit')
           or ci.metadata ->> 'transcriptType' = 'user_message'
        order by evidence.source_order asc
      `,
      [actor.userId, proposal.evidence_conversation_item_ids]
    );
    const memoryEvents = await pool.query<{
      id: string;
      payload: Record<string, unknown>;
      source_hash: string | null;
      session_id: string | null;
      occurred_at: Date;
      updated_at: Date;
      source_order: number;
    }>(
      `
        select me.id, me.payload, me.source_hash, me.session_id,
          coalesce(me.source_event_time, me.captured_at, me.created_at) as occurred_at,
          me.updated_at,
          (evidence.source_order + cardinality($2::uuid[]))::integer as source_order
        from unnest($3::uuid[]) with ordinality as evidence(id, source_order)
        join memory_events me
          on me.id = evidence.id
          and me.owner_user_id = $1
          and me.visibility = 'personal'
          and me.invalidated_at is null
          and me.personal_deleted_at is null
        order by evidence.source_order asc
      `,
      [
        actor.userId,
        proposal.evidence_conversation_item_ids,
        proposal.evidence_memory_event_ids
      ]
    );
    const accepted: Array<{
      source: CuratedMemorySourceInput;
      evidence: CuratedMemoryReviewEvidence;
      order: number;
    }> = [];
    for (const row of conversationItems.rows) {
      let text = row.raw_text?.trim() ?? "";
      const encryptedColumns = Array.isArray(
        row.metadata?.encryptedConversationItemColumns
      )
        ? row.metadata.encryptedConversationItemColumns
        : [];
      if (encryptedColumns.includes("raw_text")) {
        const decrypted =
          await decryptAuthorizedEncryptedFieldPayloadWithClient(
            pool,
            actor,
            requireEncryptionProvider(envelopeEncryptionProvider),
            {
              sourceTable: "conversation_items",
              sourceId: row.id,
              sourceColumn: "raw_text"
            }
          );
        text =
          typeof decrypted?.plaintext === "string"
            ? decrypted.plaintext.trim()
            : "";
      }
      if (text) {
        accepted.push({
          source: {
            sourceType: "conversation_item",
            sourceRole: "primary_evidence",
            conversationItemId: row.id
          },
          evidence: {
            sourceType: "conversation_item",
            sourceId: row.id,
            sourceHash: row.source_hash,
            text,
            occurredAt: row.occurred_at.toISOString(),
            sessionId: row.session_id,
            metadata: {
              sourceEventType: row.source_event_type
            }
          },
          order: row.source_order
        });
      }
    }
    for (const row of memoryEvents.rows) {
      let payload = row.payload;
      if (payload.contentEncrypted === true) {
        const decrypted =
          await decryptAuthorizedEncryptedFieldPayloadWithClient(
            pool,
            actor,
            requireEncryptionProvider(envelopeEncryptionProvider),
            {
              sourceTable: "memory_events",
              sourceId: row.id,
              sourceColumn: "payload"
            }
          );
        payload = recordValue(decrypted?.plaintext, null) ?? {};
      }
      const text =
        payload.actor === "user" && typeof payload.content === "string"
          ? payload.content.trim()
          : "";
      if (text) {
        accepted.push({
          source: {
            sourceType: "memory_event",
            sourceRole: "primary_evidence",
            memoryEventId: row.id
          },
          evidence: {
            sourceType: "memory_event",
            sourceId: row.id,
            sourceHash:
              row.source_hash ?? `${row.id}:${row.updated_at.toISOString()}`,
            text,
            occurredAt: row.occurred_at.toISOString(),
            sessionId: row.session_id,
            metadata: {
              sealReason:
                typeof payload.sealReason === "string"
                  ? payload.sealReason
                  : undefined
            }
          },
          order: row.source_order
        });
      }
    }
    accepted.sort((left, right) => left.order - right.order);
    return {
      sources: accepted.map((item) => item.source),
      evidence: accepted.map((item) => item.evidence),
      rejectedSourceCount:
        proposal.evidence_conversation_item_ids.length +
        proposal.evidence_memory_event_ids.length -
        accepted.length
    };
  },

  async claimPendingCuratedMemoryProposals(actor, input = {}) {
    const leaseSeconds = Math.min(
      Math.max(input.leaseSeconds ?? 180, 30),
      3600
    );
    const client = await pool.connect();
    let claimedRows: ProposalRow[];
    try {
      await client.query("begin");
      const claimed = await client.query<ProposalRow>(
        `
          with candidates as (
            select id
            from curated_memory_proposals
            where owner_user_id = $1
              and visibility = 'personal'
              and status = 'pending'
              and ($2::uuid is null or id = $2)
              and (
                processing_lease_until is null
                or processing_lease_until < now()
              )
            order by created_at asc, id asc
            for update skip locked
            limit $3
          )
          update curated_memory_proposals proposal
          set processing_started_at = now(),
              processing_lease_until = now() + ($4::int * interval '1 second'),
              attempt_count = proposal.attempt_count + 1,
              last_error_message = null,
              updated_at = now()
          from candidates
          where proposal.id = candidates.id
          returning proposal.*
        `,
        [
          actor.userId,
          input.proposalId ?? null,
          positiveLimit(input.limit, 5),
          leaseSeconds
        ]
      );
      claimedRows = claimed.rows;
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    return Promise.all(
      claimedRows.map(async (row) => {
        const proposal = mapProposal(
          await hydrateProposalRow(pool, actor, envelopeEncryptionProvider, row)
        );
        const evidenceResult =
          await this.getCuratedMemoryProposalUserEvidenceSources(
            actor,
            proposal.id
          );
        const candidates = await pool.query<AssertionRow>(
          `
            select ${assertionSelect}
            from curated_memory_assertions cma
            left join curated_memory_topics cmt on cmt.id = cma.topic_id
            where cma.owner_user_id = $1
              and cma.visibility = 'personal'
              and cma.status = 'current'
              and cma.suppressed_at is null
              and (cma.expires_at is null or cma.expires_at > now())
              and ${activeCuratedMemoryEvidencePredicate("cma")}
            order by (cma.id = $2::uuid) desc, cma.updated_at desc, cma.id desc
            limit 20
          `,
          [actor.userId, proposal.targetAssertionId]
        );
        return {
          proposal,
          evidence: evidenceResult.evidence,
          rejectedSourceCount: evidenceResult.rejectedSourceCount,
          currentAssertions: await Promise.all(
            candidates.rows.map(async (candidate) => {
              const assertion = mapAssertion(
                await hydrateAssertionRow(
                  pool,
                  actor,
                  envelopeEncryptionProvider,
                  candidate
                )
              );
              return {
                assertionId: assertion.id,
                assertionText: assertion.assertionText,
                topicTitle: assertion.topicTitle,
                tags: assertion.tags,
                sensitivity: assertion.sensitivity,
                observedAt: assertion.observedAt,
                updatedAt: assertion.updatedAt
              };
            })
          )
        };
      })
    );
  },

  async releaseCuratedMemoryProposalReview(actor, proposalId, input) {
    const result = await pool.query<ProposalRow>(
      `
        update curated_memory_proposals
        set processing_started_at = null,
            processing_lease_until = null,
            last_error_message = $4,
            updated_at = now()
        where id = $1
          and owner_user_id = $2
          and visibility = 'personal'
          and status = 'pending'
          and attempt_count = $3
          and processing_lease_until is not null
        returning ${proposalSelect}
      `,
      [proposalId, actor.userId, input.attemptCount, input.lastErrorMessage]
    );
    return result.rows[0]
      ? mapProposal(
          await hydrateProposalRow(
            pool,
            actor,
            envelopeEncryptionProvider,
            result.rows[0]
          )
        )
      : null;
  },

  async exportCuratedMemoryRecords(actor) {
    const [topicRows, assertionRows, proposalRows] = await Promise.all([
      pool.query<TopicRow>(
        `
          select *
          from curated_memory_topics
          where owner_user_id = $1 and visibility = 'personal'
          order by created_at asc, id asc
        `,
        [actor.userId]
      ),
      pool.query<AssertionRow>(
        `
          select ${assertionSelect}
          from curated_memory_assertions cma
          left join curated_memory_topics cmt on cmt.id = cma.topic_id
          where cma.owner_user_id = $1 and cma.visibility = 'personal'
          order by cma.created_at asc, cma.id asc
        `,
        [actor.userId]
      ),
      pool.query<ProposalRow>(
        `
          select ${proposalSelect}
          from curated_memory_proposals
          where owner_user_id = $1 and visibility = 'personal'
          order by created_at asc, id asc
        `,
        [actor.userId]
      )
    ]);
    const sourceMap = await loadSources(
      pool,
      actor,
      envelopeEncryptionProvider,
      assertionRows.rows.map((row) => row.id)
    );
    return {
      topics: await Promise.all(
        topicRows.rows.map(async (row) =>
          mapTopic(
            await hydrateTopicRow(pool, actor, envelopeEncryptionProvider, row)
          )
        )
      ),
      assertions: await Promise.all(
        assertionRows.rows.map(async (row) =>
          mapAssertion(
            await hydrateAssertionRow(
              pool,
              actor,
              envelopeEncryptionProvider,
              row
            ),
            sourceMap.get(row.id)
          )
        )
      ),
      proposals: await Promise.all(
        proposalRows.rows.map(async (row) =>
          mapProposal(
            await hydrateProposalRow(
              pool,
              actor,
              envelopeEncryptionProvider,
              row
            )
          )
        )
      )
    };
  },

  async listCuratedMemoryAssertions(actor, input = {}) {
    const result = await pool.query<AssertionRow>(
      `
        select ${assertionSelect}
        from curated_memory_assertions cma
        left join curated_memory_topics cmt on cmt.id = cma.topic_id
        where cma.owner_user_id = $1
          and cma.visibility = 'personal'
          and ($2::text is null or cma.status = $2::curated_memory_assertion_status)
          and ($3::uuid is null or cma.topic_id = $3)
        order by cma.updated_at desc, cma.id desc
        limit $4
      `,
      [
        actor.userId,
        input.status ?? null,
        input.topicId ?? null,
        positiveLimit(input.limit)
      ]
    );
    const sourceMap = input.includeSources
      ? await loadSources(
          pool,
          actor,
          envelopeEncryptionProvider,
          result.rows.map((row) => row.id)
        )
      : new Map<string, CuratedMemorySourceRecord[]>();
    return Promise.all(
      result.rows.map(async (row) =>
        mapAssertion(
          await hydrateAssertionRow(
            pool,
            actor,
            envelopeEncryptionProvider,
            row
          ),
          sourceMap.get(row.id)
        )
      )
    );
  },

  async getCuratedMemoryAssertion(actor, assertionId) {
    return getAssertionByIdWithClient(
      pool,
      actor,
      envelopeEncryptionProvider,
      assertionId
    );
  }
});
