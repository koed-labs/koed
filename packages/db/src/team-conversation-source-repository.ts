import type pg from "pg";
import { isPrivacyMaterializationSourceAdapter } from "@koed/shared";
import { recordAuditEventWithClient } from "./audit-repository.js";
import type {
  ActorContext,
  ConversationSourceArtifactRecord,
  ConversationSourceSegmentRecord
} from "./types.js";

export type TeamConversationSourceGrantMode = "snapshot" | "continuous";
export type TeamConversationSourceGrantLifecycle = "active" | "revoked";

export interface TeamConversationSourceGrantRecord {
  id: string;
  shareGrantId: string;
  artifactId: string;
  logicalSourceId: string;
  sourceGenerationId: string;
  ownerUserId: string;
  sessionId: string;
  teamId: string;
  teamWorkspaceId: string;
  mode: TeamConversationSourceGrantMode;
  maximumSegmentIndex: number | null;
  maximumSourceOffset: number | null;
  version: number;
  lifecycle: TeamConversationSourceGrantLifecycle;
  mutationId: string;
  grantedByUserId: string;
  creatorAuthority: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
}

export interface TeamConversationSourceAccessRecord {
  grant: TeamConversationSourceGrantRecord;
  artifact: ConversationSourceArtifactRecord;
  components: ConversationSourceArtifactRecord[];
}

export interface TeamConversationSourceManifestRecord extends TeamConversationSourceAccessRecord {
  selectedComponent: ConversationSourceArtifactRecord;
  segments: ConversationSourceSegmentRecord[];
}

export interface TeamConversationSourceGrantReviewRecord {
  shareGrantId: string;
  logicalMemoryId: string;
  sourceTitle: string;
  teamId: string;
  teamName: string;
  teamWorkspaceId: string;
  teamWorkspaceName: string;
  currentVersion: number;
  currentMode: TeamConversationSourceGrantMode | null;
  currentLifecycle: TeamConversationSourceGrantLifecycle | null;
}

export interface TeamConversationSourceRepository {
  getTeamConversationSourceGrantReview(
    actor: ActorContext,
    input: { shareGrantId: string; teamId: string; expectedVersion: number }
  ): Promise<TeamConversationSourceGrantReviewRecord | null>;
  putTeamConversationSourceGrant(
    actor: ActorContext,
    input: {
      mutationId: string;
      shareGrantId: string;
      teamId: string;
      expectedVersion: number;
      mode: TeamConversationSourceGrantMode;
      creatorAuthority: string;
    }
  ): Promise<TeamConversationSourceGrantRecord>;
  revokeTeamConversationSourceGrant(
    actor: ActorContext,
    input: {
      mutationId: string;
      shareGrantId: string;
      teamId: string;
      expectedVersion: number;
      reasonCode: string;
    }
  ): Promise<TeamConversationSourceGrantRecord>;
  getTeamConversationSourceAccess(
    actor: ActorContext,
    input: { shareGrantId: string }
  ): Promise<TeamConversationSourceAccessRecord | null>;
  getTeamConversationSourceManifest(
    actor: ActorContext,
    input: {
      shareGrantId: string;
      sourceComponentId?: string;
      afterSegmentIndex: number;
      limit: number;
      recordAudit?: boolean;
    }
  ): Promise<TeamConversationSourceManifestRecord | null>;
  getTeamConversationSourceSegment(
    actor: ActorContext,
    input: { shareGrantId: string; segmentId: string }
  ): Promise<
    | (TeamConversationSourceAccessRecord & {
        segment: ConversationSourceSegmentRecord;
      })
    | null
  >;
}

export class TeamConversationSourceAuthorizationError extends Error {
  statusCode = 403;
  constructor(
    message = "Team Conversation source operation is not authorized"
  ) {
    super(message);
    this.name = "TeamConversationSourceAuthorizationError";
  }
}

export class TeamConversationSourceConflictError extends Error {
  statusCode = 409;
  constructor(message = "Team Conversation source state conflict") {
    super(message);
    this.name = "TeamConversationSourceConflictError";
  }
}

type Row = Record<string, unknown>;

const stringValue = (value: unknown): string => {
  if (typeof value !== "string") throw new TypeError("Expected string value");
  return value;
};

const numberValue = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new TypeError("Expected integer value");
  return parsed;
};

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : numberValue(value);

const iso = (value: unknown): string => {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new TypeError("Expected timestamp value");
  }
  return new Date(value).toISOString();
};

const nullableIso = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);

