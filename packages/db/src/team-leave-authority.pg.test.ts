import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  teamLeaveFinishedProofSchema,
  highRiskActionGrantCanonicalHash,
  highRiskActionGrantCommitment,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "@koed/shared";
import { createDb } from "./connection.js";
import { createHighRiskActionRepository } from "./high-risk-action-repository.js";
import { createTeamAccessRepository } from "./team-access-repository.js";
import { runDbMigrations } from "./migrate.js";

const testUrl = process.env.KOED_HQ704_TEST_DATABASE_URL;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
describe.skipIf(!testUrl)("HQ704 exact Team departure authority", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  const database = `hq704_authority_${randomUUID().replaceAll("-", "")}`;
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64")
  );
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    await admin.query(`create database "${database}"`);
    const child = new URL(testUrl!);
    child.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: child.toString() });
    await runDbMigrations(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database "${database}" with (force)`);
      await admin.end();
    }
  });
  const fixture = async (secondOwner = true) => {
    const owner = randomUUID(),
      other = randomUUID(),
      team = randomUUID();
    const member = randomUUID(),
      otherMember = randomUUID(),
      workspace = randomUUID();
    const project = randomUUID(),
      device = randomUUID(),
      session = randomUUID();
    const backend = `backend-${randomUUID()}`;
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    await pool.query(
      "insert into teams(id,name) values($1,'Exact departure')",
      [team]
    );
    await pool.query(
      `insert into team_memberships(id,team_id,user_id,role) values
       ($1,$3,$4,'owner'),($2,$3,$5,$6)`,
      [
        member,
        otherMember,
        team,
        owner,
        other,
        secondOwner ? "owner" : "member"
      ]
    );
    await pool.query(
      "insert into team_workspaces(id,team_id,name) values($1,$2,'Project Workspace')",
      [workspace, team]
    );
    await pool.query(
      `insert into team_workspace_access_grants
       (team_workspace_id,team_id,user_id,access,can_share_owned_memory)
       values($1,$2,$3,'write',true)`,
      [workspace, team, owner]
    );
    await pool.query(
      `insert into workspace_projects
       (id,team_id,workspace_id,owner_team_member_id,name,key,share_attempt_key)
       values($1,$2,$3,$4,'Owner Project','OWN',$5)`,
      [project, team, workspace, member, randomUUID()]
    );
    await pool.query(
      `insert into workspace_project_members(workspace_project_id,team_member_id,access)
       values($1,$2,'write')`,
      [project, member]
    );
    await pool.query(
      `insert into device_credentials
       (id,owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
        verifier_kind,verifier_hash,operation_families)
       values($1,$2,$3,$4,$5,'secret_hash',$6,array['team_workspace_read','action_grant'])`,
      [device, owner, randomUUID(), backend, randomUUID(), hash(randomUUID())]
    );
    await pool.query(
      `insert into user_sessions(id,user_id,session_hash,expires_at)
       values($1,$2,$3,now()+interval '1 hour')`,
      [session, owner, hash(randomUUID())]
    );
    const highRisk = createHighRiskActionRepository(createDb(pool), {
      pool,
      envelopeEncryptionProvider: provider,
      teamEnvelopeEncryptionProvider: provider,
      ownerPrivateReplicaEnvelopeEncryptionProvider: provider
    });
    const teamRepo = createTeamAccessRepository(pool);
    const review = await teamRepo.getTeamLeaveReview({ userId: owner }, team);
    expect(review?.ownedWorkspaceProjects).toEqual([
      { id: project, version: 1 }
    ]);
    return {
      owner,
      team,
      member,
      otherMember,
      project,
      device,
      session,
      backend,
      highRisk,
      teamRepo,
      review: review!
    };
  };
  const approveAndPrepare = async (
    f: Awaited<ReturnType<typeof fixture>>,
    reviewedProjects = f.review.ownedWorkspaceProjects
  ) => {
    const body = {
      expectedVersion: f.review.membership.version,
      expectedTeamVersion: f.review.team.version,
      expectedOwnedWorkspaceProjects: reviewedProjects,
      copyManifestHash: hash("exact-copy-" + randomUUID())
    };
    const request = { method: "POST", path: `/v1/teams/${f.team}/leave`, body };
    const binding = {
      ownerUserId: f.owner,
      deviceCredentialId: f.device,
      upstreamBackendId: f.backend,
      teamId: f.team,
      operationFamily: "admin",
      action: "team.leave",
      targetId: f.team,
      scopeHash: highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
        {
          operationFamily: "admin",
          action: "team.leave",
          teamId: f.team,
          targetId: f.team
        }
      ),
      requestHash: highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
        request
      )
    };
    const secret = `hrg_${randomUUID().replaceAll("-", "")}`;
    const requestId = randomUUID();
    const issued = await f.highRisk.createActionGrant({
      ...binding,
      clientRequestId: requestId,
      credentialOperationFamily: "action_grant",
      approvalTier: "step_up",
      grantCommitment: highRiskActionGrantCommitment(secret),
      review: {
        version: 1,
        title: "Leave Team",
        description: "Exact owned Project set",
        consequence: "Project collaboration closes",
        confirmLabel: "Leave",
        details: []
      }
    });
    expect(issued?.state).toBe("pending");
    await f.highRisk.decideBrowserActivation({
      selector: issued!.selector,
      ownerUserId: f.owner,
      userSessionId: f.session,
      freshlyAuthenticatedAt: new Date(),
      decision: "approve"
    });
    const run = () =>
      f.highRisk.executeActionGrant({
        ...binding,
        actionGrant: secret,
        approvedRequest: request,
        execute: async ({ team }, grant) => {
          const operation = await team.prepareTeamLeave(
            { userId: f.owner },
            {
              ...body,
              teamId: f.team,
              grant: { ...grant, backendOriginHash: hash("deployment") }
            }
          );
          return operation ? { statusCode: 200, body: { operation } } : null;
        }
      });
    return { run, body, requestId };
  };
  it("rejects last Team owner and stale owned set before any departure copy", async () => {
    const last = await fixture(false);
    const denied = await approveAndPrepare(last);
    await expect(denied.run()).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(
      (
        await pool.query(
          "select 1 from team_leave_operations where team_id=$1",
          [last.team]
        )
      ).rowCount
    ).toBe(0);
    const stale = await fixture();
    const wrong = await approveAndPrepare(stale, [
      { id: stale.project, version: 2 }
    ]);
    await expect(wrong.run()).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(
      (
        await pool.query(
          "select 1 from team_leave_operations where team_id=$1",
          [stale.team]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (
        await pool.query<{ status: string }>(
          "select status from team_memberships where id=$1",
          [stale.member]
        )
      ).rows[0]?.status
    ).toBe("enabled");
  });
  it("consumes one exact Step-up, preserves Team state until finish, and recovers the finished receipt read-only", async () => {
    const f = await fixture();
    const approved = await approveAndPrepare(f);
    const first = await approved.run();
    expect(first?.replayed).toBe(false);
    const prepared = first?.body.operation;
    expect(prepared?.state).toBe("prepared");
    expect(
      (
        await pool.query<{ status: string }>(
          "select status from team_memberships where id=$1",
          [f.member]
        )
      ).rows[0]?.status
    ).toBe("enabled");
    const replay = await approved.run();
    expect(replay?.replayed).toBe(true);
    expect(replay?.body.operation).toEqual(prepared);
    const scope = {
      teamId: f.team,
      operationId: prepared!.operationId,
      continuation: prepared!.continuation,
      deviceCredentialId: f.device,
      upstreamBackendId: f.backend,
      backendOriginHash: hash("deployment")
    };
    expect(
      (await f.teamRepo.teamLeaveOperationStatus({ userId: f.owner }, scope))
        ?.state
    ).toBe("prepared");
    const recovery = {
      teamId: f.team,
      ownerUserId: f.owner,
      deviceCredentialId: f.device,
      upstreamBackendId: f.backend,
      backendOriginHash: hash("deployment")
    };
    expect(
      await f.highRisk.recoverTeamLeaveOperations({
        ...recovery,
        operationIds: [],
        includePrepared: true
      })
    ).toMatchObject([
      {
        operationId: prepared!.operationId,
        continuation: prepared!.continuation,
        state: "prepared"
      }
    ]);
    expect(
      await f.highRisk.recoverTeamLeaveOperations({
        ...recovery,
        deviceCredentialId: randomUUID(),
        operationIds: [],
        includePrepared: true
      })
    ).toEqual([]);
    expect(
      await f.highRisk.recoverTeamLeaveOperations({
        ...recovery,
        backendOriginHash: hash("another deployment"),
        operationIds: [],
        includePrepared: true
      })
    ).toEqual([]);
    const finished = await f.highRisk.finishPreparedTeamLeave({
      ...scope,
      ownerUserId: f.owner,
      copyManifestHash: approved.body.copyManifestHash
    });
    expect(finished?.membership?.status).toBe("disabled");
    expect(
      await f.highRisk.finishPreparedTeamLeave({
        ...scope,
        ownerUserId: f.owner,
        copyManifestHash: approved.body.copyManifestHash
      })
    ).toBeNull();
    expect(
      await f.teamRepo.teamLeaveOperationStatus({ userId: f.owner }, scope)
    ).toMatchObject({
      state: "finished",
      finalMembership: { id: f.member, status: "disabled" }
    });
    expect(
      (
        await pool.query<{ lifecycle: string }>(
          "select lifecycle from workspace_projects where id=$1",
          [f.project]
        )
      ).rows[0]?.lifecycle
    ).toBe("deleted");
    const textProof = {
      ownerUserId: f.owner,
      upstreamBackendId: f.backend,
      backendOriginHash: hash("deployment"),
      teamId: f.team,
      targetId: f.team,
      action: "team.leave" as const,
      effectKey: approved.requestId,
      expectedMembershipVersion: approved.body.expectedVersion,
      expectedTeamVersion: approved.body.expectedTeamVersion
    };
    expect(await f.highRisk.textActionLifecycleProof(textProof)).toBe(true);
    expect(
      await f.highRisk.textActionLifecycleProof({
        ...textProof,
        effectKey: randomUUID()
      })
    ).toBe(false);
    expect(
      await f.highRisk.textActionLifecycleProof({
        ...textProof,
        ownerUserId: randomUUID()
      })
    ).toBe(false);
    expect(
      await f.highRisk.textActionLifecycleProof({
        ...textProof,
        backendOriginHash: hash("wrong")
      })
    ).toBe(false);
    expect(
      await f.highRisk.textActionLifecycleProof({
        ...textProof,
        expectedTeamVersion: 2
      })
    ).toBe(false);
    expect(
      await f.highRisk.recoverTeamLeaveOperations({
        ...recovery,
        operationIds: [prepared!.operationId],
        includePrepared: false
      })
    ).toMatchObject([
      {
        operationId: prepared!.operationId,
        state: "finished",
        finalMembership: { id: f.member, status: "disabled" }
      }
    ]);
    await pool.query(
      "update device_credentials set revoked_at=now() where id=$1",
      [f.device]
    );
    expect(await f.highRisk.textActionLifecycleProof(textProof)).toBe(true);
    expect(
      await f.highRisk.recoverTeamLeaveOperations({
        ...recovery,
        operationIds: [prepared!.operationId],
        includePrepared: false
      })
    ).toEqual([]);
    expect(
      teamLeaveFinishedProofSchema.parse(
        await f.highRisk.finishedTeamLeaveProof({
          teamId: f.team,
          operationId: prepared!.operationId,
          ownerUserId: f.owner,
          upstreamBackendId: f.backend,
          backendOriginHash: hash("deployment")
        })
      )
    ).toMatchObject({
      state: "finished",
      operationId: prepared!.operationId,
      finalMembership: { id: f.member, status: "disabled" }
    });
    expect(
      await f.highRisk.finishedTeamLeaveProof({
        teamId: f.team,
        operationId: prepared!.operationId,
        ownerUserId: randomUUID(),
        upstreamBackendId: f.backend,
        backendOriginHash: hash("deployment")
      })
    ).toBeNull();
    expect(
      await f.highRisk.finishedTeamLeaveProof({
        teamId: f.team,
        operationId: prepared!.operationId,
        ownerUserId: f.owner,
        upstreamBackendId: f.backend,
        backendOriginHash: hash("another deployment")
      })
    ).toBeNull();
  });
  it("invalidates a prepared approval on Project drift and denies changed device generation", async () => {
    const changed = await fixture();
    const first = await (await approveAndPrepare(changed)).run();
    const op = first!.body.operation;
    expect(
      await changed.highRisk.finishedTeamLeaveProof({
        teamId: changed.team,
        operationId: op.operationId,
        ownerUserId: changed.owner,
        upstreamBackendId: changed.backend,
        backendOriginHash: hash("deployment")
      })
    ).toBeNull();
    await pool.query(
      "update workspace_projects set name='Changed collaboration' where id=$1",
      [changed.project]
    );
    expect(
      await changed.highRisk.finishPreparedTeamLeave({
        teamId: changed.team,
        operationId: op.operationId,
        continuation: op.continuation,
        ownerUserId: changed.owner,
        deviceCredentialId: changed.device,
        upstreamBackendId: changed.backend,
        backendOriginHash: hash("deployment"),
        copyManifestHash: op.copyManifestHash
      })
    ).toBeNull();
    const rotated = await fixture();
    const second = await (await approveAndPrepare(rotated)).run();
    const rotatedOp = second!.body.operation;
    await pool.query(
      "update device_credentials set credential_version=credential_version+1 where id=$1",
      [rotated.device]
    );
    expect(
      await rotated.highRisk.finishPreparedTeamLeave({
        teamId: rotated.team,
        operationId: rotatedOp.operationId,
        continuation: rotatedOp.continuation,
        ownerUserId: rotated.owner,
        deviceCredentialId: rotated.device,
        upstreamBackendId: rotated.backend,
        backendOriginHash: hash("deployment"),
        copyManifestHash: rotatedOp.copyManifestHash
      })
    ).toBeNull();
    expect(
      (
        await pool.query<{ status: string }>(
          "select status from team_memberships where id=$1",
          [rotated.member]
        )
      ).rows[0]?.status
    ).toBe("enabled");
  });
  it("proves ordinary no-owned Team leave from its exact Native approval and receipt", async () => {
    const f = await fixture();
    await pool.query(
      "update workspace_projects set owner_team_member_id=$1 where id=$2",
      [f.otherMember, f.project]
    );
    const review = await f.teamRepo.getTeamLeaveReview(
      { userId: f.owner },
      f.team
    );
    expect(review?.ownedWorkspaceProjects).toEqual([]);
    const body = {
      expectedVersion: review!.membership.version,
      expectedTeamVersion: review!.team.version,
      expectedOwnedWorkspaceProjects: []
    };
    const request = { method: "POST", path: `/v1/teams/${f.team}/leave`, body };
    const binding = {
      ownerUserId: f.owner,
      deviceCredentialId: f.device,
      upstreamBackendId: f.backend,
      teamId: f.team,
      operationFamily: "admin",
      action: "team.leave",
      targetId: f.team,
      scopeHash: highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
        {
          operationFamily: "admin",
          action: "team.leave",
          teamId: f.team,
          targetId: f.team
        }
      ),
      requestHash: highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
        request
      )
    };
    const secret = `hrg_${randomUUID().replaceAll("-", "")}`,
      requestId = randomUUID();
    expect(
      (
        await f.highRisk.createActionGrant({
          ...binding,
          clientRequestId: requestId,
          credentialOperationFamily: "action_grant",
          approvalTier: "native_review",
          grantCommitment: highRiskActionGrantCommitment(secret),
          review: {
            version: 1,
            title: "Leave Team",
            description: "No owned Projects",
            consequence: "Access closes",
            confirmLabel: "Leave",
            details: []
          }
        })
      )?.state
    ).toBe("pending");
    expect(
      (
        await f.highRisk.decideNativeActionReview({
          ...binding,
          clientRequestId: requestId,
          decision: "approve"
        })
      )?.state
    ).toBe("approved");
    expect(
      (
        await f.highRisk.executeActionGrant({
          ...binding,
          actionGrant: secret,
          approvedRequest: request,
          execute: async ({ team }) => {
            const membership = await team.leaveTeam(
              { userId: f.owner },
              { teamId: f.team, ...body }
            );
            return membership
              ? { statusCode: 200, body: { membership } }
              : null;
          }
        })
      )?.body.membership.status
    ).toBe("disabled");
    const proof = {
      ownerUserId: f.owner,
      upstreamBackendId: f.backend,
      backendOriginHash: hash("deployment"),
      teamId: f.team,
      targetId: f.team,
      action: "team.leave" as const,
      effectKey: requestId,
      expectedMembershipVersion: body.expectedVersion,
      expectedTeamVersion: body.expectedTeamVersion
    };
    expect(await f.highRisk.textActionLifecycleProof(proof)).toBe(true);
    expect(
      await f.highRisk.textActionLifecycleProof({
        ...proof,
        effectKey: randomUUID()
      })
    ).toBe(false);
    expect(
      await f.highRisk.textActionLifecycleProof({
        ...proof,
        targetId: randomUUID()
      })
    ).toBe(false);
    expect(
      await f.highRisk.textActionLifecycleProof({
        ...proof,
        expectedMembershipVersion: 2
      })
    ).toBe(false);
    expect(
      await f.highRisk.textActionLifecycleProof({
        ...proof,
        action: "workspace_project.leave"
      })
    ).toBe(false);
  });
});
