import { createHash, randomUUID } from "node:crypto";
import {
  CAPTURED_SESSION_SYNC_FORMAT,
  CAPTURED_SESSION_SYNC_FORMAT_VERSION,
  CAPTURED_SESSION_SYNC_POLICY_VERSION,
  createLocalTestKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDigest,
  sharedMemoryGrantScopedSourceId,
  type CapturedSessionSyncPackageV1,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from "vitest";
import type pg from "pg";
import { createCollaborationRepository } from "../src/collaboration-repository.js";
import { createDbPool } from "../src/connection.js";
import {
  createCrossIdentitySyncRepository,
  SyncStateConflictError
} from "../src/cross-identity-sync-repository.js";
import {
  buildCapturedSessionSyncContributor,
  buildCapturedSessionSyncEvent
} from "../src/cross-identity-sync-canonical.js";
import { runDbMigrations } from "../src/migrate.js";
import {
  createRetentionLifecycleRepository,
  type RetentionLifecycleRepository
} from "../src/retention-lifecycle-repository.js";
import {
  createSharedMemoryRepository,
  redactEligibleSharedMemorySourceItem,
  SHARED_MEMORY_AUTHORITY,
  SharedMemoryAuthorizationError,
  SharedMemoryConflictError,
  SharedMemorySourceItemRejectedError,
  type SharedMemoryAuthorityContext,
  type SharedMemoryConsentMode,
  type SharedMemoryPersistedPreviewRecord,
  type SharedMemoryRepository,
  type SharedMemoryRepresentation,
  type SharedMemorySourceItemInput
} from "../src/shared-memory-repository.js";

const databaseUrl = process.env.SHARED_MEMORY_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const allRepresentations: SharedMemoryRepresentation[] = [
  "memory_events",
  "lcm_leaves",
  "lcm_rollups"
];

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const actor = (userId: string) => ({ userId });

const occurredAtFor = (cursor: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, cursor)).toISOString();

const LCM_SUMMARY_SCHEMA_VERSION = "lcm-semantic-summary-v1";

const deterministicUuid = (...parts: string[]): string => {
  const hex = hash(parts.join(":"));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16
  )}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

interface SeededMemoryEvent {
  eventId: string;
  originEventId: string;
  sourceCursor: number;
  contributorIds: string[];
  occurredAt: string;
  content: string;
}

interface SeededNodeItem {
  nodeId: string;
  summaryText: string;
  sourceEventIds: string[];
}

interface WorkspaceFixture {
  ownerUserId: string;
  readerUserId: string;
  managerUserId: string;
  outsiderUserId: string;
  ownerSessionId: string;
  managerSessionId: string;
  teamId: string;
  teamWorkspaceId: string;
  sourceDeploymentId: string;
  sourceProtocolDeploymentId: string;
  targetDeploymentId: string;
  targetProtocolDeploymentId: string;
  remoteUserIdentityId: string;
  remoteExternalSubjectId: string;
  deviceCredentialId: string;
}

interface SourceFixture {
  logicalMemoryId: string;
  ownerPrincipalId: string;
  remoteReplicaId: string;
  sourceReplicaId: string;
  syncRelationshipId: string;
  sessionId: string;
  currentRevision: number;
  currentLabel: string;
  packageSequence: number;
  originEventId: string;
  seededEvents: SeededMemoryEvent[];
  leaf: SeededNodeItem;
  rollup: SeededNodeItem;
  lastSyncPackage: CapturedSessionSyncPackageV1 | null;
  lastUploadSessionId: string | null;
}

interface GrantFixture extends SourceFixture {
  consentId: string;
  shareGrantId: string;
  grantVersion: number;
  representation: SharedMemoryRepresentation;
  preview: SharedMemoryPersistedPreviewRecord;
}

interface SourceRevisionOptions {
  groupedAssistantSources?: boolean;
  assistantActor?: string;
  assistantKind?: string;
  assistantText?: string;
  assistantToolName?: string | null;
  assistantRawJson?: unknown;
  assistantMemoryExcludedAt?: string | null;
  assistantMemoryExclusionReason?: string | null;
  includeSummarySnapshot?: boolean;
}