const mapGrant = (row: Row): TeamConversationSourceGrantRecord => ({
  id: stringValue(row.id),
  shareGrantId: stringValue(row.share_grant_id),
  artifactId: stringValue(row.artifact_id),
  logicalSourceId: stringValue(row.logical_source_id),
  sourceGenerationId: stringValue(
    row.grant_source_generation_id ?? row.source_generation_id
  ),
  ownerUserId: stringValue(row.owner_user_id),
  sessionId: stringValue(row.session_id),
  teamId: stringValue(row.team_id),
  teamWorkspaceId: stringValue(row.team_workspace_id),
  mode: stringValue(row.mode) as TeamConversationSourceGrantMode,
  maximumSegmentIndex: nullableNumber(row.maximum_segment_index),
  maximumSourceOffset: nullableNumber(row.maximum_source_offset),
  version: numberValue(row.version),
  lifecycle: stringValue(row.lifecycle) as TeamConversationSourceGrantLifecycle,
  mutationId: stringValue(row.mutation_id),
  grantedByUserId: stringValue(row.granted_by_user_id),
  creatorAuthority: stringValue(row.creator_authority),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  revokedAt: nullableIso(row.revoked_at),
  revokedByUserId:
    row.revoked_by_user_id === null || row.revoked_by_user_id === undefined
      ? null
      : stringValue(row.revoked_by_user_id),
  revocationReason:
    row.revocation_reason === null || row.revocation_reason === undefined
      ? null
      : stringValue(row.revocation_reason)
});

const mapArtifact = (row: Row): ConversationSourceArtifactRecord => ({
  id: stringValue(row.artifact_id),
  ownerUserId: stringValue(row.artifact_owner_user_id),
  sessionId: stringValue(row.artifact_session_id),
  logicalSourceId: stringValue(row.logical_source_id),
  sourceGenerationId: stringValue(row.source_generation_id),
  sourceComponentId: stringValue(row.source_component_id),
  sourceComponentRole: stringValue(
    row.source_component_role
  ) as ConversationSourceArtifactRecord["sourceComponentRole"],
  parentSourceComponentId:
    row.parent_source_component_id === null ||
    row.parent_source_component_id === undefined
      ? null
      : stringValue(row.parent_source_component_id),
  contentFraming: stringValue(
    row.content_framing
  ) as ConversationSourceArtifactRecord["contentFraming"],
  replicaRole: stringValue(
    row.replica_role
  ) as ConversationSourceArtifactRecord["replicaRole"],
  sourceKind: stringValue(row.source_kind),
  sourceRuntime: stringValue(
    row.source_runtime
  ) as ConversationSourceArtifactRecord["sourceRuntime"],
  externalSessionId: stringValue(row.external_session_id),
  sourceFingerprint: stringValue(row.source_fingerprint),
  artifactFormat: stringValue(row.artifact_format),
  artifactFormatVersion: numberValue(row.artifact_format_version),
  sourceAdapterVersion: stringValue(row.source_adapter_version),
  lifecycle: stringValue(
    row.artifact_lifecycle
  ) as ConversationSourceArtifactRecord["lifecycle"],
  journalStartOffset: numberValue(row.journal_start_offset),
  journalStartLine: numberValue(row.journal_start_line),
  liveStartOffset: numberValue(row.live_start_offset),
  liveStartLine: numberValue(row.live_start_line),
  providerCursorOffset: numberValue(row.provider_cursor_offset),
  providerCursorLine: numberValue(row.provider_cursor_line),
  currentSourceLength: numberValue(row.current_source_length),
  currentJournalSequence: numberValue(row.current_journal_sequence),
  sourceCreatedAt: iso(row.source_created_at),
  sourceModifiedAt: nullableIso(row.source_modified_at),
  storageProvider: stringValue(row.storage_provider),
  storagePrefix: stringValue(row.storage_prefix),
  closureHash: row.closure_hash ? stringValue(row.closure_hash) : null,
  closureManifest:
    (row.closure_manifest as Record<string, unknown> | null) ?? null,
  closureSignature: row.closure_signature
    ? stringValue(row.closure_signature)
    : null,
  sourceSetClosureHash: row.source_set_closure_hash
    ? stringValue(row.source_set_closure_hash)
    : null,
  sourceSetClosureManifest:
    (row.source_set_closure_manifest as Record<string, unknown> | null) ?? null,
  sourceSetClosureSignature: row.source_set_closure_signature
    ? stringValue(row.source_set_closure_signature)
    : null,
  sourceSetFinalizedAt: nullableIso(row.source_set_finalized_at),
  originDeploymentId: stringValue(row.origin_deployment_id),
  originDeviceId: stringValue(row.origin_device_id),
  originKeyId: stringValue(row.origin_key_id),
  originPublicKey: stringValue(row.origin_public_key),
  originKeyStatus: stringValue(
    row.origin_key_status
  ) as ConversationSourceArtifactRecord["originKeyStatus"],
  priorGenerationClosure:
    (row.prior_generation_closure as Record<string, unknown> | null) ?? null,
  redactedSourceLabel: stringValue(row.redacted_source_label),
  createdAt: iso(row.artifact_created_at),
  updatedAt: iso(row.artifact_updated_at),
  finalizedAt: nullableIso(row.finalized_at)
});

