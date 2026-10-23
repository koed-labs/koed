import type pg from "pg";
import {
  crossIdentitySyncDigest,
  crossIdentitySyncDeterministicUuid,
  SharedMemoryConflictError,
  workspaceConversationExclusionSchema,
  workspaceConversationExclusionReviewInputSchema,
  type WorkspaceConversationExclusion,
  type WorkspaceConversationExclusionIntent,
  type WorkspaceConversationExclusionReviewInput,
  type WorkspaceConversationExclusionReview
} from "@koed/shared";
import { recordAuditEventWithClient } from "./audit-repository.js";

type SqlClient = Pick<pg.PoolClient, "query">;
type Row = Record<string, unknown>;
const timestamp = (value: unknown): string =>
  value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();

export const workspaceConversationExclusionFromRow = (
  row: Row
): WorkspaceConversationExclusion =>
  workspaceConversationExclusionSchema.parse({
    id: row.id,
    ownerUserId: row.owner_user_id,
    logicalMemoryId: row.logical_memory_id,
    teamId: row.team_id,
    teamWorkspaceId: row.team_workspace_id,
    version: Number(row.version),
    state: row.state,
    excludedAt: timestamp(row.excluded_at),
    restoredAt: row.restored_at == null ? null : timestamp(row.restored_at),
    updatedAt: timestamp(row.updated_at)
  });

export const readWorkspaceConversationExclusion = async (
  client: SqlClient,
  ownerUserId: string,
  input: WorkspaceConversationExclusionReviewInput,
  lock = false
): Promise<WorkspaceConversationExclusion | null> => {
  const result = await client.query<Row>(
    `select * from team_memory_workspace_exclusions
      where owner_user_id=$1 and logical_memory_id=$2 and team_id=$3 and team_workspace_id=$4
      ${lock ? "for update" : ""}`,
    [ownerUserId, input.logicalMemoryId, input.teamId, input.teamWorkspaceId]
  );
  return result.rows[0]
    ? workspaceConversationExclusionFromRow(result.rows[0])
    : null;
};

export const requireWorkspaceSourceNotExcluded = async (
  client: SqlClient,
  ownerUserId: string,
  logicalMemoryId: string,
  teamWorkspaceId: string
): Promise<void> => {
  const result = await client.query(
    `select 1 from team_memory_workspace_exclusions
      where owner_user_id=$1 and logical_memory_id=$2 and team_workspace_id=$3 and state='excluded'`,
    [ownerUserId, logicalMemoryId, teamWorkspaceId]
  );
  if (result.rowCount)
    throw new SharedMemoryConflictError(
      "This Conversation is excluded from the Workspace"
    );
};

// An owner can restrict an existing destination even after losing Workspace
// Access. A previously unrelated destination still requires current permission;
// knowing an opaque Workspace ID must not disclose its name or Team context.
export const readWorkspaceConversationExclusionReview = async (
  client: SqlClient,
  ownerUserId: string,
  input: WorkspaceConversationExclusionReviewInput,
  requireDestinationPermission: () => Promise<unknown>
): Promise<{
  review: WorkspaceConversationExclusionReview;
  ownerPrincipalId: string;
} | null> => {
  const source = await client.query<Row>(
    `select lm.owner_principal_id,t.name as team_name,workspace.name as workspace_name,
            coalesce(nullif(trim(session.metadata->>'threadName'),''),'Conversation') as source_title,
            grant_row.id as share_grant_id,grant_row.grant_version,
            (grant_row.id is not null or exists (
              select 1 from pending_share_operations pending
               where pending.owner_user_id=$1 and pending.logical_memory_id=$2
                 and pending.team_id=$3 and pending.team_workspace_id=$4
            ) or exists (
              select 1 from team_memory_workspace_exclusions exclusion
               where exclusion.owner_user_id=$1 and exclusion.logical_memory_id=$2
                 and exclusion.team_id=$3 and exclusion.team_workspace_id=$4
            )) as known_destination
       from logical_memories lm
       join users owner on owner.id=lm.owner_user_id and owner.disabled_at is null and owner.deleted_at is null
       join teams t on t.id=$3
       join team_workspaces workspace on workspace.id=$4 and workspace.team_id=t.id
       left join local_captured_session_logical_memories local_memory on local_memory.logical_memory_id=lm.id and local_memory.owner_user_id=$1
       left join sessions session on session.id=local_memory.local_session_id
       left join team_memory_share_grants grant_row on grant_row.logical_memory_id=lm.id and grant_row.owner_user_id=$1 and grant_row.team_workspace_id=$4
      where lm.id=$2 and lm.owner_user_id=$1 and lm.source_kind='captured_session' and lm.purge_completed_at is null`,
    [ownerUserId, input.logicalMemoryId, input.teamId, input.teamWorkspaceId]
  );
  const row = source.rows[0];
  if (!row) return null;
  if (row.known_destination !== true) await requireDestinationPermission();
  const exclusion = await readWorkspaceConversationExclusion(
    client,
    ownerUserId,
    input
  );
  return {
    ownerPrincipalId: String(row.owner_principal_id),
    review: {
      scope: {
        ...input,
        ownerUserId,
        expectedExclusionVersion: exclusion?.version ?? 0,
        shareGrantId:
          row.share_grant_id == null ? null : (row.share_grant_id as string),
        expectedGrantVersion:
          row.grant_version == null ? null : Number(row.grant_version)
      },
      source: {
        logicalMemoryId: input.logicalMemoryId,
        title: String(row.source_title)
      },
      team: { id: input.teamId, name: String(row.team_name) },
      workspace: {
        id: input.teamWorkspaceId,
        name: String(row.workspace_name)
      },
      exclusion
    }
  };
};

