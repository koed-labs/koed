import type pg from "pg";
import {
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  sharingRuleSourceIdentityHash,
  sharingRuleSourceIdentitySchema,
  sharedMemoryCeilingAuthorizes,
  SharedMemoryConflictError,
  type SharingRuleSourceIdentity,
  type SharedMemoryFidelityCeiling,
  type SharedMemoryRepresentation
} from "@koed/shared";
import { workspaceSourceIsNotExcludedSql } from "./shared-memory-publication-authority-sql.js";

export interface RuleMemberReadmissionInput {
  ruleId: string;
  publisherCredentialId: string;
  expectedAuthorityVersion: number;
  publisherFence: number;
  expectedMembershipVersion: number;
  expectedGrantVersion: number | null;
  sourceIdentity: SharingRuleSourceIdentity;
}
/** Internal durable lookup; Personal origin identifiers stay out of Team rows. */
export type RuleMemberReadmissionLookup = Omit<
  RuleMemberReadmissionInput,
  "sourceIdentity"
> & {
  portableSourceHash: string;
  nativeAdmissionId?: string;
};
export interface RuleMemberReadmissionAuthority {
  ruleId: string;
  membershipId: string;
  membershipVersion: number;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  publisherCredentialId: string;
  authorityVersion: number;
  publisherFence: number;
  effectivePrivacyPolicyHash: string;
  shareGrantId: string | null;
  grantVersion: number | null;
  logicalGrantId: string;
  sourceSessionId: string;
  sourceCapabilities: SharedMemoryRepresentation[];
  remoteReplicaId: string;
  sourceCredentialId: string;
  sourceRevision: number;
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  portableSourceHash: string;
  nativeAdmissionId: string | null;
}

/** Caller holds the exact owner/publisher rule authority and Workspace sharing
 * permission. This proof creates no consent, member, preview or upload authority.
 * A readmission must independently retain and recheck it before activation. */