const mapSegment = (row: Row): ConversationSourceSegmentRecord => ({
  id: stringValue(row.segment_id),
  artifactId: stringValue(row.segment_artifact_id),
  segmentIndex: numberValue(row.segment_index),
  sourceStartOffset: numberValue(row.source_start_offset),
  sourceEndOffset: numberValue(row.source_end_offset),
  sourceStartLine: numberValue(row.source_start_line),
  sourceEndLine: numberValue(row.source_end_line),
  plaintextDigest: stringValue(row.plaintext_digest),
  ciphertextDigest: row.ciphertext_digest
    ? stringValue(row.ciphertext_digest)
    : null,
  plaintextSize: numberValue(row.plaintext_size),
  storedSize: numberValue(row.stored_size),
  storageKey: stringValue(row.storage_key),
  storageProvider: stringValue(row.segment_storage_provider),
  encryptionEnvelope:
    (row.encryption_envelope as Record<string, unknown> | null) ?? null,
  signedManifest: row.signed_manifest as Record<string, unknown>,
  originSignature: stringValue(row.origin_signature),
  manifestDigest: stringValue(row.manifest_digest),
  previousContentDigest: row.previous_content_digest
    ? stringValue(row.previous_content_digest)
    : null,
  contentDigest: stringValue(row.content_digest),
  createdAt: iso(row.segment_created_at),
  sealedAt: iso(row.sealed_at)
});

const artifactColumns = `
  artifact.id as artifact_id,
  artifact.owner_user_id as artifact_owner_user_id,
  artifact.session_id as artifact_session_id,
  artifact.logical_source_id, artifact.source_generation_id,
  artifact.source_component_id, artifact.source_component_role,
  artifact.parent_source_component_id, artifact.content_framing,
  artifact.replica_role, artifact.source_kind, artifact.source_runtime,
  artifact.external_session_id, artifact.source_fingerprint,
  artifact.artifact_format, artifact.artifact_format_version,
  artifact.source_adapter_version, artifact.lifecycle as artifact_lifecycle,
  artifact.journal_start_offset, artifact.journal_start_line,
  artifact.live_start_offset, artifact.live_start_line,
  artifact.provider_cursor_offset, artifact.provider_cursor_line,
  artifact.current_source_length, artifact.current_journal_sequence,
  artifact.source_created_at, artifact.source_modified_at,
  artifact.storage_provider, artifact.storage_prefix,
  artifact.closure_hash, artifact.closure_manifest, artifact.closure_signature,
  artifact.source_set_closure_hash, artifact.source_set_closure_manifest,
  artifact.source_set_closure_signature, artifact.source_set_finalized_at,
  artifact.origin_deployment_id, artifact.origin_device_id,
  artifact.origin_key_id, artifact.origin_public_key, artifact.origin_key_status,
  artifact.prior_generation_closure, artifact.redacted_source_label,
  artifact.created_at as artifact_created_at,
  artifact.updated_at as artifact_updated_at, artifact.finalized_at
`;

