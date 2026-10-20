import type pg from "pg";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import type { CuratedMemoryRepository } from "./curated-memory-repository.js";
import {
  ENCRYPTED_CURATED_MEMORY_TEXT,
  decryptCuratedMemoryPayload,
  getAssertionByIdWithClient,
  persistCuratedMemoryPayload,
  protectedCuratedMemoryPayloadsRequired,
  requireEncryptionProvider,
  visibilityError,
  type CuratedMemoryRepositoryContext
} from "./curated-memory-support.js";
import type { ActorContext, CuratedMemorySourceInput } from "./types.js";

/** A derived summary must stay hidden while any contributing chat is forgotten. */
export const memoryNodeHasForgottenSessionPredicate = (
  nodeAlias: string
): string => `exists (
  with recursive contributing_nodes(id) as (
    select ${nodeAlias}.id
    union
    select child.child_memory_node_id
      from memory_node_children child
      join contributing_nodes parent on parent.id=child.parent_memory_node_id
  )
  select 1 from contributing_nodes contributing
    join memory_nodes node on node.id=contributing.id
   where exists (
     select 1 from sessions own_session
      where own_session.id=node.session_id
        and own_session.personal_deleted_at is not null
   ) or exists (
     select 1 from memory_node_sources source
     left join memory_events event on event.id=source.memory_event_id
     left join messages message on message.id=source.message_id
     left join tool_events tool on tool.id=source.tool_event_id
     join sessions source_session on source_session.id=coalesce(
       event.session_id,message.session_id,tool.session_id
     )
      where source.memory_node_id=node.id
        and source_session.personal_deleted_at is not null
   )
)`;

const activePersonalSourceSessionPredicate = (
  sourceAlias: string,
  assertionAlias: string
): string => `(${sourceAlias}.session_id is null or exists (
  select 1 from sessions source_session
   where source_session.id=${sourceAlias}.session_id
     and source_session.owner_user_id=${assertionAlias}.owner_user_id
     and source_session.personal_deleted_at is null
))`;

