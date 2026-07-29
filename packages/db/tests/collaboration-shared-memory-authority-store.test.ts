import { randomUUID } from "node:crypto";

import {
  createLocalTestKeyEnvelopeEncryptionProvider,
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
import { runDbMigrations } from "../src/migrate.js";

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
      `insert into logical_memories
         (id, owner_user_id, owner_principal_id, origin_deployment_identity_id,
          source_boundary, origin_source_id, local_session_id, logical_key)
       values ($1, $2, $2, $3, 'captured_session', $4, $5, $6)`,
      [
        fixture.logicalMemoryId,
        fixture.identity.localOwnerUserId,
        localDeploymentId,
        `session:${fixture.sessionId}`,
        fixture.sessionId,
        `captured-session:${fixture.sessionId}`
      ]
    );
    await pool.query(
      `insert into memory_replicas
         (id, logical_memory_id, deployment_identity_id, owner_user_id,
          owner_principal_id, replica_role, source_boundary, local_session_id,
          encryption_scope, freshness_status)
       values ($1, $2, $3, $4, $4, 'source', 'captured_session', $5,
               'personal', 'fresh')`,
      [
        localReplicaId,
        fixture.logicalMemoryId,
        localDeploymentId,
        fixture.identity.localOwnerUserId,
        fixture.sessionId
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
    previewId: randomUUID(),
    previewHash: hash("a"),
    previewRevision: 1,
    logicalMemoryId: fixture.logicalMemoryId,
    teamId: fixture.teamId,
    teamWorkspaceId: fixture.workspaceId,
    representation: "memory_events",
    binding: {
      sourceRevision: 7,
      sourceHash: hash("b"),
      representationPolicyRevision: 3,
      representationPolicyHash: hash("c"),
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
    redactedContentHash: hash("f"),
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
    id: randomUUID(),
    logicalMemoryId: fixture.logicalMemoryId,
    teamId: fixture.teamId,
    teamWorkspaceId: fixture.workspaceId,
    mode: "continuous",
    state: "active",
    consentVersion: 1,
    allowedRepresentations: ["memory_events"],
    selectedRepresentation: "memory_events",
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
      id,
      logicalGrantId: randomUUID(),
      logicalMemoryId: fixture.logicalMemoryId,
      ownerUserId: fixture.identity.upstreamUserId,
      teamId: fixture.teamId,
      teamWorkspaceId: fixture.workspaceId,
      consentId,
      ownerAllowedRepresentations: ["memory_events"],
      activeRepresentation: "memory_events",
      representationPolicyRevision: 3,
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
      allowedRepresentations: ["memory_events"],
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

  it("rotates stale authority after authenticated device or upstream identity replacement", async () => {
    const fixture = await createFixture();
    await bindFixture(fixture);
    const remote = previewFor(fixture);
    expect(
      await store.persistAuthoritativePreview({
        identity: fixture.identity,
        allowedRepresentations: ["memory_events"],
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
          allowedRepresentations: ["memory_events"],
          preview: remote
        })
      )
    );
    expect(attempts.every((value) => value?.previewRevision === 1)).toBe(true);
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
        allowedRepresentations: ["memory_events"],
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
        allowedRepresentations: ["memory_events"],
        preview: secondRemote
      })
    ).resolves.toMatchObject({ previewRevision: 2 });
    const sameRevisionRemote = previewFor(fixture, {
      previewId: randomUUID(),
      previewHash: hash("3"),
      redactedContentHash: hash("4"),
      binding: {
        ...remote.binding,
        representationPolicyRevision: 4,
        representationPolicyHash: hash("5")
      }
    });
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        allowedRepresentations: ["memory_events"],
        preview: sameRevisionRemote
      })
    ).resolves.toMatchObject({
      previewId: sameRevisionRemote.previewId,
      previewRevision: 1
    });
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        allowedRepresentations: ["memory_events"],
        preview: { ...remote, previewHash: hash("2") }
      })
    ).resolves.toBeNull();
    await expect(
      store.persistAuthoritativePreview({
        identity: fixture.identity,
        allowedRepresentations: ["memory_events"],
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
      representation: "memory_events"
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
      activeRepresentation: null,
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
          representationPolicyRevision:
            refreshed.representationPolicyRevision + 1,
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
      activeRepresentation: null,
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
        allowedRepresentations: ["memory_events"],
        preview: remote
      })
    ).rejects.toThrow("encryption unavailable");
    expect(
      await pool.query("select 1 from collaboration_shared_memory_previews")
    ).toHaveProperty("rowCount", 0);

    const persisted = await store.persistAuthoritativePreview({
      identity: fixture.identity,
      allowedRepresentations: ["memory_events"],
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
        allowedRepresentations: ["memory_events"],
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
});
