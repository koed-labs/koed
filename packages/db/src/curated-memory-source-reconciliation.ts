import type { CuratedMemoryRepository } from "./curated-memory-repository.js";
import {
  activeCuratedMemoryEvidencePredicate,
  suppressCuratedMemoryWithoutActiveEvidenceWithClient
} from "./curated-memory-policy.js";
import {
  encryptedCuratedMemoryJson,
  persistCuratedMemoryPayload,
  positiveLimit,
  protectedCuratedMemoryPayloadsRequired,
  requireEncryptionProvider,
  type CuratedMemoryRepositoryContext
} from "./curated-memory-support.js";

export const createCuratedMemorySourceReconciliationMethods = ({
  pool,
  envelopeEncryptionProvider,
  onCuratedMemoryChanged
}: CuratedMemoryRepositoryContext): Pick<
  CuratedMemoryRepository,
  "reconcileCuratedMemorySources"
> => ({
  async reconcileCuratedMemorySources(actor, input = {}) {
    const limit = positiveLimit(input.limit, 100);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await suppressCuratedMemoryWithoutActiveEvidenceWithClient(
        client,
        actor,
        envelopeEncryptionProvider
      );
      const assertionRows = await client.query<{ id: string }>(
        `
          select id
          from curated_memory_assertions
          where owner_user_id = $1
            and visibility = 'personal'
            and status = 'current'
            and suppressed_at is null
            and ${activeCuratedMemoryEvidencePredicate("curated_memory_assertions")}
          order by coalesce(last_reconciled_at, 'epoch'::timestamptz) asc, id asc
          limit $2
          for update skip locked
        `,
        [actor.userId, limit]
      );
      const assertionIds = assertionRows.rows.map((row) => row.id);
      if (assertionIds.length === 0) {
        await client.query("commit");
        return {
          assertionsScanned: 0,
          memoryEventLinksAdded: 0,
          lcmSummaryLinksAdded: 0
        };
      }
      const protectPayload = protectedCuratedMemoryPayloadsRequired();
      if (protectPayload) {
        requireEncryptionProvider(envelopeEncryptionProvider);
      }
      const sourceMetadata = {
        reconciledBy: "curated-memory-source-reconciliation-v1"
      };
      const memoryEventLinks = await client.query<{ id: string }>(
        `
          with candidate_links as (
            select distinct
              cms.assertion_id,
              mes.memory_event_id
            from curated_memory_sources cms
            join memory_event_sources mes
              on mes.conversation_item_id = cms.conversation_item_id
            join memory_events me
              on me.id = mes.memory_event_id
              and me.owner_user_id = $2
              and me.visibility = 'personal'
              and me.invalidated_at is null
              and me.personal_deleted_at is null
            where cms.assertion_id = any($1::uuid[])
              and cms.source_type = 'conversation_item'
              and not exists (
                select 1
                from curated_memory_sources existing
                where existing.assertion_id = cms.assertion_id
                  and existing.source_type = 'memory_event'
                  and existing.memory_event_id = mes.memory_event_id
              )
          )
          insert into curated_memory_sources (
            assertion_id,
            source_type,
            source_role,
            memory_event_id,
            metadata
          )
          select
            assertion_id,
            'memory_event',
            'derived_bundle',
            memory_event_id,
            $3::jsonb
          from candidate_links
          on conflict do nothing
          returning id
        `,
        [
          assertionIds,
          actor.userId,
          JSON.stringify(
            protectPayload ? encryptedCuratedMemoryJson : sourceMetadata
          )
        ]
      );
      const lcmLinks = await client.query<{ id: string }>(
        `
          with candidate_links as (
            select distinct
              cms.assertion_id,
              mns.memory_node_id
            from curated_memory_sources cms
            join memory_node_sources mns
              on (
                (cms.source_type = 'memory_event' and mns.memory_event_id = cms.memory_event_id)
                or (cms.source_type = 'lcm_summary' and false)
              )
            join memory_nodes mn
              on mn.id = mns.memory_node_id
              and mn.owner_user_id = $2
              and mn.visibility = 'personal'
              and mn.invalidated_at is null
              and mn.personal_deleted_at is null
            where cms.assertion_id = any($1::uuid[])
              and not exists (
                select 1
                from curated_memory_sources existing
                where existing.assertion_id = cms.assertion_id
                  and existing.source_type = 'lcm_summary'
                  and existing.lcm_node_id = mns.memory_node_id
              )
          )
          insert into curated_memory_sources (
            assertion_id,
            source_type,
            source_role,
            lcm_node_id,
            metadata
          )
          select
            assertion_id,
            'lcm_summary',
            'derived_summary',
            memory_node_id,
            $3::jsonb
          from candidate_links
          on conflict do nothing
          returning id
        `,
        [
          assertionIds,
          actor.userId,
          JSON.stringify(
            protectPayload ? encryptedCuratedMemoryJson : sourceMetadata
          )
        ]
      );
      if (protectPayload) {
        for (const row of [...memoryEventLinks.rows, ...lcmLinks.rows]) {
          await persistCuratedMemoryPayload(
            client,
            actor,
            envelopeEncryptionProvider,
            {
              sourceTable: "curated_memory_sources",
              sourceId: row.id,
              plaintext: { metadata: sourceMetadata }
            }
          );
        }
      }
      await client.query(
        `
          update curated_memory_assertions
          set last_reconciled_at = now(),
              reconciliation_status = 'reconciled',
              updated_at = now()
          where id = any($1::uuid[])
            and owner_user_id = $2
        `,
        [assertionIds, actor.userId]
      );
      await onCuratedMemoryChanged?.(actor, client);
      await client.query("commit");
      return {
        assertionsScanned: assertionIds.length,
        memoryEventLinksAdded: memoryEventLinks.rowCount ?? 0,
        lcmSummaryLinksAdded: lcmLinks.rowCount ?? 0
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});
