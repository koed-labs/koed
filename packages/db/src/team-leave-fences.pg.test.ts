import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";

const testUrl = process.env.KOED_HQ704_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("HQ704 prepared departure mutation fences", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  const database = `hq704_fences_${randomUUID().replaceAll("-", "")}`;
  const leaver = randomUUID(),
    other = randomUUID();
  const team = randomUUID(),
    member = randomUUID(),
    otherMember = randomUUID();
  const ownedWorkspace = randomUUID(),
    otherWorkspace = randomUUID();
  const ownedProject = randomUUID(),
    otherProject = randomUUID();
  const credential = randomUUID();
  const session = randomUUID();
  const otherCredential = randomUUID();
  const otherSession = randomUUID();
  const hash = "a".repeat(64);
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    await admin.query(`create database "${database}"`);
    const child = new URL(testUrl!);
    child.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: child.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      leaver,
      `${leaver}@example.test`,
      other,
      `${other}@example.test`
    ]);
    await pool.query("insert into teams(id,name) values($1,'Departure Team')", [
      team
    ]);
    await pool.query(
      `insert into team_memberships(id,team_id,user_id,role)
       values($1,$3,$4,'owner'),($2,$3,$5,'owner')`,
      [member, otherMember, team, leaver, other]
    );
    await pool.query(
      `insert into team_workspaces(id,team_id,name) values
       ($1,$3,'Owned Workspace'),($2,$3,'Other Workspace')`,
      [ownedWorkspace, otherWorkspace, team]
    );
    await pool.query(
      `insert into workspace_projects(id,team_id,workspace_id,owner_team_member_id,name,key,share_attempt_key)
       values ($1,$3,$4,$6,'Owned','OWN',$8),($2,$3,$5,$7,'Other','OTH',$9)`,
      [
        ownedProject,
        otherProject,
        team,
        ownedWorkspace,
        otherWorkspace,
        member,
        otherMember,
        randomUUID(),
        randomUUID()
      ]
    );
    await pool.query(
      `insert into device_credentials(id,owner_user_id,credential_key_id,upstream_backend_id,
       device_instance_id,verifier_kind,verifier_hash,operation_families)
       values($1,$2,$3,'backend-one',$4,'secret_hash',$5,array['action_grant'])`,
      [credential, leaver, randomUUID(), randomUUID(), hash]
    );
    await pool.query(
      `insert into user_sessions(id,user_id,session_hash,expires_at)
       values($1,$2,$3,now()+interval '1 hour')`,
      [session, leaver, hash]
    );
    await pool.query(
      `insert into device_credentials(id,owner_user_id,credential_key_id,upstream_backend_id,
       device_instance_id,verifier_kind,verifier_hash,operation_families)
       values($1,$2,$3,'backend-two',$4,'secret_hash',$5,array['action_grant'])`,
      [otherCredential, other, randomUUID(), randomUUID(), hash]
    );
    await pool.query(
      `insert into user_sessions(id,user_id,session_hash,expires_at)
       values($1,$2,$3,now()+interval '1 hour')`,
      [otherSession, other, "b".repeat(64)]
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database "${database}" with (force)`);
      await admin.end();
    }
  });
  const prepare = async (
    source = {
      owner: leaver,
      member,
      credential,
      session,
      backend: "backend-one",
      project: ownedProject
    }
  ) => {
    const confirmation = randomUUID(),
      grant = randomUUID(),
      operation = randomUUID();
    await pool.query(
      `insert into high_risk_browser_confirmations
       (id,selector,client_request_id,owner_user_id,device_credential_id,upstream_backend_id,
        team_id,operation_family,action,target_id,scope_hash,request_hash,
        secret_commitment,approval_tier,review_summary,state,expires_at,decided_at,
        decision_user_session_id,decision_freshly_authenticated_at)
       values($1,$2,$3,$4,$5,$10,$6,'admin','team.leave',$6,$7,$7,
              $8,'step_up','{}'::jsonb,'approved',now()+interval '1 hour',now(),$9,now())`,
      [
        confirmation,
        randomUUID(),
        randomUUID(),
        source.owner,
        source.credential,
        team,
        hash,
        `v1:${randomUUID().replaceAll("-", "").padEnd(64, "a")}`,
        source.session,
        source.backend
      ]
    );
    await pool.query(
      `insert into high_risk_device_action_grants
       (id,confirmation_id,device_credential_id,owner_user_id,upstream_backend_id,
        team_id,operation_family,action,target_id,scope_hash,request_hash,
        secret_commitment,state,use_count,expires_at,consumed_at)
       values($1,$2,$3,$4,$8,$5,'admin','team.leave',$5,$6,$6,
              $7,'consumed',1,now()+interval '1 hour',now())`,
      [
        grant,
        confirmation,
        source.credential,
        source.owner,
        team,
        hash,
        `v1:${randomUUID().replaceAll("-", "").padEnd(64, "b")}`,
        source.backend
      ]
    );
    await pool.query(
      `insert into team_leave_operations
       (id,team_id,membership_id,owner_user_id,device_credential_id,
        device_credential_version,upstream_backend_id,backend_origin_hash,action_grant_id,
        continuation_commitment,expected_team_version,expected_membership_version,
        owned_projects,owned_set_hash,copy_manifest_hash)
       values($1,$2,$3,$4,$5,1,$10,$7,$6,$8,1,1,$9::jsonb,$7,$7)`,
      [
        operation,
        team,
        source.member,
        source.owner,
        source.credential,
        grant,
        hash,
        randomUUID().replaceAll("-", "").padEnd(64, "a"),
        JSON.stringify([{ id: source.project, version: 1 }]),
        source.backend
      ]
    );
    return operation;
  };
  const state = async (operation: string) =>
    (
      await pool.query<{ state: string }>(
        "select state from team_leave_operations where id=$1",
        [operation]
      )
    ).rows[0]?.state;
  it("leaves unrelated Workspace writes alone and invalidates the owned Workspace snapshot", async () => {
    const op = await prepare();
    await pool.query(
      "update team_workspaces set name='Other updated' where id=$1",
      [otherWorkspace]
    );
    expect(await state(op)).toBe("prepared");
    await pool.query(
      "update team_workspaces set name='Owned updated' where id=$1",
      [ownedWorkspace]
    );
    expect(await state(op)).toBe("canceled");
  });
  it("lets Team governance disable a member and cancels the pending departure", async () => {
    const op = await prepare();
    await pool.query(
      "update team_memberships set status='disabled',disabled_at=now(),version=version+1 where id=$1",
      [member]
    );
    expect(await state(op)).toBe("canceled");
    expect(
      (
        await pool.query<{ status: string }>(
          "select status from team_memberships where id=$1",
          [member]
        )
      ).rows[0]?.status
    ).toBe("disabled");
    await pool.query(
      "update team_memberships set status='enabled',disabled_at=null,version=version+1 where id=$1",
      [member]
    );
  });
  it("allows different owners to prepare disjoint Project departures concurrently", async () => {
    const first = await prepare();
    const second = await prepare({
      owner: other,
      member: otherMember,
      credential: otherCredential,
      session: otherSession,
      backend: "backend-two",
      project: otherProject
    });
    expect(await state(first)).toBe("prepared");
    expect(await state(second)).toBe("prepared");
  });
});
