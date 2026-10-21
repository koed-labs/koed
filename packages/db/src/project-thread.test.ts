import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { createCollaborationRepository } from "./collaboration-repository.js";
import { runDbMigrations } from "./migrate.js";

const url = process.env.KOED_HQ705_TEST_DATABASE_URL;
describe.skipIf(!url)("Project Thread exact Project audience", () => {
  let pool: pg.Pool;
  let repo: ReturnType<typeof createCollaborationRepository>;
  const teamId = randomUUID(),
    otherTeamId = randomUUID();
  const workspaceId = randomUUID(),
    otherWorkspaceId = randomUUID();
  const projectId = randomUUID(),
    otherProjectId = randomUUID();
  const alice = randomUUID(),
    bob = randomUUID(),
    carol = randomUUID(),
    outsider = randomUUID();
  const aliceMember = randomUUID(),
    bobMember = randomUUID(),
    carolMember = randomUUID(),
    outsiderMember = randomUUID();
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await runDbMigrations(pool);
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    repo = createCollaborationRepository(pool, {
      envelopeEncryptionProvider: provider,
      teamEnvelopeEncryptionProvider: provider
    });
    for (const [user, name] of [
      [alice, "Alice"],
      [bob, "Bob"],
      [carol, "Carol"],
      [outsider, "Outside"]
    ])
      await pool.query(
        "insert into users(id,email,display_name) values ($1,$2,$3)",
        [user, `${user}@test.invalid`, name]
      );
    await pool.query(
      "insert into teams(id,name) values ($1,'Atlas'),($2,'Other')",
      [teamId, otherTeamId]
    );
    for (const [id, team, user] of [
      [aliceMember, teamId, alice],
      [bobMember, teamId, bob],
      [carolMember, teamId, carol],
      [outsiderMember, otherTeamId, outsider]
    ])
      await pool.query(
        "insert into team_memberships(id,team_id,user_id,role) values ($1,$2,$3,'member')",
        [id, team, user]
      );
    await pool.query(
      "insert into team_workspaces(id,team_id,name) values ($1,$2,'Plan'),($3,$2,'Other Project')",
      [workspaceId, teamId, otherWorkspaceId]
    );
    for (const [workspace, user] of [
      [workspaceId, alice],
      [workspaceId, bob],
      [workspaceId, carol],
      [otherWorkspaceId, carol]
    ])
      await pool.query(
        "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory) values ($1,$2,$3,'write',true)",
        [workspace, teamId, user]
      );
    await pool.query(
      "insert into workspace_projects(id,team_id,workspace_id,owner_team_member_id,name,key,share_attempt_key) values ($1,$2,$3,$4,'Plan','PLN','plan-1'),($5,$2,$6,$7,'Other','OTH','other-1')",
      [
        projectId,
        teamId,
        workspaceId,
        aliceMember,
        otherProjectId,
        otherWorkspaceId,
        carolMember
      ]
    );
    for (const [project, member] of [
      [projectId, aliceMember],
      [projectId, bobMember],
      [otherProjectId, carolMember]
    ])
      await pool.query(
        "insert into workspace_project_members(workspace_project_id,team_member_id,access) values ($1,$2,'write')",
        [project, member]
      );
  }, 120000);
  afterAll(async () => {
    await pool?.end();
  });

  it("keeps human history, mentions and receipts inside the exact Project", async () => {
    const thread = await repo.getOrCreateProjectThread(
      { userId: alice },
      { teamId, workspaceProjectId: projectId }
    );
    expect(thread).toMatchObject({
      teamId,
      workspaceProjectId: projectId,
      latestSequence: 0,
      unreadCount: 0
    });
    expect(thread?.people.map((person) => person.userId).sort()).toEqual(
      [alice, bob].sort()
    );
    const same = await repo.getOrCreateProjectThread(
      { userId: bob },
      { teamId, workspaceProjectId: projectId }
    );
    expect(same?.id).toBe(thread?.id);
    expect(
      await repo.getProjectThread(
        { userId: carol },
        { teamId, workspaceProjectId: projectId }
      )
    ).toBeNull();
    expect(
      await repo.getProjectThread(
        { userId: outsider },
        { teamId, workspaceProjectId: projectId }
      )
    ).toBeNull();
    expect(
      await repo.getProjectThread(
        { userId: bob },
        { teamId, workspaceProjectId: otherProjectId }
      )
    ).toBeNull();
    expect(
      await repo.getThread({ userId: alice }, { threadId: thread!.id })
    ).toBeNull();
    expect(
      (
        await repo.listThreads({ userId: alice }, { scope: "team", teamId })
      )?.some((row) => row.id === thread!.id)
    ).toBe(false);
    const message = await repo.sendTeamMessageV2(
      { userId: alice },
      {
        threadId: thread!.id,
        idempotencyKey: "project-message-1",
        bodyText: "Please review the plan",
        replyToMessageId: null,
        mentionsUserIds: [bob]
      }
    );
    expect(message?.mentionsUserIds).toEqual([bob]);
    expect(
      (
        await repo.listTeamMessagesV2({ userId: bob }, { threadId: thread!.id })
      )?.messages.map((item) => item.bodyText)
    ).toEqual(["Please review the plan"]);
    expect(
      await repo.listTeamMessagesV2({ userId: carol }, { threadId: thread!.id })
    ).toBeNull();
    expect(
      await repo.sendTeamMessageV2(
        { userId: carol },
        {
          threadId: thread!.id,
          idempotencyKey: "outsider",
          bodyText: "Cannot post",
          replyToMessageId: null,
          mentionsUserIds: []
        }
      )
    ).toBeNull();
    await repo.markProjectThreadRead(
      { userId: bob },
      { threadId: thread!.id, messageId: message!.id }
    );
    expect(
      await repo.getReceiptStateForRealtime(
        { userId: bob },
        { threadId: thread!.id }
      )
    ).toBeNull();
    expect(
      await repo.getReceiptStateForRealtime(
        { userId: bob },
        { threadId: thread!.id, projectThreadV2: true }
      )
    ).toMatchObject({ threadId: thread!.id, lastReadMessageId: message!.id });
    expect(
      await repo.listMessageReceiptsForRealtime(
        { userId: alice },
        { threadId: thread!.id, throughMessageId: message!.id }
      )
    ).toBeNull();
    expect(
      await repo.listMessageReceiptsForRealtime(
        { userId: alice },
        {
          threadId: thread!.id,
          throughMessageId: message!.id,
          projectThreadV2: true
        }
      )
    ).toMatchObject([{ messageId: message!.id }]);
    expect(
      (
        await repo.getProjectThread(
          { userId: bob },
          { teamId, workspaceProjectId: projectId }
        )
      )?.unreadCount
    ).toBe(0);
    await pool.query(
      "update workspace_project_members set access='disabled',disabled_at=now(),version=version+1 where workspace_project_id=$1 and team_member_id=$2",
      [projectId, bobMember]
    );
    expect(
      await repo.getProjectThread(
        { userId: bob },
        { teamId, workspaceProjectId: projectId }
      )
    ).toBeNull();
    expect(
      await repo.listTeamMessagesV2({ userId: bob }, { threadId: thread!.id })
    ).toBeNull();
    expect(
      await repo.getReceiptStateForRealtime(
        { userId: bob },
        { threadId: thread!.id, projectThreadV2: true }
      )
    ).toBeNull();
    expect(
      await repo.markProjectThreadRead(
        { userId: bob },
        { threadId: thread!.id, messageId: message!.id }
      )
    ).toBeNull();
  });
});