export const curatedMemoryActiveEvidenceRowsSql = (
  assertionAlias: string,
  prefix: string
): string => `
  select
    coalesce(${prefix}_ci.session_id, ${prefix}_me.session_id, ${prefix}_node_me.session_id) as source_session_id,
    coalesce(
      ${prefix}_ci.event_time,
      ${prefix}_ci.observed_at,
      ${prefix}_ci.created_at,
      ${prefix}_me.source_event_time,
      ${prefix}_me.captured_at,
      ${prefix}_me.created_at,
      ${prefix}_node_me.source_event_time,
      ${prefix}_node_me.captured_at,
      ${prefix}_node_me.created_at
    ) as source_event_time,
    coalesce(
      ${prefix}_ci_session.project_override_id,
      ${prefix}_ci_session.automatic_project_id,
      ${prefix}_ci_session.metadata ->> 'projectId'
    ) as ci_project_id,
    coalesce(
      ${prefix}_ci_session.project_override_id,
      ${prefix}_ci_session.automatic_project_id
    ) as ci_stable_project_id,
    ${prefix}_ci_session.cwd as ci_project_path,
    coalesce(
      nullif(${prefix}_me.payload ->> 'projectId', ''),
      ${prefix}_me_encrypted.scope ->> 'projectId',
      ${prefix}_me_session.metadata ->> 'projectId',
      ${prefix}_me_session.project_override_id,
      ${prefix}_me_session.automatic_project_id
    ) as me_project_id,
    ${prefix}_me_session.cwd as me_project_path,
    coalesce(
      nullif(${prefix}_node_me.payload ->> 'projectId', ''),
      ${prefix}_node_me_encrypted.scope ->> 'projectId',
      ${prefix}_node_session.metadata ->> 'projectId',
      ${prefix}_node_session.project_override_id,
      ${prefix}_node_session.automatic_project_id
    ) as node_project_id,
    ${prefix}_node_session.cwd as node_project_path
  from curated_memory_sources ${prefix}_cms
  left join conversation_items ${prefix}_ci
    on ${prefix}_ci.id = ${prefix}_cms.conversation_item_id
    and ${prefix}_ci.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_ci.visibility = 'personal'
    and ${prefix}_ci.personal_deleted_at is null
    and ${prefix}_ci.memory_excluded_at is null
    and ${activePersonalSourceSessionPredicate(`${prefix}_ci`, assertionAlias)}
  left join sessions ${prefix}_ci_session
    on ${prefix}_ci_session.id = ${prefix}_ci.session_id
    and ${prefix}_ci_session.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_ci_session.personal_deleted_at is null
  left join memory_events ${prefix}_me
    on ${prefix}_me.id = ${prefix}_cms.memory_event_id
    and ${prefix}_me.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_me.visibility = 'personal'
    and ${prefix}_me.invalidated_at is null
    and ${prefix}_me.personal_deleted_at is null
    and ${activePersonalSourceSessionPredicate(`${prefix}_me`, assertionAlias)}
  left join sessions ${prefix}_me_session
    on ${prefix}_me_session.id = ${prefix}_me.session_id
    and ${prefix}_me_session.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_me_session.personal_deleted_at is null
  left join encrypted_field_payloads ${prefix}_me_encrypted
    on ${prefix}_me_encrypted.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_me_encrypted.visibility = 'personal'
    and ${prefix}_me_encrypted.encryption_scope = 'personal'
    and ${prefix}_me_encrypted.source_table = 'memory_events'
    and ${prefix}_me_encrypted.source_id = ${prefix}_me.id
    and ${prefix}_me_encrypted.source_column = 'payload'
    and ${prefix}_me_encrypted.invalidated_at is null
  left join memory_nodes ${prefix}_mn
    on ${prefix}_mn.id = ${prefix}_cms.lcm_node_id
    and ${prefix}_mn.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_mn.visibility = 'personal'
    and ${prefix}_mn.invalidated_at is null
    and ${prefix}_mn.personal_deleted_at is null
    and not ${memoryNodeHasForgottenSessionPredicate(`${prefix}_mn`)}
  left join memory_node_sources ${prefix}_mns
    on ${prefix}_mns.memory_node_id = ${prefix}_mn.id
  left join memory_events ${prefix}_node_me
    on ${prefix}_node_me.id = ${prefix}_mns.memory_event_id
    and ${prefix}_node_me.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_node_me.visibility = 'personal'
    and ${prefix}_node_me.invalidated_at is null
    and ${prefix}_node_me.personal_deleted_at is null
    and ${activePersonalSourceSessionPredicate(`${prefix}_node_me`, assertionAlias)}
  left join sessions ${prefix}_node_session
    on ${prefix}_node_session.id = ${prefix}_node_me.session_id
    and ${prefix}_node_session.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_node_session.personal_deleted_at is null
  left join encrypted_field_payloads ${prefix}_node_me_encrypted
    on ${prefix}_node_me_encrypted.owner_user_id = ${assertionAlias}.owner_user_id
    and ${prefix}_node_me_encrypted.visibility = 'personal'
    and ${prefix}_node_me_encrypted.encryption_scope = 'personal'
    and ${prefix}_node_me_encrypted.source_table = 'memory_events'
    and ${prefix}_node_me_encrypted.source_id = ${prefix}_node_me.id
    and ${prefix}_node_me_encrypted.source_column = 'payload'
    and ${prefix}_node_me_encrypted.invalidated_at is null
  left join project_source_revisions ${prefix}_revision
    on ${prefix}_revision.id=${prefix}_cms.project_source_revision_id
    and ${prefix}_revision.owner_user_id=${assertionAlias}.owner_user_id
    and ${prefix}_revision.state='ready'
    and ${prefix}_revision.note_revision_id is not null
  left join project_sources ${prefix}_project_source
    on ${prefix}_project_source.id=${prefix}_revision.source_id
    and ${prefix}_project_source.owner_user_id=${assertionAlias}.owner_user_id
    and ${prefix}_project_source.kind='doc'
  left join personal_note_revisions ${prefix}_note_revision
    on ${prefix}_note_revision.id=${prefix}_revision.note_revision_id
    and ${prefix}_note_revision.owner_user_id=${assertionAlias}.owner_user_id
    and ${prefix}_note_revision.projection_state='available'
    and ${prefix}_note_revision.forgotten_at is null
  left join personal_notes ${prefix}_note
    on ${prefix}_note.id=${prefix}_note_revision.note_id
    and ${prefix}_note.owner_user_id=${assertionAlias}.owner_user_id
    and ${prefix}_note.lifecycle='active'
  left join project_work_items ${prefix}_work_item
    on ${prefix}_work_item.id=${prefix}_cms.project_work_item_id
    and ${prefix}_work_item.owner_user_id=${assertionAlias}.owner_user_id
  where ${prefix}_cms.assertion_id = ${assertionAlias}.id
    and ${prefix}_cms.source_role in (
      'primary_evidence',
      'supporting_evidence',
      'superseding_evidence',
      'conflicting_evidence'
    )
    and (coalesce(${prefix}_ci.id, ${prefix}_me.id, ${prefix}_mn.id) is not null
      or (${prefix}_project_source.id is not null and ${prefix}_note.id is not null)
      or ${prefix}_work_item.id is not null)
`;