const authorizedAccessFromSql = `
  from team_conversation_source_grants source_grant
  join team_memory_share_grants share_grant
    on share_grant.id = source_grant.share_grant_id
   and share_grant.team_id = source_grant.team_id
   and share_grant.team_workspace_id = source_grant.team_workspace_id
  join lateral (
    select candidate.*
      from conversation_source_artifacts candidate
     where candidate.owner_user_id = source_grant.owner_user_id
       and candidate.session_id = source_grant.session_id
       and candidate.logical_source_id = source_grant.logical_source_id
       and candidate.source_component_id = 'main'
       and candidate.source_component_role = 'primary'
       and (source_grant.mode = 'continuous'
         or candidate.source_generation_id = source_grant.source_generation_id)
       and ($3::uuid is null or exists (
         select 1
           from conversation_source_segments requested_segment
           join conversation_source_artifacts requested_artifact
             on requested_artifact.id = requested_segment.artifact_id
          where requested_segment.id = $3
            and requested_artifact.owner_user_id = candidate.owner_user_id
            and requested_artifact.logical_source_id = candidate.logical_source_id
            and requested_artifact.source_generation_id = candidate.source_generation_id
       ))
       and candidate.lifecycle = 'finalized'
       and (
         candidate.source_set_finalized_at is not null
         or not exists (
           select 1 from conversation_source_artifacts sibling
            where sibling.owner_user_id = candidate.owner_user_id
              and sibling.logical_source_id = candidate.logical_source_id
              and sibling.source_generation_id = candidate.source_generation_id
              and sibling.id <> candidate.id
         )
       )
     order by candidate.source_created_at desc, candidate.id desc
     limit 1
  ) artifact on true
  join teams team on team.id = source_grant.team_id
   and team.lifecycle = 'active'
   and team.entitlement_status in ('active','grace')
  join users source_owner on source_owner.id = source_grant.owner_user_id
   and source_owner.disabled_at is null and source_owner.deleted_at is null
  join team_memberships membership on membership.team_id = source_grant.team_id
   and membership.user_id = $2
   and membership.status = 'enabled' and membership.disabled_at is null
  join users viewer on viewer.id = membership.user_id
   and viewer.disabled_at is null and viewer.deleted_at is null
  join team_workspaces workspace on workspace.id = source_grant.team_workspace_id
   and workspace.team_id = source_grant.team_id
   and workspace.lifecycle = 'active' and workspace.archived_at is null
  join team_workspace_access_grants workspace_access
    on workspace_access.team_workspace_id = source_grant.team_workspace_id
   and workspace_access.team_id = source_grant.team_id
   and workspace_access.user_id = $2
   and workspace_access.disabled_at is null
   and workspace_access.access in ('read','write')
  join source_owner_representation_consents consent
    on consent.id = share_grant.consent_id
   and consent.state in ('active','paused') and consent.revoked_at is null
   and (consent.expires_at is null or consent.expires_at > now())
`;

const authorizedAccessWhereSql = `
  where source_grant.share_grant_id = $1
    and source_grant.lifecycle = 'active' and source_grant.revoked_at is null
    and share_grant.lifecycle = 'active' and share_grant.revoked_at is null
    and share_grant.personal_deleted_at is null
    and artifact.lifecycle = 'finalized'
`;

const listVerifiedComponents = async (
  client: pg.Pool | pg.PoolClient,
  artifact: ConversationSourceArtifactRecord
): Promise<ConversationSourceArtifactRecord[]> => {
  const result = await client.query<Row>(
    `select ${artifactColumns}
       from conversation_source_artifacts artifact
      where artifact.owner_user_id = $1
        and artifact.session_id = $2
        and artifact.logical_source_id = $3
        and artifact.source_generation_id = $4
        and artifact.lifecycle = 'finalized'
      order by case when artifact.source_component_role = 'primary' then 0 else 1 end,
               artifact.source_component_id`,
    [
      artifact.ownerUserId,
      artifact.sessionId,
      artifact.logicalSourceId,
      artifact.sourceGenerationId
    ]
  );
  const components = result.rows.map(mapArtifact);
  const primary = components.find(
    (component) =>
      component.sourceComponentId === "main" &&
      component.sourceComponentRole === "primary"
  );
  if (
    components.length === 0 ||
    !primary ||
    (components.length > 1 && primary.sourceSetFinalizedAt === null)
  ) {
    throw new TeamConversationSourceConflictError(
      "Conversation Source component set is incomplete"
    );
  }
  return components;
};

const notifySourceGrant = (
  client: pg.Pool | pg.PoolClient,
  input: { shareGrantId: string; reason: "grant_changed" | "revoked" }
) =>
  client.query(
    `select pg_notify(
       'koed_team_conversation_source',
       json_build_object('shareGrantId', $1::uuid, 'reason', $2::text)::text
     )`,
    [input.shareGrantId, input.reason]
  );

