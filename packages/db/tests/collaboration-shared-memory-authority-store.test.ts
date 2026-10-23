import { randomUUID } from "node:crypto";
import { preparePersonalSourceContextSnapshot } from "../src/personal-source-context-export.js";

import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  sharingSelectionDescriptor,
  sharingRuleSourceIdentityHash,
  selectionSharingEffectiveIntent,
  sharingRuleDetailAppliedScopeSchema,
  type SelectionSharingAttempt,
  repositorySharingRuleCreationLocalIntentSchema,
  repositorySharingRuleCreationIntentSchema,
  sharingRulePublisherTakeoverLocalIntentSchema,
  sharingRulePublisherTakeoverAppliedScopeSchema,
  type ConversationSharingRuleCreationIntent,
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
  vi
} from "vitest";
import type pg from "pg";

import {
  createCollaborationSharedMemoryAuthorityStore,
  type CollaborationRemoteSharedMemoryConsent,
  type CollaborationRemoteSharedMemoryGrant,
  type CollaborationRemoteSharedMemoryPreview,
  type CollaborationSharedMemoryAuthorityIdentity,
  type CollaborationSharedMemoryAuthorityRepository
} from "../src/collaboration-shared-memory-authority-store.js";
import { createDbPool } from "../src/connection.js";
import { createMemorySourceRepository } from "../src/repository.js";
import { updateSessionRepositoryOverride } from "../src/repository-assignment.js";
import { runDbMigrations } from "../src/migrate.js";
import { createSelectionSharingReconciliation } from "../src/selection-sharing-reconciliation.js";
import { createSelectionSharingJournal } from "../src/selection-sharing-journal.js";

const databaseUrl =
  process.env.COLLABORATION_SHARED_MEMORY_AUTHORITY_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const timestamp = "2026-07-17T09:00:00.000Z";
const hash = (character: string): string => character.repeat(64);

interface Fixture {
  identity: CollaborationSharedMemoryAuthorityIdentity;
  otherOwnerIdentity: CollaborationSharedMemoryAuthorityIdentity;
  wrongUpstreamIdentity: CollaborationSharedMemoryAuthorityIdentity;
  remoteDeviceId: string;
  logicalMemoryId: string;
  teamId: string;
  workspaceId: string;
  remoteReplicaId: string;
  syncRelationshipId: string;
  sessionId: string;
  companionThreadId: string;
  sharedSessionId: string;
}

