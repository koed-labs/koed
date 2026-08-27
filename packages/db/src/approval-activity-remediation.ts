import type pg from "pg";
import {
  classifyApprovalActivity,
  crossIdentitySyncDeterministicUuid
} from "@koed/shared";

import { invalidateDerivedMemoryForMemoryEvents } from "./derived-memory-invalidation.js";
import { approvalConversationItemSql } from "./approval-activity-sql.js";

export interface ApprovalActivityInventoryScope {
  ownerUserId?: string;
  sessionId?: string;
  recordLimit?: number;
}

export interface ApprovalActivityInventoryReport {
  classifierVersion: 1;
  scope: { ownerUserId: string | null; sessionId: string | null };
  bounded: { recordLimit: number; truncated: boolean };
  canonical: {
    approvalActivityRecords: number;
    ambiguousRecords: number;
    recordBytes: number;
    sampleRecordIds: string[];
    ambiguousRecordIds: string[];
  };
  affected: {
    memoryEvents: number;
    embeddingRecords: number;
    queuedProjectionWork: number;
    lcmNodes: number;
    semanticOwnerPrivateReplicas: number;
    continuousShares: number;
    snapshotShares: number;
    ambiguousSnapshotShares: number;
  };
  exemptExactSource: {
    conversationSourceAccessGrants: number;
    conversationSourceArtifacts: number;
  };
}

export interface ApprovalActivityCorrectionResult {
  status: "corrected" | "unchanged";
  conversationItemsExcluded: number;
  memoryEventsInvalidated: number;
  queuedProjectionWorkRemoved: number;
  snapshotShareGrantsRevoked: number;
  continuousShareGrantsQuarantined: number;
  continuousRepresentationsQuarantined: number;
  continuousRepresentationRebuildsQueued: number;
}

type CandidateRow = {
  id: string;
  owner_user_id: string;
  session_id: string | null;
  metadata: Record<string, unknown> | null;
  raw_json: unknown;
  raw_text: string | null;
};

const boundedLimit = (value: number | undefined): number =>
  Math.min(Math.max(value ?? 10_000, 1), 10_000);

const candidateRows = async (
  client: pg.Pool | pg.PoolClient,
  scope: ApprovalActivityInventoryScope
) => {
  const limit = boundedLimit(scope.recordLimit);
  const result = await client.query<CandidateRow>(
    `select id,owner_user_id,session_id,metadata,raw_json,raw_text
       from conversation_items ci
      where visibility='personal'
        and personal_deleted_at is null
        and ($1::uuid is null or owner_user_id=$1)
        and ($2::uuid is null or session_id=$2)
        and ${approvalConversationItemSql("ci")}
      order by owner_user_id,session_id nulls last,source_sequence nulls last,id
      limit $3`,
    [scope.ownerUserId ?? null, scope.sessionId ?? null, limit + 1]
  );
  return {
    rows: result.rows.slice(0, limit),
    truncated: result.rows.length > limit,
    limit
  };
};

const affectedEventIds = async (
  client: pg.Pool | pg.PoolClient,
  itemIds: string[]
): Promise<string[]> => {
  if (itemIds.length === 0) return [];
  const result = await client.query<{ id: string }>(
    `select distinct me.id
       from memory_events me
       join memory_event_sources mes on mes.memory_event_id=me.id
      where mes.conversation_item_id=any($1::uuid[])
        and me.invalidated_at is null
        and me.personal_deleted_at is null
      order by me.id`,
    [itemIds]
  );
  return result.rows.map((row) => row.id);
};

