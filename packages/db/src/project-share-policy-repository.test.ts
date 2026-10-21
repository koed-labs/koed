import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import {
  createProjectSharePolicyRepository,
  ProjectSharePolicyConflictError
} from "./project-share-policy-repository.js";
import { runDbMigrations } from "./migrate.js";
import {
  createPersonalProjectSharePolicyRepository,
  PersonalProjectSharePolicyConflictError
} from "./personal-project-share-policy-repository.js";

describe("Project share policy exact manifest binding", () => {
  const signingPublicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
  it("rejects revision zero rather than treating a later revision one as a match", async () => {
    const repository = createProjectSharePolicyRepository({} as pg.Pool);
    await expect(
      repository.prepareInitialManifest(
        {
          userId: randomUUID(),
          deviceCredentialId: randomUUID(),
          upstreamBackendId: "fixture"
        },
        {
          projectId: randomUUID(),
          expectedPolicyVersion: 0,
          personalProjectBindingHash: "a".repeat(64),
          signingPublicKey,
          entries: [
            {
              sessionId: randomUUID(),
              logicalMemoryId: randomUUID(),
              sourceRevision: 0,
              mappingRevision: 1,
              reviewLabel: "Fixture"
            }
          ]
        }
      )
    ).rejects.toBeInstanceOf(ProjectSharePolicyConflictError);
  });
});