// The repository owns this transaction and supplies the existing authority and
// delivery seams. This function does not open a second transaction or queue.
export const applyWorkspaceConversationExclusion = async (
  client: pg.PoolClient,
  ownerUserId: string,
  intent: WorkspaceConversationExclusionIntent,
  dependencies: {
    requireDestinationPermission: () => Promise<unknown>;
    requireAuthority: () => Promise<unknown>;
    notifyChanged: (
      grant: Row | null,
      pending: Row[],
      result: WorkspaceConversationExclusion
    ) => Promise<void>;
  }
): Promise<WorkspaceConversationExclusion> => {
  const requestHash = crossIdentitySyncDigest({ ownerUserId, ...intent });
  const replay = async (): Promise<WorkspaceConversationExclusion | null> => {
    const prior = await client.query<Row>(
      "select * from team_memory_workspace_exclusion_mutations where mutation_id=$1",
      [intent.mutationId]
    );
    if (!prior.rows[0]) return null;
    if (
      prior.rows[0].owner_user_id !== ownerUserId ||
      prior.rows[0].request_hash !== requestHash
    )
      throw new SharedMemoryConflictError(
        "Workspace exclusion mutation ID was reused"
      );
    return workspaceConversationExclusionSchema.parse(
      prior.rows[0].result_snapshot
    );
  };
  const prior = await replay();
  if (prior) return prior;
  const input = workspaceConversationExclusionReviewInputSchema.parse({
    logicalMemoryId: intent.scope.logicalMemoryId,
    teamId: intent.scope.teamId,
    teamWorkspaceId: intent.scope.teamWorkspaceId
  });
  const loaded = await readWorkspaceConversationExclusionReview(
    client,
    ownerUserId,
    input,
    dependencies.requireDestinationPermission
  );
  if (!loaded)
    throw new SharedMemoryConflictError(
      "The owned Conversation or destination is unavailable"
    );
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `shared-memory-owner-policy:${input.logicalMemoryId}:${loaded.ownerPrincipalId}`
  ]);
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `pending-share-destination:${ownerUserId}:${input.logicalMemoryId}:${input.teamId}:${input.teamWorkspaceId}`
  ]);
  const lockedPrior = await replay();
  if (lockedPrior) return lockedPrior;
  const grants = await client.query<Row>(
    "select * from team_memory_share_grants where logical_memory_id=$1 and owner_user_id=$2 and team_workspace_id=$3 for update",
    [input.logicalMemoryId, ownerUserId, input.teamWorkspaceId]
  );
  const grant = grants.rows[0] ?? null;
  const exclusion = await readWorkspaceConversationExclusion(
    client,
    ownerUserId,
    input,
    true
  );
  if (
    intent.scope.ownerUserId !== ownerUserId ||
    intent.scope.expectedExclusionVersion !== (exclusion?.version ?? 0) ||
    intent.scope.shareGrantId !== (grant ? String(grant.id) : null) ||
    intent.scope.expectedGrantVersion !==
      (grant ? Number(grant.grant_version) : null) ||
    exclusion?.state === "excluded"
  )
    throw new SharedMemoryConflictError(
      "The Workspace exclusion review is stale"
    );
  await dependencies.requireAuthority();
  const id =
    exclusion?.id ??
    crossIdentitySyncDeterministicUuid({
      kind: "workspace_conversation_exclusion",
      ownerUserId,
      ...input
    });
  const saved = await client.query<Row>(
    `insert into team_memory_workspace_exclusions(id,owner_user_id,logical_memory_id,team_id,team_workspace_id)
     values($1,$2,$3,$4,$5)
     on conflict(owner_user_id,logical_memory_id,team_workspace_id) do update set
       state='excluded',version=team_memory_workspace_exclusions.version+1,
       excluded_at=now(),restored_at=null,updated_at=now() returning *`,
    [
      id,
      ownerUserId,
      input.logicalMemoryId,
      input.teamId,
      input.teamWorkspaceId
    ]
  );
  const result = workspaceConversationExclusionFromRow(saved.rows[0]!);
  await client.query(
    `update shared_memory_candidate_previews set invalidated_at=now(),invalidation_reason='workspace_excluded'
      where owner_user_id=$1 and logical_memory_id=$2 and team_workspace_id=$3 and invalidated_at is null`,
    [ownerUserId, input.logicalMemoryId, input.teamWorkspaceId]
  );
  await client.query(
    `update shared_source_semantic_previews set status='invalidated',invalidated_at=now(),
       invalidation_reason_code='workspace_excluded',failure_code='workspace_excluded',next_attempt_at=null,updated_at=now()
      where owner_user_id=$1 and logical_memory_id=$2 and team_workspace_id=$3 and invalidated_at is null`,
    [ownerUserId, input.logicalMemoryId, input.teamWorkspaceId]
  );
  await client.query(
    `update shared_source_semantic_privacy_work_claims claim
        set state='released',released_at=now()
       from shared_source_semantic_previews semantic
      where semantic.id=claim.semantic_preview_id and claim.state='active'
        and semantic.owner_user_id=$1 and semantic.logical_memory_id=$2 and semantic.team_workspace_id=$3`,
    [ownerUserId, input.logicalMemoryId, input.teamWorkspaceId]
  );
  if (grant) {
    await client.query(
      "update team_memory_share_grants set grant_version=grant_version+1,updated_at=now() where id=$1",
      [grant.id]
    );
    await client.query(
      `update team_memory_representations set state='invalidated',invalidated_at=coalesce(invalidated_at,now()),
         invalidation_reason_code='workspace_excluded',record_version=record_version+1,updated_at=now()
       where share_grant_id=$1 and invalidated_at is null`,
      [grant.id]
    );
    await client.query(
      "delete from team_memory_semantic_items where share_grant_id=$1",
      [grant.id]
    );
    await client.query(
      `update team_conversation_source_grants set lifecycle='revoked',revoked_at=now(),revoked_by_user_id=$2,
         revocation_reason='workspace_excluded',version=version+1,updated_at=now()
       where share_grant_id=$1 and lifecycle='active'`,
      [grant.id, ownerUserId]
    );
  }
  // End direct consent, including consent prepared before grant creation. Keep
  // current rule authority separate so restoration can review eligible rules.
  await client.query(
    `update source_owner_representation_consents consent set state='revoked',revoked_at=coalesce(revoked_at,now()),
       consent_version=consent_version+1,state_reason_code='workspace_excluded',updated_at=now()
     where consent.logical_memory_id=$1 and consent.team_workspace_id=$2 and consent.state<>'revoked'
       and not exists(select 1 from team_memory_share_reasons reason where reason.consent_id=consent.id and reason.kind='rule')
       and not exists(select 1 from pending_share_operations pending join pending_sharing_rule_admissions admission
         on admission.pending_share_id=pending.id where pending.consent_id=consent.id)`,
    [input.logicalMemoryId, input.teamWorkspaceId]
  );
  const pending = await client.query<Row>(
    `update pending_share_operations operation set
       state=case when exists(select 1 from pending_sharing_rule_admissions admission where admission.pending_share_id=operation.id)
         then 'needs_attention' else 'revoked' end,
       revoked_at=case when exists(select 1 from pending_sharing_rule_admissions admission where admission.pending_share_id=operation.id)
         then null else now() end,
       workspace_access_state='none',source_update_state='stopped',redacted_failure_code='workspace_excluded',
       operation_version=operation_version+1,updated_at=now()
     where owner_user_id=$1 and logical_memory_id=$2 and team_id=$3 and team_workspace_id=$4
       and revoked_at is null and state in ('preparing','needs_attention','activated')
     returning id,owner_user_id,operation_version`,
    [ownerUserId, input.logicalMemoryId, input.teamId, input.teamWorkspaceId]
  );
  await client.query(
    "update pending_share_outbox set state='completed',locked_at=null,updated_at=now() where pending_share_id=any($1::uuid[])",
    [pending.rows.map((row) => row.id)]
  );
  await client.query(
    `insert into team_memory_workspace_exclusion_mutations(mutation_id,exclusion_id,owner_user_id,operation,request_hash,result_version,result_snapshot)
     values($1,$2,$3,'exclude',$4,$5,$6::jsonb)`,
    [
      intent.mutationId,
      result.id,
      ownerUserId,
      requestHash,
      result.version,
      JSON.stringify(result)
    ]
  );
  await recordAuditEventWithClient(client, {
    actorUserId: ownerUserId,
    ownerUserId,
    visibility: "personal",
    action: "shared_memory.workspace_excluded",
    targetTable: "team_memory_workspace_exclusions",
    targetId: result.id,
    metadata: {
      mutationId: intent.mutationId,
      version: result.version,
      teamWorkspaceId: input.teamWorkspaceId
    }
  });
  await dependencies.notifyChanged(grant, pending.rows, result);
  return result;
};