export const readRuleMemberReadmissionAuthority = async (
  client: pg.PoolClient,
  ownerUserId: string,
  input: RuleMemberReadmissionInput | RuleMemberReadmissionLookup,
  rule: Record<string, unknown>,
  pendingMembershipVersion?: number
): Promise<RuleMemberReadmissionAuthority> => {
  const unavailable = () =>
    new SharedMemoryConflictError("Existing source readmission is unavailable");
  for (const version of [
    input.expectedAuthorityVersion,
    input.publisherFence,
    input.expectedMembershipVersion,
    ...(input.expectedGrantVersion === null ? [] : [input.expectedGrantVersion])
  ])
    if (!Number.isSafeInteger(version) || version < 1)
      throw new SharedMemoryConflictError(
        "Exact current readmission versions are required"
      );
  if (
    rule.id !== input.ruleId ||
    rule.owner_user_id !== ownerUserId ||
    rule.publisher_credential_id !== input.publisherCredentialId ||
    rule.state !== "active" ||
    !["repository", "folder", "project"].includes(String(rule.selector_kind)) ||
    Number(rule.authority_version) !== input.expectedAuthorityVersion ||
    Number(rule.publisher_fence) !== input.publisherFence
  )
    throw unavailable();
  const hash =
    "sourceIdentity" in input
      ? sharingRuleSourceIdentityHash(
          ownerUserId,
          sharingRuleSourceIdentitySchema.parse(input.sourceIdentity)
        )
      : input.portableSourceHash;
  if (!/^[a-f0-9]{64}$/.test(hash)) throw unavailable();
  const result = await client.query<{
    membership_id: string;
    membership_version: number;
    logical_memory_id: string;
    owner_principal_id: string;
    share_grant_id: string | null;
    grant_version: number | null;
    native_admission_id: string | null;
    native_maximum_fidelity: SharedMemoryFidelityCeiling | null;
    native_include_curated_memory: boolean | null;
    policy_history_count: number;
    logical_grant_id: string;
    source_session_id: string;
    source_capabilities: SharedMemoryRepresentation[];
    remote_replica_id: string;
    source_credential_id: string;
    source_revision: number;
    source_owner_policy_id: string | null;
    source_owner_policy_version: number | null;
    owner_maximum_fidelity: SharedMemoryFidelityCeiling | null;
    owner_include_curated_memory: boolean | null;
    protocol_deployment_id: string;
    source_owner_principal_id: string;
  }>(
    `select member.id membership_id,member.membership_version,member.logical_memory_id,memory.owner_principal_id,
       grant_row.id share_grant_id,grant_row.grant_version,coalesce(grant_row.logical_grant_id,native.logical_grant_id) logical_grant_id,origin.source_session_id,
       native.pending_share_id native_admission_id,native.maximum_fidelity native_maximum_fidelity,
       native.include_curated_memory native_include_curated_memory,
       (select count(*)::int from source_owner_representation_policies history where history.logical_memory_id=memory.id) policy_history_count,
       to_json(coalesce(consent.source_capabilities,native.source_capabilities)) source_capabilities,replica.id remote_replica_id,source_credential.id source_credential_id,
       memory.latest_source_revision source_revision,policy.policy_id source_owner_policy_id,policy.version source_owner_policy_version,
       policy.maximum_fidelity owner_maximum_fidelity,policy.include_curated_memory owner_include_curated_memory,
       source_credential.metadata->>'protocolDeploymentId' protocol_deployment_id,
       source_credential.metadata->>'sourceOwnerPrincipalId' source_owner_principal_id
     from team_memory_sharing_rule_members member
     join users owner on owner.id=member.owner_user_id and owner.disabled_at is null and owner.deleted_at is null
     join logical_memories memory on memory.id=member.logical_memory_id and memory.owner_user_id=member.owner_user_id
       and memory.source_kind='captured_session' and memory.lifecycle='active' and memory.invalidated_at is null and memory.purge_completed_at is null
     join captured_session_logical_memories origin on origin.logical_memory_id=memory.id and origin.owner_principal_id=memory.owner_principal_id
     join local_captured_session_logical_memories local_source on local_source.logical_memory_id=memory.id and local_source.owner_user_id=member.owner_user_id
     join sessions cached_session on cached_session.id=local_source.local_session_id and cached_session.owner_user_id=member.owner_user_id
       and cached_session.visibility='personal' and cached_session.invalidated_at is null and cached_session.personal_deleted_at is null
     left join team_memory_share_reasons reason on reason.rule_id=member.rule_id and reason.membership_id=member.id and reason.kind='rule'
     left join source_owner_representation_consents consent on consent.id=reason.consent_id and consent.logical_memory_id=member.logical_memory_id
       and consent.source_owner_principal_id=memory.owner_principal_id
       and consent.team_id=$5 and consent.team_workspace_id=$6 and consent.mode='continuous'
       and consent.state='revoked' and consent.state_reason_code='selection_membership_removed'
     left join team_memory_share_grants grant_row on grant_row.owner_user_id=member.owner_user_id
       and grant_row.logical_memory_id=member.logical_memory_id and grant_row.team_id=$5 and grant_row.team_workspace_id=$6
     left join lateral (
       select original.id pending_share_id,original.logical_grant_id,candidate.source_capabilities,candidate.maximum_fidelity,candidate.include_curated_memory
       from pending_sharing_rule_admissions admission
       join pending_share_operations original on original.id=admission.pending_share_id
       join shared_memory_candidate_previews candidate on candidate.id=original.preview_id and candidate.preview_hash=original.preview_hash
       join logical_memory_source_revision_bindings binding on binding.source_revision_id=candidate.source_revision_id
       where admission.rule_id=member.rule_id and admission.membership_id=member.id and admission.admission_kind='repository_member'
         and original.owner_user_id=member.owner_user_id and original.logical_memory_id=member.logical_memory_id
         and original.team_id=$5 and original.team_workspace_id=$6 and original.mode='continuous' and original.grant_id is null
         and memory.latest_source_revision>=coalesce(original.replacement_source_revision,original.source_revision)
         and candidate.authority_source='device_action_grant' and candidate.invalidated_at is null
         and candidate.team_id=original.team_id and candidate.team_workspace_id=original.team_workspace_id and candidate.mode='continuous' 
         and binding.source_kind='captured_session' and binding.source_session_id=origin.source_session_id
         and candidate.logical_memory_id=member.logical_memory_id and candidate.owner_user_id=member.owner_user_id
         and original.state in ('preparing','needs_attention','failed','revoked')
         and (original.revoked_at is null and original.mutation_id=member.last_mutation_id or exists(
           select 1 from pending_sharing_rule_admissions current_admission
           join pending_share_operations current_pending on current_pending.id=current_admission.pending_share_id
           where current_admission.rule_id=member.rule_id and current_admission.membership_id=member.id
             and current_pending.owner_user_id=member.owner_user_id and current_pending.mutation_id=member.last_mutation_id
             and current_pending.revoked_at is null and current_pending.grant_id is null
             and current_pending.state in ('preparing','needs_attention','failed')
             and current_admission.existing_source_readmission->'input'->>'nativeAdmissionId'=original.id::text
             and current_admission.existing_source_readmission->'input'->>'portableSourceHash'=member.portable_source_hash
             and exists(select 1 from audit_events continuation where continuation.owner_user_id=member.owner_user_id
               and continuation.action='shared_memory.rule.native_admission_continued' and continuation.target_id=original.id
               and continuation.metadata->>'ruleId'=member.rule_id::text and continuation.metadata->>'membershipId'=member.id::text)
         ))
       order by original.created_at,original.id limit 1
     ) native on member.state='unresolved' and consent.id is null
     left join source_owner_representation_policies policy on policy.logical_memory_id=memory.id and policy.source_owner_principal_id=memory.owner_principal_id
       and policy.superseded_at is null
     join memory_replicas replica on replica.logical_memory_id=memory.id and replica.owner_user_id=member.owner_user_id
       and replica.owner_principal_id=memory.owner_principal_id and replica.replica_role='target'
       and replica.encryption_scope='owner_private_replica' and replica.lifecycle='active' and replica.disabled_at is null
       and replica.latest_revision=memory.latest_source_revision
     join cross_identity_sync_relationships sync on sync.logical_memory_id=memory.id and sync.local_replica_id=replica.id
       and sync.local_user_id=member.owner_user_id and sync.side='target' and sync.revoked_at is null
       and sync.state in ('processing','partially_available','ready','stale') and sync.target_processing_cursor=memory.latest_source_revision
     join device_credentials source_credential on source_credential.id=sync.device_credential_id and source_credential.owner_user_id=member.owner_user_id
       and source_credential.revoked_at is null and (source_credential.expires_at is null or source_credential.expires_at>now())
       and source_credential.operation_families @> ARRAY['sync']::text[]
     where member.rule_id=$1 and member.owner_user_id=$2 and member.portable_source_hash=$3
       and (($10='fresh' and member.state='removed' and consent.id is not null) or (member.state='unresolved' and (native.pending_share_id is not null or exists(
         select 1 from pending_sharing_rule_admissions prior
         join pending_share_operations pending on pending.id=prior.pending_share_id
         join shared_memory_candidate_previews candidate on candidate.id=pending.preview_id
         where prior.rule_id=member.rule_id and prior.membership_id=member.id and prior.admission_kind='repository_member'
           and pending.owner_user_id=member.owner_user_id and pending.logical_memory_id=member.logical_memory_id
           and pending.team_id=$5 and pending.team_workspace_id=$6 and pending.mutation_id=member.last_mutation_id
           and pending.grant_id is null and pending.revoked_at is null and pending.state in ('preparing','needs_attention','failed')
           and prior.existing_source_readmission->'input'->>'portableSourceHash'=member.portable_source_hash
           and candidate.authority_source='sharing_rule' and candidate.authority_reference_id=member.rule_id
       ))))
       and (consent.id is not null or native.pending_share_id is not null)
       and member.membership_version=$4 and grant_row.grant_version is not distinct from $7::int
       and (grant_row.id is null or (grant_row.personal_deleted_at is null and grant_row.tombstoned_at is null and grant_row.purge_completed_at is null))
       and ${workspaceSourceIsNotExcludedSql({ ownerUserId: "$2", logicalMemoryId: "member.logical_memory_id", teamWorkspaceId: "$6" })}
       and exists(select 1 from audit_events transfer where transfer.owner_user_id=$2 and transfer.target_table='team_memory_sharing_rules'
         and transfer.target_id=$1 and transfer.action='shared_memory.publisher_transferred'
         and transfer.metadata->'result'->>'publisherCredentialId'=$8
         and (transfer.metadata->'result'->>'publisherFence')::bigint<=$9::bigint)
     for share of source_credential`,
    [
      input.ruleId,
      ownerUserId,
      hash,
      pendingMembershipVersion ?? input.expectedMembershipVersion,
      rule.team_id,
      rule.team_workspace_id,
      input.expectedGrantVersion,
      input.publisherCredentialId,
      input.publisherFence,
      pendingMembershipVersion === undefined ? "fresh" : "pending"
    ]
  );
  if (result.rows.length !== 1) throw unavailable();
  const row = result.rows[0]!,
    maximumFidelity = rule.maximum_fidelity as SharedMemoryFidelityCeiling;
  if (
    !Number.isSafeInteger(Number(row.source_revision)) ||
    Number(row.source_revision) < 1 ||
    !row.protocol_deployment_id ||
    row.source_owner_principal_id !== row.owner_principal_id ||
    crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v2",
      sourceDeploymentId: row.protocol_deployment_id,
      sourceUserId: row.source_owner_principal_id,
      originSessionId: row.source_session_id,
      identity: "logical-memory"
    }) !== row.logical_memory_id ||
    (row.source_owner_policy_id === null
      ? !row.native_admission_id || row.policy_history_count !== 0
      : !sharedMemoryCeilingAuthorizes(
          row.owner_maximum_fidelity!,
          maximumFidelity,
          false
        ) ||
        (rule.include_curated_memory === true &&
          !row.owner_include_curated_memory)) ||
    (row.native_admission_id !== null &&
      (!sharedMemoryCeilingAuthorizes(
        row.native_maximum_fidelity!,
        maximumFidelity,
        false
      ) ||
        (rule.include_curated_memory === true &&
          !row.native_include_curated_memory))) ||
    !row.source_capabilities.includes(maximumFidelity) ||
    (rule.include_curated_memory === true &&
      !row.source_capabilities.includes("curated_assertions"))
  )
    throw unavailable();
  if (row.source_owner_policy_id !== null) {
    const locked = await client.query(
      "select id from source_owner_representation_policies where policy_id=$1 and version=$2 and superseded_at is null for share",
      [row.source_owner_policy_id, row.source_owner_policy_version]
    );
    if (locked.rowCount !== 1) throw unavailable();
  }
  const sourceOwnerPolicyId =
    row.source_owner_policy_id ??
    crossIdentitySyncDeterministicUuid({
      kind: "native_pending_continuation_initial_owner_policy_v1",
      nativeAdmissionId: row.native_admission_id,
      logicalMemoryId: row.logical_memory_id,
      ownerPrincipalId: row.owner_principal_id
    });
  return {
    ruleId: input.ruleId,
    membershipId: row.membership_id,
    membershipVersion: row.membership_version,
    logicalMemoryId: row.logical_memory_id,
    teamId: String(rule.team_id),
    teamWorkspaceId: String(rule.team_workspace_id),
    maximumFidelity,
    includeCuratedMemory: rule.include_curated_memory === true,
    publisherCredentialId: input.publisherCredentialId,
    authorityVersion: input.expectedAuthorityVersion,
    publisherFence: input.publisherFence,
    effectivePrivacyPolicyHash: String(rule.effective_privacy_policy_hash),
    shareGrantId: row.share_grant_id,
    grantVersion: row.grant_version,
    logicalGrantId: row.logical_grant_id,
    sourceSessionId: row.source_session_id,
    sourceCapabilities: row.source_capabilities,
    remoteReplicaId: row.remote_replica_id,
    sourceCredentialId: row.source_credential_id,
    sourceRevision: Number(row.source_revision),
    sourceOwnerPolicyId,
    sourceOwnerPolicyVersion: row.source_owner_policy_version ?? 1,
    portableSourceHash: hash,
    nativeAdmissionId: row.native_admission_id
  };
};

