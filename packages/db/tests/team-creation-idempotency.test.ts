import { randomUUID } from "node:crypto";
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

import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { createMemorySourceRepository } from "../src/repository.js";
import { createRetentionLifecycleRepository } from "../src/retention-lifecycle-repository.js";

const databaseUrl = process.env.TEAM_CREATION_IDEMPOTENCY_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("request-idempotent atomic Team creation", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query("truncate table users, teams restart identity cascade");
  });

  afterEach(async () => {
    await pool.query("truncate table users, teams restart identity cascade");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns one complete Team for concurrent exact retries", async () => {
    const repository = createMemorySourceRepository(pool);
    const owner = await repository.createUser({
      email: `team-owner-${randomUUID()}@example.test`
    });
    const idempotencyKey = randomUUID();

    const attempts = await Promise.all(
      Array.from({ length: 24 }, () =>
        repository.createTeam(
          { userId: owner.id },
          { name: "Concurrent Team", idempotencyKey }
        )
      )
    );
    expect(new Set(attempts.map((team) => team.id))).toEqual(
      new Set([attempts[0]!.id])
    );

    const state = await pool.query<{
      teams: string;
      memberships: string;
      workspaces: string;
      generalThreads: string;
      teamAudit: string;
      workspaceAudit: string;
      threadAudit: string;
      outbox: string;
      billing: string;
      retentionPolicies: string;
      retentionSeconds: string;
      deletionGraceSeconds: string;
      backupRetentionSeconds: string;
      keyHash: string;
      requestHash: string;
      rendered: string;
    }>(
      `select
         (select count(*) from teams)::text as teams,
         (select count(*) from team_memberships)::text as memberships,
         (select count(*) from team_workspaces)::text as workspaces,
         (select count(*) from collaboration_threads
           where system_key = 'workspace.general')::text as "generalThreads",
         (select count(*) from audit_events
           where action = 'team.created')::text as "teamAudit",
         (select count(*) from audit_events
           where action = 'team.workspace.created')::text as "workspaceAudit",
         (select count(*) from audit_events
           where action = 'team.thread.created')::text as "threadAudit",
         (select count(*) from collaboration_outbox)::text as outbox,
         (select count(*) from team_billing_seat_states)::text as billing,
         (select count(*) from retention_policies
           where scope = 'team' and team_id = teams.id)::text
           as "retentionPolicies",
         (select retention_seconds::text from retention_policies
           where scope = 'team' and team_id = teams.id and version = 1)
           as "retentionSeconds",
         (select deletion_grace_seconds::text from retention_policies
           where scope = 'team' and team_id = teams.id and version = 1)
           as "deletionGraceSeconds",
         (select backup_retention_seconds::text from retention_policies
           where scope = 'team' and team_id = teams.id and version = 1)
           as "backupRetentionSeconds",
         creation_idempotency_key_hash as "keyHash",
         creation_request_hash as "requestHash",
         row_to_json(teams)::text as rendered
       from teams`,
      []
    );
    expect(state.rows[0]).toMatchObject({
      teams: "1",
      memberships: "1",
      workspaces: "1",
      generalThreads: "1",
      teamAudit: "1",
      workspaceAudit: "1",
      threadAudit: "1",
      outbox: "3",
      billing: "1",
      retentionPolicies: "1",
      retentionSeconds: "2592000",
      deletionGraceSeconds: "0",
      backupRetentionSeconds: "2592000"
    });
    expect(state.rows[0]!.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.rows[0]!.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.rows[0]!.rendered).not.toContain(idempotencyKey);
  });

  it("rejects changed input while scoping the same key independently per owner", async () => {
    const repository = createMemorySourceRepository(pool);
    const firstOwner = await repository.createUser({
      email: `first-team-owner-${randomUUID()}@example.test`
    });
    const secondOwner = await repository.createUser({
      email: `second-team-owner-${randomUUID()}@example.test`
    });
    const idempotencyKey = randomUUID();
    const first = await repository.createTeam(
      { userId: firstOwner.id },
      { name: "Original Team", idempotencyKey }
    );

    await expect(
      repository.createTeam(
        { userId: firstOwner.id },
        { name: "Changed Team", idempotencyKey }
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });

    const second = await repository.createTeam(
      { userId: secondOwner.id },
      { name: "Changed Team", idempotencyKey }
    );
    expect(second.id).not.toBe(first.id);
  });

  it("atomically rejects invite acceptance for suspended Teams and disabled Users", async () => {
    const repository = createMemorySourceRepository(pool);
    const owner = await repository.createUser({
      email: `invite-owner-${randomUUID()}@example.test`
    });
    const invitedEmail = `invite-member-${randomUUID()}@example.test`;
    const invited = await repository.createUser({ email: invitedEmail });
    const team = await repository.createTeam(
      { userId: owner.id },
      { name: "Admission Guards" }
    );
    const defaultWorkspace = await repository.getTeamDefaultWorkspace(
      { userId: owner.id },
      team.id
    );
    const tokenHash = `invite-${randomUUID()}-${randomUUID()}`;
    const backendOriginHash = "a".repeat(64);
    const invite = await repository.createTeamInvite(
      { userId: owner.id },
      {
        teamId: team.id,
        defaultTeamWorkspaceId: defaultWorkspace!.id,
        defaultWorkspaceAccess: "read",
        email: invitedEmail,
        role: "member",
        backendOriginHash,
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000)
      }
    );

    await pool.query(
      `update teams
          set lifecycle = 'suspended', suspended_at = now(), version = version + 1
        where id = $1`,
      [team.id]
    );
    await expect(
      repository.acceptTeamInvite({
        tokenHash,
        userId: invited.id,
        expectedVersion: invite!.version,
        expectedBackendOriginHash: backendOriginHash
      })
    ).resolves.toBeNull();

    await pool.query(
      `update teams
          set lifecycle = 'active', suspended_at = null, version = version + 1
        where id = $1`,
      [team.id]
    );
    await pool.query("update users set disabled_at = now() where id = $1", [
      invited.id
    ]);
    await expect(
      repository.acceptTeamInvite({
        tokenHash,
        userId: invited.id,
        expectedVersion: invite!.version,
        expectedBackendOriginHash: backendOriginHash
      })
    ).resolves.toBeNull();

    const state = await pool.query<{
      invite_lifecycle: string;
      memberships: string;
      workspace_access: string;
    }>(
      `select
         (select lifecycle from team_invites where id = $1) as invite_lifecycle,
         (select count(*) from team_memberships
           where team_id = $2 and user_id = $3)::text as memberships,
         (select count(*) from team_workspace_access_grants
           where team_id = $2 and user_id = $3)::text as workspace_access`,
      [invite!.id, team.id, invited.id]
    );
    expect(state.rows[0]).toEqual({
      invite_lifecycle: "pending",
      memberships: "0",
      workspace_access: "0"
    });
  });

  it("denies ordinary Team and Workspace access immediately after the deletion tombstone", async () => {
    const repository = createMemorySourceRepository(pool);
    const retention = createRetentionLifecycleRepository(pool, {
      authorizeHoldActor: async () => true
    });
    const owner = await repository.createUser({
      email: `deletion-owner-${randomUUID()}@example.test`
    });
    const team = await repository.createTeam(
      { userId: owner.id },
      { name: "Immediate Tombstone" }
    );
    const defaultWorkspace = await repository.getTeamDefaultWorkspace(
      { userId: owner.id },
      team.id
    );
    const triggeredAt = new Date(Date.now() + 1_000);

    const deletion = await retention.requestRootTeamDeletion({
      teamId: team.id,
      actorUserId: owner.id,
      expectedVersion: team.version,
      triggeredAt,
      idempotencyKey: `team-delete-${randomUUID()}`
    });

    expect(deletion?.team).toMatchObject({
      lifecycle: "deletion_requested",
      tombstonedAt: triggeredAt,
      deletionRequestedAt: triggeredAt,
      purgeCompletedAt: null
    });
    await expect(repository.listTeams({ userId: owner.id })).resolves.toEqual(
      []
    );
    await expect(
      repository.getTeamMembership({ userId: owner.id }, team.id)
    ).resolves.toBeNull();
    await expect(
      repository.listTeamRoster({ userId: owner.id }, team.id)
    ).resolves.toBeNull();
    await expect(
      repository.listTeamWorkspaces(
        { userId: owner.id },
        { teamId: team.id, includeArchived: true }
      )
    ).resolves.toBeNull();
    await expect(
      repository.getTeamWorkspaceContext(
        { userId: owner.id },
        defaultWorkspace!.id
      )
    ).resolves.toBeNull();

    const retained = await pool.query<{
      team_rows: string;
      workspace_rows: string;
      pending_jobs: string;
      deletion_audits: string;
    }>(
      `select
         (select count(*) from teams where id = $1)::text as team_rows,
         (select count(*) from team_workspaces where team_id = $1)::text
           as workspace_rows,
         (select count(*) from purge_jobs
           where team_id = $1 and state in ('pending', 'blocked'))::text
           as pending_jobs,
         (select count(*) from audit_events
           where action = 'team.deletion_requested' and target_id = $1)::text
           as deletion_audits`,
      [team.id]
    );
    expect(retained.rows[0]).toEqual({
      team_rows: "1",
      workspace_rows: "1",
      pending_jobs: "1",
      deletion_audits: "1"
    });
  });
});
