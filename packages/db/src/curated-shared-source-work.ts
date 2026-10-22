import type pg from "pg";

export interface CuratedGrantSourceWork {
  workId: string;
  leaseToken: string;
  generation: number;
  backendId: string;
  localOwnerUserId: string;
  upstreamUserId: string;
  originalPendingShareId: string;
  consentId: string;
  previewHash: string;
  initialCommitmentHash: string;
  localSessionId: string;
  logicalMemoryId: string;
  sourceDeploymentProtocolId: string;
  sourceOwnerPrincipalId: string;
  teamId: string;
  teamWorkspaceId: string;
}

const safeGeneration = (value: string | number): number => {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Curated source generation is invalid");
  }
  return generation;
};

/** Register only after the initial signed Pending Share upload was acknowledged. */
export const registerContinuousCuratedGrantSourceWork = async (
  pool: pg.Pool,
  input: {
    backendId: string;
    localOwnerUserId: string;
    upstreamUserId: string;
    originalPendingShareId: string;
    consentId: string;
    previewHash: string;
    initialCommitmentHash: string;
    localSessionId: string;
    logicalMemoryId: string;
    sourceDeploymentProtocolId: string;
    sourceOwnerPrincipalId: string;
    teamId: string;
    teamWorkspaceId: string;
    nextExpiryAt: string | null;
  }
): Promise<boolean> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `with eligible as (
         select enrollment.id as enrollment_id
           from collaboration_shared_memory_enrollments enrollment
           join local_captured_session_logical_memories local_source
             on local_source.logical_memory_id=$8
            and local_source.local_session_id=$7
            and local_source.owner_user_id=$2
          where enrollment.backend_id=$1
            and enrollment.local_owner_user_id=$2
            and enrollment.upstream_user_id=$3
            and enrollment.revoked_at is null
          limit 1
       )
       insert into collaboration_curated_grant_source_work
           (enrollment_id,original_pending_share_id,consent_id,preview_hash,
            curated_material_commitment_hash,local_session_id,logical_memory_id,
            source_deployment_protocol_id,source_owner_principal_id,
            team_id,team_workspace_id,mode,requested_generation,
            delivered_generation,state,next_expiry_at)
         select eligible.enrollment_id,$4,$5,$6,$9,$7,$8,$10,$11,
                $12,$13,'continuous',1,0,'pending',$14::timestamptz
           from eligible
         on conflict (enrollment_id,original_pending_share_id) do nothing`,
      [
        input.backendId,
        input.localOwnerUserId,
        input.upstreamUserId,
        input.originalPendingShareId,
        input.consentId,
        input.previewHash,
        input.localSessionId,
        input.logicalMemoryId,
        input.initialCommitmentHash,
        input.sourceDeploymentProtocolId,
        input.sourceOwnerPrincipalId,
        input.teamId,
        input.teamWorkspaceId,
        input.nextExpiryAt
      ]
    );
    const result = await client.query<{
      original_pending_share_id: string;
      consent_id: string;
      preview_hash: string;
      curated_material_commitment_hash: string;
      local_session_id: string;
      logical_memory_id: string;
      source_deployment_protocol_id: string;
      source_owner_principal_id: string;
      team_id: string;
      team_workspace_id: string;
    }>(
      `select work.original_pending_share_id,work.consent_id,work.preview_hash,
              work.curated_material_commitment_hash,work.local_session_id,
              work.logical_memory_id,work.source_deployment_protocol_id,
              work.source_owner_principal_id,work.team_id,work.team_workspace_id
         from collaboration_curated_grant_source_work work
         join collaboration_shared_memory_enrollments enrollment
           on enrollment.id=work.enrollment_id
          and enrollment.backend_id=$1
          and enrollment.local_owner_user_id=$2
          and enrollment.upstream_user_id=$3
          and enrollment.revoked_at is null
        where work.original_pending_share_id=$4
        for update of work`,
      [
        input.backendId,
        input.localOwnerUserId,
        input.upstreamUserId,
        input.originalPendingShareId
      ]
    );
    const row = result.rows[0];
    const valid = Boolean(
      row &&
      row.original_pending_share_id === input.originalPendingShareId &&
      row.consent_id === input.consentId &&
      row.preview_hash === input.previewHash &&
      row.curated_material_commitment_hash === input.initialCommitmentHash &&
      row.local_session_id === input.localSessionId &&
      row.logical_memory_id === input.logicalMemoryId &&
      row.source_deployment_protocol_id === input.sourceDeploymentProtocolId &&
      row.source_owner_principal_id === input.sourceOwnerPrincipalId &&
      row.team_id === input.teamId &&
      row.team_workspace_id === input.teamWorkspaceId
    );
    await client.query(valid ? "commit" : "rollback");
    return valid;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Enqueue in the same Personal transaction as the changed assertion. Recheck
 * every owned continuous grant: removal can erase the last direct-source edge,
 * so a post-change Session join cannot safely identify every former recipient.
 */
export const enqueueCuratedGrantSourceWorkForAssertions = async (
  client: pg.PoolClient,
  ownerUserId: string,
  assertionIds: readonly string[]
): Promise<number> => {
  if (assertionIds.length === 0) return 0;
  const result = await client.query(
    `update collaboration_curated_grant_source_work work
        set requested_generation=requested_generation+1,
            state=case when state='processing' then state else 'pending' end,
            available_at=now(),updated_at=now()
       from collaboration_shared_memory_enrollments enrollment
      where enrollment.id=work.enrollment_id
        and enrollment.local_owner_user_id=$1
        and enrollment.revoked_at is null`,
    [ownerUserId]
  );
  return result.rowCount ?? 0;
};

