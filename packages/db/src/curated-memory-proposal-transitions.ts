import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import {
  approvalConversationItemSql,
  semanticMemoryEventEligibleSql
} from "./approval-activity-sql.js";
import type { CuratedMemoryRepository } from "./curated-memory-repository.js";
import {
  activeCuratedMemoryEvidencePredicate,
  verifyCuratedMemorySourcesWithClient
} from "./curated-memory-policy.js";
import {
  ENCRYPTED_CURATED_MEMORY_TEXT,
  assertionSelect,
  dedupeStrings,
  encryptedCuratedMemoryJson,
  getAssertionByIdWithClient,
  hydrateAssertionRow,
  hydrateProposalRow,
  hydrateTopicRow,
  iso,
  loadSources,
  mapAssertion,
  mapProposal,
  mapTopic,
  normalized,
  normalizedDedupeKey,
  persistCuratedMemoryPayload,
  proposalSelect,
  protectedCuratedMemoryPayloadsRequired,
  requireEncryptionProvider,
  visibilityError,
  type AssertionRow,
  type CuratedMemoryRepositoryContext,
  type ProposalRow,
  type TopicRow
} from "./curated-memory-support.js";
import type {
  ActorContext,
  CuratedMemoryAssertionRecord,
  CuratedMemoryCreateAssertionInput,
  CuratedMemoryProposalStatus,
  CuratedMemoryTopicRecord
} from "./types.js";

const upsertTopic = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  input: { title?: string | null }
): Promise<CuratedMemoryTopicRecord | null> => {
  const title = input.title?.trim();
  if (!title) {
    return null;
  }
  if (protectedCuratedMemoryPayloadsRequired()) {
    requireEncryptionProvider(provider);
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [actor.userId]
    );
    const candidates = await client.query<TopicRow>(
      `
        select *
        from curated_memory_topics
        where owner_user_id = $1
          and visibility = 'personal'
        order by updated_at desc, id desc
      `,
      [actor.userId]
    );
    const hydratedCandidates = await Promise.all(
      candidates.rows.map((row) =>
        hydrateTopicRow(client, actor, provider, row)
      )
    );
    const existing = hydratedCandidates.find(
      (row) => normalized(row.title) === normalized(title)
    );
    if (existing) {
      const updated = await client.query<TopicRow>(
        `
          update curated_memory_topics
          set updated_at = now()
          where id = $1 and owner_user_id = $2
          returning *
        `,
        [existing.id, actor.userId]
      );
      await persistCuratedMemoryPayload(client, actor, provider, {
        sourceTable: "curated_memory_topics",
        sourceId: existing.id,
        plaintext: { title, normalizedTitle: normalized(title) }
      });
      return mapTopic(
        await hydrateTopicRow(client, actor, provider, updated.rows[0]!)
      );
    }
    const inserted = await client.query<TopicRow>(
      `
        insert into curated_memory_topics (
          owner_user_id, visibility, title, normalized_title
        )
        values ($1, 'personal', $2, concat('encrypted:', gen_random_uuid()))
        returning *
      `,
      [actor.userId, ENCRYPTED_CURATED_MEMORY_TEXT]
    );
    const row = inserted.rows[0]!;
    await persistCuratedMemoryPayload(client, actor, provider, {
      sourceTable: "curated_memory_topics",
      sourceId: row.id,
      plaintext: {
        title,
        normalizedTitle: normalized(title)
      }
    });
    return mapTopic(await hydrateTopicRow(client, actor, provider, row));
  }
  const result = await client.query<TopicRow>(
    `
      insert into curated_memory_topics (
        owner_user_id,
        visibility,
        title,
        normalized_title
      )
      values ($1, 'personal', $2, $3)
      on conflict (owner_user_id, normalized_title)
        do update set
          title = excluded.title,
          updated_at = now()
      returning *
    `,
    [actor.userId, title, normalized(title)]
  );
  return result.rows[0] ? mapTopic(result.rows[0]) : null;
};

const findCurrentAssertionByTextWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  assertionText: string
): Promise<AssertionRow | undefined> => {
  const protectPayload = protectedCuratedMemoryPayloadsRequired();
  const candidates = await client.query<AssertionRow>(
    `
      select ${assertionSelect}
      from curated_memory_assertions cma
      left join curated_memory_topics cmt on cmt.id = cma.topic_id
      where cma.owner_user_id = $1
        and cma.visibility = 'personal'
        and cma.status = 'current'
        and cma.suppressed_at is null
        and cma.expires_at is null
        and ${activeCuratedMemoryEvidencePredicate("cma")}
        and ($2::text is null or cma.normalized_assertion = $2)
    `,
    [actor.userId, protectPayload ? null : normalizedDedupeKey(assertionText)]
  );
  const hydratedCandidates = await Promise.all(
    candidates.rows.map((row) =>
      hydrateAssertionRow(client, actor, provider, row)
    )
  );
  return hydratedCandidates.find(
    (row) => normalized(row.assertion_text) === normalized(assertionText)
  );
};

const createAssertionWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  input: CuratedMemoryCreateAssertionInput
): Promise<CuratedMemoryAssertionRecord> => {
  const assertionText = input.assertionText.trim();
  if (!assertionText) {
    throw new Error("Curated Memory assertion text is required");
  }
  await verifyCuratedMemorySourcesWithClient(client, actor, input.sources);
  const topic = await upsertTopic(client, actor, provider, {
    title: input.topicTitle
  });
  const protectPayload = protectedCuratedMemoryPayloadsRequired();
  if (protectPayload) {
    requireEncryptionProvider(provider);
  }
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    actor.userId
  ]);
  let existingAssertion: AssertionRow | undefined;
  if (!input.expiresAt && (input.status ?? "current") === "current") {
    existingAssertion = await findCurrentAssertionByTextWithClient(
      client,
      actor,
      provider,
      assertionText
    );
  }
  const result = existingAssertion
    ? await client.query<{ id: string }>(
        `
          update curated_memory_assertions
          set topic_id = coalesce($2::uuid, topic_id), updated_at = now()
          where id = $1 and owner_user_id = $3
          returning id
        `,
        [existingAssertion.id, topic?.id ?? null, actor.userId]
      )
    : await client.query<{ id: string }>(
        `
      insert into curated_memory_assertions (
        owner_user_id,
        visibility,
        topic_id,
        assertion_text,
        normalized_assertion,
        sensitivity,
        confidence,
        tags,
        metadata,
        expires_at,
        observed_at,
        status,
        supersedes_assertion_id,
        conflict_with_assertion_id,
        created_by_model,
        created_by_prompt_version
      )
      values (
        $1,
        'personal',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::text[],
        $8::jsonb,
        $9::timestamptz,
        coalesce($10::timestamptz, now()),
        $11::curated_memory_assertion_status,
        $12::uuid,
        $13::uuid,
        $14,
        $15
      )
      on conflict (owner_user_id, normalized_assertion)
        where visibility = 'personal'
          and status = 'current'
          and suppressed_at is null
          and expires_at is null
        do update set
          topic_id = coalesce(excluded.topic_id, curated_memory_assertions.topic_id),
          tags = (
            select array(
              select distinct tag
              from unnest(curated_memory_assertions.tags || excluded.tags) as tag
              where btrim(tag) <> ''
              order by tag
            )
          ),
          metadata = curated_memory_assertions.metadata || excluded.metadata,
          updated_at = now()
        where lower(regexp_replace(btrim(curated_memory_assertions.assertion_text), '\\s+', ' ', 'g')) = $16
      returning id
    `,
        [
          actor.userId,
          topic?.id ?? null,
          protectPayload ? ENCRYPTED_CURATED_MEMORY_TEXT : assertionText,
          protectPayload
            ? `encrypted:${randomUUID()}`
            : normalizedDedupeKey(assertionText),
          input.sensitivity ?? "normal",
          input.confidence ?? 80,
          protectPayload ? [] : dedupeStrings(input.tags),
          JSON.stringify(
            protectPayload ? encryptedCuratedMemoryJson : (input.metadata ?? {})
          ),
          input.expiresAt ?? null,
          input.observedAt ?? null,
          input.status ?? "current",
          input.supersedesAssertionId ?? null,
          input.conflictWithAssertionId ?? null,
          input.createdByModel ?? null,
          input.createdByPromptVersion ?? null,
          normalized(assertionText)
        ]
      );
  const assertionId = result.rows[0]?.id;
  if (!assertionId) {
    throw new Error("Failed to create Curated Memory assertion");
  }
  if (protectPayload) {
    const existingPayload = existingAssertion
      ? {
          assertionText: existingAssertion.assertion_text,
          normalizedAssertion: existingAssertion.normalized_assertion,
          tags: existingAssertion.tags,
          metadata: existingAssertion.metadata ?? {},
          suppressionReason: existingAssertion.suppression_reason
        }
      : null;
    await persistCuratedMemoryPayload(client, actor, provider, {
      sourceTable: "curated_memory_assertions",
      sourceId: assertionId,
      plaintext: {
        assertionText,
        normalizedAssertion: normalized(assertionText),
        tags: dedupeStrings([
          ...((existingPayload?.tags as string[] | undefined) ?? []),
          ...(input.tags ?? [])
        ]),
        metadata: {
          ...((existingPayload?.metadata as
            | Record<string, unknown>
            | undefined) ?? {}),
          ...(input.metadata ?? {})
        },
        suppressionReason: existingPayload?.suppressionReason ?? null
      }
    });
  }
  const assertion = await getAssertionByIdWithClient(
    client,
    actor,
    provider,
    assertionId
  );
  if (!assertion) {
    throw new Error("Curated Memory assertion was not visible after creation");
  }

  for (const source of input.sources) {
    const insertedSource = await client.query<{ id: string }>(
      `
        insert into curated_memory_sources (
          assertion_id,
          source_type,
          source_role,
          conversation_item_id,
          memory_event_id,
          lcm_node_id,
          metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        on conflict do nothing
        returning id
      `,
      [
        assertion.id,
        source.sourceType,
        source.sourceRole,
        source.conversationItemId ?? null,
        source.memoryEventId ?? null,
        source.lcmNodeId ?? null,
        JSON.stringify(
          protectPayload ? encryptedCuratedMemoryJson : (source.metadata ?? {})
        )
      ]
    );
    const sourceId = insertedSource.rows[0]?.id;
    if (protectPayload && sourceId) {
      await persistCuratedMemoryPayload(client, actor, provider, {
        sourceTable: "curated_memory_sources",
        sourceId,
        plaintext: { metadata: source.metadata ?? {} }
      });
    }
  }

  return (await getAssertionByIdWithClient(
    client,
    actor,
    provider,
    assertion.id
  ))!;
};

