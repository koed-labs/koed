import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import {
  approvalConversationItemSql,
  semanticMemoryEventEligibleSql
} from "./approval-activity-sql.js";
import type { CuratedMemoryRepository } from "./curated-memory-repository.js";
import {
  appendProjectActivityWithClient,
  lockProjectActivityParentNowait
} from "./project-activity-repository.js";
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
  CuratedMemoryScope,
  CuratedMemoryProposalStatus,
  CuratedMemoryTopicRecord
} from "./types.js";

const reviewClassificationWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  proposal: ProposalRow,
  input: CuratedMemoryCreateAssertionInput,
  inheritedProjectId: string | null = null
): Promise<
  Pick<CuratedMemoryCreateAssertionInput, "scope" | "kind"> & {
    projectId: string | null;
    authorKind: "user" | null;
    authorRef: string | null;
  }
> => {
  const scope: CuratedMemoryScope = input.scope ?? "unscoped";
  const selected = input.sources;
  const result = await client.query<{
    source_id: string;
    project_id: string | null;
    user_authored: boolean;
  }>(
    `select ci.id as source_id,
            case when session.project_override_id is not null
                 then session.project_override_personal_project_id
                 else session.automatic_personal_project_id end as project_id,
            (session.id is not null and
             ci.source_event_type in ('user_message','UserPromptSubmit')) as user_authored
       from conversation_items ci
       left join sessions session on session.id=ci.session_id
         and session.owner_user_id=$1 and session.personal_deleted_at is null
      where ci.owner_user_id=$1 and ci.id=any($2::uuid[])
        and ci.visibility='personal' and ci.personal_deleted_at is null
        and ci.memory_excluded_at is null
     union all
     select me.id as source_id,
            case when session.project_override_id is not null
                 then session.project_override_personal_project_id
                 else session.automatic_personal_project_id end as project_id,
            (session.id is not null and me.actor_user_id=$1::uuid
             and message.id is not null and message.role='user') as user_authored
       from memory_events me
       left join messages message on message.id=me.message_id
         and message.owner_user_id=$1 and message.session_id=me.session_id
       left join sessions session on session.id=me.session_id
         and session.owner_user_id=$1 and session.personal_deleted_at is null
      where me.owner_user_id=$1 and me.id=any($3::uuid[])
        and me.visibility='personal' and me.invalidated_at is null
        and me.personal_deleted_at is null`,
    [
      actor.userId,
      selected.flatMap((source) =>
        source.conversationItemId ? [source.conversationItemId] : []
      ),
      selected.flatMap((source) =>
        source.memoryEventId ? [source.memoryEventId] : []
      )
    ]
  );
  if (
    result.rows.length !== selected.length ||
    new Set(result.rows.map((row) => row.source_id)).size !== selected.length
  ) {
    throw Object.assign(new Error("Curated Memory source provenance changed"), {
      statusCode: 409
    });
  }
  let projectId: string | null = null;
  if (scope === "project") {
    const projectContextId = proposal.project_context_id ?? inheritedProjectId;
    if (
      !projectContextId ||
      result.rows.some((row) => row.project_id !== projectContextId)
    ) {
      throw Object.assign(
        new Error(
          "Curated Memory Project scope lacks matching source provenance"
        ),
        { statusCode: 409 }
      );
    }
    let project: pg.QueryResult<{ id: string }>;
    try {
      project = await client.query<{ id: string }>(
        `select id from projects where id=$1 and owner_user_id=$2
         and lifecycle='active' and deletion_phase is null
         for update${input.kind === "decision" ? " nowait" : ""}`,
        [projectContextId, actor.userId]
      );
    } catch (error) {
      if (
        input.kind === "decision" &&
        (error as { code?: string }).code === "55P03"
      )
        throw Object.assign(
          new Error(
            "Project changed during Curated Memory review; retry the review."
          ),
          { statusCode: 409 }
        );
      throw error;
    }
    if (!project.rows[0]) {
      throw Object.assign(new Error("Curated Memory Project is unavailable"), {
        statusCode: 409
      });
    }
    projectId = projectContextId;
  }
  const userAuthored = result.rows.every((row) => row.user_authored);
  return {
    scope,
    projectId,
    kind: input.kind ?? null,
    authorKind: userAuthored ? "user" : null,
    authorRef: userAuthored ? actor.userId : null
  };
};

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
  input: CuratedMemoryCreateAssertionInput,
  classification?: Awaited<ReturnType<typeof reviewClassificationWithClient>>
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
  if (existingAssertion) {
    const locked = await client.query<AssertionRow>(
      `select ${assertionSelect}
         from curated_memory_assertions cma
         left join curated_memory_topics cmt on cmt.id=cma.topic_id
        where cma.id=$1 and cma.owner_user_id=$2
          and cma.status='current' and cma.suppressed_at is null
        for update of cma`,
      [existingAssertion.id, actor.userId]
    );
    if (!locked.rows[0]) {
      throw Object.assign(new Error("Curated Memory duplicate changed"), {
        statusCode: 409
      });
    }
    existingAssertion = await hydrateAssertionRow(
      client,
      actor,
      provider,
      locked.rows[0]
    );
  }
  if (
    classification &&
    existingAssertion &&
    ((input.scope !== undefined &&
      (existingAssertion.scope !== classification.scope ||
        existingAssertion.project_id !== classification.projectId)) ||
      (existingAssertion.kind !== null &&
        existingAssertion.kind !== classification.kind))
  ) {
    throw Object.assign(
      new Error(
        "Curated Memory duplicate requires acknowledged classification change"
      ),
      { statusCode: 409 }
    );
  }
  const result = existingAssertion
    ? await client.query<{ id: string }>(
        `
          update curated_memory_assertions
          set topic_id = coalesce($2::uuid, topic_id),
              kind = coalesce(kind,$4::curated_memory_kind),
              updated_at = now()
          where id = $1 and owner_user_id = $3
          returning id
        `,
        [
          existingAssertion.id,
          topic?.id ?? null,
          actor.userId,
          classification?.kind ?? null
        ]
      )
    : await client.query<{ id: string }>(
        `
      insert into curated_memory_assertions (
        owner_user_id,
        visibility,
        scope,
        project_id,
        kind,
        author_kind,
        author_ref,
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
        $17::curated_memory_scope,
        $18::uuid,
        $19::curated_memory_kind,
        $20::curated_memory_author_kind,
        $21,
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
          kind = coalesce(curated_memory_assertions.kind, excluded.kind),
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
          normalized(assertionText),
          classification?.scope ?? "unscoped",
          classification?.projectId ?? null,
          classification?.kind ?? null,
          classification?.authorKind ?? null,
          classification?.authorRef ?? null
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
          project_source_revision_id,
          project_work_item_id,
          metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
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
        source.projectSourceRevisionId ?? null,
        source.projectWorkItemId ?? null,
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
        proposal.created_by_prompt_version === "deck-first-again-v1" &&
        input.decision !== "skip"
      ) {
        const eventId = proposal.evidence_memory_event_ids[0];
        const source =
          eventId &&
          proposal.evidence_memory_event_ids.length === 1 &&
          proposal.evidence_conversation_item_ids.length === 0 &&
          (
            await client.query(
              `select 1 from personal_note_revisions revision
               join personal_notes note on note.id=revision.note_id
              where revision.owner_user_id=$1 and revision.memory_event_id=$2
                and revision.revision=1 and note.owner_user_id=$1
                and note.current_revision=1 and note.lifecycle='active'`,
              [actor.userId, eventId]
            )
          ).rowCount;
        if (
          !source ||
          input.expectedAttemptCount === undefined ||
          input.decision !== "store" ||
          input.assertion?.scope !== "me" ||
          input.assertion?.kind !== "learning" ||
          proposal.scope_hint !== "me" ||
          proposal.kind_hint !== "learning" ||
          proposal.operation !== "store"
        )
          throw Object.assign(
            new Error("Deck learning must remain a source-backed Me learning"),
            { statusCode: 409 }
          );
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
          (input.assertion?.sources ?? []).some(
            (source) =>
              (source.sourceType !== "conversation_item" &&
                source.sourceType !== "memory_event") ||
              (source.sourceType === "conversation_item" &&
                !proposal.evidence_conversation_item_ids.includes(
                  source.conversationItemId ?? ""
                )) ||
              (source.sourceType === "memory_event" &&
                !proposal.evidence_memory_event_ids.includes(
                  source.memoryEventId ?? ""
                ))
          ) ||
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
      if (input.decision !== "skip") {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [actor.userId]
        );
      }
      const targetPreview = targetAssertionId
        ? (
            await client.query<{
              scope: CuratedMemoryScope;
              project_id: string | null;
              kind: CuratedMemoryCreateAssertionInput["kind"];
              classification_version: number;
            }>(
              `select scope,project_id,kind,classification_version
                 from curated_memory_assertions
                where id=$1 and owner_user_id=$2
                  and visibility='personal' and status='current'
                  and suppressed_at is null`,
              [targetAssertionId, actor.userId]
            )
          ).rows[0]
        : null;
      const classification =
        input.expectedAttemptCount !== undefined &&
        input.decision !== "skip" &&
        input.assertion &&
        (input.assertion.kind !== undefined ||
          input.assertion.scope !== undefined ||
          targetPreview != null)
          ? await reviewClassificationWithClient(
              client,
              actor,
              proposal,
              {
                ...input.assertion,
                scope:
                  input.assertion.scope ?? targetPreview?.scope ?? "unscoped",
                kind: input.assertion.kind ?? targetPreview?.kind ?? null
              },
              targetPreview?.project_id ?? null
            )
          : undefined;
      if (
        classification?.scope === "project" &&
        classification.kind === "decision" &&
        classification.projectId &&
        input.decision !== "skip" &&
        input.decision !== "conflict"
      )
        await lockProjectActivityParentNowait(
          client,
          actor.userId,
          classification.projectId
        );
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
        if (
          targetPreview &&
          targetRow.classification_version !==
            targetPreview.classification_version
        ) {
          throw Object.assign(
            new Error("Curated Memory target classification changed"),
            { statusCode: 409 }
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
      if (
        classification &&
        target &&
        (classification.scope !== target.scope ||
          classification.projectId !== target.projectId)
      ) {
        throw Object.assign(
          new Error(
            "Curated Memory target scope change requires withdrawal acknowledgement"
          ),
          { statusCode: 409 }
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
          input.assertion,
          classification
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
          },
          classification
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
          },
          classification
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
          },
          classification
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
        if (nextStatus === "stored" || nextStatus === "superseded") {
          const currentDecision = await client.query<{ project_id: string }>(
            `select cma.project_id from curated_memory_assertions cma
             where cma.id=$1 and cma.owner_user_id=$2
               and cma.visibility='personal' and cma.scope='project'
               and cma.kind='decision' and cma.project_id is not null
               and cma.status='current' and cma.suppressed_at is null
               and (cma.expires_at is null or cma.expires_at > now())
               and ${activeCuratedMemoryEvidencePredicate("cma")}`,
            [assertionId, actor.userId]
          );
          if (currentDecision.rows[0])
            await appendProjectActivityWithClient(client, {
              ownerUserId: actor.userId,
              projectId: currentDecision.rows[0].project_id,
              actorUserId: actor.userId,
              kind: "assertion_created",
              ref: assertionId,
              nowait: true
            });
        }
        const linked = await client.query<{ id: string }>(
          `select linked.id
             from curated_memory_assertions changed
             join curated_memory_assertions linked
               on linked.topic_id=changed.topic_id
              and linked.owner_user_id=changed.owner_user_id
            where changed.id=$1 and changed.owner_user_id=$2
           union select $1::uuid`,
          [assertionId, actor.userId]
        );
        await onCuratedMemoryChanged?.(
          actor,
          client,
          linked.rows.map((row) => row.id)
        );
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
