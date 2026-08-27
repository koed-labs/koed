import { createHash } from "node:crypto";

import {
  decryptEnvelopeToUtf8,
  logicalMemorySourceRevisionIdentity,
  sharedMemoryCeilingAuthorizes,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type SharedMemoryConsent,
  type SharedMemoryFidelityCeiling,
  type SharedMemoryGrant,
  type SharedMemoryRepresentation,
  type SharedMemorySourceRef,
  sharedMemorySourceRefSchema
} from "@koed/shared";
import type pg from "pg";

export interface CollaborationSharedMemoryAuthorityIdentity {
  backendId: string;
  localOwnerUserId: string;
  upstreamUserId: string;
}

export interface CollaborationSharedMemoryCanonicalSourceItem {
  itemType:
    | "user_message"
    | "assistant_message"
    | "thought"
    | "tool_call"
    | "tool_result"
    | "lcm_leaf"
    | "lcm_rollup"
    | "curated_assertion";
  schemaVersion: 1;
  sourceId: string;
  sourceLogicalMemoryId: string;
  sourceRevision: number;
  occurredAt: string | null;
  content: Record<string, unknown>;
}

export interface CollaborationSharedMemorySourceBinding {
  sourceRevision: number;
  sourceHash: string;
  fidelityPolicyRevision: number;
  fidelityPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
}

export interface CollaborationRemoteSharedMemoryPreview {
  source: SharedMemorySourceRef;
  sourceCapabilities: SharedMemoryRepresentation[];
  previewId: string;
  previewHash: string;
  previewRevision: number;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  activationRepresentation: SharedMemoryRepresentation;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  mode: "snapshot" | "continuous";
  binding: CollaborationSharedMemorySourceBinding;
  items: CollaborationSharedMemoryCanonicalSourceItem[];
  sourceContentHash: string;
  sourceRevision: number;
  sourceHash: string;
  createdAt: string;
}

export interface CollaborationPersistedSharedMemoryPreview
  extends
    CollaborationRemoteSharedMemoryPreview,
    CollaborationSharedMemoryAuthorityIdentity {
  previewRevision: number;
}

export interface CollaborationRemoteSharedMemoryConsent {
  source: SharedMemorySourceRef;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  id: string;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  mode: "snapshot" | "continuous";
  state: "pending" | "active" | "paused" | "revoked" | "expired";
  consentVersion: number;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  previewRevision: number;
  previewHash: string;
  sourceRevision: number;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
}

export interface CollaborationPersistedSharedMemoryConsent extends CollaborationSharedMemoryAuthorityIdentity {
  previewId: string;
  consent: SharedMemoryConsent;
}

export interface CollaborationRemoteSharedMemoryGrant {
  source: SharedMemorySourceRef;
  sourceCapabilities: SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  id: string;
  logicalGrantId: string;
  logicalMemoryId: string;
  ownerUserId: string | null;
  teamId: string;
  teamWorkspaceId: string;
  consentId: string;
  mode: "snapshot" | "continuous";
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  fidelityPolicyRevision: number;
  sourceRevision: number;
  grantVersion: number;
  lifecycle: SharedMemoryGrant["lifecycle"];
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  companionScope: {
    scope: "team";
    kind: "shared_session_discussion";
    teamId: string;
    teamWorkspaceId: string;
    logicalMemoryId: string;
    shareGrantId: string;
    [key: string]: unknown;
  };
}

export interface CollaborationPersistedSharedMemoryGrant extends CollaborationSharedMemoryAuthorityIdentity {
  grant: SharedMemoryGrant;
}

export interface CollaborationPersistedSharedSessionBinding extends CollaborationSharedMemoryAuthorityIdentity {
  sharedSessionId: string;
  shareGrantId: string;
  logicalMemoryId: string;
  teamId: string;
  workspaceId: string;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
}

export interface CollaborationSharedMemoryAuthorityStore {
  isEnrollmentBound(
    input: CollaborationSharedMemoryAuthorityIdentity
  ): Promise<boolean>;
  resolvePreviewTarget(
    input: CollaborationSharedMemoryAuthorityIdentity & {
      logicalMemoryId: string;
      teamId: string;
      workspaceId: string;
      representation: SharedMemoryRepresentation;
    }
  ): Promise<{
    remoteReplicaId: string;
    syncRelationshipId: string;
    localSessionId: string;
  } | null>;
  resolvePreviewTargets(
    identity: CollaborationSharedMemoryAuthorityIdentity,
    inputs: Array<{
      logicalMemoryId: string;
      teamId: string;
      workspaceId: string;
      representation: SharedMemoryRepresentation;
    }>
  ): Promise<
    Array<{
      remoteReplicaId: string;
      syncRelationshipId: string;
      localSessionId: string;
    } | null>
  >;
  persistAuthoritativePreview(input: {
    identity: CollaborationSharedMemoryAuthorityIdentity;
    preview: CollaborationRemoteSharedMemoryPreview;
  }): Promise<CollaborationPersistedSharedMemoryPreview | null>;
  persistAuthoritativeCandidatePreview(input: {
    identity: CollaborationSharedMemoryAuthorityIdentity;
    preview: CollaborationRemoteSharedMemoryPreview;
    previewExpiresAt: string;
  }): Promise<CollaborationPersistedSharedMemoryPreview | null>;
  readAuthoritativePreview(
    input: CollaborationSharedMemoryAuthorityIdentity & { previewHash: string }
  ): Promise<CollaborationPersistedSharedMemoryPreview | null>;
  persistAuthoritativeConsent(input: {
    identity: CollaborationSharedMemoryAuthorityIdentity;
    previewId: string;
    consent: CollaborationRemoteSharedMemoryConsent;
  }): Promise<CollaborationPersistedSharedMemoryConsent | null>;
  readAuthoritativeConsent(
    input: CollaborationSharedMemoryAuthorityIdentity & { consentId: string }
  ): Promise<CollaborationPersistedSharedMemoryConsent | null>;
  persistAuthoritativeGrant(input: {
    identity: CollaborationSharedMemoryAuthorityIdentity;
    grant: CollaborationRemoteSharedMemoryGrant;
    prior: CollaborationPersistedSharedMemoryGrant | null;
    mode?: "mutation" | "revocation" | "authoritative_snapshot";
    companion: {
      companionThreadId: string;
      sharedSessionId: string;
    };
  }): Promise<CollaborationPersistedSharedMemoryGrant | null>;
  readAuthoritativeGrant(
    input: CollaborationSharedMemoryAuthorityIdentity & { shareGrantId: string }
  ): Promise<CollaborationPersistedSharedMemoryGrant | null>;
  readAuthoritativeGrants(
    identity: CollaborationSharedMemoryAuthorityIdentity,
    shareGrantIds: string[]
  ): Promise<Array<CollaborationPersistedSharedMemoryGrant | null>>;
  listAuthoritativeGrants(
    input: CollaborationSharedMemoryAuthorityIdentity & {
      logicalMemoryId: string;
    }
  ): Promise<CollaborationPersistedSharedMemoryGrant[] | null>;
  readSharedSessionBinding(
    input: CollaborationSharedMemoryAuthorityIdentity & {
      sharedSessionId: string;
    }
  ): Promise<CollaborationPersistedSharedSessionBinding | null>;
  persistPendingShareSourceWork(input: {
    identity: CollaborationSharedMemoryAuthorityIdentity;
    pendingShareId: string;
    mutationId: string;
    mode: "snapshot" | "continuous";
    source: SharedMemorySourceRef;
    sourceRevision: number;
  }): Promise<boolean>;
  claimPendingShareSourceWork(input?: { limit?: number }): Promise<
    Array<{
      workId: string;
      backendId: string;
      localOwnerUserId: string;
      upstreamUserId: string;
      pendingShareId: string;
      mutationId: string;
      mode: "snapshot" | "continuous";
      source: SharedMemorySourceRef;
    }>
  >;
  finishPendingShareSourceWork(input: {
    workId: string;
    outcome: "completed" | "retry";
    redactedFailureCode?: string;
  }): Promise<boolean>;
  claimContinuousPersonalNoteAdvancementWork(input?: {
    limit?: number;
  }): Promise<
    Array<{
      workId: string;
      backendId: string;
      localOwnerUserId: string;
      noteId: string;
      noteRevision: number;
    }>
  >;
  finishContinuousPersonalNoteAdvancementWork(input: {
    workId: string;
    outcome: "completed" | "retry";
    redactedFailureCode?: string;
  }): Promise<boolean>;
  requeueLatestContinuousPersonalNoteAdvancementWork(input: {
    identity: CollaborationSharedMemoryAuthorityIdentity;
    noteId: string;
  }): Promise<boolean>;
}

export interface CollaborationSharedMemoryAuthorityBindingRepository {
  bindEnrollment(input: {
    identity: CollaborationSharedMemoryAuthorityIdentity;
    remoteDeviceId: string;
  }): Promise<boolean>;
  revokeEnrollment(
    input: CollaborationSharedMemoryAuthorityIdentity & { reason: string }
  ): Promise<boolean>;
  revokeBackendEnrollments(input: {
    backendId: string;
    localOwnerUserId: string;
    reason: string;
  }): Promise<number>;
  bindCompanionSession(input: {
    identity: CollaborationSharedMemoryAuthorityIdentity;
    shareGrantId: string;
    logicalMemoryId: string;
    teamId: string;
    workspaceId: string;
    companionThreadId: string;
    sharedSessionId: string;
  }): Promise<boolean>;
}

export type CollaborationSharedMemoryAuthorityRepository =
  CollaborationSharedMemoryAuthorityStore &
    CollaborationSharedMemoryAuthorityBindingRepository;

export interface CollaborationSharedMemoryAuthorityStoreOptions {
  envelopeEncryptionProvider: EnvelopeEncryptionProvider;
}

type EnrollmentRow = {
  id: string;
  backend_id: string;
  local_owner_user_id: string;
  upstream_user_id: string;
  remote_device_id: string;
};

type CanonicalPreviewTargetRow = {
  relationship_id: string;
  remote_replica_id: string;
  local_session_id: string;
};

type ProtectedRow = {
  protected_dto: EncryptedPayloadEnvelope;
  protected_dto_hash: string;
};