export const createCuratedMemoryProposalTransitionMethods = ({
  pool,
  envelopeEncryptionProvider,
  onCuratedMemoryChanged
}: CuratedMemoryRepositoryContext): Pick<
  CuratedMemoryRepository,
  "processCuratedMemoryProposal"
> => ({
  async processCuratedMemoryProposal(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const proposalResult = await client.query<ProposalRow>(
        `
          select ${proposalSelect}
          from curated_memory_proposals
          where id = $1
            and owner_user_id = $2
            and visibility = 'personal'
          for update
        `,
        [input.proposalId, actor.userId]
      );
      const storedProposal = proposalResult.rows[0];
      if (!storedProposal) {
        throw visibilityError("Curated Memory proposal not found");
      }
      const proposal = await hydrateProposalRow(
        client,
        actor,
        envelopeEncryptionProvider,
        storedProposal
      );
      if (proposal.status !== "pending") {
        await client.query("commit");
        return mapProposal(proposal);
      }
      if (
        input.decision !== "skip" &&
        input.expectedAttemptCount !== undefined &&
        input.assertion
      ) {
        const sensitivityRank = {
          normal: 0,
          sensitive: 1,
          review_required: 2
        } as const;
        const proposedExpiry = proposal.expires_at_hint?.getTime() ?? null;
        const reviewedExpiry = input.assertion.expiresAt
          ? Date.parse(input.assertion.expiresAt)
          : null;
        if (
          proposal.sensitivity_hint === "review_required" ||
          input.assertion.sensitivity === "review_required" ||
          (proposal.sensitivity_hint !== null &&
            sensitivityRank[input.assertion.sensitivity ?? "normal"] <
              sensitivityRank[proposal.sensitivity_hint]) ||
          (proposedExpiry !== null &&
            (reviewedExpiry === null || reviewedExpiry > proposedExpiry))
        ) {
          throw Object.assign(
            new Error("Curated Memory review violated proposal policy"),
            { statusCode: 400 }
          );
        }
      }
      if (
        input.expectedAttemptCount !== undefined &&
        (proposal.attempt_count !== input.expectedAttemptCount ||
          proposal.processing_lease_until === null ||
          proposal.processing_lease_until <= new Date())
      ) {
        throw Object.assign(new Error("Curated Memory review lease is stale"), {
          statusCode: 409
        });
      }

      if (
        input.decision !== "skip" &&
        input.expectedAttemptCount !== undefined &&
        !input.evidenceRevisions
      ) {
        throw new Error(
          "Curated Memory review evidence revisions are required"
        );
      }
      if (input.decision !== "skip" && input.evidenceRevisions) {
        const conversationRevisions = await client.query<{
          id: string;
          source_hash: string;
        }>(
          `
            select id, source_hash
            from conversation_items ci
            where ci.owner_user_id = $1
              and ci.visibility = 'personal'
              and ci.personal_deleted_at is null
              and ci.memory_excluded_at is null
              and not ${approvalConversationItemSql("ci")}
              and ci.id = any($2::uuid[])
          `,
          [actor.userId, proposal.evidence_conversation_item_ids]
        );
        const memoryEventRevisions = await client.query<{
          id: string;
          source_hash: string | null;
          updated_at: Date;
        }>(
          `
            select id, source_hash, updated_at
            from memory_events me
            where me.owner_user_id = $1
              and me.visibility = 'personal'
              and me.invalidated_at is null
              and me.personal_deleted_at is null
              and ${semanticMemoryEventEligibleSql("me")}
              and me.id = any($2::uuid[])
          `,
          [actor.userId, proposal.evidence_memory_event_ids]
        );
        const actualRevisions = new Map<string, string>([
          ...conversationRevisions.rows.map(
            (row) => [`conversation_item:${row.id}`, row.source_hash] as const
          ),
          ...memoryEventRevisions.rows.map(
            (row) =>
              [
                `memory_event:${row.id}`,
                row.source_hash ?? `${row.id}:${row.updated_at.toISOString()}`
              ] as const
          )
        ]);
        const expectedIds = [
          ...proposal.evidence_conversation_item_ids.map(
            (id) => `conversation_item:${id}`
          ),
          ...proposal.evidence_memory_event_ids.map(
            (id) => `memory_event:${id}`
          )
        ];
        const supplied = new Map(
          input.evidenceRevisions.map((revision) => [
            `${revision.sourceType}:${revision.sourceId}`,
            revision.sourceHash
          ])
        );
        if (
          expectedIds.length !== actualRevisions.size ||
          supplied.size !== actualRevisions.size ||
          expectedIds.some(
            (id) =>
              !actualRevisions.has(id) ||
              supplied.get(id) !== actualRevisions.get(id)
          )
        ) {
          throw Object.assign(
            new Error("Curated Memory evidence changed during review"),
            { statusCode: 409 }
          );
        }
      }

      let assertionId: string | null = null;
      let nextStatus: CuratedMemoryProposalStatus = "skipped";
      let target: CuratedMemoryAssertionRecord | null = null;
      const targetAssertionId =
        input.targetAssertionId !== undefined
          ? input.targetAssertionId
          : proposal.target_assertion_id;
      if (
        input.decision !== "skip" &&
        input.expectedAttemptCount !== undefined
      ) {
        const selectedEvidenceIds = new Set(input.selectedEvidenceIds ?? []);
        const proposalEvidenceIds = new Set([
          ...proposal.evidence_conversation_item_ids,
          ...proposal.evidence_memory_event_ids
        ]);
        const assertionEvidenceIds = new Set(
          (input.assertion?.sources ?? []).flatMap((source) =>
            source.conversationItemId
              ? [source.conversationItemId]
              : source.memoryEventId
                ? [source.memoryEventId]
                : []
          )
        );
        if (
          selectedEvidenceIds.size === 0 ||
          [...selectedEvidenceIds].some((id) => !proposalEvidenceIds.has(id)) ||
          selectedEvidenceIds.size !== assertionEvidenceIds.size ||
          [...selectedEvidenceIds].some((id) => !assertionEvidenceIds.has(id))
        ) {
          throw new Error(
            "Curated Memory reviewed sources must match selected proposal evidence"
          );
        }
      }
      if (
        input.expectedAttemptCount !== undefined &&
        input.decision !== "skip" &&
        input.decision !== "store" &&
        (!targetAssertionId ||
          !input.candidateAssertionIds?.includes(targetAssertionId))
      ) {
        throw new Error(
          "Curated Memory review target was not supplied to the local reviewer"
        );
      }
      if (targetAssertionId) {
        const targetResult = await client.query<AssertionRow>(
          `
            select ${assertionSelect}
            from curated_memory_assertions cma
            left join curated_memory_topics cmt on cmt.id = cma.topic_id
            where cma.id = $1
              and cma.owner_user_id = $2
              and cma.visibility = 'personal'
              and cma.status = 'current'
              and cma.suppressed_at is null
              and (cma.expires_at is null or cma.expires_at > now())
              and ${activeCuratedMemoryEvidencePredicate("cma")}
            for update of cma
          `,
          [targetAssertionId, actor.userId]
        );
        const targetRow = targetResult.rows[0];
        if (!targetRow) {
          throw visibilityError(
            "Curated Memory target assertion not found or not current"
          );
        }
        const hydratedTarget = await hydrateAssertionRow(
          client,
          actor,
          envelopeEncryptionProvider,
          targetRow
        );
        const sourceMap = await loadSources(
          client,
          actor,
          envelopeEncryptionProvider,
          [hydratedTarget.id]
        );
        target = mapAssertion(
          hydratedTarget,
          sourceMap.get(hydratedTarget.id) ?? []
        );
      }

      if (input.decision === "store") {
        if (!input.assertion) {
          throw new Error("Curated Memory assertion input is required");
        }
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [actor.userId]
        );
        const duplicate = await findCurrentAssertionByTextWithClient(
          client,
          actor,
          envelopeEncryptionProvider,
          input.assertion.assertionText
        );
        const assertion = await createAssertionWithClient(
          client,
          actor,
          envelopeEncryptionProvider,
          input.assertion
        );
        assertionId = assertion.id;
        nextStatus = duplicate ? "merged" : "stored";
      } else if (input.decision === "merge") {
        if (!input.assertion || !target) {
          throw new Error(
            "Curated Memory merge requires assertion input and a current target"
          );
        }
        const merged = await createAssertionWithClient(
          client,
          actor,
          envelopeEncryptionProvider,
          {
            ...input.assertion,
            assertionText: target.assertionText,
            topicTitle: input.assertion.topicTitle ?? target.topicTitle,
            tags: [...target.tags, ...(input.assertion.tags ?? [])],
            metadata: {
              ...target.metadata,
              ...(input.assertion.metadata ?? {})
            }
          }
        );
        assertionId = merged.id;
        nextStatus = "merged";
      } else if (input.decision === "supersede") {
        if (!input.assertion || !target) {
          throw new Error(
            "Curated Memory supersession requires assertion input and a current target"
          );
        }
        const replacement = await createAssertionWithClient(
          client,
          actor,
          envelopeEncryptionProvider,
          {
            ...input.assertion,
            status: "current",
            supersedesAssertionId: target.id
          }
        );
        await client.query(
          `
            update curated_memory_assertions
            set status = 'superseded',
                superseded_by_assertion_id = $3,
                updated_at = now()
            where id = $1
              and owner_user_id = $2
              and status = 'current'
              and suppressed_at is null
          `,
          [target.id, actor.userId, replacement.id]
        );
        assertionId = replacement.id;
        nextStatus = "superseded";
      } else if (input.decision === "conflict") {
        if (!input.assertion || !target) {
          throw new Error(
            "Curated Memory conflict requires assertion input and a current target"
          );
        }
        const conflicting = await createAssertionWithClient(
          client,
          actor,
          envelopeEncryptionProvider,
          {
            ...input.assertion,
            status: "conflicting",
            conflictWithAssertionId: target.id
          }
        );
        assertionId = conflicting.id;
        nextStatus = "conflicted";
      }

      const protectPayload = protectedCuratedMemoryPayloadsRequired();
      const updated = await client.query<ProposalRow>(
        `
          update curated_memory_proposals
          set status = $3,
              decision_reason = $4,
              assertion_id = $5,
              worker_result = $6::jsonb,
              processing_started_at = null,
              processing_lease_until = null,
              last_error_message = null,
              decided_at = now(),
              updated_at = now()
          where id = $1 and owner_user_id = $2
          returning ${proposalSelect}
        `,
        [
          input.proposalId,
          actor.userId,
          nextStatus,
          protectPayload ? null : (input.decisionReason ?? null),
          assertionId,
          input.workerResult
            ? JSON.stringify(
                protectPayload ? encryptedCuratedMemoryJson : input.workerResult
              )
            : null
        ]
      );
      if (protectPayload) {
        await persistCuratedMemoryPayload(
          client,
          actor,
          envelopeEncryptionProvider,
          {
            sourceTable: "curated_memory_proposals",
            sourceId: proposal.id,
            plaintext: {
              proposedClaim: proposal.proposed_claim,
              proposedTopic: proposal.proposed_topic,
              rationale: proposal.rationale,
              tags: proposal.tags,
              expiresAt: iso(proposal.expires_at_hint),
              decisionReason: input.decisionReason ?? null,
              workerResult: input.workerResult ?? null
            }
          }
        );
      }
      const hydratedUpdated = await hydrateProposalRow(
        client,
        actor,
        envelopeEncryptionProvider,
        updated.rows[0]!
      );
      if (assertionId) {
        await onCuratedMemoryChanged?.(actor, client);
      }
      await client.query("commit");
      return mapProposal(hydratedUpdated);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});