describeDb("Collaboration Shared Memory authority store", () => {
  let pool: pg.Pool;
  let provider: EnvelopeEncryptionProvider;
  let store: CollaborationSharedMemoryAuthorityRepository;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    if (
      process.env.COLLABORATION_SHARED_MEMORY_AUTHORITY_TEST_SCHEMA_READY !==
      "1"
    ) {
      await runDbMigrations(pool);
    }
  });

  beforeEach(() => {
    provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 73).toString("base64")
    );
    store = createCollaborationSharedMemoryAuthorityStore(pool, {
      envelopeEncryptionProvider: provider
    });
  });

  afterEach(async () => {
    await pool.query(
      `truncate table
         collaboration_shared_memory_grants,
         collaboration_shared_memory_companion_bindings,
         collaboration_shared_memory_consents,
         collaboration_shared_memory_previews,
         collaboration_shared_memory_enrollments,
         cross_identity_sync_relationships,
         memory_replicas,
         logical_memories,
         sync_principal_links,
         sync_external_user_identities,
         deployment_identities,
         sessions,
         users
       restart identity cascade`
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  const createUser = async (label: string): Promise<string> => {
    const result = await pool.query<{ id: string }>(
      `insert into users (email, display_name)
       values ($1, $2)
       returning id`,
      [`csm-${label}-${randomUUID()}@example.com`, label]
    );
    return result.rows[0]!.id;
  };

  const createFixture = async (): Promise<Fixture> => {
    const localOwnerUserId = await createUser("owner");
    const otherOwnerUserId = await createUser("other-owner");
    const backendId = `backend-${randomUUID()}`;
    const upstreamUserId = randomUUID();
    return {
      identity: { backendId, localOwnerUserId, upstreamUserId },
      otherOwnerIdentity: {
        backendId,
        localOwnerUserId: otherOwnerUserId,
        upstreamUserId
      },
      wrongUpstreamIdentity: {
        backendId,
        localOwnerUserId,
        upstreamUserId: randomUUID()
      },
      remoteDeviceId: randomUUID(),
      logicalMemoryId: randomUUID(),
      teamId: randomUUID(),
      workspaceId: randomUUID(),
      remoteReplicaId: randomUUID(),
      syncRelationshipId: randomUUID(),
      sessionId: randomUUID(),
      companionThreadId: randomUUID(),
      sharedSessionId: randomUUID()
    };
  };

  const bindFixture = async (fixture: Fixture): Promise<void> => {
    expect(
      await store.bindEnrollment({
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId
      })
    ).toBe(true);
    const localDeploymentId = randomUUID();
    const remoteDeploymentId = randomUUID();
    const remoteUserIdentityId = randomUUID();
    const localReplicaId = randomUUID();
    await pool.query(
      `insert into deployment_identities
         (id, protocol_deployment_id, locality, profile)
       values ($1, $2, 'local', 'local_personal')`,
      [localDeploymentId, randomUUID()]
    );
    await pool.query(
      `insert into deployment_identities
         (id, protocol_deployment_id, locality, profile, base_url, upstream_backend_id)
       values ($1, $2, 'remote', 'team_self_hosted', $3, $4)`,
      [
        remoteDeploymentId,
        randomUUID(),
        "https://team.example.test",
        fixture.identity.backendId
      ]
    );
    await pool.query(
      `insert into sync_external_user_identities
         (id, deployment_identity_id, external_subject_id)
       values ($1, $2, $3)`,
      [
        remoteUserIdentityId,
        remoteDeploymentId,
        fixture.identity.upstreamUserId
      ]
    );
    await pool.query(
      `insert into sync_principal_links
         (local_user_id, external_user_identity_id, proof_kind, proof_reference)
       values ($1, $2, 'device_enrollment', $3)`,
      [
        fixture.identity.localOwnerUserId,
        remoteUserIdentityId,
        `fixture:${randomUUID()}`
      ]
    );
    await pool.query(
      `insert into sessions
         (id, owner_user_id, visibility, source_runtime, capture_method)
       values ($1, $2, 'personal', 'codex', 'api')`,
      [fixture.sessionId, fixture.identity.localOwnerUserId]
    );
    await pool.query(
      `with logical_memory as (
         insert into logical_memories
           (id, owner_user_id, owner_principal_id, origin_deployment_identity_id,
            source_kind, logical_key)
         values ($1, $2, $2, $3, 'captured_session', $4)
         returning id
       ), protocol_binding as (
         insert into captured_session_logical_memories
           (logical_memory_id,source_session_id,owner_principal_id)
         select id,$5,$2 from logical_memory
       )
       insert into local_captured_session_logical_memories
         (logical_memory_id,local_session_id,owner_user_id)
       select id,$5,$2 from logical_memory`,
      [
        fixture.logicalMemoryId,
        fixture.identity.localOwnerUserId,
        localDeploymentId,
        `captured-session:${fixture.sessionId}`,
        fixture.sessionId
      ]
    );
    await pool.query(
      `insert into memory_replicas
         (id, logical_memory_id, deployment_identity_id, owner_user_id,
          owner_principal_id, replica_role, source_boundary,
          encryption_scope, freshness_status)
       values ($1, $2, $3, $4, $4, 'source', 'captured_session',
               'personal', 'fresh')`,
      [
        localReplicaId,
        fixture.logicalMemoryId,
        localDeploymentId,
        fixture.identity.localOwnerUserId
      ]
    );
    await pool.query(
      `insert into cross_identity_sync_relationships
         (id, logical_memory_id, side, local_replica_id, local_user_id,
          remote_deployment_identity_id, remote_user_identity_id,
          remote_replica_id, source_boundary, state, idempotency_key,
          creation_request_hash, policy_manifest, consent_manifest)
       values ($1, $2, 'source', $3, $4, $5, $6, $7, 'captured_session', 'ready',
               $8, $9, '{}'::jsonb, '{}'::jsonb)`,
      [
        fixture.syncRelationshipId,
        fixture.logicalMemoryId,
        localReplicaId,
        fixture.identity.localOwnerUserId,
        remoteDeploymentId,
        remoteUserIdentityId,
        fixture.remoteReplicaId,
        `fixture:${randomUUID()}`,
        hash("f")
      ]
    );
  };

  const previewFor = (
    fixture: Fixture,
    overrides: Partial<CollaborationRemoteSharedMemoryPreview> = {}
  ): CollaborationRemoteSharedMemoryPreview => ({
    source: {
      kind: "captured_session",
      sessionId: fixture.sessionId,
      logicalMemoryId: fixture.logicalMemoryId
    },
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: "memory_events",
    previewId: randomUUID(),
    previewHash: hash("a"),
    previewRevision: 1,
    logicalMemoryId: fixture.logicalMemoryId,
    teamId: fixture.teamId,
    teamWorkspaceId: fixture.workspaceId,
    representation: "memory_events",
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    mode: "continuous",
    binding: {
      sourceRevision: 7,
      sourceHash: hash("b"),
      fidelityPolicyRevision: 3,
      fidelityPolicyHash: hash("c"),
      contentPolicyVersion: 4,
      contentPolicyHash: hash("d"),
      classifierVersion: 5,
      classifierHash: hash("e")
    },
    items: [
      {
        itemType: "user_message",
        schemaVersion: 1,
        sourceId: randomUUID(),
        sourceLogicalMemoryId: fixture.logicalMemoryId,
        sourceRevision: 7,
        occurredAt: timestamp,
        content: { text: "protected exact preview body" }
      }
    ],
    sourceContentHash: hash("f"),
    sourceRevision: 7,
    sourceHash: hash("b"),
    createdAt: timestamp,
    ...overrides
  });

  const consentFor = (
    fixture: Fixture,
    preview: {
      previewId: string;
      previewHash: string;
      previewRevision: number;
    },
    overrides: Partial<CollaborationRemoteSharedMemoryConsent> = {}
  ): CollaborationRemoteSharedMemoryConsent => ({
    source: {
      kind: "captured_session",
      sessionId: fixture.sessionId,
      logicalMemoryId: fixture.logicalMemoryId
    },
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: "memory_events",
    id: randomUUID(),
    logicalMemoryId: fixture.logicalMemoryId,
    teamId: fixture.teamId,
    teamWorkspaceId: fixture.workspaceId,
    mode: "continuous",
    state: "active",
    consentVersion: 1,
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    previewRevision: preview.previewRevision,
    previewHash: preview.previewHash,
    sourceRevision: 7,
    createdAt: timestamp,
    updatedAt: timestamp,
    activatedAt: timestamp,
    revokedAt: null,
    ...overrides
  });

  const grantFor = (
    fixture: Fixture,
    consentId: string,
    overrides: Partial<CollaborationRemoteSharedMemoryGrant> = {}
  ): CollaborationRemoteSharedMemoryGrant => {
    const id = overrides.id ?? randomUUID();
    return {
      source: {
        kind: "captured_session",
        sessionId: fixture.sessionId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "memory_events",
      id,
      logicalGrantId: randomUUID(),
      logicalMemoryId: fixture.logicalMemoryId,
      ownerUserId: fixture.identity.upstreamUserId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.workspaceId,
      consentId,
      mode: "continuous",
      maximumFidelity: "memory_events",
      includeCuratedMemory: false,
      fidelityPolicyRevision: 3,
      sourceRevision: 7,
      grantVersion: 1,
      lifecycle: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      revokedAt: null,
      companionScope: {
        scope: "team",
        kind: "shared_session_discussion",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.workspaceId,
        logicalMemoryId: fixture.logicalMemoryId,
        shareGrantId: id
      },
      ...overrides
    };
  };

  const companionFor = (fixture: Fixture) => ({
    companionThreadId: fixture.companionThreadId,
    sharedSessionId: fixture.sharedSessionId
  });

  const persistPreviewAndConsent = async (fixture: Fixture) => {
    const remotePreview = previewFor(fixture);
    const preview = await store.persistAuthoritativePreview({
      identity: fixture.identity,
      preview: remotePreview
    });
    expect(preview).not.toBeNull();
    const remoteConsent = consentFor(fixture, preview!);
    const consent = await store.persistAuthoritativeConsent({
      identity: fixture.identity,
      previewId: preview!.previewId,
      consent: remoteConsent
    });
    expect(consent).not.toBeNull();
    return {
      remotePreview,
      preview: preview!,
      remoteConsent,
      consent: consent!
    };
  };

  it("migrates every authority table into a fresh database", async () => {
    const result = await pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = current_schema()
          and table_name like 'collaboration_shared_memory_%'
        order by table_name`
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "collaboration_shared_memory_companion_bindings",
      "collaboration_shared_memory_consents",
      "collaboration_shared_memory_enrollments",
      "collaboration_shared_memory_grants",
      "collaboration_shared_memory_previews"
    ]);
    const columns = await pool.query<{
      column_name: string;
      table_name: string;
    }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = current_schema()
          and table_name in (
            'collaboration_shared_memory_previews',
            'collaboration_shared_memory_consents',
            'collaboration_shared_memory_grants'
          )
          and column_name in (
            'maximum_fidelity', 'include_curated_memory',
            'active_representation', 'mode'
          )
        order by table_name, column_name`
    );
    expect(columns.rows).toEqual([
      {
        table_name: "collaboration_shared_memory_consents",
        column_name: "include_curated_memory"
      },
      {
        table_name: "collaboration_shared_memory_consents",
        column_name: "maximum_fidelity"
      },
      {
        table_name: "collaboration_shared_memory_grants",
        column_name: "include_curated_memory"
      },
      {
        table_name: "collaboration_shared_memory_grants",
        column_name: "maximum_fidelity"
      },
      {
        table_name: "collaboration_shared_memory_grants",
        column_name: "mode"
      },
      {
        table_name: "collaboration_shared_memory_previews",
        column_name: "include_curated_memory"
      },
      {
        table_name: "collaboration_shared_memory_previews",
        column_name: "maximum_fidelity"
      }
    ]);
  });

  it("persists a Continuous Personal Note preview with one exact Memory Event", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const memoryEventId = randomUUID();
    const preview = previewFor(fixture, {
      source: {
        kind: "personal_note",
        noteId: randomUUID(),
        noteRevision: 3,
        memoryEventId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      sourceCapabilities: ["memory_events"],
      activationRepresentation: "memory_events",
      maximumFidelity: "memory_events",
      includeCuratedMemory: false,
      mode: "continuous",
      sourceRevision: 3,
      binding: {
        ...previewFor(fixture).binding,
        sourceRevision: 3
      },
      items: [
        {
          itemType: "user_message",
          schemaVersion: 1,
          sourceId: memoryEventId,
          sourceLogicalMemoryId: fixture.logicalMemoryId,
          sourceRevision: 3,
          occurredAt: timestamp,
          content: { text: "privacy-filtered Personal Note" }
        }
      ]
    });

    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview
      })
    ).resolves.toMatchObject({
      mode: "continuous",
      source: { kind: "personal_note", memoryEventId }
    });
  });

  it("resolves preview authority from the exact active sync relationship", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);

    await expect(store.isEnrollmentBound(fixture.identity)).resolves.toBe(true);
    await expect(
      store.isEnrollmentBound(fixture.otherOwnerIdentity)
    ).resolves.toBe(false);
    await expect(
      store.isEnrollmentBound(fixture.wrongUpstreamIdentity)
    ).resolves.toBe(false);
    await expect(
      store.bindEnrollment({
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId
      })
    ).resolves.toBe(true);

    await expect(
      store.resolvePreviewTarget({
        ...fixture.identity,
        logicalMemoryId: fixture.logicalMemoryId,
        teamId: fixture.teamId,
        workspaceId: fixture.workspaceId,
        representation: "memory_events"
      })
    ).resolves.toEqual({
      remoteReplicaId: fixture.remoteReplicaId,
      syncRelationshipId: fixture.syncRelationshipId,
      localSessionId: fixture.sessionId
    });
    await expect(
      store.resolvePreviewTarget({
        ...fixture.identity,
        logicalMemoryId: randomUUID(),
        teamId: fixture.teamId,
        workspaceId: fixture.workspaceId,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
    for (const changed of [
      { teamId: randomUUID() },
      { workspaceId: randomUUID() },
      { representation: "lcm_leaves" as const }
    ]) {
      await expect(
        store.resolvePreviewTarget({
          ...fixture.identity,
          logicalMemoryId: fixture.logicalMemoryId,
          teamId: fixture.teamId,
          workspaceId: fixture.workspaceId,
          representation: "memory_events",
          ...changed
        })
      ).resolves.toEqual({
        remoteReplicaId: fixture.remoteReplicaId,
        syncRelationshipId: fixture.syncRelationshipId,
        localSessionId: fixture.sessionId
      });
    }
    await pool.query(
      `update cross_identity_sync_relationships
          set state = 'failed'
        where logical_memory_id = $1 and side = 'source'`,
      [fixture.logicalMemoryId]
    );
    await expect(
      store.resolvePreviewTarget({
        ...fixture.identity,
        logicalMemoryId: fixture.logicalMemoryId,
        teamId: fixture.teamId,
        workspaceId: fixture.workspaceId,
        representation: "memory_events"
      })
    ).resolves.toBeNull();
    await pool.query(
      `update cross_identity_sync_relationships
          set state = 'stale'
        where logical_memory_id = $1 and side = 'source'`,
      [fixture.logicalMemoryId]
    );
    await expect(
      store.resolvePreviewTarget({
        ...fixture.identity,
        logicalMemoryId: fixture.logicalMemoryId,
        teamId: fixture.teamId,
        workspaceId: fixture.workspaceId,
        representation: "memory_events"
      })
    ).resolves.toEqual({
      remoteReplicaId: fixture.remoteReplicaId,
      syncRelationshipId: fixture.syncRelationshipId,
      localSessionId: fixture.sessionId
    });
  });

  it("retains an authoritative Personal Note preview without a sync relationship", async () => {
    const fixture = await createFixture();
    await expect(
      store.bindEnrollment({
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId
      })
    ).resolves.toBe(true);

    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: previewFor(fixture)
      })
    ).resolves.toBeNull();

    const noteId = randomUUID();
    const memoryEventId = randomUUID();
    const remote = previewFor(fixture, {
      source: {
        kind: "personal_note",
        noteId,
        noteRevision: 1,
        memoryEventId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      sourceCapabilities: ["memory_events"],
      mode: "snapshot",
      sourceRevision: 1,
      binding: {
        sourceRevision: 1,
        sourceHash: hash("b"),
        fidelityPolicyRevision: 3,
        fidelityPolicyHash: hash("c"),
        contentPolicyVersion: 4,
        contentPolicyHash: hash("d"),
        classifierVersion: 5,
        classifierHash: hash("e")
      },
      items: [
        {
          itemType: "user_message",
          schemaVersion: 1,
          sourceId: memoryEventId,
          sourceLogicalMemoryId: fixture.logicalMemoryId,
          sourceRevision: 1,
          occurredAt: timestamp,
          content: { text: "protected Personal Note preview" }
        }
      ]
    });
    await expect(
      store.persistAuthoritativeCandidatePreview({
        identity: fixture.identity,
        preview: remote,
        previewExpiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    ).resolves.toMatchObject({
      source: { kind: "personal_note", noteId, memoryEventId },
      previewHash: remote.previewHash,
      sourceRevision: 1
    });
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: remote
      })
    ).resolves.toMatchObject({
      source: { kind: "personal_note", noteId, memoryEventId },
      previewHash: remote.previewHash,
      sourceRevision: 1
    });
    await expect(
      store.readAuthoritativePreview({
        ...fixture.identity,
        previewHash: remote.previewHash
      })
    ).resolves.toMatchObject({
      source: { kind: "personal_note", noteId, memoryEventId },
      items: [{ sourceId: memoryEventId }]
    });
    await expect(
      pool.query<{ sync_relationship_id: string | null }>(
        `select sync_relationship_id
           from collaboration_shared_memory_previews
          where preview_id = $1`,
        [remote.previewId]
      )
    ).resolves.toMatchObject({
      rows: [{ sync_relationship_id: null }]
    });
  });

  it("rotates stale authority after authenticated device or upstream identity replacement", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const remote = previewFor(fixture);
    expect(
      await store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: remote
      })
    ).not.toBeNull();
    expect(
      await store.bindCompanionSession({
        identity: fixture.identity,
        shareGrantId: randomUUID(),
        logicalMemoryId: fixture.logicalMemoryId,
        teamId: fixture.teamId,
        workspaceId: fixture.workspaceId,
        companionThreadId: fixture.companionThreadId,
        sharedSessionId: fixture.sharedSessionId
      })
    ).toBe(true);

    const replacementDeviceId = randomUUID();
    await expect(
      store.isEnrollmentBound({
        ...fixture.identity,
        remoteDeviceId: replacementDeviceId
      })
    ).resolves.toBe(false);
    await expect(
      store.bindEnrollment({
        identity: fixture.identity,
        remoteDeviceId: replacementDeviceId
      })
    ).resolves.toBe(true);
    await expect(store.isEnrollmentBound(fixture.identity)).resolves.toBe(true);
    await expect(
      store.isEnrollmentBound({
        ...fixture.identity,
        remoteDeviceId: replacementDeviceId
      })
    ).resolves.toBe(true);
    await expect(
      store.isEnrollmentBound({
        ...fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId
      })
    ).resolves.toBe(false);
    await expect(
      store.readAuthoritativePreview({
        ...fixture.identity,
        previewHash: remote.previewHash
      })
    ).resolves.toBeNull();

    await expect(
      store.bindEnrollment({
        identity: fixture.wrongUpstreamIdentity,
        remoteDeviceId: randomUUID()
      })
    ).resolves.toBe(true);
    await expect(store.isEnrollmentBound(fixture.identity)).resolves.toBe(
      false
    );
    await expect(
      store.isEnrollmentBound(fixture.wrongUpstreamIdentity)
    ).resolves.toBe(true);

    const state = await pool.query<{
      active_count: string;
      revoked_count: string;
      revoked_companion_count: string;
    }>(
      `select
         (select count(*) from collaboration_shared_memory_enrollments
           where backend_id = $1 and local_owner_user_id = $2
             and revoked_at is null)::text as active_count,
         (select count(*) from collaboration_shared_memory_enrollments
           where backend_id = $1 and local_owner_user_id = $2
             and revocation_reason = 'authenticated_upstream_identity_rotation')::text
           as revoked_count,
         (select count(*)
            from collaboration_shared_memory_companion_bindings binding
            join collaboration_shared_memory_enrollments enrollment
              on enrollment.id = binding.enrollment_id
           where enrollment.backend_id = $1
             and enrollment.local_owner_user_id = $2
             and binding.revoked_at is not null)::text as revoked_companion_count`,
      [fixture.identity.backendId, fixture.identity.localOwnerUserId]
    );
    expect(state.rows).toEqual([
      {
        active_count: "1",
        revoked_count: "2",
        revoked_companion_count: "1"
      }
    ]);
  });

  it("persists exact previews encrypted with authoritative revisions and rejects conflicts", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const remote = previewFor(fixture);
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.persistAuthoritativePreview({
          identity: fixture.identity,
          preview: remote
        })
      )
    );
    expect(attempts.every((value) => value?.previewRevision === 1)).toBe(true);
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: {
          ...remote,
          previewId: randomUUID(),
          previewHash: hash("6"),
          activationRepresentation: "curated_assertions",
          includeCuratedMemory: false
        }
      })
    ).resolves.toBeNull();
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: {
          ...remote,
          previewId: randomUUID(),
          previewHash: hash("7"),
          activationRepresentation: "memory_events",
          maximumFidelity: "lcm_rollups"
        }
      })
    ).resolves.toBeNull();
    expect(
      await pool.query(
        "select 1 from collaboration_shared_memory_previews where preview_id = $1",
        [remote.previewId]
      )
    ).toHaveProperty("rowCount", 1);
    const driftedRevisionStore = createCollaborationSharedMemoryAuthorityStore(
      pool,
      { envelopeEncryptionProvider: provider }
    );
    await expect(
      driftedRevisionStore.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: { ...remote, previewRevision: 99 }
      })
    ).resolves.toBeNull();

    const secondRemote = previewFor(fixture, {
      previewId: randomUUID(),
      previewHash: hash("1"),
      previewRevision: 2
    });
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: secondRemote
      })
    ).resolves.toMatchObject({ previewRevision: 2 });
    const sameRevisionRemote = previewFor(fixture, {
      previewId: randomUUID(),
      previewHash: hash("3"),
      sourceContentHash: hash("4"),
      binding: {
        ...remote.binding,
        fidelityPolicyRevision: 4,
        fidelityPolicyHash: hash("5")
      }
    });
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: sameRevisionRemote
      })
    ).resolves.toMatchObject({
      previewId: sameRevisionRemote.previewId,
      previewRevision: 1
    });
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: { ...remote, previewHash: hash("2") }
      })
    ).resolves.toBeNull();
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: { ...remote, previewId: randomUUID() }
      })
    ).resolves.toBeNull();
    await expect(
      store.readAuthoritativePreview({
        ...fixture.otherOwnerIdentity,
        previewHash: remote.previewHash
      })
    ).resolves.toBeNull();
    await expect(
      store.readAuthoritativePreview({
        ...fixture.wrongUpstreamIdentity,
        previewHash: remote.previewHash
      })
    ).resolves.toBeNull();

    const atRest = await pool.query<{
      protected_dto: unknown;
      protected_dto_hash: string;
    }>(
      `select protected_dto, protected_dto_hash
         from collaboration_shared_memory_previews
        where preview_id = $1`,
      [remote.previewId]
    );
    const serialized = JSON.stringify(atRest.rows[0]);
    expect(serialized).not.toContain("protected exact preview body");
    expect(serialized).not.toContain(remote.items[0]!.sourceId);
    expect(atRest.rows[0]!.protected_dto_hash).toMatch(/^[0-9a-f]{64}$/);

    await pool.query(
      `update collaboration_shared_memory_previews
          set source_hash = $2
        where preview_id = $1`,
      [remote.previewId, hash("9")]
    );
    await expect(
      store.readAuthoritativePreview({
        ...fixture.identity,
        previewHash: remote.previewHash
      })
    ).resolves.toBeNull();
  });

  it("renews an expired exact preview when the backend authorizes it again", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const remote = previewFor(fixture);
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: remote
      })
    ).resolves.not.toBeNull();
    await pool.query(
      `update collaboration_shared_memory_previews
          set expires_at = now() - interval '1 minute'
        where preview_id = $1`,
      [remote.previewId]
    );
    await expect(
      store.readAuthoritativePreview({
        ...fixture.identity,
        previewHash: remote.previewHash
      })
    ).resolves.toBeNull();

    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: remote
      })
    ).resolves.toMatchObject({
      previewId: remote.previewId,
      previewHash: remote.previewHash
    });
    await expect(
      store.readAuthoritativePreview({
        ...fixture.identity,
        previewHash: remote.previewHash
      })
    ).resolves.toMatchObject({ previewId: remote.previewId });
    await expect(
      pool.query<{ live: boolean }>(
        `select expires_at > now() as live
           from collaboration_shared_memory_previews
          where preview_id = $1`,
        [remote.previewId]
      )
    ).resolves.toMatchObject({ rows: [{ live: true }] });
  });

  it("binds consent to the exact preview and enforces monotonic idempotent versions", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const { preview, remoteConsent, consent } =
      await persistPreviewAndConsent(fixture);
    await expect(
      store.persistAuthoritativeConsent({
        identity: fixture.identity,
        previewId: preview.previewId,
        consent: remoteConsent
      })
    ).resolves.toEqual(consent);
    await expect(
      store.persistAuthoritativeConsent({
        identity: fixture.identity,
        previewId: preview.previewId,
        consent: { ...remoteConsent, state: "revoked" }
      })
    ).resolves.toBeNull();
    await expect(
      store.persistAuthoritativeConsent({
        identity: fixture.identity,
        previewId: preview.previewId,
        consent: { ...remoteConsent, consentVersion: 3 }
      })
    ).resolves.toBeNull();
    await expect(
      store.persistAuthoritativeConsent({
        identity: fixture.identity,
        previewId: preview.previewId,
        consent: {
          ...remoteConsent,
          consentVersion: 2,
          previewHash: hash("8")
        }
      })
    ).resolves.toBeNull();

    const versionTwo = {
      ...remoteConsent,
      consentVersion: 2,
      updatedAt: "2026-07-17T09:01:00.000Z"
    };
    await expect(
      store.persistAuthoritativeConsent({
        identity: fixture.identity,
        previewId: preview.previewId,
        consent: versionTwo
      })
    ).resolves.toMatchObject({ consent: { version: 2 } });
    await expect(
      store.readAuthoritativeConsent({
        ...fixture.identity,
        consentId: remoteConsent.id
      })
    ).resolves.toMatchObject({ consent: { version: 2 } });
    await expect(
      store.readAuthoritativeConsent({
        ...fixture.otherOwnerIdentity,
        consentId: remoteConsent.id
      })
    ).resolves.toBeNull();

    const atRest = await pool.query<{ protected_dto: unknown }>(
      `select protected_dto
         from collaboration_shared_memory_consents
        where consent_id = $1`,
      [remoteConsent.id]
    );
    expect(JSON.stringify(atRest.rows)).not.toContain(
      remoteConsent.previewHash
    );
  });

  it("persists an explicit companion binding with the current grant and closes on revocation", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const { consent } = await persistPreviewAndConsent(fixture);
    const remoteGrant = grantFor(fixture, consent.consent.id);

    const first = await store.persistAuthoritativeGrant({
      identity: fixture.identity,
      grant: remoteGrant,
      prior: null,
      companion: companionFor(fixture)
    });
    expect(first).toMatchObject({
      grant: {
        id: remoteGrant.id,
        grantVersion: 1,
        companionThreadId: fixture.companionThreadId
      }
    });
    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: remoteGrant,
        prior: null,
        companion: companionFor(fixture)
      })
    ).resolves.toEqual(first);
    await expect(
      store.readSharedSessionBinding({
        ...fixture.identity,
        sharedSessionId: fixture.sharedSessionId
      })
    ).resolves.toEqual({
      ...fixture.identity,
      sharedSessionId: fixture.sharedSessionId,
      shareGrantId: remoteGrant.id,
      logicalMemoryId: fixture.logicalMemoryId,
      teamId: fixture.teamId,
      workspaceId: fixture.workspaceId,
      maximumFidelity: "memory_events",
      includeCuratedMemory: false
    });
    await expect(
      store.readSharedSessionBinding({
        ...fixture.wrongUpstreamIdentity,
        sharedSessionId: fixture.sharedSessionId
      })
    ).resolves.toBeNull();

    const versionTwo = grantFor(fixture, consent.consent.id, {
      ...remoteGrant,
      grantVersion: 2,
      updatedAt: "2026-07-17T09:02:00.000Z"
    });
    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: versionTwo,
        prior: { ...first!, grant: { ...first!.grant, sourceRevision: 999 } },
        companion: companionFor(fixture)
      })
    ).resolves.toBeNull();
    const second = await store.persistAuthoritativeGrant({
      identity: fixture.identity,
      grant: versionTwo,
      prior: first,
      companion: companionFor(fixture)
    });
    expect(second).toMatchObject({ grant: { grantVersion: 2 } });
    await expect(
      store.listAuthoritativeGrants({
        ...fixture.identity,
        logicalMemoryId: fixture.logicalMemoryId
      })
    ).resolves.toEqual([second]);
    const unavailableGrantId = randomUUID();
    await expect(
      store.readAuthoritativeGrants(fixture.identity, [
        unavailableGrantId,
        remoteGrant.id,
        remoteGrant.id
      ])
    ).resolves.toEqual([null, second, second]);
    await expect(
      store.listAuthoritativeGrants({
        ...fixture.otherOwnerIdentity,
        logicalMemoryId: fixture.logicalMemoryId
      })
    ).resolves.toBeNull();

    const revoked = grantFor(fixture, consent.consent.id, {
      ...versionTwo,
      grantVersion: 3,
      lifecycle: "revoked",
      updatedAt: "2026-07-17T09:03:00.000Z",
      revokedAt: "2026-07-17T09:03:00.000Z"
    });
    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: revoked,
        prior: second,
        companion: companionFor(fixture)
      })
    ).resolves.toMatchObject({ grant: { lifecycle: "revoked" } });
    await expect(
      store.listAuthoritativeGrants({
        ...fixture.identity,
        logicalMemoryId: fixture.logicalMemoryId
      })
    ).resolves.toMatchObject([{ grant: { lifecycle: "revoked" } }]);
    await expect(
      store.readSharedSessionBinding({
        ...fixture.identity,
        sharedSessionId: fixture.sharedSessionId
      })
    ).resolves.toBeNull();

    const atRest = await pool.query<{ protected_dto: unknown }>(
      `select protected_dto
         from collaboration_shared_memory_grants
        where share_grant_id = $1`,
      [remoteGrant.id]
    );
    expect(JSON.stringify(atRest.rows)).not.toContain(
      fixture.companionThreadId
    );
  });

  it("persists a grant that authorizes every supported representation", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const { consent } = await persistPreviewAndConsent(fixture);
    const sourceCapabilities = [
      "memory_events",
      "lcm_leaves",
      "lcm_rollups",
      "curated_assertions"
    ] as const;
    const remoteGrant = grantFor(fixture, consent.consent.id, {
      sourceCapabilities: [...sourceCapabilities]
    });

    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: remoteGrant,
        prior: null,
        companion: companionFor(fixture)
      })
    ).resolves.toMatchObject({
      grant: {
        id: remoteGrant.id,
        sourceCapabilities
      }
    });
  });

  it("durably persists the explicit companion binding before returning the grant", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const { consent } = await persistPreviewAndConsent(fixture);
    const remoteGrant = grantFor(fixture, consent.consent.id);
    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: remoteGrant,
        prior: null,
        companion: companionFor(fixture)
      })
    ).resolves.toMatchObject({
      grant: { companionThreadId: fixture.companionThreadId }
    });
    expect(
      await pool.query(
        `select 1
           from collaboration_shared_memory_companion_bindings
          where share_grant_id = $1 and shared_session_id = $2`,
        [remoteGrant.id, fixture.sharedSessionId]
      )
    ).toHaveProperty("rowCount", 1);
  });

  it("bootstraps and advances authenticated grant snapshots without weakening mutation sequencing", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const versionFour = grantFor(fixture, randomUUID(), {
      grantVersion: 4,
      updatedAt: "2026-07-17T09:04:00.000Z"
    });
    const first = await store.persistAuthoritativeGrant({
      identity: fixture.identity,
      grant: versionFour,
      prior: null,
      mode: "authoritative_snapshot",
      companion: companionFor(fixture)
    });
    expect(first).toMatchObject({ grant: { grantVersion: 4 } });

    const versionSeven = grantFor(fixture, versionFour.consentId, {
      ...versionFour,
      grantVersion: 7,
      lifecycle: "unavailable",
      updatedAt: "2026-07-17T09:07:00.000Z"
    });
    const second = await store.persistAuthoritativeGrant({
      identity: fixture.identity,
      grant: versionSeven,
      prior: first,
      mode: "authoritative_snapshot",
      companion: companionFor(fixture)
    });
    expect(second).toMatchObject({
      grant: { grantVersion: 7, lifecycle: "unavailable" }
    });

    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: { ...versionSeven, grantVersion: 9 },
        prior: second,
        companion: companionFor(fixture)
      })
    ).resolves.toBeNull();
    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: { ...versionSeven, grantVersion: 6 },
        prior: second,
        mode: "authoritative_snapshot",
        companion: companionFor(fixture)
      })
    ).resolves.toBeNull();
  });

  it.each([11, 4])(
    "refreshes only monotonic metadata at source revision %s within an active grant version",
    async (sourceRevision) => {
      const fixture = await createFixture();
      await bindFixture(fixture);
      const initial = grantFor(fixture, randomUUID(), {
        grantVersion: 4,
        sourceRevision: 4,
        updatedAt: "2026-07-17T09:04:00.000Z"
      });
      const first = await store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: initial,
        prior: null,
        mode: "authoritative_snapshot",
        companion: companionFor(fixture)
      });
      expect(first).toMatchObject({
        grant: { grantVersion: 4, sourceRevision: 4 }
      });

      const refreshed = grantFor(fixture, initial.consentId, {
        ...initial,
        sourceRevision,
        updatedAt: "2026-07-17T09:11:00.000Z"
      });
      const second = await store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: refreshed,
        prior: first,
        mode: "authoritative_snapshot",
        companion: companionFor(fixture)
      });
      expect(second).toMatchObject({
        grant: { grantVersion: 4, sourceRevision }
      });
      await expect(
        store.readAuthoritativeGrant({
          ...fixture.identity,
          shareGrantId: initial.id
        })
      ).resolves.toEqual(second);
      expect(
        await pool.query(
          `select 1
           from collaboration_shared_memory_grants
          where share_grant_id = $1`,
          [initial.id]
        )
      ).toHaveProperty("rowCount", 1);

      await expect(
        store.persistAuthoritativeGrant({
          identity: fixture.identity,
          grant: {
            ...refreshed,
            sourceRevision: 12,
            fidelityPolicyRevision: refreshed.fidelityPolicyRevision + 1,
            updatedAt: "2026-07-17T09:12:00.000Z"
          },
          prior: second,
          mode: "authoritative_snapshot",
          companion: companionFor(fixture)
        })
      ).resolves.toBeNull();
      await expect(
        store.persistAuthoritativeGrant({
          identity: fixture.identity,
          grant: {
            ...refreshed,
            sourceRevision: sourceRevision - 1,
            updatedAt: "2026-07-17T09:13:00.000Z"
          },
          prior: second,
          mode: "authoritative_snapshot",
          companion: companionFor(fixture)
        })
      ).resolves.toBeNull();
      for (const changed of [
        { mode: "snapshot" as const },
        { updatedAt: "2026-07-17T09:10:00.000Z" }
      ]) {
        await expect(
          store.persistAuthoritativeGrant({
            identity: fixture.identity,
            grant: {
              ...refreshed,
              updatedAt: "2026-07-17T09:12:00.000Z",
              ...changed
            },
            prior: second,
            mode: "authoritative_snapshot",
            companion: companionFor(fixture)
          })
        ).resolves.toBeNull();
      }
      await expect(
        store.persistAuthoritativeGrant({
          identity: fixture.identity,
          grant: {
            ...refreshed,
            sourceRevision: 12,
            updatedAt: "2026-07-17T09:12:00.000Z"
          },
          prior: second,
          companion: companionFor(fixture)
        })
      ).resolves.toBeNull();
    }
  );

  it("persists a strict revocation after snapshot reconciliation without local consent history", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const snapshot = grantFor(fixture, randomUUID(), {
      grantVersion: 4,
      updatedAt: "2026-07-17T09:04:00.000Z"
    });
    const first = await store.persistAuthoritativeGrant({
      identity: fixture.identity,
      grant: snapshot,
      prior: null,
      mode: "authoritative_snapshot",
      companion: companionFor(fixture)
    });
    expect(first).toMatchObject({ grant: { grantVersion: 4 } });

    const revoked = grantFor(fixture, snapshot.consentId, {
      ...snapshot,
      grantVersion: 5,
      lifecycle: "revoked",
      updatedAt: "2026-07-17T09:05:00.000Z",
      revokedAt: "2026-07-17T09:05:00.000Z"
    });
    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: revoked,
        prior: first,
        mode: "revocation",
        companion: companionFor(fixture)
      })
    ).resolves.toMatchObject({
      grant: { grantVersion: 5, lifecycle: "revoked" }
    });
    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: { ...revoked, grantVersion: 7 },
        prior: first,
        mode: "revocation",
        companion: companionFor(fixture)
      })
    ).resolves.toBeNull();
    await expect(
      store.persistAuthoritativeGrant({
        identity: fixture.identity,
        grant: { ...snapshot, grantVersion: 6 },
        prior: first,
        mode: "revocation",
        companion: companionFor(fixture)
      })
    ).resolves.toBeNull();
  });

  it("fails closed on ciphertext tampering, encryption outage, and enrollment revocation", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const remote = previewFor(fixture);
    const unavailableProvider: EnvelopeEncryptionProvider = {
      ...provider,
      encrypt: async () => {
        throw new Error("encryption unavailable");
      },
      decrypt: provider.decrypt.bind(provider),
      rewrap: provider.rewrap?.bind(provider)
    };
    const unavailableStore = createCollaborationSharedMemoryAuthorityStore(
      pool,
      {
        envelopeEncryptionProvider: unavailableProvider
      }
    );
    await expect(
      unavailableStore.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: remote
      })
    ).rejects.toThrow("encryption unavailable");
    expect(
      await pool.query("select 1 from collaboration_shared_memory_previews")
    ).toHaveProperty("rowCount", 0);

    const persisted = await store.persistAuthoritativePreview({
      identity: fixture.identity,
      preview: remote
    });
    expect(persisted).not.toBeNull();
    await pool.query(
      `update collaboration_shared_memory_previews
          set protected_dto = jsonb_set(protected_dto, '{ciphertext}', '"tampered"')
        where preview_id = $1`,
      [remote.previewId]
    );
    await expect(
      store.readAuthoritativePreview({
        ...fixture.identity,
        previewHash: remote.previewHash
      })
    ).resolves.toBeNull();

    await expect(
      store.revokeEnrollment({
        ...fixture.identity,
        reason: "identity switched"
      })
    ).resolves.toBe(true);
    await expect(store.isEnrollmentBound(fixture.identity)).resolves.toBe(
      false
    );
    await expect(
      store.readAuthoritativePreview({
        ...fixture.identity,
        previewHash: remote.previewHash
      })
    ).resolves.toBeNull();
  });

  it("revokes only the disconnected owner's backend authority and companion bindings", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    expect(
      await store.bindCompanionSession({
        identity: fixture.identity,
        shareGrantId: randomUUID(),
        logicalMemoryId: fixture.logicalMemoryId,
        teamId: fixture.teamId,
        workspaceId: fixture.workspaceId,
        companionThreadId: fixture.companionThreadId,
        sharedSessionId: fixture.sharedSessionId
      })
    ).toBe(true);
    expect(
      await store.bindEnrollment({
        identity: fixture.otherOwnerIdentity,
        remoteDeviceId: randomUUID()
      })
    ).toBe(true);

    await expect(
      store.revokeBackendEnrollments({
        backendId: fixture.identity.backendId,
        localOwnerUserId: fixture.identity.localOwnerUserId,
        reason: "upstream backend disconnected"
      })
    ).resolves.toBe(1);
    await expect(store.isEnrollmentBound(fixture.identity)).resolves.toBe(
      false
    );
    await expect(
      store.isEnrollmentBound(fixture.otherOwnerIdentity)
    ).resolves.toBe(true);
    const state = await pool.query<{
      enrollment_revoked: boolean;
      companion_revoked: boolean;
    }>(
      `select enrollment.revoked_at is not null as enrollment_revoked,
              binding.revoked_at is not null as companion_revoked
         from collaboration_shared_memory_enrollments enrollment
         join collaboration_shared_memory_companion_bindings binding
           on binding.enrollment_id = enrollment.id
        where enrollment.backend_id = $1
          and enrollment.local_owner_user_id = $2`,
      [fixture.identity.backendId, fixture.identity.localOwnerUserId]
    );
    expect(state.rows).toEqual([
      { enrollment_revoked: true, companion_revoked: true }
    ]);
    await expect(
      store.revokeBackendEnrollments({
        backendId: fixture.identity.backendId,
        localOwnerUserId: fixture.identity.localOwnerUserId,
        reason: "replayed disconnect"
      })
    ).resolves.toBe(0);
  });

  it("serializes protected reads with concurrent enrollment revocation", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const remote = previewFor(fixture);
    expect(
      await store.persistAuthoritativePreview({
        identity: fixture.identity,
        preview: remote
      })
    ).not.toBeNull();

    let markDecryptStarted!: () => void;
    const decryptStarted = new Promise<void>((resolve) => {
      markDecryptStarted = resolve;
    });
    let releaseDecrypt!: () => void;
    const decryptReleased = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    const decrypt = provider.decrypt.bind(provider);
    const gatedStore = createCollaborationSharedMemoryAuthorityStore(pool, {
      envelopeEncryptionProvider: {
        ...provider,
        encrypt: provider.encrypt.bind(provider),
        decrypt: async (envelope) => {
          markDecryptStarted();
          await decryptReleased;
          return decrypt(envelope);
        },
        rewrap: provider.rewrap?.bind(provider)
      }
    });

    const read = gatedStore.readAuthoritativePreview({
      ...fixture.identity,
      previewHash: remote.previewHash
    });
    await decryptStarted;
    let revocationFinished = false;
    const revocation = store
      .revokeEnrollment({ ...fixture.identity, reason: "concurrent switch" })
      .then((result) => {
        revocationFinished = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(revocationFinished).toBe(false);

    releaseDecrypt();
    await expect(read).resolves.not.toBeNull();
    await expect(revocation).resolves.toBe(true);
    await expect(
      store.readAuthoritativePreview({
        ...fixture.identity,
        previewHash: remote.previewHash
      })
    ).resolves.toBeNull();
  });
  it.each(["exclude", "restore"] as const)(
    "recovers encrypted Workspace %s with exact source, owner and receipt binding",
    async (operation) => {
      const fixture = await createFixture();
      await store.bindEnrollment({
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId
      });
      const baseIntent = {
        mutationId: randomUUID(),
        scope: {
          ownerUserId: fixture.identity.upstreamUserId,
          logicalMemoryId: fixture.logicalMemoryId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.workspaceId,
          expectedExclusionVersion: operation === "restore" ? 1 : 0,
          shareGrantId: null,
          expectedGrantVersion: null
        }
      };
      const intent =
        operation === "restore"
          ? {
              ...baseIntent,
              restoration: {
                scope: baseIntent.scope,
                source: {
                  logicalMemoryId: fixture.logicalMemoryId,
                  title: "Private source title"
                },
                team: { id: fixture.teamId, name: "Engineering" },
                workspace: { id: fixture.workspaceId, name: "Platform" },
                exclusion: {
                  id: randomUUID(),
                  ownerUserId: fixture.identity.upstreamUserId,
                  logicalMemoryId: fixture.logicalMemoryId,
                  teamId: fixture.teamId,
                  teamWorkspaceId: fixture.workspaceId,
                  version: 1,
                  state: "excluded" as const,
                  excludedAt: timestamp,
                  restoredAt: null,
                  updatedAt: timestamp
                },
                rules: [],
                authorityHash: hash("a"),
                reviewHash: hash("b"),
                expiresAt: "2099-01-01T00:00:00.000Z"
              }
            }
          : baseIntent;
      const request = {
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId,
        requestId: randomUUID(),
        actionGrantId: randomUUID(),
        actionGrant: "hrg_approved_secret_for_exact_exclusion_000000",
        intent,
        presentation: {
          sourceTitle: "Private source title",
          teamName: "Engineering",
          workspaceName: "Platform"
        }
      };
      expect((await store.persistRuleDelivery(request))?.state).toBe("queued");
      const raw = await pool.query(
        "select * from collaboration_sharing_rule_deliveries"
      );
      expect(raw.rows[0]).toMatchObject({
        rule_id: null,
        operation_kind:
          operation === "restore" ? "workspace_restore" : "workspace_exclude",
        source_logical_memory_id: fixture.logicalMemoryId,
        team_workspace_id: fixture.workspaceId
      });
      expect(JSON.stringify(raw.rows)).not.toContain(request.actionGrant);
      expect(JSON.stringify(raw.rows)).not.toContain(
        request.presentation.sourceTitle
      );
      const restarted = createCollaborationSharedMemoryAuthorityStore(pool, {
        envelopeEncryptionProvider: provider
      });
      expect(
        (
          await restarted.persistRuleDelivery({
            ...request,
            actionGrant: null,
            presentation: null
          })
        )?.state
      ).toBe("queued");
      expect(
        await restarted.persistRuleDelivery({
          ...request,
          intent:
            "restoration" in intent
              ? {
                  ...intent,
                  restoration: { ...intent.restoration, reviewHash: hash("c") }
                }
              : {
                  ...intent,
                  scope: { ...intent.scope, logicalMemoryId: randomUUID() }
                }
        })
      ).toBeNull();
      expect(
        await restarted.listRuleDeliveries(fixture.otherOwnerIdentity)
      ).toBeNull();
      const [lease] = await restarted.claimRuleDeliveries({
        localOwnerUserId: fixture.identity.localOwnerUserId
      });
      expect(lease?.intent).toEqual(intent);
      const exclusion = {
        id: randomUUID(),
        ownerUserId: intent.scope.ownerUserId,
        logicalMemoryId: intent.scope.logicalMemoryId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.workspaceId,
        version: operation === "restore" ? 2 : 1,
        state:
          operation === "restore"
            ? ("restored" as const)
            : ("excluded" as const),
        excludedAt: timestamp,
        restoredAt: operation === "restore" ? timestamp : null,
        updatedAt: timestamp
      };
      await expect(
        restarted.finishRuleDelivery({
          ...lease!,
          outcome: "acknowledged",
          exclusion: { ...exclusion, logicalMemoryId: randomUUID() }
        })
      ).rejects.toThrow();
      expect(
        (
          await restarted.finishRuleDelivery({
            ...lease!,
            outcome: "acknowledged",
            exclusion
          })
        )?.exclusion
      ).toEqual(exclusion);
      expect(await restarted.claimRuleDeliveries()).toEqual([]);
      expect(
        (
          await restarted.persistRuleDelivery({
            ...request,
            actionGrant: null,
            presentation: null
          })
        )?.exclusion
      ).toEqual(exclusion);
    }
  );
  it("recovers encrypted rule controls across restart and fences expired worker leases", async () => {
    const fixture = await createFixture();
    await store.bindEnrollment({
      identity: fixture.identity,
      remoteDeviceId: fixture.remoteDeviceId
    });
    const intent = {
      mutationId: randomUUID(),
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.workspaceId,
      shareGrantId: randomUUID(),
      ruleId: randomUUID(),
      reasonId: randomUUID(),
      expectedAuthorityVersion: 2,
      expectedGrantVersion: 4,
      controlAction: "stop" as const
    };
    const request = {
      identity: fixture.identity,
      remoteDeviceId: fixture.remoteDeviceId,
      requestId: randomUUID(),
      actionGrantId: randomUUID(),
      actionGrant: "hrg_approved_secret_for_exact_stop_000000",
      intent,
      presentation: {
        sourceTitle: "Private Conversation title",
        teamName: "Engineering",
        workspaceName: "Platform"
      }
    };
    expect((await store.persistRuleDelivery(request))?.state).toBe("queued");
    const raw = await pool.query(
      "select * from collaboration_sharing_rule_deliveries"
    );
    expect(JSON.stringify(raw.rows)).not.toContain(request.actionGrant);
    expect(JSON.stringify(raw.rows)).not.toContain(
      request.presentation.sourceTitle
    );
    const restarted = createCollaborationSharedMemoryAuthorityStore(pool, {
      envelopeEncryptionProvider: provider
    });
    // Exact observation must survive loss or expiry of the original approval custody entry.
    expect(
      (
        await restarted.persistRuleDelivery({
          ...request,
          actionGrant: null,
          presentation: null
        })
      )?.state
    ).toBe("queued");
    expect(
      await restarted.persistRuleDelivery({
        ...request,
        intent: { ...intent, controlAction: "pause" }
      })
    ).toBeNull();
    expect(
      await restarted.persistRuleDelivery({
        ...request,
        intent: { ...intent, mutationId: randomUUID() }
      })
    ).toBeNull();
    expect(
      await restarted.listRuleDeliveries(fixture.otherOwnerIdentity)
    ).toBeNull();
    expect(
      await restarted.claimRuleDeliveries({
        localOwnerUserId: fixture.otherOwnerIdentity.localOwnerUserId
      })
    ).toEqual([]);
    const [first] = await restarted.claimRuleDeliveries({
      localOwnerUserId: fixture.identity.localOwnerUserId
    });
    expect(first?.actionGrant).toBe(request.actionGrant);
    expect(await restarted.claimRuleDeliveries()).toEqual([]);
    await pool.query(
      "update collaboration_sharing_rule_deliveries set locked_at=now()-interval '6 minutes'"
    );
    const [second] = await restarted.claimRuleDeliveries();
    expect(second!.leaseVersion).toBeGreaterThan(first!.leaseVersion);
    const receipt = {
      ruleId: intent.ruleId,
      reasonId: intent.reasonId,
      shareGrantId: intent.shareGrantId,
      state: "stopped" as const,
      authorityVersion: 3,
      consentVersion: 2,
      grantVersion: 5,
      publisherFence: 2,
      catchUpState: "idle" as const
    };
    await expect(
      restarted.finishRuleDelivery({
        ...first!,
        outcome: "acknowledged",
        control: receipt
      })
    ).resolves.toBeNull();
    await expect(
      restarted.finishRuleDelivery({
        ...second!,
        outcome: "acknowledged",
        control: { ...receipt, state: "active" }
      })
    ).rejects.toThrow();
    expect(
      (
        await restarted.finishRuleDelivery({
          ...second!,
          outcome: "acknowledged",
          control: receipt
        })
      )?.state
    ).toBe("acknowledged");
    expect(await restarted.claimRuleDeliveries()).toEqual([]);
    expect(
      (
        await restarted.listRuleDeliveries({
          ...fixture.identity,
          shareGrantId: intent.shareGrantId
        })
      )?.[0]?.control
    ).toEqual(receipt);
    expect(
      (
        await restarted.persistRuleDelivery({
          ...request,
          actionGrant: null,
          presentation: null
        })
      )?.state
    ).toBe("acknowledged");
    // An additional approved request loses its encrypted credentials when enrollment ends.
    const next = {
      ...request,
      intent: { ...intent, mutationId: randomUUID(), ruleId: randomUUID() }
    };
    await restarted.persistRuleDelivery(next);
    await restarted.revokeEnrollment({
      ...fixture.identity,
      reason: "owner disconnected"
    });
    expect(await restarted.claimRuleDeliveries()).toEqual([]);
    const revoked = await pool.query(
      "select protected_dto,state from collaboration_sharing_rule_deliveries where mutation_id=$1",
      [next.intent.mutationId]
    );
    expect(revoked.rows[0]).toEqual({
      protected_dto: null,
      state: "needs_review"
    });
  });
  it.each(
    (["repository", "folder", "project"] as const).flatMap((selectionKind) =>
      (["expired", "unavailable"] as const).map((cursorFailure) => ({
        selectionKind,
        cursorFailure
      }))
    )
  )(
    "recovers encrypted $selectionKind creation after $cursorFailure history without inventing a source grant",
    async ({ selectionKind, cursorFailure }) => {
      const fixture = await createFixture();
      await store.bindEnrollment({
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId
      });
      const personal = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const localOwner = { userId: fixture.identity.localOwnerUserId };
      const privateProject =
        selectionKind === "project"
          ? await personal.createNamedPersonalProject(localOwner, {
              name: "PRIVATE PROJECT NAME"
            })
          : null;
      const intent = repositorySharingRuleCreationLocalIntentSchema.parse({
        mutationId: randomUUID(),
        ruleId: randomUUID(),
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.workspaceId,
        selector: {
          kind: "portable_repository",
          key: "gr_private_delivery_anchor"
        },
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false,
        includesFutureConversations: true,
        selectionSnapshotVersion: randomUUID(),
        completedReviewHash: hash("a"),
        teamPolicyVersion: 1,
        teamPolicyHash: hash("b"),
        workspacePolicyVersion: 2,
        workspacePolicyHash: hash("c"),
        effectivePrivacyPolicyHash: hash("d"),
        review: {
          teamId: fixture.teamId,
          workspaceId: fixture.workspaceId,
          representation: "lcm_rollups",
          completionToken: "gsc1_owner_private_review",
          target: {
            kind: "repository",
            repository: {
              kind: "portable_repository",
              key: "gr_private_delivery_anchor",
              root: "/private/delivery-anchor",
              branch: null,
              reason: "origin",
              checkoutId: null,
              originatingDeviceId: "capture-device",
              selectedRemote: "origin",
              anchorDisplay: "Private anchor"
            }
          }
        }
      });
      const repositoryTarget = intent.review.target;
      if (repositoryTarget.kind !== "repository")
        throw new Error("Expected Git Anchor fixture");
      const folderReference = {
        ownerUserId: fixture.identity.localOwnerUserId,
        folderId: randomUUID(),
        originatingDeploymentId: randomUUID(),
        originatingDeviceId: "capture-device",
        originatingProfileId: "capture-profile",
        directoryIncarnationId: randomUUID()
      };
      if (selectionKind === "folder") {
        intent.review.target = { kind: "folder", folder: folderReference };
        intent.selector = sharingSelectionDescriptor(intent.review.target);
      }
      if (privateProject) {
        intent.review.target = {
          kind: "project",
          project: {
            ownerUserId: localOwner.userId,
            projectId: privateProject.projectId
          }
        };
        intent.selector = sharingSelectionDescriptor(intent.review.target);
      }
      const request = {
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId,
        requestId: randomUUID(),
        actionGrantId: randomUUID(),
        actionGrant: "hrg_private_repository_creation_000000",
        intent,
        presentation: {
          sourceTitle: "Private Git Anchor",
          teamName: "Team",
          workspaceName: "Workspace"
        }
      };
      expect((await store.persistRuleDelivery(request))?.state).toBe("queued");
      const raw = await pool.query(
        "select * from collaboration_sharing_rule_deliveries where mutation_id=$1",
        [intent.mutationId]
      );
      expect(raw.rows[0]).toMatchObject({
        operation_kind: "repository_create",
        share_grant_id: null,
        logical_grant_id: null
      });
      for (const secret of [
        request.actionGrant,
        intent.selector.key,
        intent.review.completionToken,
        "/private/delivery-anchor"
      ])
        expect(JSON.stringify(raw.rows)).not.toContain(secret);
      const restarted = createCollaborationSharedMemoryAuthorityStore(pool, {
        envelopeEncryptionProvider: provider
      });
      const [work] = await restarted.claimRuleDeliveries();
      expect(work?.intent).toEqual(intent);
      await expect(
        restarted.finishRuleDelivery({
          ...work!,
          outcome: "acknowledged",
          creation: { pendingShareId: randomUUID(), sourceRevision: 1 }
        })
      ).rejects.toThrow();
      const receipt = {
        ruleId: intent.ruleId,
        state: "active" as const,
        authorityVersion: 1 as const,
        publisherFence: 1 as const
      };
      expect(
        (
          await restarted.finishRuleDelivery({
            ...work!,
            outcome: "acknowledged",
            creation: receipt
          })
        )?.creation
      ).toEqual(receipt);
      expect(await restarted.claimRuleDeliveries()).toEqual([]);
      expect(
        (
          await restarted.persistRuleDelivery({
            ...request,
            actionGrant: null,
            presentation: null
          })
        )?.creation
      ).toEqual(receipt);
      expect(
        await restarted.persistRuleDelivery({
          ...request,
          intent: {
            ...intent,
            review: {
              ...intent.review,
              target: {
                ...repositoryTarget,
                repository: {
                  ...repositoryTarget.repository,
                  root: "/private/substituted"
                }
              }
            }
          }
        })
      ).toBeNull();

      const approvedAt = new Date().toISOString();
      const detailMutationId = randomUUID();
      const detailScope = sharingRuleDetailAppliedScopeSchema.parse({
        approvedAt,
        review: {
          ruleId: intent.ruleId,
          teamId: intent.teamId,
          teamWorkspaceId: intent.teamWorkspaceId,
          selectorKind: selectionKind,
          state: "active",
          previousMaximumFidelity: "lcm_rollups",
          previousIncludeCuratedMemory: false,
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          expectedAuthorityVersion: 1,
          publisherFence: 1,
          teamPolicyVersion: intent.teamPolicyVersion,
          teamPolicyHash: intent.teamPolicyHash,
          workspacePolicyVersion: intent.workspacePolicyVersion,
          workspacePolicyHash: intent.workspacePolicyHash,
          effectivePrivacyPolicyHash: intent.effectivePrivacyPolicyHash,
          policyBindingHash: hash("a"),
          memberBindingHash: hash("b"),
          memberCount: 0,
          ownerPolicyExpansionCount: 0,
          disclosureIncrease: true,
          teamName: "Team",
          workspaceName: "Workspace",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          reviewHash: hash("c")
        },
        result: {
          mutationId: detailMutationId,
          approvedAt,
          ruleId: intent.ruleId,
          state: "active",
          authorityVersion: 2,
          publisherFence: 1,
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          memberCount: 0
        }
      });
      const detailRequest = {
        ...request,
        requestId: randomUUID(),
        actionGrantId: randomUUID(),
        intent: {
          operationKind: "detail" as const,
          mutationId: detailMutationId,
          ruleId: intent.ruleId,
          teamId: intent.teamId,
          teamWorkspaceId: intent.teamWorkspaceId,
          review: detailScope.review
        }
      };
      expect((await restarted.persistRuleDelivery(detailRequest))?.state).toBe(
        "queued"
      );
      const [detailWork] = await restarted.claimRuleDeliveries();
      await expect(
        restarted.finishRuleDelivery({
          ...detailWork!,
          outcome: "acknowledged",
          detailAmendment: {
            ...detailScope,
            result: { ...detailScope.result, mutationId: randomUUID() }
          }
        })
      ).rejects.toThrow();
      expect(
        (
          await restarted.finishRuleDelivery({
            ...detailWork!,
            outcome: "acknowledged",
            detailAmendment: detailScope
          })
        )?.detailAmendment
      ).toEqual(detailScope);
      expect(
        (
          await restarted.persistRuleDelivery({
            ...detailRequest,
            actionGrant: null,
            presentation: null
          })
        )?.detailAmendment
      ).toEqual(detailScope);
      const detailRows = await pool.query<{
        operation_kind: string;
        protected_dto: unknown;
      }>(
        "select operation_kind,protected_dto from collaboration_sharing_rule_deliveries where mutation_id=$1",
        [detailMutationId]
      );
      expect(detailRows.rows[0]?.operation_kind).toBe("detail");
      expect(JSON.stringify(detailRows.rows)).not.toContain(
        detailScope.review.reviewHash
      );

      const journal = createSelectionSharingJournal(pool, provider);
      if (privateProject) {
        expect(
          await journal.resolveSharingSelectionTarget({
            ownerUserId: localOwner.userId,
            target: intent.review.target
          })
        ).toEqual(intent.review.target);
        const identity = `pending-catalog-${randomUUID()}`;
        await pool.query(
          `insert into personal_membership_entities(owner_user_id,project_identity,entity_identity,entity_kind,local_project_id)
          values($1,$2,$2,'project',$3)`,
          [localOwner.userId, identity, privateProject.projectId]
        );
        expect(
          await journal.resolveSharingSelectionTarget({
            ownerUserId: localOwner.userId,
            target: intent.review.target
          })
        ).toBeNull();
        await pool.query(
          "delete from personal_membership_entities where owner_user_id=$1 and project_identity=$2",
          [localOwner.userId, identity]
        );
        expect(
          await journal.resolveSharingSelectionTarget({
            ownerUserId: localOwner.userId,
            target: intent.review.target
          })
        ).toEqual(intent.review.target);
      }
      const session = await personal.createCapturedSession(localOwner, {
        externalSessionId: randomUUID(),
        repositoryIdentity: repositoryTarget.repository,
        folderObservation: {
          identity: {
            folderId: folderReference.folderId,
            originatingDeploymentId: folderReference.originatingDeploymentId,
            originatingDeviceId: folderReference.originatingDeviceId,
            originatingProfileId: folderReference.originatingProfileId,
            directoryIncarnationId: folderReference.directoryIncarnationId
          },
          capturedPath: "/private/delivery-anchor",
          normalizedPath: "/private/delivery-anchor",
          observedAt: new Date().toISOString()
        }
      });
      const nativeContextClient = await pool.connect();
      try {
        await nativeContextClient.query("begin");
        await preparePersonalSourceContextSnapshot(nativeContextClient, {
          ownerUserId: localOwner.userId,
          localSessionId: session.id,
          originatingDeploymentId: "private-personal-origin",
          originatingDeviceId: "private-personal-device"
        });
        await nativeContextClient.query("commit");
      } catch (error) {
        await nativeContextClient.query("rollback");
        throw error;
      } finally {
        nativeContextClient.release();
      }
      let projectVersion = privateProject?.version ?? 0;
      let directInclusion: string | null = null;
      let expectedEntries = 1;
      if (privateProject) {
        const direct = await personal.addPersonalProjectSession(
          localOwner,
          privateProject.projectId,
          { sessionId: session.id, expectedVersion: projectVersion }
        );
        directInclusion = direct.membership.inclusionId;
        const git = await personal.addPersonalProjectRepositoryRule(
          localOwner,
          privateProject.projectId,
          {
            repository: repositoryTarget.repository,
            expectedVersion: direct.project.version
          }
        );
        const folder = await personal.addPersonalProjectFolderRule(
          localOwner,
          privateProject.projectId,
          { folder: folderReference, expectedVersion: git.project.version }
        );
        projectVersion = folder.project.version;
        expectedEntries = 3;
      }
      const installBaseline = async () => {
        const page = await personal.startPersonalSelectionEnumeration(
          localOwner,
          {
            target: intent.review.target
          }
        );
        expect(page.nextCursor).toBeNull();
        expect(page.entries).toHaveLength(expectedEntries);
        const [enumerating] = await journal.claim(localOwner.userId);
        await journal.appendPage(enumerating!, page);
        const [present] = await journal.claim(localOwner.userId);
        await journal.stagePresentPage(present!);
        const [missing] = await journal.claim(localOwner.userId);
        const known = await journal.readMissing(missing!);
        expect(known.entries).toEqual([]);
        await journal.stageMissing(missing!, []);
        const [ready] = await journal.claim(localOwner.userId);
        await journal.commit(ready!);
        return page;
      };
      const initialBaseline = await installBaseline();
      const [source] = await journal.claimSources(localOwner.userId);
      expect(source?.goal.source.localSessionId).toBe(session.id);
      expect(source?.progress.intent).toEqual(intent);
      expect(source?.progress.detailAmendment).toEqual(detailScope);
      expect(
        selectionSharingEffectiveIntent(source!.progress).maximumFidelity
      ).toBe("lcm_leaves");
      const sourceDeploymentId = folderReference.originatingDeploymentId;
      const nativeSource = {
        sessionId: session.id,
        logicalMemoryId: crossIdentitySyncDeterministicUuid({
          protocol: "koed.captured-session-sync/v2",
          sourceDeploymentId,
          sourceUserId: localOwner.userId,
          originSessionId: session.id,
          identity: "logical-memory"
        })
      };
      expect(
        await journal.resolveNativeSource(source!, sourceDeploymentId)
      ).toEqual(nativeSource);
      expect(await journal.resolveExistingSource(source!)).toBeNull();
      expect(
        await journal.resolveNativeConversationSource({
          ownerUserId: localOwner.userId,
          sessionId: session.id,
          deploymentProtocolId: sourceDeploymentId
        })
      ).toEqual({
        logicalMemoryId: nativeSource.logicalMemoryId,
        sourceIdentity: {
          originatingDeploymentId:
            source!.goal.source.portable!.originatingDeploymentId,
          originatingDeviceId:
            source!.goal.source.portable!.originatingDeviceId,
          logicalSessionId: source!.goal.source.portable!.logicalSessionId
        }
      });

      expect(
        await journal.resolvePublisherTakeoverSource({
          ownerUserId: localOwner.userId,
          sessionId: session.id
        })
      ).toMatchObject({
        source: { localSessionId: session.id, identityState: "verified" },
        sourceIdentity: {
          originatingDeploymentId:
            source!.goal.source.portable!.originatingDeploymentId,
          originatingDeviceId:
            source!.goal.source.portable!.originatingDeviceId,
          logicalSessionId: source!.goal.source.portable!.logicalSessionId
        }
      });
      const bindings = await journal.readPublisherTakeoverSourceBindings({
        ownerUserId: localOwner.userId
      });
      expect(bindings.entries).toHaveLength(1);
      expect(bindings.entries[0]!.source).toEqual(source!.goal.source);
      expect(bindings.nextAfterBindingId).toBeNull();
      expect(
        await journal.readPublisherTakeoverSourceBindings({
          ownerUserId: localOwner.userId,
          afterBindingId: bindings.entries[0]!.bindingId
        })
      ).toEqual({ entries: [], nextAfterBindingId: null });
      expect(
        await journal.readPublisherTakeoverSourceBindings({
          ownerUserId: randomUUID()
        })
      ).toEqual({ entries: [], nextAfterBindingId: null });
      const mutationId = randomUUID(),
        logicalMemoryId = randomUUID(),
        membershipId = randomUUID();
      const body = { mutationId, sourceContextHash: source!.goal.contextHash };
      const attempt: SelectionSharingAttempt = {
        mutationId,
        logicalMemoryId,
        membershipId,
        body,
        kind: "context",
        goalHash: source!.goalHash,
        deliveryEpoch: source!.deliveryEpoch,
        requestHash: crossIdentitySyncDigest({
          kind: "context",
          logicalMemoryId,
          membershipId,
          body
        })
      };
      await journal.persistAttempt(source!, attempt);
      // An outage can outlive the Personal selection checkpoint. Recovery
      // must leave this ambiguous remote write intact and start a fresh scan.
      const outageRecovery = createSelectionSharingReconciliation(
        pool,
        provider
      );
      const clock =
        cursorFailure === "expired"
          ? vi
              .spyOn(Date, "now")
              .mockReturnValue(Date.now() + 25 * 60 * 60 * 1000)
          : null;
      if (cursorFailure === "unavailable") {
        await pool.query(
          "delete from personal_selection_cursors where cursor_id=$1",
          [initialBaseline.changeCursor]
        );
      }
      try {
        expect(await outageRecovery.reconcile(localOwner.userId, 1)).toEqual({
          advanced: 0,
          failures: [
            {
              progressId: source!.progressId,
              code: `selection_cursor_${cursorFailure}`
            }
          ]
        });
      } finally {
        clock?.mockRestore();
      }
      const [reset] = await journal.claim(localOwner.userId);
      expect(reset?.data.currentGeneration).toBe(
        source!.progress.currentGeneration
      );
      expect(reset?.data.changeCursor).toBeNull();
      expect(reset?.data.proposal).toBeNull();
      expect(
        (await journal.readSourceState(fixture.identity, source!.sourceId))
          ?.attempt
      ).toEqual(attempt);
      await journal.abandon(reset!);
      for (let phase = 0; phase < 4; phase++) {
        expect(await outageRecovery.reconcile(localOwner.userId, 1)).toEqual({
          advanced: 1,
          failures: []
        });
      }
      expect(
        (await journal.readSourceState(fixture.identity, source!.sourceId))
          ?.attempt
      ).toEqual(attempt);
      if (privateProject && directInclusion) {
        projectVersion = (
          await personal.removePersonalProjectInclusion(
            localOwner,
            privateProject.projectId,
            directInclusion,
            { expectedVersion: projectVersion }
          )
        ).project.version;
        expectedEntries = 2;
        await installBaseline();
        const retained = await journal.readSourceState(
          fixture.identity,
          source!.sourceId
        );
        expect(retained?.proposed?.desired).toBe("present");
        expect(retained?.proposed?.source).toEqual(source!.goal.source);
      }
      if (selectionKind === "folder" || selectionKind === "project") {
        const correction = await personal.previewPersonalSourceCorrection(
          localOwner,
          session.id,
          {
            axis: "folder",
            action: "reset",
            expectedVersion: 1
          }
        );
        await personal.applyPersonalSourceCorrection(
          localOwner,
          session.id,
          correction.preview.reviewId,
          { expectedVersion: 1 }
        );
      } else {
        const correction = await personal.previewPersonalSourceCorrection(
          localOwner,
          session.id,
          {
            axis: "git",
            action: "set",
            repository: {
              ...repositoryTarget.repository,
              branch: "after-correction"
            },
            expectedVersion: 1
          }
        );
        await personal.applyPersonalSourceCorrection(
          localOwner,
          session.id,
          correction.preview.reviewId,
          { expectedVersion: 1 }
        );
      }
      await installBaseline();
      await expect(
        journal.resolveNativeSource(source!, sourceDeploymentId)
      ).rejects.toThrow();
      const groupControl = {
        ...request,
        requestId: randomUUID(),
        actionGrantId: randomUUID(),
        intent: {
          selectorKind: "selection" as const,
          mutationId: randomUUID(),
          ruleId: intent.ruleId,
          teamId: intent.teamId,
          teamWorkspaceId: intent.teamWorkspaceId,
          expectedAuthorityVersion: detailScope.result.authorityVersion,
          publisherFence: 1,
          controlAction: "pause" as const
        }
      };
      expect((await restarted.persistRuleDelivery(groupControl))?.state).toBe(
        "queued"
      );
      const [controlWork] = await restarted.claimRuleDeliveries();
      expect(
        (
          await restarted.finishRuleDelivery({
            ...controlWork!,
            outcome: "acknowledged",
            control: {
              selectorKind: "selection",
              catchUpState: "idle",
              ruleId: intent.ruleId,
              state: "paused",
              authorityVersion: detailScope.result.authorityVersion + 1,
              publisherFence: 1
            }
          })
        )?.state
      ).toBe("acknowledged");
      const remote = {
        logicalMemoryId,
        membershipId,
        membershipVersion: 1,
        authorityVersion: detailScope.result.authorityVersion,
        publisherFence: 1,
        pendingShareId: null
      };
      await journal.acknowledgeSource(source!, { mutationId, remote });
      const [newer] = await journal.claimSources(localOwner.userId);
      expect(newer?.goalHash).not.toBe(source!.goalHash);
      expect(newer?.deliveryEpoch).toBe(source!.deliveryEpoch + 1);
      expect(newer?.data.attempt).toBeNull();
      expect(newer?.data.remote).toEqual(remote);
      expect(
        await journal.resolveNativeSource(newer!, sourceDeploymentId)
      ).toEqual(nativeSource);
      await pool.query("update sessions set invalidated_at=now() where id=$1", [
        session.id
      ]);
      expect(
        await journal.resolveNativeSource(newer!, sourceDeploymentId)
      ).toBeNull();
      await expect(
        journal.acknowledgeSource(source!, { mutationId: null, remote })
      ).rejects.toThrow();
      await journal.acknowledgeSource(newer!, { mutationId: null, remote });
      expect(await journal.claimSources(localOwner.userId)).toEqual([]);
      const rawSources = await pool.query(
        "select * from collaboration_sharing_selection_sources"
      );
      expect(JSON.stringify(rawSources.rows)).not.toContain(session.id);
      expect(JSON.stringify(rawSources.rows)).not.toContain(
        repositoryTarget.repository.root
      );

      // A complete baseline remains authoritative while a replacement is partial.
      expect(
        await journal.claim(fixture.otherOwnerIdentity.localOwnerUserId)
      ).toEqual([]);
      const [lease] = await journal.claim(fixture.identity.localOwnerUserId);
      expect(lease?.data.intent).toEqual(intent);
      const page = {
        version: 1,
        snapshotVersion: randomUUID(),
        selection: {
          version: 1,
          ownerUserId: fixture.identity.localOwnerUserId,
          target: intent.review.target
        },
        entries: [
          {
            source: {
              localSessionId: fixture.sessionId,
              localLogicalSessionId: randomUUID(),
              portable: null,
              identityState: "local_only",
              contextVersion: { git: 1, folder: 1 }
            },
            reason: initialBaseline.entries[0]!.reason,
            projectVersion: null
          }
        ],
        nextCursor: randomUUID(),
        changeCursor: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      await journal.appendPage(lease!, page);
      expect(
        await journal.claimSources(fixture.identity.localOwnerUserId)
      ).toEqual([]);
      const recovered = createSelectionSharingJournal(pool, provider);
      const [nextLease] = await recovered.claim(
        fixture.identity.localOwnerUserId
      );
      expect(nextLease?.data.proposal).toMatchObject({
        phase: "enumerating",
        pageCount: 1,
        nextCursor: page.nextCursor
      });
      await expect(recovered.stagePresentPage(nextLease!)).rejects.toThrow();
      if (privateProject) {
        await recovered.abandon(nextLease!);
        await personal.deleteNamedPersonalProject(
          localOwner,
          privateProject.projectId,
          { expectedVersion: projectVersion }
        );
        const reconciliation = createSelectionSharingReconciliation(
          pool,
          provider
        );
        for (let phase = 0; phase < 4; phase++)
          expect(await reconciliation.reconcile(localOwner.userId, 1)).toEqual({
            advanced: 1,
            failures: []
          });
        const [removed] = await journal.claimSources(localOwner.userId);
        expect(removed?.goal.desired).toBe("removed");
        expect(removed?.goal.source.localSessionId).toBe(session.id);
      }
      await restarted.revokeEnrollment({
        ...fixture.identity,
        reason: "owner disconnected"
      });
      await expect(
        recovered.appendPage(nextLease!, {
          ...page,
          nextCursor: null,
          changeCursor: randomUUID()
        })
      ).rejects.toThrow();
      expect(
        await recovered.claimSources(fixture.identity.localOwnerUserId)
      ).toEqual([]);
      const erased = await pool.query(
        "select state,protected_dto,protected_dto_hash from collaboration_sharing_selection_progress where rule_id=$1",
        [intent.ruleId]
      );
      expect(erased.rows).toEqual([
        { state: "revoked", protected_dto: null, protected_dto_hash: null }
      ]);
      expect(
        (
          await pool.query(
            "select 1 from collaboration_sharing_selection_pages"
          )
        ).rowCount
      ).toBe(0);
    }
  );
  it("recovers a long-outage selection journal while a queued stop leaves another Workspace independent", async () => {
    const fixture = await createFixture();
    await store.bindEnrollment({
      identity: fixture.identity,
      remoteDeviceId: fixture.remoteDeviceId
    });
    const personal = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const owner = { userId: fixture.identity.localOwnerUserId };
    const git = {
      kind: "portable_repository" as const,
      key: `gr_${randomUUID()}`,
      root: "/private/outage",
      branch: "main",
      reason: "origin" as const,
      checkoutId: null,
      originatingDeviceId: "outage-device",
      selectedRemote: "origin",
      anchorDisplay: "Private outage anchor"
    };
    const sessions = await Promise.all(
      [0, 1].map(() =>
        personal.createCapturedSession(owner, {
          externalSessionId: randomUUID(),
          repositoryIdentity: git
        })
      )
    );
    const starts: Array<
      Parameters<typeof store.persistRuleDelivery>[0] & {
        intent: ReturnType<
          typeof repositorySharingRuleCreationLocalIntentSchema.parse
        >;
      }
    > = [];
    for (const workspaceId of [fixture.workspaceId, randomUUID()]) {
      const intent = repositorySharingRuleCreationLocalIntentSchema.parse({
        mutationId: randomUUID(),
        ruleId: randomUUID(),
        teamId: fixture.teamId,
        teamWorkspaceId: workspaceId,
        selector: sharingSelectionDescriptor({
          kind: "repository",
          repository: git
        }),
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        includesFutureConversations: true,
        selectionSnapshotVersion: randomUUID(),
        completedReviewHash: hash("a"),
        teamPolicyVersion: 1,
        teamPolicyHash: hash("b"),
        workspacePolicyVersion: 1,
        workspacePolicyHash: hash("c"),
        effectivePrivacyPolicyHash: hash("d"),
        review: {
          teamId: fixture.teamId,
          workspaceId,
          representation: "memory_events",
          completionToken: "gsc1_outage_review",
          target: { kind: "repository", repository: git }
        }
      });
      const request = {
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId,
        requestId: randomUUID(),
        actionGrantId: randomUUID(),
        actionGrant: "hrg_disposable_outage_reviewed_creation",
        intent,
        presentation: {
          sourceTitle: "Private outage anchor",
          teamName: "Team",
          workspaceName: workspaceId
        }
      };
      expect((await store.persistRuleDelivery(request))?.state).toBe("queued");
      starts.push(request);
    }
    for (const work of await store.claimRuleDeliveries()) {
      if (!("includesFutureConversations" in work.intent))
        throw new Error("Expected selection rule creation");
      await store.finishRuleDelivery({
        ...work,
        outcome: "acknowledged",
        creation: {
          ruleId: work.intent.ruleId,
          state: "active",
          authorityVersion: 1,
          publisherFence: 1
        }
      });
    }
    let journal = createSelectionSharingJournal(pool, provider);
    let reconciliation = createSelectionSharingReconciliation(pool, provider);
    const baseline = async (rules: number) => {
      for (let phase = 0; phase < 4; phase++)
        expect(await reconciliation.reconcile(owner.userId, 10)).toEqual({
          advanced: rules,
          failures: []
        });
    };
    await baseline(2);
    const delivered: Array<{
      ruleId: string;
      sessionId: string;
      desired: string;
      goalHash: string;
    }> = [];
    const drain = async () => {
      for (let round = 0; round < 10; round++) {
        const work = await journal.claimSources(owner.userId, 10);
        if (!work.length) return;
        for (const lease of work) {
          delivered.push({
            ruleId: lease.progress.intent.ruleId,
            sessionId: lease.goal.source.localSessionId,
            desired: lease.goal.desired,
            goalHash: lease.goalHash
          });
          await journal.acknowledgeSource(lease, {
            mutationId: null,
            remote: lease.data.remote ?? {
              logicalMemoryId: crossIdentitySyncDeterministicUuid({
                session: lease.goal.source.localSessionId
              }),
              membershipId: crossIdentitySyncDeterministicUuid({
                rule: lease.progress.intent.ruleId,
                session: lease.goal.source.localSessionId
              }),
              membershipVersion: 1,
              authorityVersion: 1,
              publisherFence: 1,
              pendingShareId: null
            }
          });
        }
      }
      throw new Error("Selection journal did not converge within its bound");
    };
    await drain();
    expect(delivered).toHaveLength(4);
    const stop = {
      ...starts[0]!,
      requestId: randomUUID(),
      actionGrantId: randomUUID(),
      intent: {
        selectorKind: "selection" as const,
        mutationId: randomUUID(),
        ruleId: starts[0]!.intent.ruleId,
        teamId: fixture.teamId,
        teamWorkspaceId: starts[0]!.intent.teamWorkspaceId,
        expectedAuthorityVersion: 1,
        publisherFence: 1,
        controlAction: "stop" as const
      }
    };
    expect((await store.persistRuleDelivery(stop))?.state).toBe("queued");
    const [offlineStop] = await store.claimRuleDeliveries();
    expect(
      (
        await store.finishRuleDelivery({
          ...offlineStop!,
          outcome: "retry",
          failureCode: "remote_unavailable"
        })
      )?.state
    ).toBe("queued");
    const initial = await pool.query<{
      rule_id: string;
      current_generation: string | null;
      state: string;
    }>(
      "select rule_id,current_generation,state from collaboration_sharing_selection_progress order by rule_id"
    );
    expect(initial.rows.every((row) => row.state === "active")).toBe(true);
    const added = await personal.createCapturedSession(owner, {
      externalSessionId: randomUUID(),
      repositoryIdentity: git
    });
    await updateSessionRepositoryOverride(pool, {
      ownerUserId: owner.userId,
      sessionId: sessions[0]!.id,
      expectedVersion: 1,
      identity: { ...git, key: `gr_${randomUUID()}` }
    });
    for (const text of [
      "Turn captured before delivery resumes",
      "Later completed turn after the outage"
    ]) {
      await personal.createMemoryEvent(owner, {
        sessionId: sessions[1]!.id,
        projectId: "outage-fixture",
        visibility: "personal",
        actor: "user",
        sourceRuntime: "codex",
        eventType: "captured",
        rawEventType: "user_message",
        content: text,
        idempotencyKey: randomUUID()
      });
    }
    journal = createSelectionSharingJournal(pool, provider);
    reconciliation = createSelectionSharingReconciliation(pool, provider);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    try {
      const failed = await reconciliation.reconcile(owner.userId, 10);
      expect(failed.advanced).toBe(0);
      expect(failed.failures).toHaveLength(2);
      expect(
        failed.failures.every(
          (failure) => failure.code === "selection_cursor_expired"
        )
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect(
      (
        await pool.query(
          "select rule_id,current_generation,state from collaboration_sharing_selection_progress order by rule_id"
        )
      ).rows
    ).toEqual(initial.rows);
    const recovered = createCollaborationSharedMemoryAuthorityStore(pool, {
      envelopeEncryptionProvider: provider
    });
    const pending = await recovered.persistRuleDelivery({
      ...stop,
      actionGrant: null,
      presentation: null
    });
    expect(pending).toMatchObject({
      state: "queued",
      intent: stop.intent,
      control: null
    });
    // Only advance disposable scheduling metadata; the approved intent and
    // encrypted payload remain unchanged throughout the outage.
    await pool.query(
      "update collaboration_sharing_rule_deliveries set available_at=now() where mutation_id=$1",
      [stop.intent.mutationId]
    );
    const [recoveredStop] = await recovered.claimRuleDeliveries();
    expect(recoveredStop?.intent).toEqual(stop.intent);
    const stopped = {
      selectorKind: "selection" as const,
      ruleId: stop.intent.ruleId,
      state: "stopped" as const,
      authorityVersion: 2,
      publisherFence: 2,
      catchUpState: "idle" as const
    };
    expect(
      (
        await recovered.finishRuleDelivery({
          ...recoveredStop!,
          outcome: "acknowledged",
          control: stopped
        })
      )?.control
    ).toEqual(stopped);
    await baseline(1);
    await drain();
    const resumed = delivered.slice(4);
    expect(resumed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: starts[1]!.intent.ruleId,
          sessionId: sessions[0]!.id,
          desired: "removed"
        }),
        expect.objectContaining({
          ruleId: starts[1]!.intent.ruleId,
          sessionId: added.id,
          desired: "present"
        })
      ])
    );
    expect(resumed).toHaveLength(2);
    expect(
      resumed.every((row) => row.ruleId === starts[1]!.intent.ruleId)
    ).toBe(true);
    expect(
      new Set(
        delivered.map((row) => `${row.ruleId}:${row.sessionId}:${row.goalHash}`)
      ).size
    ).toBe(delivered.length);
    expect(await journal.claimSources(owner.userId)).toEqual([]);
    expect(await recovered.claimRuleDeliveries()).toEqual([]);
    expect(
      (
        await recovered.persistRuleDelivery({
          ...stop,
          actionGrant: null,
          presentation: null
        })
      )?.control
    ).toEqual(stopped);
    const final = (
      await pool.query<{ rule_id: string; state: string }>(
        "select rule_id,state from collaboration_sharing_selection_progress order by rule_id"
      )
    ).rows;
    expect(
      final.find((row) => row.rule_id === starts[0]!.intent.ruleId)?.state
    ).toBe("stopped");
    expect(
      final.find((row) => row.rule_id === starts[1]!.intent.ruleId)?.state
    ).toBe("active");
    expect(
      (
        await pool.query<{ count: number }>(
          "select count(*)::int count from memory_events where session_id=$1",
          [sessions[1]!.id]
        )
      ).rows[0]?.count
    ).toBe(2);
  });

  it.each(["active", "paused", "fresh"] as const)(
    "installs a fresh receiving baseline after an exact %s publisher transfer",
    async (variant) => {
      const state = variant === "paused" ? "paused" : "active";
      const fixture = await createFixture();
      await store.bindEnrollment({
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId
      });
      const personal = createMemorySourceRepository(pool, {
          envelopeEncryptionProvider: provider
        }),
        owner = { userId: fixture.identity.localOwnerUserId };
      const target = {
        kind: "repository" as const,
        repository: {
          kind: "portable_repository" as const,
          key: `gr_${randomUUID()}`,
          root: "/private/takeover-source",
          branch: null,
          reason: "origin" as const,
          checkoutId: null,
          originatingDeviceId: "origin-device",
          selectedRemote: null,
          anchorDisplay: "Private anchor"
        }
      };
      const session = await personal.createCapturedSession(owner, {
        externalSessionId: randomUUID(),
        repositoryIdentity: target.repository
      });
      const creation = repositorySharingRuleCreationLocalIntentSchema.parse({
        ruleId: randomUUID(),
        mutationId: randomUUID(),
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.workspaceId,
        selector: sharingSelectionDescriptor(target),
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: false,
        includesFutureConversations: true,
        selectionSnapshotVersion: randomUUID(),
        completedReviewHash: hash("a"),
        teamPolicyVersion: 1,
        teamPolicyHash: hash("b"),
        workspacePolicyVersion: 1,
        workspacePolicyHash: hash("c"),
        effectivePrivacyPolicyHash: hash("d"),
        review: {
          target,
          teamId: fixture.teamId,
          workspaceId: fixture.workspaceId,
          representation: "lcm_rollups",
          completionToken: "gsc1_original_local_review"
        }
      });
      const presentation = {
        sourceTitle: "Private anchor",
        teamName: "Team",
        workspaceName: "Workspace"
      };
      const journal = createSelectionSharingJournal(pool, provider),
        reconcile = createSelectionSharingReconciliation(pool, provider);
      let oldProgress:
        | Awaited<ReturnType<typeof journal.claim>>[number]
        | undefined;
      let oldSource:
        | Awaited<ReturnType<typeof journal.claimSources>>[number]
        | undefined;
      if (variant !== "fresh") {
        await store.persistRuleDelivery({
          identity: fixture.identity,
          remoteDeviceId: fixture.remoteDeviceId,
          requestId: randomUUID(),
          actionGrantId: randomUUID(),
          actionGrant: "hrg_original_synthetic_creation_secret",
          intent: creation,
          presentation
        });
        const [create] = await store.claimRuleDeliveries();
        await store.finishRuleDelivery({
          ...create!,
          outcome: "acknowledged",
          creation: {
            ruleId: creation.ruleId,
            state: "active",
            authorityVersion: 1,
            publisherFence: 1
          }
        });
        for (let phase = 0; phase < 4; phase++)
          expect(await reconcile.reconcile(owner.userId, 1)).toEqual({
            advanced: 1,
            failures: []
          });
        [oldProgress] = await journal.claim(owner.userId, 1);
        [oldSource] = await journal.claimSources(owner.userId, 1);
        expect(oldProgress?.data.changeCursor).not.toBeNull();
        expect(oldSource?.goal.source.localSessionId).toBe(session.id);
      }
      const sourceForReview = oldSource?.goal.source ?? {
        localSessionId: session.id,
        localLogicalSessionId: (
          await pool.query<{ logical_session_id: string }>(
            "select logical_session_id from sessions where id=$1",
            [session.id]
          )
        ).rows[0]!.logical_session_id,
        identityState: "local_only" as const,
        portable: null,
        contextVersion: { git: 1, folder: 1 }
      };
      // Team review and local availability are trusted fixtures at this storage
      // boundary; signed source proof is exercised by the dedicated source tests.
      const sourceIdentity = {
        originatingDeploymentId: "verified-takeover-origin",
        originatingDeviceId: "verified-takeover-device",
        logicalSessionId: "verified-takeover-conversation"
      };
      const intent = sharingRulePublisherTakeoverLocalIntentSchema.parse({
        operationKind: "publisher_takeover",
        mutationId: randomUUID(),
        ruleId: creation.ruleId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.workspaceId,
        target,
        localSource: {
          ...sourceForReview,
          identityState: "verified",
          portable: { ownerUserId: owner.userId, ...sourceIdentity }
        },
        review: {
          ruleId: creation.ruleId,
          teamId: fixture.teamId,
          teamWorkspaceId: fixture.workspaceId,
          expectedAuthorityVersion: 3,
          publisherFence: 3,
          sourceIdentity,
          selectorKind: "repository",
          state,
          maximumFidelity: creation.maximumFidelity,
          includeCuratedMemory: false,
          effectivePrivacyPolicyHash: creation.effectivePrivacyPolicyHash,
          teamName: "Team",
          workspaceName: "Workspace",
          currentPublisher: {
            credentialId: randomUUID(),
            deviceInstanceId: "former-device",
            label: "Former publisher",
            available: true
          },
          receivingPublisher: {
            credentialId: fixture.remoteDeviceId,
            deviceInstanceId: "receiving-device",
            label: "Receiving publisher",
            available: true
          },
          logicalMemoryId: randomUUID(),
          membershipId: randomUUID(),
          shareGrantId: randomUUID(),
          membershipVersion: 1,
          selectionScope: repositorySharingRuleCreationIntentSchema
            .strip()
            .parse(creation),
          expiresAt: new Date(Date.now() + 60000).toISOString()
        }
      });
      const request = {
        identity: fixture.identity,
        remoteDeviceId: fixture.remoteDeviceId,
        requestId: randomUUID(),
        actionGrantId: randomUUID(),
        actionGrant: "hrg_private_native_transfer_secret",
        intent,
        presentation
      };
      let removedSourceId: string | null = null;
      let lateSourceId: string | null = null;
      const inventoryEntries: Array<{
        membershipId: string;
        logicalMemoryId: string;
        membershipVersion: number;
        state: "present";
        portableSourceHash: string | null;
      }> = [];
      if (variant === "fresh") {
        const outside = await personal.createCapturedSession(owner, {
          externalSessionId: randomUUID(),
          repositoryIdentity: {
            ...target.repository,
            key: `gr_${randomUUID()}`
          }
        });
        removedSourceId = outside.id;
        const client = await pool.connect();
        try {
          await client.query("begin");
          await preparePersonalSourceContextSnapshot(client, {
            ownerUserId: owner.userId,
            localSessionId: outside.id,
            originatingDeploymentId: "verified-outside-origin",
            originatingDeviceId: "verified-outside-device"
          });
          await client.query("commit");
        } finally {
          client.release();
        }
        const portable = (
          await journal.readPublisherTakeoverSourceBindings({
            ownerUserId: owner.userId
          })
        ).entries.find((entry) => entry.source.localSessionId === outside.id)!
          .source.portable!;
        inventoryEntries.push(
          {
            membershipId: randomUUID(),
            logicalMemoryId: randomUUID(),
            membershipVersion: 1,
            state: "present",
            portableSourceHash: sharingRuleSourceIdentityHash(
              fixture.identity.upstreamUserId,
              {
                originatingDeploymentId: portable.originatingDeploymentId,
                originatingDeviceId: portable.originatingDeviceId,
                logicalSessionId: portable.logicalSessionId
              }
            )
          },
          {
            membershipId: randomUUID(),
            logicalMemoryId: randomUUID(),
            membershipVersion: 1,
            state: "present",
            portableSourceHash: null
          }
        );
        const late = await personal.createCapturedSession(owner, {
          externalSessionId: randomUUID(),
          repositoryIdentity: {
            ...target.repository,
            key: `gr_${randomUUID()}`
          }
        });
        lateSourceId = late.id;
        const lateClient = await pool.connect();
        try {
          await lateClient.query("begin");
          await preparePersonalSourceContextSnapshot(lateClient, {
            ownerUserId: owner.userId,
            localSessionId: late.id,
            originatingDeploymentId: "verified-late-origin",
            originatingDeviceId: "verified-late-device"
          });
          await lateClient.query("commit");
        } finally {
          lateClient.release();
        }
        const latePortable = (
          await journal.readPublisherTakeoverSourceBindings({
            ownerUserId: owner.userId
          })
        ).entries.find((entry) => entry.source.localSessionId === late.id)!
          .source.portable!;
        inventoryEntries.push({
          membershipId: randomUUID(),
          logicalMemoryId: randomUUID(),
          membershipVersion: 1,
          state: "present",
          portableSourceHash: sharingRuleSourceIdentityHash(
            fixture.identity.upstreamUserId,
            {
              originatingDeploymentId: latePortable.originatingDeploymentId,
              originatingDeviceId: latePortable.originatingDeviceId,
              logicalSessionId: latePortable.logicalSessionId
            }
          )
        });
        await pool.query(
          "update personal_source_bindings set git_state='pending' where local_session_id=$1",
          [late.id]
        );
        for (let unknown = 0; unknown < 98; unknown++)
          inventoryEntries.push({
            membershipId: randomUUID(),
            logicalMemoryId: randomUUID(),
            membershipVersion: 1,
            state: "present",
            portableSourceHash: null
          });
        inventoryEntries.sort((left, right) =>
          left.membershipId.localeCompare(right.membershipId)
        );
      }
      const readInventory = vi.fn(
        async (
          lease: import("../src/selection-sharing-journal.js").SelectionSharingProgressLease
        ) => {
          const after = lease.data.proposal?.inventory?.afterMembershipId;
          const remaining = inventoryEntries.filter(
            (entry) => !after || entry.membershipId > after
          );
          const entries = remaining.slice(0, 100);
          return {
            ruleId: intent.ruleId,
            teamId: intent.teamId,
            teamWorkspaceId: intent.teamWorkspaceId,
            authorityVersion: 4,
            publisherFence: 4,
            selectorBindingHash: crossIdentitySyncDigest(
              intent.review.selectionScope!.selector
            ),
            entries,
            nextAfterMembershipId:
              remaining.length > 100 ? entries.at(-1)!.membershipId : null
          };
        }
      );
      expect((await store.persistRuleDelivery(request))?.state).toBe("queued");
      let [work] = await store.claimRuleDeliveries();
      expect(
        (
          await store.finishRuleDelivery({
            ...work!,
            outcome: "retry",
            failureCode: "source_unavailable"
          })
        )?.failureCode
      ).toBe("source_unavailable");
      await pool.query(
        "update collaboration_sharing_rule_deliveries set available_at=now() where id=$1",
        [work!.workId]
      );
      [work] = await store.claimRuleDeliveries();
      const scope = sharingRulePublisherTakeoverAppliedScopeSchema.parse({
        review: intent.review,
        result: {
          mutationId: intent.mutationId,
          ruleId: intent.ruleId,
          state,
          authorityVersion: 4,
          publisherFence: 4,
          previousPublisherCredentialId:
            intent.review.currentPublisher.credentialId,
          publisherCredentialId: fixture.remoteDeviceId,
          catchUpState: state === "active" ? "queued" : "idle",
          approvedAt: new Date().toISOString()
        }
      });
      await expect(
        store.finishRuleDelivery({
          ...work!,
          outcome: "acknowledged",
          publisherTakeover: {
            ...scope,
            result: { ...scope.result, mutationId: randomUUID() }
          }
        })
      ).rejects.toThrow();
      expect(
        (
          await store.finishRuleDelivery({
            ...work!,
            outcome: "acknowledged",
            publisherTakeover: scope
          })
        )?.publisherTakeover
      ).toEqual(scope);
      if (oldProgress)
        await expect(journal.abandon(oldProgress)).rejects.toThrow();
      if (oldSource)
        await expect(journal.deferSource(oldSource)).rejects.toThrow();
      const [fresh] = await journal.claim(owner.userId, 1);
      expect(fresh?.data).toMatchObject({
        currentGeneration: null,
        changeCursor: null,
        proposal: null,
        intent: { publisherTakeover: scope, review: { target } }
      });
      expect(fresh?.data.intent.review).not.toHaveProperty("completionToken");
      expect(
        (
          await pool.query(
            "select 1 from collaboration_sharing_selection_sources where progress_id=$1",
            [fresh!.progressId]
          )
        ).rowCount
      ).toBe(0);
      await journal.abandon(fresh!);
      for (let phase = 0; phase < (variant === "fresh" ? 8 : 5); phase++) {
        if (variant === "fresh" && phase === 3) {
          const [lease] = await journal.claim(owner.userId, 1);
          const page = await readInventory(lease!);
          await expect(
            journal.installInventoryPage(lease!, {
              ...page,
              teamWorkspaceId: randomUUID()
            })
          ).rejects.toThrow();
          await expect(
            journal.installInventoryPage(lease!, {
              ...page,
              publisherFence: page.publisherFence + 1
            })
          ).rejects.toMatchObject({ code: "selection_enumeration_stale" });
          await expect(
            journal.installInventoryPage(lease!, {
              ...page,
              entries: [page.entries[0]!, page.entries[0]!]
            })
          ).rejects.toThrow();
          await journal.installInventoryPage(lease!, page);
        } else {
          expect(
            await createSelectionSharingReconciliation(
              pool,
              provider
            ).reconcile(owner.userId, 1, readInventory)
          ).toEqual({
            advanced: 1,
            failures: []
          });
        }
        if (phase < (variant === "fresh" ? 7 : 4))
          expect(await journal.claimSources(owner.userId, 1)).toEqual([]);
      }
      expect(readInventory).toHaveBeenCalledTimes(variant === "fresh" ? 2 : 1);
      const sources = [];
      for (let count = 0; count < (variant === "fresh" ? 2 : 1); count++)
        sources.push(...(await journal.claimSources(owner.userId, 1)));
      const current = sources.find(
        (source) => source.goal.source.localSessionId === session.id
      );
      if (removedSourceId) {
        const removed = sources.find(
          (source) => source.goal.source.localSessionId === removedSourceId
        )!;
        expect(removed.goal.desired).toBe("removed");
        expect(removed.data.remote?.logicalMemoryId).toBe(
          inventoryEntries.find(
            (entry) =>
              entry.portableSourceHash ===
              sharingRuleSourceIdentityHash(fixture.identity.upstreamUserId, {
                originatingDeploymentId:
                  removed.goal.source.portable!.originatingDeploymentId,
                originatingDeviceId:
                  removed.goal.source.portable!.originatingDeviceId,
                logicalSessionId: removed.goal.source.portable!.logicalSessionId
              })
          )!.logicalMemoryId
        );
        expect(removed.progress.pendingMemberCount).toBe(100);
      }
      expect(current?.progress.currentGeneration).not.toBe(
        oldProgress?.data.currentGeneration
      );
      expect(current?.progress.changeCursor).not.toBe(
        oldProgress?.data.changeCursor
      );
      expect(current?.goal.source.localSessionId).toBe(session.id);
      expect(current?.data.remote).toBeNull();
      if (lateSourceId) {
        // No selector change event is needed: a later verified Personal binding
        // must be reconsidered even when the installed checkpoint is unchanged.
        await pool.query(
          "update personal_source_bindings set git_state='available' where local_session_id=$1",
          [lateSourceId]
        );
        expect(
          await reconcile.reconcile(owner.userId, 1, readInventory)
        ).toEqual({ advanced: 1, failures: [] });
        const claimed = sources[0]!,
          mutationId = randomUUID();
        const unsent = {
          kind: "remove" as const,
          logicalMemoryId: claimed.data.remote?.logicalMemoryId ?? randomUUID(),
          membershipId: claimed.data.remote?.membershipId ?? randomUUID(),
          body: { mutationId }
        };
        await expect(
          journal.persistAttempt(claimed, {
            ...unsent,
            mutationId,
            deliveryEpoch: claimed.deliveryEpoch,
            goalHash: claimed.goalHash,
            requestHash: crossIdentitySyncDigest(unsent)
          })
        ).rejects.toThrow();
        for (const source of sources)
          await journal.acknowledgeSource(source, {
            mutationId: null,
            remote: source.data.remote
          });
        for (let phase = 1; phase < 8; phase++)
          expect(
            await reconcile.reconcile(owner.userId, 1, readInventory)
          ).toEqual({ advanced: 1, failures: [] });
        const [late] = await journal.claimSources(owner.userId, 1);
        expect(late?.goal.source.localSessionId).toBe(lateSourceId);
        expect(late?.goal.desired).toBe("removed");
        expect(late?.progress.pendingMemberCount).toBe(99);
      }
      expect(
        (
          await store.persistRuleDelivery({
            ...request,
            actionGrant: null,
            presentation: null
          })
        )?.publisherTakeover
      ).toEqual(scope);
      const raw = (
        await pool.query(
          "select protected_dto,protected_dto_hash from collaboration_sharing_selection_progress where id=$1",
          [fresh!.progressId]
        )
      ).rows;
      for (const secret of [
        request.actionGrant,
        sourceIdentity.originatingDeploymentId,
        target.repository.root
      ])
        expect(JSON.stringify(raw)).not.toContain(secret);
      if (variant === "active") {
        const mutationId = randomUUID(),
          logicalMemoryId = randomUUID(),
          membershipId = randomUUID(),
          pendingShareId = randomUUID();
        const request = {
          kind: "admit" as const,
          logicalMemoryId,
          membershipId,
          body: { mutationId }
        };
        await journal.persistAttempt(current!, {
          ...request,
          sourceWorkMode: "retained",
          mutationId,
          deliveryEpoch: current!.deliveryEpoch,
          goalHash: current!.goalHash,
          requestHash: crossIdentitySyncDigest(request)
        });
        const remote = {
          logicalMemoryId,
          membershipId,
          membershipVersion: 2,
          authorityVersion: 4,
          publisherFence: 4,
          pendingShareId
        };
        await journal.acknowledgeSource(current!, {
          mutationId,
          remote,
          observePending: true
        });
        const restarted = createSelectionSharingJournal(pool, provider);
        expect(await restarted.claimSources(owner.userId, 1)).toEqual([]);
        await pool.query(
          "update collaboration_sharing_selection_sources set available_at=now()-interval '1 second' where id=$1",
          [current!.sourceId]
        );
        const [observing] = await restarted.claimSources(owner.userId, 1);
        expect(observing?.sourceId).toBe(current!.sourceId);
        expect(observing?.data.attempt).toBeNull();
        expect(observing?.data.remote).toEqual(remote);
        await restarted.acknowledgeSource(observing!, {
          mutationId: null,
          remote: { ...remote, pendingShareId: null }
        });
        expect(await restarted.claimSources(owner.userId, 1)).toEqual([]);
      }
    }
  );

  it("retains a creation receipt separately from later controls of the same rule", async () => {
    const fixture = await createFixture();
    await store.bindEnrollment({
      identity: fixture.identity,
      remoteDeviceId: fixture.remoteDeviceId
    });
    const intent: ConversationSharingRuleCreationIntent = {
      mutationId: randomUUID(),
      ruleId: randomUUID(),
      logicalGrantId: randomUUID(),
      consentId: randomUUID(),
      source: {
        kind: "captured_session",
        sessionId: fixture.sessionId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      sourceCapabilities: ["lcm_rollups"],
      activationRepresentation: "lcm_rollups",
      logicalMemoryId: fixture.logicalMemoryId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.workspaceId,
      previewId: randomUUID(),
      previewHash: hash("a"),
      previewRevision: 1,
      mode: "continuous",
      maximumFidelity: "lcm_rollups",
      includeCuratedMemory: false,
      expiresAt: null,
      expectedGrantVersion: null,
      effectivePrivacyPolicyHash: hash("b")
    };
    const request = {
      identity: fixture.identity,
      remoteDeviceId: fixture.remoteDeviceId,
      requestId: randomUUID(),
      actionGrantId: randomUUID(),
      actionGrant: "hrg_private_creation_credential_0000000",
      intent,
      presentation: {
        sourceTitle: "Private creation title",
        teamName: "Team",
        workspaceName: "Workspace"
      }
    };
    expect((await store.persistRuleDelivery(request))?.state).toBe("queued");
    const raw = await pool.query(
      "select * from collaboration_sharing_rule_deliveries"
    );
    expect(raw.rows[0]).toMatchObject({
      logical_grant_id: intent.logicalGrantId,
      share_grant_id: null
    });
    expect(JSON.stringify(raw.rows)).not.toContain(request.actionGrant);
    expect(JSON.stringify(raw.rows)).not.toContain(
      request.presentation.sourceTitle
    );
    const control = {
      ...request,
      requestId: randomUUID(),
      actionGrantId: randomUUID(),
      intent: {
        mutationId: randomUUID(),
        ruleId: intent.ruleId,
        reasonId: randomUUID(),
        shareGrantId: randomUUID(),
        teamId: intent.teamId,
        teamWorkspaceId: intent.teamWorkspaceId,
        expectedAuthorityVersion: 1,
        expectedGrantVersion: 2,
        controlAction: "stop" as const
      }
    };
    // A reviewed stop must not wait for an earlier creation response to be recovered.
    expect((await store.persistRuleDelivery(control))?.state).toBe("queued");
    const restarted = createCollaborationSharedMemoryAuthorityStore(pool, {
      envelopeEncryptionProvider: provider
    });
    const work = await restarted.claimRuleDeliveries();
    expect(work).toHaveLength(2);
    const creation = work.find((item) => !("controlAction" in item.intent))!;
    await expect(
      restarted.finishRuleDelivery({
        ...creation,
        outcome: "acknowledged",
        creation: { pendingShareId: randomUUID(), sourceRevision: 4 }
      })
    ).rejects.toThrow();
    const receipt = {
      pendingShareId: crossIdentitySyncDeterministicUuid({
        kind: "pending_share",
        mutationId: intent.mutationId
      }),
      sourceRevision: 4
    };
    expect(
      (
        await restarted.finishRuleDelivery({
          ...creation,
          outcome: "acknowledged",
          creation: receipt
        })
      )?.creation
    ).toEqual(receipt);
    const exact = await restarted.listRuleDeliveries({
      ...fixture.identity,
      mutationId: intent.mutationId
    });
    expect(exact).toHaveLength(1);
    expect(exact![0]).toMatchObject({
      state: "acknowledged",
      creation: receipt,
      control: null
    });
    expect(
      (
        await restarted.persistRuleDelivery({
          ...request,
          actionGrant: null,
          presentation: null
        })
      )?.state
    ).toBe("acknowledged");
    expect(
      await restarted.persistRuleDelivery({
        ...request,
        intent: { ...intent, previewId: randomUUID() }
      })
    ).toBeNull();
  });
});
