import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import {
  createRetentionLifecycleRepository,
  lockShareGrantRetentionScopeWithClient,
  scheduleShareGrantRevocationRetentionWithClient,
  type AuthorizeHoldActor,
  type RetentionLifecycleRepository
} from "../src/retention-lifecycle-repository.js";

const databaseUrl = process.env.RETENTION_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

interface Fixture {
  userId: string;
  secondUserId: string;
  teamId: string;
  teamWorkspaceId: string;
}

interface SharedMemoryFixture extends Fixture {
  ownerPrincipalId: string;
  logicalMemoryId: string;
  ownerPrivateReplicaId: string;
  localSessionId: string;
  syncRelationshipId: string;
  deploymentIdentityId: string;
  sourceArtifactId: string;
  semanticPreviewId: string;
  shareGrantId: string;
  representationId: string;
  representation: "memory_events" | "lcm_rollups";
  sourceRevision: number;
}

interface OwnerReplicaFixture extends Fixture {
  ownerPrincipalId: string;
  logicalMemoryId: string;
  ownerPrivateReplicaId: string;
  localSessionId: string;
  syncRelationshipId: string;
  deploymentIdentityId: string;
}

describeDb("retention lifecycle repository", () => {
  let pool: pg.Pool;
  let now: Date;
  let authorize: AuthorizeHoldActor;
  let repository: RetentionLifecycleRepository;

  const resetRepository = (
    authorization: AuthorizeHoldActor = async () => true
  ): void => {
    authorize = authorization;
    repository = createRetentionLifecycleRepository(pool, {
      authorizeHoldActor: (context) => authorize(context),
      clock: () => new Date(now),
      blockedHoldRecheckMs: 1,
      staleRunningAttemptMs: 100
    });
  };

  const createFixture = async (): Promise<Fixture> => {
    const firstUser = await pool.query<{ id: string }>(
      `insert into users (email, display_name)
       values ($1, 'Retention Holder') returning id`,
      [`retention-${randomUUID()}@example.com`]
    );
    const secondUser = await pool.query<{ id: string }>(
      `insert into users (email, display_name)
       values ($1, 'Independent Holder') returning id`,
      [`retention-${randomUUID()}@example.com`]
    );
    const team = await pool.query<{ id: string }>(
      "insert into teams (name) values ($1) returning id",
      [`Retention Team ${randomUUID()}`]
    );
    const teamWorkspace = await pool.query<{ id: string }>(
      `insert into team_workspaces (team_id, name)
       values ($1, $2) returning id`,
      [team.rows[0]!.id, `Retention Workspace ${randomUUID()}`]
    );
    await pool.query(
      `insert into team_memberships (team_id, user_id, role, status, accepted_at)
       values ($1, $2, 'owner', 'enabled', now()),
              ($1, $3, 'admin', 'enabled', now())`,
      [team.rows[0]!.id, firstUser.rows[0]!.id, secondUser.rows[0]!.id]
    );
    await pool.query(
      `insert into team_workspace_access_grants (
         team_workspace_id, team_id, user_id, access, granted_by_user_id
       ) values ($1, $2, $3, 'write', $3),
                ($1, $2, $4, 'write', $3)`,
      [
        teamWorkspace.rows[0]!.id,
        team.rows[0]!.id,
        firstUser.rows[0]!.id,
        secondUser.rows[0]!.id
      ]
    );
    return {
      userId: firstUser.rows[0]!.id,
      secondUserId: secondUser.rows[0]!.id,
      teamId: team.rows[0]!.id,
      teamWorkspaceId: teamWorkspace.rows[0]!.id
    };
  };

  const createSharedMemoryFixture = async (
    existingFixture?: Fixture,
    requestedRepresentation: "memory_events" | "lcm_rollups" = "memory_events"
  ): Promise<SharedMemoryFixture> => {
    const fixture = existingFixture ?? (await createFixture());
    const ownerPrincipalId = randomUUID();
    const session = await pool.query<{ id: string }>(
      `insert into sessions (
         owner_user_id, visibility, source_runtime, capture_method
       ) values ($1, 'personal', 'codex', 'transcript') returning id`,
      [fixture.userId]
    );
    const deployment = await pool.query<{ id: string }>(
      `insert into deployment_identities (
         protocol_deployment_id, locality, profile, display_name
       ) values ($1, 'remote', 'team_self_hosted', $2) returning id`,
      [randomUUID(), `Retention Remote ${randomUUID()}`]
    );
    const logicalMemory = await pool.query<{ id: string }>(
      `with logical_memory as (
         insert into logical_memories (
           owner_user_id,owner_principal_id,origin_deployment_identity_id,
           source_kind,logical_key
         ) values ($1,$2,$3,'captured_session',$4)
         returning id
       ), protocol_binding as (
         insert into captured_session_logical_memories (
           logical_memory_id,source_session_id,owner_principal_id
         ) select id,$5,$2 from logical_memory
       ), local_binding as (
         insert into local_captured_session_logical_memories (
           logical_memory_id,local_session_id,owner_user_id
         ) select id,$5,$1 from logical_memory
       )
       select id from logical_memory`,
      [
        fixture.userId,
        ownerPrincipalId,
        deployment.rows[0]!.id,
        `retention-logical-${randomUUID()}`,
        session.rows[0]!.id
      ]
    );
    const replica = await pool.query<{ id: string }>(
      `insert into memory_replicas (
         logical_memory_id, deployment_identity_id, owner_user_id,
         owner_principal_id, replica_role, source_boundary,
         encryption_scope
       ) values (
         $1, $2, $3, $4, 'target', 'captured_session',
         'owner_private_replica'
       ) returning id`,
      [
        logicalMemory.rows[0]!.id,
        deployment.rows[0]!.id,
        fixture.userId,
        ownerPrincipalId
      ]
    );
    const remoteIdentity = await pool.query<{ id: string }>(
      `insert into sync_external_user_identities (
         deployment_identity_id, external_subject_id
       ) values ($1, $2) returning id`,
      [deployment.rows[0]!.id, `retention-subject-${randomUUID()}`]
    );
    const deviceCredential = await pool.query<{ id: string }>(
      `insert into device_credentials (
         owner_user_id, credential_key_id, upstream_backend_id,
         device_instance_id, verifier_kind, verifier_hash, operation_families
       ) values ($1, $2, $3, $4, 'secret_hash', $5, $6::text[])
       returning id`,
      [
        fixture.userId,
        `retention-key-${randomUUID()}`,
        `retention-backend-${randomUUID()}`,
        `retention-device-${randomUUID()}`,
        hash(`retention-credential-${randomUUID()}`),
        ["share_grant_management", "team_workspace_read", "sync"]
      ]
    );
    const sourceReplicaId = randomUUID();
    const relationship = await pool.query<{ id: string }>(
      `insert into cross_identity_sync_relationships (
         id, logical_memory_id, side, local_replica_id, local_user_id,
         device_credential_id, remote_deployment_identity_id,
         remote_user_identity_id, remote_replica_id, source_boundary,
         sync_mode, state, idempotency_key, creation_request_hash,
         source_cursor, target_processing_cursor, package_sequence, last_synced_at
       ) values (
         $1, $2, 'target', $3, $4, $5, $6, $7, $8,
         'captured_session', 'live', 'ready', $9, $10, 7, 7, 7, now()
       ) returning id`,
      [
        randomUUID(),
        logicalMemory.rows[0]!.id,
        replica.rows[0]!.id,
        fixture.userId,
        deviceCredential.rows[0]!.id,
        deployment.rows[0]!.id,
        remoteIdentity.rows[0]!.id,
        sourceReplicaId,
        `retention-sync-${randomUUID()}`,
        hash(`retention-sync-request-${randomUUID()}`)
      ]
    );

    const sourceOwnerPolicyId = randomUUID();
    const teamPolicyId = randomUUID();
    const workspacePolicyId = randomUUID();
    const effectiveAt = new Date("2025-01-01T00:00:00.000Z");
    await pool.query(
      `insert into source_owner_representation_policies (
         policy_id, logical_memory_id, source_owner_principal_id, version,
         maximum_fidelity, include_curated_memory, policy_hash,
         created_by_user_id, effective_at
       ) values ($1, $2, $3, 1, 'memory_events', false, $4, $5, $6)`,
      [
        sourceOwnerPolicyId,
        logicalMemory.rows[0]!.id,
        ownerPrincipalId,
        hash("source-owner-policy"),
        fixture.userId,
        effectiveAt
      ]
    );
    await pool.query(
      `insert into team_representation_policies (
         policy_id, team_id, version, maximum_fidelity,
         include_curated_memory, policy_hash, created_by_user_id, effective_at
       ) values ($1, $2, 1, 'memory_events', false, $3, $4, $5)`,
      [
        teamPolicyId,
        fixture.teamId,
        hash("team-policy"),
        fixture.userId,
        effectiveAt
      ]
    );
    await pool.query(
      `insert into workspace_representation_policies (
         policy_id, team_id, team_workspace_id, version,
         maximum_fidelity, include_curated_memory, policy_hash,
         created_by_user_id, effective_at
       ) values ($1, $2, $3, 1, 'memory_events', false, $4, $5, $6)`,
      [
        workspacePolicyId,
        fixture.teamId,
        fixture.teamWorkspaceId,
        hash("workspace-policy"),
        fixture.userId,
        effectiveAt
      ]
    );

    const sharedMemoryFixtureKey = logicalMemory.rows[0]!.id;
    const sourceHash = hash(`source:${sharedMemoryFixtureKey}`);
    const previewHash = hash(`preview:${sharedMemoryFixtureKey}`);
    const manifestHash = hash(`manifest:${sharedMemoryFixtureKey}`);
    const artifactHash = hash(`artifact:${sharedMemoryFixtureKey}`);
    const sourceContentHash = hash(
      `redacted-content:${sharedMemoryFixtureKey}`
    );
    const desiredClassifierHash = hash("classifier");
    const privacyPolicyHash = hash("effective-privacy-policy");
    const sanitizedContentHash = hash("sanitized-content");
    const classifierGeneration = await pool.query<{
      id: string;
      classifierHash: string;
    }>(
      `insert into privacy_classifier_generations (
         version, classifier_hash, model_key, model_revision,
         artifact_sha256, tokenizer_sha256, decoder_sha256,
         calibration_sha256, deterministic_detector_version,
         input_contract_version, status
       ) values (
         1, $1, 'fixture-privacy-model', 'fixture-revision',
         $2, $3, $4, $5, 'fixture-detector-v1', 'fixture-input-v1', 'staged'
       )
       on conflict (version) do update set version = excluded.version
       returning id, classifier_hash as "classifierHash"`,
      [
        desiredClassifierHash,
        hash("classifier-artifact"),
        hash("classifier-tokenizer"),
        hash("classifier-decoder"),
        hash("classifier-calibration")
      ]
    );
    const classifierHash = classifierGeneration.rows[0]!.classifierHash;
    const sourceRevisionId = randomUUID();
    await pool.query(
      `with source_revision as (
         insert into logical_memory_source_revisions (
           id,logical_memory_id,owner_principal_id,source_kind,revision,binding_hash
         ) values ($1,$2,$3,'captured_session',8,$4)
         returning id
       )
       insert into captured_session_source_revisions (
         source_revision_id,logical_memory_id,owner_principal_id,source_kind,
         revision,source_session_id,source_cursor
       ) select id,$2,$3,'captured_session',8,$5,7 from source_revision`,
      [
        sourceRevisionId,
        logicalMemory.rows[0]!.id,
        ownerPrincipalId,
        hash(`source-revision-binding:${logicalMemory.rows[0]!.id}:7`),
        session.rows[0]!.id
      ]
    );
    const sourceArtifact = await pool.query<{ id: string }>(
      `insert into shared_source_artifacts (
         logical_memory_id, source_revision_id, remote_replica_id,
         sync_relationship_id,
         owner_user_id, owner_principal_id, team_id, team_workspace_id,
         source_capabilities, activation_representation, representation,
         maximum_fidelity, include_curated_memory,
         source_revision, source_cursor, package_sequence,
         source_hash, manifest_hash, artifact_hash, source_content_hash,
         source_owner_policy_id, source_owner_policy_version,
         team_policy_id, team_policy_version, workspace_policy_id,
         workspace_policy_version, representation_policy_revision,
         representation_policy_hash, content_policy_version,
         content_policy_hash, classifier_version, classifier_hash,
         source_deployment_identity_id, remote_user_identity_id,
         device_credential_id, device_provenance_hash
       ) values (
         $1, $23, $2, $3, $4, $5, $6, $7,
         array['memory_events','lcm_leaves','lcm_rollups']::shared_memory_representation[],
         $22::shared_memory_representation, $22::shared_memory_representation,
         'memory_events', false, 7, 7, 7,
         $8, $9, $10, $11, $12, 1, $13, 1, $14, 1, 1, $15, 1,
         $16, 1, $17, $18, $19, $20, $21
       ) returning id`,
      [
        logicalMemory.rows[0]!.id,
        replica.rows[0]!.id,
        relationship.rows[0]!.id,
        fixture.userId,
        ownerPrincipalId,
        fixture.teamId,
        fixture.teamWorkspaceId,
        sourceHash,
        manifestHash,
        artifactHash,
        sourceContentHash,
        sourceOwnerPolicyId,
        teamPolicyId,
        workspacePolicyId,
        hash("representation-policy"),
        hash("content-policy"),
        classifierHash,
        deployment.rows[0]!.id,
        remoteIdentity.rows[0]!.id,
        deviceCredential.rows[0]!.id,
        hash("device-provenance"),
        requestedRepresentation,
        sourceRevisionId
      ]
    );
    const sourcePreview = await pool.query<{ id: string }>(
      `insert into shared_source_previews (
         source_artifact_id, logical_memory_id, source_revision_id,
         remote_replica_id,
         owner_user_id, owner_principal_id, team_id, team_workspace_id,
         source_capabilities, activation_representation, mode,
         representation, preview_revision, preview_hash, source_revision,
         source_hash, source_content_hash
       ) values (
         $1, $2, $12, $3, $4, $5, $6, $7,
         array['memory_events','lcm_leaves','lcm_rollups']::shared_memory_representation[],
         $11::shared_memory_representation, 'snapshot',
         $11::shared_memory_representation, 1, $8, 7, $9, $10
       ) returning id`,
      [
        sourceArtifact.rows[0]!.id,
        logicalMemory.rows[0]!.id,
        replica.rows[0]!.id,
        fixture.userId,
        ownerPrincipalId,
        fixture.teamId,
        fixture.teamWorkspaceId,
        previewHash,
        sourceHash,
        sourceContentHash,
        requestedRepresentation,
        sourceRevisionId
      ]
    );
    const semanticPreview = await pool.query<{ id: string }>(
      `insert into shared_source_semantic_previews (
         source_preview_id, source_artifact_id, source_preview_revision,
         source_preview_hash, source_artifact_hash, source_manifest_hash,
         source_revision, source_hash, logical_memory_id, owner_user_id,
         owner_principal_id, team_id, team_workspace_id, representation,
         classifier_generation_id, classifier_version, classifier_hash,
         effective_privacy_policy_hash, status
       ) values (
         $1, $2, 1, $3, $4, $5, 7, $6, $7, $8, $9, $10, $11,
         $15::shared_memory_representation, $12, 1, $13, $14, 'pending'
       ) returning id`,
      [
        sourcePreview.rows[0]!.id,
        sourceArtifact.rows[0]!.id,
        previewHash,
        artifactHash,
        manifestHash,
        sourceHash,
        logicalMemory.rows[0]!.id,
        fixture.userId,
        ownerPrincipalId,
        fixture.teamId,
        fixture.teamWorkspaceId,
        classifierGeneration.rows[0]!.id,
        classifierHash,
        privacyPolicyHash,
        requestedRepresentation
      ]
    );

    const consent = await pool.query<{ id: string }>(
      `insert into source_owner_representation_consents (
         logical_memory_id, source_revision_id, remote_replica_id, preview_id,
         source_owner_principal_id,
         team_id, team_workspace_id, source_owner_policy_id,
         source_owner_policy_version, team_policy_id, team_policy_version,
         workspace_policy_id, workspace_policy_version,
         source_capabilities, activation_representation, mode, state,
         maximum_fidelity, include_curated_memory, preview_revision,
         preview_hash, source_revision, maximum_authorized_source_revision,
         source_hash, fidelity_policy_revision,
         fidelity_policy_hash, content_policy_version,
         content_policy_hash, classifier_version, classifier_hash,
         source_content_hash, activated_at
       ) values (
         $1, $17, $2, $3, $4, $5, $6, $7, 1, $8, 1, $9, 1,
         array['memory_events','lcm_leaves','lcm_rollups']::shared_memory_representation[],
         $18::shared_memory_representation, 'snapshot', 'active',
         'memory_events', false, 1, $10, 7, 7, $11, 1, $12, 1, $13, 1,
         $14, $15, $16
       ) returning id`,
      [
        logicalMemory.rows[0]!.id,
        replica.rows[0]!.id,
        sourcePreview.rows[0]!.id,
        ownerPrincipalId,
        fixture.teamId,
        fixture.teamWorkspaceId,
        sourceOwnerPolicyId,
        teamPolicyId,
        workspacePolicyId,
        previewHash,
        sourceHash,
        hash("representation-policy"),
        hash("content-policy"),
        hash("classifier"),
        hash("redacted-content"),
        effectiveAt,
        sourceRevisionId,
        requestedRepresentation
      ]
    );
    const shareGrant = await pool.query<{ id: string }>(
      `insert into team_memory_share_grants (
         logical_memory_id, remote_replica_id, owner_user_id,
         owner_principal_id, source_revision_id, team_id, team_workspace_id,
         consent_id, source_owner_policy_id, source_owner_policy_version,
         team_policy_id, team_policy_version, workspace_policy_id,
         workspace_policy_version, source_capabilities,
         activation_representation, mode, maximum_fidelity,
         include_curated_memory,
         fidelity_policy_revision,
         content_policy_version, classifier_version, source_revision,
         creator_authority, granted_by_user_id
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, 1, $11, 1,
         array['memory_events','lcm_leaves','lcm_rollups']::shared_memory_representation[],
         $12::shared_memory_representation, 'snapshot',
         'memory_events', false, 1, 1, 1, 7, 'fixture', $3
       ) returning id`,
      [
        logicalMemory.rows[0]!.id,
        replica.rows[0]!.id,
        fixture.userId,
        ownerPrincipalId,
        sourceRevisionId,
        fixture.teamId,
        fixture.teamWorkspaceId,
        consent.rows[0]!.id,
        sourceOwnerPolicyId,
        teamPolicyId,
        workspacePolicyId,
        requestedRepresentation
      ]
    );
    const representation = await pool.query<{ id: string }>(
      `insert into team_memory_representations (
         share_grant_id, consent_id, source_preview_id, source_artifact_id,
         sanitized_source_preview_id, privacy_classifier_generation_id,
         privacy_classifier_hash, effective_privacy_policy_hash,
         source_manifest_hash, sanitized_content_hash, team_id, team_workspace_id,
         logical_memory_id, source_revision_id, representation, source_revision,
         source_revision_hash, provenance_hash, source_owner_policy_id,
         source_owner_policy_version, team_policy_id, team_policy_version,
         workspace_policy_id, workspace_policy_version,
         fidelity_policy_revision, content_policy_version,
         classifier_version
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $20, $19::shared_memory_representation, 7, $14, $15, $16, 1, $17, 1,
         $18, 1, 1, 1, 1
       ) returning id`,
      [
        shareGrant.rows[0]!.id,
        consent.rows[0]!.id,
        sourcePreview.rows[0]!.id,
        sourceArtifact.rows[0]!.id,
        semanticPreview.rows[0]!.id,
        classifierGeneration.rows[0]!.id,
        classifierHash,
        privacyPolicyHash,
        manifestHash,
        sanitizedContentHash,
        fixture.teamId,
        fixture.teamWorkspaceId,
        logicalMemory.rows[0]!.id,
        hash("source-revision"),
        hash("provenance"),
        sourceOwnerPolicyId,
        teamPolicyId,
        workspacePolicyId,
        requestedRepresentation,
        sourceRevisionId
      ]
    );
    await pool.query(
      `insert into team_memory_representation_chunks (
         representation_id, share_grant_id, team_id, team_workspace_id,
         logical_memory_id, chunk_index, envelope_version, provider_mode,
         algorithm, key_id, key_version, ciphertext, ciphertext_hash, nonce,
         tag, wrapped_dek, aad, envelope_created_at, verified_at
       ) values (
         $1, $2, $3, $4, $5, 0, 1, 'local_test_key', 'aes-256-gcm',
         'team-key', 1, 'ciphertext', $6, 'nonce', 'tag', '{}'::jsonb,
         '{}'::jsonb, now(), now()
       )`,
      [
        representation.rows[0]!.id,
        shareGrant.rows[0]!.id,
        fixture.teamId,
        fixture.teamWorkspaceId,
        logicalMemory.rows[0]!.id,
        hash("ciphertext")
      ]
    );
    await pool.query(
      `insert into encrypted_field_payloads (
         team_id, team_workspace_id, visibility, encryption_scope,
         source_table, source_id, source_column, envelope_version,
         provider_mode, key_id, key_version, scope, provenance, algorithm,
         ciphertext, nonce, tag, wrapped_dek, ciphertext_location, aad,
         envelope_created_at
       ) values (
         $1, $2, 'personal', 'team', 'shared_source_semantic_previews',
         $3, 'items', 1, 'local_test_key', 'team-key', 1, '{}'::jsonb,
         '{}'::jsonb, 'aes-256-gcm', 'semantic-ciphertext', 'nonce', 'tag',
         '{"key":"wrapped"}'::jsonb, 'encrypted_field_payloads',
         '{}'::jsonb, now()
       )`,
      [fixture.teamId, fixture.teamWorkspaceId, semanticPreview.rows[0]!.id]
    );

    return {
      ...fixture,
      ownerPrincipalId,
      logicalMemoryId: logicalMemory.rows[0]!.id,
      ownerPrivateReplicaId: replica.rows[0]!.id,
      localSessionId: session.rows[0]!.id,
      syncRelationshipId: relationship.rows[0]!.id,
      deploymentIdentityId: deployment.rows[0]!.id,
      sourceArtifactId: sourceArtifact.rows[0]!.id,
      semanticPreviewId: semanticPreview.rows[0]!.id,
      shareGrantId: shareGrant.rows[0]!.id,
      representationId: representation.rows[0]!.id,
      representation: requestedRepresentation,
      sourceRevision: 7
    };
  };

  const seedTeamSemanticArtifacts = async (
    fixture: SharedMemoryFixture
  ): Promise<string[]> => {
    const semanticItemIds: string[] = [];
    for (const [sourceItemIndex, dimensions] of [
      384, 1024, 1536, 3072
    ].entries()) {
      const item = await pool.query<{ id: string }>(
        `insert into team_memory_semantic_items (
           representation_id, share_grant_id, team_id, team_workspace_id,
           logical_memory_id, pseudonymous_source_id, source_item_index,
           encrypted_chunk_index, encrypted_chunk_item_index, item_type,
           source_revision, representation_policy_revision,
           content_policy_version, classifier_version, content_hash,
           embedding_state, embedding_model, embedding_dimensions,
           embedding_version, embedding_input_hash, embedded_at
         ) values (
           $1,$2,$3,$4,$5,$6,$7,0,$7,'memory_event',$8,1,1,1,$9,
           'embedded','retention-fixture',$10,'1',$11,now()
         ) returning id`,
        [
          fixture.representationId,
          fixture.shareGrantId,
          fixture.teamId,
          fixture.teamWorkspaceId,
          fixture.logicalMemoryId,
          randomUUID(),
          sourceItemIndex,
          fixture.sourceRevision,
          hash(`semantic-content-${fixture.shareGrantId}-${dimensions}`),
          dimensions,
          hash(`semantic-input-${fixture.shareGrantId}-${dimensions}`)
        ]
      );
      const itemId = item.rows[0]!.id;
      const vectorType = dimensions === 3072 ? "halfvec" : "vector";
      await pool.query(
        `insert into team_memory_semantic_vectors_${dimensions} (
           semantic_item_id, embedding
         ) values ($1, $2::${vectorType})`,
        [itemId, `[${Array(dimensions).fill("0").join(",")}]`]
      );
      semanticItemIds.push(itemId);
    }
    return semanticItemIds;
  };

  const semanticArtifactCounts = async (
    semanticItemIds: string[]
  ): Promise<{ items: string; vectors: string }> => {
    const counts = await pool.query<{ items: string; vectors: string }>(
      `select
         (select count(*) from team_memory_semantic_items
           where id = any($1::uuid[])) as items,
         ((select count(*) from team_memory_semantic_vectors_384
             where semantic_item_id = any($1::uuid[]))
          + (select count(*) from team_memory_semantic_vectors_1024
             where semantic_item_id = any($1::uuid[]))
          + (select count(*) from team_memory_semantic_vectors_1536
             where semantic_item_id = any($1::uuid[]))
          + (select count(*) from team_memory_semantic_vectors_3072
             where semantic_item_id = any($1::uuid[])))::text as vectors`,
      [semanticItemIds]
    );
    return counts.rows[0]!;
  };

  const createOwnerReplicaFixture = async (
    existingFixture?: Fixture
  ): Promise<OwnerReplicaFixture> => {
    const fixture = existingFixture ?? (await createFixture());
    const ownerPrincipalId = randomUUID();
    const session = await pool.query<{ id: string }>(
      `insert into sessions (
         owner_user_id, visibility, source_runtime,
         capture_method, external_session_id, metadata
       ) values ($1, 'personal', 'codex', 'api', $2, $3::jsonb)
       returning id`,
      [
        fixture.userId,
        `remote-${randomUUID()}`,
        JSON.stringify({ privateTitle: "owner-only replica" })
      ]
    );
    const deployment = await pool.query<{ id: string }>(
      `insert into deployment_identities (
         protocol_deployment_id, locality, profile, display_name
       ) values ($1, 'remote', 'team_self_hosted', $2) returning id`,
      [randomUUID(), `Retention Remote ${randomUUID()}`]
    );
    const logicalMemory = await pool.query<{ id: string }>(
      `with logical_memory as (
         insert into logical_memories (
           owner_user_id,owner_principal_id,origin_deployment_identity_id,
           source_kind,logical_key
         ) values ($1,$2,$3,'captured_session',$4)
         returning id
       ), protocol_binding as (
         insert into captured_session_logical_memories (
           logical_memory_id,source_session_id,owner_principal_id
         ) select id,$5,$2 from logical_memory
       ), local_binding as (
         insert into local_captured_session_logical_memories (
           logical_memory_id,local_session_id,owner_user_id
         ) select id,$5,$1 from logical_memory
       )
       select id from logical_memory`,
      [
        fixture.userId,
        ownerPrincipalId,
        deployment.rows[0]!.id,
        `retention-logical-${randomUUID()}`,
        session.rows[0]!.id
      ]
    );
    const replica = await pool.query<{ id: string }>(
      `insert into memory_replicas (
         logical_memory_id, deployment_identity_id, owner_user_id,
         owner_principal_id, replica_role, source_boundary,
         encryption_scope, freshness_status
       ) values (
         $1, $2, $3, $4, 'target', 'captured_session',
         'owner_private_replica', 'fresh'
       ) returning id`,
      [
        logicalMemory.rows[0]!.id,
        deployment.rows[0]!.id,
        fixture.userId,
        ownerPrincipalId
      ]
    );
    const remoteIdentity = await pool.query<{ id: string }>(
      `insert into sync_external_user_identities (
         deployment_identity_id, external_subject_id
       ) values ($1, $2) returning id`,
      [deployment.rows[0]!.id, `retention-subject-${randomUUID()}`]
    );
    const deviceCredential = await pool.query<{ id: string }>(
      `insert into device_credentials (
         owner_user_id, credential_key_id, upstream_backend_id,
         device_instance_id, verifier_kind, verifier_hash, operation_families
       ) values ($1, $2, $3, $4, 'secret_hash', $5, $6::text[])
       returning id`,
      [
        fixture.userId,
        `retention-key-${randomUUID()}`,
        `retention-backend-${randomUUID()}`,
        `retention-device-${randomUUID()}`,
        hash(`retention-credential-${randomUUID()}`),
        ["sync"]
      ]
    );
    const relationship = await pool.query<{ id: string }>(
      `insert into cross_identity_sync_relationships (
         logical_memory_id, side, local_replica_id, local_user_id,
         device_credential_id, remote_deployment_identity_id,
         remote_user_identity_id, remote_replica_id, source_boundary,
         state, idempotency_key, creation_request_hash
       ) values (
         $1, 'target', $2, $3, $4, $5, $6, $7, 'captured_session',
         'ready', $8, $9
       ) returning id`,
      [
        logicalMemory.rows[0]!.id,
        replica.rows[0]!.id,
        fixture.userId,
        deviceCredential.rows[0]!.id,
        deployment.rows[0]!.id,
        remoteIdentity.rows[0]!.id,
        randomUUID(),
        `retention-sync-${randomUUID()}`,
        hash(`retention-sync-request-${randomUUID()}`)
      ]
    );
    return {
      ...fixture,
      ownerPrincipalId,
      logicalMemoryId: logicalMemory.rows[0]!.id,
      ownerPrivateReplicaId: replica.rows[0]!.id,
      localSessionId: session.rows[0]!.id,
      syncRelationshipId: relationship.rows[0]!.id,
      deploymentIdentityId: deployment.rows[0]!.id
    };
  };

  const seedOwnerReplicaArtifacts = async (
    fixture: OwnerReplicaFixture,
    sourceArtifactId?: string
  ) => {
    const item = await pool.query<{ id: string }>(
      `insert into conversation_items (
         owner_user_id, visibility, session_id, source_kind,
         source_adapter_version, source_transport, source_record_type,
         raw_json, raw_text, source_hash, idempotency_key,
         canonical_item_key
       ) values (
         $1, 'personal', $2, 'koed_sync', '1', 'remote', 'message',
         '{}'::jsonb, '[koed encrypted conversation item]', $3, $4, $5
       ) returning id`,
      [
        fixture.userId,
        fixture.localSessionId,
        hash(`item-source-${randomUUID()}`),
        `item-${randomUUID()}`,
        `canonical-${randomUUID()}`
      ]
    );
    const event = await pool.query<{ id: string }>(
      `insert into memory_events (
         owner_user_id, visibility, event_type, capture_method, session_id,
         idempotency_key, source_hash, payload
       ) values (
         $1, 'personal', 'captured', 'api', $2, $3, $4,
         '{"contentEncrypted":true}'::jsonb
       ) returning id`,
      [
        fixture.userId,
        fixture.localSessionId,
        `event-${randomUUID()}`,
        hash(`event-source-${randomUUID()}`)
      ]
    );
    const message = await pool.query<{ id: string }>(
      `insert into messages (
         session_id, owner_user_id, visibility, role, content,
         source_runtime, capture_method, source_event_time
       ) values (
         $1,$2,'personal','assistant','[koed encrypted message]',
         'codex','api',now()
       ) returning id`,
      [fixture.localSessionId, fixture.userId]
    );
    const toolEvent = await pool.query<{ id: string }>(
      `insert into tool_events (
         session_id, owner_user_id, visibility, message_id, tool_name,
         source_runtime, capture_method, source_event_time
       ) values (
         $1,$2,'personal',$3,'fixture_tool','codex','api',now()
       ) returning id`,
      [fixture.localSessionId, fixture.userId, message.rows[0]!.id]
    );
    await pool.query("update memory_events set tool_event_id=$2 where id=$1", [
      event.rows[0]!.id,
      toolEvent.rows[0]!.id
    ]);
    const node = await pool.query<{ id: string }>(
      `insert into memory_nodes (
         owner_user_id, session_id, visibility, kind, summary_text,
         body_text, capture_method, source_items_json
       ) values (
         $1, $2, 'personal', 'leaf', '[koed encrypted memory node]',
         '[koed encrypted memory node]', 'mcp', '[]'::jsonb
       ) returning id`,
      [fixture.userId, fixture.localSessionId]
    );
    await pool.query(
      `insert into memory_event_sources (
         memory_event_id, conversation_item_id, source_order
       ) values ($1, $2, 0)`,
      [event.rows[0]!.id, item.rows[0]!.id]
    );
    await pool.query(
      `insert into memory_node_sources (
         memory_node_id, memory_event_id, source_order
       ) values ($1, $2, 0)`,
      [node.rows[0]!.id, event.rows[0]!.id]
    );
    const derivedNode = await pool.query<{ id: string }>(
      `insert into memory_nodes (
         owner_user_id, visibility, kind, summary_text, body_text,
         capture_method, source_items_json
       ) values (
         $1, 'personal', 'leaf', '[koed encrypted derived node]',
         '[koed encrypted derived node]', 'mcp', '[]'::jsonb
       ) returning id`,
      [fixture.userId]
    );
    const derivedParentNode = await pool.query<{ id: string }>(
      `insert into memory_nodes (
         owner_user_id, visibility, kind, summary_text, body_text,
         capture_method, source_items_json
       ) values (
         $1, 'personal', 'rollup', '[koed encrypted derived rollup]',
         '[koed encrypted derived rollup]', 'mcp', '[]'::jsonb
       ) returning id`,
      [fixture.userId]
    );
    await pool.query(
      `insert into memory_node_sources (
         memory_node_id, memory_event_id, message_id, source_order
       ) values ($1, $2, $3, 0)`,
      [derivedNode.rows[0]!.id, event.rows[0]!.id, message.rows[0]!.id]
    );
    await pool.query(
      `insert into memory_node_children (
         parent_memory_node_id, child_memory_node_id, child_order
       ) values ($1, $2, 0)`,
      [derivedParentNode.rows[0]!.id, derivedNode.rows[0]!.id]
    );
    const embedding = await pool.query<{ id: string }>(
      `insert into memory_embeddings (
         memory_event_id, owner_user_id, visibility, embedding_model,
         embedding_dimensions, embedding_version, source_hash,
         canonical_embedding_state, embedding_source_content_hash,
         embedding_input_hash
       ) values ($1, $2, 'personal', 'fixture', 384, '1', $3,
         'encrypted_payload', $4, $4) returning id`,
      [
        event.rows[0]!.id,
        fixture.userId,
        hash(`embedding-${randomUUID()}`),
        hash("encrypted-event-embedding-input")
      ]
    );
    await pool.query(
      `insert into memory_embeddings_384 (memory_embedding_id, embedding)
       values ($1, $2::vector)`,
      [embedding.rows[0]!.id, `[${Array(384).fill("0").join(",")}]`]
    );
    const derivedEmbedding = await pool.query<{ id: string }>(
      `insert into memory_embeddings (
         memory_node_id, owner_user_id, visibility, embedding_model,
         embedding_dimensions, embedding_version, source_hash,
         canonical_embedding_state, embedding_source_content_hash,
         embedding_input_hash
       ) values ($1, $2, 'personal', 'fixture', 384, '1', $3,
         'encrypted_payload', $4, $4) returning id`,
      [
        derivedParentNode.rows[0]!.id,
        fixture.userId,
        hash(`derived-embedding-${randomUUID()}`),
        hash("encrypted-derived-embedding-input")
      ]
    );
    await pool.query(
      `insert into memory_embeddings_384 (memory_embedding_id, embedding)
       values ($1, $2::vector)`,
      [derivedEmbedding.rows[0]!.id, `[${Array(384).fill("0").join(",")}]`]
    );

    const encryptedSources = [
      ["conversation_items", item.rows[0]!.id, "raw_json"],
      ["memory_events", event.rows[0]!.id, "payload"],
      ["memory_nodes", node.rows[0]!.id, "summary_text"],
      ["memory_nodes", derivedNode.rows[0]!.id, "summary_text"],
      ["memory_nodes", derivedParentNode.rows[0]!.id, "summary_text"],
      ["memory_embeddings", embedding.rows[0]!.id, "source_text"],
      ["memory_embeddings", derivedEmbedding.rows[0]!.id, "source_text"],
      ["memory_replica_revisions", fixture.ownerPrivateReplicaId, "payload"],
      ...(sourceArtifactId
        ? [["shared_source_artifacts", sourceArtifactId, "artifact"]]
        : [])
    ];
    for (const [sourceTable, sourceId, sourceColumn] of encryptedSources) {
      await pool.query(
        `insert into encrypted_field_payloads (
           owner_user_id, owner_principal_id, visibility, encryption_scope,
           source_table, source_id, source_column, envelope_version,
           provider_mode, key_id, key_version, scope, provenance, algorithm,
           ciphertext, nonce, tag, wrapped_dek, ciphertext_location, aad,
           envelope_created_at
         ) values (
           $1, $2, 'personal', 'owner_private_replica', $3, $4, $5, 1,
           'local_test_key', 'owner-private-key', 1, '{}'::jsonb,
           '{}'::jsonb, 'aes-256-gcm', $6, 'nonce', 'tag',
           '{"key":"wrapped"}'::jsonb, 'encrypted_field_payloads',
           $7::jsonb, now()
         )`,
        [
          fixture.userId,
          fixture.ownerPrincipalId,
          sourceTable,
          sourceId,
          sourceColumn,
          `ciphertext-${randomUUID()}`,
          JSON.stringify({ syncRelationshipId: fixture.syncRelationshipId })
        ]
      );
    }

    const upload = await pool.query<{ id: string }>(
      `insert into sync_package_upload_sessions (
         sync_relationship_id, protocol_package_id, request_hash,
         package_manifest, package_checksum, source_sequence, from_cursor,
         to_cursor, total_bytes, uploaded_bytes, expected_chunk_count,
         chunk_count, verified_chunk_count, idempotency_key
       ) values (
         $1, $2, $3, '{}'::jsonb, $4, 1, 0, 1, 16, 16, 1, 1, 0, $5
       ) returning id`,
      [
        fixture.syncRelationshipId,
        randomUUID(),
        hash(`package-request-${randomUUID()}`),
        hash(`package-${randomUUID()}`),
        `package-${randomUUID()}`
      ]
    );
    await pool.query(
      `insert into sync_package_chunks (
         upload_session_id, chunk_index, chunk_checksum, byte_count,
         encrypted_payload
       ) values ($1, 0, $2, 16, '{"wrappedDek":"secret"}'::jsonb)`,
      [upload.rows[0]!.id, hash(`chunk-${randomUUID()}`)]
    );
    for (const table of ["sync_outbox_entries", "sync_inbox_entries"]) {
      await pool.query(
        `insert into ${table} (
           sync_relationship_id, upload_session_id, idempotency_key,
           request_hash, payload_manifest
         ) values ($1, $2, $3, $4, '{}'::jsonb)`,
        [
          fixture.syncRelationshipId,
          upload.rows[0]!.id,
          `${table}-${randomUUID()}`,
          hash(`${table}-${randomUUID()}`)
        ]
      );
    }
    await pool.query(
      `insert into sync_event_mappings (
         sync_relationship_id, origin_event_id, revision_hash,
         local_memory_event_id, source_cursor
       ) values ($1, $2, $3, $4, 1)`,
      [
        fixture.syncRelationshipId,
        randomUUID(),
        hash(`event-revision-${randomUUID()}`),
        event.rows[0]!.id
      ]
    );
    await pool.query(
      `insert into sync_summary_node_mappings (
         sync_relationship_id, origin_node_id, revision_hash,
         local_memory_node_id
       ) values ($1, $2, $3, $4)`,
      [
        fixture.syncRelationshipId,
        randomUUID(),
        hash(`node-revision-${randomUUID()}`),
        node.rows[0]!.id
      ]
    );
    await pool.query(
      `insert into sync_semantic_changes (
         session_id, memory_event_id, origin_event_id, operation,
         revision_hash
       ) values ($1, $2, $3, 'upsert', $4)`,
      [
        fixture.localSessionId,
        event.rows[0]!.id,
        randomUUID(),
        hash(`semantic-${randomUUID()}`)
      ]
    );
    await pool.query(
      `insert into semantic_memory_rebuild_jobs (
         owner_user_id, visibility, memory_event_id, scheduled_after
       ) values ($1, 'personal', $2, now())`,
      [fixture.userId, event.rows[0]!.id]
    );
    await pool.query(
      `insert into local_work_queue (
         queue_name, job_name, job_key, data
       ) values ('memory-embed', 'embed-source', $1, $2::jsonb)`,
      [
        `owner-private-${randomUUID()}`,
        JSON.stringify({
          sourceType: "memory_event",
          sourceId: event.rows[0]!.id
        })
      ]
    );
    await pool.query(
      `insert into sync_recipient_keys (
         deployment_identity_id, key_id, key_version, algorithm, public_jwk,
         encrypted_private_key
       ) values ($1, $2, 1, 'rsa-oaep-256', '{}'::jsonb, $3::jsonb)`,
      [
        fixture.deploymentIdentityId,
        `recipient-${randomUUID()}`,
        JSON.stringify({ ciphertext: "recipient-key-must-survive" })
      ]
    );
    return {
      itemId: item.rows[0]!.id,
      eventId: event.rows[0]!.id,
      nodeId: node.rows[0]!.id,
      embeddingId: embedding.rows[0]!.id,
      derivedNodeId: derivedNode.rows[0]!.id,
      derivedParentNodeId: derivedParentNode.rows[0]!.id,
      derivedEmbeddingId: derivedEmbedding.rows[0]!.id,
      uploadId: upload.rows[0]!.id
    };
  };

  const createEligibleTeamDecision = async (fixture: Fixture) => {
    const policy = await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 0,
      effectiveAt: new Date("2025-01-01T00:00:00.000Z"),
      createdByUserId: fixture.userId
    });
    return repository.snapshotDecision({
      policyId: policy.policyId,
      target: {
        kind: "team",
        targetId: fixture.teamId,
        teamId: fixture.teamId
      },
      trigger: "team_deletion",
      triggeredAt: new Date("2025-02-01T00:00:00.000Z"),
      decidedAt: now
    });
  };

  const createCollaborationPurgeFixture = async (fixture: Fixture) => {
    const thread = await pool.query<{ id: string }>(
      `insert into collaboration_threads (
         scope, kind, team_id, team_workspace_id, system_key, created_by_user_id
       ) values (
         'team', 'workspace_channel', $1, $2, 'workspace.general', $3
      ) returning id`,
      [fixture.teamId, fixture.teamWorkspaceId, fixture.userId]
    );
    const audienceMembers = [fixture.userId, fixture.secondUserId].sort();
    await pool.query(
      `insert into collaboration_thread_audiences (
         thread_id, version, member_set_hash
       ) values ($1, 1, $2)`,
      [
        thread.rows[0]!.id,
        hash(
          `koed:collaboration:audience-members:v1\n${JSON.stringify(audienceMembers)}`
        )
      ]
    );
    await pool.query(
      `insert into collaboration_thread_audience_members (
         thread_id, audience_version, user_id
       )
       select $1, 1, member.user_id
       from unnest($2::uuid[]) as member(user_id)`,
      [thread.rows[0]!.id, audienceMembers]
    );
    const message = await pool.query<{ id: string }>(
      `insert into collaboration_messages (
         thread_id, thread_sequence, audience_version, scope, team_id,
         team_workspace_id,
         sender_kind, sender_principal_id, sender_user_id,
         idempotency_key_hash, request_hash, body_marker, metadata_marker,
         provenance_kind, provenance_id, provenance_marker
       ) values (
         $1, 1, 1, 'team', $2, $3, 'user', $4, $4, $5, $6,
         '[koed encrypted collaboration message]',
         '[koed encrypted collaboration metadata]',
         'fixture', $7, '[koed encrypted collaboration provenance]'
       ) returning id`,
      [
        thread.rows[0]!.id,
        fixture.teamId,
        fixture.teamWorkspaceId,
        fixture.userId,
        hash(`message-idempotency-${randomUUID()}`),
        hash(`message-request-${randomUUID()}`),
        `fixture-${randomUUID()}`
      ]
    );
    await pool.query(
      `insert into collaboration_outbox (
         protocol_version, family, scope, team_id, team_workspace_id,
         thread_id, message_id, resource_type, resource_id, mutation_id,
         replay_until
       ) values (
         1, 'message_created', 'team', $1, $2, $3, $4, 'message', $4, $5,
         now() + interval '1 day'
       )`,
      [
        fixture.teamId,
        fixture.teamWorkspaceId,
        thread.rows[0]!.id,
        message.rows[0]!.id,
        randomUUID()
      ]
    );
    await pool.query(
      `insert into encrypted_field_payloads (
         team_id, team_workspace_id, visibility, encryption_scope,
         source_table, source_id, source_column, envelope_version,
         provider_mode, key_id, key_version, scope, provenance, algorithm,
         ciphertext, nonce, tag, wrapped_dek, ciphertext_location, aad,
         envelope_created_at
       ) values (
         $1, $2, 'personal', 'team', 'collaboration_messages', $3, 'body',
         1, 'local_test_key', 'team-key', 1, '{}'::jsonb, '{}'::jsonb,
         'aes-256-gcm', 'ciphertext', 'nonce', 'tag', '{}'::jsonb,
         'encrypted_field_payloads', '{}'::jsonb, now()
       )`,
      [fixture.teamId, fixture.teamWorkspaceId, message.rows[0]!.id]
    );
    return {
      threadId: thread.rows[0]!.id,
      messageId: message.rows[0]!.id
    };
  };

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  afterEach(async () => {
    await pool.query(
      `truncate table retention_policy_shortening_migrations,
         retention_policy_shortening_affected_scopes,
         retention_policy_shortening_previews, purge_job_evidence,
         purge_job_attempts, purge_jobs, retention_decisions, legal_holds,
         retention_policies cascade`
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("versions policies prospectively and resolves the version effective at the trigger", async () => {
    const fixture = await createFixture();
    now = new Date("2026-01-10T00:00:00.000Z");
    resetRepository();
    const first = await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 100,
      deletionGraceSeconds: 20,
      effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      createdByUserId: fixture.userId
    });
    await expect(
      repository.versionPolicy({
        policyId: first.policyId,
        retentionSeconds: 200,
        effectiveAt: new Date("2026-01-09T00:00:00.000Z"),
        actorUserId: fixture.userId,
        expectedTeamId: fixture.teamId
      })
    ).rejects.toThrow("prospectively");
    const second = await repository.versionPolicy({
      policyId: first.policyId,
      retentionSeconds: 200,
      deletionGraceSeconds: 30,
      effectiveAt: new Date("2026-01-20T00:00:00.000Z"),
      actorUserId: fixture.userId,
      expectedTeamId: fixture.teamId
    });

    const oldDecisionInput = {
      policyId: first.policyId,
      target: {
        kind: "team" as const,
        targetId: fixture.teamId,
        teamId: fixture.teamId
      },
      trigger: "team_deletion" as const,
      triggeredAt: new Date("2026-01-15T00:00:00.000Z"),
      decidedAt: new Date("2026-02-01T00:00:00.000Z")
    };
    const oldDecision = await repository.snapshotDecision(oldDecisionInput);
    const repeated = await repository.snapshotDecision(oldDecisionInput);
    const newDecision = await repository.snapshotDecision({
      ...oldDecisionInput,
      triggeredAt: new Date("2026-01-25T00:00:00.000Z")
    });

    expect(second.version).toBe(2);
    expect(oldDecision.policyVersion).toBe(1);
    expect(oldDecision.retainUntil.toISOString()).toBe(
      "2026-01-15T00:02:00.000Z"
    );
    expect(newDecision.policyVersion).toBe(2);
    expect(newDecision.retainUntil.toISOString()).toBe(
      "2026-01-25T00:03:50.000Z"
    );
    expect(repeated.decisionSnapshotHash).toBe(
      oldDecision.decisionSnapshotHash
    );

    const persistedOldDecision = await pool.query<{
      policy_version: number;
      retain_until: Date;
      decision_snapshot_hash: string;
    }>(
      `select policy_version, retain_until, decision_snapshot_hash
         from retention_decisions where id = $1`,
      [oldDecision.id]
    );
    expect(persistedOldDecision.rows[0]).toEqual({
      policy_version: 1,
      retain_until: oldDecision.retainUntil,
      decision_snapshot_hash: oldDecision.decisionSnapshotHash
    });
  });

  it("requires an exact affected-scope preview, grace, hold re-evaluation, and explicit confirmation before shortening existing retention", async () => {
    const fixture = await createFixture();
    now = new Date("2026-01-10T00:00:00.000Z");
    resetRepository();
    const first = await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 40 * 24 * 60 * 60,
      effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      createdByUserId: fixture.userId
    });
    const original = await repository.snapshotDecision({
      policyId: first.policyId,
      target: {
        kind: "team",
        targetId: fixture.teamId,
        teamId: fixture.teamId
      },
      trigger: "team_deletion",
      triggeredAt: new Date("2026-01-05T00:00:00.000Z"),
      decidedAt: now
    });
    const purgeJob = await repository.createPurgeJob({
      retentionDecisionId: original.id,
      idempotencyKey: `shortening-${randomUUID()}`,
      requiredArtifacts: [
        {
          artifactKind: "database_row",
          artifactLocatorHash: hash("shortening-database-row")
        }
      ]
    });
    const shortenedPolicy = await repository.versionPolicy({
      policyId: first.policyId,
      retentionSeconds: 24 * 60 * 60,
      effectiveAt: new Date("2026-01-20T00:00:00.000Z"),
      actorUserId: fixture.userId,
      expectedTeamId: fixture.teamId
    });
    const firstPreview = await repository.previewPolicyShortening({
      policyId: first.policyId,
      policyVersion: shortenedPolicy.version,
      actorUserId: fixture.userId,
      expectedTeamId: fixture.teamId,
      graceSeconds: 24 * 60 * 60
    });

    expect(firstPreview.graceUntil.toISOString()).toBe(
      "2026-01-20T00:00:00.000Z"
    );
    expect(firstPreview).toMatchObject({
      state: "pending",
      confirmedByUserId: null,
      confirmedAt: null,
      invalidatedAt: null,
      invalidationReasonCode: null
    });
    expect(firstPreview.affectedScopes).toEqual([
      {
        retentionDecisionId: original.id,
        targetKind: "team",
        targetId: fixture.teamId,
        previousRetainUntil: new Date("2026-02-14T00:00:00.000Z"),
        shortenedRetainUntil: new Date("2026-01-20T00:00:00.000Z"),
        applicableLegalHoldIds: []
      }
    ]);
    const unchanged = await pool.query<{ retain_until: Date }>(
      "select retain_until from retention_decisions where id = $1",
      [original.id]
    );
    expect(unchanged.rows[0]?.retain_until).toEqual(original.retainUntil);
    await expect(
      repository.confirmPolicyShortening({
        previewId: firstPreview.id,
        previewHash: firstPreview.previewHash,
        expectedAffectedScopeCount: 1,
        actorUserId: fixture.secondUserId,
        expectedTeamId: fixture.teamId,
        expectedPolicyId: first.policyId
      })
    ).rejects.toThrow("grace period is still active");

    now = new Date("2026-01-19T00:00:00.000Z");
    const hold = await repository.placeLegalHold({
      target: { scope: "team", teamId: fixture.teamId },
      actorUserId: fixture.userId,
      authority: "team.legal_hold.manage",
      reasonCode: "shortening.review",
      reasonHash: hash("shortening review"),
      freshlyAuthenticatedAt: now
    });
    now = new Date("2026-01-20T00:00:00.000Z");
    await expect(
      repository.confirmPolicyShortening({
        previewId: firstPreview.id,
        previewHash: firstPreview.previewHash,
        expectedAffectedScopeCount: 1,
        actorUserId: fixture.secondUserId,
        expectedTeamId: fixture.teamId,
        expectedPolicyId: first.policyId
      })
    ).rejects.toThrow("stale after hold or scope re-evaluation");
    const invalidated = await pool.query<{
      state: string;
      invalidation_reason_code: string;
      invalidated_at: Date;
      migration_count: string;
      invalidation_audit_count: string;
    }>(
      `select preview.state, preview.invalidation_reason_code,
              preview.invalidated_at,
              (select count(*) from retention_policy_shortening_migrations migration
                where migration.preview_id = preview.id)::text as migration_count,
              (select count(*) from audit_events audit
                where audit.action = 'team.retention_policy.shortening_invalidated'
                  and audit.target_table = 'retention_policy_shortening_previews'
                  and audit.target_id = preview.id)::text as invalidation_audit_count
         from retention_policy_shortening_previews preview
        where preview.id = $1`,
      [firstPreview.id]
    );
    expect(invalidated.rows[0]).toMatchObject({
      state: "invalidated",
      invalidation_reason_code: "affected_scope_changed",
      invalidated_at: now,
      migration_count: "0",
      invalidation_audit_count: "1"
    });
    await repository.requestLegalHoldRelease({
      holdId: hold.id,
      actorUserId: fixture.userId
    });
    await repository.confirmLegalHoldRelease({
      holdId: hold.id,
      actorUserId: fixture.secondUserId
    });

    const currentPreview = await repository.previewPolicyShortening({
      policyId: first.policyId,
      policyVersion: shortenedPolicy.version,
      actorUserId: fixture.userId,
      expectedTeamId: fixture.teamId,
      graceSeconds: 60
    });
    await expect(
      repository.confirmPolicyShortening({
        previewId: currentPreview.id,
        previewHash: currentPreview.previewHash,
        expectedAffectedScopeCount: 1,
        actorUserId: fixture.secondUserId,
        expectedTeamId: fixture.teamId,
        expectedPolicyId: first.policyId
      })
    ).rejects.toThrow("grace period is still active");
    now = new Date("2026-01-20T00:01:00.000Z");
    const mismatchedPreviewHash = `${currentPreview.previewHash[0] === "0" ? "1" : "0"}${currentPreview.previewHash.slice(1)}`;
    await expect(
      repository.confirmPolicyShortening({
        previewId: currentPreview.id,
        previewHash: mismatchedPreviewHash,
        expectedAffectedScopeCount: 1,
        actorUserId: fixture.secondUserId,
        expectedTeamId: fixture.teamId,
        expectedPolicyId: first.policyId
      })
    ).rejects.toThrow("does not match its preview");
    await expect(
      pool.query(
        `update retention_policy_shortening_previews
            set preview_hash = $2
          where id = $1`,
        [currentPreview.id, mismatchedPreviewHash]
      )
    ).rejects.toThrow("preview snapshot is immutable");
    await expect(
      pool.query(
        `update retention_policy_shortening_affected_scopes
            set target_id = $2
          where preview_id = $1`,
        [currentPreview.id, randomUUID()]
      )
    ).rejects.toThrow("snapshot and migration rows are immutable");
    await expect(
      pool.query(
        `insert into retention_policy_shortening_previews (
           retention_policy_row_id, team_id, policy_id, policy_version,
           policy_hash, affected_scope_count, preview_hash,
           previewed_by_user_id, previewed_at, grace_until
         )
         select id, team_id, policy_id, version, $2, 0, $3,
                $4, $5::timestamptz, $5::timestamptz + interval '1 minute'
           from retention_policies
          where policy_id = $1 and version = 2`,
        [
          first.policyId,
          hash("forged-policy-hash"),
          hash("forged-policy-preview"),
          fixture.userId,
          now
        ]
      )
    ).rejects.toThrow("retention_policy_shortening_previews_policy_fk");

    const incompletePreview = await pool.connect();
    try {
      await incompletePreview.query("begin");
      await incompletePreview.query(
        `insert into retention_policy_shortening_previews (
           retention_policy_row_id, team_id, policy_id, policy_version,
           policy_hash, affected_scope_count, preview_hash,
           previewed_by_user_id, previewed_at, grace_until
         )
         select id, team_id, policy_id, version, policy_hash, 1, $2,
                $3, $4::timestamptz, $4::timestamptz + interval '1 minute'
           from retention_policies
          where policy_id = $1 and version = 2`,
        [
          first.policyId,
          hash("malformed-shortening-preview"),
          fixture.userId,
          now
        ]
      );
      await expect(incompletePreview.query("commit")).rejects.toThrow(
        "expected 1 affected scopes but has 0"
      );
    } finally {
      await incompletePreview.query("rollback").catch(() => undefined);
      incompletePreview.release();
    }

    const incompleteConfirmation = await pool.connect();
    try {
      await incompleteConfirmation.query("begin");
      await incompleteConfirmation.query(
        `update retention_policy_shortening_previews
            set state = 'confirmed', confirmed_by_user_id = $2,
                confirmed_at = $3, updated_at = $3
          where id = $1`,
        [currentPreview.id, fixture.secondUserId, now]
      );
      await expect(incompleteConfirmation.query("commit")).rejects.toThrow(
        "expected 1 migrations but has 0"
      );
    } finally {
      await incompleteConfirmation.query("rollback").catch(() => undefined);
      incompleteConfirmation.release();
    }
    const confirmation = await repository.confirmPolicyShortening({
      previewId: currentPreview.id,
      previewHash: currentPreview.previewHash,
      expectedAffectedScopeCount: 1,
      actorUserId: fixture.secondUserId,
      expectedTeamId: fixture.teamId,
      expectedPolicyId: first.policyId
    });

    expect(confirmation.migratedDecisionIds).toHaveLength(1);
    const persisted = await pool.query<{
      id: string;
      trigger: string;
      policy_version: number;
      retain_until: Date;
      applicable_legal_hold_ids: string[];
      purge_decision_id: string;
      old_retain_until: Date;
      preview_state: string;
      affected_scope_count: number;
      persisted_preview_hash: string;
      persisted_grace_until: Date;
      confirmed_by_user_id: string;
      confirmed_at: Date;
      scope_retention_decision_id: string;
      scope_snapshot_hash: string;
      migration_previous_decision_id: string;
      migration_decision_id: string;
      confirmation_audits: string;
      audit_metadata: Record<string, unknown>;
    }>(
      `select migrated.id, migrated.trigger, migrated.policy_version,
              migrated.retain_until, migrated.applicable_legal_hold_ids,
              job.retention_decision_id as purge_decision_id,
              original.retain_until as old_retain_until,
              preview.state as preview_state,
              preview.affected_scope_count,
              preview.preview_hash as persisted_preview_hash,
              preview.grace_until as persisted_grace_until,
              preview.confirmed_by_user_id,
              preview.confirmed_at,
              affected.retention_decision_id as scope_retention_decision_id,
              affected.scope_snapshot_hash,
              migration.previous_retention_decision_id as migration_previous_decision_id,
              migration.migrated_retention_decision_id as migration_decision_id,
              (select count(*) from audit_events audit
                where audit.action = 'team.retention_policy.shortening_confirmed'
                  and audit.target_table = 'retention_policy_shortening_previews'
                  and audit.target_id = $4)::text as confirmation_audits,
              (select audit.metadata from audit_events audit
                where audit.action = 'team.retention_policy.shortening_confirmed'
                  and audit.target_table = 'retention_policy_shortening_previews'
                  and audit.target_id = $4
                limit 1) as audit_metadata
         from retention_decisions migrated
         join retention_decisions original on original.id = $1
         join purge_jobs job on job.id = $2
         join retention_policy_shortening_previews preview on preview.id = $4
         join retention_policy_shortening_affected_scopes affected
           on affected.preview_id = preview.id
         join retention_policy_shortening_migrations migration
           on migration.preview_id = preview.id
          and migration.affected_scope_id = affected.id
        where migrated.id = $3`,
      [
        original.id,
        purgeJob.id,
        confirmation.migratedDecisionIds[0],
        currentPreview.id
      ]
    );
    expect(persisted.rows[0]).toMatchObject({
      id: confirmation.migratedDecisionIds[0],
      trigger: "policy_migration",
      policy_version: 2,
      retain_until: new Date("2026-01-20T00:01:00.000Z"),
      applicable_legal_hold_ids: [],
      purge_decision_id: confirmation.migratedDecisionIds[0],
      old_retain_until: original.retainUntil,
      preview_state: "confirmed",
      affected_scope_count: 1,
      persisted_preview_hash: currentPreview.previewHash,
      persisted_grace_until: currentPreview.graceUntil,
      confirmed_by_user_id: fixture.secondUserId,
      confirmed_at: confirmation.confirmedAt,
      scope_retention_decision_id: original.id,
      migration_previous_decision_id: original.id,
      migration_decision_id: confirmation.migratedDecisionIds[0],
      confirmation_audits: "1"
    });
    expect(persisted.rows[0]?.scope_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted.rows[0]?.audit_metadata)).not.toMatch(
      /content|ciphertext|wrapped_dek|message_body|source_text/i
    );
    await expect(
      repository.confirmPolicyShortening({
        previewId: currentPreview.id,
        previewHash: currentPreview.previewHash,
        expectedAffectedScopeCount: 1,
        actorUserId: fixture.secondUserId,
        expectedTeamId: fixture.teamId,
        expectedPolicyId: first.policyId
      })
    ).resolves.toEqual(confirmation);
    await expect(
      pool.query(
        `update retention_policy_shortening_previews
            set state = 'pending', confirmed_by_user_id = null,
                confirmed_at = null
          where id = $1`,
        [currentPreview.id]
      )
    ).rejects.toThrow(
      "invalid retention policy shortening preview state transition"
    );
    await expect(
      pool.query(
        `delete from retention_policy_shortening_migrations
          where preview_id = $1`,
        [currentPreview.id]
      )
    ).rejects.toThrow("snapshot and migration rows are immutable");
    const postConfirmationPreview = await repository.previewPolicyShortening({
      policyId: first.policyId,
      policyVersion: shortenedPolicy.version,
      actorUserId: fixture.userId,
      expectedTeamId: fixture.teamId,
      graceSeconds: 60
    });
    expect(postConfirmationPreview.affectedScopes).toEqual([]);
  });

  it("snapshots every retention trigger with an immutable content-free policy basis", async () => {
    const fixture = await createFixture();
    now = new Date("2026-01-10T00:00:00.000Z");
    resetRepository();
    const policy = await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 90,
      deletionGraceSeconds: 30,
      effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
      createdByUserId: fixture.userId
    });
    const triggers = [
      "share_revoked",
      "team_deletion",
      "workspace_policy",
      "user_erasure",
      "source_purge",
      "policy_migration"
    ] as const;

    const decisions = [];
    for (const [index, trigger] of triggers.entries()) {
      const triggeredAt = new Date(
        Date.parse("2026-01-05T00:00:00.000Z") + index * 1_000
      );
      decisions.push(
        await repository.snapshotDecision({
          policyId: policy.policyId,
          target: {
            kind: "team",
            targetId: fixture.teamId,
            teamId: fixture.teamId
          },
          trigger,
          triggeredAt,
          decidedAt: now
        })
      );
    }

    expect(
      decisions.map((decision) => ({
        trigger: decision.trigger,
        policyId: decision.policyId,
        policyVersion: decision.policyVersion,
        retentionMs:
          decision.retainUntil.getTime() - decision.triggeredAt.getTime(),
        holds: decision.applicableLegalHoldIds,
        hashIsSha256: /^[a-f0-9]{64}$/.test(decision.decisionSnapshotHash)
      }))
    ).toEqual(
      triggers.map((trigger) => ({
        trigger,
        policyId: policy.policyId,
        policyVersion: 1,
        retentionMs: 120_000,
        holds: [],
        hashIsSha256: true
      }))
    );
    expect(new Set(decisions.map((decision) => decision.id)).size).toBe(6);
    expect(
      new Set(decisions.map((decision) => decision.decisionSnapshotHash)).size
    ).toBe(6);

    const columns = await pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public' and table_name = 'retention_decisions'
        order by column_name`
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([
        "content",
        "message_body",
        "source_text",
        "ciphertext",
        "wrapped_dek"
      ])
    );
  });

  it("keeps Team/grant holds separate from owner-private holds and applies broad hold precedence", async () => {
    const fixture = await createSharedMemoryFixture(undefined, "lcm_rollups");
    const rollupRepresentationId = fixture.representationId;
    const rollupSourceRevision = fixture.sourceRevision;
    now = new Date("2026-02-01T00:00:00.000Z");
    const authorizedScopes: string[] = [];
    resetRepository(async (context) => {
      authorizedScopes.push(context.target.scope);
      return true;
    });
    const teamPolicy = await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 0,
      effectiveAt: new Date("2025-01-01T00:00:00.000Z")
    });
    const ownerPolicy = await repository.createPolicy({
      target: {
        scope: "owner_private_replica",
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      retentionSeconds: 0,
      effectiveAt: new Date("2025-01-01T00:00:00.000Z")
    });
    const grantHold = await repository.placeLegalHold({
      target: {
        scope: "grant_representation",
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: fixture.shareGrantId,
        representationId: rollupRepresentationId,
        representation: "lcm_rollups",
        sourceRevision: rollupSourceRevision,
        logicalMemoryId: fixture.logicalMemoryId
      },
      actorUserId: fixture.userId,
      authority: "team.compliance",
      reasonCode: "matter.open",
      reasonHash: hash("grant matter"),
      freshlyAuthenticatedAt: now
    });
    const ownerHold = await repository.placeLegalHold({
      target: {
        scope: "owner_private_replica",
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      actorUserId: fixture.userId,
      authority: "owner.compliance",
      reasonCode: "owner.matter.open",
      reasonHash: hash("owner matter"),
      freshlyAuthenticatedAt: now
    });

    const grantDecision = await repository.snapshotDecision({
      policyId: teamPolicy.policyId,
      target: {
        kind: "grant_representation",
        targetId: rollupRepresentationId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: fixture.shareGrantId,
        representationId: rollupRepresentationId,
        representation: "lcm_rollups",
        sourceRevision: rollupSourceRevision,
        logicalMemoryId: fixture.logicalMemoryId
      },
      trigger: "share_revoked",
      triggeredAt: new Date("2026-01-01T00:00:00.000Z"),
      decidedAt: now
    });
    const mismatchedRevisionDecision = await repository.snapshotDecision({
      policyId: teamPolicy.policyId,
      target: {
        kind: "grant_representation",
        targetId: rollupRepresentationId,
        teamId: fixture.teamId,
        teamWorkspaceId: fixture.teamWorkspaceId,
        shareGrantId: fixture.shareGrantId,
        representationId: rollupRepresentationId,
        representation: "lcm_rollups",
        sourceRevision: rollupSourceRevision + 1,
        logicalMemoryId: fixture.logicalMemoryId
      },
      trigger: "share_revoked",
      triggeredAt: new Date("2026-01-01T00:00:00.000Z"),
      decidedAt: now
    });
    const teamDecision = await repository.snapshotDecision({
      policyId: teamPolicy.policyId,
      target: {
        kind: "team",
        targetId: fixture.teamId,
        teamId: fixture.teamId
      },
      trigger: "team_deletion",
      triggeredAt: new Date("2026-01-01T00:00:00.000Z"),
      decidedAt: now
    });
    const ownerDecision = await repository.snapshotDecision({
      policyId: ownerPolicy.policyId,
      target: {
        kind: "owner_private_replica",
        targetId: fixture.ownerPrivateReplicaId,
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      trigger: "user_erasure",
      triggeredAt: new Date("2026-01-01T00:00:00.000Z"),
      decidedAt: now
    });

    expect(grantDecision.applicableLegalHoldIds).toEqual([grantHold.id]);
    expect(mismatchedRevisionDecision.applicableLegalHoldIds).toEqual([]);
    expect(teamDecision.applicableLegalHoldIds).toEqual([grantHold.id]);
    expect(ownerDecision.applicableLegalHoldIds).toEqual([ownerHold.id]);
    expect(
      [grantDecision, teamDecision, ownerDecision].every((d) => !d.eligible)
    ).toBe(true);
    expect(authorizedScopes).toEqual([
      "grant_representation",
      "owner_private_replica"
    ]);
  });

  it("requires request plus an independently authorized release confirmation", async () => {
    const fixture = await createFixture();
    now = new Date("2026-03-01T00:00:00.000Z");
    let allowSingleHolderException = false;
    resetRepository(async (context) =>
      context.action === "single_holder_release"
        ? allowSingleHolderException
        : true
    );
    const place = () =>
      repository.placeLegalHold({
        target: { scope: "team", teamId: fixture.teamId },
        actorUserId: fixture.userId,
        authority: "team.compliance",
        reasonCode: "litigation",
        reasonHash: hash(randomUUID()),
        freshlyAuthenticatedAt: now
      });

    const independentHold = await place();
    await repository.requestLegalHoldRelease({
      holdId: independentHold.id,
      actorUserId: fixture.userId
    });
    await expect(
      repository.confirmLegalHoldRelease({
        holdId: independentHold.id,
        actorUserId: fixture.userId
      })
    ).rejects.toThrow("independent confirmer");
    const released = await repository.confirmLegalHoldRelease({
      holdId: independentHold.id,
      actorUserId: fixture.secondUserId
    });
    expect(released.state).toBe("released");
    expect(released.singleHolderReleaseException).toBe(false);

    const exceptionHold = await place();
    await repository.requestLegalHoldRelease({
      holdId: exceptionHold.id,
      actorUserId: fixture.userId
    });
    await expect(
      repository.confirmLegalHoldRelease({
        holdId: exceptionHold.id,
        actorUserId: fixture.userId,
        singleHolderReleaseException: true
      })
    ).rejects.toThrow("not authorized");
    allowSingleHolderException = true;
    const exceptionReleased = await repository.confirmLegalHoldRelease({
      holdId: exceptionHold.id,
      actorUserId: fixture.userId,
      singleHolderReleaseException: true
    });
    expect(exceptionReleased.singleHolderReleaseException).toBe(true);
  });

  it("authorizes owner-private purge requests and discovers one idempotent artifact set", async () => {
    const fixture = await createOwnerReplicaFixture();
    now = new Date("2026-03-15T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: {
        scope: "owner_private_replica",
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      retentionSeconds: 0,
      effectiveAt: new Date("2026-03-01T00:00:00.000Z"),
      createdByUserId: fixture.userId
    });

    await expect(
      repository.requestOwnerPrivateReplicaPurge({
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        actorUserId: fixture.secondUserId,
        expectedVersion: 1,
        triggeredAt: now
      })
    ).resolves.toBeNull();

    const input = {
      ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now,
      idempotencyKey: `owner-purge-${randomUUID()}`
    };
    const requests = await Promise.all([
      repository.requestOwnerPrivateReplicaPurge(input),
      repository.requestOwnerPrivateReplicaPurge(input)
    ]);
    expect(requests[0]?.decision.trigger).toBe("source_purge");
    expect(requests[0]?.purgeJob.id).toBe(requests[1]?.purgeJob.id);
    expect(
      requests[0]?.requiredArtifacts.map((artifact) => artifact.artifactKind)
    ).toEqual([
      "database_row",
      "encrypted_payload",
      "wrapped_key",
      "search_index",
      "vector",
      "outbox_replay",
      "backup_copy"
    ]);
    expect(
      requests[0]?.requiredArtifacts.every((artifact) =>
        /^[a-f0-9]{64}$/.test(artifact.artifactLocatorHash)
      )
    ).toBe(true);
    await expect(
      repository.createPurgeJob({
        retentionDecisionId: requests[0]!.decision.id,
        idempotencyKey: `owner-bypass-${randomUUID()}`,
        requiredArtifacts: [
          { artifactKind: "database_row", artifactLocatorHash: hash("bypass") }
        ]
      })
    ).rejects.toThrow("server discovery");
    const counts = await pool.query<{ jobs: string; audits: string }>(
      `select
         (select count(*) from purge_jobs where idempotency_key = $1) as jobs,
         (select count(*) from audit_events
           where action = 'owner_private_replica.deletion_requested'
             and target_id = $2) as audits`,
      [input.idempotencyKey, fixture.ownerPrivateReplicaId]
    );
    expect(counts.rows[0]).toEqual({ jobs: "1", audits: "1" });
  });

  it("tombstones an erased User while preserving separately encrypted Team memory", async () => {
    const fixture = await createSharedMemoryFixture();
    now = new Date("2026-03-18T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: {
        scope: "owner_private_replica",
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      retentionSeconds: 0,
      effectiveAt: new Date("2026-03-01T00:00:00.000Z")
    });
    await pool.query(
      `insert into user_sessions (user_id,session_hash,expires_at)
       values ($1,$2,$3)`,
      [fixture.userId, hash(`session-${randomUUID()}`), new Date("2027-01-01")]
    );
    await pool.query(
      `insert into api_tokens (owner_user_id,name,token_hash,token_prefix)
       values ($1,'erasure test',$2,'erasure_test')`,
      [fixture.userId, hash(`token-${randomUUID()}`)]
    );
    await pool.query(
      `insert into external_auth_identities (
         provider,provider_environment,provider_user_id,user_id,email,
         email_verified,display_name,profile
       ) values (
         'workos_authkit','default',$2,$1,'identifying@example.test',true,
         'Identifying Name','{"private":"profile"}'::jsonb
       )`,
      [fixture.userId, `workos-${randomUUID()}`]
    );
    await pool.query(
      `update users
          set email='identifying@example.test', display_name='Identifying Name',
              avatar_reference='private-avatar', password_hash='private-hash'
        where id=$1`,
      [fixture.userId]
    );
    const requested = await repository.requestOwnerPrivateReplicaPurge({
      ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      trigger: "user_erasure",
      triggeredAt: now
    });
    expect(requested?.decision.trigger).toBe("user_erasure");

    await expect(
      repository.completeUserErasureTombstone({
        userId: fixture.userId,
        erasedAt: now
      })
    ).rejects.toThrow("Team ownership must be transferred");
    await pool.query(
      `update team_memberships
          set role='owner', updated_at=$3
        where team_id=$1 and user_id=$2`,
      [fixture.teamId, fixture.secondUserId, now]
    );
    await expect(
      repository.completeUserErasureTombstone({
        userId: fixture.userId,
        erasedAt: now
      })
    ).resolves.toEqual({ userId: fixture.userId, erasedAt: now });

    const identityState = await pool.query<{
      email: string;
      display_name: string | null;
      avatar_reference: string | null;
      password_hash: string | null;
      deleted_at: Date | null;
      sessions_active: string;
      tokens_active: string;
      external_identities: string;
      memberships_enabled: string;
      replica_lifecycle: string;
      team_grants: string;
      team_chunks: string;
    }>(
      `select user_row.email,user_row.display_name,user_row.avatar_reference,
              user_row.password_hash,user_row.deleted_at,
         (select count(*) from user_sessions
           where user_id=$1 and revoked_at is null) as sessions_active,
         (select count(*) from api_tokens
           where owner_user_id=$1 and revoked_at is null) as tokens_active,
         (select count(*) from external_auth_identities
           where user_id=$1) as external_identities,
         (select count(*) from team_memberships
           where user_id=$1 and status='enabled') as memberships_enabled,
         (select lifecycle from memory_replicas where id=$2) as replica_lifecycle,
         (select count(*) from team_memory_share_grants where id=$3) as team_grants,
         (select count(*) from team_memory_representation_chunks
           where share_grant_id=$3) as team_chunks
       from users user_row where user_row.id=$1`,
      [fixture.userId, fixture.ownerPrivateReplicaId, fixture.shareGrantId]
    );
    expect(identityState.rows[0]?.email).toMatch(
      /^erased-[a-f0-9]{24}@deleted\.koed\.invalid$/
    );
    expect(identityState.rows[0]).toMatchObject({
      display_name: null,
      avatar_reference: null,
      password_hash: null,
      deleted_at: now,
      sessions_active: "0",
      tokens_active: "0",
      external_identities: "0",
      memberships_enabled: "0",
      replica_lifecycle: "purge_pending",
      team_grants: "1",
      team_chunks: "1"
    });

    const claimed = await repository.claimNextPurgeJob();
    expect(claimed?.job.id).toBe(requested?.purgeJob.id);
    await repository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      repository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });
    await expect(
      pool.query(
        `select
           (select lifecycle from memory_replicas where id=$1) as replica_lifecycle,
           (select count(*) from team_memory_share_grants where id=$2) as team_grants,
           (select count(*) from team_memory_representation_chunks
             where share_grant_id=$2) as team_chunks,
           (select count(*) from audit_events
             where action='user.erasure_tombstoned' and target_id=$3) as tombstones`,
        [fixture.ownerPrivateReplicaId, fixture.shareGrantId, fixture.userId]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          replica_lifecycle: "purged",
          team_grants: "1",
          team_chunks: "1",
          tombstones: "1"
        }
      ]
    });
  });

  it("purges owner-private cryptographic, vector, search, and sync artifacts while Team and unrelated data survive", async () => {
    const fixture = await createSharedMemoryFixture();
    const unrelated = await createOwnerReplicaFixture();
    const targetArtifacts = await seedOwnerReplicaArtifacts(
      fixture,
      fixture.sourceArtifactId
    );
    const unrelatedArtifacts = await seedOwnerReplicaArtifacts(unrelated);
    now = new Date("2026-03-20T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: {
        scope: "owner_private_replica",
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      retentionSeconds: 0,
      backupRetentionSeconds: 120,
      effectiveAt: new Date("2026-03-01T00:00:00.000Z")
    });
    const requested = await repository.requestOwnerPrivateReplicaPurge({
      ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now
    });
    const claimed = await repository.claimNextPurgeJob();
    expect(claimed?.job.id).toBe(requested?.purgeJob.id);
    await repository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      repository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });

    const state = await pool.query<{
      target_payloads: string;
      target_vectors: string;
      target_embeddings: string;
      target_events: string;
      target_nodes: string;
      target_derived_nodes: string;
      target_derived_embeddings: string;
      target_derived_vectors: string;
      target_items: string;
      target_messages: string;
      target_tools: string;
      target_packages: string;
      target_outbox: string;
      target_inbox: string;
      target_mappings: string;
      target_replay: string;
      target_local_jobs: string;
      target_relationship_state: string;
      target_replica_lifecycle: string;
      target_logical_lifecycle: string;
      team_grants: string;
      team_chunks: string;
      team_source_artifacts: string;
      recipient_keys: string;
      unrelated_payloads: string;
      unrelated_embeddings: string;
      unrelated_vectors: string;
      backup_state: string;
      backup_expires_at: Date | null;
      completion_audits: string;
    }>(
      `select
         (select count(*) from encrypted_field_payloads
           where encryption_scope = 'owner_private_replica'
             and owner_principal_id = $1) as target_payloads,
         (select count(*) from memory_embeddings_384
           where memory_embedding_id = $7) as target_vectors,
         (select count(*) from memory_embeddings
           where id = $7) as target_embeddings,
         (select count(*) from memory_events where session_id = $2) as target_events,
         (select count(*) from memory_nodes where session_id = $2) as target_nodes,
         (select count(*) from memory_nodes
           where id in ($14, $15)) as target_derived_nodes,
         (select count(*) from memory_embeddings
           where id = $16) as target_derived_embeddings,
         (select count(*) from memory_embeddings_384
           where memory_embedding_id = $16) as target_derived_vectors,
         (select count(*) from conversation_items where session_id = $2) as target_items,
         (select count(*) from messages where session_id = $2) as target_messages,
         (select count(*) from tool_events where session_id = $2) as target_tools,
         (select count(*) from sync_package_upload_sessions
           where sync_relationship_id = $3) as target_packages,
         (select count(*) from sync_outbox_entries
           where sync_relationship_id = $3) as target_outbox,
         (select count(*) from sync_inbox_entries
           where sync_relationship_id = $3) as target_inbox,
         ((select count(*) from sync_event_mappings where sync_relationship_id = $3)
           + (select count(*) from sync_summary_node_mappings where sync_relationship_id = $3))::text as target_mappings,
         (select count(*) from sync_semantic_changes where session_id = $2) as target_replay,
         (select count(*) from local_work_queue where data ->> 'sourceId' = $8) as target_local_jobs,
         (select state from cross_identity_sync_relationships where id = $3) as target_relationship_state,
         (select lifecycle from memory_replicas where id = $4) as target_replica_lifecycle,
         (select lifecycle from logical_memories where id = $5) as target_logical_lifecycle,
         (select count(*) from team_memory_share_grants where id = $6) as team_grants,
         (select count(*) from team_memory_representation_chunks where share_grant_id = $6) as team_chunks,
         (select count(*) from shared_source_artifacts where id = $9) as team_source_artifacts,
         (select count(*) from sync_recipient_keys where deployment_identity_id = $10) as recipient_keys,
         (select count(*) from encrypted_field_payloads
           where encryption_scope = 'owner_private_replica'
             and owner_principal_id = $11) as unrelated_payloads,
         (select count(*) from memory_embeddings where id = $12) as unrelated_embeddings,
         (select count(*) from memory_embeddings_384 where memory_embedding_id = $12) as unrelated_vectors,
         (select state from purge_job_evidence
           where purge_job_id = $13 and artifact_kind = 'backup_copy') as backup_state,
         (select backup_expires_at from purge_job_evidence
           where purge_job_id = $13 and artifact_kind = 'backup_copy') as backup_expires_at,
         (select count(*) from audit_events
           where action = 'owner_private_replica.purge_completed'
             and target_id = $4
             and metadata ->> 'purgeJobId' = $13::text) as completion_audits`,
      [
        fixture.ownerPrincipalId,
        fixture.localSessionId,
        fixture.syncRelationshipId,
        fixture.ownerPrivateReplicaId,
        fixture.logicalMemoryId,
        fixture.shareGrantId,
        targetArtifacts.embeddingId,
        targetArtifacts.eventId,
        fixture.sourceArtifactId,
        fixture.deploymentIdentityId,
        unrelated.ownerPrincipalId,
        unrelatedArtifacts.embeddingId,
        claimed!.job.id,
        targetArtifacts.derivedNodeId,
        targetArtifacts.derivedParentNodeId,
        targetArtifacts.derivedEmbeddingId
      ]
    );
    expect(state.rows[0]).toMatchObject({
      target_payloads: "0",
      target_vectors: "0",
      target_embeddings: "0",
      target_events: "0",
      target_nodes: "0",
      target_derived_nodes: "0",
      target_derived_embeddings: "0",
      target_derived_vectors: "0",
      target_items: "0",
      target_messages: "0",
      target_tools: "0",
      target_packages: "0",
      target_outbox: "0",
      target_inbox: "0",
      target_mappings: "0",
      target_replay: "0",
      target_local_jobs: "0",
      target_relationship_state: "revoked",
      target_replica_lifecycle: "purged",
      target_logical_lifecycle: "active",
      team_grants: "1",
      team_chunks: "1",
      team_source_artifacts: "1",
      recipient_keys: "1",
      unrelated_payloads: "8",
      unrelated_embeddings: "1",
      unrelated_vectors: "1",
      backup_state: "scheduled_expiry",
      completion_audits: "1"
    });
    expect(state.rows[0]!.backup_expires_at?.toISOString()).toBe(
      "2026-03-20T00:02:00.000Z"
    );
    await repository.completePurgeJob(claimed!.job.id);
    const repeatedAudit = await pool.query<{ count: string }>(
      `select count(*) from audit_events
        where action = 'owner_private_replica.purge_completed'
          and target_id = $1 and metadata ->> 'purgeJobId' = $2::text`,
      [fixture.ownerPrivateReplicaId, claimed!.job.id]
    );
    expect(repeatedAudit.rows[0]?.count).toBe("1");
  });

  it("purges canonical owner-private rows only without Team references", async () => {
    const fixture = await createOwnerReplicaFixture();
    await seedOwnerReplicaArtifacts(fixture);
    now = new Date("2026-03-25T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: {
        scope: "owner_private_replica",
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      retentionSeconds: 0,
      effectiveAt: new Date("2026-03-01T00:00:00.000Z")
    });
    await repository.requestOwnerPrivateReplicaPurge({
      ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now
    });
    const claimed = await repository.claimNextPurgeJob();
    await repository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await repository.completePurgeJob(claimed!.job.id);
    const state = await pool.query<{
      replica_lifecycle: string;
      replica_purged_at: Date | null;
      logical_lifecycle: string;
      relationships: string;
      session_metadata: Record<string, unknown>;
    }>(
      `select
         (select lifecycle from memory_replicas where id = $1) as replica_lifecycle,
         (select purge_completed_at from memory_replicas where id = $1) as replica_purged_at,
         (select lifecycle from logical_memories where id = $2) as logical_lifecycle,
         (select count(*) from cross_identity_sync_relationships
           where local_replica_id = $1) as relationships,
         (select metadata from sessions where id = $3) as session_metadata`,
      [
        fixture.ownerPrivateReplicaId,
        fixture.logicalMemoryId,
        fixture.localSessionId
      ]
    );
    expect(state.rows[0]).toMatchObject({
      replica_lifecycle: "purged",
      logical_lifecycle: "purged",
      relationships: "0",
      session_metadata: {}
    });
    expect(state.rows[0]!.replica_purged_at?.toISOString()).toBe(
      now.toISOString()
    );
  });

  it("blocks and resumes owner-private purge work from durable artifact checkpoints", async () => {
    const fixture = await createOwnerReplicaFixture();
    await seedOwnerReplicaArtifacts(fixture);
    now = new Date("2026-03-28T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: {
        scope: "owner_private_replica",
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      retentionSeconds: 0,
      effectiveAt: new Date("2026-03-01T00:00:00.000Z")
    });
    const hold = await repository.placeLegalHold({
      target: {
        scope: "owner_private_replica",
        ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
        logicalMemoryId: fixture.logicalMemoryId
      },
      actorUserId: fixture.userId,
      authority: "owner.compliance",
      reasonCode: "owner.hold",
      reasonHash: hash("owner hold"),
      freshlyAuthenticatedAt: now
    });
    const requested = await repository.requestOwnerPrivateReplicaPurge({
      ownerPrivateReplicaId: fixture.ownerPrivateReplicaId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now
    });
    expect(requested?.decision.eligibilityReasonCode).toBe("active_legal_hold");
    await expect(repository.claimNextPurgeJob()).resolves.toBeNull();
    await repository.requestLegalHoldRelease({
      holdId: hold.id,
      actorUserId: fixture.userId
    });
    await repository.confirmLegalHoldRelease({
      holdId: hold.id,
      actorUserId: fixture.secondUserId
    });
    now = new Date(now.getTime() + 2);
    const first = await repository.claimNextPurgeJob();
    await expect(
      repository.processClaimedPurgeJob({
        purgeJobId: first!.job.id,
        purgeAttemptId: first!.attempt.id,
        failBeforeArtifactKind: "encrypted_payload"
      })
    ).rejects.toThrow("Purge artifact processing failed for encrypted_payload");
    const failedArtifact = requested!.requiredArtifacts.find(
      (artifact) => artifact.artifactKind === "encrypted_payload"
    )!;
    await repository.recordPurgeEvidence({
      purgeJobId: first!.job.id,
      purgeAttemptId: first!.attempt.id,
      artifactKind: failedArtifact.artifactKind,
      artifactLocatorHash: failedArtifact.artifactLocatorHash,
      state: "failed",
      removedRecordCount: 0,
      removedByteCount: 0,
      observedAt: now
    });
    const checkpoint = await pool.query<{
      outbox: string;
      payloads: string;
      outbox_evidence: string;
      vector_evidence: string;
      payload_evidence: string;
    }>(
      `select
         (select count(*) from sync_outbox_entries
           where sync_relationship_id = $1) as outbox,
         (select count(*) from encrypted_field_payloads
           where owner_principal_id = $2
             and encryption_scope = 'owner_private_replica') as payloads,
         (select state from purge_job_evidence
           where purge_job_id = $3 and artifact_kind = 'outbox_replay') as outbox_evidence,
         (select state from purge_job_evidence
           where purge_job_id = $3 and artifact_kind = 'vector') as vector_evidence,
         (select state from purge_job_evidence
           where purge_job_id = $3 and artifact_kind = 'encrypted_payload') as payload_evidence`,
      [fixture.syncRelationshipId, fixture.ownerPrincipalId, first!.job.id]
    );
    expect(checkpoint.rows[0]).toEqual({
      outbox: "0",
      payloads: "8",
      outbox_evidence: "verified",
      vector_evidence: "verified",
      payload_evidence: "failed"
    });
    await repository.finishPurgeAttempt({
      purgeJobId: first!.job.id,
      purgeAttemptId: first!.attempt.id,
      outcome: "retryable_failure",
      resumeArtifactKind: failedArtifact.artifactKind,
      resumeCursor: failedArtifact.artifactLocatorHash,
      errorCode: "InjectedFailure",
      errorHash: hash("injected failure"),
      retryAt: now
    });
    const second = await repository.claimNextPurgeJob();
    expect(second?.attempt.attemptNumber).toBe(2);
    expect(second?.job.resumeArtifactKind).toBe("encrypted_payload");
    expect(second?.job.resumeCursor).toBe(failedArtifact.artifactLocatorHash);
    await repository.processClaimedPurgeJob({
      purgeJobId: second!.job.id,
      purgeAttemptId: second!.attempt.id
    });
    await expect(
      repository.completePurgeJob(second!.job.id)
    ).resolves.toMatchObject({ completed: true });
  });

  it("creates one purge job and one required artifact set for concurrent idempotent requests", async () => {
    const fixture = await createFixture();
    now = new Date("2026-04-01T00:00:00.000Z");
    resetRepository();
    const decision = await createEligibleTeamDecision(fixture);
    const input = {
      retentionDecisionId: decision.id,
      idempotencyKey: `purge-${randomUUID()}`,
      requiredArtifacts: [
        {
          artifactKind: "database_row" as const,
          artifactLocatorHash: hash("rows")
        },
        {
          artifactKind: "vector" as const,
          artifactLocatorHash: hash("vectors")
        }
      ]
    };
    const jobs = await Promise.all([
      repository.createPurgeJob(input),
      repository.createPurgeJob(input)
    ]);
    expect(jobs[0]!.id).toBe(jobs[1]!.id);
    const counts = await pool.query<{ jobs: string; evidence: string }>(
      `select
         (select count(*) from purge_jobs where idempotency_key = $1) as jobs,
         (select count(*) from purge_job_evidence where purge_job_id = $2) as evidence`,
      [input.idempotencyKey, jobs[0]!.id]
    );
    expect(counts.rows[0]).toEqual({ jobs: "1", evidence: "2" });
    await expect(
      repository.createPurgeJob({
        ...input,
        requiredArtifacts: [
          { artifactKind: "wrapped_key", artifactLocatorHash: hash("other") }
        ]
      })
    ).rejects.toThrow("different artifacts");
  });

  it("claims, checkpoints, retries, and resumes with monotonic attempts", async () => {
    const fixture = await createFixture();
    now = new Date("2026-05-01T00:00:00.000Z");
    resetRepository();
    const decision = await createEligibleTeamDecision(fixture);
    const job = await repository.createPurgeJob({
      retentionDecisionId: decision.id,
      idempotencyKey: `purge-${randomUUID()}`,
      requiredArtifacts: [
        { artifactKind: "vector", artifactLocatorHash: hash("resume-vector") }
      ]
    });
    const first = await repository.claimNextPurgeJob();
    expect(first?.job.id).toBe(job.id);
    expect(first?.attempt.attemptNumber).toBe(1);
    await repository.checkpointPurgeAttempt({
      purgeJobId: job.id,
      purgeAttemptId: first!.attempt.id,
      resumeArtifactKind: "vector",
      resumeCursor: "vector:42"
    });
    await repository.finishPurgeAttempt({
      purgeJobId: job.id,
      purgeAttemptId: first!.attempt.id,
      outcome: "retryable_failure",
      resumeArtifactKind: "vector",
      resumeCursor: "vector:42",
      errorCode: "index_timeout",
      errorHash: hash("index timeout")
    });

    now = new Date(now.getTime() + 1);
    const second = await repository.claimNextPurgeJob();
    expect(second?.job.id).toBe(job.id);
    expect(second?.attempt.attemptNumber).toBe(2);
    expect(second?.job.resumeArtifactKind).toBe("vector");
    expect(second?.job.resumeCursor).toBe("vector:42");
    const attempts = await pool.query<{
      attempt_number: number;
      state: string;
    }>(
      `select attempt_number, state from purge_job_attempts
       where purge_job_id = $1 order by attempt_number`,
      [job.id]
    );
    expect(attempts.rows).toEqual([
      { attempt_number: 1, state: "retryable_failure" },
      { attempt_number: 2, state: "running" }
    ]);
  });

  it("refuses completion until every artifact is verified and rechecks new holds", async () => {
    const fixture = await createFixture();
    now = new Date("2026-06-01T00:00:00.000Z");
    resetRepository();
    const decision = await createEligibleTeamDecision(fixture);
    const locatorHash = hash("completion-row");
    const job = await repository.createPurgeJob({
      retentionDecisionId: decision.id,
      idempotencyKey: `purge-${randomUUID()}`,
      requiredArtifacts: [
        { artifactKind: "database_row", artifactLocatorHash: locatorHash }
      ]
    });
    const preClaimHold = await repository.placeLegalHold({
      target: { scope: "team", teamId: fixture.teamId },
      actorUserId: fixture.userId,
      authority: "team.compliance",
      reasonCode: "claim.block",
      reasonHash: hash("claim block"),
      freshlyAuthenticatedAt: now
    });
    await expect(repository.claimNextPurgeJob()).resolves.toBeNull();
    const blocked = await pool.query<{ state: string }>(
      "select state from purge_jobs where id = $1",
      [job.id]
    );
    expect(blocked.rows).toEqual([{ state: "blocked" }]);
    await repository.requestLegalHoldRelease({
      holdId: preClaimHold.id,
      actorUserId: fixture.userId
    });
    await repository.confirmLegalHoldRelease({
      holdId: preClaimHold.id,
      actorUserId: fixture.secondUserId
    });
    now = new Date(now.getTime() + 2);
    const first = await repository.claimNextPurgeJob();
    await repository.recordPurgeEvidence({
      purgeJobId: job.id,
      purgeAttemptId: first!.attempt.id,
      artifactKind: "database_row",
      artifactLocatorHash: locatorHash,
      state: "cleaned",
      removedRecordCount: 12,
      removedByteCount: 2048,
      evidenceHash: hash("cleaned proof")
    });
    await repository.finishPurgeAttempt({
      purgeJobId: job.id,
      purgeAttemptId: first!.attempt.id,
      outcome: "completed"
    });
    await expect(repository.completePurgeJob(job.id)).resolves.toMatchObject({
      completed: false,
      reason: "unverified_artifacts"
    });

    now = new Date(now.getTime() + 1);
    const second = await repository.claimNextPurgeJob();
    await repository.recordPurgeEvidence({
      purgeJobId: job.id,
      purgeAttemptId: second!.attempt.id,
      artifactKind: "database_row",
      artifactLocatorHash: locatorHash,
      state: "verified",
      removedRecordCount: 12,
      removedByteCount: 2048,
      evidenceHash: hash("verified proof")
    });
    await repository.finishPurgeAttempt({
      purgeJobId: job.id,
      purgeAttemptId: second!.attempt.id,
      outcome: "completed"
    });
    const hold = await repository.placeLegalHold({
      target: { scope: "team", teamId: fixture.teamId },
      actorUserId: fixture.userId,
      authority: "team.compliance",
      reasonCode: "late.matter",
      reasonHash: hash("late matter"),
      freshlyAuthenticatedAt: now
    });
    await expect(repository.completePurgeJob(job.id)).resolves.toMatchObject({
      completed: false,
      reason: "active_legal_hold"
    });
    await repository.requestLegalHoldRelease({
      holdId: hold.id,
      actorUserId: fixture.userId
    });
    await repository.confirmLegalHoldRelease({
      holdId: hold.id,
      actorUserId: fixture.secondUserId
    });
    const completed = await repository.completePurgeJob(job.id);
    expect(completed.completed).toBe(true);
    if (completed.completed) expect(completed.job.state).toBe("verified");
  });

  it("requests root Team deletion with server-derived retention and durable not-yet-eligible work", async () => {
    const fixture = await createFixture();
    await createCollaborationPurgeFixture(fixture);
    now = new Date("2026-07-01T00:00:00.000Z");
    resetRepository();
    const policy = await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 3600,
      deletionGraceSeconds: 60,
      backupRetentionSeconds: 86400,
      effectiveAt: new Date("2026-06-01T00:00:00.000Z"),
      createdByUserId: fixture.userId
    });

    const result = await repository.requestRootTeamDeletion({
      teamId: fixture.teamId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now,
      idempotencyKey: `team-delete-${randomUUID()}`
    });

    expect(result?.team.lifecycle).toBe("deletion_requested");
    expect(result?.team.retainUntil?.toISOString()).toBe(
      "2026-07-01T01:01:00.000Z"
    );
    expect(result?.decision.policyId).toBe(policy.policyId);
    expect(result?.decision.policyVersion).toBe(1);
    expect(result?.decision.eligible).toBe(false);
    expect(result?.decision.eligibilityReasonCode).toBe(
      "retention_period_active"
    );
    expect(result?.purgeJob.state).toBe("pending");
    expect(
      result?.requiredArtifacts.map((artifact) => artifact.artifactKind)
    ).toEqual([
      "database_row",
      "encrypted_payload",
      "wrapped_key",
      "search_index",
      "vector",
      "outbox_replay",
      "backup_copy"
    ]);
    await expect(repository.claimNextPurgeJob()).resolves.toBeNull();
    const blockedReads = await pool.query<{ active_threads: string }>(
      `select count(*) as active_threads
         from collaboration_threads
        where team_id = $1 and lifecycle = 'active'`,
      [fixture.teamId]
    );
    expect(blockedReads.rows[0]!.active_threads).toBe("0");
  });

  it("keeps held Team deletion purge jobs durable and blocked until hold release", async () => {
    const fixture = await createFixture();
    now = new Date("2026-08-01T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 0,
      effectiveAt: new Date("2026-07-01T00:00:00.000Z")
    });
    const hold = await repository.placeLegalHold({
      target: { scope: "team", teamId: fixture.teamId },
      actorUserId: fixture.userId,
      authority: "team.compliance",
      reasonCode: "matter.open",
      reasonHash: hash("matter open"),
      freshlyAuthenticatedAt: now
    });

    const deletion = await repository.requestRootTeamDeletion({
      teamId: fixture.teamId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now
    });
    expect(deletion?.decision.eligibilityReasonCode).toBe("active_legal_hold");
    expect(await repository.claimNextPurgeJob()).toBeNull();
    const blocked = await pool.query<{ state: string }>(
      "select state from purge_jobs where id = $1",
      [deletion!.purgeJob.id]
    );
    expect(blocked.rows[0]!.state).toBe("blocked");

    await repository.requestLegalHoldRelease({
      holdId: hold.id,
      actorUserId: fixture.userId
    });
    await repository.confirmLegalHoldRelease({
      holdId: hold.id,
      actorUserId: fixture.secondUserId
    });
    now = new Date(now.getTime() + 2);
    const claimed = await repository.claimNextPurgeJob();
    expect(claimed?.job.id).toBe(deletion?.purgeJob.id);
  });

  it("removes every Team semantic vector dimension and search item without touching another Team", async () => {
    const fixture = await createFixture();
    const sharedMemory = await createSharedMemoryFixture(fixture);
    const unrelatedSharedMemory = await createSharedMemoryFixture();
    const targetSemanticItemIds = await seedTeamSemanticArtifacts(sharedMemory);
    const unrelatedSemanticItemIds = await seedTeamSemanticArtifacts(
      unrelatedSharedMemory
    );
    now = new Date("2026-08-15T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 0,
      effectiveAt: new Date("2026-08-01T00:00:00.000Z")
    });
    const deletion = await repository.requestRootTeamDeletion({
      teamId: fixture.teamId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now
    });
    const claimed = await repository.claimNextPurgeJob();
    expect(claimed?.job.id).toBe(deletion?.purgeJob.id);

    await repository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      repository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });

    await expect(
      semanticArtifactCounts(targetSemanticItemIds)
    ).resolves.toEqual({ items: "0", vectors: "0" });
    await expect(
      semanticArtifactCounts(unrelatedSemanticItemIds)
    ).resolves.toEqual({ items: "4", vectors: "4" });
    const semanticPreviewPayloads = await pool.query<{
      target_count: string;
      unrelated_count: string;
    }>(
      `select
         count(*) filter (where source_id=$1)::text as target_count,
         count(*) filter (where source_id=$2)::text as unrelated_count
       from encrypted_field_payloads
       where source_table='shared_source_semantic_previews'`,
      [sharedMemory.semanticPreviewId, unrelatedSharedMemory.semanticPreviewId]
    );
    expect(semanticPreviewPayloads.rows[0]).toEqual({
      target_count: "0",
      unrelated_count: "1"
    });
    const evidence = await pool.query<{
      artifact_kind: string;
      removed_record_count: string;
      state: string;
    }>(
      `select artifact_kind, removed_record_count, state
         from purge_job_evidence
        where purge_job_id=$1 and artifact_kind in ('vector','search_index')
        order by artifact_kind`,
      [claimed!.job.id]
    );
    expect(evidence.rows).toEqual([
      {
        artifact_kind: "search_index",
        removed_record_count: "6",
        state: "verified"
      },
      {
        artifact_kind: "vector",
        removed_record_count: "4",
        state: "verified"
      }
    ]);
  });

  it("removes every Share Grant semantic vector dimension and search item without touching another grant", async () => {
    const sharedMemory = await createSharedMemoryFixture();
    const unrelatedSharedMemory = await createSharedMemoryFixture();
    const targetSemanticItemIds = await seedTeamSemanticArtifacts(sharedMemory);
    const unrelatedSemanticItemIds = await seedTeamSemanticArtifacts(
      unrelatedSharedMemory
    );
    now = new Date("2026-08-20T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: {
        scope: "share_grant",
        teamId: sharedMemory.teamId,
        teamWorkspaceId: sharedMemory.teamWorkspaceId,
        shareGrantId: sharedMemory.shareGrantId,
        logicalMemoryId: sharedMemory.logicalMemoryId
      },
      retentionSeconds: 0,
      effectiveAt: new Date("2026-08-01T00:00:00.000Z")
    });
    const mutationId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("begin");
      expect(
        await lockShareGrantRetentionScopeWithClient(
          client,
          sharedMemory.shareGrantId
        )
      ).toBe(true);
      await client.query(
        `update team_memory_share_grants
            set lifecycle='revoked', revoked_at=$2, revocation_epoch=1
          where id=$1`,
        [sharedMemory.shareGrantId, now]
      );
      await scheduleShareGrantRevocationRetentionWithClient(client, {
        shareGrantId: sharedMemory.shareGrantId,
        actorUserId: sharedMemory.userId,
        mutationId,
        revocationEpoch: 1,
        triggeredAt: now
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const claimed = await repository.claimNextPurgeJob();
    expect(claimed?.job.target).toMatchObject({
      kind: "share_grant",
      shareGrantId: sharedMemory.shareGrantId
    });
    await repository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    await expect(
      repository.completePurgeJob(claimed!.job.id)
    ).resolves.toMatchObject({ completed: true });

    await expect(
      semanticArtifactCounts(targetSemanticItemIds)
    ).resolves.toEqual({ items: "0", vectors: "0" });
    await expect(
      semanticArtifactCounts(unrelatedSemanticItemIds)
    ).resolves.toEqual({ items: "4", vectors: "4" });
    const semanticPreviewPayloads = await pool.query<{
      target_count: string;
      unrelated_count: string;
    }>(
      `select
         count(*) filter (where source_id=$1)::text as target_count,
         count(*) filter (where source_id=$2)::text as unrelated_count
       from encrypted_field_payloads
       where source_table='shared_source_semantic_previews'`,
      [sharedMemory.semanticPreviewId, unrelatedSharedMemory.semanticPreviewId]
    );
    expect(semanticPreviewPayloads.rows[0]).toEqual({
      target_count: "0",
      unrelated_count: "1"
    });
    const evidence = await pool.query<{
      artifact_kind: string;
      removed_record_count: string;
      state: string;
    }>(
      `select artifact_kind, removed_record_count, state
         from purge_job_evidence
        where purge_job_id=$1 and artifact_kind in ('vector','search_index')
        order by artifact_kind`,
      [claimed!.job.id]
    );
    expect(evidence.rows).toEqual([
      {
        artifact_kind: "search_index",
        removed_record_count: "4",
        state: "verified"
      },
      {
        artifact_kind: "vector",
        removed_record_count: "4",
        state: "verified"
      }
    ]);
  });

  it("processes root Team purge artifacts, schedules backup expiry, and verifies completion", async () => {
    const fixture = await createFixture();
    await createCollaborationPurgeFixture(fixture);
    await createSharedMemoryFixture(fixture);
    now = new Date("2026-09-01T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 0,
      backupRetentionSeconds: 120,
      effectiveAt: new Date("2026-08-01T00:00:00.000Z")
    });
    const deletion = await repository.requestRootTeamDeletion({
      teamId: fixture.teamId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now
    });
    const claimed = await repository.claimNextPurgeJob();
    expect(claimed?.job.id).toBe(deletion?.purgeJob.id);
    await repository.processClaimedPurgeJob({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id
    });
    const completed = await repository.completePurgeJob(claimed!.job.id);

    expect(completed.completed).toBe(true);
    const counts = await pool.query<{
      payloads: string;
      representation_chunks: string;
      messages: string;
      threads: string;
      outbox: string;
      team_lifecycle: string;
      workspace_lifecycle: string;
      workspace_purge_completed_at: Date | null;
      backup_state: string;
      backup_expires_at: Date | null;
      completion_audits: string;
    }>(
      `select
         (select count(*) from encrypted_field_payloads where team_id = $1) as payloads,
         (select count(*) from team_memory_representation_chunks where team_id = $1) as representation_chunks,
         (select count(*) from collaboration_messages where team_id = $1) as messages,
         (select count(*) from collaboration_threads where team_id = $1) as threads,
         (select count(*) from collaboration_outbox where team_id = $1) as outbox,
         (select lifecycle from teams where id = $1) as team_lifecycle,
         (select lifecycle from team_workspaces where id = $3) as workspace_lifecycle,
         (select purge_completed_at from team_workspaces where id = $3) as workspace_purge_completed_at,
         (select state from purge_job_evidence
           where purge_job_id = $2 and artifact_kind = 'backup_copy') as backup_state,
         (select backup_expires_at from purge_job_evidence
           where purge_job_id = $2 and artifact_kind = 'backup_copy') as backup_expires_at,
         (select count(*) from audit_events
           where action = 'team.purge_completed'
             and target_id = $1
             and metadata->>'purgeJobId' = $2::text) as completion_audits`,
      [fixture.teamId, claimed!.job.id, fixture.teamWorkspaceId]
    );
    expect(counts.rows[0]).toMatchObject({
      payloads: "0",
      representation_chunks: "0",
      messages: "0",
      threads: "0",
      outbox: "0",
      team_lifecycle: "purged",
      workspace_lifecycle: "purged",
      workspace_purge_completed_at: now,
      backup_state: "scheduled_expiry",
      completion_audits: "1"
    });
    expect(counts.rows[0]!.backup_expires_at?.toISOString()).toBe(
      "2026-09-01T00:02:00.000Z"
    );
    const refusedRestore = await pool.query(
      `update team_workspaces
          set lifecycle = 'active', archived_at = null, version = version + 1
        where id = $1 and lifecycle = 'archived'
        returning id`,
      [fixture.teamWorkspaceId]
    );
    expect(refusedRestore.rowCount).toBe(0);
    await repository.completePurgeJob(claimed!.job.id);
    const repeatedAudit = await pool.query<{ count: string }>(
      `select count(*) from audit_events
        where action = 'team.purge_completed'
          and target_id = $1
          and metadata->>'purgeJobId' = $2::text`,
      [fixture.teamId, claimed!.job.id]
    );
    expect(repeatedAudit.rows[0]?.count).toBe("1");
  });

  it("resumes Team purge after failure at every artifact boundary", async () => {
    const artifactOrder = [
      "outbox_replay",
      "vector",
      "encrypted_payload",
      "wrapped_key",
      "search_index",
      "database_row",
      "backup_copy"
    ] as const;

    for (const [failureIndex, artifactKind] of artifactOrder.entries()) {
      const fixture = await createFixture();
      await createCollaborationPurgeFixture(fixture);
      now = new Date(
        Date.parse("2026-10-01T00:00:00.000Z") + failureIndex * 1_000
      );
      resetRepository();
      await repository.createPolicy({
        target: { scope: "team", teamId: fixture.teamId },
        retentionSeconds: 0,
        backupRetentionSeconds: 60,
        effectiveAt: new Date("2026-09-01T00:00:00.000Z")
      });
      const deletion = await repository.requestRootTeamDeletion({
        teamId: fixture.teamId,
        actorUserId: fixture.userId,
        expectedVersion: 1,
        triggeredAt: now
      });
      const first = await repository.claimNextPurgeJob();
      await expect(
        repository.processClaimedPurgeJob({
          purgeJobId: first!.job.id,
          purgeAttemptId: first!.attempt.id,
          failBeforeArtifactKind: artifactKind
        })
      ).rejects.toThrow(`Purge artifact processing failed for ${artifactKind}`);

      const failedArtifact = deletion!.requiredArtifacts.find(
        (artifact) => artifact.artifactKind === artifactKind
      )!;
      await repository.recordPurgeEvidence({
        purgeJobId: first!.job.id,
        purgeAttemptId: first!.attempt.id,
        artifactKind,
        artifactLocatorHash: failedArtifact.artifactLocatorHash,
        state: "failed",
        removedRecordCount: 0,
        removedByteCount: 0,
        observedAt: now
      });

      const checkpoint = await pool.query<{
        artifact_kind: (typeof artifactOrder)[number];
        state: string;
        evidence_hash: string | null;
      }>(
        `select artifact_kind, state, evidence_hash
           from purge_job_evidence
          where purge_job_id = $1
          order by array_position(
            array['outbox_replay', 'vector', 'encrypted_payload',
                  'wrapped_key', 'search_index', 'database_row',
                  'backup_copy']::purge_artifact_kind[], artifact_kind
          )`,
        [deletion!.purgeJob.id]
      );
      expect(
        checkpoint.rows.map((row) => ({
          ...row,
          evidence_hash:
            row.evidence_hash === null
              ? null
              : /^[a-f0-9]{64}$/.test(row.evidence_hash)
        }))
      ).toEqual(
        artifactOrder.map((candidate, index) => ({
          artifact_kind: candidate,
          state:
            index < failureIndex
              ? "verified"
              : index === failureIndex
                ? "failed"
                : "pending",
          evidence_hash: index < failureIndex ? true : null
        }))
      );

      await repository.finishPurgeAttempt({
        purgeJobId: first!.job.id,
        purgeAttemptId: first!.attempt.id,
        outcome: "retryable_failure",
        resumeArtifactKind: artifactKind,
        resumeCursor: failedArtifact.artifactLocatorHash,
        errorCode: "InjectedFailure",
        errorHash: hash(`failure:${artifactKind}`),
        retryAt: now
      });
      const second = await repository.claimNextPurgeJob();
      expect(second?.attempt.attemptNumber).toBe(2);
      expect(second?.job.resumeArtifactKind).toBe(artifactKind);
      expect(second?.job.resumeCursor).toBe(failedArtifact.artifactLocatorHash);
      await repository.processClaimedPurgeJob({
        purgeJobId: second!.job.id,
        purgeAttemptId: second!.attempt.id
      });
      await expect(
        repository.completePurgeJob(second!.job.id)
      ).resolves.toMatchObject({ completed: true });
    }
  });

  it("persists a minimal terminal artifact failure and refuses further claims", async () => {
    const fixture = await createFixture();
    await createCollaborationPurgeFixture(fixture);
    now = new Date("2026-11-01T00:00:00.000Z");
    resetRepository();
    await repository.createPolicy({
      target: { scope: "team", teamId: fixture.teamId },
      retentionSeconds: 0,
      effectiveAt: new Date("2026-10-01T00:00:00.000Z")
    });
    const deletion = await repository.requestRootTeamDeletion({
      teamId: fixture.teamId,
      actorUserId: fixture.userId,
      expectedVersion: 1,
      triggeredAt: now
    });
    const claimed = await repository.claimNextPurgeJob();
    const failedArtifact = deletion!.requiredArtifacts.find(
      (artifact) => artifact.artifactKind === "outbox_replay"
    )!;
    await repository.recordPurgeEvidence({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id,
      artifactKind: failedArtifact.artifactKind,
      artifactLocatorHash: failedArtifact.artifactLocatorHash,
      state: "failed",
      removedRecordCount: 0,
      removedByteCount: 0,
      observedAt: now
    });
    const terminal = await repository.finishPurgeAttempt({
      purgeJobId: claimed!.job.id,
      purgeAttemptId: claimed!.attempt.id,
      outcome: "terminal_failure",
      resumeArtifactKind: failedArtifact.artifactKind,
      resumeCursor: failedArtifact.artifactLocatorHash,
      errorCode: "PurgeArtifactProcessingError",
      errorHash: hash("redacted terminal failure")
    });

    expect(terminal).toMatchObject({
      state: "failed",
      terminalErrorCode: "PurgeArtifactProcessingError",
      resumeArtifactKind: "outbox_replay",
      resumeCursor: failedArtifact.artifactLocatorHash
    });
    await expect(repository.claimNextPurgeJob()).resolves.toBeNull();
    await expect(repository.completePurgeJob(terminal.id)).resolves.toEqual({
      completed: false,
      reason: "job_not_completable"
    });
    const persisted = await pool.query<{
      evidence_state: string;
      audits: string;
      metadata: Record<string, unknown>;
    }>(
      `select evidence.state as evidence_state,
              (select count(*) from audit_events audit
                where audit.action = 'retention.purge_terminal_failure'
                  and audit.target_id = $1)::text as audits,
              (select audit.metadata from audit_events audit
                where audit.action = 'retention.purge_terminal_failure'
                  and audit.target_id = $1 limit 1) as metadata
         from purge_job_evidence evidence
        where evidence.purge_job_id = $1
          and evidence.artifact_kind = 'outbox_replay'`,
      [terminal.id]
    );
    expect(persisted.rows[0]).toMatchObject({
      evidence_state: "failed",
      audits: "1",
      metadata: {
        purgeJobId: terminal.id,
        targetKind: "team",
        targetId: fixture.teamId,
        teamId: fixture.teamId,
        attemptNumber: 1,
        artifactKind: "outbox_replay",
        errorCode: "PurgeArtifactProcessingError",
        errorHash: hash("redacted terminal failure")
      }
    });
    expect(JSON.stringify(persisted.rows[0]?.metadata)).not.toMatch(
      /content|ciphertext|wrapped_dek|message_body|source_text/i
    );
  });
});