const scalarCounts = async (
  client: pg.Pool | pg.PoolClient,
  eventIds: string[],
  sessionIds: string[]
) => {
  const result = await client.query<Record<string, number>>(
    `with recursive affected_nodes as (
       select distinct mns.memory_node_id as id
         from memory_node_sources mns
        where mns.memory_event_id=any($1::uuid[])
       union
       select child.parent_memory_node_id
         from memory_node_children child
         join affected_nodes affected on affected.id=child.child_memory_node_id
     )
     select
       (select count(*)::int from memory_embeddings where invalidated_at is null and (memory_event_id=any($1::uuid[]) or memory_node_id in (select id from affected_nodes))) as embeddings,
       (select count(*)::int from conversation_projection_processing_outbox where event_id=any($1::uuid[])) as queued,
       (select count(*)::int from affected_nodes) as nodes,
       (select count(distinct sem.sync_relationship_id)::int from sync_event_mappings sem where sem.local_memory_event_id=any($1::uuid[]) and sem.active=true and sem.invalidated_at is null) as replicas,
       (select count(*)::int
          from team_memory_share_grants share_grant
          join source_owner_representation_consents consent on consent.id=share_grant.consent_id
          join local_captured_session_logical_memories local_memory
            on local_memory.logical_memory_id=share_grant.logical_memory_id
         where local_memory.local_session_id=any($2::uuid[])
           and consent.mode='continuous' and share_grant.lifecycle='active') as continuous_shares,
       (select count(distinct share_grant.id)::int
          from team_memory_share_grants share_grant
          join source_owner_representation_consents consent on consent.id=share_grant.consent_id
          join local_captured_session_logical_memories local_memory
            on local_memory.logical_memory_id=share_grant.logical_memory_id
          join memory_events event on event.id=any($1::uuid[])
          left join lateral (
            select max(mapping.source_cursor) as upsert_cursor
              from sync_event_mappings mapping
             where mapping.local_memory_event_id=event.id
               and mapping.active=true and mapping.invalidated_at is null
          ) semantic on true
         where local_memory.local_session_id=event.session_id
           and consent.mode='snapshot'
           and share_grant.lifecycle='active'
           and semantic.upsert_cursor is not null
           and semantic.upsert_cursor <= consent.source_revision) as snapshot_shares,
       (select count(distinct share_grant.id)::int
          from team_memory_share_grants share_grant
          join source_owner_representation_consents consent on consent.id=share_grant.consent_id
          join local_captured_session_logical_memories local_memory
            on local_memory.logical_memory_id=share_grant.logical_memory_id
          join memory_events event on event.id=any($1::uuid[])
          left join lateral (
            select max(mapping.source_cursor) as upsert_cursor
              from sync_event_mappings mapping
             where mapping.local_memory_event_id=event.id
               and mapping.active=true and mapping.invalidated_at is null
          ) semantic on true
         where local_memory.local_session_id=event.session_id
           and consent.mode='snapshot'
           and share_grant.lifecycle='active'
           and semantic.upsert_cursor is null) as ambiguous_snapshot_shares,
       (select count(*)::int
          from team_conversation_source_grants source_grant
          join team_memory_share_grants share_grant on share_grant.id=source_grant.share_grant_id
          join local_captured_session_logical_memories local_memory
            on local_memory.logical_memory_id=share_grant.logical_memory_id
         where local_memory.local_session_id=any($2::uuid[])
           and source_grant.lifecycle='active') as source_grants,
       (select count(*)::int from conversation_source_artifacts artifact where artifact.session_id=any($2::uuid[]) and artifact.lifecycle='active') as source_artifacts`,
    [eventIds, sessionIds]
  );
  return result.rows[0] ?? {};
};

