import type pg from "pg";
import {
  crossIdentitySyncDeterministicUuid,
  SharedMemoryConflictError
} from "@koed/shared";
import { recordAuditEventWithClient } from "./audit-repository.js";

type Client = Pick<pg.PoolClient, "query">;
type Row = Record<string, unknown>;

// When another reason retains access, the owner can withdraw just the fixed
// direct snapshot. The ordinary grant revocation handles the final reason and
// its retention/cascade boundary.
export const stopIndependentDirectSnapshot = async (
  client: pg.PoolClient,
  input: { ownerUserId: string; shareGrantId: string; consentId: string }
): Promise<Row> => {
  const authority = await client.query<Row>(
    `select g.* from team_memory_share_grants g
     join team_memory_share_reasons direct on direct.share_grant_id=g.id
       and direct.kind='direct' and direct.consent_id=$3
     join source_owner_representation_consents consent on consent.id=direct.consent_id
       and consent.mode='snapshot' and consent.state='active' and consent.revoked_at is null
     where g.id=$1 and g.owner_user_id=$2 and g.lifecycle='active' and g.revoked_at is null
       and exists(select 1 from team_memory_share_reasons reason
         join team_memory_sharing_rules rule on rule.id=reason.rule_id
           and rule.state in ('active','paused')
         join source_owner_representation_consents other on other.id=reason.consent_id
           and other.state in ('active','paused') and other.revoked_at is null
           and (other.expires_at is null or other.expires_at>now())
         where reason.share_grant_id=g.id and reason.kind='rule')
     for update of g,direct,consent`,
    [input.shareGrantId, input.ownerUserId, input.consentId]
  );
  if (!authority.rows[0])
    throw new SharedMemoryConflictError(
      "Stopping only this snapshot requires an active snapshot and an independent sharing rule; otherwise revoke all sharing"
    );
  await client.query(
    `update source_owner_representation_consents set state='revoked',revoked_at=now(),
       state_reason_code='owner_stopped_direct_snapshot',updated_at=now()
     where id=$1`,
    [input.consentId]
  );
  await client.query(
    `with invalidated as (
       update team_memory_representations set state='invalidated',invalidated_at=now(),
         invalidation_reason_code='direct_snapshot_stopped',record_version=record_version+1,updated_at=now()
       where share_grant_id=$1 and consent_id=$2 and invalidated_at is null returning id
     ) delete from team_memory_semantic_items where representation_id in (select id from invalidated)`,
    [input.shareGrantId, input.consentId]
  );
  const root = await client.query<Row>(
    `update team_memory_share_grants set grant_version=grant_version+1,updated_at=now()
     where id=$1 returning *`,
    [input.shareGrantId]
  );
  return root.rows[0]!;
};

// A missing expected version means a new destination. Reusing a rule-created
// contribution always requires its exact reviewed logical identity and version.
export const requireReviewedDirectDestination = async (
  client: Client,
  input: {
    ownerUserId: string;
    logicalMemoryId: string;
    teamId: string;
    teamWorkspaceId: string;
    logicalGrantId: string;
    expectedGrantVersion?: number | null;
    mode: string;
  }
): Promise<Row | null> => {
  const rows = await client.query<Row>(
    `select grant_row.*,
    exists(select 1 from team_memory_share_reasons reason where reason.share_grant_id=grant_row.id and reason.kind='direct') has_direct
    from team_memory_share_grants grant_row where logical_memory_id=$1 and team_workspace_id=$2`,
    [input.logicalMemoryId, input.teamWorkspaceId]
  );
  const root = rows.rows[0];
  if (!root) {
    if (input.expectedGrantVersion != null)
      throw new SharedMemoryConflictError(
        "The reviewed sharing destination is unavailable"
      );
    return null;
  }
  if (
    input.mode !== "snapshot" ||
    root.owner_user_id !== input.ownerUserId ||
    root.team_id !== input.teamId ||
    root.logical_grant_id !== input.logicalGrantId ||
    input.expectedGrantVersion == null ||
    Number(root.grant_version) !== input.expectedGrantVersion ||
    !["active", "unavailable"].includes(root.lifecycle as string) ||
    root.revoked_at != null ||
    root.tombstoned_at != null ||
    root.purge_completed_at != null ||
    root.has_direct === true
  )
    throw new SharedMemoryConflictError(
      "The direct snapshot destination changed; review it again"
    );
  return root;
};