describe("Shared Memory source-content policy", () => {
  it("redacts secrets and rejects unknown, prohibited, forged, and cross-source items", () => {
    const logicalMemoryId = randomUUID();
    const sourceRevision = 4;
    const tool = redactEligibleSharedMemorySourceItem({
      representation: "memory_events",
      logicalMemoryId,
      sourceRevision,
      item: {
        itemType: "tool_result",
        schemaVersion: 1,
        sourceId: randomUUID(),
        sourceLogicalMemoryId: logicalMemoryId,
        sourceRevision,
        content: {
          toolName: "deploy",
          toolCallId: "call-redaction-proof",
          payload: {
            password: "plaintext-password",
            nested: {
              authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
              output: "Bearer abcdefghijklmnopqrstuvwxyz"
            }
          }
        }
      }
    });
    expect(tool.content).toEqual({
      toolName: "deploy",
      toolCallId: "call-redaction-proof",
      payload: {
        password: "[REDACTED]",
        nested: {
          authorization: "[REDACTED]",
          output: "[REDACTED]"
        }
      }
    });

    const base: SharedMemorySourceItemInput = {
      itemType: "user_message",
      schemaVersion: 1,
      sourceId: randomUUID(),
      sourceLogicalMemoryId: logicalMemoryId,
      sourceRevision,
      content: { text: "eligible" }
    };
    const rejected: Array<{
      item: SharedMemorySourceItemInput;
      reasonCode: string;
    }> = [
      {
        item: { ...base, itemType: "future_protocol_item" },
        reasonCode: "unknown_item_type"
      },
      {
        item: { ...base, schemaVersion: 2 },
        reasonCode: "unknown_schema_version"
      },
      {
        item: { ...base, classification: { hiddenReasoning: true } },
        reasonCode: "hidden_reasoning"
      },
      {
        item: { ...base, classification: { systemInstruction: true } },
        reasonCode: "system_instruction"
      },
      {
        item: { ...base, classification: { containsCredentials: true } },
        reasonCode: "credential_item"
      },
      {
        item: {
          ...base,
          classification: { unsupportedProtocolItem: true }
        },
        reasonCode: "unsupported_protocol_item"
      },
      {
        item: { ...base, sourceLogicalMemoryId: randomUUID() },
        reasonCode: "cross_memory_provenance"
      },
      {
        item: { ...base, itemType: "lcm_leaf" },
        reasonCode: "wrong_representation"
      },
      {
        item: {
          ...base,
          classification: { shareEligible: true }
        } as unknown as SharedMemorySourceItemInput,
        reasonCode: "invalid_item_schema"
      }
    ];
    for (const testCase of rejected) {
      try {
        redactEligibleSharedMemorySourceItem({
          representation: "memory_events",
          logicalMemoryId,
          sourceRevision,
          item: testCase.item
        });
        throw new Error("expected source item rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(SharedMemorySourceItemRejectedError);
        expect(error).toMatchObject({ reasonCode: testCase.reasonCode });
      }
    }
  });
});

describeDb("Shared Memory repository", () => {
  let pool: pg.Pool;
  let provider: EnvelopeEncryptionProvider;
  let ownerProvider: EnvelopeEncryptionProvider;
  let encryptSpy: Mock<EnvelopeEncryptionProvider["encrypt"]>;
  let decryptSpy: Mock<EnvelopeEncryptionProvider["decrypt"]>;
  let ownerEncryptSpy: Mock<EnvelopeEncryptionProvider["encrypt"]>;
  let ownerDecryptSpy: Mock<EnvelopeEncryptionProvider["decrypt"]>;
  let repository: SharedMemoryRepository;
  let collaboration: ReturnType<typeof createCollaborationRepository>;
  let syncRepository: ReturnType<typeof createCrossIdentitySyncRepository>;
  let retentionRepository: RetentionLifecycleRepository;
  const decryptCount = (): number =>
    decryptSpy.mock.calls.length + ownerDecryptSpy.mock.calls.length;

  const authority = (
    fixture: WorkspaceFixture,
    source: "owner" | "manager" = "owner"
  ): SharedMemoryAuthorityContext => ({
    action: SHARED_MEMORY_AUTHORITY,
    source: "browser_session",
    referenceId:
      source === "owner" ? fixture.ownerSessionId : fixture.managerSessionId
  });

  const createUser = async (label: string): Promise<string> => {
    const result = await pool.query<{ id: string }>(
      `insert into users (email, display_name)
       values ($1, $2) returning id`,
      [`shared-${label}-${randomUUID()}@example.com`, label]
    );
    return result.rows[0]!.id;
  };

  const createWorkspaceFixture = async (options?: {
    teamAllowed?: SharedMemoryRepresentation[];
    workspaceAllowed?: SharedMemoryRepresentation[];
    retentionSeconds?: number;
    deletionGraceSeconds?: number;
    backupRetentionSeconds?: number;
  }): Promise<WorkspaceFixture> => {
    const ownerUserId = await createUser("Owner");
    const readerUserId = await createUser("Reader");
    const managerUserId = await createUser("Manager");
    const outsiderUserId = await createUser("Outsider");
    const team = await pool.query<{ id: string }>(
      "insert into teams (name) values ($1) returning id",
      [`Shared Memory Team ${randomUUID()}`]
    );
    const teamId = team.rows[0]!.id;
    const workspace = await pool.query<{ id: string }>(
      `insert into team_workspaces (team_id, name)
       values ($1, $2) returning id`,
      [teamId, `Shared Memory Workspace ${randomUUID()}`]
    );
    const teamWorkspaceId = workspace.rows[0]!.id;
    const retentionPolicyId = randomUUID();
    const retentionEffectiveAt = new Date("2020-01-01T00:00:00.000Z");
    const retentionSeconds = options?.retentionSeconds ?? 2_592_000;
    const deletionGraceSeconds = options?.deletionGraceSeconds ?? 0;
    const backupRetentionSeconds = options?.backupRetentionSeconds ?? 2_592_000;
    await pool.query(
      `insert into retention_policies (
         policy_id, version, scope, team_id, retention_seconds,
         deletion_grace_seconds, backup_retention_seconds, policy_hash,
         created_by_user_id, effective_at
       ) values ($1,1,'team',$2,$3,$4,$5,$6,$7,$8)`,
      [
        retentionPolicyId,
        teamId,
        retentionSeconds,
        deletionGraceSeconds,
        backupRetentionSeconds,
        crossIdentitySyncDigest({
          policyId: retentionPolicyId,
          version: 1,
          target: { scope: "team", teamId },
          retentionSeconds,
          deletionGraceSeconds,
          backupRetentionSeconds,
          effectiveAt: retentionEffectiveAt.toISOString()
        }),
        ownerUserId,
        retentionEffectiveAt
      ]
    );
    await pool.query(
      `insert into team_memberships (
         team_id, user_id, role, status, accepted_at
       ) values
         ($1, $2, 'owner', 'enabled', now()),
         ($1, $3, 'member', 'enabled', now()),
         ($1, $4, 'admin', 'enabled', now())`,
      [teamId, ownerUserId, readerUserId, managerUserId]
    );
    await pool.query(
      `insert into team_workspace_access_grants (
         team_workspace_id, team_id, user_id, access,
         can_share_owned_memory, granted_by_user_id
       ) values
         ($1, $2, $3, 'write', true, $3),
         ($1, $2, $4, 'read', false, $3),
         ($1, $2, $5, 'write', true, $3)`,
      [teamWorkspaceId, teamId, ownerUserId, readerUserId, managerUserId]
    );
    const ownerSession = await pool.query<{ id: string }>(
      `insert into user_sessions (user_id, session_hash, expires_at)
       values ($1, $2, now() + interval '1 hour') returning id`,
      [ownerUserId, hash(`owner-session:${randomUUID()}`)]
    );
    const managerSession = await pool.query<{ id: string }>(
      `insert into user_sessions (user_id, session_hash, expires_at)
       values ($1, $2, now() + interval '1 hour') returning id`,
      [managerUserId, hash(`manager-session:${randomUUID()}`)]
    );
    const sourceDeployment = await pool.query<{
      id: string;
      protocol_deployment_id: string;
    }>(
      `insert into deployment_identities (
         protocol_deployment_id, locality, profile, display_name
       ) values ($1, 'remote', 'team_self_hosted', $2)
       returning id, protocol_deployment_id`,
      [randomUUID(), `Source ${randomUUID()}`]
    );
    const targetDeployment = await pool.query<{
      id: string;
      protocol_deployment_id: string;
    }>(
      `insert into deployment_identities (
         protocol_deployment_id, locality, profile, display_name
       ) values ($1, 'remote', 'team_self_hosted', $2)
       returning id, protocol_deployment_id`,
      [randomUUID(), `Target ${randomUUID()}`]
    );
    const remoteExternalSubjectId = `subject-${randomUUID()}`;
    const remoteIdentity = await pool.query<{ id: string }>(
      `insert into sync_external_user_identities (
         deployment_identity_id, external_subject_id
       ) values ($1, $2) returning id`,
      [sourceDeployment.rows[0]!.id, remoteExternalSubjectId]
    );
    const credential = await pool.query<{ id: string }>(
      `insert into device_credentials (
         owner_user_id, credential_key_id, upstream_backend_id,
         device_instance_id, verifier_kind, verifier_hash, operation_families
       ) values ($1, $2, $3, $4, 'secret_hash', $5, $6::text[])
       returning id`,
      [
        ownerUserId,
        `shared-memory-key-${randomUUID()}`,
        `backend-${randomUUID()}`,
        `device-${randomUUID()}`,
        hash(`credential:${randomUUID()}`),
        ["share_grant_management", "team_workspace_read", "sync"]
      ]
    );
    const fixture: WorkspaceFixture = {
      ownerUserId,
      readerUserId,
      managerUserId,
      outsiderUserId,
      ownerSessionId: ownerSession.rows[0]!.id,
      managerSessionId: managerSession.rows[0]!.id,
      teamId,
      teamWorkspaceId,
      sourceDeploymentId: sourceDeployment.rows[0]!.id,
      sourceProtocolDeploymentId: String(
        sourceDeployment.rows[0]!.protocol_deployment_id
      ),
      targetDeploymentId: targetDeployment.rows[0]!.id,
      targetProtocolDeploymentId: String(
        targetDeployment.rows[0]!.protocol_deployment_id
      ),
      remoteUserIdentityId: remoteIdentity.rows[0]!.id,
      remoteExternalSubjectId,
      deviceCredentialId: credential.rows[0]!.id
    };
    await repository.putTeamPolicy(actor(ownerUserId), {
      mutationId: randomUUID(),
      teamId,
      expectedCurrentVersion: 0,
      allowedRepresentations: options?.teamAllowed ?? allRepresentations
    });
    await repository.putWorkspacePolicy(actor(ownerUserId), {
      mutationId: randomUUID(),
      teamId,
      teamWorkspaceId,
      expectedCurrentVersion: 0,
      allowedRepresentations: options?.workspaceAllowed ?? allRepresentations
    });
    return fixture;
  };

  const createSource = async (
    fixture: WorkspaceFixture,
    sourceRevision = 1,
    label = `source-${sourceRevision}`,
    options?: SourceRevisionOptions
  ): Promise<SourceFixture> => {
    const session = await pool.query<{ id: string }>(
      `insert into sessions (
         owner_user_id, visibility, source_runtime, capture_method
       ) values ($1, 'personal', 'codex', 'transcript') returning id`,
      [fixture.ownerUserId]
    );
    const ownerPrincipalId = randomUUID();
    const logicalMemory = await pool.query<{ id: string }>(
      `insert into logical_memories (
         owner_user_id, owner_principal_id, origin_deployment_identity_id,
         source_boundary, origin_source_id, local_session_id, logical_key,
         latest_source_revision
      ) values ($1, $2, $3, 'captured_session', $4, $5, $6, $7)
       returning id`,
      [
        fixture.ownerUserId,
        ownerPrincipalId,
        fixture.sourceDeploymentId,
        `source-${randomUUID()}`,
        session.rows[0]!.id,
        `logical-${randomUUID()}`,
        0
      ]
    );
    const logicalMemoryId = logicalMemory.rows[0]!.id;
    const replica = await pool.query<{ id: string }>(
      `insert into memory_replicas (
         logical_memory_id, deployment_identity_id, owner_user_id,
         owner_principal_id, replica_role, source_boundary, local_session_id,
         latest_revision, lifecycle, encryption_scope, freshness_status,
         representation_policy_revision, content_policy_version
       ) values (
         $1, $2, $3, $4, 'target', 'captured_session', $5,
         $6, 'active', 'owner_private_replica', 'fresh', 1, 1
       ) returning id`,
      [
        logicalMemoryId,
        fixture.targetDeploymentId,
        fixture.ownerUserId,
        ownerPrincipalId,
        session.rows[0]!.id,
        0
      ]
    );
    const remoteReplicaId = replica.rows[0]!.id;
    const sourceReplicaId = randomUUID();
    const relationship = await pool.query<{ id: string }>(
      `insert into cross_identity_sync_relationships (
         id,
         logical_memory_id, side, local_replica_id, local_user_id,
         device_credential_id, remote_deployment_identity_id,
         remote_user_identity_id, remote_replica_id, source_boundary,
         sync_mode, state, idempotency_key, creation_request_hash,
         source_cursor, target_processing_cursor, package_sequence, last_synced_at
       ) values (
         $1, $2, 'target', $3, $4, $5, $6, $7, $8::uuid, 'captured_session',
         'live', 'ready', $9::text, $10::text, $11::bigint, $11::bigint,
         $11::bigint, now()
       ) returning id`,
      [
        randomUUID(),
        logicalMemoryId,
        remoteReplicaId,
        fixture.ownerUserId,
        fixture.deviceCredentialId,
        fixture.sourceDeploymentId,
        fixture.remoteUserIdentityId,
        sourceReplicaId,
        `sync-${randomUUID()}`,
        hash(`sync-request:${randomUUID()}`),
        0
      ]
    );
    const source: SourceFixture = {
      logicalMemoryId,
      ownerPrincipalId,
      remoteReplicaId,
      sourceReplicaId,
      syncRelationshipId: relationship.rows[0]!.id,
      sessionId: session.rows[0]!.id,
      currentRevision: 0,
      currentLabel: "",
      packageSequence: 0,
      originEventId: deterministicUuid(logicalMemoryId, "origin-event"),
      seededEvents: [],
      leaf: {
        nodeId: "",
        summaryText: "",
        sourceEventIds: []
      },
      rollup: {
        nodeId: "",
        summaryText: "",
        sourceEventIds: []
      },
      lastSyncPackage: null,
      lastUploadSessionId: null
    };
    await seedAuthoritativeSourceRevision(
      fixture,
      source,
      sourceRevision,
      label,
      options
    );
    return source;
  };

  const applySyncPackage = async (
    source: SourceFixture,
    syncPackage: CapturedSessionSyncPackageV1,
    summarySnapshotIncluded = true
  ) => {
    const uploadSessionId = randomUUID();
    await pool.query(
      `insert into sync_package_upload_sessions (
         id, sync_relationship_id, protocol_package_id, request_hash,
         package_manifest, package_checksum, source_sequence, from_cursor,
         to_cursor, total_bytes, expected_chunk_count, idempotency_key
       ) values (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12
       )`,
      [
        uploadSessionId,
        source.syncRelationshipId,
        syncPackage.packageId,
        hash(`upload-request:${syncPackage.packageId}`),
        JSON.stringify({
          recordCount:
            syncPackage.changes.length + syncPackage.summaryNodes.length,
          summaryRevisionHash: summarySnapshotIncluded
            ? syncPackage.summaryRevisionHash
            : null
        }),
        hash(`upload-checksum:${syncPackage.packageId}`),
        syncPackage.packageSequence,
        syncPackage.fromCursor,
        syncPackage.toCursor,
        Buffer.byteLength(JSON.stringify(syncPackage), "utf8"),
        1,
        `upload-${syncPackage.packageId}`
      ]
    );
    const result = await syncRepository.applyCapturedSessionSyncPackage({
      relationshipId: source.syncRelationshipId,
      uploadSessionId,
      package: syncPackage
    });
    return { ...result, uploadSessionId };
  };

  const seedAuthoritativeSourceRevision = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    revision: number,
    label: string,
    options?: SourceRevisionOptions
  ): Promise<void> => {
    if (revision < source.currentRevision) {
      throw new Error("seedAuthoritativeSourceRevision cannot move backwards");
    }
    if (revision === source.currentRevision) {
      return;
    }
    const userText = `${label} user source`;
    const assistantText = options?.assistantText ?? `${label} assistant source`;
    const assistantPrimaryText = options?.groupedAssistantSources
      ? `${label} assistant`
      : assistantText;
    const userOccurredAt = occurredAtFor(revision * 10);
    const assistantOccurredAt = occurredAtFor(revision * 10 + 1);
    const capturedAt = occurredAtFor(revision * 10 + 2);
    const transportChunkGroupId = deterministicUuid(
      source.logicalMemoryId,
      String(revision),
      "transport-group"
    );
    const userContributor = buildCapturedSessionSyncContributor({
      originItemId: deterministicUuid(
        source.logicalMemoryId,
        String(revision),
        "user"
      ),
      actor: "user",
      kind: "user_message",
      content: userText,
      toolName: null,
      toolCallId: null,
      sourceEventTime: userOccurredAt,
      sourceSequence: revision * 10,
      sourceKind: "codex",
      sourceAdapterVersion: "1",
      sourceTransport: "test",
      sourceRecordType: "message",
      sourceEventType: "user_message",
      rawJson: { text: userText },
      rawText: userText,
      metadata: {
        actor: "user",
        seedLabel: label,
        role: "user",
        transportChunkGroupId
      },
      logicalSourceId: `logical-${label}-user`,
      transportChunkIndex: 0,
      transportChunkCount: 1,
      transportChunkText: userText,
      transportChunkEncoding: "utf8",
      projectionStatus: "projected",
      projectionVersion: "shared-memory-test-v1",
      projectionPolicyRevision: 1,
      memoryExcludedAt: null,
      memoryExclusionReason: null
    });
    const assistantContributor = buildCapturedSessionSyncContributor({
      originItemId: deterministicUuid(
        source.logicalMemoryId,
        String(revision),
        "assistant"
      ),
      actor: options?.assistantActor ?? "assistant",
      kind: options?.assistantKind ?? "assistant_message",
      content: assistantPrimaryText,
      toolName: options?.assistantToolName ?? null,
      toolCallId: null,
      sourceEventTime: assistantOccurredAt,
      sourceSequence: revision * 10 + 1,
      sourceKind: "codex",
      sourceAdapterVersion: "1",
      sourceTransport: "test",
      sourceRecordType: "message",
      sourceEventType: options?.assistantKind ?? "assistant_message",
      rawJson: options?.assistantRawJson ?? { text: assistantPrimaryText },
      rawText: assistantPrimaryText,
      metadata: {
        actor: options?.assistantActor ?? "assistant",
        seedLabel: label,
        role: options?.assistantActor ?? "assistant",
        ...(options?.assistantToolName
          ? { toolName: options.assistantToolName }
          : {}),
        transportChunkGroupId
      },
      logicalSourceId: `logical-${label}-assistant`,
      transportChunkIndex: 0,
      transportChunkCount: options?.groupedAssistantSources ? 2 : 1,
      transportChunkText: assistantPrimaryText,
      transportChunkEncoding: "utf8",
      projectionStatus: "projected",
      projectionVersion: "shared-memory-test-v1",
      projectionPolicyRevision: 1,
      memoryExcludedAt: options?.assistantMemoryExcludedAt ?? null,
      memoryExclusionReason: options?.assistantMemoryExclusionReason ?? null
    });
    const assistantContinuationContributor = options?.groupedAssistantSources
      ? buildCapturedSessionSyncContributor({
          originItemId: deterministicUuid(
            source.logicalMemoryId,
            String(revision),
            "assistant-continuation"
          ),
          actor: "assistant",
          kind: "assistant_message",
          content: "source",
          toolName: null,
          toolCallId: null,
          sourceEventTime: assistantOccurredAt,
          sourceSequence: revision * 10 + 2,
          sourceKind: "codex",
          sourceAdapterVersion: "1",
          sourceTransport: "test",
          sourceRecordType: "message",
          sourceEventType: "assistant_message",
          rawJson: { text: "source" },
          rawText: "source",
          metadata: {
            actor: "assistant",
            seedLabel: label,
            role: "assistant",
            transportChunkGroupId
          },
          logicalSourceId: `logical-${label}-assistant`,
          transportChunkIndex: 1,
          transportChunkCount: 2,
          transportChunkText: "source",
          transportChunkEncoding: "utf8",
          projectionStatus: "projected",
          projectionVersion: "shared-memory-test-v1",
          projectionPolicyRevision: 1,
          memoryExcludedAt: null,
          memoryExclusionReason: null
        })
      : null;
    const content = `${userText}\n${assistantText}`;
    const manifest = [
      {
        sourceIds: [userContributor.originItemId],
        actor: userContributor.actor,
        kind: userContributor.kind,
        toolName: userContributor.toolName ?? null,
        toolCallId: userContributor.toolCallId ?? null,
        sourceSequence: userContributor.sourceSequence,
        sourceEventTime: userContributor.sourceEventTime,
        offsetStart: 0,
        offsetEnd: userText.length
      },
      {
        sourceIds: [
          assistantContributor.originItemId,
          ...(assistantContinuationContributor
            ? [assistantContinuationContributor.originItemId]
            : [])
        ],
        actor: assistantContributor.actor,
        kind: assistantContributor.kind,
        toolName: assistantContributor.toolName ?? null,
        toolCallId: assistantContributor.toolCallId ?? null,
        sourceSequence: assistantContributor.sourceSequence,
        sourceEventTime: assistantContributor.sourceEventTime,
        offsetStart: userText.length + 1,
        offsetEnd: content.length
      }
    ];
    const event = buildCapturedSessionSyncEvent({
      originEventId: source.originEventId,
      eventType: "captured",
      actor: "assistant",
      content,
      metadata: { semanticItemManifest: manifest, seedLabel: label },
      includeInEmbedding: true,
      includeInLcm: true,
      projectionPolicyKey: "shared-memory-test",
      projectionPolicyRevision: 1,
      tokenCount: content.split(/\s+/).length,
      sealReason: "user_turn",
      capturedAt,
      sourceEventTime: capturedAt,
      sourceSequence: revision,
      contributors: [
        userContributor,
        assistantContributor,
        ...(assistantContinuationContributor
          ? [assistantContinuationContributor]
          : [])
      ]
    });
    const leafOriginNodeId = deterministicUuid(
      source.logicalMemoryId,
      "lcm-leaf"
    );
    const rollupOriginNodeId = deterministicUuid(
      source.logicalMemoryId,
      "lcm-rollup"
    );
    const leafSummaryText = `${label} synthesized source summary`;
    const leafBase = {
      originNodeId: leafOriginNodeId,
      kind: "leaf" as const,
      depth: 0,
      lcmAlgorithmVersion: "depth0-source-items-v1",
      summaryText: leafSummaryText,
      summaryModel: "test-lcm-model",
      summaryPromptVersion: "shared-memory-test-v1",
      summaryStructuredJson: {
        schema_version: LCM_SUMMARY_SCHEMA_VERSION,
        title: `${label} leaf`,
        summary_text: leafSummaryText
      },
      summaryStructuredSchemaVersion: LCM_SUMMARY_SCHEMA_VERSION,
      sourceOriginEventIds: [source.originEventId],
      childOriginNodeIds: [],
      sourceHash: hash(`leaf:${source.logicalMemoryId}:${revision}:${label}`),
      sourceEventCount: 1,
      sourceTokenEstimate: content.split(/\s+/).length,
      summaryTokenEstimate: leafSummaryText.split(/\s+/).length,
      createdAt: capturedAt,
      updatedAt: occurredAtFor(revision * 10 + 3)
    };
    const leaf = {
      ...leafBase,
      revisionHash: crossIdentitySyncDigest(leafBase)
    };
    const rollupSummaryText = `${label} synthesized rollup summary`;
    const rollupBase = {
      originNodeId: rollupOriginNodeId,
      kind: "rollup" as const,
      depth: 1,
      lcmAlgorithmVersion: "depth1-child-rollup-v1",
      summaryText: rollupSummaryText,
      summaryModel: "test-lcm-model",
      summaryPromptVersion: "shared-memory-test-v1",
      summaryStructuredJson: {
        schema_version: LCM_SUMMARY_SCHEMA_VERSION,
        title: `${label} rollup`,
        summary_text: rollupSummaryText
      },
      summaryStructuredSchemaVersion: LCM_SUMMARY_SCHEMA_VERSION,
      sourceOriginEventIds: [source.originEventId],
      childOriginNodeIds: [leafOriginNodeId],
      sourceHash: hash(`rollup:${source.logicalMemoryId}:${revision}:${label}`),
      sourceEventCount: 1,
      sourceTokenEstimate: content.split(/\s+/).length,
      summaryTokenEstimate: rollupSummaryText.split(/\s+/).length,
      createdAt: capturedAt,
      updatedAt: occurredAtFor(revision * 10 + 3)
    };
    const rollup = {
      ...rollupBase,
      revisionHash: crossIdentitySyncDigest(rollupBase)
    };
    const summaryNodes =
      options?.includeSummarySnapshot === false ? [] : [leaf, rollup];
    const syncPackage: CapturedSessionSyncPackageV1 = {
      format: CAPTURED_SESSION_SYNC_FORMAT,
      formatVersion: CAPTURED_SESSION_SYNC_FORMAT_VERSION,
      policyVersion: CAPTURED_SESSION_SYNC_POLICY_VERSION,
      packageId: randomUUID(),
      relationshipId: source.syncRelationshipId,
      logicalMemoryId: source.logicalMemoryId,
      sourceDeploymentId: fixture.sourceProtocolDeploymentId,
      sourceUserId: fixture.remoteExternalSubjectId,
      sourceReplicaId: source.sourceReplicaId,
      targetDeploymentId: fixture.targetProtocolDeploymentId,
      targetUserId: fixture.ownerUserId,
      targetReplicaId: source.remoteReplicaId,
      packageSequence: source.packageSequence + 1,
      fromCursor: source.currentRevision,
      toCursor: revision,
      createdAt: occurredAtFor(revision * 10 + 3),
      consentDigest: hash(`consent:${source.logicalMemoryId}`),
      policyDigest: hash(`policy:${source.logicalMemoryId}`),
      summaryRevisionHash: crossIdentitySyncDigest(summaryNodes),
      session: {
        originSessionId: source.sessionId,
        externalSessionId: `external-${source.sessionId}`,
        sourceRuntime: "codex",
        captureMethod: "transcript",
        capturedAt,
        title: `${label} session`,
        sourceAdapterVersion: "1"
      },
      changes: [
        {
          cursor: revision,
          operation: "upsert",
          originEventId: source.originEventId,
          revisionHash: event.revisionHash,
          event
        }
      ],
      summaryNodes
    };
    const applied = await applySyncPackage(
      source,
      syncPackage,
      options?.includeSummarySnapshot !== false
    );
    const eventId = applied.eventIds[0];
    if (!eventId) {
      throw new Error("expected synchronized event to materialize");
    }
    const persistedContributors = await pool.query<{ id: string }>(
      `select ci.id
         from memory_event_sources mes
         join conversation_items ci on ci.id = mes.conversation_item_id
        where mes.memory_event_id = $1
        order by mes.source_order, ci.id`,
      [eventId]
    );
    source.currentRevision = revision;
    source.currentLabel = label;
    source.packageSequence = syncPackage.packageSequence;
    source.seededEvents = [
      {
        eventId,
        originEventId: source.originEventId,
        sourceCursor: revision,
        contributorIds: persistedContributors.rows.map((row) => row.id),
        occurredAt: capturedAt,
        content
      }
    ];
    if (options?.includeSummarySnapshot !== false) {
      source.leaf = {
        nodeId: applied.summaryNodeIds[0]!,
        summaryText: leafSummaryText,
        sourceEventIds: [eventId]
      };
      source.rollup = {
        nodeId: applied.summaryNodeIds[1]!,
        summaryText: rollupSummaryText,
        sourceEventIds: [eventId]
      };
    }
    source.lastSyncPackage = syncPackage;
    source.lastUploadSessionId = applied.uploadSessionId;
  };

  const ensureSourceRevision = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    sourceRevision: number,
    label: string
  ): Promise<void> => {
    if (sourceRevision > source.currentRevision) {
      await seedAuthoritativeSourceRevision(
        fixture,
        source,
        sourceRevision,
        label
      );
    }
  };

  const createPersistedPreview = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    representation: SharedMemoryRepresentation,
    sourceRevision = source.currentRevision,
    label = source.currentLabel,
    allowedRepresentations: SharedMemoryRepresentation[] = allRepresentations
  ) => {
    await ensureSourceRevision(fixture, source, sourceRevision, label);
    return repository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      {
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: source.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        representation,
        allowedRepresentations,
        authority: authority(fixture)
      }
    );
  };

  const putOwnerPolicy = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    allowedRepresentations: SharedMemoryRepresentation[] = allRepresentations
  ) =>
    repository.putSourceOwnerPolicy(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      logicalMemoryId: source.logicalMemoryId,
      expectedCurrentVersion: 0,
      allowedRepresentations
    });

  const createConsent = async (
    fixture: WorkspaceFixture,
    source: SourceFixture,
    input: {
      representation: SharedMemoryRepresentation;
      mode: SharedMemoryConsentMode;
      allowedRepresentations?: SharedMemoryRepresentation[];
      sourceRevision?: number;
      label: string;
      consentId?: string;
    }
  ) => {
    const preview = await createPersistedPreview(
      fixture,
      source,
      input.representation,
      input.sourceRevision ?? source.currentRevision,
      input.label,
      input.allowedRepresentations ?? allRepresentations
    );
    const consentId = input.consentId ?? randomUUID();
    const consent = await repository.createSourceOwnerConsent(
      actor(fixture.ownerUserId),
      {
        consentId,
        mode: input.mode,
        allowedRepresentations:
          input.allowedRepresentations ?? allRepresentations,
        selectedRepresentation: input.representation,
        authority: authority(fixture),
        preview
      }
    );
    return { consent, consentId, preview };
  };

  const createGrant = async (
    fixture: WorkspaceFixture,
    options: {
      representation?: SharedMemoryRepresentation;
      mode?: SharedMemoryConsentMode;
      ownerAllowed?: SharedMemoryRepresentation[];
      sourceRevision?: number;
      label?: string;
    } = {}
  ): Promise<GrantFixture> => {
    const representation = options.representation ?? "memory_events";
    const source = await createSource(
      fixture,
      options.sourceRevision ?? 1,
      options.label ?? representation
    );
    await putOwnerPolicy(
      fixture,
      source,
      options.ownerAllowed ?? allRepresentations
    );
    const created = await createConsent(fixture, source, {
      representation,
      mode: options.mode ?? "continuous",
      allowedRepresentations: options.ownerAllowed ?? allRepresentations,
      label: options.label ?? representation
    });
    const grant = await repository.createShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: created.consentId,
        authority: authority(fixture)
      }
    );
    return {
      ...source,
      consentId: created.consentId,
      shareGrantId: grant.id,
      grantVersion: grant.grantVersion,
      representation,
      preview: created.preview
    };
  };

  const materialize = async (
    fixture: WorkspaceFixture,
    grant: GrantFixture,
    options?: {
      sourceRevision?: number;
      label?: string;
      mutationId?: string;
      expectedRepresentationVersion?: number;
    }
  ) => {
    const sourceRevision = options?.sourceRevision ?? grant.currentRevision;
    const label = options?.label ?? grant.currentLabel;
    const preview = await createPersistedPreview(
      fixture,
      grant,
      grant.representation,
      sourceRevision,
      label
    );
    return repository.materializeGrantRepresentation(
      actor(fixture.ownerUserId),
      {
        mutationId: options?.mutationId ?? randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: grant.consentId,
        expectedGrantVersion: grant.grantVersion,
        expectedRepresentationVersion: options?.expectedRepresentationVersion,
        preview
      }
    );
  };

  const materializeWithPreview = async (
    fixture: WorkspaceFixture,
    grant: GrantFixture,
    options?: {
      sourceRevision?: number;
      label?: string;
      mutationId?: string;
      expectedRepresentationVersion?: number;
    }
  ) => {
    const sourceRevision = options?.sourceRevision ?? grant.currentRevision;
    const label = options?.label ?? grant.currentLabel;
    const preview = await createPersistedPreview(
      fixture,
      grant,
      grant.representation,
      sourceRevision,
      label
    );
    const representation = await repository.materializeGrantRepresentation(
      actor(fixture.ownerUserId),
      {
        mutationId: options?.mutationId ?? randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: grant.consentId,
        expectedGrantVersion: grant.grantVersion,
        expectedRepresentationVersion: options?.expectedRepresentationVersion,
        preview
      }
    );
    return { preview, representation };
  };

  const readMemoryPipelineCounts = async (): Promise<
    Record<string, string>
  > => {
    const result = await pool.query<Record<string, string>>(
      `select
         (select count(*) from conversation_items)::text as conversation_items,
         (select count(*) from memory_events)::text as memory_events,
         (select count(*) from memory_event_sources)::text as memory_event_sources,
         (select count(*) from memory_nodes)::text as memory_nodes,
         (select count(*) from memory_node_sources)::text as memory_node_sources,
         (select count(*) from memory_embeddings)::text as memory_embeddings,
         (select count(*) from memory_embeddings_384)::text as memory_embeddings_384,
         (select count(*) from memory_embeddings_1024)::text as memory_embeddings_1024,
         (select count(*) from memory_embeddings_1536)::text as memory_embeddings_1536,
         (select count(*) from memory_embeddings_3072)::text as memory_embeddings_3072,
         (select count(*) from memory_questions)::text as memory_questions,
         (select count(*) from workflow_token_usage_source_references)::text as ai_sources,
         (select count(*) from local_work_queue)::text as queued_projection_work`
    );
    return result.rows[0]!;
  };

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  beforeEach(() => {
    const base = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 41).toString("base64")
    );
    const ownerBase = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 42).toString("base64")
    );
    encryptSpy = vi.fn(base.encrypt.bind(base));
    decryptSpy = vi.fn(base.decrypt.bind(base));
    ownerEncryptSpy = vi.fn(ownerBase.encrypt.bind(ownerBase));
    ownerDecryptSpy = vi.fn(ownerBase.decrypt.bind(ownerBase));
    provider = {
      ...base,
      encrypt: encryptSpy,
      decrypt: decryptSpy,
      rewrap: base.rewrap?.bind(base)
    } satisfies EnvelopeEncryptionProvider;
    ownerProvider = {
      ...ownerBase,
      encrypt: ownerEncryptSpy,
      decrypt: ownerDecryptSpy,
      rewrap: ownerBase.rewrap?.bind(ownerBase)
    } satisfies EnvelopeEncryptionProvider;
    repository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });
    collaboration = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    syncRepository = createCrossIdentitySyncRepository(pool, {
      ownerPrivateReplicaEnvelopeEncryptionProvider: ownerProvider
    });
    retentionRepository = createRetentionLifecycleRepository(pool, {
      authorizeHoldActor: async () => true
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("encrypts synchronized conversation item metadata and transport payloads", async () => {
    const fixture = await createWorkspaceFixture();
    const secret = `cross-sync-secret-${randomUUID()}`;
    const source = await createSource(fixture, 1, secret);
    const contributorIds = source.seededEvents[0]!.contributorIds;

    const stored = await pool.query<{
      raw_json: unknown;
      raw_text: string | null;
      transport_chunk_text: string | null;
      metadata: Record<string, unknown>;
    }>(
      `select raw_json,raw_text,transport_chunk_text,metadata
         from conversation_items
        where id=any($1::uuid[])
        order by id`,
      [contributorIds]
    );
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows) {
      expect(row.raw_json).toMatchObject({ contentEncrypted: true });
      expect(row.raw_text).toBe("[koed encrypted conversation item]");
      expect(row.transport_chunk_text).toBe(
        "[koed encrypted conversation item]"
      );
      expect(row.metadata.encryptedConversationItemColumns).toEqual([
        "raw_json",
        "raw_text",
        "transport_chunk_text",
        "metadata"
      ]);
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(JSON.stringify(row.metadata)).not.toContain("seedLabel");
    }

    const encrypted = await pool.query<{
      source_id: string;
      source_column: string;
    }>(
      `select source_id,source_column
         from encrypted_field_payloads
        where source_table='conversation_items'
          and source_id=any($1::uuid[])
          and invalidated_at is null
        order by source_id,source_column`,
      [contributorIds]
    );
    expect(encrypted.rows).toHaveLength(8);
    for (const contributorId of contributorIds) {
      expect(
        encrypted.rows
          .filter((row) => row.source_id === contributorId)
          .map((row) => row.source_column)
      ).toEqual(["metadata", "raw_json", "raw_text", "transport_chunk_text"]);
    }
  });

  it("binds explicit consent to the exact redacted preview and source owner", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 3);
    await putOwnerPolicy(fixture, source);
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events",
      3,
      "exact-preview"
    );
    const contributorIdentities = await pool.query<{
      id: string;
      external_item_id: string | null;
    }>(
      `select ci.id, ci.external_item_id
         from memory_event_sources mes
         join conversation_items ci on ci.id = mes.conversation_item_id
        where mes.memory_event_id = $1
        order by mes.source_order, ci.id`,
      [source.seededEvents[0]!.eventId]
    );
    expect(contributorIdentities.rows).not.toHaveLength(0);
    expect(
      contributorIdentities.rows.every(
        (row) => row.external_item_id && row.id !== row.external_item_id
      )
    ).toBe(true);
    const consentId = randomUUID();
    const input = {
      consentId,
      mode: "snapshot" as const,
      allowedRepresentations: allRepresentations,
      selectedRepresentation: "memory_events" as const,
      authority: authority(fixture),
      preview
    };
    const first = await repository.createSourceOwnerConsent(
      actor(fixture.ownerUserId),
      input
    );
    const replay = await repository.createSourceOwnerConsent(
      actor(fixture.ownerUserId),
      input
    );
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      id: consentId,
      mode: "snapshot",
      state: "active",
      maximumAuthorizedSourceRevision: 3,
      previewHash: preview.previewHash,
      redactedContentHash: preview.redactedContentHash
    });

    await expect(
      repository.createSourceOwnerConsent(actor(fixture.ownerUserId), {
        ...input,
        consentId: randomUUID(),
        preview: {
          previewId: preview.previewId,
          previewHash: hash(`tampered-preview:${preview.previewId}`)
        }
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    await expect(
      repository.createSourceOwnerConsent(actor(fixture.managerUserId), {
        ...input,
        consentId: randomUUID(),
        authority: authority(fixture, "manager")
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    await expect(
      repository.createShareGrant(actor(fixture.managerUserId), {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId,
        authority: authority(fixture, "manager")
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
  });

  it("holds one repeatable-read snapshot while authoritative previews load sync context and source rows", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "repeatable-read");
    await putOwnerPolicy(fixture, source);
    const tamperedContributorId = source.seededEvents[0]?.contributorIds[0];
    if (!tamperedContributorId) {
      throw new Error("expected seeded contributor for repeatable-read test");
    }

    let releaseProviderGate!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProviderGate = resolve;
    });
    let signalProviderRequested!: () => void;
    const providerRequested = new Promise<void>((resolve) => {
      signalProviderRequested = resolve;
    });
    let gateUsed = false;
    const snapshotRepository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolveOwnerPrivateReplicaEncryptionProvider: async (input) => {
        if (input.purpose === "decrypt" && !gateUsed) {
          gateUsed = true;
          signalProviderRequested();
          await providerGate;
        }
        return ownerProvider;
      }
    });
    const previewInput = {
      logicalMemoryId: source.logicalMemoryId,
      remoteReplicaId: source.remoteReplicaId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      representation: "memory_events" as const,
      allowedRepresentations: allRepresentations,
      authority: authority(fixture)
    };

    const previewPromise = snapshotRepository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      previewInput
    );
    await providerRequested;
    await pool.query(
      `update conversation_items
          set source_event_type = $2
        where id = $1`,
      [tamperedContributorId, "tampered_user_message"]
    );
    releaseProviderGate();

    const preview = await previewPromise;
    expect(preview.sourceRevision).toBe(1);
    expect(preview.items.map((item) => item.itemType)).toEqual([
      "user_message",
      "assistant_message"
    ]);
    await expect(
      repository.createAuthoritativeSourcePreview(
        actor(fixture.ownerUserId),
        previewInput
      )
    ).rejects.toThrow(
      "Memory Event sync revision hash does not match active mapping"
    );
  });

  it("verifies every canonical contributor while rendering grouped semantic source items", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "grouped-source", {
      groupedAssistantSources: true
    });
    await putOwnerPolicy(fixture, source);

    const preview = await repository.createAuthoritativeSourcePreview(
      actor(fixture.ownerUserId),
      {
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: source.remoteReplicaId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        representation: "memory_events",
        allowedRepresentations: allRepresentations,
        authority: authority(fixture)
      }
    );

    expect(source.seededEvents[0]?.contributorIds).toHaveLength(3);
    expect(preview.items).toMatchObject([
      { itemType: "user_message" },
      {
        itemType: "assistant_message",
        content: { text: "grouped-source assistant source" }
      }
    ]);
  });

  it("excludes independently classified source items after verifying the canonical revision", async () => {
    const cases: Array<{
      label: string;
      options: SourceRevisionOptions;
    }> = [
      {
        label: "hidden-reasoning",
        options: {
          assistantKind: "reasoning_raw",
          assistantText: "hidden chain of thought"
        }
      },
      {
        label: "system-instruction",
        options: {
          assistantActor: "system",
          assistantKind: "system_message",
          assistantText: "hidden system instruction"
        }
      },
      {
        label: "credential-bearing",
        options: {
          assistantText: "Bearer abcdefghijklmnopqrstuvwxyz"
        }
      },
      {
        label: "unsupported-tool",
        options: {
          assistantActor: "tool",
          assistantKind: "tool_result",
          assistantText: "unclassified tool output"
        }
      },
      {
        label: "memory-excluded",
        options: {
          assistantMemoryExcludedAt: "2026-01-01T00:00:00.000Z",
          assistantMemoryExclusionReason: "source_policy"
        }
      }
    ];

    for (const testCase of cases) {
      const fixture = await createWorkspaceFixture();
      const source = await createSource(
        fixture,
        1,
        testCase.label,
        testCase.options
      );
      await putOwnerPolicy(fixture, source);
      const preview = await createPersistedPreview(
        fixture,
        source,
        "memory_events"
      );
      expect(preview.items).toEqual([
        expect.objectContaining({
          itemType: "user_message",
          content: { text: `${testCase.label} user source` }
        })
      ]);
    }
  });

  it("rejects unknown authoritative source types instead of filtering them", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "unknown-source-type", {
      assistantActor: "future_actor",
      assistantKind: "future_protocol_item"
    });
    await putOwnerPolicy(fixture, source);
    await expect(
      createPersistedPreview(fixture, source, "memory_events")
    ).rejects.toMatchObject({ reasonCode: "unknown_item_type" });
    const persisted = await pool.query(
      `select 1 from shared_source_artifacts where logical_memory_id=$1`,
      [source.logicalMemoryId]
    );
    expect(persisted.rowCount).toBe(0);
  });

  it("rejects cross-session leaf and rollup provenance without creating a fallback", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "cross-session-primary");
    const foreign = await createSource(fixture, 1, "cross-session-foreign");
    await putOwnerPolicy(fixture, source);
    const foreignEventId = foreign.seededEvents[0]!.eventId;

    await pool.query(
      `insert into memory_node_sources
         (memory_node_id,memory_event_id,source_order)
       values ($1,$2,1)`,
      [source.leaf.nodeId, foreignEventId]
    );
    await expect(
      createPersistedPreview(fixture, source, "lcm_leaves")
    ).rejects.toThrow("LCM leaf mixes shared and unshared source provenance");
    await pool.query(
      `delete from memory_node_sources
        where memory_node_id=$1 and memory_event_id=$2`,
      [source.leaf.nodeId, foreignEventId]
    );

    await pool.query(
      `insert into memory_node_sources
         (memory_node_id,memory_event_id,source_order)
       values ($1,$2,1)`,
      [source.rollup.nodeId, foreignEventId]
    );
    await expect(
      createPersistedPreview(fixture, source, "lcm_rollups")
    ).rejects.toThrow("LCM rollup mixes shared and unshared source provenance");

    const persisted = await pool.query(
      `select representation from shared_source_artifacts
        where logical_memory_id=$1`,
      [source.logicalMemoryId]
    );
    expect(persisted.rows).toEqual([]);
  });

  it("keeps missing, placeholder, and unknown-schema LCM states unavailable without fallback", async () => {
    const cases: Array<{
      representation: "lcm_leaves" | "lcm_rollups";
      mutate: (source: SourceFixture) => Promise<unknown>;
      message: string;
    }> = [
      {
        representation: "lcm_leaves",
        mutate: (source) =>
          pool.query(
            "update memory_nodes set invalidated_at=now() where id=$1",
            [source.leaf.nodeId]
          ),
        message:
          "Authoritative Shared Memory source material is empty or invalid"
      },
      {
        representation: "lcm_leaves",
        mutate: (source) =>
          pool.query("update memory_nodes set summary_model=null where id=$1", [
            source.leaf.nodeId
          ]),
        message: "LCM placeholder leaves cannot be shared authoritatively"
      },
      {
        representation: "lcm_rollups",
        mutate: (source) =>
          pool.query(
            `update memory_nodes
                set summary_structured_schema_version='future-summary-v2'
              where id=$1`,
            [source.rollup.nodeId]
          ),
        message:
          "Legacy or incomplete LCM rollups cannot be shared authoritatively"
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const fixture = await createWorkspaceFixture();
      const source = await createSource(fixture, 1, `derived-state-${index}`);
      await putOwnerPolicy(fixture, source);
      await testCase.mutate(source);
      await expect(
        createPersistedPreview(fixture, source, testCase.representation)
      ).rejects.toThrow(testCase.message);
      const persisted = await pool.query(
        `select representation from shared_source_artifacts
          where logical_memory_id=$1`,
        [source.logicalMemoryId]
      );
      expect(persisted.rows).toEqual([]);
    }
  });

  it("rejects stale LCM coverage when a newer synced event has no summary snapshot", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 1, "complete-lcm");
    await putOwnerPolicy(fixture, source);
    const previousLeafId = source.leaf.nodeId;
    const previousRollupId = source.rollup.nodeId;

    source.originEventId = deterministicUuid(
      source.logicalMemoryId,
      "new-unsummarized-event"
    );
    await seedAuthoritativeSourceRevision(
      fixture,
      source,
      2,
      "missing-lcm-snapshot",
      { includeSummarySnapshot: false }
    );

    const activeEvents = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from sync_event_mappings
        where sync_relationship_id=$1 and active=true`,
      [source.syncRelationshipId]
    );
    expect(activeEvents.rows[0]?.count).toBe("2");
    expect(source.leaf.nodeId).toBe(previousLeafId);
    expect(source.rollup.nodeId).toBe(previousRollupId);

    await expect(
      createPersistedPreview(fixture, source, "lcm_leaves")
    ).rejects.toThrow(
      "LCM leaves do not cover the authoritative source revision"
    );
    await expect(
      createPersistedPreview(fixture, source, "lcm_rollups")
    ).rejects.toThrow(
      "LCM rollups do not cover the authoritative source revision"
    );
    const fallback = await pool.query(
      `select representation
         from shared_source_artifacts
        where logical_memory_id=$1`,
      [source.logicalMemoryId]
    );
    expect(fallback.rows).toEqual([]);
  });

  it("enforces the source-owner, Team, and Workspace allowlist intersection", async () => {
    const fixture = await createWorkspaceFixture({
      teamAllowed: ["lcm_leaves", "lcm_rollups"],
      workspaceAllowed: ["memory_events", "lcm_leaves"]
    });
    const source = await createSource(fixture);
    await putOwnerPolicy(fixture, source, ["memory_events", "lcm_leaves"]);
    await expect(
      createConsent(fixture, source, {
        representation: "memory_events",
        mode: "snapshot",
        allowedRepresentations: ["memory_events", "lcm_leaves"],
        label: "outside-intersection"
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
    const leaves = await createConsent(fixture, source, {
      representation: "lcm_leaves",
      mode: "snapshot",
      allowedRepresentations: ["lcm_leaves"],
      label: "inside-intersection"
    });
    expect(leaves.consent.selectedRepresentation).toBe("lcm_leaves");
  });

  it("audits representation policies and publishes committed Shared Memory outbox notifications", async () => {
    const listener = await pool.connect();
    try {
      await listener.query("listen koed_collaboration_realtime");
      const notification = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Shared Memory notification timed out")),
            2_000
          );
          listener.once(
            "notification",
            (message: { payload?: string | null }) => {
              clearTimeout(timer);
              const parsed: unknown = JSON.parse(message.payload ?? "{}");
              resolve(parsed as Record<string, unknown>);
            }
          );
        }
      );

      const fixture = await createWorkspaceFixture();
      const grant = await createGrant(fixture, {
        representation: "memory_events",
        label: "audited-notification"
      });
      const payload = await notification;
      expect(payload).toMatchObject({
        scope: "team",
        teamId: fixture.teamId,
        family: "share_grant_lifecycle"
      });
      expect(Number(payload.cursor)).toBeGreaterThan(0);

      const audit = await pool.query<{
        action: string;
        actor_user_id: string;
        owner_user_id: string | null;
        target_table: string;
        metadata: Record<string, unknown>;
      }>(
        `select action,actor_user_id,owner_user_id,target_table,metadata
           from audit_events
          where actor_user_id=$1
            and (
              metadata->>'teamId'=$2
              or metadata->>'logicalMemoryId'=$3
            )
          order by action`,
        [fixture.ownerUserId, fixture.teamId, grant.logicalMemoryId]
      );
      expect(audit.rows).toHaveLength(3);
      const byAction = new Map(audit.rows.map((row) => [row.action, row]));
      const ownerAudit = byAction.get(
        "shared_memory.source_owner_policy.updated"
      );
      expect(ownerAudit?.owner_user_id).toBe(fixture.ownerUserId);
      expect(ownerAudit?.target_table).toBe(
        "source_owner_representation_policies"
      );
      expect(ownerAudit?.metadata).toMatchObject({
        scope: "source_owner",
        logicalMemoryId: grant.logicalMemoryId,
        version: 1,
        previousVersion: 0
      });
      expect(ownerAudit?.metadata.allowedRepresentations).toEqual(
        [...allRepresentations].sort()
      );

      const teamAudit = byAction.get("team.shared_memory_policy.updated");
      expect(teamAudit?.owner_user_id).toBeNull();
      expect(teamAudit?.target_table).toBe("team_representation_policies");
      expect(teamAudit?.metadata).toMatchObject({
        scope: "team",
        teamId: fixture.teamId,
        version: 1,
        previousVersion: 0
      });
      expect(teamAudit?.metadata.allowedRepresentations).toEqual(
        [...allRepresentations].sort()
      );

      const workspaceAudit = byAction.get(
        "team.workspace.shared_memory_policy.updated"
      );
      expect(workspaceAudit?.owner_user_id).toBeNull();
      expect(workspaceAudit?.target_table).toBe(
        "workspace_representation_policies"
      );
      expect(workspaceAudit?.metadata).toMatchObject({
        scope: "workspace",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        version: 1,
        previousVersion: 0
      });
      expect(workspaceAudit?.metadata.allowedRepresentations).toEqual(
        [...allRepresentations].sort()
      );
    } finally {
      listener.release();
    }
  });

  it("audits policy reduction, invalidates the active representation, and never falls back", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "policy-reduction"
    });
    await materialize(fixture, grant);
    const mutationId = randomUUID();
    const reduced = await repository.putTeamPolicy(
      actor(fixture.managerUserId),
      {
        mutationId,
        teamId: fixture.teamId,
        expectedCurrentVersion: 1,
        allowedRepresentations: ["lcm_leaves"]
      }
    );
    expect(reduced).toMatchObject({
      scope: "team",
      version: 2,
      allowedRepresentations: ["lcm_leaves"]
    });
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId
      })
    ).toBeNull();
    const states = await pool.query<{
      lifecycle: string;
      representation: string;
      state: string;
    }>(
      `select g.lifecycle,r.representation,r.state
         from team_session_share_grants g
         join team_memory_representations r on r.share_grant_id=g.id
        where g.id=$1`,
      [grant.shareGrantId]
    );
    expect(states.rows).toEqual([
      {
        lifecycle: "unavailable",
        representation: "memory_events",
        state: "invalidated"
      }
    ]);
    const fallback = await pool.query(
      `select 1 from team_memory_representations
        where share_grant_id=$1 and representation='lcm_leaves'`,
      [grant.shareGrantId]
    );
    expect(fallback.rowCount).toBe(0);
    const audit = await pool.query<{
      metadata: Record<string, unknown>;
    }>(
      `select metadata from audit_events
        where action='team.shared_memory_policy.updated'
          and metadata->>'mutationId'=$1`,
      [mutationId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      teamId: fixture.teamId,
      version: 2,
      previousVersion: 1,
      allowedRepresentations: ["lcm_leaves"]
    });
    await expect(
      repository.putTeamPolicy(actor(fixture.managerUserId), {
        mutationId: randomUUID(),
        teamId: fixture.teamId,
        expectedCurrentVersion: 2,
        allowedRepresentations: allRepresentations
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    for (const scope of ["source_owner", "workspace"] as const) {
      const scopedFixture = await createWorkspaceFixture();
      const scopedGrant = await createGrant(scopedFixture, {
        representation: "memory_events",
        label: `${scope}-policy-reduction`
      });
      await materialize(scopedFixture, scopedGrant);
      const scopedMutationId = randomUUID();
      if (scope === "source_owner") {
        await repository.putSourceOwnerPolicy(
          actor(scopedFixture.ownerUserId),
          {
            mutationId: scopedMutationId,
            logicalMemoryId: scopedGrant.logicalMemoryId,
            expectedCurrentVersion: 1,
            allowedRepresentations: ["lcm_leaves"]
          }
        );
      } else {
        await repository.putWorkspacePolicy(
          actor(scopedFixture.managerUserId),
          {
            mutationId: scopedMutationId,
            teamId: scopedFixture.teamId,
            teamWorkspaceId: scopedFixture.teamWorkspaceId,
            expectedCurrentVersion: 1,
            allowedRepresentations: ["lcm_leaves"]
          }
        );
      }
      expect(
        await repository.readGrantRepresentation(
          actor(scopedFixture.readerUserId),
          { shareGrantId: scopedGrant.shareGrantId }
        )
      ).toBeNull();
      const scopedStates = await pool.query<{
        lifecycle: string;
        representation: string;
        state: string;
      }>(
        `select g.lifecycle,r.representation,r.state
           from team_session_share_grants g
           join team_memory_representations r on r.share_grant_id=g.id
          where g.id=$1`,
        [scopedGrant.shareGrantId]
      );
      expect(scopedStates.rows).toEqual([
        {
          lifecycle: "unavailable",
          representation: "memory_events",
          state: "invalidated"
        }
      ]);
      const scopedFallback = await pool.query(
        `select 1 from team_memory_representations
          where share_grant_id=$1 and representation='lcm_leaves'`,
        [scopedGrant.shareGrantId]
      );
      expect(scopedFallback.rowCount).toBe(0);
      const scopedAudit = await pool.query<{
        action: string;
        metadata: Record<string, unknown>;
      }>(
        `select action,metadata from audit_events
          where metadata->>'mutationId'=$1`,
        [scopedMutationId]
      );
      expect(scopedAudit.rows).toHaveLength(1);
      expect(scopedAudit.rows[0]).toMatchObject({
        action:
          scope === "source_owner"
            ? "shared_memory.source_owner_policy.updated"
            : "team.workspace.shared_memory_policy.updated",
        metadata: {
          scope,
          version: 2,
          previousVersion: 1,
          allowedRepresentations: ["lcm_leaves"]
        }
      });
    }
  });

  it("allows exactly one concurrent representation-policy mutation from the same revision", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "concurrent-policy-mutation"
    });
    await materialize(fixture, grant);
    const mutationIds = [randomUUID(), randomUUID()] as const;
    const allowedSets: SharedMemoryRepresentation[][] = [
      ["memory_events", "lcm_leaves"],
      ["memory_events", "lcm_rollups"]
    ];

    const results = await Promise.allSettled(
      mutationIds.map((mutationId, index) =>
        repository.putTeamPolicy(actor(fixture.managerUserId), {
          mutationId,
          teamId: fixture.teamId,
          expectedCurrentVersion: 1,
          allowedRepresentations: allowedSets[index]!
        })
      )
    );
    const fulfilled = results.filter(
      (
        result
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<SharedMemoryRepository["putTeamPolicy"]>>
      > => result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value).toMatchObject({ scope: "team", version: 2 });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(SharedMemoryConflictError);

    const policies = await pool.query<{
      version: number;
      policy_hash: string;
      superseded_at: Date | null;
    }>(
      `select version,policy_hash,superseded_at
         from team_representation_policies
        where team_id=$1
        order by version`,
      [fixture.teamId]
    );
    expect(policies.rows).toHaveLength(2);
    expect(policies.rows.filter((policy) => policy.version === 2)).toEqual([
      expect.objectContaining({
        policy_hash: fulfilled[0]!.value.policyHash,
        superseded_at: null
      })
    ]);

    const committedEffects = await pool.query<{
      policy_audits: string;
      representation_events: string;
    }>(
      `select
         (select count(*) from audit_events
           where action='team.shared_memory_policy.updated'
             and metadata->>'mutationId'=any($1::text[]))::text as policy_audits,
         (select count(*) from collaboration_outbox
           where family='representation_changed'
             and share_grant_id=$2)::text as representation_events`,
      [mutationIds, grant.shareGrantId]
    );
    expect(committedEffects.rows[0]).toEqual({
      policy_audits: "1",
      representation_events: "1"
    });
  });

  it("keeps one explicit active representation and permits only owner changes", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "lcm_leaves",
      mode: "continuous",
      label: "initial-leaves"
    });
    await materialize(fixture, grant, { label: "initial-leaves" });
    const replacement = await createConsent(fixture, grant, {
      representation: "lcm_rollups",
      mode: "continuous",
      label: "replacement-rollup"
    });
    await expect(
      repository.selectGrantRepresentation(actor(fixture.managerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: replacement.consentId,
        representation: "lcm_rollups",
        expectedGrantVersion: grant.grantVersion,
        authority: authority(fixture, "manager")
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    const changed = await repository.selectGrantRepresentation(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: replacement.consentId,
        representation: "lcm_rollups",
        expectedGrantVersion: grant.grantVersion,
        authority: authority(fixture)
      }
    );
    expect(changed).toMatchObject({
      activeRepresentation: "lcm_rollups",
      consentId: replacement.consentId,
      grantVersion: grant.grantVersion + 1
    });
    const states = await pool.query<{
      representation: SharedMemoryRepresentation;
      state: string;
    }>(
      `select representation, state from team_memory_representations
       where share_grant_id = $1`,
      [grant.shareGrantId]
    );
    expect(states.rows).toEqual([
      { representation: "lcm_leaves", state: "invalidated" }
    ]);
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId,
        representation: "lcm_leaves"
      })
    ).toBeNull();
  });

  it("pins snapshot consent and advances continuous consent by source revision", async () => {
    const fixture = await createWorkspaceFixture();
    const snapshot = await createGrant(fixture, {
      mode: "snapshot",
      sourceRevision: 2,
      label: "snapshot"
    });
    const snapshotRepresentation = await materialize(fixture, snapshot, {
      label: "snapshot"
    });
    expect(snapshotRepresentation.sourceRevision).toBe(2);
    await expect(
      materialize(fixture, snapshot, {
        sourceRevision: 3,
        label: "snapshot-next"
      })
    ).rejects.toThrow(
      "Snapshot consent requires the exact consented preview revision"
    );

    const continuous = await createGrant(fixture, {
      mode: "continuous",
      sourceRevision: 2,
      label: "continuous"
    });
    await materialize(fixture, continuous, { label: "continuous" });
    const future = await materializeWithPreview(fixture, continuous, {
      sourceRevision: 4,
      label: "continuous-next"
    });
    expect(future.representation.sourceRevision).toBe(4);
    const rows = await pool.query<{ source_revision: string; state: string }>(
      `select source_revision::text, state
       from team_memory_representations
       where share_grant_id = $1 order by source_revision`,
      [continuous.shareGrantId]
    );
    expect(rows.rows).toEqual([
      { source_revision: "2", state: "available" },
      { source_revision: "4", state: "available" }
    ]);
    const read = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: continuous.shareGrantId }
    );
    expect(read?.representation.sourceRevision).toBe(4);
    expect(read?.items.map((item) => item.content)).toEqual(
      future.preview.items.map((item) => item.content)
    );
  });

  it("automatically advances only active continuous grants after target sync", async () => {
    const fixture = await createWorkspaceFixture();
    const continuous = await createGrant(fixture, {
      mode: "continuous",
      label: "continuous-initial"
    });
    await materialize(fixture, continuous);
    await seedAuthoritativeSourceRevision(
      fixture,
      continuous,
      2,
      "continuous-refreshed"
    );

    await expect(
      repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: continuous.remoteReplicaId,
        sourceRevision: 2
      })
    ).resolves.toEqual({ advanced: 1 });
    await expect(
      repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: continuous.remoteReplicaId,
        sourceRevision: 2
      })
    ).resolves.toEqual({ advanced: 0 });

    const continuousRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: continuous.shareGrantId }
    );
    expect(continuousRead).toMatchObject({
      freshness: "fresh",
      representation: { sourceRevision: 2 }
    });
    expect(JSON.stringify(continuousRead?.items)).toContain(
      "continuous-refreshed"
    );

    const snapshot = await createGrant(fixture, {
      mode: "snapshot",
      label: "snapshot-initial"
    });
    await materialize(fixture, snapshot);
    await seedAuthoritativeSourceRevision(
      fixture,
      snapshot,
      2,
      "snapshot-not-propagated"
    );
    await expect(
      repository.advanceContinuousGrantRepresentations({
        remoteReplicaId: snapshot.remoteReplicaId,
        sourceRevision: 2
      })
    ).resolves.toEqual({ advanced: 0 });
    const snapshotRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: snapshot.shareGrantId }
    );
    expect(snapshotRead?.representation.sourceRevision).toBe(1);
    expect(JSON.stringify(snapshotRead?.items)).not.toContain(
      "snapshot-not-propagated"
    );
  });

  it("keeps only the last authorized revision stale after sync revocation and blocks future propagation", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      mode: "continuous",
      label: "authorized-revision-one"
    });
    await materialize(fixture, grant);

    await seedAuthoritativeSourceRevision(
      fixture,
      grant,
      2,
      "authorized-revision-two"
    );
    const laggingRead = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: grant.shareGrantId }
    );
    expect(laggingRead).toMatchObject({
      freshness: "stale",
      representation: { sourceRevision: 1 }
    });
    expect(JSON.stringify(laggingRead?.items)).toContain(
      "authorized-revision-one"
    );
    expect(JSON.stringify(laggingRead?.items)).not.toContain(
      "authorized-revision-two"
    );
    await expect(
      repository.listWorkspaceGrants(actor(fixture.readerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          representationSourceRevision: 1,
          freshness: "stale"
        })
      ]
    });

    const latest = await materializeWithPreview(fixture, grant, {
      sourceRevision: 2,
      label: "authorized-revision-two"
    });
    expect(latest.representation.sourceRevision).toBe(2);
    const revokedSync =
      await syncRepository.revokeCrossIdentitySyncRelationship(
        {
          userId: fixture.ownerUserId,
          deviceCredentialId: fixture.deviceCredentialId
        },
        {
          syncRelationshipId: grant.syncRelationshipId,
          reason: "owner_disconnected_sync"
        }
      );
    expect(revokedSync).toMatchObject({ state: "revoked", sourceCursor: 2 });

    const stale = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: grant.shareGrantId }
    );
    expect(stale).toMatchObject({
      freshness: "stale",
      representation: { sourceRevision: 2 }
    });
    expect(JSON.stringify(stale?.items)).toContain("authorized-revision-two");

    const beforeRejectedRevision = await pool.query<{
      event_count: string;
      active_cursor: string;
    }>(
      `select
         (select count(*) from sync_event_mappings
           where sync_relationship_id=$1)::text as event_count,
         (select target_processing_cursor::text
            from cross_identity_sync_relationships where id=$1) as active_cursor`,
      [grant.syncRelationshipId]
    );
    await expect(
      seedAuthoritativeSourceRevision(fixture, grant, 3, "must-never-propagate")
    ).rejects.toBeInstanceOf(SyncStateConflictError);
    const afterRejectedRevision = await pool.query<{
      event_count: string;
      active_cursor: string;
      leaked: string;
    }>(
      `select
         (select count(*) from sync_event_mappings
           where sync_relationship_id=$1)::text as event_count,
         (select target_processing_cursor::text
            from cross_identity_sync_relationships where id=$1) as active_cursor,
         (select count(*) from conversation_items
           where metadata::text like '%must-never-propagate%')::text as leaked`,
      [grant.syncRelationshipId]
    );
    expect(afterRejectedRevision.rows[0]).toMatchObject({
      ...beforeRejectedRevision.rows[0],
      leaked: "0"
    });

    const revokedGrant = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_revoked_share",
        authority: authority(fixture)
      }
    );
    expect(revokedGrant.lifecycle).toBe("revoked");
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId
      })
    ).resolves.toBeNull();
  });

  it("restarts at the persisted cursor without duplicate revisions or skipped source items", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 2, "cursor-before-restart");
    expect(source.lastSyncPackage).not.toBeNull();
    expect(source.lastUploadSessionId).not.toBeNull();
    const beforeRestart = await pool.query<Record<string, string>>(
      `select
         (select count(*) from sync_event_mappings
           where sync_relationship_id=$1)::text as event_mappings,
         (select count(*) from sync_summary_node_mappings
           where sync_relationship_id=$1)::text as summary_mappings,
         (select count(*) from memory_events
           where idempotency_key like $2)::text as memory_events,
         (select count(*) from conversation_items
           where idempotency_key like $3)::text as conversation_items`,
      [
        source.syncRelationshipId,
        `sync:${source.syncRelationshipId}:event:%`,
        `sync:${source.syncRelationshipId}:item:%`
      ]
    );

    syncRepository = createCrossIdentitySyncRepository(pool, {
      ownerPrivateReplicaEnvelopeEncryptionProvider: ownerProvider
    });
    const replay = await syncRepository.applyCapturedSessionSyncPackage({
      relationshipId: source.syncRelationshipId,
      uploadSessionId: source.lastUploadSessionId!,
      package: source.lastSyncPackage!
    });
    expect(replay.eventIds).toEqual([source.seededEvents[0]!.eventId]);
    expect(new Set(replay.summaryNodeIds)).toEqual(
      new Set([source.leaf.nodeId, source.rollup.nodeId])
    );
    const afterRestart = await pool.query<Record<string, string>>(
      `select
         (select count(*) from sync_event_mappings
           where sync_relationship_id=$1)::text as event_mappings,
         (select count(*) from sync_summary_node_mappings
           where sync_relationship_id=$1)::text as summary_mappings,
         (select count(*) from memory_events
           where idempotency_key like $2)::text as memory_events,
         (select count(*) from conversation_items
           where idempotency_key like $3)::text as conversation_items`,
      [
        source.syncRelationshipId,
        `sync:${source.syncRelationshipId}:event:%`,
        `sync:${source.syncRelationshipId}:item:%`
      ]
    );
    expect(afterRestart.rows[0]).toEqual(beforeRestart.rows[0]);

    await seedAuthoritativeSourceRevision(
      fixture,
      source,
      3,
      "cursor-after-restart"
    );
    await putOwnerPolicy(fixture, source);
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events"
    );
    expect(preview.sourceRevision).toBe(3);
    expect(preview.items.map((item) => item.content)).toEqual([
      { text: "cursor-after-restart user source" },
      { text: "cursor-after-restart assistant source" }
    ]);
    const persistedCursor = await pool.query<{
      target_processing_cursor: string;
      package_sequence: string;
      mapping_count: string;
      active_mapping_count: string;
      active_mapping_cursor: string;
    }>(
      `select relationship.target_processing_cursor::text,
              relationship.package_sequence::text,
              (select count(*) from sync_event_mappings
                where sync_relationship_id=relationship.id)::text as mapping_count,
              (select count(*) from sync_event_mappings
                where sync_relationship_id=relationship.id and active=true)::text
                as active_mapping_count,
              (select source_cursor::text from sync_event_mappings
                where sync_relationship_id=relationship.id and active=true)
                as active_mapping_cursor
         from cross_identity_sync_relationships relationship
        where relationship.id=$1`,
      [source.syncRelationshipId]
    );
    expect(persistedCursor.rows[0]).toEqual({
      target_processing_cursor: "3",
      package_sequence: "2",
      mapping_count: "2",
      active_mapping_count: "1",
      active_mapping_cursor: "3"
    });
  });

  it("lists and reads active Memory Event, leaf, and rollup timelines from encrypted storage", async () => {
    const fixture = await createWorkspaceFixture();
    const grants = await Promise.all(
      allRepresentations.map((representation) =>
        createGrant(fixture, {
          representation,
          label: `timeline-${representation}`
        })
      )
    );
    for (const grant of grants) {
      await materialize(fixture, grant, {
        label: `timeline-${grant.representation}`
      });
    }
    const index = await repository.listWorkspaceGrants(
      actor(fixture.readerUserId),
      {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      }
    );
    expect(index.hasMore).toBe(false);
    expect(index.entries).toHaveLength(3);
    expect(
      new Set(index.entries.map((entry) => entry.activeRepresentation))
    ).toEqual(new Set(allRepresentations));

    const ownerDecryptsBeforeReads = ownerDecryptSpy.mock.calls.length;
    for (const grant of grants) {
      const read = await repository.readGrantRepresentation(
        actor(fixture.readerUserId),
        {
          shareGrantId: grant.shareGrantId,
          representation: grant.representation
        }
      );
      expect(read).toMatchObject({
        freshness: "fresh",
        representation: {
          representation: grant.representation,
          state: "available",
          sourceRevision: grant.currentRevision
        },
        companionScope: {
          kind: "shared_session_discussion",
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.teamWorkspaceId,
          logicalMemoryId: grant.logicalMemoryId,
          shareGrantId: grant.shareGrantId
        }
      });
      expect(read?.items.map((item) => item.itemType)).toEqual(
        grant.preview.items.map((item) => item.itemType)
      );
      expect(read?.items.map((item) => item.occurredAt)).toEqual(
        grant.preview.items.map((item) => item.occurredAt)
      );
      expect(read?.sourcePage).toEqual({
        itemOffset: 0,
        itemCount: grant.preview.items.length
      });
      const newest = await repository.readGrantRepresentation(
        actor(fixture.readerUserId),
        {
          shareGrantId: grant.shareGrantId,
          representation: grant.representation,
          page: { direction: "older", limit: 1 }
        }
      );
      expect(newest?.sourcePage).toEqual({
        itemOffset: grant.preview.items.length - 1,
        itemCount: grant.preview.items.length
      });
      expect(newest?.items.map((item) => item.itemType)).toEqual([
        grant.preview.items.at(-1)!.itemType
      ]);
    }
    expect(ownerDecryptSpy).toHaveBeenCalledTimes(ownerDecryptsBeforeReads);
    const stored = await pool.query<{
      id: string;
      share_grant_id: string;
      stored: string;
      ciphertext: string;
      aad: Record<string, string>;
    }>(
      `select c.id, c.share_grant_id, row_to_json(c)::text as stored,
              c.ciphertext, c.aad
       from team_memory_representation_chunks c
       where c.share_grant_id = any($1::uuid[])`,
      [grants.map((grant) => grant.shareGrantId)]
    );
    expect(stored.rows).toHaveLength(3);
    for (const row of stored.rows) {
      expect(row.stored).not.toContain("timeline-");
      expect(row.ciphertext).not.toContain("source summary");
      expect(row.ciphertext).not.toContain("assistant source");
      expect(row.aad.chunkFormatVersion).toBe("1");
    }

    await pool.query(
      `update team_memory_representation_chunks
          set aad=jsonb_set(aad, '{chunkFormatVersion}', '"2"'::jsonb)
        where id=$1`,
      [stored.rows[0]!.id]
    );
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: stored.rows[0]!.share_grant_id
      })
    ).rejects.toBeInstanceOf(SharedMemoryConflictError);
  });

  it("preserves exact rollup fidelity and policy provenance through owner-private sync and Team materialization", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "lcm_rollups",
      label: "rollup-fidelity"
    });
    expect(grant.preview.items).toEqual([
      {
        itemType: "lcm_rollup",
        schemaVersion: 1,
        sourceId: grant.rollup.nodeId,
        sourceLogicalMemoryId: grant.logicalMemoryId,
        sourceRevision: 1,
        occurredAt: occurredAtFor(13),
        content: {
          title: "rollup-fidelity rollup",
          summaryText: "rollup-fidelity synthesized rollup summary",
          sourceIds: grant.rollup.sourceEventIds
        }
      }
    ]);
    const representation = await materialize(fixture, grant);
    const read = await repository.readGrantRepresentation(
      actor(fixture.readerUserId),
      { shareGrantId: grant.shareGrantId, representation: "lcm_rollups" }
    );
    expect(read?.items).toEqual([
      {
        ...grant.preview.items[0],
        sourceId: sharedMemoryGrantScopedSourceId(
          grant.shareGrantId,
          grant.rollup.nodeId
        ),
        content: {
          ...grant.preview.items[0]!.content,
          sourceIds: grant.rollup.sourceEventIds.map((sourceId) =>
            sharedMemoryGrantScopedSourceId(grant.shareGrantId, sourceId)
          )
        }
      }
    ]);
    expect(representation.provenanceHash).toBe(
      crossIdentitySyncDigest({
        shareGrantId: read!.grant.id,
        consentId: read!.grant.consentId,
        logicalMemoryId: read!.grant.logicalMemoryId,
        representation: "lcm_rollups",
        binding: grant.preview.binding,
        redactedContentHash: grant.preview.redactedContentHash,
        sourceOwnerPolicyId: read!.grant.sourceOwnerPolicyId,
        sourceOwnerPolicyVersion: read!.grant.sourceOwnerPolicyVersion,
        teamPolicyId: read!.grant.teamPolicyId,
        teamPolicyVersion: read!.grant.teamPolicyVersion,
        workspacePolicyId: read!.grant.workspacePolicyId,
        workspacePolicyVersion: read!.grant.workspacePolicyVersion
      })
    );

    const synchronizedNode = await pool.query<{
      summary_model: string;
      summary_prompt_version: string;
      lcm_algorithm_version: string;
      summary_structured_schema_version: string;
      source_event_count: number;
    }>(
      `select summary_model,summary_prompt_version,lcm_algorithm_version,
              summary_structured_schema_version,source_event_count
         from memory_nodes where id=$1`,
      [grant.rollup.nodeId]
    );
    expect(synchronizedNode.rows[0]).toEqual({
      summary_model: "test-lcm-model",
      summary_prompt_version: "shared-memory-test-v1",
      lcm_algorithm_version: "depth1-child-rollup-v1",
      summary_structured_schema_version: LCM_SUMMARY_SCHEMA_VERSION,
      source_event_count: 1
    });
    const artifact = await pool.query<{
      source_cursor: string;
      package_sequence: string;
      representation_policy_revision: number;
      representation_policy_hash: string;
      content_policy_version: number;
      content_policy_hash: string;
      classifier_version: number;
      classifier_hash: string;
      structural: string;
    }>(
      `select source_cursor::text,package_sequence::text,
              representation_policy_revision,representation_policy_hash,
              content_policy_version,content_policy_hash,
              classifier_version,classifier_hash,
              row_to_json(shared_source_artifacts)::text as structural
         from shared_source_artifacts where id=$1`,
      [grant.preview.artifactId]
    );
    expect(artifact.rows[0]).toMatchObject({
      source_cursor: "1",
      package_sequence: "1",
      representation_policy_revision:
        grant.preview.binding.representationPolicyRevision,
      representation_policy_hash:
        grant.preview.binding.representationPolicyHash,
      content_policy_version: grant.preview.binding.contentPolicyVersion,
      content_policy_hash: grant.preview.binding.contentPolicyHash,
      classifier_version: grant.preview.binding.classifierVersion,
      classifier_hash: grant.preview.binding.classifierHash
    });
    expect(artifact.rows[0]?.structural).not.toContain(
      "rollup-fidelity synthesized"
    );
    const ownerEncryptedArtifact = await pool.query<{
      visibility: string;
      encryption_scope: string;
      owner_principal_id: string;
      ciphertext: string;
    }>(
      `select visibility,encryption_scope,owner_principal_id,ciphertext
         from encrypted_field_payloads
        where source_table='shared_source_artifacts'
          and source_id=$1 and invalidated_at is null`,
      [grant.preview.artifactId]
    );
    expect(ownerEncryptedArtifact.rows).toHaveLength(1);
    expect(ownerEncryptedArtifact.rows[0]).toMatchObject({
      visibility: "personal",
      encryption_scope: "owner_private_replica",
      owner_principal_id: grant.ownerPrincipalId
    });
    expect(ownerEncryptedArtifact.rows[0]?.ciphertext).not.toContain(
      "rollup-fidelity"
    );
    const teamChunk = await pool.query<{
      key_id: string;
      aad: Record<string, string | number>;
    }>(
      `select key_id,aad from team_memory_representation_chunks
        where representation_id=$1 and chunk_index=0`,
      [representation.id]
    );
    expect(teamChunk.rows[0]?.key_id).toBe(provider.keyId);
    expect(teamChunk.rows[0]?.key_id).not.toBe(ownerProvider.keyId);
    expect(teamChunk.rows[0]?.aad).toMatchObject({
      representationId: representation.id,
      shareGrantId: grant.shareGrantId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.teamWorkspaceId,
      logicalMemoryId: grant.logicalMemoryId,
      consentId: grant.consentId,
      representation: "lcm_rollups",
      sourceRevision: String(grant.preview.binding.sourceRevision),
      sourceHash: grant.preview.binding.sourceHash,
      representationPolicyRevision: String(
        grant.preview.binding.representationPolicyRevision
      ),
      representationPolicyHash: grant.preview.binding.representationPolicyHash,
      contentPolicyVersion: String(grant.preview.binding.contentPolicyVersion),
      contentPolicyHash: grant.preview.binding.contentPolicyHash,
      classifierVersion: String(grant.preview.binding.classifierVersion),
      classifierHash: grant.preview.binding.classifierHash,
      redactedContentHash: grant.preview.redactedContentHash,
      provenanceHash: representation.provenanceHash
    });
  });

  it("shares one canonical owner-private replica independently into two Teams without cross-grant correlation", async () => {
    const first = await createWorkspaceFixture();
    const secondReaderUserId = await createUser("Second Team Reader");
    const secondTeam = await pool.query<{ id: string }>(
      "insert into teams (name) values ($1) returning id",
      [`Second Shared Memory Team ${randomUUID()}`]
    );
    const secondTeamId = secondTeam.rows[0]!.id;
    const secondWorkspace = await pool.query<{ id: string }>(
      `insert into team_workspaces (team_id,name)
       values ($1,$2) returning id`,
      [secondTeamId, `Second Shared Memory Workspace ${randomUUID()}`]
    );
    const secondTeamWorkspaceId = secondWorkspace.rows[0]!.id;
    const secondRetentionPolicyId = randomUUID();
    const secondRetentionEffectiveAt = new Date("2020-01-01T00:00:00.000Z");
    await pool.query(
      `insert into retention_policies (
         policy_id, version, scope, team_id, retention_seconds,
         deletion_grace_seconds, backup_retention_seconds, policy_hash,
         created_by_user_id, effective_at
       ) values ($1,1,'team',$2,2592000,0,2592000,$3,$4,$5)`,
      [
        secondRetentionPolicyId,
        secondTeamId,
        crossIdentitySyncDigest({
          policyId: secondRetentionPolicyId,
          version: 1,
          target: { scope: "team", teamId: secondTeamId },
          retentionSeconds: 2_592_000,
          deletionGraceSeconds: 0,
          backupRetentionSeconds: 2_592_000,
          effectiveAt: secondRetentionEffectiveAt.toISOString()
        }),
        first.ownerUserId,
        secondRetentionEffectiveAt
      ]
    );
    await pool.query(
      `insert into team_memberships
         (team_id,user_id,role,status,accepted_at)
       values ($1,$2,'owner','enabled',now()),
              ($1,$3,'member','enabled',now())`,
      [secondTeamId, first.ownerUserId, secondReaderUserId]
    );
    await pool.query(
      `insert into team_workspace_access_grants
         (team_workspace_id,team_id,user_id,access,
          can_share_owned_memory,granted_by_user_id)
       values ($1,$2,$3,'write',true,$3),
              ($1,$2,$4,'read',false,$3)`,
      [
        secondTeamWorkspaceId,
        secondTeamId,
        first.ownerUserId,
        secondReaderUserId
      ]
    );
    const second: WorkspaceFixture = {
      ...first,
      readerUserId: secondReaderUserId,
      teamId: secondTeamId,
      teamWorkspaceId: secondTeamWorkspaceId
    };
    await repository.putTeamPolicy(actor(first.ownerUserId), {
      mutationId: randomUUID(),
      teamId: secondTeamId,
      expectedCurrentVersion: 0,
      allowedRepresentations: allRepresentations
    });
    await repository.putWorkspacePolicy(actor(first.ownerUserId), {
      mutationId: randomUUID(),
      teamId: secondTeamId,
      teamWorkspaceId: secondTeamWorkspaceId,
      expectedCurrentVersion: 0,
      allowedRepresentations: allRepresentations
    });

    const source = await createSource(first, 1, "two-team-canonical-source");
    await putOwnerPolicy(first, source);
    const secondTeamProvider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 43).toString("base64")
    );
    repository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: ({ teamId }) =>
        teamId === secondTeamId ? secondTeamProvider : provider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => ownerProvider
    });

    const createDestinationGrant = async (
      destination: WorkspaceFixture,
      label: string
    ): Promise<GrantFixture> => {
      const created = await createConsent(destination, source, {
        representation: "memory_events",
        mode: "continuous",
        label
      });
      const grant = await repository.createShareGrant(
        actor(first.ownerUserId),
        {
          mutationId: randomUUID(),
          logicalGrantId: randomUUID(),
          consentId: created.consentId,
          authority: authority(destination)
        }
      );
      return {
        ...source,
        consentId: created.consentId,
        shareGrantId: grant.id,
        grantVersion: grant.grantVersion,
        representation: "memory_events",
        preview: created.preview
      };
    };
    const firstGrant = await createDestinationGrant(first, "first-team");
    const secondGrant = await createDestinationGrant(second, "second-team");
    const firstRepresentation = await materialize(first, firstGrant);
    const secondRepresentation = await materialize(second, secondGrant);
    expect(firstGrant.remoteReplicaId).toBe(secondGrant.remoteReplicaId);
    expect(firstGrant.shareGrantId).not.toBe(secondGrant.shareGrantId);
    expect(firstRepresentation.id).not.toBe(secondRepresentation.id);

    const firstRead = await repository.readGrantRepresentation(
      actor(first.readerUserId),
      { shareGrantId: firstGrant.shareGrantId }
    );
    const secondRead = await repository.readGrantRepresentation(
      actor(second.readerUserId),
      { shareGrantId: secondGrant.shareGrantId }
    );
    expect(firstRead?.items.map((item) => item.content)).toEqual(
      secondRead?.items.map((item) => item.content)
    );
    expect(firstRead?.items.map((item) => item.sourceId)).not.toEqual(
      secondRead?.items.map((item) => item.sourceId)
    );
    await expect(
      repository.readGrantRepresentation(actor(first.readerUserId), {
        shareGrantId: secondGrant.shareGrantId
      })
    ).resolves.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(second.readerUserId), {
        shareGrantId: firstGrant.shareGrantId
      })
    ).resolves.toBeNull();

    const decryptsBeforeCanonicalGuesses = decryptCount();
    for (const guessedId of [
      source.remoteReplicaId,
      source.logicalMemoryId,
      source.syncRelationshipId
    ]) {
      await expect(
        repository.readGrantRepresentation(actor(first.readerUserId), {
          shareGrantId: guessedId
        })
      ).resolves.toBeNull();
    }
    await expect(
      repository.createAuthoritativeSourcePreview(actor(first.readerUserId), {
        logicalMemoryId: source.logicalMemoryId,
        remoteReplicaId: source.remoteReplicaId,
        teamId: first.teamId,
        teamWorkspaceId: first.teamWorkspaceId,
        representation: "memory_events",
        allowedRepresentations: allRepresentations,
        authority: authority(first)
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
    expect(decryptCount()).toBe(decryptsBeforeCanonicalGuesses);
    const teamEvents = await pool.query<{ event: string }>(
      `select row_to_json(collaboration_outbox)::text as event
         from collaboration_outbox
        where share_grant_id=any($1::uuid[])`,
      [[firstGrant.shareGrantId, secondGrant.shareGrantId]]
    );
    expect(teamEvents.rows.length).toBeGreaterThan(0);
    for (const row of teamEvents.rows) {
      expect(row.event).not.toContain(source.remoteReplicaId);
      expect(row.event).not.toContain(source.syncRelationshipId);
      expect(row.event).not.toContain(source.ownerPrincipalId);
    }
    const teamKeys = await pool.query<{
      share_grant_id: string;
      key_id: string;
    }>(
      `select share_grant_id,key_id
         from team_memory_representation_chunks
        where share_grant_id=any($1::uuid[])
        order by share_grant_id`,
      [[firstGrant.shareGrantId, secondGrant.shareGrantId]]
    );
    expect(new Set(teamKeys.rows.map((row) => row.key_id))).toEqual(
      new Set([provider.keyId, secondTeamProvider.keyId])
    );

    await repository.revokeShareGrant(actor(first.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: firstGrant.shareGrantId,
      expectedGrantVersion: firstGrant.grantVersion,
      reasonCode: "first_team_only",
      authority: authority(first)
    });
    await expect(
      repository.readGrantRepresentation(actor(first.readerUserId), {
        shareGrantId: firstGrant.shareGrantId
      })
    ).resolves.toBeNull();
    await expect(
      repository.readGrantRepresentation(actor(second.readerUserId), {
        shareGrantId: secondGrant.shareGrantId
      })
    ).resolves.toMatchObject({ freshness: "fresh" });
    const canonicalReplica = await pool.query<{
      lifecycle: string;
      disabled_at: Date | null;
      grant_count: string;
    }>(
      `select replica.lifecycle,replica.disabled_at,
              (select count(*) from team_session_share_grants
                where remote_replica_id=replica.id)::text as grant_count
         from memory_replicas replica where replica.id=$1`,
      [source.remoteReplicaId]
    );
    expect(canonicalReplica.rows[0]).toEqual({
      lifecycle: "active",
      disabled_at: null,
      grant_count: "2"
    });
  });

  it("lists current owner grant state even when Team reading is unavailable", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "owner-state" });
    const active = await repository.listOwnerGrants(
      actor(fixture.ownerUserId),
      { logicalMemoryId: grant.logicalMemoryId, limit: 10, offset: 0 }
    );
    expect(active).toMatchObject({
      hasMore: false,
      entries: [
        {
          id: grant.shareGrantId,
          logicalMemoryId: grant.logicalMemoryId,
          lifecycle: "active",
          grantVersion: grant.grantVersion
        }
      ]
    });

    await pool.query(
      `update team_session_share_grants
          set lifecycle='unavailable',grant_version=grant_version+1,updated_at=now()
        where id=$1`,
      [grant.shareGrantId]
    );
    const unavailable = await repository.listOwnerGrants(
      actor(fixture.ownerUserId),
      { logicalMemoryId: grant.logicalMemoryId, limit: 1, offset: 0 }
    );
    expect(unavailable.entries).toMatchObject([
      {
        id: grant.shareGrantId,
        lifecycle: "unavailable",
        grantVersion: grant.grantVersion + 1
      }
    ]);
    await expect(
      repository.listOwnerGrants(actor(fixture.readerUserId), {
        logicalMemoryId: grant.logicalMemoryId,
        limit: 10,
        offset: 0
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
  });

  it("rejects Team materialization when owner-private and Team encryption keys are not distinct", async () => {
    const safeRepository = repository;
    const safeSyncRepository = syncRepository;
    repository = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => provider
    });
    syncRepository = createCrossIdentitySyncRepository(pool, {
      ownerPrivateReplicaEnvelopeEncryptionProvider: provider
    });
    try {
      const fixture = await createWorkspaceFixture();
      const grant = await createGrant(fixture, {
        representation: "memory_events",
        label: "key-boundary"
      });
      const preview = await createPersistedPreview(
        fixture,
        grant,
        grant.representation,
        grant.currentRevision,
        grant.currentLabel
      );
      const decrypts = decryptCount();

      await expect(
        repository.materializeGrantRepresentation(actor(fixture.ownerUserId), {
          mutationId: randomUUID(),
          shareGrantId: grant.shareGrantId,
          consentId: grant.consentId,
          expectedGrantVersion: grant.grantVersion,
          preview
        })
      ).rejects.toThrow(
        "Owner-private replica and Team representations require distinct encryption keys"
      );
      expect(decryptCount()).toBe(decrypts);
    } finally {
      repository = safeRepository;
      syncRepository = safeSyncRepository;
    }
  });

  it("rewraps Team representation DEKs without decrypting or changing ciphertext", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      representation: "memory_events",
      label: "representation-rewrap"
    });
    await materialize(fixture, grant, { label: "representation-rewrap" });
    const before = await pool.query<{
      id: string;
      ciphertext: string;
      wrapped_dek: { version: number };
    }>(
      `select id,ciphertext,wrapped_dek
         from team_memory_representation_chunks
        where share_grant_id=$1`,
      [grant.shareGrantId]
    );
    const decrypts = decryptCount();

    const dryRunRewrap = vi.fn(provider.rewrap!.bind(provider));
    const dryRun = await repository.rewrapTeamRepresentationChunkBatch(
      { ...provider, rewrap: dryRunRewrap },
      { teamId: fixture.teamId, force: true, dryRun: true }
    );
    expect(dryRun).toMatchObject({
      processedRows: before.rows.length,
      rewrappedRows: 0,
      wouldRewrapRows: before.rows.length,
      failedRows: 0,
      done: true
    });
    expect(dryRunRewrap).not.toHaveBeenCalled();
    const afterDryRun = await pool.query<{
      ciphertext: string;
      envelope_reencrypted_at: Date | null;
    }>(
      `select ciphertext,envelope_reencrypted_at
         from team_memory_representation_chunks
        where share_grant_id=$1`,
      [grant.shareGrantId]
    );
    expect(afterDryRun.rows.map((row) => row.ciphertext)).toEqual(
      before.rows.map((row) => row.ciphertext)
    );
    expect(
      afterDryRun.rows.every((row) => row.envelope_reencrypted_at === null)
    ).toBe(true);

    const result = await repository.rewrapTeamRepresentationChunkBatch(
      provider,
      { teamId: fixture.teamId, force: true }
    );

    expect(result).toMatchObject({
      processedRows: before.rows.length,
      rewrappedRows: before.rows.length,
      wouldRewrapRows: 0,
      failedRows: 0,
      done: true
    });
    expect(decryptCount()).toBe(decrypts);
    const after = await pool.query<{
      id: string;
      ciphertext: string;
      wrapped_dek: { version: number };
      envelope_reencrypted_at: Date | null;
    }>(
      `select id,ciphertext,wrapped_dek,envelope_reencrypted_at
         from team_memory_representation_chunks
        where share_grant_id=$1`,
      [grant.shareGrantId]
    );
    expect(after.rows.map((row) => row.ciphertext)).toEqual(
      before.rows.map((row) => row.ciphertext)
    );
    expect(
      after.rows.every((row) => row.envelope_reencrypted_at !== null)
    ).toBe(true);
    expect(after.rows.map((row) => row.wrapped_dek.version)).toEqual(
      before.rows.map((row) => row.wrapped_dek.version + 1)
    );
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId
      })
    ).not.toBeNull();
  });

  it("fails closed on every current access gate before resolving a decrypt key", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "authorization" });
    await materialize(fixture, grant, { label: "authorization" });
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId
      })
    ).not.toBeNull();

    const assertDeniedBeforeDecrypt = async (
      deny: () => Promise<unknown>,
      restore: () => Promise<unknown>,
      listRejects = false
    ): Promise<void> => {
      await deny();
      const decrypts = decryptCount();
      expect(
        await repository.readGrantRepresentation(actor(fixture.readerUserId), {
          shareGrantId: grant.shareGrantId
        })
      ).toBeNull();
      if (listRejects) {
        await expect(
          repository.listWorkspaceGrants(actor(fixture.readerUserId), {
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId,
            limit: 10,
            offset: 0
          })
        ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);
      } else {
        const page = await repository.listWorkspaceGrants(
          actor(fixture.readerUserId),
          {
            teamId: fixture.teamId,
            teamWorkspaceId: fixture.teamWorkspaceId,
            limit: 10,
            offset: 0
          }
        );
        expect(page.entries).toEqual([]);
      }
      expect(decryptCount()).toBe(decrypts);
      await restore();
    };

    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update team_session_share_grants
           set lifecycle = 'revoked', revoked_at = now(),
               revoked_by_user_id = $2, revocation_reason = 'matrix'
           where id = $1`,
          [grant.shareGrantId, fixture.ownerUserId]
        ),
      () =>
        pool.query(
          `update team_session_share_grants
           set lifecycle = 'active', revoked_at = null,
               revoked_by_user_id = null, revocation_reason = null
           where id = $1`,
          [grant.shareGrantId]
        )
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update team_workspaces
           set lifecycle = 'archived', archived_at = now() where id = $1`,
          [fixture.teamWorkspaceId]
        ),
      () =>
        pool.query(
          `update team_workspaces
           set lifecycle = 'active', archived_at = null where id = $1`,
          [fixture.teamWorkspaceId]
        ),
      true
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update team_memberships
           set status = 'disabled', disabled_at = now()
           where team_id = $1 and user_id = $2`,
          [fixture.teamId, fixture.readerUserId]
        ),
      () =>
        pool.query(
          `update team_memberships
           set status = 'enabled', disabled_at = null
           where team_id = $1 and user_id = $2`,
          [fixture.teamId, fixture.readerUserId]
        ),
      true
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update teams set lifecycle = 'suspended', suspended_at = now()
           where id = $1`,
          [fixture.teamId]
        ),
      () =>
        pool.query(
          `update teams set lifecycle = 'active', suspended_at = null
           where id = $1`,
          [fixture.teamId]
        ),
      true
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update source_owner_representation_consents
           set state = 'revoked', revoked_at = now() where id = $1`,
          [grant.consentId]
        ),
      () =>
        pool.query(
          `update source_owner_representation_consents
           set state = 'active', revoked_at = null where id = $1`,
          [grant.consentId]
        )
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update memory_replicas set disabled_at = now(),
             disabled_reason = 'matrix' where id = $1`,
          [grant.remoteReplicaId]
        ),
      () =>
        pool.query(
          `update memory_replicas set disabled_at = null,
             disabled_reason = null where id = $1`,
          [grant.remoteReplicaId]
        )
    );
    await pool.query(
      `update cross_identity_sync_relationships
       set state = 'revoked', revoked_at = now(),
           revoked_by_user_id = $2, revocation_reason = 'matrix'
       where local_replica_id = $1`,
      [grant.remoteReplicaId, fixture.ownerUserId]
    );
    await expect(
      repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId
      })
    ).resolves.toMatchObject({ freshness: "stale" });
    await expect(
      repository.listWorkspaceGrants(actor(fixture.readerUserId), {
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        limit: 10,
        offset: 0
      })
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ freshness: "stale" })]
    });
    await pool.query(
      `update cross_identity_sync_relationships
       set state = 'ready', revoked_at = null,
           revoked_by_user_id = null, revocation_reason = null
       where local_replica_id = $1`,
      [grant.remoteReplicaId]
    );
    await assertDeniedBeforeDecrypt(
      () =>
        pool.query(
          `update team_workspace_access_grants
           set access = 'disabled', disabled_at = now(),
               disabled_reason = 'withdrawn'
           where team_workspace_id = $1 and user_id = $2`,
          [fixture.teamWorkspaceId, fixture.readerUserId]
        ),
      () =>
        pool.query(
          `update team_workspace_access_grants
           set access = 'read', disabled_at = null, disabled_reason = null
           where team_workspace_id = $1 and user_id = $2`,
          [fixture.teamWorkspaceId, fixture.readerUserId]
        ),
      true
    );
    const decrypts = decryptCount();
    expect(
      await repository.readGrantRepresentation(actor(fixture.outsiderUserId), {
        shareGrantId: grant.shareGrantId
      })
    ).toBeNull();
    expect(decryptCount()).toBe(decrypts);
  });

  it("withdraws new share authority without mutating existing grants or blocking owner revocation", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "share-authority" });
    await materialize(fixture, grant, { label: "share-authority" });
    const replacement = await createConsent(fixture, grant, {
      representation: "lcm_leaves",
      mode: "continuous",
      label: "share-authority-replacement"
    });
    const stateBeforeWithdrawal = await pool.query<{
      lifecycle: string;
      sync_state: string;
    }>(
      `select g.lifecycle, s.state as sync_state
         from team_session_share_grants g
         join cross_identity_sync_relationships s
           on s.local_replica_id = g.remote_replica_id and s.side = 'target'
        where g.id = $1`,
      [grant.shareGrantId]
    );

    await pool.query(
      `update team_workspace_access_grants
          set can_share_owned_memory = false, version = version + 1,
              updated_at = now()
        where team_workspace_id = $1 and user_id = $2`,
      [fixture.teamWorkspaceId, fixture.ownerUserId]
    );

    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId
      })
    ).not.toBeNull();
    const existing = await pool.query<{
      lifecycle: string;
      sync_state: string;
    }>(
      `select g.lifecycle, s.state as sync_state
         from team_session_share_grants g
         join cross_identity_sync_relationships s
           on s.local_replica_id = g.remote_replica_id and s.side = 'target'
        where g.id = $1`,
      [grant.shareGrantId]
    );
    expect(existing.rows[0]).toEqual(stateBeforeWithdrawal.rows[0]);
    expect(existing.rows[0]?.lifecycle).toBe("active");

    await expect(
      repository.selectGrantRepresentation(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: replacement.consentId,
        representation: "lcm_leaves",
        expectedGrantVersion: grant.grantVersion,
        authority: authority(fixture)
      })
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    const anotherSource = await createSource(fixture, 1, "new-share-denied");
    await putOwnerPolicy(fixture, anotherSource);
    await expect(
      createPersistedPreview(
        fixture,
        anotherSource,
        "memory_events",
        1,
        "new-share-denied"
      )
    ).rejects.toBeInstanceOf(SharedMemoryAuthorizationError);

    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_withdrawal",
        authority: authority(fixture)
      }
    );
    expect(revoked.lifecycle).toBe("revoked");
  });

  it("evaluates every effective Team, Workspace, and Share Grant retention policy and uses the longest deadline", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "retention-precedence" });
    const representation = await materialize(fixture, grant);
    const companion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: `retention-precedence:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      }
    );
    const effectiveAt = new Date("2020-01-02T00:00:00.000Z");
    const teamPolicy = await pool.query<{ policy_id: string }>(
      `select policy_id from retention_policies
        where scope = 'team' and team_id = $1 and superseded_at is null`,
      [fixture.teamId]
    );
    const workspacePolicy = await retentionRepository.createPolicy({
      target: {
        scope: "workspace",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId
      },
      retentionSeconds: 3_000_000,
      deletionGraceSeconds: 200_000,
      backupRetentionSeconds: 0,
      effectiveAt,
      createdByUserId: fixture.ownerUserId
    });
    const grantPolicy = await retentionRepository.createPolicy({
      target: {
        scope: "share_grant",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: grant.shareGrantId,
        logicalMemoryId: grant.logicalMemoryId
      },
      retentionSeconds: 3_100_000,
      deletionGraceSeconds: 50_000,
      backupRetentionSeconds: 0,
      effectiveAt,
      createdByUserId: fixture.ownerUserId
    });

    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: grant.shareGrantId,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "retention_precedence",
      authority: authority(fixture)
    });
    const snapshot = await pool.query<{
      policy_id: string;
      triggered_at: Date;
      retain_until: Date;
      grant_retain_until: Date;
      representation_retain_until: Date;
      companion_retain_until: Date;
      metadata: {
        evaluatedPolicies: Array<{
          policyId: string;
          scope: string;
          retainUntil: string;
        }>;
      };
    }>(
      `select decision.policy_id, decision.triggered_at, decision.retain_until,
              grant_row.retain_until as grant_retain_until,
              representation.retain_until as representation_retain_until,
              companion.retain_until as companion_retain_until,
              audit.metadata
         from team_session_share_grants grant_row
         join retention_decisions decision
           on decision.id = grant_row.active_retention_decision_id
         join team_memory_representations representation
           on representation.id = $2
         join collaboration_threads companion on companion.id = $3
         join audit_events audit
           on audit.action = 'share_grant.retention_started'
          and audit.target_id = grant_row.id
          and audit.metadata ->> 'retentionDecisionId' = decision.id::text
        where grant_row.id = $1`,
      [grant.shareGrantId, representation.id, companion!.id]
    );
    const row = snapshot.rows[0]!;
    expect(row.policy_id).toBe(workspacePolicy.policyId);
    expect(row.retain_until.getTime() - row.triggered_at.getTime()).toBe(
      3_200_000_000
    );
    expect(row.grant_retain_until).toEqual(row.retain_until);
    expect(row.representation_retain_until).toEqual(row.retain_until);
    expect(row.companion_retain_until).toEqual(row.retain_until);
    expect(row.metadata.evaluatedPolicies).toEqual([
      expect.objectContaining({
        policyId: workspacePolicy.policyId,
        scope: "workspace",
        retainUntil: row.retain_until.toISOString()
      }),
      expect.objectContaining({
        policyId: grantPolicy.policyId,
        scope: "share_grant",
        retainUntil: new Date(
          row.triggered_at.getTime() + 3_150_000_000
        ).toISOString()
      }),
      expect.objectContaining({
        policyId: teamPolicy.rows[0]!.policy_id,
        scope: "team",
        retainUntil: new Date(
          row.triggered_at.getTime() + 2_592_000_000
        ).toISOString()
      })
    ]);
  });

  it("serializes concurrent exact Share Grant revocation retries into one retention epoch", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "concurrent-revoke" });
    await materialize(fixture, grant);
    const input = {
      mutationId: randomUUID(),
      shareGrantId: grant.shareGrantId,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "concurrent_exact_retry",
      authority: authority(fixture)
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        repository.revokeShareGrant(actor(fixture.ownerUserId), input)
      )
    );
    expect(new Set(results.map((result) => result.grantVersion))).toEqual(
      new Set([grant.grantVersion + 1])
    );
    await expect(
      pool.query(
        `select grant_row.lifecycle, grant_row.revocation_epoch::text,
                (select count(*)::text from retention_decisions decision
                  where decision.share_grant_id = grant_row.id
                    and decision.trigger = 'share_revoked') as decisions,
                (select count(*)::text from purge_jobs job
                  where job.share_grant_id = grant_row.id) as jobs,
                (select count(*)::text from purge_job_evidence evidence
                  join purge_jobs job on job.id = evidence.purge_job_id
                  where job.share_grant_id = grant_row.id) as evidence
           from team_session_share_grants grant_row where grant_row.id = $1`,
        [grant.shareGrantId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          lifecycle: "revoked",
          revocation_epoch: "1",
          decisions: "1",
          jobs: "1",
          evidence: "7"
        }
      ]
    });
  });

  it("rolls back Share Grant revocation when retention scheduling cannot resolve a policy", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "revoke-rollback" });
    await materialize(fixture, grant);
    await pool.query("delete from retention_policies where team_id = $1", [
      fixture.teamId
    ]);
    await expect(
      repository.revokeShareGrant(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "missing_retention_policy",
        authority: authority(fixture)
      })
    ).rejects.toThrow(
      "No retention policy was effective for the Share Grant at revocation time"
    );
    await expect(
      pool.query(
        `select grant_row.lifecycle, grant_row.grant_version,
                grant_row.revocation_epoch::text,
                representation.state,
                (select count(*)::text from retention_decisions decision
                  where decision.share_grant_id = grant_row.id) as decisions,
                (select count(*)::text from purge_jobs job
                  where job.share_grant_id = grant_row.id) as jobs
           from team_session_share_grants grant_row
           join team_memory_representations representation
             on representation.share_grant_id = grant_row.id
          where grant_row.id = $1`,
        [grant.shareGrantId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          lifecycle: "active",
          grant_version: grant.grantVersion,
          revocation_epoch: "0",
          state: "available",
          decisions: "0",
          jobs: "0"
        }
      ]
    });
  });

  it("creates one companion discussion concurrently and derives access from the live grant", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "companion" });
    const initialRepresentation = await materialize(fixture, grant);
    const create = (idempotencyKey: string) =>
      collaboration.createThread(actor(fixture.ownerUserId), {
        kind: "shared_session_discussion",
        idempotencyKey,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      });
    const discussions = await Promise.all([
      create("companion-first"),
      create("companion-second"),
      create("companion-first")
    ]);
    expect(new Set(discussions.map((thread) => thread?.id)).size).toBe(1);
    const discussion = discussions[0]!;
    const storedThreads = await pool.query<{ count: string }>(
      `select count(*)::text as count from collaboration_threads
       where kind = 'shared_session_discussion'
         and team_workspace_id = $1 and shared_logical_memory_id = $2`,
      [fixture.teamWorkspaceId, grant.logicalMemoryId]
    );
    expect(storedThreads.rows[0]?.count).toBe("1");

    const discussionText = `companion-only-${randomUUID()}`;
    const pipelineCountsBefore = await readMemoryPipelineCounts();
    await collaboration.sendMessage(actor(fixture.ownerUserId), {
      threadId: discussion.id,
      idempotencyKey: "companion-message",
      bodyText: discussionText,
      metadata: { channel: "discussion" }
    });
    const readerPage = await collaboration.listMessages(
      actor(fixture.readerUserId),
      { threadId: discussion.id, limit: 20 }
    );
    expect(readerPage?.messages[0]?.bodyText).toBe(discussionText);

    expect(await readMemoryPipelineCounts()).toEqual(pipelineCountsBefore);
    const encryptedMessage = await pool.query<{
      structural: string;
      encrypted: string;
    }>(
      `select row_to_json(cm)::text as structural,
              string_agg(efp.ciphertext, '') as encrypted
       from collaboration_messages cm
       join encrypted_field_payloads efp
         on efp.source_table = 'collaboration_messages'
        and efp.source_id = cm.id and efp.invalidated_at is null
       where cm.thread_id = $1
       group by cm.id`,
      [discussion.id]
    );
    expect(encryptedMessage.rows[0]?.structural).not.toContain(discussionText);
    expect(encryptedMessage.rows[0]?.encrypted).not.toContain(discussionText);

    const firstRevocationMutationId = randomUUID();
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: firstRevocationMutationId,
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_revoked",
        authority: authority(fixture)
      }
    );
    const scheduledRetention = await pool.query<{
      grant_epoch: string;
      active_decision_id: string | null;
      active_job_id: string | null;
      trigger_epoch: string;
      target_epoch: string;
      job_state: string;
      evidence_count: string;
    }>(
      `select g.revocation_epoch::text as grant_epoch,
              g.active_retention_decision_id as active_decision_id,
              g.active_purge_job_id as active_job_id,
              decision.trigger_epoch::text as trigger_epoch,
              job.target_epoch::text as target_epoch,
              job.state as job_state,
              (select count(*)::text from purge_job_evidence evidence
                where evidence.purge_job_id = job.id) as evidence_count
         from team_session_share_grants g
         join retention_decisions decision
           on decision.id = g.active_retention_decision_id
         join purge_jobs job on job.id = g.active_purge_job_id
        where g.id = $1`,
      [grant.shareGrantId]
    );
    expect(scheduledRetention.rows[0]).toMatchObject({
      grant_epoch: "1",
      trigger_epoch: "1",
      target_epoch: "1",
      job_state: "pending",
      evidence_count: "7"
    });
    expect(scheduledRetention.rows[0]?.active_decision_id).toBeTruthy();
    expect(scheduledRetention.rows[0]?.active_job_id).toBeTruthy();
    const decryptsBeforeDeniedHistory = decryptCount();
    expect(
      await collaboration.listMessages(actor(fixture.readerUserId), {
        threadId: discussion.id,
        limit: 20
      })
    ).toBeNull();
    expect(decryptCount()).toBe(decryptsBeforeDeniedHistory);

    const restoredConsent = await createConsent(fixture, grant, {
      representation: grant.representation,
      mode: "continuous",
      label: "companion-restored"
    });
    const restored = await repository.selectGrantRepresentation(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: restoredConsent.consentId,
        representation: grant.representation,
        expectedGrantVersion: revoked.grantVersion,
        authority: authority(fixture)
      }
    );
    const canceledRetention = await pool.query<{
      grant_decision_id: string | null;
      grant_job_id: string | null;
      job_state: string;
      canceled_at: Date | null;
      cancellation_reason_code: string | null;
      immutable_decisions: string;
      immutable_evidence: string;
    }>(
      `select g.active_retention_decision_id as grant_decision_id,
              g.active_purge_job_id as grant_job_id,
              job.state as job_state, job.canceled_at,
              job.cancellation_reason_code,
              (select count(*)::text from retention_decisions decision
                where decision.share_grant_id = g.id
                  and decision.trigger = 'share_revoked') as immutable_decisions,
              (select count(*)::text from purge_job_evidence evidence
                where evidence.purge_job_id = job.id) as immutable_evidence
         from team_session_share_grants g
         join purge_jobs job
           on job.id = $2
        where g.id = $1`,
      [grant.shareGrantId, scheduledRetention.rows[0]!.active_job_id]
    );
    expect(canceledRetention.rows[0]).toMatchObject({
      grant_decision_id: null,
      grant_job_id: null,
      job_state: "canceled",
      cancellation_reason_code: "restored_before_purge",
      immutable_decisions: "1",
      immutable_evidence: "7"
    });
    expect(canceledRetention.rows[0]?.canceled_at).toBeInstanceOf(Date);
    const restoredRepresentation =
      await repository.materializeGrantRepresentation(
        actor(fixture.ownerUserId),
        {
          mutationId: randomUUID(),
          shareGrantId: grant.shareGrantId,
          consentId: restoredConsent.consentId,
          expectedGrantVersion: restored.grantVersion,
          expectedRepresentationVersion:
            initialRepresentation.recordVersion + 1,
          preview: restoredConsent.preview
        }
      );
    expect(restoredRepresentation.id).toBe(initialRepresentation.id);
    expect(restoredRepresentation.state).toBe("available");
    expect(
      await repository.readGrantRepresentation(actor(fixture.readerUserId), {
        shareGrantId: grant.shareGrantId
      })
    ).not.toBeNull();
    const restoredPage = await collaboration.listMessages(
      actor(fixture.readerUserId),
      { threadId: discussion.id, limit: 20 }
    );
    expect(restoredPage?.messages[0]?.bodyText).toBe(discussionText);

    await expect(
      repository.revokeShareGrant(actor(fixture.ownerUserId), {
        mutationId: firstRevocationMutationId,
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: restored.grantVersion,
        reasonCode: "owner_revoked_again",
        authority: authority(fixture)
      })
    ).rejects.toThrow("Share Grant revocation mutation was already used");

    const revokedAgain = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: restored.grantVersion,
        reasonCode: "owner_revoked_again",
        authority: authority(fixture)
      }
    );
    expect(revokedAgain.lifecycle).toBe("revoked");
    const retentionHistory = await pool.query<{
      decision_id: string;
      job_id: string;
      trigger_epoch: string;
      target_epoch: string;
      job_state: string;
      evidence_count: string;
      active_decision_id: string;
      active_job_id: string;
      grant_epoch: string;
    }>(
      `select decision.id as decision_id, job.id as job_id,
              decision.trigger_epoch::text, job.target_epoch::text,
              job.state as job_state,
              count(evidence.id)::text as evidence_count,
              grant_row.active_retention_decision_id as active_decision_id,
              grant_row.active_purge_job_id as active_job_id,
              grant_row.revocation_epoch::text as grant_epoch
         from retention_decisions decision
         join purge_jobs job on job.retention_decision_id = decision.id
         join purge_job_evidence evidence on evidence.purge_job_id = job.id
         join team_session_share_grants grant_row
           on grant_row.id = decision.share_grant_id
        where decision.share_grant_id = $1
          and decision.trigger = 'share_revoked'
        group by decision.id, job.id, grant_row.id
        order by decision.trigger_epoch`,
      [grant.shareGrantId]
    );
    expect(retentionHistory.rows).toHaveLength(2);
    expect(retentionHistory.rows[0]).toMatchObject({
      decision_id: scheduledRetention.rows[0]!.active_decision_id,
      job_id: scheduledRetention.rows[0]!.active_job_id,
      trigger_epoch: "1",
      target_epoch: "1",
      job_state: "canceled",
      evidence_count: "7"
    });
    expect(retentionHistory.rows[1]).toMatchObject({
      trigger_epoch: "2",
      target_epoch: "2",
      job_state: "pending",
      evidence_count: "7",
      grant_epoch: "2"
    });
    expect(retentionHistory.rows[1]!.decision_id).not.toBe(
      retentionHistory.rows[0]!.decision_id
    );
    expect(retentionHistory.rows[1]!.job_id).not.toBe(
      retentionHistory.rows[0]!.job_id
    );
    expect(retentionHistory.rows[1]!.active_decision_id).toBe(
      retentionHistory.rows[1]!.decision_id
    );
    expect(retentionHistory.rows[1]!.active_job_id).toBe(
      retentionHistory.rows[1]!.job_id
    );

    await pool.query(
      `update team_workspace_access_grants
       set access = 'disabled', disabled_at = now(), disabled_reason = 'withdrawn'
       where team_workspace_id = $1 and user_id = $2`,
      [fixture.teamWorkspaceId, fixture.readerUserId]
    );
    const decryptsBeforeWorkspaceWithdrawal = decryptCount();
    expect(
      await collaboration.listMessages(actor(fixture.readerUserId), {
        threadId: discussion.id,
        limit: 20
      })
    ).toBeNull();
    expect(decryptCount()).toBe(decryptsBeforeWorkspaceWithdrawal);
  });

  it("rejects restore after a Share Grant purge job has been claimed", async () => {
    const fixture = await createWorkspaceFixture({
      retentionSeconds: 0,
      backupRetentionSeconds: 0
    });
    const grant = await createGrant(fixture, { label: "claimed-restore" });
    await materialize(fixture, grant);
    const replacement = await createConsent(fixture, grant, {
      representation: grant.representation,
      mode: "continuous",
      label: "claimed-restore-replacement"
    });
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "claim_before_restore",
        authority: authority(fixture)
      }
    );
    const claimed = await retentionRepository.claimNextPurgeJob();
    expect(claimed?.job.target).toMatchObject({
      kind: "share_grant",
      shareGrantId: grant.shareGrantId
    });
    expect(claimed?.job.state).toBe("running");

    await expect(
      repository.selectGrantRepresentation(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        consentId: replacement.consentId,
        representation: grant.representation,
        expectedGrantVersion: revoked.grantVersion,
        authority: authority(fixture)
      })
    ).rejects.toThrow(
      "Share Grant cannot be changed after retention purge has started"
    );
    const state = await pool.query<{
      grant_lifecycle: string;
      representation_state: string;
      active_job_id: string;
      job_state: string;
      attempt_state: string;
    }>(
      `select grant_row.lifecycle as grant_lifecycle,
              representation.state as representation_state,
              grant_row.active_purge_job_id as active_job_id,
              job.state as job_state, attempt.state as attempt_state
         from team_session_share_grants grant_row
         join team_memory_representations representation
           on representation.share_grant_id = grant_row.id
         join purge_jobs job on job.id = grant_row.active_purge_job_id
         join purge_job_attempts attempt on attempt.purge_job_id = job.id
        where grant_row.id = $1`,
      [grant.shareGrantId]
    );
    expect(state.rows[0]).toEqual({
      grant_lifecycle: "purge_pending",
      representation_state: "purge_pending",
      active_job_id: claimed!.job.id,
      job_state: "running",
      attempt_state: "running"
    });

    await retentionRepository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      retentionRepository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });
  });

  it("purges only one zero-retention Share Grant and its companion artifacts", async () => {
    const fixture = await createWorkspaceFixture({
      retentionSeconds: 0,
      backupRetentionSeconds: 0
    });
    const targetGrant = await createGrant(fixture, {
      label: "target-grant-purge"
    });
    const unrelatedGrant = await createGrant(fixture, {
      label: "unrelated-grant-survives"
    });
    const targetRepresentation = await materialize(fixture, targetGrant);
    const unrelatedRepresentation = await materialize(fixture, unrelatedGrant);
    const createCompanion = (grant: GrantFixture, label: string) =>
      collaboration.createThread(actor(fixture.ownerUserId), {
        kind: "shared_session_discussion",
        idempotencyKey: `${label}:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      });
    const targetCompanion = await createCompanion(
      targetGrant,
      "target-companion"
    );
    const unrelatedCompanion = await createCompanion(
      unrelatedGrant,
      "unrelated-companion"
    );
    const workspaceChannel = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "workspace_channel",
        idempotencyKey: `purge-scope-channel:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        name: `Purge scope ${randomUUID()}`
      }
    );
    const targetMessage = await collaboration.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: targetCompanion!.id,
        idempotencyKey: `target-message:${randomUUID()}`,
        bodyText: `target-companion-secret-${randomUUID()}`,
        metadata: { scope: "target" }
      }
    );
    const unrelatedMessage = await collaboration.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: unrelatedCompanion!.id,
        idempotencyKey: `unrelated-message:${randomUUID()}`,
        bodyText: `unrelated-companion-secret-${randomUUID()}`,
        metadata: { scope: "unrelated" }
      }
    );
    const channelMessage = await collaboration.sendMessage(
      actor(fixture.ownerUserId),
      {
        threadId: workspaceChannel!.id,
        idempotencyKey: `channel-message:${randomUUID()}`,
        bodyText: `workspace-channel-secret-${randomUUID()}`,
        metadata: { scope: "channel" }
      }
    );
    const readOwnerPrivateState = () =>
      pool.query<{
        logical_lifecycle: string;
        replica_lifecycle: string;
        sync_state: string;
        sessions: string;
        events: string;
        nodes: string;
        artifacts: string;
        previews: string;
        encrypted_payloads: string;
      }>(
        `select
           (select lifecycle from logical_memories where id = $1) as logical_lifecycle,
           (select lifecycle from memory_replicas where id = $2) as replica_lifecycle,
           (select state from cross_identity_sync_relationships
             where id = $3) as sync_state,
           (select count(*)::text from sessions where id = $4) as sessions,
           (select count(*)::text from memory_events
             where session_id = $4) as events,
           (select count(*)::text from memory_nodes
             where session_id = $4) as nodes,
           (select count(*)::text from shared_source_artifacts
             where remote_replica_id = $2) as artifacts,
           (select count(*)::text from shared_source_previews
             where remote_replica_id = $2) as previews,
           (select count(*)::text from encrypted_field_payloads
             where encryption_scope = 'owner_private_replica'
               and owner_principal_id = $5) as encrypted_payloads`,
        [
          targetGrant.logicalMemoryId,
          targetGrant.remoteReplicaId,
          targetGrant.syncRelationshipId,
          targetGrant.sessionId,
          targetGrant.ownerPrincipalId
        ]
      );
    const ownerPrivateBefore = (await readOwnerPrivateState()).rows[0]!;
    expect(Number(ownerPrivateBefore.events)).toBeGreaterThan(0);
    expect(Number(ownerPrivateBefore.nodes)).toBeGreaterThan(0);
    expect(Number(ownerPrivateBefore.artifacts)).toBeGreaterThan(0);
    expect(Number(ownerPrivateBefore.encrypted_payloads)).toBeGreaterThan(0);
    const before = await pool.query<{
      target_chunks: string;
      target_payloads: string;
      target_messages: string;
      target_outbox: string;
      unrelated_chunks: string;
      unrelated_payloads: string;
      unrelated_messages: string;
      unrelated_outbox: string;
      channel_payloads: string;
      channel_messages: string;
      channel_outbox: string;
    }>(
      `select
         (select count(*)::text from team_memory_representation_chunks
           where share_grant_id = $1) as target_chunks,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($6::uuid[])) as target_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $2) as target_messages,
         (select count(*)::text from collaboration_outbox
           where share_grant_id = $1 or thread_id = $2) as target_outbox,
         (select count(*)::text from team_memory_representation_chunks
           where share_grant_id = $3) as unrelated_chunks,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($7::uuid[])) as unrelated_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $4) as unrelated_messages,
         (select count(*)::text from collaboration_outbox
           where share_grant_id = $3 or thread_id = $4) as unrelated_outbox,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($8::uuid[])) as channel_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $5) as channel_messages,
         (select count(*)::text from collaboration_outbox
           where thread_id = $5) as channel_outbox`,
      [
        targetGrant.shareGrantId,
        targetCompanion!.id,
        unrelatedGrant.shareGrantId,
        unrelatedCompanion!.id,
        workspaceChannel!.id,
        [targetCompanion!.id, targetMessage!.id],
        [unrelatedCompanion!.id, unrelatedMessage!.id],
        [workspaceChannel!.id, channelMessage!.id]
      ]
    );
    for (const count of Object.values(before.rows[0]!)) {
      expect(Number(count)).toBeGreaterThan(0);
    }
    const targetEvent = await pool.query<{ id: string; cursor: string }>(
      `select id, cursor::text from collaboration_outbox
        where share_grant_id = $1 or thread_id = $2
        order by cursor desc limit 1`,
      [targetGrant.shareGrantId, targetCompanion!.id]
    );
    const streamSubscription = await pool.query<{ id: string }>(
      `insert into collaboration_stream_subscriptions (
         backend_identity_hash, principal_id_hash, client_instance_hash,
         subscription_key_hash, protocol_version, scope, team_id,
         snapshot_high_water_cursor, acknowledged_event_id,
         acknowledged_cursor, expires_at
       ) values ($1,$2,$3,$4,1,'team',$5,$6,$7,$6,now() + interval '1 day')
       returning id`,
      [
        hash(`backend:${randomUUID()}`),
        hash(`principal:${randomUUID()}`),
        hash(`client:${randomUUID()}`),
        hash(`subscription:${randomUUID()}`),
        fixture.teamId,
        targetEvent.rows[0]!.cursor,
        targetEvent.rows[0]!.id
      ]
    );

    const grantPolicy = await retentionRepository.createPolicy({
      target: {
        scope: "share_grant",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: targetGrant.shareGrantId,
        logicalMemoryId: targetGrant.logicalMemoryId
      },
      retentionSeconds: 0,
      deletionGraceSeconds: 0,
      backupRetentionSeconds: 0,
      effectiveAt: new Date("2020-01-02T00:00:00.000Z"),
      createdByUserId: fixture.ownerUserId
    });
    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: targetGrant.shareGrantId,
      expectedGrantVersion: targetGrant.grantVersion,
      reasonCode: "zero_retention_purge",
      authority: authority(fixture)
    });
    const claimed = await retentionRepository.claimNextPurgeJob();
    expect(claimed?.job.target).toMatchObject({
      kind: "share_grant",
      shareGrantId: targetGrant.shareGrantId
    });
    await retentionRepository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      retentionRepository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });

    expect((await readOwnerPrivateState()).rows[0]).toEqual(ownerPrivateBefore);
    const after = await pool.query<{
      target_grant_lifecycle: string;
      target_representation_state: string;
      target_chunks: string;
      target_companion_lifecycle: string;
      target_payloads: string;
      target_messages: string;
      target_outbox: string;
      unrelated_grant_lifecycle: string;
      unrelated_representation_state: string;
      unrelated_chunks: string;
      unrelated_companion_lifecycle: string;
      unrelated_payloads: string;
      unrelated_messages: string;
      unrelated_outbox: string;
      channel_lifecycle: string;
      channel_payloads: string;
      channel_messages: string;
      channel_outbox: string;
      completion_audits: string;
    }>(
      `select
         (select lifecycle from team_session_share_grants
           where id = $1) as target_grant_lifecycle,
         (select state from team_memory_representations
           where id = $2) as target_representation_state,
         (select count(*)::text from team_memory_representation_chunks
           where share_grant_id = $1) as target_chunks,
         (select lifecycle from collaboration_threads
           where id = $3) as target_companion_lifecycle,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($8::uuid[])) as target_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $3) as target_messages,
         (select count(*)::text from collaboration_outbox
           where share_grant_id = $1 or thread_id = $3) as target_outbox,
         (select lifecycle from team_session_share_grants
           where id = $4) as unrelated_grant_lifecycle,
         (select state from team_memory_representations
           where id = $5) as unrelated_representation_state,
         (select count(*)::text from team_memory_representation_chunks
           where share_grant_id = $4) as unrelated_chunks,
         (select lifecycle from collaboration_threads
           where id = $6) as unrelated_companion_lifecycle,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($9::uuid[])) as unrelated_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $6) as unrelated_messages,
         (select count(*)::text from collaboration_outbox
           where share_grant_id = $4 or thread_id = $6) as unrelated_outbox,
         (select lifecycle from collaboration_threads
           where id = $7) as channel_lifecycle,
         (select count(*)::text from encrypted_field_payloads
           where source_id = any($10::uuid[])) as channel_payloads,
         (select count(*)::text from collaboration_messages
           where thread_id = $7) as channel_messages,
         (select count(*)::text from collaboration_outbox
           where thread_id = $7) as channel_outbox,
         (select count(*)::text from audit_events
           where action = 'share_grant.purge_completed'
             and target_id = $1
             and metadata ->> 'purgeJobId' = $11::text) as completion_audits`,
      [
        targetGrant.shareGrantId,
        targetRepresentation.id,
        targetCompanion!.id,
        unrelatedGrant.shareGrantId,
        unrelatedRepresentation.id,
        unrelatedCompanion!.id,
        workspaceChannel!.id,
        [targetCompanion!.id, targetMessage!.id],
        [unrelatedCompanion!.id, unrelatedMessage!.id],
        [workspaceChannel!.id, channelMessage!.id],
        claimed!.job.id
      ]
    );
    expect(after.rows[0]).toMatchObject({
      target_grant_lifecycle: "purged",
      target_representation_state: "purged",
      target_chunks: "0",
      target_companion_lifecycle: "purged",
      target_payloads: "0",
      target_messages: "0",
      target_outbox: "0",
      unrelated_grant_lifecycle: "active",
      unrelated_representation_state: "available",
      unrelated_companion_lifecycle: "active",
      unrelated_messages: "1",
      channel_lifecycle: "active",
      channel_messages: "1",
      completion_audits: "1"
    });
    for (const count of [
      after.rows[0]!.unrelated_chunks,
      after.rows[0]!.unrelated_payloads,
      after.rows[0]!.unrelated_outbox,
      after.rows[0]!.channel_payloads,
      after.rows[0]!.channel_outbox
    ]) {
      expect(Number(count)).toBeGreaterThan(0);
    }
    const evidence = await pool.query<{
      artifact_kind: string;
      state: string;
      removed_record_count: string;
    }>(
      `select artifact_kind, state, removed_record_count::text
         from purge_job_evidence
        where purge_job_id = $1
        order by artifact_kind`,
      [claimed!.job.id]
    );
    expect(
      evidence.rows.filter((row) =>
        ["search_index", "vector"].includes(row.artifact_kind)
      )
    ).toEqual([
      {
        artifact_kind: "search_index",
        state: "not_applicable",
        removed_record_count: "0"
      },
      {
        artifact_kind: "vector",
        state: "not_applicable",
        removed_record_count: "0"
      }
    ]);
    expect(
      evidence.rows.find((row) => row.artifact_kind === "encrypted_payload")
        ?.removed_record_count
    ).toBe(
      String(
        Number(before.rows[0]!.target_chunks) +
          Number(before.rows[0]!.target_payloads)
      )
    );
    const decision = await pool.query<{ policy_id: string; state: string }>(
      `select decision.policy_id, job.state
         from purge_jobs job
         join retention_decisions decision
           on decision.id = job.retention_decision_id
        where job.id = $1`,
      [claimed!.job.id]
    );
    expect(decision.rows[0]).toEqual({
      policy_id: grantPolicy.policyId,
      state: "verified"
    });
    await expect(
      pool.query(
        `select acknowledged_event_id, acknowledged_cursor::text,
                snapshot_high_water_cursor
           from collaboration_stream_subscriptions where id = $1`,
        [streamSubscription.rows[0]!.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          acknowledged_event_id: null,
          acknowledged_cursor: "0",
          snapshot_high_water_cursor: null
        }
      ]
    });
  });

  it("treats companion thread and message-range holds as part of the Share Grant purge scope", async () => {
    const fixture = await createWorkspaceFixture({
      retentionSeconds: 0,
      backupRetentionSeconds: 0
    });
    const grant = await createGrant(fixture, { label: "companion-hold" });
    await materialize(fixture, grant);
    const companion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: `companion-hold:${randomUUID()}`,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      }
    );
    await collaboration.sendMessage(actor(fixture.ownerUserId), {
      threadId: companion!.id,
      idempotencyKey: `companion-hold-message:${randomUUID()}`,
      bodyText: `held-companion-${randomUUID()}`,
      metadata: { held: true }
    });
    const freshlyAuthenticatedAt = new Date();
    const threadHold = await retentionRepository.placeLegalHold({
      target: {
        scope: "thread",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        threadId: companion!.id
      },
      actorUserId: fixture.ownerUserId,
      authority: "team.compliance",
      reasonCode: "companion_thread_hold",
      reasonHash: hash("companion thread hold"),
      freshlyAuthenticatedAt
    });
    const rangeHold = await retentionRepository.placeLegalHold({
      target: {
        scope: "team_message_range",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        threadId: companion!.id,
        messageRangeStart: 1,
        messageRangeEnd: 1
      },
      actorUserId: fixture.ownerUserId,
      authority: "team.compliance",
      reasonCode: "companion_message_hold",
      reasonHash: hash("companion message hold"),
      freshlyAuthenticatedAt
    });
    await repository.revokeShareGrant(actor(fixture.ownerUserId), {
      mutationId: randomUUID(),
      shareGrantId: grant.shareGrantId,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "held_share_revocation",
      authority: authority(fixture)
    });
    const scheduled = await pool.query<{
      job_id: string;
      applicable_legal_hold_ids: string[];
    }>(
      `select job.id as job_id, decision.applicable_legal_hold_ids
         from team_session_share_grants grant_row
         join retention_decisions decision
           on decision.id = grant_row.active_retention_decision_id
         join purge_jobs job on job.id = grant_row.active_purge_job_id
        where grant_row.id = $1`,
      [grant.shareGrantId]
    );
    expect(scheduled.rows[0]!.applicable_legal_hold_ids.sort()).toEqual(
      [threadHold.id, rangeHold.id].sort()
    );
    await expect(retentionRepository.claimNextPurgeJob()).resolves.toBeNull();
    await expect(
      pool.query(
        `select grant_row.lifecycle, job.state,
                (select count(*)::text from team_memory_representation_chunks
                  where share_grant_id = grant_row.id) as chunks,
                (select count(*)::text from collaboration_messages
                  where thread_id = $2) as messages
           from team_session_share_grants grant_row
           join purge_jobs job on job.id = grant_row.active_purge_job_id
          where grant_row.id = $1`,
        [grant.shareGrantId, companion!.id]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          lifecycle: "purge_pending",
          state: "blocked",
          chunks: "1",
          messages: "1"
        }
      ]
    });
    for (const hold of [threadHold, rangeHold]) {
      await retentionRepository.requestLegalHoldRelease({
        holdId: hold.id,
        actorUserId: fixture.ownerUserId
      });
      await retentionRepository.confirmLegalHoldRelease({
        holdId: hold.id,
        actorUserId: fixture.managerUserId
      });
    }
    await pool.query(
      "update purge_jobs set next_attempt_at = now() - interval '1 second' where id = $1",
      [scheduled.rows[0]!.job_id]
    );
    const claimed = await retentionRepository.claimNextPurgeJob();
    expect(claimed?.job.id).toBe(scheduled.rows[0]!.job_id);
    await retentionRepository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      retentionRepository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });
  });

  it("replays a revoked Share Grant idempotently after its outbox event is pruned", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "pruned-revoke-replay" });
    await materialize(fixture, grant);
    const mutationId = randomUUID();
    const input = {
      mutationId,
      shareGrantId: grant.shareGrantId,
      expectedGrantVersion: grant.grantVersion,
      reasonCode: "pruned_revoke_replay",
      authority: authority(fixture)
    };
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      input
    );
    const revokeEvent = await pool.query<{ id: string }>(
      `update collaboration_outbox
          set occurred_at = now() - interval '2 seconds',
              replay_until = now() - interval '1 second'
        where mutation_id = $1 and family = 'access_revoked'
        returning id`,
      [mutationId]
    );
    expect(revokeEvent.rows).toHaveLength(1);
    const pruned = await collaboration.pruneExpiredReplayHistory({
      limit: 10_000
    });
    expect(pruned.deletedEventCount).toBeGreaterThanOrEqual(1);
    const replayed = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      input
    );
    expect(replayed).toEqual(revoked);
    const durable = await pool.query<{
      decisions: string;
      jobs: string;
      revoke_events: string;
      trigger_epoch: string;
      target_epoch: string;
    }>(
      `select
         (select count(*)::text from retention_decisions
           where share_grant_id = $1 and trigger = 'share_revoked') as decisions,
         (select count(*)::text from purge_jobs
           where share_grant_id = $1) as jobs,
         (select count(*)::text from collaboration_outbox
           where mutation_id = $2 and family = 'access_revoked') as revoke_events,
         decision.trigger_epoch::text,
         job.target_epoch::text
       from team_session_share_grants grant_row
       join retention_decisions decision
         on decision.id = grant_row.active_retention_decision_id
       join purge_jobs job on job.id = grant_row.active_purge_job_id
       where grant_row.id = $1`,
      [grant.shareGrantId, mutationId]
    );
    expect(durable.rows[0]).toEqual({
      decisions: "1",
      jobs: "1",
      revoke_events: "0",
      trigger_epoch: "1",
      target_epoch: "1"
    });
  });

  it("reveals retained companion history only after a future member receives current Workspace Access", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, {
      label: "future-member-history"
    });
    await materialize(fixture, grant);
    const discussion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: "future-member-history",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: grant.logicalMemoryId,
        shareGrantId: grant.shareGrantId
      }
    );
    if (!discussion) throw new Error("Expected companion thread creation");
    const historicalText = `retained-companion-${randomUUID()}`;
    await collaboration.sendMessage(actor(fixture.ownerUserId), {
      threadId: discussion.id,
      idempotencyKey: "retained-before-member-joins",
      bodyText: historicalText,
      metadata: { channel: "discussion" }
    });

    const unrelatedGrant = await createGrant(fixture, {
      label: "unrelated-companion"
    });
    await materialize(fixture, unrelatedGrant);
    const unrelatedDiscussion = await collaboration.createThread(
      actor(fixture.ownerUserId),
      {
        kind: "shared_session_discussion",
        idempotencyKey: "unrelated-companion",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        sharedLogicalMemoryId: unrelatedGrant.logicalMemoryId,
        shareGrantId: unrelatedGrant.shareGrantId
      }
    );
    if (!unrelatedDiscussion) {
      throw new Error("Expected unrelated companion thread creation");
    }

    const decryptsBeforeMembership = decryptCount();
    await expect(
      collaboration.listMessages(actor(fixture.outsiderUserId), {
        threadId: discussion.id,
        limit: 20
      })
    ).resolves.toBeNull();
    expect(decryptCount()).toBe(decryptsBeforeMembership);

    await pool.query(
      `insert into team_memberships (
         team_id,user_id,role,status,accepted_at
       ) values ($1,$2,'member','enabled',now())`,
      [fixture.teamId, fixture.outsiderUserId]
    );
    const decryptsBeforeWorkspaceAccess = decryptCount();
    await expect(
      collaboration.listMessages(actor(fixture.outsiderUserId), {
        threadId: discussion.id,
        limit: 20
      })
    ).resolves.toBeNull();
    expect(decryptCount()).toBe(decryptsBeforeWorkspaceAccess);

    await pool.query(
      `insert into team_workspace_access_grants (
         team_workspace_id,team_id,user_id,access,
         can_share_owned_memory,granted_by_user_id
       ) values ($1,$2,$3,'read',false,$4)`,
      [
        fixture.teamWorkspaceId,
        fixture.teamId,
        fixture.outsiderUserId,
        fixture.managerUserId
      ]
    );
    const authorizedHistory = await collaboration.listMessages(
      actor(fixture.outsiderUserId),
      { threadId: discussion.id, limit: 20 }
    );
    expect(authorizedHistory?.messages).toHaveLength(1);
    expect(authorizedHistory?.messages[0]?.bodyText).toBe(historicalText);

    const unrelatedHistory = await collaboration.listMessages(
      actor(fixture.outsiderUserId),
      { threadId: unrelatedDiscussion.id, limit: 20 }
    );
    expect(unrelatedHistory?.messages).toEqual([]);
    const storedMessages = await pool.query<{
      thread_id: string;
      count: string;
    }>(
      `select thread_id,count(*)::text as count
         from collaboration_messages
        where thread_id=any($1::uuid[])
        group by thread_id`,
      [[discussion.id, unrelatedDiscussion.id]]
    );
    expect(storedMessages.rows).toEqual([
      { thread_id: discussion.id, count: "1" }
    ]);
  });

  it("is idempotent under concurrent grant and representation retries", async () => {
    const fixture = await createWorkspaceFixture();
    const source = await createSource(fixture, 2);
    await putOwnerPolicy(fixture, source);
    const created = await createConsent(fixture, source, {
      representation: "memory_events",
      mode: "continuous",
      label: "concurrent"
    });
    const logicalGrantId = randomUUID();
    const mutationId = randomUUID();
    const create = () =>
      repository.createShareGrant(actor(fixture.ownerUserId), {
        mutationId,
        logicalGrantId,
        consentId: created.consentId,
        authority: authority(fixture)
      });
    const grants = await Promise.all([create(), create(), create()]);
    expect(new Set(grants.map((grant) => grant.id)).size).toBe(1);
    const shareGrantId = grants[0]!.id;
    const outbox = await pool.query<{ count: string }>(
      `select count(*)::text as count from collaboration_outbox
       where mutation_id = $1 and family = 'share_grant_lifecycle'`,
      [mutationId]
    );
    expect(outbox.rows[0]?.count).toBe("1");

    const materializationMutationId = randomUUID();
    const preview = await createPersistedPreview(
      fixture,
      source,
      "memory_events",
      source.currentRevision,
      "concurrent"
    );
    const encryptionsBeforeMaterialize = encryptSpy.mock.calls.length;
    const materializeRetry = () =>
      repository.materializeGrantRepresentation(actor(fixture.ownerUserId), {
        mutationId: materializationMutationId,
        shareGrantId,
        consentId: created.consentId,
        expectedGrantVersion: grants[0]!.grantVersion,
        preview
      });
    const representations = await Promise.all([
      materializeRetry(),
      materializeRetry(),
      materializeRetry()
    ]);
    expect(new Set(representations.map((item) => item.id)).size).toBe(1);
    expect(encryptSpy.mock.calls.length - encryptionsBeforeMaterialize).toBe(1);
    const rows = await pool.query<{ count: string }>(
      `select count(*)::text as count from team_memory_representations
       where share_grant_id = $1 and state = 'available'`,
      [shareGrantId]
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("preserves one durable Share Grant identity per logical memory and destination", async () => {
    const fixture = await createWorkspaceFixture();
    const grant = await createGrant(fixture, { label: "durable-grant" });
    const revoked = await repository.revokeShareGrant(
      actor(fixture.ownerUserId),
      {
        mutationId: randomUUID(),
        shareGrantId: grant.shareGrantId,
        expectedGrantVersion: grant.grantVersion,
        reasonCode: "owner_withdrawal",
        authority: authority(fixture)
      }
    );
    expect(revoked.lifecycle).toBe("revoked");

    const replacement = await createConsent(fixture, grant, {
      representation: "memory_events",
      mode: "continuous",
      label: "replacement-grant"
    });
    await expect(
      repository.createShareGrant(actor(fixture.ownerUserId), {
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        consentId: replacement.consentId,
        authority: authority(fixture)
      })
    ).rejects.toThrow(
      "This logical memory already has a Share Grant for the destination Workspace"
    );

    const stored = await pool.query<{ count: string }>(
      `select count(*)::text as count from team_session_share_grants
       where logical_memory_id=$1 and team_workspace_id=$2`,
      [grant.logicalMemoryId, fixture.teamWorkspaceId]
    );
    expect(stored.rows[0]?.count).toBe("1");
  });
});
