import { randomUUID } from "node:crypto";

import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  sharingSelectionDescriptor,
  selectionSharingEffectiveIntent,
  sharingRuleDetailAppliedScopeSchema,
  type SelectionSharingAttempt,
  repositorySharingRuleCreationLocalIntentSchema,
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
  it
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
      store.bindEnrollment({
        identity: fixture.identity,
        remoteDeviceId: replacementDeviceId
      })
    ).resolves.toBe(true);
    await expect(store.isEnrollmentBound(fixture.identity)).resolves.toBe(true);
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

  it("refreshes only monotonic source freshness within an active grant version", async () => {
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
      sourceRevision: 11,
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
      grant: { grantVersion: 4, sourceRevision: 11 }
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
          sourceRevision: 10,
          updatedAt: "2026-07-17T09:13:00.000Z"
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
          sourceRevision: 12,
          updatedAt: "2026-07-17T09:12:00.000Z"
        },
        prior: second,
        companion: companionFor(fixture)
      })
    ).resolves.toBeNull();
  });

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
  it.each(["repository", "folder", "project"] as const)(
    "recovers encrypted %s creation without inventing a source grant",
    async (selectionKind) => {
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
        expect(
          await updateSessionRepositoryOverride(pool, {
            ownerUserId: localOwner.userId,
            sessionId: session.id,
            expectedVersion: 1,
            identity: {
              ...repositoryTarget.repository,
              branch: "after-correction"
            }
          })
        ).not.toBeNull();
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