const testUrl = process.env.KOED_HQ702_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("durable member Project share policy", () => {
  const signingPublicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const userId = randomUUID();
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const memberId = randomUUID();
  const deviceCredentialId = randomUUID();
  const actor = {
    userId,
    deviceCredentialId,
    upstreamBackendId: "test-backend"
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq702_policy_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${database}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query(`insert into users(id,email) values($1,$2)`, [
      userId,
      `${userId}@test.invalid`
    ]);
    await pool.query(`insert into teams(id,name) values($1,'Policy team')`, [
      teamId
    ]);
    await pool.query(
      `insert into team_memberships(id,team_id,user_id,role,status,accepted_at)
       values($1,$2,$3,'member','enabled',now())`,
      [memberId, teamId, userId]
    );
    await pool.query(
      `insert into team_workspaces(id,team_id,name) values($1,$2,'Policy workspace')`,
      [workspaceId, teamId]
    );
    await pool.query(
      `insert into team_workspace_access_grants
       (team_workspace_id,team_id,user_id,access,can_share_owned_memory)
       values($1,$2,$3,'write',true)`,
      [workspaceId, teamId, userId]
    );
    await pool.query(
      `insert into workspace_projects(id,team_id,workspace_id,owner_team_member_id,name,key,share_attempt_key)
       values($1,$2,$3,$4,'Policy project','POLICY','policy-test')`,
      [projectId, teamId, workspaceId, memberId]
    );
    await pool.query(
      `insert into workspace_project_members(workspace_project_id,team_member_id,access)
       values($1,$2,'write')`,
      [projectId, memberId]
    );
    await pool.query(
      `insert into device_credentials
       (id,owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
        verifier_kind,verifier_hash,operation_families)
       values($1,$2,$3,$4,'policy-fixture','secret_hash',$5,ARRAY['share_grant_management']::text[])`,
      [
        deviceCredentialId,
        userId,
        `hq702-${randomUUID()}`,
        actor.upstreamBackendId,
        "a".repeat(64)
      ]
    );
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database "${database}" with (force)`);
    await admin?.end();
  });

  it("binds one owner policy to exact Native manifest and stops issuance after revocation", async () => {
    const repo = createProjectSharePolicyRepository(pool);
    const privateBeforeEnable = randomUUID();
    expect(
      await repo.excludeSession(actor, {
        projectId,
        sessionId: privateBeforeEnable,
        expectedPolicyVersion: 0
      })
    ).toMatchObject({ blocked: true, withdrawalRequired: false });
    expect(
      (
        await pool.query(
          `select 1 from workspace_project_share_policy_exclusions
        where workspace_project_id=$1 and source_owner_team_member_id=$2 and session_id=$3`,
          [projectId, memberId, privateBeforeEnable]
        )
      ).rowCount
    ).toBe(1);
    const manifest = await repo.prepareInitialManifest(actor, {
      projectId,
      expectedPolicyVersion: 0,
      personalProjectBindingHash: "b".repeat(64),
      entries: [],
      signingPublicKey
    });
    expect(
      await repo.getReview(actor, {
        projectId,
        expectedPolicyVersion: 0,
        manifestId: manifest.manifestId,
        manifestHash: manifest.manifestHash
      })
    ).toMatchObject({ status: "absent", eligibleCount: 0 });
    await expect(
      repo.enable(actor, {
        projectId,
        expectedPolicyVersion: 0,
        manifestId: manifest.manifestId,
        manifestHash: "c".repeat(64),
        currentEntries: [],
        signingPublicKey
      })
    ).rejects.toBeInstanceOf(ProjectSharePolicyConflictError);
    expect(
      await repo.enable(actor, {
        projectId,
        expectedPolicyVersion: 0,
        manifestId: manifest.manifestId,
        manifestHash: manifest.manifestHash,
        currentEntries: [],
        signingPublicKey
      })
    ).toMatchObject({ version: 1, eligible: [] });
    await expect(
      repo.enable(actor, {
        projectId,
        expectedPolicyVersion: 0,
        manifestId: manifest.manifestId,
        manifestHash: manifest.manifestHash,
        currentEntries: [],
        signingPublicKey
      })
    ).rejects.toBeInstanceOf(ProjectSharePolicyConflictError);
    expect(
      await repo.revoke(actor, { projectId, expectedPolicyVersion: 1 })
    ).toMatchObject({ version: 2 });
    await expect(
      repo.prepareInitialManifest(actor, {
        projectId,
        expectedPolicyVersion: 1,
        personalProjectBindingHash: "b".repeat(64),
        entries: [],
        signingPublicKey
      })
    ).rejects.toBeInstanceOf(ProjectSharePolicyConflictError);
    await pool.query(
      `update team_workspace_access_grants set can_share_owned_memory=false where team_workspace_id=$1 and user_id=$2`,
      [workspaceId, userId]
    );
    await expect(
      repo.prepareInitialManifest(actor, {
        projectId,
        expectedPolicyVersion: 2,
        personalProjectBindingHash: "b".repeat(64),
        entries: [],
        signingPublicKey
      })
    ).rejects.toThrow("authority unavailable");
  });

  it("keeps old sealed attempts but only blocks the exact current Team principal and device", async () => {
    const personalProjectId = randomUUID();
    const oldWorkspaceProjectId = randomUUID();
    const currentPrincipalId = randomUUID();
    const currentDeviceId = randomUUID();
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const personal = createPersonalProjectSharePolicyRepository(pool, provider);
    await pool.query(
      `insert into projects(id,owner_user_id,name,key,team_backend_id,workspace_project_id)
       values($1,$2,'Policy attempts','policy-attempts','test-backend',$3)`,
      [personalProjectId, userId, projectId]
    );
    for (let index = 0; index < 12; index++) {
      const requestId = randomUUID();
      const grantId = randomUUID();
      const sealed = await provider.encrypt({
        plaintext: JSON.stringify({
          teamId,
          teamPrincipalUserId: currentPrincipalId,
          deviceCredentialId: currentDeviceId,
          expectedPolicyVersion: 0
        }),
        scope: {
          projectId: personalProjectId,
          objectClass: "project_share_policy_attempt"
        },
        provenance: {
          rowFamily: "project_share_policy_attempts",
          sourceId: requestId
        },
        ciphertextLocation: `project_share_policy_attempts:${requestId}`,
        aad: {
          ownerUserId: userId,
          projectId: personalProjectId,
          teamBackendId: "old-backend",
          workspaceProjectId: oldWorkspaceProjectId,
          action: "enable",
          clientRequestId: requestId,
          actionGrantId: grantId,
          payloadHash: "a".repeat(64)
        }
      });
      await pool.query(
        `insert into project_share_policy_attempts
         (owner_user_id,project_id,backend_id,workspace_project_id,action,
          client_request_id,action_grant_id,payload_hash,sealed_binding)
         values($1,$2,'old-backend',$3,'enable',$4,$5,$6,$7::jsonb)`,
        [
          userId,
          personalProjectId,
          oldWorkspaceProjectId,
          requestId,
          grantId,
          "a".repeat(64),
          JSON.stringify(sealed)
        ]
      );
    }
    const current = {
      ownerUserId: userId,
      projectId: personalProjectId,
      teamBackendId: "test-backend",
      workspaceProjectId: projectId,
      teamId,
      teamPrincipalUserId: currentPrincipalId,
      deviceCredentialId: currentDeviceId
    };
    expect(
      await personal.pendingAttempts({ ...current, currentScope: current })
    ).toEqual([]);
    const requestId = randomUUID();
    await personal.beginAttempt({
      ...current,
      action: "revoke",
      clientRequestId: requestId,
      actionGrantId: randomUUID(),
      payloadHash: "b".repeat(64),
      expectedPolicyVersion: 1
    });
    expect(
      (
        await personal.pendingAttempts({ ...current, currentScope: current })
      ).map((attempt) => attempt.clientRequestId)
    ).toEqual([requestId]);
    await expect(
      personal.beginAttempt({
        ...current,
        action: "revoke",
        clientRequestId: randomUUID(),
        actionGrantId: randomUUID(),
        payloadHash: "c".repeat(64),
        expectedPolicyVersion: 1
      })
    ).rejects.toBeInstanceOf(PersonalProjectSharePolicyConflictError);
    const rotatedDeviceId = randomUUID();
    const rotated = { ...current, deviceCredentialId: rotatedDeviceId };
    expect(
      await personal.pendingAttempts({ ...rotated, currentScope: rotated })
    ).toEqual([]);
    const rotatedRequestId = randomUUID();
    await personal.beginAttempt({
      ...rotated,
      action: "revoke",
      clientRequestId: rotatedRequestId,
      actionGrantId: randomUUID(),
      payloadHash: "d".repeat(64),
      expectedPolicyVersion: 1
    });
    expect(
      (
        await personal.pendingAttempts({ ...rotated, currentScope: rotated })
      ).map((attempt) => attempt.clientRequestId)
    ).toEqual([rotatedRequestId]);
    await pool.query(
      `update projects set share_policy_link_epoch=gen_random_uuid() where id=$1`,
      [personalProjectId]
    );
    expect(
      await personal.pendingAttempts({ ...rotated, currentScope: rotated })
    ).toEqual([]);
    const relinkedRequestId = randomUUID();
    await personal.beginAttempt({
      ...rotated,
      action: "revoke",
      clientRequestId: relinkedRequestId,
      actionGrantId: randomUUID(),
      payloadHash: "e".repeat(64),
      expectedPolicyVersion: 1
    });
    expect(
      (
        await personal.pendingAttempts({ ...rotated, currentScope: rotated })
      ).map((attempt) => attempt.clientRequestId)
    ).toEqual([relinkedRequestId]);
  });
});