/** Expiration needs no synthetic capture event or source-cursor advance. */
export const enqueueDueCuratedGrantExpiryWork = async (
  pool: pg.Pool
): Promise<number> => {
  const result = await pool.query(
    `update collaboration_curated_grant_source_work work
        set requested_generation=requested_generation+1,
            next_expiry_at=null,
            state=case when state='processing' then state else 'pending' end,
            available_at=now(),updated_at=now()
       from collaboration_shared_memory_enrollments enrollment
      where enrollment.id=work.enrollment_id
        and enrollment.revoked_at is null
        and work.next_expiry_at<=now()`
  );
  return result.rowCount ?? 0;
};

export const claimCuratedGrantSourceWork = async (
  pool: pg.Pool,
  limit = 10
): Promise<CuratedGrantSourceWork[]> => {
  const result = await pool.query<{
    work_id: string;
    lease_token: string;
    claimed_generation: string;
    backend_id: string;
    local_owner_user_id: string;
    upstream_user_id: string;
    original_pending_share_id: string;
    consent_id: string;
    preview_hash: string;
    curated_material_commitment_hash: string;
    local_session_id: string;
    logical_memory_id: string;
    source_deployment_protocol_id: string;
    source_owner_principal_id: string;
    team_id: string;
    team_workspace_id: string;
  }>(
    `with candidates as (
       select work.id
         from collaboration_curated_grant_source_work work
         join collaboration_shared_memory_enrollments enrollment
           on enrollment.id=work.enrollment_id
          and enrollment.revoked_at is null
        where work.requested_generation>work.delivered_generation
          and ((work.state in ('pending','failed') and work.available_at<=now())
            or (work.state='processing' and
                work.locked_at<now()-interval '5 minutes'))
        order by work.available_at,work.id
        for update of work skip locked
        limit $1
     ), claimed as (
       update collaboration_curated_grant_source_work work
          set state='processing',
              requested_generation=case when work.state='processing'
                                        then work.requested_generation+1
                                        else work.requested_generation end,
              claimed_generation=case when work.state='processing'
                                       then work.requested_generation+1
                                       else work.requested_generation end,
              lease_token=gen_random_uuid(),locked_at=now(),
              attempt_count=work.attempt_count+1,updated_at=now()
         from candidates
        where work.id=candidates.id
      returning work.*
     )
     select claimed.id as work_id,claimed.lease_token,
            claimed.claimed_generation,enrollment.backend_id,
            enrollment.local_owner_user_id,enrollment.upstream_user_id,
            claimed.original_pending_share_id,claimed.consent_id,
            claimed.preview_hash,claimed.curated_material_commitment_hash,
            claimed.local_session_id,claimed.logical_memory_id,
            claimed.source_deployment_protocol_id,
            claimed.source_owner_principal_id,claimed.team_id,
            claimed.team_workspace_id
       from claimed
       join collaboration_shared_memory_enrollments enrollment
         on enrollment.id=claimed.enrollment_id`,
    [Math.max(1, Math.min(limit, 50))]
  );
  return result.rows.map((row) => ({
    workId: row.work_id,
    leaseToken: row.lease_token,
    generation: safeGeneration(row.claimed_generation),
    backendId: row.backend_id,
    localOwnerUserId: row.local_owner_user_id,
    upstreamUserId: row.upstream_user_id,
    originalPendingShareId: row.original_pending_share_id,
    consentId: row.consent_id,
    previewHash: row.preview_hash,
    initialCommitmentHash: row.curated_material_commitment_hash,
    localSessionId: row.local_session_id,
    logicalMemoryId: row.logical_memory_id,
    sourceDeploymentProtocolId: row.source_deployment_protocol_id,
    sourceOwnerPrincipalId: row.source_owner_principal_id,
    teamId: row.team_id,
    teamWorkspaceId: row.team_workspace_id
  }));
};

export const finishCuratedGrantSourceWork = async (
  pool: pg.Pool,
  input: {
    workId: string;
    leaseToken: string;
    generation: number;
    outcome: "delivered" | "retry";
    nextExpiryAt?: string | null;
  }
): Promise<boolean> => {
  const delivered = input.outcome === "delivered";
  const result = await pool.query(
    `update collaboration_curated_grant_source_work work
        set requested_generation=case when $4::boolean then work.requested_generation
                                      else greatest(work.requested_generation,$3+1) end,
            delivered_generation=case when $4::boolean then $3
                                      else work.delivered_generation end,
            state=case when not $4::boolean then 'failed'
                       when work.requested_generation>$3 then 'pending'
                       else 'idle' end,
            next_expiry_at=case when $4::boolean then $5::timestamptz
                                else work.next_expiry_at end,
            available_at=case when $4::boolean then now()
                              else now()+interval '30 seconds' end,
            claimed_generation=null,lease_token=null,locked_at=null,
            updated_at=now()
      where work.id=$1 and work.lease_token=$2
        and work.claimed_generation=$3 and work.state='processing'`,
    [
      input.workId,
      input.leaseToken,
      input.generation,
      delivered,
      input.nextExpiryAt ?? null
    ]
  );
  return result.rowCount === 1;
};