/** Internal persisted evidence; never accepted from a client as authority. */
export interface RuleMemberReadmissionProof {
  input: RuleMemberReadmissionLookup;
  authority: RuleMemberReadmissionAuthority;
}
/** Durable proof contains digests, not native or Personal source identifiers. */
export interface DurableRuleMemberReadmissionProof {
  input: RuleMemberReadmissionLookup;
  authorityHash: string;
}

/** A candidate prepared by Team from an already-bound native source. It cannot
 * authorize a new origin, and only the atomic retained admission accepts it. */
export const persistRuleMemberReadmissionCandidate = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    mutationId: string;
    proof: RuleMemberReadmissionProof;
    preview: import("./shared-memory-repository.js").SharedMemoryPersistedPreviewRecord;
    manifest: Array<{ sourceId: string; revisionHash: string }>;
  }
): Promise<{
  previewId: string;
  previewHash: string;
  previewRevision: number;
}> => {
  const previewHash = crossIdentitySyncDigest({
    kind: "existing_source_readmission_candidate_v1",
    ownerUserId: input.ownerUserId,
    mutationId: input.mutationId,
    authority: input.proof.authority,
    sourcePreview: {
      previewId: input.preview.previewId,
      previewHash: input.preview.previewHash
    },
    manifest: input.manifest
  });
  const previewId = crossIdentitySyncDeterministicUuid({
    kind: "existing_source_readmission_candidate",
    previewHash
  });
  const byteCount = Buffer.byteLength(
    JSON.stringify(input.preview.items),
    "utf8"
  );
  if (
    input.manifest.length < 1 ||
    input.manifest.length > 100 ||
    byteCount < 1 ||
    byteCount > 262144
  )
    throw new SharedMemoryConflictError(
      "Existing source candidate exceeds preparation bounds"
    );
  const inserted = await client.query(
    `insert into shared_memory_candidate_previews
      (id,preview_hash,preview_revision,authority_source,authority_reference_id,
       owner_user_id,logical_memory_id,source_revision_id,team_id,team_workspace_id,
       representation,maximum_fidelity,include_curated_memory,mode,source_revision,
       source_hash,redacted_content_hash,item_count,byte_count,excluded_item_count,
       candidate_manifest,candidate_manifest_hash,representation_policy_revision,representation_policy_hash,
       content_policy_version,content_policy_hash,classifier_version,classifier_hash,
       share_expires_at,expires_at,source_capabilities,activation_representation)
     select $1,$2,1,'sharing_rule',$3,a.owner_user_id,a.logical_memory_id,a.source_revision_id,a.team_id,a.team_workspace_id,
       a.representation,a.maximum_fidelity,a.include_curated_memory,'continuous',a.source_revision,
       $2,$2,$4,$5,0,$6::jsonb,$7,a.representation_policy_revision,a.representation_policy_hash,
       a.content_policy_version,a.content_policy_hash,a.classifier_version,a.classifier_hash,
       null,now()+interval '10 minutes',a.source_capabilities,a.activation_representation
     from shared_source_artifacts a where a.id=$8 and a.owner_user_id=$9 and a.logical_memory_id=$10
       and a.invalidated_at is null returning id`,
    [
      previewId,
      previewHash,
      input.proof.authority.ruleId,
      input.manifest.length,
      byteCount,
      JSON.stringify(input.manifest),
      crossIdentitySyncDigest(input.manifest),
      input.preview.artifactId,
      input.ownerUserId,
      input.proof.authority.logicalMemoryId
    ]
  );
  if (!inserted.rowCount)
    throw new SharedMemoryConflictError(
      "Existing source artifact is unavailable"
    );
  return { previewId, previewHash, previewRevision: 1 };
};
