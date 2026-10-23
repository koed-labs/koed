import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  crossIdentitySyncDeterministicUuid,
  generateProjectSharePolicyKeyPair,
  signProjectSharePolicyProof
} from "@koed/shared";
import { runDbMigrations } from "./migrate.js";
import {
  createChatMoveRepository,
  ChatMoveConflictError
} from "./chat-move-repository.js";
import { createPersonalProjectSharePolicyRepository } from "./personal-project-share-policy-repository.js";
import {
  createProjectSharePolicyRepository,
  ProjectSharePolicyConflictError,
  type ProjectShareManifestEntry
} from "./project-share-policy-repository.js";
import { createSharedMemoryRepository } from "./shared-memory-repository.js";

const testUrl = process.env.KOED_HQ702_TEST_DATABASE_URL;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe.skipIf(!testUrl)("Project policy issue integration", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database = "";
  const teamUserId = randomUUID();
  const personalOwnerUserId = randomUUID();
  const teamId = randomUUID();
  const memberId = randomUUID();
  const workspaceId = randomUUID();
  const deviceCredentialId = randomUUID();
  const deploymentProtocolId = randomUUID();
  const sourceOwnerPrincipalId = randomUUID();
  const backendId = "hq702-stage-integration";
  const actor = {
    userId: teamUserId,
    deviceCredentialId,
    upstreamBackendId: backendId
  };
  const keys = generateProjectSharePolicyKeyPair();
  const bindingHash = hash("exact owner Personal Project link");

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq702_stage_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${database}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query(`insert into users(id,email) values($1,$2)`, [
      teamUserId,
      `${teamUserId}@test.invalid`
    ]);
    await pool.query(
      `insert into teams(id,name) values($1,'Policy stage team')`,
      [teamId]
    );
    await pool.query(
      `insert into team_memberships(id,team_id,user_id,role,status,accepted_at)
       values($1,$2,$3,'owner','enabled',now())`,
      [memberId, teamId, teamUserId]
    );
    await pool.query(
      `insert into team_workspaces(id,team_id,name) values($1,$2,'Policy stage workspace')`,
      [workspaceId, teamId]
    );
    await pool.query(
      `insert into team_workspace_access_grants
       (team_workspace_id,team_id,user_id,access,can_share_owned_memory)
       values($1,$2,$3,'write',true)`,
      [workspaceId, teamId, teamUserId]
    );
    await pool.query(
      `insert into deployment_identities(protocol_deployment_id,locality,profile,display_name)
       values($1,'remote','team_self_hosted','Policy source')`,
      [deploymentProtocolId]
    );
    const deployment = await pool.query<{ id: string }>(
      `select id from deployment_identities where protocol_deployment_id=$1`,
      [deploymentProtocolId]
    );
    const identity = await pool.query<{ id: string }>(
      `insert into sync_external_user_identities(deployment_identity_id,external_subject_id)
       values($1,$2) returning id`,
      [deployment.rows[0]!.id, sourceOwnerPrincipalId]
    );
    await pool.query(
      `insert into sync_principal_links
       (local_user_id,external_user_identity_id,proof_kind,proof_reference)
       values($1,$2,'test_fixture',$3)`,
      [teamUserId, identity.rows[0]!.id, `policy-stage-${randomUUID()}`]
    );
    await pool.query(
      `insert into device_credentials
       (id,owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
        verifier_kind,verifier_hash,operation_families,metadata)
       values($1,$2,$3,$4,$5,'secret_hash',$6,ARRAY['share_grant_management']::text[],$7::jsonb)`,
      [
        deviceCredentialId,
        teamUserId,
        `stage-${randomUUID()}`,
        backendId,
        `stage-${randomUUID()}`,
        hash("credential"),
        JSON.stringify({
          protocolDeploymentId: deploymentProtocolId,
          sourceOwnerPrincipalId
        })
      ]
    );
    for (const table of [
      "team_representation_policies",
      "workspace_representation_policies"
    ] as const) {
      const scopeColumn =
        table === "team_representation_policies" ? "" : "team_workspace_id,";
      const scopeValue = table === "team_representation_policies" ? "" : "$3,";
      const parameters =
        table === "team_representation_policies"
          ? [randomUUID(), teamId, hash(table), teamUserId]
          : [randomUUID(), teamId, workspaceId, hash(table), teamUserId];
      const hashIndex = table === "team_representation_policies" ? 3 : 4;
      const userIndex = hashIndex + 1;
      await pool.query(
        `insert into ${table}
         (policy_id,team_id,${scopeColumn}version,maximum_fidelity,include_curated_memory,
          policy_hash,created_by_user_id,effective_at)
         values($1,$2,${scopeValue}1,'lcm_leaves',false,$${hashIndex},$${userIndex},now())`,
        parameters
      );
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database "${database}" with (force)`);
    await admin?.end();
  });

  const createProject = async () => {
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await pool.query(
      `insert into team_workspaces(id,team_id,name) values($1,$2,$3)`,
      [projectWorkspaceId, teamId, `Stage workspace ${projectId}`]
    );
    await pool.query(
      `insert into team_workspace_access_grants
       (team_workspace_id,team_id,user_id,access,can_share_owned_memory)
       values($1,$2,$3,'write',true)`,
      [projectWorkspaceId, teamId, teamUserId]
    );
    await pool.query(
      `insert into workspace_representation_policies
       (policy_id,team_id,team_workspace_id,version,maximum_fidelity,
        include_curated_memory,policy_hash,created_by_user_id,effective_at)
       values($1,$2,$3,1,'lcm_leaves',false,$4,$5,now())`,
      [randomUUID(), teamId, projectWorkspaceId, hash(projectId), teamUserId]
    );
    await pool.query(
      `insert into workspace_projects
       (id,team_id,workspace_id,owner_team_member_id,name,key,share_attempt_key)
       values($1,$2,$3,$4,'Policy staging',$5,$6)`,
      [
        projectId,
        teamId,
        projectWorkspaceId,
        memberId,
        `stage-${projectId}`,
        `stage-${projectId}`
      ]
    );
    await pool.query(
      `insert into workspace_project_members(workspace_project_id,team_member_id,access)
       values($1,$2,'write')`,
      [projectId, memberId]
    );
    return projectId;
  };

  const createSource = async (label: string) => {
    const sessionId = randomUUID();
    const logicalMemoryId = crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v1",
      sourceDeploymentId: deploymentProtocolId,
      sourceUserId: sourceOwnerPrincipalId,
      originSessionId: sessionId,
      identity: "logical-memory"
    });
    const deployment = await pool.query<{ id: string }>(
      `select id from deployment_identities where protocol_deployment_id=$1`,
      [deploymentProtocolId]
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into logical_memories
         (id,owner_user_id,owner_principal_id,origin_deployment_identity_id,
          source_kind,logical_key,latest_source_revision)
         values($1,$2,$3,$4,'captured_session',$5,0)`,
        [
          logicalMemoryId,
          teamUserId,
          sourceOwnerPrincipalId,
          deployment.rows[0]!.id,
          `captured-session:${sessionId}`
        ]
      );
      await client.query(
        `insert into captured_session_logical_memories
         (logical_memory_id,source_kind,source_session_id,owner_principal_id)
         values($1,'captured_session',$2,$3)`,
        [logicalMemoryId, sessionId, sourceOwnerPrincipalId]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const sourceId = randomUUID();
    const candidate = {
      source: { kind: "captured_session" as const, sessionId, logicalMemoryId },
      logicalMemoryId,
      sourceDeploymentProtocolId: deploymentProtocolId,
      sourceOwnerPrincipalId,
      deviceCredentialId,
      sourceCapabilities: ["lcm_leaves" as const],
      activationRepresentation: "lcm_leaves" as const,
      candidateHash: hash(`candidate:${label}`),
      sourceRevision: 1,
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId, revisionHash: hash(`leaf:${label}`) }],
      byteCount: 128
    };
    const entry: ProjectShareManifestEntry = {
      sessionId,
      logicalMemoryId,
      sourceRevision: 1,
      mappingRevision: 1,
      reviewLabel: label
    };
    return { entry, candidate };
  };

  const enable = async (
    projectId: string,
    entries: ProjectShareManifestEntry[]
  ) => {
    const repository = createProjectSharePolicyRepository(pool);
    const prepared = await repository.prepareInitialManifest(actor, {
      projectId,
      expectedPolicyVersion: 0,
      personalProjectBindingHash: bindingHash,
      signingPublicKey: keys.publicKeyDerBase64,
      entries
    });
    const enabled = await repository.enable(actor, {
      projectId,
      expectedPolicyVersion: 0,
      manifestId: prepared.manifestId,
      manifestHash: prepared.manifestHash,
      signingPublicKey: keys.publicKeyDerBase64,
      currentEntries: entries
    });
    return { repository, prepared, enabled };
  };

  // The share activation itself is covered by Shared Memory suites. These
  // rows seed its acknowledged result so exclusion uses real PostgreSQL joins
  // and row locks, including the partial unique index for active grants.
  const seedActivatedGrant = async (input: {
    pendingShareId: string;
    projectId: string;
    policyGrant?: boolean;
    frozen?: boolean;
  }) => {
    const grantId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role=replica");
      await client.query(
        `insert into team_memory_share_grants
         (id,logical_grant_id,logical_memory_id,source_revision_id,
          owner_user_id,owner_principal_id,team_id,team_workspace_id,consent_id,
          source_owner_policy_id,source_owner_policy_version,team_policy_id,
          team_policy_version,workspace_policy_id,workspace_policy_version,
          source_capabilities,activation_representation,mode,maximum_fidelity,
          include_curated_memory,fidelity_policy_revision,content_policy_version,
          classifier_version,source_revision,creator_authority,grant_version,
          frozen_at,freeze_mutation_id,freeze_manifest_hash,freeze_representation_count)
         select $1,$2,p.logical_memory_id,p.source_revision_id,p.owner_user_id,
                source.owner_principal_id,p.team_id,p.team_workspace_id,p.consent_id,
                $3,1,$4,1,$5,1,p.source_capabilities,p.activation_representation,
                p.mode,p.maximum_fidelity,p.include_curated_memory,1,1,1,
                p.source_revision,'device_action_grant',
                case when $6::boolean then 2 else 1 end,
                case when $6::boolean then now() else null end,
                case when $6::boolean then $7::uuid else null end,
                case when $6::boolean then $8::text else null end,
                case when $6::boolean then 0 else null end
           from pending_share_operations p
           join logical_memories source on source.id=p.logical_memory_id
          where p.id=$9`,
        [
          grantId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          input.frozen ?? false,
          randomUUID(),
          hash("frozen grant"),
          input.pendingShareId
        ]
      );
      await client.query(
        `insert into workspace_project_share_grant_bindings
         (workspace_project_id,share_grant_id,source_owner_team_member_id)
         values($1,$2,$3)`,
        [input.projectId, grantId, memberId]
      );
      if (input.policyGrant) {
        await client.query(
          `update pending_share_operations
              set grant_id=$2,state='activated',activated_at=now()
            where id=$1`,
          [input.pendingShareId, grantId]
        );
        await client.query(
          `update workspace_project_share_policy_issues
              set activated_at=now() where pending_share_id=$1`,
          [input.pendingShareId]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return grantId;
  };

  const freezeSeededGrant = async (grantId: string) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role=replica");
      await client.query(
        `update team_memory_share_grants
          set frozen_at=now(),freeze_mutation_id=$2,
              freeze_manifest_hash=$3,freeze_representation_count=0,
              grant_version=grant_version+1
        where id=$1 and frozen_at is null`,
        [grantId, randomUUID(), hash(`freeze:${grantId}`)]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };

  it("requires freeze only for a live original policy grant and settles after its freeze", async () => {
    const projectId = await createProject();
    const source = await createSource("Original policy freeze");
    const { repository, prepared } = await enable(projectId, [source.entry]);
    const staged = await repository.stageInitialBundle(actor, {
      projectId,
      expectedPolicyVersion: 1,
      personalProjectBindingHash: prepared.personalProjectBindingHash,
      sessionId: source.entry.sessionId,
      mappingRevision: 1,
      candidate: source.candidate
    });
    if (staged.state !== "staged")
      throw new Error("Expected staged policy grant");
    const grantId = await seedActivatedGrant({
      pendingShareId: staged.pendingShareId,
      projectId,
      policyGrant: true
    });
    const unavailableEncryption = (): never => {
      throw new Error("Owned-share metadata must not decrypt source content");
    };
    const shares = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: unavailableEncryption,
      resolveOwnerPrivateReplicaEncryptionProvider: unavailableEncryption,
      resolvePersonalEncryptionProvider: unavailableEncryption
    });
    const listed = await shares.listOwnerShares(
      { userId: teamUserId },
      { limit: 100 }
    );
    expect(
      listed.entries.filter((entry) =>
        entry.kind === "grant"
          ? entry.grant.id === grantId
          : entry.pendingShare.grantId === grantId
      )
    ).toHaveLength(1);
    const detail = await shares.getOwnerShare(
      { userId: teamUserId },
      { kind: "grant", id: grantId }
    );
    expect(detail?.kind).toBe("grant");
    if (detail?.kind === "grant") {
      expect(detail.grant.id).toBe(grantId);
      expect(detail.summary.workspaceContentAccess).toBe("available");
    }
    expect(
      await shares.getOwnerShare(
        { userId: randomUUID() },
        { kind: "grant", id: grantId }
      )
    ).toBeNull();
    expect(
      await repository.excludeSession(actor, {
        projectId,
        sessionId: source.entry.sessionId,
        expectedPolicyVersion: 1
      })
    ).toMatchObject({
      withdrawalRequired: true,
      withdrawalTarget: { shareGrantId: grantId, grantVersion: 1 }
    });
    await freezeSeededGrant(grantId);
    expect(
      await repository.excludeSession(actor, {
        projectId,
        sessionId: source.entry.sessionId,
        expectedPolicyVersion: 1
      })
    ).toMatchObject({ withdrawalRequired: false, withdrawalTarget: null });
  });

  it("settles multiple historical frozen grants and freezes a share-again grant once", async () => {
    const projectId = await createProject();
    const source = await createSource("Repeated share and private");
    const { repository, prepared } = await enable(projectId, [source.entry]);
    const staged = await repository.stageInitialBundle(actor, {
      projectId,
      expectedPolicyVersion: 1,
      personalProjectBindingHash: prepared.personalProjectBindingHash,
      sessionId: source.entry.sessionId,
      mappingRevision: 1,
      candidate: source.candidate
    });
    if (staged.state !== "staged")
      throw new Error("Expected staged policy grant");
    await seedActivatedGrant({
      pendingShareId: staged.pendingShareId,
      projectId,
      policyGrant: true,
      frozen: true
    });
    await seedActivatedGrant({
      pendingShareId: staged.pendingShareId,
      projectId,
      frozen: true
    });
    expect(
      await repository.excludeSession(actor, {
        projectId,
        sessionId: source.entry.sessionId,
        expectedPolicyVersion: 1
      })
    ).toMatchObject({ withdrawalRequired: false, withdrawalTarget: null });
    const shareAgainId = await seedActivatedGrant({
      pendingShareId: staged.pendingShareId,
      projectId
    });
    expect(
      await repository.excludeSession(actor, {
        projectId,
        sessionId: source.entry.sessionId,
        expectedPolicyVersion: 1
      })
    ).toMatchObject({
      withdrawalRequired: true,
      withdrawalTarget: { shareGrantId: shareAgainId, grantVersion: 1 }
    });
    await freezeSeededGrant(shareAgainId);
    expect(
      await repository.excludeSession(actor, {
        projectId,
        sessionId: source.entry.sessionId,
        expectedPolicyVersion: 1
      })
    ).toMatchObject({ withdrawalRequired: false, withdrawalTarget: null });
  });

  it("stages exactly one initial Pending Share from the reviewed source", async () => {
    const projectId = await createProject();
    const source = await createSource("Reviewed biology chat");
    const { repository, prepared, enabled } = await enable(projectId, [
      source.entry
    ]);
    expect(enabled.eligible).toEqual([source.entry]);
    expect((await repository.getStatus(actor, projectId)).eligibleCount).toBe(
      1
    );
    const input = {
      projectId,
      expectedPolicyVersion: 1,
      personalProjectBindingHash: prepared.personalProjectBindingHash,
      sessionId: source.entry.sessionId,
      mappingRevision: 1,
      candidate: source.candidate
    };
    const first = await repository.stageInitialBundle(actor, input);
    expect(first.state).toBe("staged");
    if (first.state !== "staged") throw new Error("Expected staged issue");
    expect(typeof first.pendingShareId).toBe("string");
    expect(await repository.stageInitialBundle(actor, input)).toEqual({
      state: "skipped",
      reason: "already_issued"
    });
    const persisted = await pool.query<{ count: string }>(
      `select count(*)::text as count from pending_share_operations
       where owner_user_id=$1 and logical_memory_id=$2`,
      [teamUserId, source.entry.logicalMemoryId]
    );
    expect(persisted.rows[0]?.count).toBe("1");
  });

  it("stages a signed future capture only for the exact active Project and key", async () => {
    const projectId = await createProject();
    const { repository, enabled } = await enable(projectId, []);
    const source = await createSource("Later physics chat");
    const issuedAt = new Date();
    const proof = signProjectSharePolicyProof(
      {
        protocol: "koed_project_share_policy_future_proof",
        version: 1,
        type: "future_summary",
        policyId: enabled.policyId,
        policyVersion: 1,
        backendId,
        workspaceProjectId: projectId,
        personalOwnerUserId,
        ownerUserId: teamUserId,
        ownerTeamMemberId: memberId,
        deviceCredentialId,
        personalProjectBindingHash: bindingHash,
        sessionId: source.entry.sessionId,
        logicalMemoryId: source.entry.logicalMemoryId,
        sourceRevision: 1,
        mappingRevision: 1,
        capturePolicyVersion: 1,
        captureWorkspaceProjectId: projectId,
        captureContextVersion: 1,
        captureAt: new Date(issuedAt.getTime() - 1_000).toISOString(),
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 4 * 60_000).toISOString(),
        nonce: randomUUID(),
        candidateHash: source.candidate.candidateHash,
        closureHash: hash(
          JSON.stringify({
            manifest: source.candidate.manifest,
            byteCount: source.candidate.byteCount,
            itemCount: source.candidate.itemCount,
            excludedItemCount: source.candidate.excludedItemCount
          })
        )
      },
      keys.privateKeyDerBase64
    );
    const input = {
      projectId,
      expectedPolicyVersion: 1,
      personalProjectBindingHash: bindingHash,
      sessionId: source.entry.sessionId,
      mappingRevision: 1,
      candidate: source.candidate,
      proof
    };
    await expect(
      repository.stageInitialBundle(actor, {
        ...input,
        proof: { ...proof, payload: { ...proof.payload, mappingRevision: 2 } }
      })
    ).rejects.toBeInstanceOf(ProjectSharePolicyConflictError);
    const staged = await repository.stageInitialBundle(actor, input);
    expect(staged.state).toBe("staged");
    if (staged.state !== "staged") throw new Error("Expected staged issue");
    expect(typeof staged.pendingShareId).toBe("string");
    expect(await repository.stageInitialBundle(actor, input)).toEqual({
      state: "skipped",
      reason: "already_issued"
    });
  });

  it("honors an absent-policy private exclusion before enable and never issues that source", async () => {
    const projectId = await createProject();
    const source = await createSource("Private chemistry chat");
    const repository = createProjectSharePolicyRepository(pool);
    expect(
      await repository.excludeSession(actor, {
        projectId,
        sessionId: source.entry.sessionId,
        expectedPolicyVersion: 0
      })
    ).toMatchObject({ blocked: true, withdrawalRequired: false });
    const { prepared, enabled } = await enable(projectId, [source.entry]);
    expect(enabled.eligible).toEqual([]);
    expect(
      (await repository.getStatus(actor, projectId)).reviewSources
    ).toEqual([
      {
        sessionId: source.entry.sessionId,
        reviewLabel: source.entry.reviewLabel,
        eligible: false
      }
    ]);
    await expect(
      repository.stageInitialBundle(actor, {
        projectId,
        expectedPolicyVersion: 1,
        personalProjectBindingHash: prepared.personalProjectBindingHash,
        sessionId: source.entry.sessionId,
        mappingRevision: 1,
        candidate: source.candidate
      })
    ).rejects.toBeInstanceOf(ProjectSharePolicyConflictError);
  });

  it("fences an initial issue if privacy wins after enable but before staging", async () => {
    const projectId = await createProject();
    const source = await createSource("Private after approval");
    const { repository, prepared, enabled } = await enable(projectId, [
      source.entry
    ]);
    expect(enabled.eligible).toEqual([source.entry]);
    expect(
      await repository.excludeSession(actor, {
        projectId,
        sessionId: source.entry.sessionId,
        expectedPolicyVersion: 1
      })
    ).toMatchObject({ blocked: true, withdrawalRequired: false });
    expect(
      await repository.stageInitialBundle(actor, {
        projectId,
        expectedPolicyVersion: 1,
        personalProjectBindingHash: prepared.personalProjectBindingHash,
        sessionId: source.entry.sessionId,
        mappingRevision: 1,
        candidate: source.candidate
      })
    ).toEqual({ state: "skipped", reason: "occupied" });
    const issued = await pool.query<{ count: string }>(
      `select count(*)::text as count from workspace_project_share_policy_issues
       where session_id=$1`,
      [source.entry.sessionId]
    );
    expect(issued.rows[0]?.count).toBe("0");
  });

  it("requires an acknowledged no-issue fence before HQ107 moves an unshared chat", async () => {
    const sourceProjectId = randomUUID();
    const targetProjectId = randomUUID();
    const sessionId = randomUUID();
    const canceledSessionId = randomUUID();
    const reviewedCancelSessionId = randomUUID();
    await pool.query("insert into users(id,email) values($1,$2)", [
      personalOwnerUserId,
      `${personalOwnerUserId}@test.invalid`
    ]);
    await pool.query(
      `insert into projects(id,owner_user_id,name,key,team_backend_id,
         team_workspace_id,workspace_project_id)
       values($1,$3,'Linked source',$4,$5,$6,$7),
             ($2,$3,'Private destination',$8,null,null,null)`,
      [
        sourceProjectId,
        targetProjectId,
        personalOwnerUserId,
        `linked-${sourceProjectId}`,
        backendId,
        workspaceId,
        randomUUID(),
        `private-${targetProjectId}`
      ]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,
         visibility,automatic_personal_project_id)
       values($1,$4,'codex-cli','api','personal',$5),
             ($2,$4,'codex-cli','api','personal',$5),
             ($3,$4,'codex-cli','api','personal',$5)`,
      [
        sessionId,
        canceledSessionId,
        reviewedCancelSessionId,
        personalOwnerUserId,
        sourceProjectId
      ]
    );
    const policy = createPersonalProjectSharePolicyRepository(pool);
    const moves = createChatMoveRepository(pool);
    const projectLink = await pool.query<{ workspace_project_id: string }>(
      "select workspace_project_id from projects where id=$1",
      [sourceProjectId]
    );
    const scope = {
      ownerUserId: personalOwnerUserId,
      projectId: sourceProjectId,
      teamBackendId: backendId,
      workspaceProjectId: projectLink.rows[0]!.workspace_project_id
    };
    await expect(
      moves.prepare(
        personalOwnerUserId,
        sessionId,
        sourceProjectId,
        targetProjectId
      )
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    const fence = await policy.beginMoveFence({ ...scope, sessionId });
    await expect(
      moves.prepare(
        personalOwnerUserId,
        sessionId,
        sourceProjectId,
        targetProjectId
      )
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    await policy.acknowledgeMoveFence({ ...scope, sessionId, ...fence });
    expect(await policy.currentMoveFence({ ...scope, sessionId })).toEqual({
      state: "acknowledged",
      fenceId: fence.fenceId,
      mappingRevision: fence.mappingRevision
    });
    const move = await moves.prepare(
      personalOwnerUserId,
      sessionId,
      sourceProjectId,
      targetProjectId
    );
    expect(move?.bindings).toEqual([]);
    expect(
      await moves.complete(personalOwnerUserId, sessionId, move!.batchId)
    ).toBe(targetProjectId);

    const canceledFence = await policy.beginMoveFence({
      ...scope,
      sessionId: canceledSessionId
    });
    await policy.acknowledgeMoveFence({
      ...scope,
      sessionId: canceledSessionId,
      ...canceledFence
    });
    await policy.releaseMoveFence({
      ...scope,
      sessionId: canceledSessionId,
      fenceId: canceledFence.fenceId
    });
    expect(
      await policy.currentMoveFence({
        ...scope,
        sessionId: canceledSessionId
      })
    ).toEqual({ state: "none" });
    await expect(
      moves.prepare(
        personalOwnerUserId,
        canceledSessionId,
        sourceProjectId,
        targetProjectId
      )
    ).rejects.toBeInstanceOf(ChatMoveConflictError);

    // A reviewed HQ107 move can be canceled before any grant freeze is
    // dispatched. Its exact terminal cancellation permits local hold release.
    await pool.query(
      `insert into project_policy_session_grants
       (owner_user_id,session_id,project_id,backend_id,logical_memory_id,
        team_id,team_workspace_id,share_grant_id,policy_generation,
        mapping_version,grant_version)
       values($1,$2,$3,$4,$5,$6,$7,$8,1,1,1)`,
      [
        personalOwnerUserId,
        reviewedCancelSessionId,
        sourceProjectId,
        backendId,
        randomUUID(),
        teamId,
        workspaceId,
        randomUUID()
      ]
    );
    const reviewedFence = await policy.beginMoveFence({
      ...scope,
      sessionId: reviewedCancelSessionId
    });
    await policy.acknowledgeMoveFence({
      ...scope,
      sessionId: reviewedCancelSessionId,
      ...reviewedFence
    });
    const reviewedMove = await moves.prepare(
      personalOwnerUserId,
      reviewedCancelSessionId,
      sourceProjectId,
      targetProjectId
    );
    expect(reviewedMove?.bindings).toHaveLength(1);
    await moves.cancel(
      personalOwnerUserId,
      reviewedCancelSessionId,
      reviewedMove!.batchId
    );
    await policy.releaseMoveFence({
      ...scope,
      sessionId: reviewedCancelSessionId,
      fenceId: reviewedFence.fenceId
    });
    expect(
      await policy.currentMoveFence({
        ...scope,
        sessionId: reviewedCancelSessionId
      })
    ).toEqual({ state: "none" });
  });
});