export const attachReviewedDirectSnapshot = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    pendingShareId: string;
    root: Row;
    consent: Row;
    mutationId: string;
  }
): Promise<Row> => {
  const { root, consent } = input;
  const pending = (
    await client.query<Row>(
      `select * from pending_share_operations
    where id=$1 and owner_user_id=$2 and consent_id=$3 and logical_grant_id=$4
      and logical_memory_id=$5 and team_id=$6 and team_workspace_id=$7
      and state='preparing' and revoked_at is null and mode='snapshot'
      and reviewed_grant_version=$8 for update`,
      [
        input.pendingShareId,
        input.ownerUserId,
        consent.id,
        root.logical_grant_id,
        root.logical_memory_id,
        root.team_id,
        root.team_workspace_id,
        root.grant_version
      ]
    )
  ).rows[0];
  if (
    !pending ||
    consent.mode !== "snapshot" ||
    root.owner_user_id !== input.ownerUserId ||
    root.logical_memory_id !== consent.logical_memory_id ||
    root.remote_replica_id !== consent.remote_replica_id ||
    root.owner_principal_id !== consent.source_owner_principal_id ||
    root.team_id !== consent.team_id ||
    root.team_workspace_id !== consent.team_workspace_id ||
    !["active", "unavailable"].includes(root.lifecycle as string) ||
    root.revoked_at != null ||
    root.tombstoned_at != null ||
    root.purge_completed_at != null
  )
    throw new SharedMemoryConflictError(
      "The reviewed direct snapshot authority changed before activation"
    );
  const direct = await client.query(
    "select id from team_memory_share_reasons where share_grant_id=$1 and kind='direct' for update",
    [root.id]
  );
  if (direct.rowCount)
    throw new SharedMemoryConflictError(
      "This destination already has a direct sharing reason"
    );
  const reasonId = crossIdentitySyncDeterministicUuid({
    kind: "direct_snapshot_reason",
    shareGrantId: root.id,
    consentId: consent.id
  });
  await client.query(
    "insert into team_memory_share_reasons(id,share_grant_id,consent_id,kind,repository_snapshot,repository_snapshot_source_revision) values($1,$2,$3,'direct',$4::jsonb,$5)",
    [
      reasonId,
      root.id,
      consent.id,
      JSON.stringify(root.repository_snapshot),
      root.repository_snapshot_source_revision
    ]
  );
  // Prefer the independently approved direct reason just as in direct-first
  // creation. Rule records and their own consent/publications remain unchanged.
  const updated = await client.query<Row>(
    `update team_memory_share_grants set
    consent_id=$2,source_owner_policy_id=$3,source_owner_policy_version=$4,
    team_policy_id=$5,team_policy_version=$6,workspace_policy_id=$7,workspace_policy_version=$8,
    maximum_fidelity=$9,include_curated_memory=$10,fidelity_policy_revision=$11,
    content_policy_version=$12,classifier_version=$13,source_revision=$14,
    activation_representation=$15,mode=$16,source_capabilities=$17,source_revision_id=$18,
    grant_version=grant_version+1,updated_at=now()
    where id=$1 and grant_version=$19 returning *`,
    [
      root.id,
      consent.id,
      consent.source_owner_policy_id,
      consent.source_owner_policy_version,
      consent.team_policy_id,
      consent.team_policy_version,
      consent.workspace_policy_id,
      consent.workspace_policy_version,
      consent.maximum_fidelity,
      consent.include_curated_memory,
      consent.fidelity_policy_revision,
      consent.content_policy_version,
      consent.classifier_version,
      consent.source_revision,
      consent.activation_representation,
      consent.mode,
      consent.source_capabilities,
      consent.source_revision_id,
      root.grant_version
    ]
  );
  if (!updated.rows[0])
    throw new SharedMemoryConflictError(
      "The direct snapshot destination changed during activation"
    );
  await client.query(
    "update pending_share_operations set grant_id=$2,stage='activating',last_progress_at=now(),updated_at=now() where id=$1 and state='preparing'",
    [input.pendingShareId, root.id]
  );
  await recordAuditEventWithClient(client, {
    actorUserId: input.ownerUserId,
    ownerUserId: input.ownerUserId,
    visibility: "personal",
    action: "shared_memory.direct_snapshot_added",
    targetTable: "team_memory_share_reasons",
    targetId: reasonId,
    metadata: {
      mutationId: input.mutationId,
      pendingShareId: input.pendingShareId,
      shareGrantId: root.id,
      consentId: consent.id,
      grantVersionBefore: root.grant_version,
      grantVersionAfter: updated.rows[0].grant_version
    }
  });
  return updated.rows[0];
};
