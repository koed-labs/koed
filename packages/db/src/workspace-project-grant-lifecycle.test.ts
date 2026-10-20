import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  highRiskActionGrantCanonicalHash,
  highRiskActionGrantCommitment,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS,
  crossIdentitySyncDigest,
  noPrivacyLabelsPolicy
} from "@koed/shared";
import { createDb } from "./connection.js";
import { createHighRiskActionRepository } from "./high-risk-action-repository.js";
import { runDbMigrations } from "./migrate.js";
import { createWorkspaceProjectRepository } from "./workspace-project-repository.js";
import { createTeamAccessRepository } from "./team-access-repository.js";
import {
  createSharedMemoryRepository,
  SHARED_MEMORY_AUTHORITY,
  sharedMemorySanitizedSemanticSourceRevisionHash,
  sharedMemorySanitizedSemanticSourceBinding,
  sharedMemorySanitizedSemanticProvenanceHash,
  readSharedMemoryGrantAuthorityWithClient
} from "./shared-memory-repository.js";
import { createCollaborationRepository } from "./collaboration-repository.js";
import { createMemorySourceRepository } from "./repository.js";
import {
  createPrivacyClassificationRepository,
  privacySourceFrontierHash
} from "./privacy-classification-repository.js";
import { createTeamConversationSourceRepository } from "./team-conversation-source-repository.js";

