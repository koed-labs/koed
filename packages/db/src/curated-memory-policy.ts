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

export const activeCuratedMemoryEvidencePredicate = (
  assertionAlias: string
): string => `
  exists (
    select 1
    from curated_memory_sources active_cms
    left join conversation_items active_ci
      on active_ci.id = active_cms.conversation_item_id
      and active_ci.owner_user_id = ${assertionAlias}.owner_user_id
      and active_ci.visibility = 'personal'
      and active_ci.personal_deleted_at is null
    left join memory_events active_me
      on active_me.id = active_cms.memory_event_id
      and active_me.owner_user_id = ${assertionAlias}.owner_user_id
      and active_me.visibility = 'personal'
      and active_me.invalidated_at is null
      and active_me.personal_deleted_at is null
    left join memory_nodes active_mn
      on active_mn.id = active_cms.lcm_node_id
      and active_mn.owner_user_id = ${assertionAlias}.owner_user_id
      and active_mn.visibility = 'personal'
      and active_mn.invalidated_at is null
      and active_mn.personal_deleted_at is null
    where active_cms.assertion_id = ${assertionAlias}.id
      and active_cms.source_role in (
        'primary_evidence',
        'supporting_evidence',
        'superseding_evidence',
        'conflicting_evidence'
      )
      and coalesce(active_ci.id, active_me.id, active_mn.id) is not null
  )
`;

export const suppressCuratedMemoryWithoutActiveEvidenceWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  provider: EnvelopeEncryptionProvider | undefined
): Promise<string[]> => {
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
        and not ${activeCuratedMemoryEvidencePredicate("cma")}
      returning cma.id
    `,
    [
      actor.userId,
      protectPayload
        ? ENCRYPTED_CURATED_MEMORY_TEXT
        : "Final active source evidence was deleted"
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

  if (conversationItemIds.length > 0) {
    const result = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from conversation_items
        where id = any($1::uuid[])
          and owner_user_id = $2
          and visibility = 'personal'
          and personal_deleted_at is null
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
};

export const createCuratedMemoryPolicyMethods = ({
  pool,
  envelopeEncryptionProvider
}: CuratedMemoryRepositoryContext): Pick<
  CuratedMemoryRepository,
  "suppressCuratedMemoryAssertion" | "reconcileCuratedMemoryLifecycle"
> => ({
  async suppressCuratedMemoryAssertion(actor, assertionId, input) {
    const client = await pool.connect();
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
        return null;
      }
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
      const hydrated = id
        ? await getAssertionByIdWithClient(
            client,
            actor,
            envelopeEncryptionProvider,
            id
          )
        : null;
      await client.query("commit");
      return hydrated;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async reconcileCuratedMemoryLifecycle(actor) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const suppressed =
        await suppressCuratedMemoryWithoutActiveEvidenceWithClient(
          client,
          actor,
          envelopeEncryptionProvider
        );
      await client.query("commit");
      return { assertionsSuppressed: suppressed.length };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});