export const inventoryApprovalActivity = async (
  client: pg.Pool | pg.PoolClient,
  scope: ApprovalActivityInventoryScope = {}
): Promise<ApprovalActivityInventoryReport> => {
  const candidates = await candidateRows(client, scope);
  const classified: CandidateRow[] = [];
  const ambiguous: CandidateRow[] = [];
  for (const row of candidates.rows) {
    const classification = classifyApprovalActivity({ metadata: row.metadata });
    if (!classification || classification.kind === "unknown_approval_record") {
      ambiguous.push(row);
    } else {
      classified.push(row);
    }
  }
  const eventIds = await affectedEventIds(
    client,
    classified.map((row) => row.id)
  );
  const sessionIds = [
    ...new Set(
      classified.flatMap((row) => (row.session_id ? [row.session_id] : []))
    )
  ];
  const counts = await scalarCounts(client, eventIds, sessionIds);
  return {
    classifierVersion: 1,
    scope: {
      ownerUserId: scope.ownerUserId ?? null,
      sessionId: scope.sessionId ?? null
    },
    bounded: { recordLimit: candidates.limit, truncated: candidates.truncated },
    canonical: {
      approvalActivityRecords: classified.length,
      ambiguousRecords: ambiguous.length,
      recordBytes: classified.reduce(
        (total, row) =>
          total +
          Buffer.byteLength(JSON.stringify(row.raw_json), "utf8") +
          Buffer.byteLength(row.raw_text ?? "", "utf8"),
        0
      ),
      sampleRecordIds: classified.slice(0, 100).map((row) => row.id),
      ambiguousRecordIds: ambiguous.slice(0, 100).map((row) => row.id)
    },
    affected: {
      memoryEvents: eventIds.length,
      embeddingRecords: Number(counts.embeddings ?? 0),
      queuedProjectionWork: Number(counts.queued ?? 0),
      lcmNodes: Number(counts.nodes ?? 0),
      semanticOwnerPrivateReplicas: Number(counts.replicas ?? 0),
      continuousShares: Number(counts.continuous_shares ?? 0),
      snapshotShares: Number(counts.snapshot_shares ?? 0),
      ambiguousSnapshotShares: Number(counts.ambiguous_snapshot_shares ?? 0)
    },
    exemptExactSource: {
      conversationSourceAccessGrants: Number(counts.source_grants ?? 0),
      conversationSourceArtifacts: Number(counts.source_artifacts ?? 0)
    }
  };
};