export const createTeamConversationSourceRepository = (
  pool: pg.Pool
): TeamConversationSourceRepository => ({
  async getTeamConversationSourceGrantReview(actor, input) {
    const result = await pool.query<Row>(
      `select share_grant.id as share_grant_id,
              share_grant.logical_memory_id,
              coalesce(session.automatic_project_name, session.external_session_id, 'Captured Session') as source_title,
              share_grant.team_id, team.name as team_name,
              share_grant.team_workspace_id,
              workspace.name as team_workspace_name,
              coalesce(source_grant.version, 0) as current_version,
              source_grant.mode as current_mode,
              source_grant.lifecycle as current_lifecycle
         from team_memory_share_grants share_grant
         join logical_memory_source_revision_bindings source_binding
           on source_binding.source_revision_id=share_grant.source_revision_id
         join local_captured_session_logical_memories local_memory
           on local_memory.logical_memory_id=share_grant.logical_memory_id
         join sessions session on session.id=local_memory.local_session_id
         join users source_owner on source_owner.id=share_grant.owner_user_id
          and source_owner.disabled_at is null and source_owner.deleted_at is null
         join teams team on team.id=share_grant.team_id
          and team.entitlement_status in ('active','grace')
         join team_workspaces workspace
           on workspace.id=share_grant.team_workspace_id
          and workspace.team_id=share_grant.team_id
         join source_owner_representation_consents consent
           on consent.id=share_grant.consent_id
          and consent.state='active' and consent.revoked_at is null
          and (consent.expires_at is null or consent.expires_at > now())
         left join team_conversation_source_grants source_grant
           on source_grant.share_grant_id=share_grant.id
        where share_grant.id=$1 and share_grant.owner_user_id=$2
          and source_binding.source_kind='captured_session'
          and share_grant.lifecycle='active' and share_grant.revoked_at is null
          and share_grant.personal_deleted_at is null
          and team.lifecycle='active'
          and workspace.lifecycle='active' and workspace.archived_at is null
          and share_grant.team_id=$3
          and coalesce(source_grant.version, 0)=$4
          and exists (
            select 1 from conversation_source_artifacts artifact
             where artifact.owner_user_id=$2
               and artifact.session_id=local_memory.local_session_id
               and artifact.lifecycle not in ('deleted','deletion_pending','failed','conflicted')
          )
        limit 1`,
      [input.shareGrantId, actor.userId, input.teamId, input.expectedVersion]
    );
    const row = result.rows[0];
    return row
      ? {
          shareGrantId: stringValue(row.share_grant_id),
          logicalMemoryId: stringValue(row.logical_memory_id),
          sourceTitle: stringValue(row.source_title),
          teamId: stringValue(row.team_id),
          teamName: stringValue(row.team_name),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          teamWorkspaceName: stringValue(row.team_workspace_name),
          currentVersion: numberValue(row.current_version),
          currentMode: row.current_mode
            ? (stringValue(row.current_mode) as TeamConversationSourceGrantMode)
            : null,
          currentLifecycle: row.current_lifecycle
            ? (stringValue(
                row.current_lifecycle
              ) as TeamConversationSourceGrantLifecycle)
            : null
        }
      : null;
  },

  async putTeamConversationSourceGrant(actor, input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const parent = await client.query<Row>(
        `select share_grant.*, local_memory.local_session_id
           from team_memory_share_grants share_grant
           join logical_memory_source_revision_bindings source_binding
             on source_binding.source_revision_id=share_grant.source_revision_id
           join local_captured_session_logical_memories local_memory
             on local_memory.logical_memory_id = share_grant.logical_memory_id
           join users source_owner on source_owner.id = share_grant.owner_user_id
            and source_owner.disabled_at is null
            and source_owner.deleted_at is null
           join teams team on team.id = share_grant.team_id
            and team.lifecycle = 'active'
            and team.entitlement_status in ('active','grace')
           join team_workspaces workspace
             on workspace.id = share_grant.team_workspace_id
            and workspace.team_id = share_grant.team_id
            and workspace.lifecycle = 'active'
            and workspace.archived_at is null
           join team_memberships source_membership
             on source_membership.team_id = share_grant.team_id
            and source_membership.user_id = $2
            and source_membership.status = 'enabled'
            and source_membership.disabled_at is null
           join team_workspace_access_grants source_access
             on source_access.team_workspace_id = share_grant.team_workspace_id
            and source_access.team_id = share_grant.team_id
            and source_access.user_id = $2
            and source_access.access = 'write'
            and source_access.can_share_owned_memory = true
            and source_access.disabled_at is null
           join source_owner_representation_consents consent
             on consent.id = share_grant.consent_id
            and consent.state in ('active','paused')
            and consent.revoked_at is null
            and (consent.expires_at is null or consent.expires_at > now())
          where share_grant.id = $1
            and share_grant.owner_user_id = $2
            and source_binding.source_kind = 'captured_session'
            and share_grant.team_id = $3
            and share_grant.lifecycle = 'active'
            and share_grant.revoked_at is null
            and share_grant.personal_deleted_at is null
          for update of share_grant`,
        [input.shareGrantId, actor.userId, input.teamId]
      );
      const parentRow = parent.rows[0];
      if (!parentRow || !parentRow.local_session_id) {
        throw new TeamConversationSourceAuthorizationError();
      }
      const artifactResult = await client.query<Row>(
        `select candidate.* from conversation_source_artifacts candidate
          where candidate.owner_user_id = $1 and candidate.session_id = $2
            and candidate.source_component_id = 'main'
            and candidate.source_component_role = 'primary'
            and candidate.lifecycle = 'finalized'
            and (
              candidate.source_set_finalized_at is not null
              or not exists (
                select 1 from conversation_source_artifacts sibling
                 where sibling.owner_user_id = candidate.owner_user_id
                   and sibling.logical_source_id = candidate.logical_source_id
                   and sibling.source_generation_id = candidate.source_generation_id
                   and sibling.id <> candidate.id
              )
            )
          order by source_created_at desc, id desc
          limit 1
          for share`,
        [actor.userId, parentRow.local_session_id]
      );
      const artifact = artifactResult.rows[0];
      if (!artifact) {
        throw new TeamConversationSourceConflictError(
          "Conversation Source Artifact is unavailable"
        );
      }
      if (
        !isPrivacyMaterializationSourceAdapter({
          sourceKind: artifact.source_kind,
          artifactFormat: artifact.artifact_format,
          artifactFormatVersion: artifact.artifact_format_version
        })
      ) {
        throw new TeamConversationSourceConflictError(
          "Conversation Source Artifact cannot be sanitized for Team access"
        );
      }
      const existing = await client.query<Row>(
        `select * from team_conversation_source_grants
          where share_grant_id = $1 for update`,
        [input.shareGrantId]
      );
      const current = existing.rows[0];
      if (current?.mutation_id === input.mutationId) {
        if (
          stringValue(current.mode) !== input.mode ||
          numberValue(current.version) !== input.expectedVersion + 1
        ) {
          throw new TeamConversationSourceConflictError(
            "Conversation source mutation identity conflict"
          );
        }
        await client.query("commit");
        return mapGrant(current);
      }
      const currentVersion = current ? numberValue(current.version) : 0;
      if (currentVersion !== input.expectedVersion) {
        throw new TeamConversationSourceConflictError(
          "Conversation source grant version conflict"
        );
      }
      const maximumSegmentIndex =
        input.mode === "snapshot"
          ? numberValue(artifact.current_journal_sequence)
          : null;
      const maximumSourceOffset =
        input.mode === "snapshot"
          ? numberValue(artifact.provider_cursor_offset)
          : null;
      if (
        input.mode === "snapshot" &&
        (maximumSegmentIndex === null || maximumSegmentIndex < 0)
      ) {
        throw new TeamConversationSourceConflictError(
          "Conversation Source Artifact has no committed segments"
        );
      }
      const result = current
        ? await client.query<Row>(
            `update team_conversation_source_grants
                set artifact_id = $3, logical_source_id = $11,
                    source_generation_id = $12,
                    owner_user_id = $2, session_id = $4,
                    mode = $5, maximum_segment_index = $6,
                    maximum_source_offset = $7, version = version + 1,
                    lifecycle = 'active', mutation_id = $8,
                    granted_by_user_id = $2, creator_authority = $9,
                    updated_at = now(), revoked_at = null,
                    revoked_by_user_id = null, revocation_reason = null
              where share_grant_id = $1 and version = $10
              returning *`,
            [
              input.shareGrantId,
              actor.userId,
              artifact.id,
              parentRow.local_session_id,
              input.mode,
              maximumSegmentIndex,
              maximumSourceOffset,
              input.mutationId,
              input.creatorAuthority,
              input.expectedVersion,
              artifact.logical_source_id,
              artifact.source_generation_id
            ]
          )
        : await client.query<Row>(
            `insert into team_conversation_source_grants (
               share_grant_id, artifact_id, logical_source_id,
               source_generation_id,
               owner_user_id, session_id,
               team_id, team_workspace_id, mode, maximum_segment_index,
               maximum_source_offset, mutation_id, granted_by_user_id,
               creator_authority
             ) values ($1,$2,$12,$13,$3,$4,$5,$6,$7,$8,$9,$10,$3,$11)
             returning *`,
            [
              input.shareGrantId,
              artifact.id,
              actor.userId,
              parentRow.local_session_id,
              parentRow.team_id,
              parentRow.team_workspace_id,
              input.mode,
              maximumSegmentIndex,
              maximumSourceOffset,
              input.mutationId,
              input.creatorAuthority,
              artifact.logical_source_id,
              artifact.source_generation_id
            ]
          );
      const row = result.rows[0];
      if (!row) throw new TeamConversationSourceConflictError();
      await recordAuditEventWithClient(client, {
        actorUserId: actor.userId,
        ownerUserId: actor.userId,
        visibility: "personal",
        action: "team_conversation_source.grant_changed",
        targetTable: "team_conversation_source_grants",
        targetId: stringValue(row.id),
        metadata: {
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          shareGrantId: input.shareGrantId,
          mode: input.mode,
          version: numberValue(row.version)
        }
      });
      await notifySourceGrant(client, {
        shareGrantId: input.shareGrantId,
        reason: "grant_changed"
      });
      await client.query("commit");
      return mapGrant(row);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async revokeTeamConversationSourceGrant(actor, input) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(input.reasonCode)) {
      throw new TeamConversationSourceConflictError(
        "Conversation source revocation reason is invalid"
      );
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<Row>(
        `update team_conversation_source_grants source_grant
            set lifecycle = 'revoked', version = version + 1,
                mutation_id = $3, revoked_at = now(),
                revoked_by_user_id = $2, revocation_reason = $5,
                updated_at = now()
           from team_memory_share_grants share_grant
          where source_grant.share_grant_id = $1
            and source_grant.version = $4
            and source_grant.lifecycle = 'active'
            and share_grant.id = source_grant.share_grant_id
            and share_grant.owner_user_id = $2
            and source_grant.team_id = $6
            and share_grant.team_id = $6
          returning source_grant.*`,
        [
          input.shareGrantId,
          actor.userId,
          input.mutationId,
          input.expectedVersion,
          input.reasonCode,
          input.teamId
        ]
      );
      const row = result.rows[0];
      if (!row) {
        const replay = await client.query<Row>(
          `select source_grant.*
             from team_conversation_source_grants source_grant
             join team_memory_share_grants share_grant
               on share_grant.id = source_grant.share_grant_id
            where source_grant.share_grant_id = $1
              and source_grant.mutation_id = $3
              and source_grant.lifecycle = 'revoked'
              and share_grant.owner_user_id = $2
              and source_grant.team_id = $4
              and share_grant.team_id = $4`,
          [input.shareGrantId, actor.userId, input.mutationId, input.teamId]
        );
        if (!replay.rows[0]) {
          throw new TeamConversationSourceConflictError();
        }
        if (
          numberValue(replay.rows[0].version) !== input.expectedVersion + 1 ||
          stringValue(replay.rows[0].revocation_reason) !== input.reasonCode
        ) {
          throw new TeamConversationSourceConflictError(
            "Conversation source mutation identity conflict"
          );
        }
        await client.query("commit");
        return mapGrant(replay.rows[0]);
      }
      await recordAuditEventWithClient(client, {
        actorUserId: actor.userId,
        ownerUserId: actor.userId,
        visibility: "personal",
        action: "team_conversation_source.revoked",
        targetTable: "team_conversation_source_grants",
        targetId: stringValue(row.id),
        metadata: {
          teamId: stringValue(row.team_id),
          teamWorkspaceId: stringValue(row.team_workspace_id),
          shareGrantId: input.shareGrantId,
          reasonCode: input.reasonCode,
          version: numberValue(row.version)
        }
      });
      await notifySourceGrant(client, {
        shareGrantId: input.shareGrantId,
        reason: "revoked"
      });
      await client.query("commit");
      return mapGrant(row);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getTeamConversationSourceAccess(actor, input) {
    const result = await pool.query<Row>(
      `select source_grant.*,
              source_grant.source_generation_id as grant_source_generation_id,
              ${artifactColumns}
       ${authorizedAccessFromSql}
       ${authorizedAccessWhereSql}
       limit 1`,
      [input.shareGrantId, actor.userId, null]
    );
    const row = result.rows[0];
    if (!row) return null;
    const artifact = mapArtifact(row);
    return {
      grant: mapGrant(row),
      artifact,
      components: await listVerifiedComponents(pool, artifact)
    };
  },

  async getTeamConversationSourceManifest(actor, input) {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set transaction isolation level repeatable read");
      const access = await client.query<Row>(
        `select source_grant.*,
                source_grant.source_generation_id as grant_source_generation_id,
                ${artifactColumns}
         ${authorizedAccessFromSql}
         ${authorizedAccessWhereSql}
         limit 1`,
        [input.shareGrantId, actor.userId, null]
      );
      const row = access.rows[0];
      if (!row) {
        await client.query("rollback");
        return null;
      }
      const grant = mapGrant(row);
      const artifact = mapArtifact(row);
      const components = await listVerifiedComponents(client, artifact);
      const selectedComponent = input.sourceComponentId
        ? components.find(
            (component) =>
              component.sourceComponentId === input.sourceComponentId
          )
        : components.find(
            (component) => component.sourceComponentRole === "primary"
          );
      if (!selectedComponent) {
        await client.query("rollback");
        return null;
      }
      const segmentRows = await client.query<Row>(
        `select segment.id as segment_id,
                segment.artifact_id as segment_artifact_id,
                segment.segment_index, segment.source_start_offset,
                segment.source_end_offset, segment.source_start_line,
                segment.source_end_line, segment.plaintext_digest,
                segment.ciphertext_digest, segment.plaintext_size,
                segment.stored_size, segment.storage_key,
                segment.storage_provider as segment_storage_provider,
                segment.encryption_envelope, segment.signed_manifest,
                segment.origin_signature, segment.manifest_digest,
                segment.previous_content_digest, segment.content_digest,
                segment.created_at as segment_created_at, segment.sealed_at
           from conversation_source_segments segment
          where segment.artifact_id = $1 and segment.segment_index > $2
            and ($3::integer is null or segment.segment_index <= $3)
          order by segment.segment_index
          limit $4`,
        [
          selectedComponent.id,
          input.afterSegmentIndex,
          grant.mode === "snapshot" &&
          selectedComponent.sourceComponentRole === "primary"
            ? grant.maximumSegmentIndex
            : null,
          limit
        ]
      );
      if (input.recordAudit !== false) {
        await recordAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: grant.ownerUserId,
          visibility: "personal",
          action: "team_conversation_source.manifest_read",
          targetTable: "team_conversation_source_grants",
          targetId: grant.id,
          metadata: {
            teamId: grant.teamId,
            teamWorkspaceId: grant.teamWorkspaceId,
            shareGrantId: grant.shareGrantId,
            segmentCount: segmentRows.rows.length,
            afterSegmentIndex: input.afterSegmentIndex
          }
        });
      }
      await client.query("commit");
      return {
        grant,
        artifact,
        components,
        selectedComponent,
        segments: segmentRows.rows.map(mapSegment)
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getTeamConversationSourceSegment(actor, input) {
    const result = await pool.query<Row>(
      `select source_grant.*,
              source_grant.source_generation_id as grant_source_generation_id,
              ${artifactColumns},
              segment.id as segment_id,
              segment.artifact_id as segment_artifact_id,
              segment.segment_index, segment.source_start_offset,
              segment.source_end_offset, segment.source_start_line,
              segment.source_end_line, segment.plaintext_digest,
              segment.ciphertext_digest, segment.plaintext_size,
              segment.stored_size, segment.storage_key,
              segment.storage_provider as segment_storage_provider,
              segment.encryption_envelope, segment.signed_manifest,
              segment.origin_signature, segment.manifest_digest,
              segment.previous_content_digest, segment.content_digest,
              segment.created_at as segment_created_at, segment.sealed_at
       ${authorizedAccessFromSql}
       join conversation_source_artifacts segment_artifact
         on segment_artifact.owner_user_id = source_grant.owner_user_id
        and segment_artifact.session_id = source_grant.session_id
        and segment_artifact.logical_source_id = source_grant.logical_source_id
        and segment_artifact.source_generation_id = artifact.source_generation_id
        and segment_artifact.lifecycle = 'finalized'
       join conversation_source_segments segment
         on segment.artifact_id = segment_artifact.id
        and segment.id = $3
        and (source_grant.maximum_segment_index is null
          or segment_artifact.source_component_role <> 'primary'
          or segment.segment_index <= source_grant.maximum_segment_index)
       ${authorizedAccessWhereSql}
       limit 1`,
      [input.shareGrantId, actor.userId, input.segmentId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const artifact = mapArtifact(row);
    return {
      grant: mapGrant(row),
      artifact,
      components: await listVerifiedComponents(pool, artifact),
      segment: mapSegment(row)
    };
  }
});
