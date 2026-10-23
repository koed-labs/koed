import type pg from "pg";
import {
  crossIdentitySyncDigest,
  sharedMemoryCeilingAuthorizes,
  snapshotConversionScopeSchema,
  SharedMemoryConflictError,
  type SnapshotConversionScope
} from "@koed/shared";
import { stopIndependentDirectSnapshot } from "./shared-memory-direct-reason.js";
import { recordAuditEventWithClient } from "./audit-repository.js";

type Destination = {
  ownerUserId: string;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
};

export const lockSnapshotConversionDestination = async (
  client: pg.PoolClient,
  input: Destination
) => {
  const root = (
    await client.query<{ id: string; owner_principal_id: string }>(
      `select id,owner_principal_id from team_memory_share_grants
     where logical_memory_id=$1 and owner_user_id=$2 and team_id=$3 and team_workspace_id=$4`,
      [
        input.logicalMemoryId,
        input.ownerUserId,
        input.teamId,
        input.teamWorkspaceId
      ]
    )
  ).rows[0];
  if (!root)
    throw new SharedMemoryConflictError(
      "The snapshot destination is unavailable"
    );
  // Keep the same source -> root -> reason/consent order as publication.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `shared-memory-owner-policy:${input.logicalMemoryId}:${root.owner_principal_id}`
  ]);
  await client.query(
    "select id from team_memory_share_grants where id=$1 for update",
    [root.id]
  );
};

export const readSnapshotConversionScope = async (
  client: pg.PoolClient,
  input: Destination & { reasonId: string; lock?: boolean }
) => {
  if (input.lock) await lockSnapshotConversionDestination(client, input);
  const row = (
    await client.query<{
      reason_id: string;
      consent_id: string;
      consent_version: number;
      source_revision: string | number;
      maximum_fidelity: string;
      include_curated_memory: boolean;
      expires_at: Date | null;
      grant_version: number;
    }>(
      `select reason.id reason_id,consent.id consent_id,consent.consent_version,
       consent.source_revision,consent.maximum_fidelity,consent.include_curated_memory,
       consent.expires_at,g.grant_version
     from team_memory_share_grants g
     join team_memory_share_reasons reason on reason.share_grant_id=g.id
       and reason.id=$5 and reason.kind='direct' and reason.rule_id is null
     join source_owner_representation_consents consent on consent.id=reason.consent_id
       and consent.logical_memory_id=g.logical_memory_id
       and consent.source_owner_principal_id=g.owner_principal_id
       and consent.team_id=g.team_id and consent.team_workspace_id=g.team_workspace_id
       and consent.mode='snapshot' and consent.state='active' and consent.revoked_at is null
       and (consent.expires_at is null or consent.expires_at>now())
     where g.logical_memory_id=$1 and g.owner_user_id=$2 and g.team_id=$3
       and g.team_workspace_id=$4 and g.lifecycle='active' and g.revoked_at is null
       and exists(select 1 from team_memory_reason_publications publication
         join team_memory_representations representation on representation.id=publication.representation_id
           and representation.consent_id=consent.id and representation.invalidated_at is null
           and representation.state in ('available','stale')
         where publication.reason_id=reason.id and publication.consent_id=consent.id)
     ${input.lock ? "for update of g,reason,consent" : ""}`,
      [
        input.logicalMemoryId,
        input.ownerUserId,
        input.teamId,
        input.teamWorkspaceId,
        input.reasonId
      ]
    )
  ).rows[0];
  if (!row)
    throw new SharedMemoryConflictError(
      "A current published fixed snapshot is required for conversion"
    );
  return {
    grantVersion: row.grant_version,
    scope: snapshotConversionScopeSchema.parse({
      reasonId: row.reason_id,
      consentId: row.consent_id,
      consentVersion: row.consent_version,
      sourceRevision: Number(row.source_revision),
      maximumFidelity: row.maximum_fidelity,
      includeCuratedMemory: row.include_curated_memory,
      expiresAt: row.expires_at?.toISOString() ?? null
    })
  };
};

/** Snapshot conversion is one operation even while its replacement rule is
 * initialized and the fixed snapshot is intentionally still readable. */
