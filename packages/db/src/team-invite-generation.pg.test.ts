import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createTeamAccessRepository } from "./team-access-repository.js";

const testUrl = process.env.KOED_HQ703_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("HQ-703 generation-bound Team invitations", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  let repo: ReturnType<typeof createTeamAccessRepository>;
  const owner = randomUUID();
  const recipient = randomUUID();
  const team = randomUUID();
  const firstWorkspace = randomUUID();
  const secondWorkspace = randomUUID();
  const origin = "a".repeat(64);
  const ownerActor = { userId: owner };
  const recipientActor = { userId: recipient };
  const invite = (workspace: string, role: "member" | "admin" = "member") =>
    repo.createTeamInvite(ownerActor, {
      teamId: team,
      defaultTeamWorkspaceId: workspace,
      defaultWorkspaceAccess: "read",
      email: `${recipient}@example.test`,
      role,
      backendOriginHash: origin,
      tokenHash: randomUUID().replaceAll("-", "").repeat(2),
      expiresAt: new Date(Date.now() + 86_400_000)
    });
  const review = (id: string, version: number) =>
    repo.getTeamInviteDecisionReview(recipientActor, {
      inviteId: id,
      expectedVersion: version,
      backendOriginHash: origin
    });
  const accept = (binding: NonNullable<Awaited<ReturnType<typeof review>>>) =>
    repo.acceptTeamInvite({
      inviteId: binding.invite.id,
      userId: recipient,
      expectedVersion: binding.invite.version,
      expectedBackendOriginHash: origin,
      expectedMembershipVersion: binding.membershipVersion,
      expectedMembershipStatus: binding.membershipStatus,
      expectedMembershipDisabledReason: binding.membershipDisabledReason,
      expectedLeaveGeneration: binding.leaveGeneration
    });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq703_invite_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    repo = createTeamAccessRepository(pool);
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      recipient,
      `${recipient}@example.test`
    ]);
    await pool.query("insert into teams(id,name) values($1,'Invite Team')", [
      team
    ]);
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,leave_generation)
      values($1,$2,'owner',0)`,
      [team, owner]
    );
    await pool.query(
      "insert into team_workspaces(id,team_id,name) values($1,$3,'First'),($2,$3,'Second')",
      [firstWorkspace, secondWorkspace, team]
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(
        `drop database if exists ${quote(database)} with (force)`
      );
    await admin?.end();
  });

  it("re-reviews first-time different-Workspace invites and invalidates pre-leave issuance", async () => {
    const first = await invite(firstWorkspace);
    const second = await invite(secondWorkspace);
    expect(first).toMatchObject({
      recipientUserId: recipient,
      recipientLeaveGeneration: 0,
      issuanceMembershipVersion: null
    });
    expect(second).toMatchObject({
      recipientUserId: recipient,
      recipientLeaveGeneration: 0,
      issuanceMembershipVersion: null
    });
    const nonmemberInbox = await repo.listMyTeamInvites(recipientActor, origin);
    expect(nonmemberInbox.map((row) => row.id).sort()).toEqual(
      [first!.id, second!.id].sort()
    );
    expect(
      nonmemberInbox.every(
        (row) =>
          row.membershipVersion === null && row.effectiveRole === row.role
      )
    ).toBe(true);
    expect(JSON.stringify(nonmemberInbox)).not.toContain("tokenHash");
    const firstReview = await review(first!.id, first!.version);
    const staleSecondReview = await review(second!.id, second!.version);
    expect(firstReview?.membershipVersion).toBeNull();
    expect(await accept(firstReview!)).not.toBeNull();
    expect(await accept(staleSecondReview!)).toBeNull();
    const freshSecondReview = await review(second!.id, second!.version);
    expect(freshSecondReview?.membershipStatus).toBe("enabled");
    expect(await accept(freshSecondReview!)).not.toBeNull();

    const old = await invite(firstWorkspace);
    expect(old?.recipientLeaveGeneration).toBe(0);
    await pool.query("update users set email=$2 where id=$1", [
      recipient,
      `away-${recipient}@example.test`
    ]);
    expect(await review(old!.id, old!.version)).toBeNull();
    await pool.query("update users set email=$2 where id=$1", [
      recipient,
      `${recipient}@example.test`
    ]);
    expect(await review(old!.id, old!.version)).not.toBeNull();
    const current = await repo.getTeamMembership(recipientActor, team);
    const left = await repo.leaveTeam(recipientActor, {
      teamId: team,
      expectedVersion: current!.version
    });
    expect(left?.leaveGeneration).toBe(1);
    expect(left?.status).toBe("disabled");
    const cleaned = await pool.query<{ lifecycle: string; version: number }>(
      "select lifecycle,version from team_invites where id=$1",
      [old!.id]
    );
    expect(cleaned.rows[0]).toMatchObject({
      lifecycle: "revoked",
      version: old!.version + 1
    });
    await pool.query("update users set email=$2 where id=$1", [
      recipient,
      `away-${recipient}@example.test`
    ]);
    expect(await review(old!.id, old!.version)).toBeNull();
    await pool.query("update users set email=$2 where id=$1", [
      recipient,
      `${recipient}@example.test`
    ]);
    expect(await review(old!.id, old!.version)).toBeNull();
    const oldToken = (
      await pool.query<{ token_hash: string }>(
        "select token_hash from team_invites where id=$1",
        [old!.id]
      )
    ).rows[0]!.token_hash;
    expect(
      await repo.acceptTeamInvite({
        tokenHash: oldToken,
        userId: recipient,
        expectedVersion: old!.version,
        expectedBackendOriginHash: origin
      })
    ).toBeNull();
    const fresh = await invite(firstWorkspace, "admin");
    const stalePeer = await invite(secondWorkspace, "member");
    expect(fresh).toMatchObject({
      recipientUserId: recipient,
      recipientLeaveGeneration: 1,
      issuanceMembershipVersion: left!.version,
      issuanceMembershipStatus: "disabled",
      issuanceDisabledReason: "member_left"
    });
    const freshReview = await review(fresh!.id, fresh!.version);
    expect(freshReview?.leaveGeneration).toBe(1);
    const rejoined = await accept(freshReview!);
    expect(rejoined?.membership).toMatchObject({
      role: "admin",
      status: "enabled",
      leaveGeneration: 1
    });
    const lowerRoleOffer = await invite(secondWorkspace, "member");
    const enabledInbox = await repo.listMyTeamInvites(recipientActor, origin);
    expect(
      enabledInbox.find((row) => row.id === lowerRoleOffer!.id)
    ).toMatchObject({
      role: "member",
      effectiveRole: "admin",
      membershipStatus: "enabled"
    });
    expect(await review(old!.id, old!.version)).toBeNull();
    expect(await review(stalePeer!.id, stalePeer!.version)).toBeNull();
    const accesses = await pool.query<{
      team_workspace_id: string;
      access: string;
      disabled_at: Date | null;
    }>(
      `select team_workspace_id,access::text,disabled_at from team_workspace_access_grants
      where team_id=$1 and user_id=$2 order by team_workspace_id`,
      [team, recipient]
    );
    expect(
      accesses.rows.find((row) => row.team_workspace_id === secondWorkspace)
        ?.disabled_at
    ).not.toBeNull();
    expect(
      accesses.rows.find((row) => row.team_workspace_id === firstWorkspace)
        ?.disabled_at
    ).toBeNull();
  }, 120_000);

  it("declines only the exact current invitation and rejects replay", async () => {
    const pending = await invite(firstWorkspace);
    const current = await review(pending!.id, pending!.version);
    expect(current).not.toBeNull();
    const decision = {
      inviteId: pending!.id,
      userId: recipient,
      expectedVersion: pending!.version,
      expectedBackendOriginHash: origin,
      expectedMembershipVersion: current!.membershipVersion,
      expectedMembershipStatus: current!.membershipStatus,
      expectedMembershipDisabledReason: current!.membershipDisabledReason,
      expectedLeaveGeneration: current!.leaveGeneration
    };
    const declined = await repo.declineTeamInvite(decision);
    expect(declined).toMatchObject({
      lifecycle: "declined",
      version: pending!.version + 1
    });
    expect(await repo.declineTeamInvite(decision)).toBeNull();
    expect(await review(pending!.id, pending!.version)).toBeNull();
  });

  it("serializes concurrent first-time decisions for different Workspaces", async () => {
    const newcomer = randomUUID();
    await pool.query("insert into users(id,email) values($1,$2)", [
      newcomer,
      `${newcomer}@example.test`
    ]);
    const make = (workspaceId: string) =>
      repo.createTeamInvite(ownerActor, {
        teamId: team,
        defaultTeamWorkspaceId: workspaceId,
        defaultWorkspaceAccess: "read",
        email: `${newcomer}@example.test`,
        role: "member",
        backendOriginHash: origin,
        tokenHash: randomUUID().replaceAll("-", "").repeat(2),
        expiresAt: new Date(Date.now() + 86_400_000)
      });
    const pending = await Promise.all([
      make(firstWorkspace),
      make(secondWorkspace)
    ]);
    const reviews = await Promise.all(
      pending.map((item) =>
        repo.getTeamInviteDecisionReview(
          { userId: newcomer },
          {
            inviteId: item!.id,
            expectedVersion: item!.version,
            backendOriginHash: origin
          }
        )
      )
    );
    expect(reviews.every((item) => item?.membershipVersion === null)).toBe(
      true
    );
    const decide = (item: NonNullable<(typeof reviews)[number]>) =>
      repo.acceptTeamInvite({
        inviteId: item.invite.id,
        userId: newcomer,
        expectedVersion: item.invite.version,
        expectedBackendOriginHash: origin,
        expectedMembershipVersion: item.membershipVersion,
        expectedMembershipStatus: item.membershipStatus,
        expectedMembershipDisabledReason: item.membershipDisabledReason,
        expectedLeaveGeneration: item.leaveGeneration
      });
    const outcomes = await Promise.all(reviews.map((item) => decide(item!)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const firstState = await pool.query<{
      status: string;
      version: number;
      leave_generation: number;
    }>(
      "select status::text,version,leave_generation from team_memberships where team_id=$1 and user_id=$2",
      [team, newcomer]
    );
    expect(firstState.rows).toMatchObject([
      {
        status: "enabled",
        version: 1,
        leave_generation: 0
      }
    ]);
    const firstGrants = await pool.query<{
      team_workspace_id: string;
      disabled_at: Date | null;
    }>(
      "select team_workspace_id,disabled_at from team_workspace_access_grants where team_id=$1 and user_id=$2",
      [team, newcomer]
    );
    expect(firstGrants.rows).toHaveLength(1);
    expect(firstGrants.rows[0]?.disabled_at).toBeNull();
    const loser = pending[outcomes.findIndex((item) => item === null)]!;
    const fresh = await repo.getTeamInviteDecisionReview(
      { userId: newcomer },
      {
        inviteId: loser!.id,
        expectedVersion: loser!.version,
        backendOriginHash: origin
      }
    );
    expect(fresh?.membershipVersion).toBe(1);
    expect(await decide(fresh!)).not.toBeNull();
    const finalGrants = await pool.query<{
      team_workspace_id: string;
      disabled_at: Date | null;
    }>(
      "select team_workspace_id,disabled_at from team_workspace_access_grants where team_id=$1 and user_id=$2",
      [team, newcomer]
    );
    expect(finalGrants.rows).toHaveLength(2);
    expect(finalGrants.rows.every((row) => row.disabled_at === null)).toBe(
      true
    );
  }, 120_000);

  it("makes accept versus successful leave one membership epoch transition", async () => {
    const member = randomUUID();
    await pool.query("insert into users(id,email) values($1,$2)", [
      member,
      `${member}@example.test`
    ]);
    const make = (workspaceId: string) =>
      repo.createTeamInvite(ownerActor, {
        teamId: team,
        defaultTeamWorkspaceId: workspaceId,
        defaultWorkspaceAccess: "read",
        email: `${member}@example.test`,
        role: "member",
        backendOriginHash: origin,
        tokenHash: randomUUID().replaceAll("-", "").repeat(2),
        expiresAt: new Date(Date.now() + 86_400_000)
      });
    const seed = await make(firstWorkspace);
    const seedReview = await repo.getTeamInviteDecisionReview(
      { userId: member },
      {
        inviteId: seed!.id,
        expectedVersion: seed!.version,
        backendOriginHash: origin
      }
    );
    expect(
      await repo.acceptTeamInvite({
        inviteId: seed!.id,
        userId: member,
        expectedVersion: seed!.version,
        expectedBackendOriginHash: origin,
        expectedMembershipVersion: seedReview!.membershipVersion,
        expectedMembershipStatus: seedReview!.membershipStatus,
        expectedMembershipDisabledReason: seedReview!.membershipDisabledReason,
        expectedLeaveGeneration: seedReview!.leaveGeneration
      })
    ).not.toBeNull();
    const current = await repo.getTeamMembership({ userId: member }, team);
    const pending = await make(secondWorkspace);
    const reviewed = await repo.getTeamInviteDecisionReview(
      { userId: member },
      {
        inviteId: pending!.id,
        expectedVersion: pending!.version,
        backendOriginHash: origin
      }
    );
    expect(reviewed?.membershipVersion).toBe(current!.version);
    const [accepted, left] = await Promise.all([
      repo.acceptTeamInvite({
        inviteId: pending!.id,
        userId: member,
        expectedVersion: pending!.version,
        expectedBackendOriginHash: origin,
        expectedMembershipVersion: reviewed!.membershipVersion,
        expectedMembershipStatus: reviewed!.membershipStatus,
        expectedMembershipDisabledReason: reviewed!.membershipDisabledReason,
        expectedLeaveGeneration: reviewed!.leaveGeneration
      }),
      repo
        .leaveTeam(
          { userId: member },
          { teamId: team, expectedVersion: current!.version }
        )
        .catch((error: unknown) => {
          expect(error).toMatchObject({ code: "STALE_VERSION" });
          return null;
        })
    ]);
    expect(Number(accepted !== null) + Number(left !== null)).toBe(1);
    const membershipState = (
      await pool.query<{
        status: string;
        version: number;
        leaveGeneration: number;
      }>(
        'select status::text as status,version,leave_generation as "leaveGeneration" from team_memberships where team_id=$1 and user_id=$2',
        [team, member]
      )
    ).rows[0];
    const inviteState = await pool.query<{
      lifecycle: string;
      version: number;
    }>("select lifecycle::text,version from team_invites where id=$1", [
      pending!.id
    ]);
    const grantState = await pool.query<{
      team_workspace_id: string;
      disabled_at: Date | null;
    }>(
      "select team_workspace_id,disabled_at from team_workspace_access_grants where team_id=$1 and user_id=$2",
      [team, member]
    );
    expect(membershipState?.version).toBe(current!.version + 1);
    if (accepted) {
      expect(membershipState).toMatchObject({
        status: "enabled",
        leaveGeneration: 0
      });
      expect(inviteState.rows).toMatchObject([
        { lifecycle: "accepted", version: pending!.version + 1 }
      ]);
      expect(grantState.rows).toHaveLength(2);
      expect(grantState.rows.every((row) => row.disabled_at === null)).toBe(
        true
      );
    } else {
      expect(membershipState).toMatchObject({
        status: "disabled",
        leaveGeneration: 1
      });
      expect(inviteState.rows).toMatchObject([
        { lifecycle: "revoked", version: pending!.version + 1 }
      ]);
      expect(grantState.rows).toHaveLength(1);
      expect(grantState.rows[0]).toMatchObject({
        team_workspace_id: firstWorkspace
      });
      expect(grantState.rows[0]?.disabled_at).not.toBeNull();
    }
  }, 120_000);
});