type PreviewRow = ProtectedRow & {
  preview_id: string;
  preview_hash: string;
  preview_revision: number;
  logical_memory_id: string;
  team_id: string;
  team_workspace_id: string;
  representation: SharedMemoryRepresentation;
  maximum_fidelity: SharedMemoryFidelityCeiling;
  include_curated_memory: boolean;
  mode: "snapshot" | "continuous";
  source_revision: string | number;
  source_hash: string;
  source_content_hash: string;
  item_count: number;
  expires_at: Date | string;
};

type ConsentRow = ProtectedRow & {
  consent_id: string;
  consent_version: number;
  preview_id: string;
  preview_hash: string;
  preview_revision: number;
  logical_memory_id: string;
  team_id: string;
  team_workspace_id: string;
  maximum_fidelity: SharedMemoryFidelityCeiling;
  include_curated_memory: boolean;
  mode: "snapshot" | "continuous";
  source_revision: string | number;
};

type CompanionRow = {
  id: string;
  share_grant_id: string;
  logical_memory_id: string;
  team_id: string;
  team_workspace_id: string;
  companion_thread_id: string;
  shared_session_id: string;
};

type GrantRow = ProtectedRow & {
  share_grant_id: string;
  logical_grant_id: string;
  logical_memory_id: string;
  consent_id: string;
  team_id: string;
  team_workspace_id: string;
  maximum_fidelity: SharedMemoryFidelityCeiling;
  include_curated_memory: boolean;
  mode: "snapshot" | "continuous";
  source_revision: string | number;
  grant_version: number;
  lifecycle: SharedMemoryGrant["lifecycle"];
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const backendIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const representationSet = new Set<SharedMemoryRepresentation>([
  "memory_events",
  "lcm_leaves",
  "lcm_rollups",
  "curated_assertions"
]);
const fidelitySet = new Set<SharedMemoryFidelityCeiling>([
  "memory_events",
  "lcm_leaves",
  "lcm_rollups"
]);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);

const isHash = (value: unknown): value is string =>
  typeof value === "string" && hashPattern.test(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isRepresentation = (
  value: unknown
): value is SharedMemoryRepresentation =>
  typeof value === "string" &&
  representationSet.has(value as SharedMemoryRepresentation);

const validRepresentations = (
  values: unknown
): values is SharedMemoryRepresentation[] =>
  Array.isArray(values) &&
  values.length >= 1 &&
  values.length <= 4 &&
  values.every(isRepresentation) &&
  new Set(values).size === values.length;
const isFidelity = (value: unknown): value is SharedMemoryFidelityCeiling =>
  typeof value === "string" &&
  fidelitySet.has(value as SharedMemoryFidelityCeiling);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const hashDto = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const sameDto = (left: unknown, right: unknown): boolean =>
  hashDto(left) === hashDto(right) &&
  canonicalJson(left) === canonicalJson(right);

const grantAuthoritySnapshot = (
  grant: SharedMemoryGrant
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(grant).filter(
      ([key]) => key !== "sourceRevision" && key !== "updatedAt"
    )
  );

const canRefreshAuthoritativeGrant = (
  current: CollaborationPersistedSharedMemoryGrant,
  next: CollaborationPersistedSharedMemoryGrant
): boolean => {
  if (
    !sameIdentity(current, next) ||
    current.grant.lifecycle !== "active" ||
    next.grant.lifecycle !== "active" ||
    current.grant.revokedAt !== null ||
    next.grant.revokedAt !== null ||
    next.grant.sourceRevision <= current.grant.sourceRevision ||
    Date.parse(next.grant.updatedAt) <= Date.parse(current.grant.updatedAt)
  ) {
    return false;
  }
  return sameDto(
    grantAuthoritySnapshot(current.grant),
    grantAuthoritySnapshot(next.grant)
  );
};

const validIdentity = (
  identity: CollaborationSharedMemoryAuthorityIdentity
): boolean =>
  backendIdPattern.test(identity.backendId) &&
  isUuid(identity.localOwnerUserId) &&
  isUuid(identity.upstreamUserId);

const sameIdentity = (
  value: CollaborationSharedMemoryAuthorityIdentity,
  identity: CollaborationSharedMemoryAuthorityIdentity
): boolean =>
  value.backendId === identity.backendId &&
  value.localOwnerUserId === identity.localOwnerUserId &&
  value.upstreamUserId === identity.upstreamUserId;

const withTransaction = async <T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

const lockBinding = async (
  client: pg.PoolClient,
  key: string
): Promise<void> => {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key
  ]);
};

const activeEnrollment = async (
  client: pg.Pool | pg.PoolClient,
  identity: CollaborationSharedMemoryAuthorityIdentity,
  lock: "share" | "update" | null = null
): Promise<EnrollmentRow | null> => {
  if (!validIdentity(identity)) return null;
  const result = await client.query<EnrollmentRow>(
    `select id, backend_id, local_owner_user_id, upstream_user_id, remote_device_id
       from collaboration_shared_memory_enrollments
      where backend_id = $1
        and local_owner_user_id = $2
        and upstream_user_id = $3
        and revoked_at is null
      limit 1
      ${lock === "share" ? "for share" : lock === "update" ? "for update" : ""}`,
    [identity.backendId, identity.localOwnerUserId, identity.upstreamUserId]
  );
  return result.rows[0] ?? null;
};

const canonicalPreviewTarget = async (
  client: pg.Pool | pg.PoolClient,
  enrollmentId: string,
  logicalMemoryId: string
): Promise<CanonicalPreviewTargetRow | null> => {
  const result = await client.query<CanonicalPreviewTargetRow>(
    `select relationship.id as relationship_id,
            relationship.remote_replica_id,
            local_memory.local_session_id
       from collaboration_shared_memory_enrollments enrollment
       join deployment_identities deployment
         on deployment.upstream_backend_id = enrollment.backend_id
        and deployment.locality = 'remote'
        and deployment.disabled_at is null
       join sync_external_user_identities remote_user
         on remote_user.deployment_identity_id = deployment.id
        and remote_user.external_subject_id = enrollment.upstream_user_id::text
        and remote_user.status = 'active'
        and remote_user.revoked_at is null
       join sync_principal_links principal_link
         on principal_link.local_user_id = enrollment.local_owner_user_id
        and principal_link.external_user_identity_id = remote_user.id
        and principal_link.revoked_at is null
       join cross_identity_sync_relationships relationship
         on relationship.local_user_id = enrollment.local_owner_user_id
        and relationship.remote_deployment_identity_id = deployment.id
        and relationship.remote_user_identity_id = remote_user.id
        and relationship.logical_memory_id = $2
        and relationship.side = 'source'
        and relationship.remote_replica_id is not null
        and relationship.revoked_at is null
        and relationship.state in
          ('uploading','uploaded','verified','processing','partially_available',
           'ready','stale','paused')
       join memory_replicas replica
         on replica.id = relationship.local_replica_id
        and replica.owner_user_id = enrollment.local_owner_user_id
       join local_captured_session_logical_memories local_memory
         on local_memory.logical_memory_id=relationship.logical_memory_id
        and local_memory.owner_user_id=enrollment.local_owner_user_id
      where enrollment.id = $1
        and enrollment.revoked_at is null
      limit 1`,
    [enrollmentId, logicalMemoryId]
  );
  return result.rows[0] ?? null;
};

const encryptedDto = async (
  provider: EnvelopeEncryptionProvider,
  input: {
    table: string;
    sourceId: string;
    identity: CollaborationSharedMemoryAuthorityIdentity;
    dto: unknown;
  }
): Promise<{ envelope: EncryptedPayloadEnvelope; hash: string }> => {
  const plaintext = canonicalJson(input.dto);
  return {
    hash: createHash("sha256").update(plaintext).digest("hex"),
    envelope: await provider.encrypt({
      plaintext,
      scope: {
        deploymentId: input.identity.backendId,
        tenantId: input.identity.localOwnerUserId,
        objectClass: "collaboration_shared_memory_authority"
      },
      provenance: {
        rowFamily: "collaboration_shared_memory_authority",
        sourceTable: input.table,
        sourceColumn: "protected_dto",
        sourceId: input.sourceId
      },
      ciphertextLocation: input.table,
      aad: {
        backendId: input.identity.backendId,
        localOwnerUserId: input.identity.localOwnerUserId,
        upstreamUserId: input.identity.upstreamUserId,
        sourceId: input.sourceId
      }
    })
  };
};

const decryptDto = async <T>(
  provider: EnvelopeEncryptionProvider,
  row: ProtectedRow,
  validate: (value: unknown) => value is T
): Promise<T | null> => {
  try {
    const plaintext = await decryptEnvelopeToUtf8(provider, row.protected_dto);
    if (
      createHash("sha256").update(plaintext).digest("hex") !==
      row.protected_dto_hash
    ) {
      return null;
    }
    const value: unknown = JSON.parse(plaintext);
    return validate(value) && hashDto(value) === row.protected_dto_hash
      ? value
      : null;
  } catch {
    return null;
  }
};