export const activeCuratedMemoryEvidencePredicate = (
  assertionAlias: string
): string =>
  `exists (${curatedMemoryActiveEvidenceRowsSql(assertionAlias, "active")})`;

export const suppressCuratedMemoryWithoutActiveEvidenceWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined,
  assertionIds?: readonly string[]
): Promise<string[]> => {
  if (assertionIds && assertionIds.length === 0) return [];
  const protectPayload = protectedCuratedMemoryPayloadsRequired();
  if (protectPayload) {
    requireEncryptionProvider(provider);
  }
  const updated = await client.query<{ id: string }>(
    `
      update curated_memory_assertions cma
      set status = 'suppressed',
          suppressed_at = now(),
          suppressed_by_user_id = $1,
          suppression_reason = $2,
          updated_at = now()
      where cma.owner_user_id = $1
        and cma.visibility = 'personal'
        and cma.status = 'current'
        and cma.suppressed_at is null
        and ($3::uuid[] is null or cma.id = any($3::uuid[]))
        and not ${activeCuratedMemoryEvidencePredicate("cma")}
      returning cma.id
    `,
    [
      actor.userId,
      protectPayload
        ? ENCRYPTED_CURATED_MEMORY_TEXT
        : "Final active source evidence was deleted",
      assertionIds ?? null
    ]
  );
  if (protectPayload) {
    for (const row of updated.rows) {
      const payload = await decryptCuratedMemoryPayload(
        client,
        actor,
        provider,
        "curated_memory_assertions",
        row.id
      );
      await persistCuratedMemoryPayload(client, actor, provider, {
        sourceTable: "curated_memory_assertions",
        sourceId: row.id,
        plaintext: {
          ...(payload ?? {}),
          suppressionReason: "Final active source evidence was deleted"
        }
      });
    }
  }
  return updated.rows.map((row) => row.id);
};