export const requireNoSnapshotConversionInProgress = async (
  client: pg.PoolClient,
  input: Destination & { consentId: string }
) => {
  const prior = await client.query(
    `select admission.pending_share_id from pending_sharing_rule_admissions admission
     join pending_share_operations pending on pending.id=admission.pending_share_id
     left join team_memory_sharing_rules rule on rule.id=admission.rule_id
     where pending.owner_user_id=$1 and pending.logical_memory_id=$2
       and pending.team_id=$3 and pending.team_workspace_id=$4
       and admission.snapshot_conversion->>'consentId'=$5
       and (rule.state in ('active','paused') or
         (rule.id is null and pending.revoked_at is null and pending.state in ('preparing','needs_attention')))
     limit 1`,
    [
      input.ownerUserId,
      input.logicalMemoryId,
      input.teamId,
      input.teamWorkspaceId,
      input.consentId
    ]
  );
  if (prior.rowCount)
    throw new SharedMemoryConflictError(
      "A conversion of this snapshot is already in progress"
    );
};

export const requireReviewedSnapshotConversion = async (
  client: pg.PoolClient,
  input: Destination & {
    expected: SnapshotConversionScope;
    expectedGrantVersion: number | null;
    maximumFidelity: SnapshotConversionScope["maximumFidelity"];
    includeCuratedMemory: boolean;
    expiresAt: string | null;
  }
) => {
  const current = await readSnapshotConversionScope(client, {
    ...input,
    reasonId: input.expected.reasonId,
    lock: true
  });
  if (
    current.grantVersion !== input.expectedGrantVersion ||
    crossIdentitySyncDigest(current.scope) !==
      crossIdentitySyncDigest(input.expected) ||
    !sharedMemoryCeilingAuthorizes(
      current.scope.maximumFidelity,
      input.maximumFidelity,
      current.scope.includeCuratedMemory
    ) ||
    (input.includeCuratedMemory && !current.scope.includeCuratedMemory) ||
    input.expiresAt !== current.scope.expiresAt
  )
    throw new SharedMemoryConflictError(
      "The reviewed snapshot or its consent limits changed before conversion"
    );
};

/** Called only after the approved Conversation rule has an eligible publication.
 * The caller holds the source/root locks and commits this with pending completion.
 * A separately stopped snapshot is already retired; a new independent snapshot
 * must never be withdrawn by this older conversion. */
export const completeSnapshotConversion = async (
  client: pg.PoolClient,
  input: Destination & {
    expected: SnapshotConversionScope;
    shareGrantId: string;
    ruleId: string;
    pendingShareId: string;
  }
) => {
  const original = (
    await client.query<{ state: string; revoked_at: Date | null }>(
      `select state,revoked_at from source_owner_representation_consents
     where id=$1 and logical_memory_id=$2 and team_id=$3 and team_workspace_id=$4
       and mode='snapshot' for update`,
      [
        input.expected.consentId,
        input.logicalMemoryId,
        input.teamId,
        input.teamWorkspaceId
      ]
    )
  ).rows[0];
  if (!original)
    throw new SharedMemoryConflictError(
      "The selected snapshot consent is unavailable"
    );
  if (original.state === "revoked" && original.revoked_at !== null) return;
  const current = await readSnapshotConversionScope(client, {
    ...input,
    reasonId: input.expected.reasonId,
    lock: true
  });
  if (
    crossIdentitySyncDigest(current.scope) !==
    crossIdentitySyncDigest(input.expected)
  )
    throw new SharedMemoryConflictError(
      "The selected snapshot changed while conversion was processing"
    );
  await stopIndependentDirectSnapshot(client, {
    ownerUserId: input.ownerUserId,
    shareGrantId: input.shareGrantId,
    consentId: input.expected.consentId
  });
  await recordAuditEventWithClient(client, {
    actorUserId: input.ownerUserId,
    ownerUserId: input.ownerUserId,
    visibility: "personal",
    action: "shared_memory.snapshot_converted",
    targetTable: "team_memory_sharing_rules",
    targetId: input.ruleId,
    metadata: {
      pendingShareId: input.pendingShareId,
      shareGrantId: input.shareGrantId,
      snapshotReasonId: input.expected.reasonId,
      snapshotConsentId: input.expected.consentId
    }
  });
};