export const correctApprovalActivity = async (
  pool: pg.Pool,
  scope: ApprovalActivityInventoryScope = {}
): Promise<ApprovalActivityCorrectionResult> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('approval-activity-remediation',0))"
    );
    const candidates = await candidateRows(client, scope);
    const classified = candidates.rows.filter((row) => {
      const value = classifyApprovalActivity({ metadata: row.metadata });
      return value && value.kind !== "unknown_approval_record";
    });
    const ambiguous = candidates.rows.filter((row) => {
      const value = classifyApprovalActivity({ metadata: row.metadata });
      return !value || value.kind === "unknown_approval_record";
    });
    if (candidates.truncated || ambiguous.length > 0) {
      throw Object.assign(
        new Error(
          candidates.truncated
            ? "Approval Activity remediation scope exceeds its bounded inventory"
            : "Approval Activity remediation requires Operator review of ambiguous records"
        ),
        {
          code: "approval_activity_remediation_ambiguous",
          ambiguousRecordIds: ambiguous.map((row) => row.id)
        }
      );
    }
    const itemIds = classified.map((row) => row.id);
    const eventIds = await affectedEventIds(client, itemIds);
    const excluded = itemIds.length
      ? await client.query(
          `update conversation_items
              set memory_excluded_at=coalesce(memory_excluded_at,now()),
                  memory_exclusion_reason=coalesce(memory_exclusion_reason,'approval_activity_policy_v1'),
                  projection_status='projected',projection_error=null,projected_at=coalesce(projected_at,now())
            where id=any($1::uuid[])
              and (memory_excluded_at is null
                or memory_exclusion_reason is null
                or projection_status<>'projected'
                or projection_error is not null
                or projected_at is null)`,
          [itemIds]
        )
      : { rowCount: 0 };
    const invalidated = eventIds.length
      ? await client.query(
          `update memory_events
              set invalidated_at=coalesce(invalidated_at,now()),
                  invalidation_reason=coalesce(invalidation_reason,'approval_activity_policy_v1'),
                  include_in_embedding=false,include_in_lcm=false,updated_at=now()
            where id=any($1::uuid[]) and invalidated_at is null`,
          [eventIds]
        )
      : { rowCount: 0 };
    const queued = eventIds.length
      ? await client.query(
          "delete from conversation_projection_processing_outbox where event_id=any($1::uuid[])",
          [eventIds]
        )
      : { rowCount: 0 };
    await invalidateDerivedMemoryForMemoryEvents(
      client,
      eventIds,
      "approval_activity_policy_v1"
    );
    const ambiguousSnapshots = eventIds.length
      ? await client.query<{ id: string }>(
          `select distinct share_grant.id
             from team_memory_share_grants share_grant
             join source_owner_representation_consents consent on consent.id=share_grant.consent_id
             join local_captured_session_logical_memories local_memory
               on local_memory.logical_memory_id=share_grant.logical_memory_id
             join memory_events event on event.id=any($1::uuid[])
             left join lateral (
               select max(mapping.source_cursor) as upsert_cursor
                 from sync_event_mappings mapping
                where mapping.local_memory_event_id=event.id
                  and mapping.active=true and mapping.invalidated_at is null
             ) semantic on true
            where local_memory.local_session_id=event.session_id
              and consent.mode='snapshot'
              and share_grant.lifecycle='active'
              and semantic.upsert_cursor is null
            order by share_grant.id`,
          [eventIds]
        )
      : { rows: [] };
    if (ambiguousSnapshots.rows.length > 0) {
      throw Object.assign(
        new Error(
          "Approval Activity remediation requires Operator review of ambiguous snapshot revisions"
        ),
        {
          code: "approval_activity_remediation_ambiguous",
          ambiguousSnapshotGrantIds: ambiguousSnapshots.rows.map(
            (row) => row.id
          )
        }
      );
    }
    const revoked = eventIds.length
      ? await client.query<{
          id: string;
          owner_user_id: string;
          team_id: string;
          team_workspace_id: string;
          logical_memory_id: string;
        }>(
          `update team_memory_share_grants as share_grant
              set lifecycle='revoked',revoked_at=coalesce(share_grant.revoked_at,now()),
                  revocation_reason='approval_content_remediation',
                  revoked_by_user_id=coalesce(share_grant.revoked_by_user_id,share_grant.owner_user_id),
                  grant_version=share_grant.grant_version+1,
                  revocation_epoch=share_grant.revocation_epoch+1,updated_at=now()
             from source_owner_representation_consents consent,
                  local_captured_session_logical_memories local_memory
            where consent.id=share_grant.consent_id
              and local_memory.logical_memory_id=share_grant.logical_memory_id
              and consent.mode='snapshot'
              and share_grant.lifecycle='active'
              and exists (
                select 1
                  from memory_events event
                  join lateral (
                    select max(mapping.source_cursor) as upsert_cursor
                      from sync_event_mappings mapping
                     where mapping.local_memory_event_id=event.id
                       and mapping.active=true and mapping.invalidated_at is null
                  ) semantic on true
                 where event.id=any($1::uuid[])
                   and event.session_id=local_memory.local_session_id
                   and semantic.upsert_cursor is not null
                   and semantic.upsert_cursor <= consent.source_revision
              )
          returning share_grant.id,share_grant.owner_user_id,
                    share_grant.team_id,share_grant.team_workspace_id,
                    share_grant.logical_memory_id`,
          [eventIds]
        )
      : { rowCount: 0, rows: [] };
    for (const shareGrant of revoked.rows) {
      const mutationId = crossIdentitySyncDeterministicUuid({
        kind: "approval_activity_snapshot_remediation",
        shareGrantId: shareGrant.id,
        policy: "approval_activity_policy_v1"
      });
      await client.query(
        `insert into audit_events
           (actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata)
         values ($1,$1,'personal','shared_memory.snapshot.remediated',
                 'team_memory_share_grants',$2,$3::jsonb)`,
        [
          shareGrant.owner_user_id,
          shareGrant.id,
          JSON.stringify({
            mutationId,
            reasonCode: "approval_content_remediation",
            teamId: shareGrant.team_id,
            teamWorkspaceId: shareGrant.team_workspace_id,
            logicalMemoryId: shareGrant.logical_memory_id
          })
        ]
      );
      await client.query(
        `insert into collaboration_outbox (
           protocol_version,family,scope,team_id,team_workspace_id,
           share_grant_id,logical_memory_id,resource_type,resource_id,
           actor_principal_id,mutation_id,replay_until
         ) values (1,'access_revoked','team',$1,$2,$3,$4,
                   'team_memory_share_grants',$3,$5,$6,now()+interval '30 days')
         on conflict (mutation_id,family) do nothing`,
        [
          shareGrant.team_id,
          shareGrant.team_workspace_id,
          shareGrant.id,
          shareGrant.logical_memory_id,
          shareGrant.owner_user_id,
          mutationId
        ]
      );
      await client.query(
        `select pg_notify(
           'koed_collaboration_realtime',
           json_build_object(
             'scope','team','teamId',$1::uuid,
             'cursor',(select cursor from collaboration_outbox
                        where mutation_id=$2 and family='access_revoked'),
             'family','access_revoked'
           )::text
         )`,
        [shareGrant.team_id, mutationId]
      );
    }
    const quarantined = eventIds.length
      ? await client.query<{
          id: string;
          owner_user_id: string;
          team_id: string;
          team_workspace_id: string;
          logical_memory_id: string;
        }>(
          `update team_memory_share_grants as share_grant
              set lifecycle='unavailable',grant_version=grant_version+1,
                  updated_at=now()
             from source_owner_representation_consents consent,
                  local_captured_session_logical_memories local_memory
            where consent.id=share_grant.consent_id
              and local_memory.logical_memory_id=share_grant.logical_memory_id
              and consent.mode='continuous'
              and share_grant.lifecycle='active'
              and exists (
                select 1 from memory_events event
                 where event.id=any($1::uuid[])
                   and event.session_id=local_memory.local_session_id
              )
          returning share_grant.id,share_grant.owner_user_id,
                    share_grant.team_id,share_grant.team_workspace_id,
                    share_grant.logical_memory_id`,
          [eventIds]
        )
      : { rowCount: 0, rows: [] };
    let quarantinedRepresentations = 0;
    let continuousRebuildsQueued = 0;
    for (const shareGrant of quarantined.rows) {
      const representations = await client.query<{ id: string }>(
        `update team_memory_representations
            set state='invalidated',invalidated_at=now(),updated_at=now(),
                record_version=record_version+1,
                invalidation_reason_code='approval_content_remediation'
          where share_grant_id=$1 and state in ('pending','available','stale')
          returning id`,
        [shareGrant.id]
      );
      quarantinedRepresentations += representations.rows.length;
      await client.query(
        `delete from team_memory_semantic_items where share_grant_id=$1`,
        [shareGrant.id]
      );
      const pendingShares = await client.query<{
        id: string;
        owner_user_id: string;
        operation_version: number;
      }>(
        `update pending_share_operations
            set state='needs_attention',source_update_state='failed',
                redacted_failure_code='approval_content_remediation',
                updated_at=now(),operation_version=operation_version+1
          where grant_id=$1 and state='activated' and revoked_at is null
          returning id,owner_user_id,operation_version`,
        [shareGrant.id]
      );
      for (const pendingShare of pendingShares.rows) {
        await client.query(
          `update pending_share_outbox
              set state='completed',locked_at=null,updated_at=now()
            where pending_share_id=$1`,
          [pendingShare.id]
        );
        const ownerMutationId = crossIdentitySyncDeterministicUuid({
          kind: "pending_share_lifecycle",
          pendingShareId: pendingShare.id,
          state: "needs_attention",
          reason: "approval_content_remediation",
          operationVersion: Number(pendingShare.operation_version)
        });
        await client.query(
          `insert into collaboration_outbox (
             protocol_version,family,scope,personal_owner_user_id,
             resource_type,resource_id,actor_principal_id,mutation_id,replay_until
           ) values (1,'pending_share_lifecycle','personal',$1,
                     'pending_share_operations',$2,$1,$3,now()+interval '30 days')
           on conflict (mutation_id,family) do nothing`,
          [pendingShare.owner_user_id, pendingShare.id, ownerMutationId]
        );
        await client.query(
          `select pg_notify(
             'koed_collaboration_realtime',
             json_build_object(
               'scope','personal','ownerUserId',$1::uuid,
               'cursor',(select cursor from collaboration_outbox
                          where mutation_id=$2 and family='pending_share_lifecycle'),
               'family','pending_share_lifecycle'
             )::text
           )`,
          [pendingShare.owner_user_id, ownerMutationId]
        );
        continuousRebuildsQueued += 1;
      }
      const grantMutationId = crossIdentitySyncDeterministicUuid({
        kind: "approval_activity_continuous_quarantine",
        shareGrantId: shareGrant.id,
        policy: "approval_activity_policy_v1"
      });
      await client.query(
        `insert into audit_events
           (actor_user_id,owner_user_id,visibility,action,target_table,target_id,metadata)
         values ($1,$1,'personal','shared_memory.continuous.quarantined',
                 'team_memory_share_grants',$2,$3::jsonb)`,
        [
          shareGrant.owner_user_id,
          shareGrant.id,
          JSON.stringify({
            mutationId: grantMutationId,
            reasonCode: "approval_content_remediation",
            representationCount: representations.rows.length
          })
        ]
      );
      for (const representation of representations.rows) {
        await client.query(
          `insert into collaboration_outbox (
             protocol_version,family,scope,team_id,team_workspace_id,
             share_grant_id,logical_memory_id,resource_type,resource_id,
             actor_principal_id,mutation_id,replay_until
           ) values (1,'fidelity_changed','team',$1,$2,$3,$4,
                     'team_memory_representation',$5,$6,$7,now()+interval '30 days')
           on conflict (mutation_id,family) do nothing`,
          [
            shareGrant.team_id,
            shareGrant.team_workspace_id,
            shareGrant.id,
            shareGrant.logical_memory_id,
            representation.id,
            shareGrant.owner_user_id,
            crossIdentitySyncDeterministicUuid({
              kind: "approval_activity_semantic_representation_deleted",
              shareGrantId: shareGrant.id,
              representationId: representation.id
            })
          ]
        );
      }
      await client.query(
        `insert into collaboration_outbox (
           protocol_version,family,scope,team_id,team_workspace_id,
           share_grant_id,logical_memory_id,resource_type,resource_id,
           actor_principal_id,mutation_id,replay_until
         ) values (1,'share_grant_lifecycle','team',$1,$2,$3,$4,
                   'team_memory_share_grant',$3,$5,$6,now()+interval '30 days')
         on conflict (mutation_id,family) do nothing`,
        [
          shareGrant.team_id,
          shareGrant.team_workspace_id,
          shareGrant.id,
          shareGrant.logical_memory_id,
          shareGrant.owner_user_id,
          grantMutationId
        ]
      );
      await client.query(
        `select pg_notify(
           'koed_collaboration_realtime',
           json_build_object(
             'scope','team','teamId',$1::uuid,
             'cursor',(select max(cursor) from collaboration_outbox
                        where share_grant_id=$2
                          and family in ('fidelity_changed','share_grant_lifecycle')),
             'family','share_grant_lifecycle'
           )::text
         )`,
        [shareGrant.team_id, shareGrant.id]
      );
    }
    await client.query("commit");
    const changed =
      Number(excluded.rowCount ?? 0) +
      Number(invalidated.rowCount ?? 0) +
      Number(queued.rowCount ?? 0) +
      Number(revoked.rowCount ?? 0) +
      Number(quarantined.rowCount ?? 0) +
      quarantinedRepresentations;
    return {
      status: changed > 0 ? "corrected" : "unchanged",
      conversationItemsExcluded: Number(excluded.rowCount ?? 0),
      memoryEventsInvalidated: Number(invalidated.rowCount ?? 0),
      queuedProjectionWorkRemoved: Number(queued.rowCount ?? 0),
      snapshotShareGrantsRevoked: Number(revoked.rowCount ?? 0),
      continuousShareGrantsQuarantined: Number(quarantined.rowCount ?? 0),
      continuousRepresentationsQuarantined: quarantinedRepresentations,
      continuousRepresentationRebuildsQueued: continuousRebuildsQueued
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