export const verifyCuratedMemorySourcesWithClient = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  sources: CuratedMemorySourceInput[]
): Promise<void> => {
  if (sources.length === 0) {
    throw Object.assign(
      new Error("Curated Memory requires at least one source link"),
      { statusCode: 400 }
    );
  }
  const conversationItemIds = sources
    .map((source) => source.conversationItemId)
    .filter((value): value is string => Boolean(value));
  const memoryEventIds = sources
    .map((source) => source.memoryEventId)
    .filter((value): value is string => Boolean(value));
  const lcmNodeIds = sources
    .map((source) => source.lcmNodeId)
    .filter((value): value is string => Boolean(value));
  const projectSourceRevisionIds = sources
    .map((source) => source.projectSourceRevisionId)
    .filter((value): value is string => Boolean(value));
  const projectWorkItemIds = sources
    .map((source) => source.projectWorkItemId)
    .filter((value): value is string => Boolean(value));

  if (conversationItemIds.length > 0) {
    const result = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from conversation_items
        where id = any($1::uuid[])
          and owner_user_id = $2
          and visibility = 'personal'
          and personal_deleted_at is null
          and memory_excluded_at is null
      `,
      [conversationItemIds, actor.userId]
    );
    if (
      Number(result.rows[0]?.count ?? 0) !== new Set(conversationItemIds).size
    ) {
      throw visibilityError(
        "Curated Memory source conversation item is not visible"
      );
    }
  }

  if (memoryEventIds.length > 0) {
    const result = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from memory_events
        where id = any($1::uuid[])
          and owner_user_id = $2
          and visibility = 'personal'
          and invalidated_at is null
          and personal_deleted_at is null
      `,
      [memoryEventIds, actor.userId]
    );
    if (Number(result.rows[0]?.count ?? 0) !== new Set(memoryEventIds).size) {
      throw visibilityError(
        "Curated Memory source Memory Event is not visible"
      );
    }
  }

  if (lcmNodeIds.length > 0) {
    const result = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from memory_nodes
        where id = any($1::uuid[])
          and owner_user_id = $2
          and visibility = 'personal'
          and invalidated_at is null
          and personal_deleted_at is null
      `,
      [lcmNodeIds, actor.userId]
    );
    if (Number(result.rows[0]?.count ?? 0) !== new Set(lcmNodeIds).size) {
      throw visibilityError("Curated Memory source LCM Summary is not visible");
    }
  }
  if (projectSourceRevisionIds.length) {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count
         from project_source_revisions revision
         join project_sources source on source.id=revision.source_id
           and source.owner_user_id=revision.owner_user_id
         join personal_note_revisions note_revision
           on note_revision.id=revision.note_revision_id
          and note_revision.owner_user_id=revision.owner_user_id
          and note_revision.forgotten_at is null
          and note_revision.projection_state='available'
         join personal_notes note on note.id=note_revision.note_id
          and note.owner_user_id=revision.owner_user_id
          and note.lifecycle='active'
         join projects project on project.id=source.project_id
           and project.owner_user_id=source.owner_user_id
        where revision.id=any($1::uuid[]) and revision.owner_user_id=$2
          and revision.state='ready' and revision.note_revision_id is not null
          and source.kind='doc' and source.status='ready'
          and source.deleted_at is null and source.remove_batch_id is null
          and project.lifecycle='active' and project.deletion_phase is null`,
      [projectSourceRevisionIds, actor.userId]
    );
    if (
      Number(result.rows[0]?.count ?? 0) !==
      new Set(projectSourceRevisionIds).size
    )
      throw visibilityError(
        "Curated Project Source Note revision is unavailable"
      );
  }
  if (projectWorkItemIds.length) {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count from project_work_items work_item
         join projects project on project.id=work_item.project_id
           and project.owner_user_id=work_item.owner_user_id
        where work_item.id=any($1::uuid[]) and work_item.owner_user_id=$2
          and work_item.deleted_at is null
          and project.lifecycle='active' and project.deletion_phase is null`,
      [projectWorkItemIds, actor.userId]
    );
    if (Number(result.rows[0]?.count ?? 0) !== new Set(projectWorkItemIds).size)
      throw visibilityError("Curated Work Item is unavailable");
  }
};

export const createCuratedMemoryPolicyMethods = ({
  pool,
  envelopeEncryptionProvider,
  onCuratedMemoryChanged
}: CuratedMemoryRepositoryContext): Pick<
  CuratedMemoryRepository,
  | "suppressCuratedMemoryAssertion"
  | "unsuppressCuratedMemoryAssertion"
  | "reconcileCuratedMemoryLifecycle"
> => ({
  async suppressCuratedMemoryAssertion(actor, assertionId, input) {
    const client = await pool.connect();
    let hydrated: Awaited<ReturnType<typeof getAssertionByIdWithClient>> = null;
    try {
      await client.query("begin");
      const existing = await getAssertionByIdWithClient(
        client,
        actor,
        envelopeEncryptionProvider,
        assertionId
      );
      if (!existing) {
        await client.query("commit");
      } else {
        const protectPayload = protectedCuratedMemoryPayloadsRequired();
        const result = await client.query<{ id: string }>(
          `
          update curated_memory_assertions
          set status = $4::curated_memory_assertion_status,
              suppressed_at = case when $4::curated_memory_assertion_status = 'suppressed' then now() else suppressed_at end,
              suppressed_by_user_id = case when $4::curated_memory_assertion_status = 'suppressed' then $2 else suppressed_by_user_id end,
              suppression_reason = $3,
              updated_at = now()
          where id = $1
            and owner_user_id = $2
            and visibility = 'personal'
          returning id
        `,
          [
            assertionId,
            actor.userId,
            protectPayload && input.reason
              ? ENCRYPTED_CURATED_MEMORY_TEXT
              : (input.reason ?? null),
            input.status ?? "suppressed"
          ]
        );
        const id = result.rows[0]?.id;
        if (protectPayload && id) {
          await persistCuratedMemoryPayload(
            client,
            actor,
            envelopeEncryptionProvider,
            {
              sourceTable: "curated_memory_assertions",
              sourceId: id,
              plaintext: {
                assertionText: existing.assertionText,
                normalizedAssertion: existing.normalizedAssertion,
                tags: existing.tags,
                metadata: existing.metadata,
                suppressionReason: input.reason ?? null
              }
            }
          );
        }
        hydrated = id
          ? await getAssertionByIdWithClient(
              client,
              actor,
              envelopeEncryptionProvider,
              id
            )
          : null;
        if (id) {
          await onCuratedMemoryChanged?.(actor, client, [id]);
        }
        await client.query("commit");
      }
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return hydrated;
  },

  async unsuppressCuratedMemoryAssertion(actor, assertionId, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `select id from curated_memory_assertions
          where id=$1 and owner_user_id=$2 and visibility='personal' for update`,
        [assertionId, actor.userId]
      );
      const existing = await getAssertionByIdWithClient(
        client,
        actor,
        envelopeEncryptionProvider,
        assertionId
      );
      if (!existing) {
        await client.query("commit");
        return null;
      }
      // The database timestamp and owner are authoritative. This conditional
      // update also serializes Undo against a second suppression or source loss.
      const result = await client.query<{ id: string }>(
        `update curated_memory_assertions cma
            set status='current', suppressed_at=null,
                suppressed_by_user_id=null, suppression_reason=null,
                updated_at=now()
          where cma.id=$1 and cma.owner_user_id=$2
            and cma.visibility='personal' and cma.status='suppressed'
            and cma.suppressed_by_user_id=$2
            and ((extract(epoch from cma.suppressed_at) * 1000000)::bigint)::text=$3
            and cma.suppressed_at > now() - interval '7 days'
            and cma.suppressed_at <= now()
            and cma.superseded_by_assertion_id is null
            and cma.conflict_with_assertion_id is null
            and (cma.expires_at is null or cma.expires_at > now())
            and ${activeCuratedMemoryEvidencePredicate("cma")}
            and not exists (
              select 1 from chat_forget_operations forget,
                jsonb_to_recordset(forget.assertion_snapshots)
                  as snapshot(id uuid, "suppressedAt" timestamptz)
              where forget.owner_user_id=$2 and forget.state='complete'
                and snapshot.id=cma.id
                and snapshot."suppressedAt"=cma.suppressed_at
            )
          returning cma.id`,
        [assertionId, actor.userId, input.suppressionToken]
      );
      if (!result.rows[0]) {
        throw Object.assign(new Error("Curated Memory Undo is unavailable"), {
          statusCode: 409
        });
      }
      if (protectedCuratedMemoryPayloadsRequired()) {
        await persistCuratedMemoryPayload(
          client,
          actor,
          envelopeEncryptionProvider,
          {
            sourceTable: "curated_memory_assertions",
            sourceId: assertionId,
            plaintext: {
              assertionText: existing.assertionText,
              normalizedAssertion: existing.normalizedAssertion,
              tags: existing.tags,
              metadata: existing.metadata,
              suppressionReason: null
            }
          }
        );
      }
      await onCuratedMemoryChanged?.(actor, client, [assertionId]);
      const restored = await getAssertionByIdWithClient(
        client,
        actor,
        envelopeEncryptionProvider,
        assertionId
      );
      await client.query("commit");
      return restored;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async reconcileCuratedMemoryLifecycle(actor) {
    const client = await pool.connect();
    let assertionsSuppressed: number;
    try {
      await client.query("begin");
      const suppressed =
        await suppressCuratedMemoryWithoutActiveEvidenceWithClient(
          client,
          actor,
          envelopeEncryptionProvider
        );
      if (suppressed.length > 0) {
        await onCuratedMemoryChanged?.(actor, client, suppressed);
      }
      await client.query("commit");
      assertionsSuppressed = suppressed.length;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return { assertionsSuppressed };
  }
});