const validPersistedPreview = (
  value: unknown
): value is CollaborationPersistedSharedMemoryPreview => {
  if (!isObject(value) || !isObject(value.binding)) return false;
  const binding = value.binding;
  if (
    !backendIdPattern.test(String(value.backendId)) ||
    !isUuid(value.localOwnerUserId) ||
    !isUuid(value.upstreamUserId) ||
    !isUuid(value.previewId) ||
    !isHash(value.previewHash) ||
    !isPositiveInteger(value.previewRevision) ||
    !isUuid(value.logicalMemoryId) ||
    !isUuid(value.teamId) ||
    !isUuid(value.teamWorkspaceId) ||
    !Array.isArray(value.sourceCapabilities) ||
    !validRepresentations(value.sourceCapabilities) ||
    !isRepresentation(value.activationRepresentation) ||
    !isRepresentation(value.representation) ||
    value.representation !== value.activationRepresentation ||
    !isFidelity(value.maximumFidelity) ||
    typeof value.includeCuratedMemory !== "boolean" ||
    (value.mode !== "snapshot" && value.mode !== "continuous") ||
    !sharedMemoryCeilingAuthorizes(
      value.maximumFidelity,
      value.activationRepresentation,
      value.includeCuratedMemory
    ) ||
    !value.sourceCapabilities.includes(value.activationRepresentation) ||
    !isRevision(value.sourceRevision) ||
    !isHash(value.sourceHash) ||
    !isHash(value.sourceContentHash) ||
    !isTimestamp(value.createdAt) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 2_048
  ) {
    return false;
  }
  if (
    !isRevision(binding.sourceRevision) ||
    !isHash(binding.sourceHash) ||
    !isPositiveInteger(binding.fidelityPolicyRevision) ||
    !isHash(binding.fidelityPolicyHash) ||
    !isPositiveInteger(binding.contentPolicyVersion) ||
    !isHash(binding.contentPolicyHash) ||
    !isPositiveInteger(binding.classifierVersion) ||
    !isHash(binding.classifierHash) ||
    binding.sourceRevision !== value.sourceRevision ||
    binding.sourceHash !== value.sourceHash
  ) {
    return false;
  }
  const source = sharedMemorySourceRefSchema.safeParse(value.source);
  if (
    !source.success ||
    source.data.logicalMemoryId !== value.logicalMemoryId
  ) {
    return false;
  }
  const firstItem: unknown = value.items[0];
  if (
    source.success &&
    source.data.kind === "personal_note" &&
    (value.activationRepresentation !== "memory_events" ||
      value.sourceCapabilities.length !== 1 ||
      value.sourceCapabilities[0] !== "memory_events" ||
      value.maximumFidelity !== "memory_events" ||
      value.includeCuratedMemory ||
      value.sourceRevision !== source.data.noteRevision ||
      value.items.length !== 1 ||
      !isObject(firstItem) ||
      firstItem.sourceId !== source.data.memoryEventId)
  ) {
    return false;
  }
  return value.items.every((item) => {
    if (!isObject(item)) return false;
    return (
      [
        "user_message",
        "assistant_message",
        "thought",
        "tool_call",
        "tool_result",
        "lcm_leaf",
        "lcm_rollup",
        "curated_assertion"
      ].includes(String(item.itemType)) &&
      item.schemaVersion === 1 &&
      isUuid(item.sourceId) &&
      item.sourceLogicalMemoryId === value.logicalMemoryId &&
      item.sourceRevision === value.sourceRevision &&
      (item.occurredAt === null || isTimestamp(item.occurredAt)) &&
      isObject(item.content)
    );
  });
};

const validPersistedConsent = (
  value: unknown
): value is CollaborationPersistedSharedMemoryConsent => {
  if (!isObject(value) || !isObject(value.consent)) return false;
  const consent = value.consent;
  return (
    backendIdPattern.test(String(value.backendId)) &&
    isUuid(value.localOwnerUserId) &&
    isUuid(value.upstreamUserId) &&
    isUuid(value.previewId) &&
    (consent.source === undefined ||
      sharedMemorySourceRefSchema.safeParse(consent.source).success) &&
    isUuid(consent.id) &&
    isUuid(consent.logicalMemoryId) &&
    isUuid(consent.teamId) &&
    isUuid(consent.workspaceId) &&
    ["snapshot", "continuous"].includes(String(consent.mode)) &&
    ["pending", "active", "paused", "revoked", "expired"].includes(
      String(consent.state)
    ) &&
    isPositiveInteger(consent.version) &&
    isFidelity(consent.maximumFidelity) &&
    typeof consent.includeCuratedMemory === "boolean" &&
    isPositiveInteger(consent.previewRevision) &&
    isHash(consent.previewHash) &&
    isRevision(consent.sourceRevision) &&
    isTimestamp(consent.createdAt) &&
    isTimestamp(consent.updatedAt) &&
    (consent.activatedAt === null || isTimestamp(consent.activatedAt)) &&
    (consent.revokedAt === null || isTimestamp(consent.revokedAt))
  );
};

const validPersistedGrant = (
  value: unknown
): value is CollaborationPersistedSharedMemoryGrant => {
  if (!isObject(value) || !isObject(value.grant)) return false;
  const grant = value.grant;
  return (
    backendIdPattern.test(String(value.backendId)) &&
    isUuid(value.localOwnerUserId) &&
    isUuid(value.upstreamUserId) &&
    (grant.source === undefined ||
      sharedMemorySourceRefSchema.safeParse(grant.source).success) &&
    isUuid(grant.id) &&
    isUuid(grant.logicalGrantId) &&
    isUuid(grant.logicalMemoryId) &&
    (grant.ownerUserId === null || isUuid(grant.ownerUserId)) &&
    isUuid(grant.teamId) &&
    isUuid(grant.workspaceId) &&
    isUuid(grant.consentId) &&
    isFidelity(grant.maximumFidelity) &&
    typeof grant.includeCuratedMemory === "boolean" &&
    isPositiveInteger(grant.fidelityPolicyRevision) &&
    isRevision(grant.sourceRevision) &&
    isPositiveInteger(grant.grantVersion) &&
    [
      "active",
      "unavailable",
      "revoked",
      "tombstoned",
      "purge_pending",
      "purged"
    ].includes(String(grant.lifecycle)) &&
    isTimestamp(grant.createdAt) &&
    isTimestamp(grant.updatedAt) &&
    (grant.revokedAt === null || isTimestamp(grant.revokedAt)) &&
    isUuid(grant.companionThreadId)
  );
};

const previewMatchesRow = (
  value: CollaborationPersistedSharedMemoryPreview,
  row: PreviewRow,
  identity: CollaborationSharedMemoryAuthorityIdentity
): boolean =>
  sameIdentity(value, identity) &&
  value.previewId === row.preview_id &&
  value.previewHash === row.preview_hash &&
  value.previewRevision === row.preview_revision &&
  value.logicalMemoryId === row.logical_memory_id &&
  value.teamId === row.team_id &&
  value.teamWorkspaceId === row.team_workspace_id &&
  value.activationRepresentation === row.representation &&
  value.representation === row.representation &&
  value.maximumFidelity === row.maximum_fidelity &&
  value.includeCuratedMemory === row.include_curated_memory &&
  value.sourceRevision === Number(row.source_revision) &&
  value.sourceHash === row.source_hash &&
  value.sourceContentHash === row.source_content_hash &&
  value.items.length === row.item_count;

const consentMatchesRow = (
  value: CollaborationPersistedSharedMemoryConsent,
  row: ConsentRow,
  identity: CollaborationSharedMemoryAuthorityIdentity
): boolean =>
  sameIdentity(value, identity) &&
  value.consent.id === row.consent_id &&
  value.consent.version === row.consent_version &&
  value.previewId === row.preview_id &&
  value.consent.previewHash === row.preview_hash &&
  value.consent.previewRevision === row.preview_revision &&
  value.consent.logicalMemoryId === row.logical_memory_id &&
  value.consent.teamId === row.team_id &&
  value.consent.workspaceId === row.team_workspace_id &&
  value.consent.maximumFidelity === row.maximum_fidelity &&
  value.consent.includeCuratedMemory === row.include_curated_memory &&
  value.consent.sourceRevision === Number(row.source_revision);

const grantMatchesRow = (
  value: CollaborationPersistedSharedMemoryGrant,
  row: GrantRow,
  identity: CollaborationSharedMemoryAuthorityIdentity
): boolean =>
  sameIdentity(value, identity) &&
  value.grant.id === row.share_grant_id &&
  value.grant.logicalGrantId === row.logical_grant_id &&
  value.grant.logicalMemoryId === row.logical_memory_id &&
  value.grant.consentId === row.consent_id &&
  value.grant.teamId === row.team_id &&
  value.grant.workspaceId === row.team_workspace_id &&
  value.grant.maximumFidelity === row.maximum_fidelity &&
  value.grant.includeCuratedMemory === row.include_curated_memory &&
  value.grant.mode === row.mode &&
  value.grant.sourceRevision === Number(row.source_revision) &&
  value.grant.grantVersion === row.grant_version &&
  value.grant.lifecycle === row.lifecycle;

const mapConsent = (
  consent: CollaborationRemoteSharedMemoryConsent
): SharedMemoryConsent => ({
  source: consent.source,
  sourceCapabilities: consent.sourceCapabilities,
  activationRepresentation: consent.activationRepresentation,
  id: consent.id,
  logicalMemoryId: consent.logicalMemoryId,
  teamId: consent.teamId,
  workspaceId: consent.teamWorkspaceId,
  mode: consent.mode,
  state: consent.state,
  version: consent.consentVersion,
  maximumFidelity: consent.maximumFidelity,
  includeCuratedMemory: consent.includeCuratedMemory,
  previewRevision: consent.previewRevision,
  previewHash: consent.previewHash,
  sourceRevision: consent.sourceRevision,
  createdAt: consent.createdAt,
  updatedAt: consent.updatedAt,
  activatedAt: consent.activatedAt,
  revokedAt: consent.revokedAt
});

const mapGrant = (
  grant: CollaborationRemoteSharedMemoryGrant,
  companionThreadId: string
): SharedMemoryGrant => ({
  source: grant.source,
  sourceCapabilities: grant.sourceCapabilities,
  activationRepresentation: grant.activationRepresentation,
  id: grant.id,
  logicalGrantId: grant.logicalGrantId,
  logicalMemoryId: grant.logicalMemoryId,
  ownerUserId: grant.ownerUserId,
  teamId: grant.teamId,
  workspaceId: grant.teamWorkspaceId,
  consentId: grant.consentId,
  mode: grant.mode,
  maximumFidelity: grant.maximumFidelity,
  includeCuratedMemory: grant.includeCuratedMemory,
  fidelityPolicyRevision: grant.fidelityPolicyRevision,
  sourceRevision: grant.sourceRevision,
  grantVersion: grant.grantVersion,
  lifecycle: grant.lifecycle,
  createdAt: grant.createdAt,
  updatedAt: grant.updatedAt,
  revokedAt: grant.revokedAt,
  companionThreadId
});

const reconcileContinuousPersonalNoteGrant = async (
  client: pg.PoolClient,
  input: {
    enrollmentId: string;
    localOwnerUserId: string;
    grant: SharedMemoryGrant;
  }
): Promise<void> => {
  const source = input.grant.source;
  if (
    input.grant.mode !== "continuous" ||
    input.grant.lifecycle !== "active" ||
    source?.kind !== "personal_note"
  ) {
    return;
  }
  await client.query(
    `insert into collaboration_continuous_note_advancement_work
       (enrollment_id,local_owner_user_id,source_revision_id)
     select $1,$2,latest.source_revision_id
       from (
         select local_revision.source_revision_id
           from local_personal_note_source_revisions local_revision
           join personal_note_source_revisions source_revision
             on source_revision.source_revision_id=local_revision.source_revision_id
          where local_revision.local_note_id=$3
            and source_revision.logical_memory_id=$4
            and source_revision.owner_principal_id=$2
            and source_revision.revision>$5
          order by source_revision.revision desc
          limit 1
       ) latest
     on conflict (enrollment_id,source_revision_id) do update
       set state='pending',available_at=now(),locked_at=null,
           completed_at=null,redacted_failure_code=null,updated_at=now()
     where collaboration_continuous_note_advancement_work.state in ('completed','failed')`,
    [
      input.enrollmentId,
      input.localOwnerUserId,
      source.noteId,
      input.grant.logicalMemoryId,
      input.grant.sourceRevision
    ]
  );
};