// This suite deliberately owns a database: grant freezes and parent mutations
// must be observed in one real PostgreSQL transaction.
const testUrl = process.env.KOED_HQ712_GRANT_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe.skipIf(!testUrl)("Workspace Project grant-bearing lifecycle", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const alice = randomUUID(),
    bob = randomUUID(),
    carol = randomUUID();
  const teamId = randomUUID();
  let workspaceId = randomUUID();
  let project: Awaited<
    ReturnType<ReturnType<typeof createWorkspaceProjectRepository>["create"]>
  >;
  let members: Record<string, { id: string; version: number }>;
  let privacy: ReturnType<typeof createPrivacyClassificationRepository>;
  let classifierHash: string;
  let localDeploymentId: string;
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64")
  );

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq712_grant_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    const localDeployment = await pool.query<{ id: string }>(
      `insert into deployment_identities
      (protocol_deployment_id,locality,profile)
      values ($1,'local','developer') returning id`,
      [randomUUID()]
    );
    localDeploymentId = localDeployment.rows[0]!.id;
    privacy = createPrivacyClassificationRepository(pool, {
      fingerprintKey: "hq712-grant-lifecycle-test-fingerprint-v1"
    });
    const registered = await privacy.registerClassifierGeneration({
      version: 1,
      modelKey: "test-privacy-filter",
      modelRevision: "hq712-v1",
      artifactSha256: hash("artifact"),
      tokenizerSha256: hash("tokenizer"),
      decoderSha256: hash("decoder"),
      calibrationSha256: hash("calibration"),
      deterministicDetectorVersion: "structured-secrets-v1"
    });
    classifierHash = (await privacy.activateClassifierGeneration(registered.id))
      .classifierHash;
    await privacy.createContentPolicyVersion({
      scope: "deployment",
      subject: { deploymentIdentityId: localDeploymentId },
      labels: noPrivacyLabelsPolicy(),
      expectedPreviousVersion: 0
    });
    await pool.query(
      `insert into users(id,email) values ($1,$2),($3,$4),($5,$6)`,
      [
        alice,
        `${alice}@example.test`,
        bob,
        `${bob}@example.test`,
        carol,
        `${carol}@example.test`
      ]
    );
    await pool.query(
      `insert into teams(id,name) values ($1,'Grant lifecycle')`,
      [teamId]
    );
    const rows = await pool.query<{
      id: string;
      user_id: string;
      version: number;
    }>(
      `
      insert into team_memberships(team_id,user_id,role,status,accepted_at)
      values ($1,$2,'owner','enabled',now()),($1,$3,'member','enabled',now()),
             ($1,$4,'owner','enabled',now()) returning id,user_id,version`,
      [teamId, alice, bob, carol]
    );
    members = Object.fromEntries(rows.rows.map((row) => [row.user_id, row]));
    await pool.query(
      `insert into team_workspaces(id,team_id,name) values ($1,$2,'Shared')`,
      [workspaceId, teamId]
    );
    const retentionId = randomUUID();
    const effectiveAt = new Date("2020-01-01T00:00:00.000Z");
    await pool.query(
      `insert into retention_policies
      (policy_id,version,scope,team_id,retention_seconds,deletion_grace_seconds,
       backup_retention_seconds,policy_hash,created_by_user_id,effective_at)
      values ($1,1,'team',$2,2592000,0,2592000,$3,$4,$5)`,
      [
        retentionId,
        teamId,
        crossIdentitySyncDigest({
          policyId: retentionId,
          version: 1,
          target: { scope: "team", teamId },
          retentionSeconds: 2592000,
          deletionGraceSeconds: 0,
          backupRetentionSeconds: 2592000,
          effectiveAt: effectiveAt.toISOString()
        }),
        alice,
        effectiveAt
      ]
    );
    await pool.query(
      `insert into team_workspace_access_grants
      (team_workspace_id,team_id,user_id,access,can_share_owned_memory)
      values ($1,$2,$3,'write',true),($1,$2,$4,'write',true),($1,$2,$5,'write',true)`,
      [workspaceId, teamId, alice, bob, carol]
    );
    const repository = createWorkspaceProjectRepository(pool);
    project = await repository.create(alice, {
      teamId,
      workspaceId,
      name: "Grant lifecycle",
      key: "GRANT",
      shareAttemptKey: randomUUID()
    });
    await repository.join(bob, project.id);
    await repository.join(carol, project.id);
  }, 120_000);

  afterAll(async () => {
    try {
      await pool?.end();
      if (admin && database)
        await admin.query(`drop database ${quote(database)}`);
    } finally {
      await admin?.end();
    }
  });

  const grantState = async (id: string) => {
    const result = await pool.query<{
      frozen_at: Date | null;
      grant_version: number;
      freeze_manifest_hash: string | null;
    }>(
      `select frozen_at,grant_version,freeze_manifest_hash
      from team_memory_share_grants where id=$1`,
      [id]
    );
    return result.rows[0]!;
  };

  const publishContinuousSource = async (input: {
    grantId: string;
    owner: string;
    sessionId: string;
    logicalSourceId?: string;
    sourceGenerationId?: string;
    length?: number;
    externalSessionId?: string;
  }) => {
    const logicalSourceId = input.logicalSourceId ?? randomUUID();
    const sourceGenerationId = input.sourceGenerationId ?? randomUUID();
    const length = input.length ?? 24;
    const externalSessionId =
      input.externalSessionId ?? `grant-source-${randomUUID()}`;
    await pool.query(`update sessions set external_session_id=$2 where id=$1`, [
      input.sessionId,
      externalSessionId
    ]);
    const source = await createMemorySourceRepository(
      pool
    ).ensureConversationSourceArtifact(
      { userId: input.owner },
      {
        sessionId: input.sessionId,
        logicalSourceId,
        sourceGenerationId,
        replicaRole: "origin_local",
        sourceKind: "codex",
        sourceRuntime: "codex",
        externalSessionId,
        sourceFingerprint: hash(`source:${sourceGenerationId}`),
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        sourceAdapterVersion: "codex-transcript-v1",
        journalStartOffset: 0,
        journalStartLine: 0,
        liveStartOffset: 0,
        liveStartLine: 0,
        currentSourceLength: length,
        sourceCreatedAt: new Date(
          length > 24 ? "2026-10-19T00:01:00.000Z" : "2026-10-19T00:00:00.000Z"
        ).toISOString(),
        storageProvider: "filesystem",
        storagePrefix: `grant-source-${randomUUID()}`,
        originDeploymentId: `deployment-${randomUUID()}`,
        originDeviceId: `device-${randomUUID()}`,
        originKeyId: `key-${randomUUID()}`,
        originPublicKey: "a".repeat(43),
        redactedSourceLabel: "Continuous source"
      }
    );
    const headDigest = hash(`head:${source.id}`);
    await pool.query(
      `insert into conversation_source_segments
      (artifact_id,segment_index,source_start_offset,source_end_offset,
       source_start_line,source_end_line,plaintext_digest,plaintext_size,
       stored_size,storage_key,storage_provider,signed_manifest,
       origin_signature,manifest_digest,previous_content_digest,content_digest)
      values ($1,0,0,$2,0,1,$3,$2,$2,$4,'filesystem',
        '{"version":1}'::jsonb,$5,$6,null,$7)`,
      [
        source.id,
        length,
        hash(`plaintext:${source.id}`),
        `${source.storagePrefix}/0.jsonl`,
        "a".repeat(86),
        hash(`manifest:${source.id}`),
        headDigest
      ]
    );
    const sourceClosureHash = hash(`closure:${source.id}`);
    await pool.query(
      `update conversation_source_artifacts
      set current_journal_sequence=0,provider_cursor_offset=$2,
          provider_cursor_line=1,current_source_length=$2,
          lifecycle='finalized',closure_hash=$3,closure_manifest=$4::jsonb,
          closure_signature=$5,finalized_at=now(),source_modified_at=now()
      where id=$1`,
      [
        source.id,
        length,
        sourceClosureHash,
        JSON.stringify({
          version: 1,
          segmentCount: 1,
          chainHeadDigest: headDigest
        }),
        "a".repeat(86)
      ]
    );
    await pool.query(
      `insert into team_conversation_source_grants
      (share_grant_id,artifact_id,logical_source_id,source_generation_id,
       owner_user_id,session_id,team_id,team_workspace_id,mode,
       mutation_id,granted_by_user_id,creator_authority)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'continuous',$9,$5,'test')`,
      [
        input.grantId,
        source.id,
        logicalSourceId,
        sourceGenerationId,
        input.owner,
        input.sessionId,
        teamId,
        workspaceId,
        randomUUID()
      ]
    );
    const policy = await privacy.resolveEffectiveContentPolicy({
      deploymentIdentityId: localDeploymentId,
      sourceOwnerUserId: input.owner,
      teamId,
      teamWorkspaceId: workspaceId
    });
    const classification =
      await privacy.getOrCreateStructuralClassificationBinding({
        actor: { userId: input.owner },
        provider,
        classifierHash
      });
    const sanitized = await privacy.storeSanitizedSourceArtifact({
      actor: { userId: input.owner },
      provider,
      shareGrantId: input.grantId,
      sourceArtifactId: source.id,
      teamId,
      teamWorkspaceId: workspaceId,
      classifierHash,
      effectivePolicyHash: policy.effectivePolicyHash,
      sourceFrontierHash: privacySourceFrontierHash({
        sourceArtifactId: source.id,
        sourceFrontierCursor: length,
        sourceSegmentCount: 1,
        headContentDigest: headDigest
      }),
      sourceFrontierCursor: length,
      sourceSegmentCount: 1,
      sourceClosureHash,
      format: "codex_rollout_jsonl",
      formatVersion: 1,
      metadata: { redactedTitle: "Published continuous source" },
      chunks: [
        {
          classificationResultId: classification.id,
          sourceStartByte: 0,
          sourceEndByte: length,
          text: `source revision ${length}`
        }
      ]
    });
    return {
      source,
      sanitized,
      logicalSourceId,
      sourceGenerationId,
      headDigest,
      externalSessionId
    };
  };

  // Seed the source, policy and reviewed consent boundary; create each active
  // grant through the shared-memory repository, then bind it through the
  // Workspace Project repository.
  const seedGrant = async (
    owner: string,
    sourceKind: "captured_session" | "personal_note"
  ) => {
    let deploymentId: string = randomUUID(),
      memoryId: string = randomUUID();
    const revisionId = randomUUID();
    const sourceId = randomUUID(),
      previewId = randomUUID(),
      consentId = randomUUID();
    const ownerPolicyId = randomUUID(),
      teamPolicyId = randomUUID(),
      workspacePolicyId = randomUUID();
    const grantId = randomUUID();
    let sourceSessionId: string = randomUUID();
    if (sourceKind === "captured_session") {
      await pool.query(
        `insert into deployment_identities
      (id,protocol_deployment_id,locality,profile) values ($1,$2,'remote','team_self_hosted')`,
        [deploymentId, randomUUID()]
      );
      await pool.query(
        `insert into sessions(id,owner_user_id,source_runtime,capture_method)
        values ($1,$2,'codex-cli','api')`,
        [sourceSessionId, owner]
      );
      const seed = await pool.connect();
      try {
        await seed.query("begin");
        await seed.query(
          `insert into logical_memories
      (id,protocol_logical_id,owner_user_id,owner_principal_id,
       origin_deployment_identity_id,source_kind,logical_key)
      values ($1,$1,$2,$2,$3,$4,$5)`,
          [
            memoryId,
            owner,
            deploymentId,
            sourceKind,
            `${sourceKind}:${sourceSessionId}`
          ]
        );
        if (sourceKind === "captured_session") {
          await seed.query(
            `insert into captured_session_logical_memories
        (logical_memory_id,source_session_id,owner_principal_id)
        values ($1,$2,$3)`,
            [memoryId, sourceSessionId, owner]
          );
        }
        await seed.query(
          `insert into logical_memory_source_revisions
      (id,logical_memory_id,owner_principal_id,source_kind,revision,binding_hash)
      values ($1,$2,$3,$4,1,$5)`,
          [revisionId, memoryId, owner, sourceKind, hash(revisionId)]
        );
        if (sourceKind === "captured_session") {
          await seed.query(
            `insert into captured_session_source_revisions
        (source_revision_id,logical_memory_id,owner_principal_id,source_kind,
         revision,source_cursor,source_session_id)
        values ($1,$2,$3,'captured_session',1,1,$4)`,
            [revisionId, memoryId, owner, sourceSessionId]
          );
        }
        await seed.query("commit");
      } catch (error) {
        await seed.query("rollback");
        throw error;
      } finally {
        seed.release();
      }
    } else {
      const note = await createCollaborationRepository(pool, {
        envelopeEncryptionProvider: provider
      }).createPersonalNote(
        { userId: owner },
        {
          body: "A durable Personal Note source",
          idempotencyKey: `grant-note-${randomUUID()}`
        }
      );
      sourceSessionId = note.noteId;
      const binding = await pool.query<{
        logical_memory_id: string;
        origin_deployment_identity_id: string;
      }>(
        `select local_memory.logical_memory_id,
          logical.origin_deployment_identity_id
        from local_personal_note_logical_memories local_memory
        join logical_memories logical on logical.id=local_memory.logical_memory_id
       where local_memory.local_note_id=$1 and local_memory.owner_user_id=$2`,
        [sourceSessionId, owner]
      );
      expect(binding.rows).toHaveLength(1);
      memoryId = binding.rows[0]!.logical_memory_id;
      deploymentId = binding.rows[0]!.origin_deployment_identity_id;
      const noteRevision = await pool.connect();
      try {
        await noteRevision.query("begin");
        await noteRevision.query(
          `insert into logical_memory_source_revisions
          (id,logical_memory_id,owner_principal_id,source_kind,revision,binding_hash)
          values ($1,$2,$3,'personal_note',1,$4)`,
          [revisionId, memoryId, owner, hash(revisionId)]
        );
        await noteRevision.query(
          `insert into personal_note_source_revisions
          (source_revision_id,logical_memory_id,owner_principal_id,source_kind,
           revision,source_note_id,source_memory_event_id)
          values ($1,$2,$3,'personal_note',1,$4,$5)`,
          [revisionId, memoryId, owner, sourceSessionId, randomUUID()]
        );
        await noteRevision.query("commit");
      } catch (error) {
        await noteRevision.query("rollback");
        throw error;
      } finally {
        noteRevision.release();
      }
    }
    await pool.query(
      `insert into source_owner_representation_policies
      (policy_id,logical_memory_id,source_owner_principal_id,version,
       maximum_fidelity,include_curated_memory,policy_hash,effective_at)
      values ($1,$2,$3,1,'memory_events',false,$4,now())`,
      [ownerPolicyId, memoryId, owner, hash(ownerPolicyId)]
    );
    await pool.query(
      `insert into team_representation_policies
      (policy_id,team_id,version,maximum_fidelity,include_curated_memory,
       policy_hash,effective_at) values ($1,$2,1,'memory_events',false,$3,now())
       on conflict do nothing`,
      [teamPolicyId, teamId, hash(teamPolicyId)]
    );
    await pool.query(
      `insert into workspace_representation_policies
      (policy_id,team_id,team_workspace_id,version,maximum_fidelity,
       include_curated_memory,policy_hash,effective_at)
       values ($1,$2,$3,1,'memory_events',false,$4,now()) on conflict do nothing`,
      [workspacePolicyId, teamId, workspaceId, hash(workspacePolicyId)]
    );
    const currentTeamPolicy = await pool.query<{ policy_id: string }>(
      `select policy_id from team_representation_policies where team_id=$1 and superseded_at is null`,
      [teamId]
    );
    const currentWorkspacePolicy = await pool.query<{ policy_id: string }>(
      `select policy_id from workspace_representation_policies where team_workspace_id=$1 and superseded_at is null`,
      [workspaceId]
    );
    const tp = currentTeamPolicy.rows[0]!.policy_id,
      wp = currentWorkspacePolicy.rows[0]!.policy_id;
    let remoteIdentityId: string = randomUUID();
    const credentialId = randomUUID();
    const remoteIdentity = await pool.query<{ id: string }>(
      `insert into sync_external_user_identities
      (id,deployment_identity_id,external_subject_id) values ($1,$2,$3)
      on conflict (deployment_identity_id,external_subject_id)
      do update set updated_at=sync_external_user_identities.updated_at returning id`,
      [remoteIdentityId, deploymentId, owner]
    );
    remoteIdentityId = remoteIdentity.rows[0]!.id;
    await pool.query(
      `insert into device_credentials
      (id,owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
       verifier_kind,verifier_hash,operation_families)
       values ($1,$2,$3,$4,$5,'secret_hash',$6,array['share_grant_management'])`,
      [
        credentialId,
        owner,
        randomUUID(),
        `backend-${randomUUID()}`,
        randomUUID(),
        hash(credentialId)
      ]
    );
    let remoteReplicaId: string | null = null;
    if (sourceKind === "captured_session") {
      remoteReplicaId = randomUUID();
      await pool.query(
        `insert into memory_replicas
        (id,logical_memory_id,deployment_identity_id,owner_user_id,
         owner_principal_id,replica_role,source_boundary,latest_revision,
         lifecycle,encryption_scope,freshness_status,
         representation_policy_revision,content_policy_version)
        values ($1,$2,$3,$4,$4,'target','captured_session',1,'active',
          'owner_private_replica','fresh',1,1)`,
        [remoteReplicaId, memoryId, localDeploymentId, owner]
      );
      await pool.query(
        `insert into cross_identity_sync_relationships
        (logical_memory_id,side,local_replica_id,local_user_id,
         device_credential_id,remote_deployment_identity_id,
         remote_user_identity_id,remote_replica_id,source_boundary,
         sync_mode,state,idempotency_key,creation_request_hash,
         source_cursor,target_processing_cursor,package_sequence,last_synced_at)
        values ($1,'target',$2,$3,$4,$5,$6,$7,'captured_session',
          'live','ready',$8,$9,1,1,1,now())`,
        [
          memoryId,
          remoteReplicaId,
          owner,
          credentialId,
          deploymentId,
          remoteIdentityId,
          randomUUID(),
          `sync-${randomUUID()}`,
          hash(randomUUID())
        ]
      );
    }
    await pool.query(
      `insert into shared_source_artifacts
      (id,logical_memory_id,source_revision_id,remote_replica_id,
       owner_user_id,owner_principal_id,
       team_id,team_workspace_id,source_capabilities,activation_representation,
       representation,source_revision,source_cursor,package_sequence,source_hash,
       manifest_hash,artifact_hash,source_content_hash,maximum_fidelity,
       include_curated_memory,source_owner_policy_id,source_owner_policy_version,
       team_policy_id,team_policy_version,workspace_policy_id,workspace_policy_version,
       representation_policy_revision,representation_policy_hash,
       content_policy_version,content_policy_hash,classifier_version,classifier_hash,
       source_deployment_identity_id,remote_user_identity_id,device_credential_id,
       device_provenance_hash)
       values ($1,$2,$3,$14,$4,$4,$5,$6,array['memory_events']::shared_memory_representation[],
        'memory_events','memory_events',1,1,1,$7,$7,$7,$7,'memory_events',false,
        $8,1,$9,1,$10,1,1,$7,1,$7,1,$7,$11,$12,$13,$7)`,
      [
        sourceId,
        memoryId,
        revisionId,
        owner,
        teamId,
        workspaceId,
        hash(sourceId),
        ownerPolicyId,
        tp,
        wp,
        deploymentId,
        remoteIdentityId,
        credentialId,
        remoteReplicaId
      ]
    );
    await pool.query(
      `insert into shared_source_previews
      (id,source_artifact_id,logical_memory_id,source_revision_id,
       remote_replica_id,owner_user_id,
       owner_principal_id,team_id,team_workspace_id,source_capabilities,
       activation_representation,mode,representation,preview_hash,
       source_revision,source_hash,source_content_hash)
       values ($1,$2,$3,$4,$9,$5,$5,$6,$7,
         array['memory_events']::shared_memory_representation[],
         'memory_events','continuous','memory_events',$8,1,$8,$8)`,
      [
        previewId,
        sourceId,
        memoryId,
        revisionId,
        owner,
        teamId,
        workspaceId,
        hash(previewId),
        remoteReplicaId
      ]
    );
    await pool.query(
      `insert into source_owner_representation_consents
      (id,logical_memory_id,source_revision_id,remote_replica_id,
       source_owner_principal_id,
       team_id,team_workspace_id,source_owner_policy_id,source_owner_policy_version,
       team_policy_id,team_policy_version,workspace_policy_id,workspace_policy_version,
       source_capabilities,activation_representation,mode,state,
       maximum_fidelity,include_curated_memory,preview_id,preview_revision,
       preview_hash,source_revision,source_hash,fidelity_policy_revision,
       fidelity_policy_hash,content_policy_version,content_policy_hash,
       classifier_version,classifier_hash,source_content_hash,activated_at)
       values ($1,$2,$3,$12,$4,$5,$6,$7,1,$8,1,$9,1,
        array['memory_events']::shared_memory_representation[],
        'memory_events','continuous','active','memory_events',false,$10,1,$11,
        1,$11,1,$11,1,$11,1,$11,$11,now())`,
      [
        consentId,
        memoryId,
        revisionId,
        owner,
        teamId,
        workspaceId,
        ownerPolicyId,
        tp,
        wp,
        previewId,
        hash(previewId),
        remoteReplicaId
      ]
    );
    const session = await pool.query<{ id: string }>(
      `insert into user_sessions
      (user_id,session_hash,expires_at) values ($1,$2,now()+interval '1 hour')
      returning id`,
      [owner, hash(randomUUID())]
    );
    const created = await createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: () => provider,
      resolveOwnerPrivateReplicaEncryptionProvider: () => provider,
      resolvePersonalEncryptionProvider: () => provider
    }).createShareGrant(
      { userId: owner },
      {
        mutationId: randomUUID(),
        logicalGrantId: grantId,
        consentId,
        authority: {
          action: SHARED_MEMORY_AUTHORITY,
          source: "browser_session",
          referenceId: session.rows[0]!.id
        }
      }
    );
    return {
      id: created.id,
      sourceSessionId,
      memoryId,
      revisionId,
      consentId,
      sourceId,
      previewId,
      ownerPolicyId,
      teamPolicyId: tp,
      workspacePolicyId: wp,
      owner
    };
  };

  const seedSummary = async (
    grant: Awaited<ReturnType<typeof seedGrant>>,
    summary: string,
    sourceRevision = 1
  ) => {
    let revisionId = grant.revisionId,
      sourceArtifactId = grant.sourceId;
    if (sourceRevision > 1) {
      revisionId = randomUUID();
      sourceArtifactId = randomUUID();
      const revision = await pool.connect();
      try {
        await revision.query("begin");
        await revision.query(
          `insert into logical_memory_source_revisions
          (id,logical_memory_id,owner_principal_id,source_kind,
           revision,binding_hash)
          values ($1,$2,$3,'captured_session',$4,$5)`,
          [
            revisionId,
            grant.memoryId,
            grant.owner,
            sourceRevision,
            hash(`revision:${revisionId}`)
          ]
        );
        await revision.query(
          `insert into captured_session_source_revisions
          (source_revision_id,logical_memory_id,owner_principal_id,
           source_kind,revision,source_cursor,source_session_id)
          values ($1,$2,$3,'captured_session',$4,$4,$5)`,
          [
            revisionId,
            grant.memoryId,
            grant.owner,
            sourceRevision,
            grant.sourceSessionId
          ]
        );
        await revision.query("commit");
      } catch (error) {
        await revision.query("rollback");
        throw error;
      } finally {
        revision.release();
      }
      await pool.query(
        `insert into shared_source_artifacts
        select (jsonb_populate_record(null::shared_source_artifacts,
          to_jsonb(source) || jsonb_build_object(
            'id',$2::text,'source_revision_id',$3::text,
            'source_revision',$4::integer,'source_cursor',$4::integer,
            'package_sequence',$4::integer,'source_hash',$5::text,
            'manifest_hash',$5::text,'artifact_hash',$5::text,
            'source_content_hash',$5::text,
            'representation_policy_hash',$5::text))).*
        from shared_source_artifacts source where source.id=$1`,
        [
          grant.sourceId,
          sourceArtifactId,
          revisionId,
          sourceRevision,
          hash(sourceArtifactId)
        ]
      );
      await pool.query(
        `update memory_replicas set latest_revision=$2,
        updated_at=now() where logical_memory_id=$1 and replica_role='target'`,
        [grant.memoryId, sourceRevision]
      );
      await pool.query(
        `update cross_identity_sync_relationships
        set source_cursor=$2,target_processing_cursor=$2,package_sequence=$2,
            last_synced_at=now(),updated_at=now()
        where logical_memory_id=$1 and side='target'`,
        [grant.memoryId, sourceRevision]
      );
      await pool.query(
        `update logical_memories set latest_source_revision=$2
        where id=$1`,
        [grant.memoryId, sourceRevision]
      );
    }
    const classifier = await pool.query<{ id: string; version: number }>(
      `select id,version from privacy_classifier_generations
        where classifier_hash=$1 and status='active'`,
      [classifierHash]
    );
    const policy = await privacy.resolveEffectiveContentPolicy({
      deploymentIdentityId: localDeploymentId,
      sourceOwnerUserId: grant.owner,
      teamId,
      teamWorkspaceId: workspaceId
    });
    const summaryPreviewId = randomUUID(),
      semanticPreviewId = randomUUID();
    const representationId = randomUUID();
    const contentHash = hash(summary);
    const previewHash = hash(summaryPreviewId),
      artifactHash = hash(sourceArtifactId);
    await pool.query(
      `insert into shared_source_previews
      (id,source_artifact_id,logical_memory_id,source_revision_id,
       owner_user_id,owner_principal_id,team_id,team_workspace_id,
       source_capabilities,activation_representation,mode,representation,
       preview_hash,source_revision,source_hash,source_content_hash)
      values ($1,$2,$3,$4,$5,$5,$6,$7,
        array['memory_events','lcm_rollups']::shared_memory_representation[],
        'memory_events','continuous','lcm_rollups',$8,$10,$9,$9)`,
      [
        summaryPreviewId,
        sourceArtifactId,
        grant.memoryId,
        revisionId,
        grant.owner,
        teamId,
        workspaceId,
        previewHash,
        artifactHash,
        sourceRevision
      ]
    );
    await pool.query(
      `insert into shared_source_semantic_previews
      (id,source_preview_id,source_artifact_id,source_preview_revision,
       source_preview_hash,source_artifact_hash,source_manifest_hash,
       source_revision,source_hash,logical_memory_id,owner_user_id,
       owner_principal_id,team_id,team_workspace_id,representation,
       classifier_generation_id,classifier_version,classifier_hash,
       effective_privacy_policy_hash,expected_manifest_hash,
       expected_chunk_count,result_manifest_hash,classification_field_count,
       completed_chunk_count,classification_byte_count,
       source_item_identity_hash,source_item_count,
       sanitized_content_hash,payload_binding_hash,status,ready_at)
      values ($1,$2,$3,1,$4,$5,$5,$16,$5,$6,$7,$7,$8,$9,
        'lcm_rollups',$10,$11,$12,$13,$14,1,$14,1,1,1,$14,1,$15,$14,
        'ready',now())`,
      [
        semanticPreviewId,
        summaryPreviewId,
        sourceArtifactId,
        previewHash,
        artifactHash,
        grant.memoryId,
        grant.owner,
        teamId,
        workspaceId,
        classifier.rows[0]!.id,
        classifier.rows[0]!.version,
        classifierHash,
        policy.effectivePolicyHash,
        hash(semanticPreviewId),
        contentHash,
        sourceRevision
      ]
    );
    const sourceRevisionHash = sharedMemorySanitizedSemanticSourceRevisionHash({
      sourcePreviewId: summaryPreviewId,
      sourcePreviewHash: previewHash,
      sourceArtifactId,
      sourceArtifactHash: artifactHash,
      sourceManifestHash: artifactHash,
      sourceRevision,
      representation: "lcm_rollups",
      sanitizedSourcePreviewId: semanticPreviewId,
      sanitizedContentHash: contentHash,
      sourceItemIdentityHash: hash(semanticPreviewId),
      sourceItemCount: 1,
      privacyClassifierGenerationId: classifier.rows[0]!.id,
      privacyClassifierHash: classifierHash,
      effectivePrivacyPolicyHash: policy.effectivePolicyHash
    });
    const binding = sharedMemorySanitizedSemanticSourceBinding({
      sourceRevision,
      sourceRevisionHash,
      fidelityPolicyRevision: 1,
      fidelityPolicyHash: artifactHash,
      contentPolicyVersion: 1,
      effectivePrivacyPolicyHash: policy.effectivePolicyHash,
      privacyClassifierVersion: classifier.rows[0]!.version,
      privacyClassifierHash: classifierHash
    });
    const provenanceHash = sharedMemorySanitizedSemanticProvenanceHash({
      shareGrantId: grant.id,
      consentId: grant.consentId,
      logicalMemoryId: grant.memoryId,
      representation: "lcm_rollups",
      binding,
      sourcePreviewId: summaryPreviewId,
      sourcePreviewHash: previewHash,
      sourceArtifactId,
      sourceArtifactHash: artifactHash,
      sourceManifestHash: artifactHash,
      sanitizedSourcePreviewId: semanticPreviewId,
      expectedManifestHash: hash(semanticPreviewId),
      expectedChunkCount: 1,
      resultManifestHash: hash(semanticPreviewId),
      sourceItemIdentityHash: hash(semanticPreviewId),
      sourceItemCount: 1,
      semanticPayloadBindingHash: hash(semanticPreviewId),
      privacyClassifierGenerationId: classifier.rows[0]!.id,
      privacyClassifierHash: classifierHash,
      effectivePrivacyPolicyHash: policy.effectivePolicyHash,
      sanitizedContentHash: contentHash,
      sourceOwnerPolicyId: grant.ownerPolicyId,
      sourceOwnerPolicyVersion: 1,
      teamPolicyId: grant.teamPolicyId,
      teamPolicyVersion: 1,
      workspacePolicyId: grant.workspacePolicyId,
      workspacePolicyVersion: 1
    });
    await pool.query(
      `insert into team_memory_representations
      (id,share_grant_id,consent_id,source_preview_id,source_artifact_id,
       sanitized_source_preview_id,privacy_classifier_generation_id,
       privacy_classifier_hash,effective_privacy_policy_hash,
       source_manifest_hash,sanitized_content_hash,team_id,team_workspace_id,
       logical_memory_id,source_revision_id,representation,source_revision,
       source_revision_hash,provenance_hash,source_owner_policy_id,
       source_owner_policy_version,team_policy_id,team_policy_version,
       workspace_policy_id,workspace_policy_version,fidelity_policy_revision,
       content_policy_version,classifier_version,state,available_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        'lcm_rollups',$22,$16,$17,$18,1,$19,1,$20,1,1,1,$21,'available',now())`,
      [
        representationId,
        grant.id,
        grant.consentId,
        summaryPreviewId,
        sourceArtifactId,
        semanticPreviewId,
        classifier.rows[0]!.id,
        classifierHash,
        policy.effectivePolicyHash,
        artifactHash,
        contentHash,
        teamId,
        workspaceId,
        grant.memoryId,
        revisionId,
        sourceRevisionHash,
        provenanceHash,
        grant.ownerPolicyId,
        grant.teamPolicyId,
        grant.workspacePolicyId,
        classifier.rows[0]!.version,
        sourceRevision
      ]
    );
    await pool.query(
      `insert into team_memory_semantic_items
      (representation_id,share_grant_id,team_id,team_workspace_id,
       logical_memory_id,pseudonymous_source_id,source_item_index,
       encrypted_chunk_index,encrypted_chunk_item_index,item_type,
       source_revision,representation_policy_revision,content_policy_version,
       classifier_version,content_hash)
      values ($1,$2,$3,$4,$5,$6,0,0,0,'lcm_summary',$9,1,1,$7,$8)`,
      [
        representationId,
        grant.id,
        teamId,
        workspaceId,
        grant.memoryId,
        randomUUID(),
        classifier.rows[0]!.version,
        contentHash,
        sourceRevision
      ]
    );
    return { representationId, semanticPreviewId, contentHash };
  };

  const executeProjectAction = async (
    actor: string,
    action:
      | "workspace_project.leave"
      | "workspace_project.delete"
      | "project_source.team_metadata.delete",
    body: Record<string, unknown>,
    execute: (
      repository: ReturnType<typeof createWorkspaceProjectRepository>
    ) => Promise<unknown>,
    sourceId?: string
  ) => {
    const session = await pool.query<{ id: string }>(
      `insert into user_sessions
      (user_id,session_hash,expires_at) values ($1,$2,now()+interval '1 hour')
      returning id`,
      [actor, hash(randomUUID())]
    );
    const credential = await pool.query<{
      id: string;
      upstream_backend_id: string;
    }>(
      `
      insert into device_credentials
        (owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
         verifier_kind,verifier_hash,operation_families)
      values ($1,$2,$3,$4,'secret_hash',$5,array['action_grant'])
      returning id,upstream_backend_id`,
      [
        actor,
        randomUUID(),
        `backend-${randomUUID()}`,
        randomUUID(),
        hash(randomUUID())
      ]
    );
    const path =
      action === "project_source.team_metadata.delete" && sourceId
        ? `/v1/workspace-projects/${project.id}/sources/${sourceId}/delete`
        : action === "workspace_project.leave"
          ? `/v1/workspace-projects/${project.id}/leave`
          : `/v1/workspace-projects/${project.id}/delete`;
    const request = { method: "POST", path, body };
    const operation = {
      ownerUserId: actor,
      deviceCredentialId: credential.rows[0]!.id,
      upstreamBackendId: credential.rows[0]!.upstream_backend_id,
      teamId,
      operationFamily: "admin",
      action,
      targetId: project.id,
      scopeHash: highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
        { operationFamily: "admin", action, teamId, targetId: project.id }
      ),
      requestHash: highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
        request
      )
    };
    const repository = createHighRiskActionRepository(createDb(pool), {
      pool,
      envelopeEncryptionProvider: provider,
      teamEnvelopeEncryptionProvider: provider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: provider
    });
    const secret = `hrg_${randomUUID().replaceAll("-", "")}`;
    const grant = await repository.createActionGrant({
      ...operation,
      clientRequestId: randomUUID(),
      grantCommitment: highRiskActionGrantCommitment(secret),
      credentialOperationFamily: "action_grant",
      approvalTier: "step_up",
      review: {
        version: 1,
        title: "Review Project action",
        description: "Review exact action",
        consequence: "Project access changes",
        confirmLabel: "Continue",
        details: []
      }
    });
    expect(grant?.state).toBe("pending");
    await repository.decideBrowserActivation({
      selector: grant!.selector,
      ownerUserId: actor,
      userSessionId: session.rows[0]!.id,
      freshlyAuthenticatedAt: new Date(),
      decision: "approve"
    });
    return repository.executeActionGrant({
      ...operation,
      actionGrant: secret,
      approvedRequest: request,
      execute: async ({ workspaceProject }) => {
        const result = await execute(workspaceProject);
        return result ? { statusCode: 200, body: { result } } : null;
      }
    });
  };

  const executeTeamLeave = async (
    expectedOwnedWorkspaceProjects: { id: string; version: number }[],
    expectedVersion: number,
    expectedTeamVersion: number
  ) => {
    const session = await pool.query<{ id: string }>(
      `insert into user_sessions
      (user_id,session_hash,expires_at) values ($1,$2,now()+interval '1 hour')
      returning id`,
      [alice, hash(randomUUID())]
    );
    const credential = await pool.query<{
      id: string;
      upstream_backend_id: string;
    }>(
      `
      insert into device_credentials
        (owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
         verifier_kind,verifier_hash,operation_families)
      values ($1,$2,$3,$4,'secret_hash',$5,array['action_grant'])
      returning id,upstream_backend_id`,
      [
        alice,
        randomUUID(),
        `backend-${randomUUID()}`,
        randomUUID(),
        hash(randomUUID())
      ]
    );
    const request = {
      method: "POST",
      path: `/v1/teams/${teamId}/leave`,
      body: {
        expectedVersion,
        expectedTeamVersion,
        expectedOwnedWorkspaceProjects
      }
    };
    const operation = {
      ownerUserId: alice,
      deviceCredentialId: credential.rows[0]!.id,
      upstreamBackendId: credential.rows[0]!.upstream_backend_id,
      teamId,
      operationFamily: "admin",
      action: "team.leave",
      targetId: teamId,
      scopeHash: highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
        {
          operationFamily: "admin",
          action: "team.leave",
          teamId,
          targetId: teamId
        }
      ),
      requestHash: highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
        request
      )
    };
    const repository = createHighRiskActionRepository(createDb(pool), {
      pool,
      envelopeEncryptionProvider: provider,
      teamEnvelopeEncryptionProvider: provider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: provider
    });
    const secret = `hrg_${randomUUID().replaceAll("-", "")}`;
    const issued = await repository.createActionGrant({
      ...operation,
      clientRequestId: randomUUID(),
      grantCommitment: highRiskActionGrantCommitment(secret),
      credentialOperationFamily: "action_grant",
      approvalTier: "step_up",
      review: {
        version: 1,
        title: "Leave Team",
        description: "Review owned Projects",
        consequence: "Shared grants freeze",
        confirmLabel: "Leave",
        details: []
      }
    });
    expect(issued?.state).toBe("pending");
    await repository.decideBrowserActivation({
      selector: issued!.selector,
      ownerUserId: alice,
      userSessionId: session.rows[0]!.id,
      freshlyAuthenticatedAt: new Date(),
      decision: "approve"
    });
    return repository.executeActionGrant({
      ...operation,
      actionGrant: secret,
      approvedRequest: request,
      execute: async ({ team }) => {
        const result = await team.leaveTeam(
          { userId: alice },
          { teamId, ...request.body }
        );
        return result ? { statusCode: 200, body: { result } } : null;
      }
    });
  };

  it("freezes only the bound member grant in a verified self-leave", async () => {
    const bound = await seedGrant(bob, "personal_note");
    const independent = await seedGrant(bob, "captured_session");
    const repository = createWorkspaceProjectRepository(pool);
    expect(
      await repository.bindShareGrant(bob, project.id, bound.id, 1)
    ).toMatchObject({
      workspaceProjectId: project.id,
      shareGrantId: bound.id,
      sourceOwnerTeamMemberId: members[bob]!.id
    });
    await expect(
      repository.bindShareGrant(alice, project.id, independent.id, 1)
    ).rejects.toThrow();
    await pool.query(
      `update workspace_project_members set access='read',version=version+1
      where workspace_project_id=$1 and team_member_id=$2`,
      [project.id, members[bob]!.id]
    );
    await pool.query(
      `update team_workspace_access_grants set access='read',
      can_share_owned_memory=false,version=version+1
      where team_workspace_id=$1 and user_id=$2`,
      [workspaceId, bob]
    );
    const state = await repository.lifecycle(bob, project.id);
    await executeProjectAction(
      bob,
      "workspace_project.leave",
      {
        expectedProjectVersion: state.version,
        expectedMemberVersion: state.memberVersion
      },
      (scoped) =>
        scoped.leave(bob, project.id, {
          expectedProjectVersion: state.version,
          expectedMemberVersion: state.memberVersion
        })
    );
    expect((await grantState(bound.id)).frozen_at).not.toBeNull();
    expect((await grantState(bound.id)).freeze_manifest_hash).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect((await grantState(independent.id)).frozen_at).toBeNull();
    expect((await repository.lifecycle(bob, project.id)).active).toBe(false);
    const access = await pool.query<{ access: string }>(
      `select access from team_workspace_access_grants
      where team_workspace_id=$1 and user_id=$2`,
      [workspaceId, bob]
    );
    expect(access.rows[0]?.access).toBe("disabled");
    const member = await pool.query<{ status: string }>(
      `select status from team_memberships where id=$1`,
      [members[bob]!.id]
    );
    expect(member.rows[0]?.status).toBe("enabled");
    const remaining = await pool.query<{ access: string }>(
      `select access from team_workspace_access_grants
      where team_workspace_id=$1 and user_id=$2`,
      [workspaceId, carol]
    );
    expect(remaining.rows[0]?.access).toBe("write");
  }, 120_000);

  it("requires reviewed Source metadata deletion and freezes only its exact Personal Note grant", async () => {
    const repository = createWorkspaceProjectRepository(pool);
    const bound = await seedGrant(alice, "personal_note");
    const otherNote = await seedGrant(alice, "personal_note");
    const revision = await pool.query<{ id: string }>(
      `select id from personal_note_revisions
      where note_id=$1 and owner_user_id=$2 order by revision desc limit 1`,
      [bound.sourceSessionId, alice]
    );
    expect(revision.rows).toHaveLength(1);
    const source = await repository.createSource(alice, project.id, {
      sourceProjectSourceId: randomUUID(),
      name: "Owner's Note",
      kind: "doc",
      status: "ready",
      personalNoteId: bound.sourceSessionId,
      personalNoteRevisionId: revision.rows[0]!.id
    });
    await expect(
      repository.bindShareGrant(alice, project.id, otherNote.id, 1, source.id)
    ).rejects.toThrow();
    expect(
      await repository.bindShareGrant(alice, project.id, bound.id, 1, source.id)
    ).toMatchObject({
      shareGrantId: bound.id,
      workspaceProjectSourceId: source.id
    });
    const review = await repository.getSourceDeleteReview(
      alice,
      project.id,
      source.id
    );
    expect(review).toMatchObject({
      sourceId: source.id,
      sourceVersion: source.version,
      uploaderUserId: alice
    });
    await expect(
      repository.patchSource(alice, project.id, source.id, {
        expectedVersion: source.version,
        deleted: true
      })
    ).rejects.toThrow(/Step-up/);
    expect((await grantState(bound.id)).frozen_at).toBeNull();
    const current = await repository.lifecycle(alice, project.id);
    await expect(
      executeProjectAction(
        alice,
        "project_source.team_metadata.delete",
        {
          expectedProjectVersion: current.version,
          expectedSourceVersion: source.version + 1
        },
        (scoped) =>
          scoped.deleteSourceMetadata(alice, project.id, source.id, {
            expectedProjectVersion: current.version,
            expectedSourceVersion: source.version + 1
          }),
        source.id
      )
    ).rejects.toThrow();
    expect((await grantState(bound.id)).frozen_at).toBeNull();
    expect(
      (
        await repository.listSources(alice, project.id, { offset: 0 })
      ).items.map((entry) => entry.id)
    ).toContain(source.id);
    const deleted = await executeProjectAction(
      alice,
      "project_source.team_metadata.delete",
      {
        expectedProjectVersion: current.version,
        expectedSourceVersion: source.version
      },
      (scoped) =>
        scoped.deleteSourceMetadata(alice, project.id, source.id, {
          expectedProjectVersion: current.version,
          expectedSourceVersion: source.version
        }),
      source.id
    );
    expect(deleted?.statusCode).toBe(200);
    expect((await grantState(bound.id)).frozen_at).not.toBeNull();
    expect((await grantState(bound.id)).freeze_manifest_hash).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect((await grantState(otherNote.id)).frozen_at).toBeNull();
    expect(
      (
        await repository.listSources(alice, project.id, { offset: 0 })
      ).items.map((entry) => entry.id)
    ).not.toContain(source.id);
    const personal = await pool.query<{ id: string }>(
      `select id from personal_notes
      where id=$1 and owner_user_id=$2`,
      [bound.sourceSessionId, alice]
    );
    expect(personal.rows).toHaveLength(1);
    await repository.patchSource(alice, project.id, source.id, {
      expectedVersion: source.version + 1,
      deleted: false
    });
    expect(
      (
        await repository.listSources(alice, project.id, { offset: 0 })
      ).items.map((entry) => entry.id)
    ).toContain(source.id);
    expect((await grantState(bound.id)).frozen_at).not.toBeNull();
    expect((await grantState(otherNote.id)).frozen_at).toBeNull();
  }, 120_000);

  it("atomically freezes all bound grants on owner delete and leaves independent grants active", async () => {
    const repository = createWorkspaceProjectRepository(pool);
    const ownerBound = await seedGrant(alice, "captured_session");
    const memberBound = await seedGrant(carol, "captured_session");
    const independent = await seedGrant(alice, "captured_session");
    const independentSameSource = await seedGrant(carol, "captured_session");
    const continuous = await publishContinuousSource({
      grantId: memberBound.id,
      owner: carol,
      sessionId: memberBound.sourceSessionId
    });
    const firstSummary = await seedSummary(memberBound, "Summary revision N");
    const sourceAccess = createTeamConversationSourceRepository(pool);
    const beforeSource = await sourceAccess.getTeamConversationSourceManifest(
      { userId: alice },
      { shareGrantId: memberBound.id, afterSegmentIndex: -1, limit: 10 }
    );
    expect(beforeSource?.segments).toHaveLength(1);
    await repository.bindShareGrant(alice, project.id, ownerBound.id, 1);
    await repository.bindShareGrant(carol, project.id, memberBound.id, 1);
    const current = await repository.lifecycle(alice, project.id);
    await expect(
      executeProjectAction(
        alice,
        "workspace_project.delete",
        {
          expectedProjectVersion: current.version + 1
        },
        (scoped) => scoped.deleteProject(alice, project.id, current.version + 1)
      )
    ).rejects.toThrow();
    expect((await grantState(ownerBound.id)).frozen_at).toBeNull();
    expect((await grantState(memberBound.id)).frozen_at).toBeNull();
    expect((await repository.lifecycle(alice, project.id)).active).toBe(true);
    const result = await executeProjectAction(
      alice,
      "workspace_project.delete",
      {
        expectedProjectVersion: current.version
      },
      (scoped) => scoped.deleteProject(alice, project.id, current.version)
    );
    expect(result?.statusCode).toBe(200);
    expect((await grantState(ownerBound.id)).frozen_at).not.toBeNull();
    expect((await grantState(memberBound.id)).frozen_at).not.toBeNull();
    const frozenSummary = await pool.query<{
      source_representation_id: string;
      frozen_representation_id: string;
      source_revision: string;
    }>(
      `select source_representation_id,frozen_representation_id,source_revision
      from team_memory_grant_freeze_representations
      where share_grant_id=$1 and representation='lcm_rollups'`,
      [memberBound.id]
    );
    expect(frozenSummary.rows[0]?.source_representation_id).toBe(
      firstSummary.representationId
    );
    expect(frozenSummary.rows[0]?.frozen_representation_id).not.toBe(
      firstSummary.representationId
    );
    const frozenItem = await pool.query<{ content_hash: string }>(
      `select item.content_hash from team_memory_semantic_items item
        where item.representation_id=$1`,
      [frozenSummary.rows[0]!.frozen_representation_id]
    );
    expect(frozenItem.rows[0]?.content_hash).toBe(firstSummary.contentHash);
    const frozenSource = await pool.query<{
      lifecycle: string;
      mode: string;
      maximum_segment_index: number | null;
      maximum_source_offset: string | null;
    }>(
      `select lifecycle,mode,maximum_segment_index,maximum_source_offset
        from team_conversation_source_grants
        where share_grant_id=$1`,
      [memberBound.id]
    );
    expect(frozenSource.rows[0]).toMatchObject({
      lifecycle: "active",
      mode: "snapshot"
    });
    expect(frozenSource.rows[0]?.maximum_segment_index).toBe(0);
    expect(Number(frozenSource.rows[0]?.maximum_source_offset)).toBe(24);
    const pinned = await sourceAccess.getTeamConversationSourceManifest(
      { userId: alice },
      { shareGrantId: memberBound.id, afterSegmentIndex: -1, limit: 10 }
    );
    expect(pinned?.segments).toHaveLength(1);
    expect(continuous.sanitized.id).toBeTruthy();
    const later = await publishContinuousSource({
      grantId: independentSameSource.id,
      owner: carol,
      sessionId: memberBound.sourceSessionId,
      logicalSourceId: continuous.logicalSourceId,
      externalSessionId: continuous.externalSessionId,
      length: 48
    });
    const laterSummary = await seedSummary(
      independentSameSource,
      "Summary revision N+1",
      2
    );
    const authorityClient = await pool.connect();
    try {
      const currentSummary = await readSharedMemoryGrantAuthorityWithClient(
        authorityClient,
        { userId: alice },
        {
          shareGrantId: independentSameSource.id,
          representation: "lcm_rollups"
        },
        false
      );
      expect(currentSummary?.representation.sourceRevision).toBe(2);
      const pinnedSummary = await readSharedMemoryGrantAuthorityWithClient(
        authorityClient,
        { userId: alice },
        { shareGrantId: memberBound.id, representation: "lcm_rollups" },
        false
      );
      expect(pinnedSummary?.representation.sourceRevision).toBe(1);
    } finally {
      authorityClient.release();
    }
    const laterManifest = await sourceAccess.getTeamConversationSourceManifest(
      { userId: alice },
      {
        shareGrantId: independentSameSource.id,
        afterSegmentIndex: -1,
        limit: 10
      }
    );
    expect(laterManifest?.segments).toHaveLength(1);
    expect(laterManifest?.artifact.id).toBe(later.source.id);
    const stillPinned = await sourceAccess.getTeamConversationSourceManifest(
      { userId: alice },
      { shareGrantId: memberBound.id, afterSegmentIndex: -1, limit: 10 }
    );
    expect(stillPinned?.artifact.id).toBe(continuous.source.id);
    expect(laterSummary.contentHash).not.toBe(firstSummary.contentHash);
    const stillFrozenItem = await pool.query<{ content_hash: string }>(
      `select content_hash from team_memory_semantic_items
        where representation_id=$1`,
      [frozenSummary.rows[0]!.frozen_representation_id]
    );
    expect(stillFrozenItem.rows[0]?.content_hash).toBe(
      firstSummary.contentHash
    );
    expect((await grantState(independentSameSource.id)).frozen_at).toBeNull();
    expect((await grantState(independent.id)).frozen_at).toBeNull();
    const lifecycle = await pool.query<{ lifecycle: string }>(
      `select lifecycle from workspace_projects where id=$1`,
      [project.id]
    );
    expect(lifecycle.rows[0]?.lifecycle).toBe("deleted");
    const access = await pool.query<{ user_id: string; access: string }>(
      `select user_id,access from team_workspace_access_grants
        where team_workspace_id=$1 and user_id in ($2,$3)`,
      [workspaceId, alice, carol]
    );
    expect(access.rows).toEqual(
      expect.arrayContaining([
        { user_id: alice, access: "write" },
        { user_id: carol, access: "write" }
      ])
    );
  }, 120_000);

  it("requires the exact owned Project set and freezes grants with Team leave", async () => {
    const repository = createWorkspaceProjectRepository(pool);
    workspaceId = randomUUID();
    await pool.query(
      `insert into team_workspaces(id,team_id,name)
      values ($1,$2,'Team leave Project')`,
      [workspaceId, teamId]
    );
    await pool.query(
      `insert into team_workspace_access_grants
      (team_workspace_id,team_id,user_id,access,can_share_owned_memory)
      values ($1,$2,$3,'write',true),($1,$2,$4,'write',true)`,
      [workspaceId, teamId, alice, carol]
    );
    project = await repository.create(alice, {
      teamId,
      workspaceId,
      name: "Team leave source",
      key: "TLV",
      shareAttemptKey: randomUUID()
    });
    await repository.join(carol, project.id);
    const otherMemberBound = await seedGrant(carol, "captured_session");
    const otherMemberIndependent = await seedGrant(carol, "captured_session");
    const ownerUnbound = await seedGrant(alice, "captured_session");
    const teamLeaveSource = await publishContinuousSource({
      grantId: otherMemberBound.id,
      owner: carol,
      sessionId: otherMemberBound.sourceSessionId
    });
    const teamLeaveSummary = await seedSummary(
      otherMemberBound,
      "Owned Project Team leave summary"
    );
    await repository.bindShareGrant(carol, project.id, otherMemberBound.id, 1);
    const team = createTeamAccessRepository(pool);
    await pool.query(
      `update team_memberships set role='member',version=version+1
      where id=$1`,
      [members[carol]!.id]
    );
    const lastOwnerReview = await team.getTeamLeaveReview(
      { userId: alice },
      teamId
    );
    expect(lastOwnerReview?.activeOwnerCount).toBe(1);
    await expect(
      executeTeamLeave(
        lastOwnerReview!.ownedWorkspaceProjects,
        lastOwnerReview!.membership.version,
        lastOwnerReview!.team.version
      )
    ).resolves.toBeNull();
    expect((await grantState(otherMemberBound.id)).frozen_at).toBeNull();
    expect((await repository.lifecycle(alice, project.id)).active).toBe(true);
    await pool.query(
      `update team_memberships set role='owner',version=version+1
      where id=$1`,
      [members[carol]!.id]
    );
    const review = await team.getTeamLeaveReview({ userId: alice }, teamId);
    expect(review?.ownedWorkspaceProjects).toEqual([
      { id: project.id, version: project.version + 1 }
    ]);
    const before = await grantState(otherMemberBound.id);
    await expect(
      executeTeamLeave(
        [{ id: project.id, version: 0 }],
        review!.membership.version,
        review!.team.version
      )
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(await grantState(otherMemberBound.id)).toEqual(before);
    expect((await repository.lifecycle(alice, project.id)).active).toBe(true);
    const result = await executeTeamLeave(
      review!.ownedWorkspaceProjects,
      review!.membership.version,
      review!.team.version
    );
    expect(result?.statusCode).toBe(200);
    expect((await grantState(otherMemberBound.id)).frozen_at).not.toBeNull();
    const teamLeavePinned = await pool.query<{
      source_representation_id: string;
      frozen_representation_id: string;
    }>(
      `select source_representation_id,frozen_representation_id
      from team_memory_grant_freeze_representations
      where share_grant_id=$1 and representation='lcm_rollups'`,
      [otherMemberBound.id]
    );
    expect(teamLeavePinned.rows[0]?.source_representation_id).toBe(
      teamLeaveSummary.representationId
    );
    const teamLeaveSourceGrant = await pool.query<{
      mode: string;
      maximum_source_offset: string;
    }>(
      `select mode,maximum_source_offset from team_conversation_source_grants
        where share_grant_id=$1`,
      [otherMemberBound.id]
    );
    expect(teamLeaveSourceGrant.rows[0]?.mode).toBe("snapshot");
    expect(Number(teamLeaveSourceGrant.rows[0]?.maximum_source_offset)).toBe(
      24
    );
    expect(teamLeaveSource.sanitized.id).toBeTruthy();
    expect((await grantState(otherMemberIndependent.id)).frozen_at).toBeNull();
    expect((await grantState(ownerUnbound.id)).frozen_at).not.toBeNull();
    const state = await pool.query<{ lifecycle: string }>(
      `select lifecycle from workspace_projects where id=$1`,
      [project.id]
    );
    expect(state.rows[0]?.lifecycle).toBe("deleted");
    const access = await pool.query<{
      user_id: string;
      access: string;
      disabled_at: Date | null;
    }>(
      `select user_id,access,disabled_at from team_workspace_access_grants
        where team_workspace_id=$1 and user_id in ($2,$3)`,
      [workspaceId, alice, carol]
    );
    expect(
      access.rows.find((row) => row.user_id === alice)?.disabled_at
    ).toBeInstanceOf(Date);
    expect(access.rows.find((row) => row.user_id === carol)).toMatchObject({
      access: "write",
      disabled_at: null
    });
  }, 120_000);
});