const selectPreviewSql = `select preview_id, preview_hash, preview_revision,
                                 logical_memory_id, team_id, team_workspace_id,
                                 representation, maximum_fidelity,
                                 include_curated_memory, source_revision, source_hash,
                                 source_content_hash, item_count,
                                 protected_dto_hash, protected_dto, expires_at
                            from collaboration_shared_memory_previews`;
const selectConsentSql = `select consent_id, consent_version, preview_id,
                                 preview_hash, preview_revision,
                                 logical_memory_id, team_id,
                                 team_workspace_id, maximum_fidelity,
                                 include_curated_memory, source_revision,
                                 protected_dto_hash, protected_dto
                            from collaboration_shared_memory_consents`;
const grantProjectionSql = `share_grant_id, logical_grant_id, logical_memory_id,
                            consent_id, team_id, team_workspace_id,
                            maximum_fidelity, include_curated_memory, mode,
                            source_revision, grant_version, lifecycle,
                            protected_dto_hash, protected_dto`;
const selectGrantSql = `select ${grantProjectionSql}
                          from collaboration_shared_memory_grants`;

export const createCollaborationSharedMemoryAuthorityStore = (
  pool: pg.Pool,
  options: CollaborationSharedMemoryAuthorityStoreOptions
): CollaborationSharedMemoryAuthorityRepository => {
  const provider = options.envelopeEncryptionProvider;

  const revokeActiveBackendBindings = async (
    client: pg.PoolClient,
    input: {
      backendId: string;
      localOwnerUserId: string;
      reason: string;
    }
  ): Promise<number> => {
    const active = await client.query<{ id: string }>(
      `select id
         from collaboration_shared_memory_enrollments
        where backend_id = $1 and local_owner_user_id = $2
          and revoked_at is null
        for update`,
      [input.backendId, input.localOwnerUserId]
    );
    if (active.rowCount === 0) return 0;
    const enrollmentIds = active.rows.map((row) => row.id);
    await client.query(
      `update collaboration_shared_memory_companion_bindings
          set revoked_at = coalesce(revoked_at, now())
        where enrollment_id = any($1::uuid[]) and revoked_at is null`,
      [enrollmentIds]
    );
    const revoked = await client.query(
      `update collaboration_shared_memory_enrollments
          set revoked_at = now(), revocation_reason = $3, updated_at = now()
        where backend_id = $1 and local_owner_user_id = $2
          and revoked_at is null`,
      [input.backendId, input.localOwnerUserId, input.reason.slice(0, 160)]
    );
    return revoked.rowCount ?? 0;
  };

  const readPreviewRow = async (
    client: pg.Pool | pg.PoolClient,
    enrollmentId: string,
    predicate: {
      includeExpired?: boolean;
      previewHash?: string;
      previewId?: string;
    }
  ): Promise<PreviewRow | null> => {
    const column = predicate.previewHash ? "preview_hash" : "preview_id";
    const value = predicate.previewHash ?? predicate.previewId;
    if (!value) return null;
    const result = await client.query<PreviewRow>(
      `${selectPreviewSql}
        where enrollment_id = $1 and ${column} = $2
        limit 1`,
      [enrollmentId, value]
    );
    const row = result.rows[0] ?? null;
    return row &&
      (predicate.includeExpired ||
        new Date(row.expires_at).getTime() > Date.now())
      ? row
      : null;
  };

  const decodePreview = async (
    row: PreviewRow,
    identity: CollaborationSharedMemoryAuthorityIdentity
  ): Promise<CollaborationPersistedSharedMemoryPreview | null> => {
    const dto = await decryptDto(provider, row, validPersistedPreview);
    return dto && previewMatchesRow(dto, row, identity) ? dto : null;
  };

  const decodeConsent = async (
    row: ConsentRow,
    identity: CollaborationSharedMemoryAuthorityIdentity
  ): Promise<CollaborationPersistedSharedMemoryConsent | null> => {
    const dto = await decryptDto(provider, row, validPersistedConsent);
    return dto && consentMatchesRow(dto, row, identity) ? dto : null;
  };

  const decodeGrant = async (
    row: GrantRow,
    identity: CollaborationSharedMemoryAuthorityIdentity
  ): Promise<CollaborationPersistedSharedMemoryGrant | null> => {
    const dto = await decryptDto(provider, row, validPersistedGrant);
    return dto && grantMatchesRow(dto, row, identity) ? dto : null;
  };

  const bindEnrollment: CollaborationSharedMemoryAuthorityBindingRepository["bindEnrollment"] =
    async ({ identity, remoteDeviceId }) => {
      if (!validIdentity(identity) || !isUuid(remoteDeviceId)) return false;
      return withTransaction(pool, async (client) => {
        await lockBinding(
          client,
          `csm:enrollment:${identity.localOwnerUserId}:${identity.backendId}`
        );
        const current = await activeEnrollment(client, identity, "update");
        if (current?.remote_device_id === remoteDeviceId) return true;
        const collision = await client.query<EnrollmentRow>(
          `select id, backend_id, local_owner_user_id, upstream_user_id, remote_device_id
             from collaboration_shared_memory_enrollments
            where local_owner_user_id = $1 and backend_id = $2 and revoked_at is null
            limit 1`,
          [identity.localOwnerUserId, identity.backendId]
        );
        if (collision.rowCount) {
          await revokeActiveBackendBindings(client, {
            backendId: identity.backendId,
            localOwnerUserId: identity.localOwnerUserId,
            reason: "authenticated_upstream_identity_rotation"
          });
        }
        try {
          await client.query(
            `insert into collaboration_shared_memory_enrollments
               (backend_id, local_owner_user_id, upstream_user_id, remote_device_id)
             values ($1, $2, $3, $4)`,
            [
              identity.backendId,
              identity.localOwnerUserId,
              identity.upstreamUserId,
              remoteDeviceId
            ]
          );
          return true;
        } catch (error) {
          if (isObject(error) && error.code === "23505") return false;
          throw error;
        }
      });
    };

  const revokeEnrollment: CollaborationSharedMemoryAuthorityBindingRepository["revokeEnrollment"] =
    async (input) => {
      if (!validIdentity(input) || !input.reason.trim()) return false;
      const result = await pool.query(
        `update collaboration_shared_memory_enrollments
            set revoked_at = now(), revocation_reason = $4, updated_at = now()
          where backend_id = $1 and local_owner_user_id = $2
            and upstream_user_id = $3 and revoked_at is null`,
        [
          input.backendId,
          input.localOwnerUserId,
          input.upstreamUserId,
          input.reason.trim().slice(0, 160)
        ]
      );
      return result.rowCount === 1;
    };

  const revokeBackendEnrollments: CollaborationSharedMemoryAuthorityBindingRepository["revokeBackendEnrollments"] =
    async (input) => {
      if (
        !backendIdPattern.test(input.backendId) ||
        !isUuid(input.localOwnerUserId) ||
        !input.reason.trim()
      ) {
        return 0;
      }
      return withTransaction(pool, async (client) => {
        await lockBinding(
          client,
          `csm:enrollment:${input.localOwnerUserId}:${input.backendId}`
        );
        return revokeActiveBackendBindings(client, {
          backendId: input.backendId,
          localOwnerUserId: input.localOwnerUserId,
          reason: input.reason.trim()
        });
      });
    };

  const bindCompanionSession: CollaborationSharedMemoryAuthorityBindingRepository["bindCompanionSession"] =
    async (input) => {
      if (
        !validIdentity(input.identity) ||
        !isUuid(input.shareGrantId) ||
        !isUuid(input.logicalMemoryId) ||
        !isUuid(input.teamId) ||
        !isUuid(input.workspaceId) ||
        !isUuid(input.companionThreadId) ||
        !isUuid(input.sharedSessionId)
      ) {
        return false;
      }
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(
          client,
          input.identity,
          "update"
        );
        if (!enrollment) return false;
        await lockBinding(
          client,
          `csm:companion:${enrollment.id}:${input.shareGrantId}`
        );
        const current = await client.query<
          CompanionRow & { revoked_at: Date | null }
        >(
          `select id, share_grant_id, logical_memory_id, team_id,
                  team_workspace_id, companion_thread_id, shared_session_id, revoked_at
             from collaboration_shared_memory_companion_bindings
            where enrollment_id = $1 and share_grant_id = $2
            order by created_at desc limit 1`,
          [enrollment.id, input.shareGrantId]
        );
        const row = current.rows[0];
        if (row) {
          return (
            !row.revoked_at &&
            row.logical_memory_id === input.logicalMemoryId &&
            row.team_id === input.teamId &&
            row.team_workspace_id === input.workspaceId &&
            row.companion_thread_id === input.companionThreadId &&
            row.shared_session_id === input.sharedSessionId
          );
        }
        try {
          await client.query(
            `insert into collaboration_shared_memory_companion_bindings
               (enrollment_id, share_grant_id, logical_memory_id, team_id,
                team_workspace_id, companion_thread_id, shared_session_id)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              enrollment.id,
              input.shareGrantId,
              input.logicalMemoryId,
              input.teamId,
              input.workspaceId,
              input.companionThreadId,
              input.sharedSessionId
            ]
          );
          return true;
        } catch (error) {
          if (isObject(error) && error.code === "23505") return false;
          throw error;
        }
      });
    };

  const store: CollaborationSharedMemoryAuthorityRepository = {
    bindEnrollment,
    revokeEnrollment,
    revokeBackendEnrollments,
    bindCompanionSession,

    async isEnrollmentBound(identity) {
      return (await activeEnrollment(pool, identity)) !== null;
    },

    async resolvePreviewTarget(input) {
      if (
        !validIdentity(input) ||
        !isUuid(input.logicalMemoryId) ||
        !isUuid(input.teamId) ||
        !isUuid(input.workspaceId) ||
        !isRepresentation(input.representation)
      ) {
        return null;
      }
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, input, "share");
        if (!enrollment) return null;
        const target = await canonicalPreviewTarget(
          client,
          enrollment.id,
          input.logicalMemoryId
        );
        return target
          ? {
              remoteReplicaId: target.remote_replica_id,
              syncRelationshipId: target.relationship_id,
              localSessionId: target.local_session_id
            }
          : null;
      });
    },

    async resolvePreviewTargets(identity, inputs) {
      if (
        !validIdentity(identity) ||
        inputs.length > 100 ||
        inputs.some(
          (input) =>
            !isUuid(input.logicalMemoryId) ||
            !isUuid(input.teamId) ||
            !isUuid(input.workspaceId) ||
            !isRepresentation(input.representation)
        )
      ) {
        return inputs.map(() => null);
      }
      if (inputs.length === 0) return [];
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, identity, "share");
        if (!enrollment) return inputs.map(() => null);
        const result = await client.query<
          CanonicalPreviewTargetRow & { logical_memory_id: string }
        >(
          `with requested(logical_memory_id) as (
             select distinct unnest($2::uuid[])
           )
           select requested.logical_memory_id,
                  relationship.id as relationship_id,
                  relationship.remote_replica_id,
                  local_memory.local_session_id
             from requested
             join collaboration_shared_memory_enrollments enrollment
               on enrollment.id=$1 and enrollment.revoked_at is null
             join deployment_identities deployment
               on deployment.upstream_backend_id=enrollment.backend_id
              and deployment.locality='remote' and deployment.disabled_at is null
             join sync_external_user_identities remote_user
               on remote_user.deployment_identity_id=deployment.id
              and remote_user.external_subject_id=enrollment.upstream_user_id::text
              and remote_user.status='active' and remote_user.revoked_at is null
             join sync_principal_links principal_link
               on principal_link.local_user_id=enrollment.local_owner_user_id
              and principal_link.external_user_identity_id=remote_user.id
              and principal_link.revoked_at is null
             join cross_identity_sync_relationships relationship
               on relationship.local_user_id=enrollment.local_owner_user_id
              and relationship.remote_deployment_identity_id=deployment.id
              and relationship.remote_user_identity_id=remote_user.id
              and relationship.logical_memory_id=requested.logical_memory_id
              and relationship.side='source'
              and relationship.remote_replica_id is not null
              and relationship.revoked_at is null
              and relationship.state in
                ('uploading','uploaded','verified','processing','partially_available',
                 'ready','stale','paused')
             join memory_replicas replica
               on replica.id=relationship.local_replica_id
              and replica.owner_user_id=enrollment.local_owner_user_id
             join local_captured_session_logical_memories local_memory
               on local_memory.logical_memory_id=relationship.logical_memory_id
              and local_memory.owner_user_id=enrollment.local_owner_user_id`,
          [enrollment.id, inputs.map((input) => input.logicalMemoryId)]
        );
        const byLogicalMemoryId = new Map(
          result.rows.map((row) => [row.logical_memory_id, row])
        );
        return inputs.map((input) => {
          const target = byLogicalMemoryId.get(input.logicalMemoryId);
          return target
            ? {
                remoteReplicaId: target.remote_replica_id,
                syncRelationshipId: target.relationship_id,
                localSessionId: target.local_session_id
              }
            : null;
        });
      });
    },

    async persistAuthoritativeCandidatePreview(input) {
      const { identity, preview } = input;
      if (
        !validIdentity(identity) ||
        !validPersistedPreview({ ...identity, ...preview })
      ) {
        return null;
      }
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, identity, "update");
        if (!enrollment) return null;
        await lockBinding(
          client,
          `csm:candidate-preview:${preview.logicalMemoryId}:${preview.teamId}:${preview.teamWorkspaceId}:${preview.activationRepresentation}`
        );
        const existingById = await readPreviewRow(client, enrollment.id, {
          includeExpired: true,
          previewId: preview.previewId
        });
        const existingByHash = await readPreviewRow(client, enrollment.id, {
          includeExpired: true,
          previewHash: preview.previewHash
        });
        const existing = existingById ?? existingByHash;
        const persisted: CollaborationPersistedSharedMemoryPreview = {
          ...identity,
          ...preview
        };
        if (existing) {
          if (
            existing.preview_id !== preview.previewId ||
            existing.preview_hash !== preview.previewHash ||
            existing.preview_revision !== preview.previewRevision
          ) {
            return null;
          }
          const decoded = await decodePreview(existing, identity);
          if (!decoded || !sameDto(decoded, persisted)) return null;
          const refreshed = await client.query(
            `update collaboration_shared_memory_previews
                set expires_at = $3
              where enrollment_id = $1 and preview_id = $2
                and expires_at <= now()`,
            [enrollment.id, preview.previewId, input.previewExpiresAt]
          );
          return refreshed.rowCount === 0 &&
            new Date(existing.expires_at).getTime() <= Date.now()
            ? null
            : decoded;
        }
        const protectedValue = await encryptedDto(provider, {
          table: "collaboration_shared_memory_previews",
          sourceId: preview.previewId,
          identity,
          dto: persisted
        });
        try {
          await client.query(
            `insert into collaboration_shared_memory_previews
               (enrollment_id, sync_relationship_id, preview_id, preview_hash,
                preview_revision, logical_memory_id, team_id, team_workspace_id,
                representation, maximum_fidelity, include_curated_memory,
                source_revision, source_hash,
                source_content_hash, item_count, protected_dto_hash, protected_dto,
                expires_at)
             values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
              enrollment.id,
              preview.previewId,
              preview.previewHash,
              preview.previewRevision,
              preview.logicalMemoryId,
              preview.teamId,
              preview.teamWorkspaceId,
              preview.activationRepresentation,
              preview.maximumFidelity,
              preview.includeCuratedMemory,
              preview.sourceRevision,
              preview.sourceHash,
              preview.sourceContentHash,
              preview.items.length,
              protectedValue.hash,
              protectedValue.envelope,
              input.previewExpiresAt
            ]
          );
        } catch (error) {
          if (isObject(error) && error.code === "23505") return null;
          throw error;
        }
        return persisted;
      });
    },

    async persistAuthoritativePreview(input) {
      const { identity, preview } = input;
      if (
        !validIdentity(identity) ||
        !validPersistedPreview({ ...identity, ...preview })
      ) {
        return null;
      }
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, identity, "update");
        if (!enrollment) return null;
        const standalonePersonalNote =
          preview.source?.kind === "personal_note" ? preview.source : null;
        const target = standalonePersonalNote
          ? null
          : await canonicalPreviewTarget(
              client,
              enrollment.id,
              preview.logicalMemoryId
            );
        let previewAuthorityId: string;
        if (target) previewAuthorityId = target.relationship_id;
        else if (standalonePersonalNote) {
          previewAuthorityId = `personal-note:${standalonePersonalNote.noteId}`;
        } else return null;
        await lockBinding(
          client,
          `csm:preview:${previewAuthorityId}:${preview.teamId}:${preview.teamWorkspaceId}:${preview.activationRepresentation}`
        );
        const existingById = await readPreviewRow(client, enrollment.id, {
          includeExpired: true,
          previewId: preview.previewId
        });
        const existingByHash = await readPreviewRow(client, enrollment.id, {
          includeExpired: true,
          previewHash: preview.previewHash
        });
        const existing = existingById ?? existingByHash;
        if (existing) {
          if (
            existing.preview_id !== preview.previewId ||
            existing.preview_hash !== preview.previewHash ||
            existing.preview_revision !== preview.previewRevision
          ) {
            return null;
          }
          const decoded = await decodePreview(existing, identity);
          if (!decoded || !sameDto(decoded, { ...identity, ...preview })) {
            return null;
          }
          await client.query(
            `update collaboration_shared_memory_previews
                set expires_at = now() + interval '10 minutes'
              where enrollment_id = $1 and preview_id = $2
                and expires_at <= now()`,
            [enrollment.id, preview.previewId]
          );
          return decoded;
        }
        const persisted: CollaborationPersistedSharedMemoryPreview = {
          ...identity,
          ...preview
        };
        const protectedValue = await encryptedDto(provider, {
          table: "collaboration_shared_memory_previews",
          sourceId: preview.previewId,
          identity,
          dto: persisted
        });
        try {
          await client.query(
            `insert into collaboration_shared_memory_previews
               (enrollment_id, sync_relationship_id, preview_id, preview_hash,
                preview_revision, logical_memory_id, team_id, team_workspace_id,
                representation, maximum_fidelity, include_curated_memory,
                source_revision, source_hash,
                source_content_hash, item_count, protected_dto_hash, protected_dto)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
              enrollment.id,
              target?.relationship_id ?? null,
              preview.previewId,
              preview.previewHash,
              persisted.previewRevision,
              preview.logicalMemoryId,
              preview.teamId,
              preview.teamWorkspaceId,
              preview.activationRepresentation,
              preview.maximumFidelity,
              preview.includeCuratedMemory,
              preview.sourceRevision,
              preview.sourceHash,
              preview.sourceContentHash,
              preview.items.length,
              protectedValue.hash,
              protectedValue.envelope
            ]
          );
        } catch (error) {
          if (isObject(error) && error.code === "23505") return null;
          throw error;
        }
        return persisted;
      });
    },

    async readAuthoritativePreview(input) {
      if (!validIdentity(input) || !isHash(input.previewHash)) return null;
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, input, "share");
        if (!enrollment) return null;
        const row = await readPreviewRow(client, enrollment.id, {
          previewHash: input.previewHash
        });
        return row ? decodePreview(row, input) : null;
      });
    },

    async persistAuthoritativeConsent(input) {
      const { identity, previewId, consent } = input;
      const mapped = mapConsent(consent);
      const persisted: CollaborationPersistedSharedMemoryConsent = {
        ...identity,
        previewId,
        consent: mapped
      };
      if (
        !validIdentity(identity) ||
        !isUuid(previewId) ||
        !validPersistedConsent(persisted)
      ) {
        return null;
      }
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, identity, "update");
        if (!enrollment) return null;
        const previewRow = await readPreviewRow(client, enrollment.id, {
          previewId
        });
        if (!previewRow) return null;
        const preview = await decodePreview(previewRow, identity);
        if (
          !preview ||
          preview.previewId !== previewId ||
          preview.previewHash !== consent.previewHash ||
          preview.previewRevision !== consent.previewRevision ||
          preview.logicalMemoryId !== consent.logicalMemoryId ||
          preview.teamId !== consent.teamId ||
          preview.teamWorkspaceId !== consent.teamWorkspaceId ||
          preview.sourceRevision !== consent.sourceRevision ||
          preview.maximumFidelity !== consent.maximumFidelity ||
          preview.includeCuratedMemory !== consent.includeCuratedMemory
        ) {
          return null;
        }
        await lockBinding(client, `csm:consent:${enrollment.id}:${consent.id}`);
        const existingResult = await client.query<ConsentRow>(
          `${selectConsentSql}
            where enrollment_id = $1 and consent_id = $2 and consent_version = $3
            limit 1`,
          [enrollment.id, consent.id, consent.consentVersion]
        );
        const existing = existingResult.rows[0];
        if (existing) {
          const decoded = await decodeConsent(existing, identity);
          return decoded && sameDto(decoded, persisted) ? decoded : null;
        }
        const latest = await client.query<{ consent_version: number }>(
          `select consent_version
             from collaboration_shared_memory_consents
            where enrollment_id = $1 and consent_id = $2
            order by consent_version desc limit 1`,
          [enrollment.id, consent.id]
        );
        const expectedVersion = (latest.rows[0]?.consent_version ?? 0) + 1;
        if (consent.consentVersion !== expectedVersion) return null;
        const protectedValue = await encryptedDto(provider, {
          table: "collaboration_shared_memory_consents",
          sourceId: consent.id,
          identity,
          dto: persisted
        });
        await client.query(
          `insert into collaboration_shared_memory_consents
             (enrollment_id, consent_id, consent_version, preview_id,
              preview_hash, preview_revision, logical_memory_id, team_id,
              team_workspace_id, maximum_fidelity, include_curated_memory,
              source_revision, protected_dto_hash, protected_dto)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            enrollment.id,
            consent.id,
            consent.consentVersion,
            previewId,
            consent.previewHash,
            consent.previewRevision,
            consent.logicalMemoryId,
            consent.teamId,
            consent.teamWorkspaceId,
            consent.maximumFidelity,
            consent.includeCuratedMemory,
            consent.sourceRevision,
            protectedValue.hash,
            protectedValue.envelope
          ]
        );
        return persisted;
      });
    },

    async readAuthoritativeConsent(input) {
      if (!validIdentity(input) || !isUuid(input.consentId)) return null;
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, input, "share");
        if (!enrollment) return null;
        const result = await client.query<ConsentRow>(
          `${selectConsentSql}
            where enrollment_id = $1 and consent_id = $2
            order by consent_version desc limit 1`,
          [enrollment.id, input.consentId]
        );
        return result.rows[0] ? decodeConsent(result.rows[0], input) : null;
      });
    },

    async persistAuthoritativeGrant(input) {
      const { identity, grant, prior, companion: requiredCompanion } = input;
      const mode = input.mode ?? "mutation";
      if (
        !validIdentity(identity) ||
        !isUuid(grant.id) ||
        !isUuid(grant.logicalGrantId) ||
        !isUuid(grant.logicalMemoryId) ||
        !isUuid(grant.teamId) ||
        !isUuid(grant.teamWorkspaceId) ||
        !isUuid(grant.consentId) ||
        !isPositiveInteger(grant.grantVersion) ||
        !isRevision(grant.sourceRevision) ||
        !isFidelity(grant.maximumFidelity) ||
        typeof grant.includeCuratedMemory !== "boolean" ||
        !isPositiveInteger(grant.fidelityPolicyRevision) ||
        grant.companionScope.scope !== "team" ||
        grant.companionScope.kind !== "shared_session_discussion" ||
        grant.companionScope.shareGrantId !== grant.id ||
        grant.companionScope.logicalMemoryId !== grant.logicalMemoryId ||
        grant.companionScope.teamId !== grant.teamId ||
        grant.companionScope.teamWorkspaceId !== grant.teamWorkspaceId ||
        !isUuid(requiredCompanion.companionThreadId) ||
        !isUuid(requiredCompanion.sharedSessionId) ||
        (mode === "revocation" &&
          (grant.lifecycle !== "revoked" || prior === null))
      ) {
        return null;
      }

      const resolvedBinding = await bindCompanionSession({
        identity,
        shareGrantId: grant.id,
        logicalMemoryId: grant.logicalMemoryId,
        teamId: grant.teamId,
        workspaceId: grant.teamWorkspaceId,
        companionThreadId: requiredCompanion.companionThreadId,
        sharedSessionId: requiredCompanion.sharedSessionId
      });
      if (!resolvedBinding) return null;

      let enrollment = await activeEnrollment(pool, identity);
      if (!enrollment) return null;
      let companionResult = await pool.query<CompanionRow>(
        `select id, share_grant_id, logical_memory_id, team_id,
                team_workspace_id, companion_thread_id, shared_session_id
           from collaboration_shared_memory_companion_bindings
          where enrollment_id = $1 and share_grant_id = $2 and revoked_at is null
          limit 1`,
        [enrollment.id, grant.id]
      );
      if (!companionResult.rows[0]) {
        enrollment = await activeEnrollment(pool, identity);
        if (!enrollment) return null;
        companionResult = await pool.query<CompanionRow>(
          `select id, share_grant_id, logical_memory_id, team_id,
                  team_workspace_id, companion_thread_id, shared_session_id
             from collaboration_shared_memory_companion_bindings
            where enrollment_id = $1 and share_grant_id = $2 and revoked_at is null
            limit 1`,
          [enrollment.id, grant.id]
        );
      }
      const companion = companionResult.rows[0];
      if (
        !companion ||
        companion.logical_memory_id !== grant.logicalMemoryId ||
        companion.team_id !== grant.teamId ||
        companion.team_workspace_id !== grant.teamWorkspaceId
      ) {
        return null;
      }
      const persisted: CollaborationPersistedSharedMemoryGrant = {
        ...identity,
        grant: mapGrant(grant, companion.companion_thread_id)
      };
      if (!validPersistedGrant(persisted)) return null;

      return withTransaction(pool, async (client) => {
        const active = await activeEnrollment(client, identity, "update");
        if (!active || active.id !== enrollment!.id) return null;
        await lockBinding(client, `csm:grant:${active.id}:${grant.id}`);
        if (mode === "mutation") {
          const consent = await client.query<ConsentRow>(
            `${selectConsentSql}
              where enrollment_id = $1 and consent_id = $2
                and logical_memory_id = $3 and team_id = $4 and team_workspace_id = $5
              order by consent_version desc limit 1`,
            [
              active.id,
              grant.consentId,
              grant.logicalMemoryId,
              grant.teamId,
              grant.teamWorkspaceId
            ]
          );
          if (
            !consent.rows[0] ||
            !(await decodeConsent(consent.rows[0], identity))
          ) {
            return null;
          }
        }
        const currentCompanion = await client.query<CompanionRow>(
          `select id, share_grant_id, logical_memory_id, team_id,
                  team_workspace_id, companion_thread_id, shared_session_id
             from collaboration_shared_memory_companion_bindings
            where id = $1 and enrollment_id = $2 and revoked_at is null
            limit 1`,
          [companion.id, active.id]
        );
        if (!currentCompanion.rows[0]) return null;
        const existingResult = await client.query<GrantRow>(
          `${selectGrantSql}
            where enrollment_id = $1 and share_grant_id = $2 and grant_version = $3
            limit 1`,
          [active.id, grant.id, grant.grantVersion]
        );
        const existing = existingResult.rows[0];
        if (existing) {
          const decoded = await decodeGrant(existing, identity);
          if (!decoded) return null;
          if (sameDto(decoded, persisted)) {
            await reconcileContinuousPersonalNoteGrant(client, {
              enrollmentId: active.id,
              localOwnerUserId: identity.localOwnerUserId,
              grant: decoded.grant
            });
            return decoded;
          }
          if (
            mode !== "authoritative_snapshot" ||
            prior === null ||
            !sameDto(decoded, prior) ||
            !canRefreshAuthoritativeGrant(decoded, persisted)
          ) {
            return null;
          }
          const protectedValue = await encryptedDto(provider, {
            table: "collaboration_shared_memory_grants",
            sourceId: grant.id,
            identity,
            dto: persisted
          });
          const refreshed = await client.query(
            `update collaboration_shared_memory_grants
                set source_revision = $1,
                    mode = $2,
                    protected_dto_hash = $3,
                    protected_dto = $4
              where enrollment_id = $5 and share_grant_id = $6
                and grant_version = $7 and source_revision = $8`,
            [
              grant.sourceRevision,
              grant.mode,
              protectedValue.hash,
              protectedValue.envelope,
              active.id,
              grant.id,
              grant.grantVersion,
              decoded.grant.sourceRevision
            ]
          );
          if (refreshed.rowCount !== 1) return null;
          await reconcileContinuousPersonalNoteGrant(client, {
            enrollmentId: active.id,
            localOwnerUserId: identity.localOwnerUserId,
            grant: persisted.grant
          });
          return persisted;
        }
        const latestResult = await client.query<GrantRow>(
          `${selectGrantSql}
            where enrollment_id = $1 and share_grant_id = $2
            order by grant_version desc limit 1`,
          [active.id, grant.id]
        );
        const latest = latestResult.rows[0];
        if (!latest) {
          if (
            prior !== null ||
            (mode !== "authoritative_snapshot" && grant.grantVersion !== 1)
          ) {
            return null;
          }
        } else {
          const decodedLatest = await decodeGrant(latest, identity);
          if (
            !decodedLatest ||
            grant.grantVersion <= latest.grant_version ||
            (mode !== "authoritative_snapshot" &&
              grant.grantVersion !== latest.grant_version + 1) ||
            prior === null ||
            !sameDto(decodedLatest, prior)
          ) {
            return null;
          }
        }
        const protectedValue = await encryptedDto(provider, {
          table: "collaboration_shared_memory_grants",
          sourceId: grant.id,
          identity,
          dto: persisted
        });
        await client.query(
          `insert into collaboration_shared_memory_grants
             (enrollment_id, companion_binding_id, share_grant_id,
              logical_grant_id, logical_memory_id, consent_id, team_id,
              team_workspace_id, maximum_fidelity, include_curated_memory,
              mode, source_revision,
              grant_version, lifecycle, protected_dto_hash, protected_dto)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            active.id,
            companion.id,
            grant.id,
            grant.logicalGrantId,
            grant.logicalMemoryId,
            grant.consentId,
            grant.teamId,
            grant.teamWorkspaceId,
            grant.maximumFidelity,
            grant.includeCuratedMemory,
            grant.mode,
            grant.sourceRevision,
            grant.grantVersion,
            grant.lifecycle,
            protectedValue.hash,
            protectedValue.envelope
          ]
        );
        await reconcileContinuousPersonalNoteGrant(client, {
          enrollmentId: active.id,
          localOwnerUserId: identity.localOwnerUserId,
          grant: persisted.grant
        });
        return persisted;
      });
    },

    async readAuthoritativeGrant(input) {
      if (!validIdentity(input) || !isUuid(input.shareGrantId)) return null;
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, input, "share");
        if (!enrollment) return null;
        const result = await client.query<GrantRow>(
          `${selectGrantSql}
            where enrollment_id = $1 and share_grant_id = $2
            order by grant_version desc limit 1`,
          [enrollment.id, input.shareGrantId]
        );
        return result.rows[0] ? decodeGrant(result.rows[0], input) : null;
      });
    },

    async readAuthoritativeGrants(identity, shareGrantIds) {
      if (
        !validIdentity(identity) ||
        shareGrantIds.length > 100 ||
        shareGrantIds.some((id) => !isUuid(id))
      ) {
        return shareGrantIds.map(() => null);
      }
      if (shareGrantIds.length === 0) return [];
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, identity, "share");
        if (!enrollment) return shareGrantIds.map(() => null);
        const result = await client.query<GrantRow>(
          `select distinct on (share_grant_id)
                  ${grantProjectionSql}
             from collaboration_shared_memory_grants
            where enrollment_id=$1 and share_grant_id=any($2::uuid[])
            order by share_grant_id,grant_version desc`,
          [enrollment.id, shareGrantIds]
        );
        const decoded = await Promise.all(
          result.rows.map((row) => decodeGrant(row, identity))
        );
        const byId = new Map(
          decoded.flatMap((grant) =>
            grant ? [[grant.grant.id, grant] as const] : []
          )
        );
        return shareGrantIds.map((id) => byId.get(id) ?? null);
      });
    },

    async listAuthoritativeGrants(input) {
      if (!validIdentity(input) || !isUuid(input.logicalMemoryId)) return null;
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, input, "share");
        if (!enrollment) return null;
        const result = await client.query<GrantRow>(
          `select distinct on (share_grant_id)
                  ${grantProjectionSql}
             from collaboration_shared_memory_grants
            where enrollment_id = $1 and logical_memory_id = $2
            order by share_grant_id, grant_version desc
            limit 251`,
          [enrollment.id, input.logicalMemoryId]
        );
        if (result.rows.length > 250) return null;
        const grants = await Promise.all(
          result.rows.map((row) => decodeGrant(row, input))
        );
        return grants.every(
          (grant): grant is CollaborationPersistedSharedMemoryGrant =>
            grant !== null
        )
          ? grants.sort(
              (left, right) =>
                Date.parse(right.grant.updatedAt) -
                  Date.parse(left.grant.updatedAt) ||
                left.grant.id.localeCompare(right.grant.id)
            )
          : null;
      });
    },

    async persistPendingShareSourceWork(input) {
      const parsedSource = sharedMemorySourceRefSchema.safeParse(input.source);
      if (
        !validIdentity(input.identity) ||
        !isUuid(input.pendingShareId) ||
        !isUuid(input.mutationId) ||
        !["snapshot", "continuous"].includes(input.mode) ||
        !Number.isSafeInteger(input.sourceRevision) ||
        input.sourceRevision < 0 ||
        !parsedSource.success
      ) {
        return false;
      }
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(
          client,
          input.identity,
          "update"
        );
        if (!enrollment) return false;
        const source = parsedSource.data;
        if (
          source.kind === "personal_note" &&
          source.noteRevision !== input.sourceRevision
        ) {
          return false;
        }
        let sourceRevisionId: string;
        if (source.kind === "captured_session") {
          const genericRevision = input.sourceRevision + 1;
          if (!Number.isSafeInteger(genericRevision)) return false;
          const session = await client.query<{ logical_memory_id: string }>(
            `select local_memory.logical_memory_id
               from local_captured_session_logical_memories local_memory
               join captured_session_logical_memories source_memory
                 on source_memory.logical_memory_id=local_memory.logical_memory_id
                and source_memory.source_session_id=$1
               join logical_memories logical
                 on logical.id=local_memory.logical_memory_id
                and logical.owner_principal_id=$2
                and logical.source_kind='captured_session'
              where local_memory.logical_memory_id=$3
                and local_memory.local_session_id=$1
                and local_memory.owner_user_id=$2
              limit 1`,
            [
              source.sessionId,
              input.identity.localOwnerUserId,
              source.logicalMemoryId
            ]
          );
          if (!session.rowCount) return false;
          const revisionIdentity = logicalMemorySourceRevisionIdentity({
            source,
            ownerPrincipalId: input.identity.localOwnerUserId,
            sourceRevision: input.sourceRevision
          });
          const bindingHash = revisionIdentity.bindingHash;
          sourceRevisionId = revisionIdentity.id;
          const revision = await client.query(
            `insert into logical_memory_source_revisions
               (id,logical_memory_id,owner_principal_id,source_kind,revision,binding_hash)
             values ($1,$2,$3,'captured_session',$4,$5)
             on conflict (logical_memory_id,revision) do update
               set binding_hash=logical_memory_source_revisions.binding_hash
             where logical_memory_source_revisions.id=excluded.id
               and logical_memory_source_revisions.owner_principal_id=excluded.owner_principal_id
               and logical_memory_source_revisions.source_kind=excluded.source_kind
               and logical_memory_source_revisions.binding_hash=excluded.binding_hash
             returning id`,
            [
              sourceRevisionId,
              source.logicalMemoryId,
              input.identity.localOwnerUserId,
              genericRevision,
              bindingHash
            ]
          );
          if (!revision.rowCount) return false;
          const binding = await client.query(
            `insert into captured_session_source_revisions
               (source_revision_id,logical_memory_id,owner_principal_id,
                source_kind,revision,source_session_id,source_cursor)
             values ($1,$2,$3,'captured_session',$4,$5,$6)
             on conflict (source_revision_id) do update
               set source_cursor=captured_session_source_revisions.source_cursor
             where captured_session_source_revisions.logical_memory_id=excluded.logical_memory_id
               and captured_session_source_revisions.owner_principal_id=excluded.owner_principal_id
               and captured_session_source_revisions.source_session_id=excluded.source_session_id
               and captured_session_source_revisions.source_cursor=excluded.source_cursor
             returning source_revision_id`,
            [
              sourceRevisionId,
              source.logicalMemoryId,
              input.identity.localOwnerUserId,
              genericRevision,
              source.sessionId,
              input.sourceRevision
            ]
          );
          if (!binding.rowCount) return false;
          await client.query(
            `update logical_memories
                set latest_source_revision=greatest(latest_source_revision,$2),
                    updated_at=case when latest_source_revision<$2 then now() else updated_at end
              where id=$1 and owner_principal_id=$3`,
            [
              source.logicalMemoryId,
              input.sourceRevision,
              input.identity.localOwnerUserId
            ]
          );
        } else {
          const note = await client.query<{ source_revision_id: string }>(
            `select source_revision.source_revision_id
               from local_personal_note_source_revisions local_revision
               join personal_note_source_revisions source_revision
                 on source_revision.source_revision_id=local_revision.source_revision_id
              where local_revision.local_note_id=$1
                and local_revision.local_memory_event_id=$2
                and local_revision.revision=$3
                and source_revision.logical_memory_id=$4
                and source_revision.owner_principal_id=$5
                and source_revision.source_note_id=$1
                and source_revision.source_memory_event_id=$2
              limit 1`,
            [
              source.noteId,
              source.memoryEventId,
              source.noteRevision,
              source.logicalMemoryId,
              input.identity.localOwnerUserId
            ]
          );
          if (!note.rowCount) return false;
          sourceRevisionId = note.rows[0]!.source_revision_id;
        }
        await lockBinding(
          client,
          `csm:pending-source-work:${enrollment.id}:${input.mutationId}`
        );
        const existing = await client.query<{
          mutation_id: string;
          pending_share_id: string;
          mode: "snapshot" | "continuous";
          logical_memory_id: string;
          source_revision_id: string;
        }>(
          `select mutation_id,pending_share_id,mode,logical_memory_id,source_revision_id
             from collaboration_pending_share_source_work
            where enrollment_id=$1 and mutation_id=$2
            limit 1`,
          [enrollment.id, input.mutationId]
        );
        if (existing.rows[0]) {
          return (
            existing.rows[0].mutation_id === input.mutationId &&
            existing.rows[0].pending_share_id === input.pendingShareId &&
            existing.rows[0].mode === input.mode &&
            existing.rows[0].logical_memory_id === source.logicalMemoryId &&
            existing.rows[0].source_revision_id === sourceRevisionId
          );
        }
        if (source.kind === "personal_note" && input.mode === "continuous") {
          await client.query(
            `update collaboration_pending_share_source_work
                set state='completed',locked_at=null,completed_at=now(),
                    redacted_failure_code=null,updated_at=now()
              where enrollment_id=$1 and pending_share_id=$2
                and mode='continuous'
                and source_revision_id in (
                  select revision.source_revision_id
                    from personal_note_source_revisions revision
                   where revision.source_note_id=$3 and revision.revision<$4
                )
                and state<>'completed'`,
            [
              enrollment.id,
              input.pendingShareId,
              source.noteId,
              source.noteRevision
            ]
          );
        }
        try {
          await client.query(
            `insert into collaboration_pending_share_source_work
               (enrollment_id,pending_share_id,mutation_id,mode,
                logical_memory_id,source_revision_id)
             values ($1,$2,$3,$4,$5,$6)`,
            [
              enrollment.id,
              input.pendingShareId,
              input.mutationId,
              input.mode,
              source.logicalMemoryId,
              sourceRevisionId
            ]
          );
        } catch (error) {
          if (isObject(error) && error.code === "23505") return false;
          throw error;
        }
        return true;
      });
    },

    async claimPendingShareSourceWork(input = {}) {
      const limit = Math.max(1, Math.min(50, input.limit ?? 10));
      return withTransaction(pool, async (client) => {
        const result = await client.query<{
          work_id: string;
          backend_id: string;
          local_owner_user_id: string;
          upstream_user_id: string;
          pending_share_id: string;
          mutation_id: string;
          mode: "snapshot" | "continuous";
          logical_memory_id: string;
          source_kind: "captured_session" | "personal_note";
          local_session_id: string | null;
          local_note_id: string | null;
          local_note_revision: number | null;
          local_memory_event_id: string | null;
        }>(
          `with candidates as (
             select work.id
               from collaboration_pending_share_source_work work
               join collaboration_shared_memory_enrollments enrollment
                 on enrollment.id=work.enrollment_id
                and enrollment.revoked_at is null
              where ((work.state in ('pending','failed') and work.available_at<=now())
                 or (work.state='processing' and
                     work.locked_at<now()-interval '5 minutes'))
              order by work.available_at,work.id
              for update of work skip locked
              limit $1
           ), claimed as (
             update collaboration_pending_share_source_work work
                set state='processing',locked_at=now(),updated_at=now(),
                    attempt_count=attempt_count+1
               from candidates
              where work.id=candidates.id
            returning work.*
           )
           select claimed.id as work_id,enrollment.backend_id,
                  enrollment.local_owner_user_id,enrollment.upstream_user_id,
                  claimed.pending_share_id,claimed.mutation_id,claimed.mode,
                  claimed.logical_memory_id,binding.source_kind,
                  local_session.local_session_id,
                  binding.source_note_id as local_note_id,
                  binding.source_revision as local_note_revision,
                  binding.source_memory_event_id as local_memory_event_id
             from claimed
             join collaboration_shared_memory_enrollments enrollment
               on enrollment.id=claimed.enrollment_id
             join logical_memory_source_revision_bindings binding
               on binding.source_revision_id=claimed.source_revision_id
             left join local_captured_session_logical_memories local_session
               on local_session.logical_memory_id=claimed.logical_memory_id
              and local_session.owner_user_id=enrollment.local_owner_user_id`,
          [limit]
        );
        return result.rows.map((row) => ({
          workId: row.work_id,
          backendId: row.backend_id,
          localOwnerUserId: row.local_owner_user_id,
          upstreamUserId: row.upstream_user_id,
          pendingShareId: row.pending_share_id,
          mutationId: row.mutation_id,
          mode: row.mode,
          source:
            row.source_kind === "personal_note"
              ? {
                  kind: "personal_note" as const,
                  noteId: row.local_note_id!,
                  noteRevision: Number(row.local_note_revision!),
                  memoryEventId: row.local_memory_event_id!,
                  logicalMemoryId: row.logical_memory_id
                }
              : {
                  kind: "captured_session" as const,
                  sessionId: row.local_session_id!,
                  logicalMemoryId: row.logical_memory_id
                }
        }));
      });
    },

    async finishPendingShareSourceWork(input) {
      if (!isUuid(input.workId)) return false;
      const failureCode = input.redactedFailureCode ?? null;
      if (
        failureCode !== null &&
        !/^[A-Za-z0-9_.:-]{1,120}$/.test(failureCode)
      ) {
        return false;
      }
      const result = await pool.query(
        input.outcome === "completed"
          ? `update collaboration_pending_share_source_work
                set state='completed',locked_at=null,completed_at=now(),
                    redacted_failure_code=null,updated_at=now()
              where id=$1 and state='processing'`
          : `with target as (
               select work.id,
                      exists (
                        select 1
                          from collaboration_pending_share_source_work newer
                          join personal_note_source_revisions newer_revision
                            on newer_revision.source_revision_id=newer.source_revision_id
                          join personal_note_source_revisions work_revision
                            on work_revision.source_revision_id=work.source_revision_id
                         where newer.enrollment_id=work.enrollment_id
                           and newer.pending_share_id=work.pending_share_id
                           and newer.mode='continuous'
                           and newer_revision.source_note_id=work_revision.source_note_id
                           and newer_revision.revision>work_revision.revision
                      ) as superseded
                 from collaboration_pending_share_source_work work
                where work.id=$1 and work.state='processing'
             )
             update collaboration_pending_share_source_work work
                set state=case when target.superseded then 'completed' else 'failed' end,
                    locked_at=null,
                    completed_at=case when target.superseded then now() else completed_at end,
                    available_at=case when target.superseded
                      then available_at else now()+interval '30 seconds' end,
                    redacted_failure_code=case when target.superseded then null else $2 end,
                    updated_at=now()
               from target
              where work.id=target.id`,
        input.outcome === "completed"
          ? [input.workId]
          : [input.workId, failureCode ?? "source_preparation_failed"]
      );
      return result.rowCount === 1;
    },

    async claimContinuousPersonalNoteAdvancementWork(input = {}) {
      const limit = Math.max(1, Math.min(50, input.limit ?? 10));
      return withTransaction(pool, async (client) => {
        const result = await client.query<{
          work_id: string;
          backend_id: string;
          local_owner_user_id: string;
          local_note_id: string;
          local_note_revision: number;
        }>(
          `with candidates as (
             select work.id
               from collaboration_continuous_note_advancement_work work
               join collaboration_shared_memory_enrollments enrollment
                 on enrollment.id=work.enrollment_id
                and enrollment.local_owner_user_id=work.local_owner_user_id
                and enrollment.revoked_at is null
              where ((work.state in ('pending','failed') and work.available_at<=now())
                 or (work.state='processing' and
                     work.locked_at<now()-interval '5 minutes'))
                and not exists (
                  select 1
                    from collaboration_continuous_note_advancement_work newer
                   where newer.enrollment_id=work.enrollment_id
                     and newer.source_revision_id in (
                       select newer_revision.source_revision_id
                         from personal_note_source_revisions newer_revision
                         join personal_note_source_revisions work_revision
                           on work_revision.source_revision_id=work.source_revision_id
                          and newer_revision.source_note_id=work_revision.source_note_id
                          and newer_revision.revision>work_revision.revision
                     )
                     and newer.state in ('pending','processing','failed')
                )
              order by work.available_at,work.id
              for update of work skip locked
              limit $1
           ), claimed as (
             update collaboration_continuous_note_advancement_work work
                set state='processing',locked_at=now(),updated_at=now(),
                    attempt_count=attempt_count+1
               from candidates
              where work.id=candidates.id
            returning work.*
           )
           select claimed.id as work_id,enrollment.backend_id,
                  claimed.local_owner_user_id,
                  local_revision.local_note_id,
                  local_revision.revision as local_note_revision
             from claimed
             join collaboration_shared_memory_enrollments enrollment
               on enrollment.id=claimed.enrollment_id
              and enrollment.local_owner_user_id=claimed.local_owner_user_id
              and enrollment.revoked_at is null
             join local_personal_note_source_revisions local_revision
               on local_revision.source_revision_id=claimed.source_revision_id`,
          [limit]
        );
        return result.rows.map((row) => ({
          workId: row.work_id,
          backendId: row.backend_id,
          localOwnerUserId: row.local_owner_user_id,
          noteId: row.local_note_id,
          noteRevision: Number(row.local_note_revision)
        }));
      });
    },

    async finishContinuousPersonalNoteAdvancementWork(input) {
      if (!isUuid(input.workId)) return false;
      const failureCode = input.redactedFailureCode ?? null;
      if (
        failureCode !== null &&
        !/^[A-Za-z0-9_.:-]{1,120}$/.test(failureCode)
      ) {
        return false;
      }
      const result = await pool.query(
        input.outcome === "completed"
          ? `update collaboration_continuous_note_advancement_work
                set state='completed',locked_at=null,completed_at=now(),
                    redacted_failure_code=null,updated_at=now()
              where id=$1 and state='processing'`
          : `update collaboration_continuous_note_advancement_work
                set state='failed',locked_at=null,
                    available_at=now()+interval '30 seconds',
                    redacted_failure_code=$2,updated_at=now()
              where id=$1 and state='processing'`,
        input.outcome === "completed"
          ? [input.workId]
          : [input.workId, failureCode ?? "note_advancement_failed"]
      );
      return result.rowCount === 1;
    },

    async requeueLatestContinuousPersonalNoteAdvancementWork(input) {
      if (!validIdentity(input.identity) || !isUuid(input.noteId)) return false;
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(
          client,
          input.identity,
          "update"
        );
        if (!enrollment) return false;
        const result = await client.query(
          `update collaboration_continuous_note_advancement_work work
              set state='pending',available_at=now(),locked_at=null,
                  completed_at=null,redacted_failure_code=null,updated_at=now()
            where work.id=(
              select latest.id
                from collaboration_continuous_note_advancement_work latest
               join local_personal_note_source_revisions local_revision
                 on local_revision.source_revision_id=latest.source_revision_id
               where latest.enrollment_id=$1 and local_revision.local_note_id=$2
               order by local_revision.revision desc
               limit 1
            ) and work.state in ('completed','failed','pending')`,
          [enrollment.id, input.noteId]
        );
        return result.rowCount === 1;
      });
    },

    async readSharedSessionBinding(input) {
      if (!validIdentity(input) || !isUuid(input.sharedSessionId)) return null;
      return withTransaction(pool, async (client) => {
        const enrollment = await activeEnrollment(client, input, "share");
        if (!enrollment) return null;
        const result = await client.query<
          CompanionRow & {
            maximum_fidelity: SharedMemoryFidelityCeiling;
            include_curated_memory: boolean;
            lifecycle: SharedMemoryGrant["lifecycle"];
          }
        >(
          `select b.id, b.share_grant_id, b.logical_memory_id, b.team_id,
                b.team_workspace_id, b.companion_thread_id, b.shared_session_id,
                g.maximum_fidelity, g.include_curated_memory, g.lifecycle
           from collaboration_shared_memory_companion_bindings b
           join lateral (
             select maximum_fidelity, include_curated_memory, lifecycle
               from collaboration_shared_memory_grants
              where enrollment_id = b.enrollment_id
                and companion_binding_id = b.id
                and share_grant_id = b.share_grant_id
              order by grant_version desc limit 1
           ) g on true
          where b.enrollment_id = $1 and b.shared_session_id = $2
            and b.revoked_at is null
            and g.lifecycle = 'active'
            limit 1`,
          [enrollment.id, input.sharedSessionId]
        );
        const row = result.rows[0];
        return row
          ? {
              ...input,
              shareGrantId: row.share_grant_id,
              logicalMemoryId: row.logical_memory_id,
              teamId: row.team_id,
              workspaceId: row.team_workspace_id,
              maximumFidelity: row.maximum_fidelity,
              includeCuratedMemory: row.include_curated_memory
            }
          : null;
      });
    }
  };

  return store;
};
