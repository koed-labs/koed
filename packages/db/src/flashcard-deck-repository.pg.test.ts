import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createFlashcardDeckRepository,
  DeckConflictError,
  DeckUnavailableError
} from "./flashcard-deck-repository.js";

const testUrl = process.env.KOED_HQ801_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("HQ-801 Flashcard Deck isolation", () => {
  let pool: pg.Pool;
  let decks: ReturnType<typeof createFlashcardDeckRepository>;
  const alice = randomUUID(),
    bob = randomUUID(),
    teamId = randomUUID(),
    workspaceId = randomUUID(),
    workspaceProjectId = randomUUID(),
    aliceMember = randomUUID(),
    bobMember = randomUUID(),
    aliceProject = randomUUID(),
    bobProject = randomUUID(),
    privateProject = randomUUID(),
    backend = "team-test";
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    decks = createFlashcardDeckRepository(pool);
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      alice,
      `${alice}@example.test`,
      bob,
      `${bob}@example.test`
    ]);
    await pool.query(
      "insert into projects(id,owner_user_id,name,key) values($1,$2,'Alice','ALICE'),($3,$4,'Bob','BOB'),($5,$2,'Private','PRIVATE')",
      [aliceProject, alice, bobProject, bob, privateProject]
    );
    await pool.query("insert into teams(id,name) values($1,'Deck Team')", [
      teamId
    ]);
    await pool.query(
      "insert into team_memberships(id,team_id,user_id,role) values($1,$3,$4,'member'),($2,$3,$5,'member')",
      [aliceMember, bobMember, teamId, alice, bob]
    );
    await pool.query(
      "insert into team_workspaces(id,team_id,name) values($1,$2,'Deck Workspace')",
      [workspaceId, teamId]
    );
    await pool.query(
      "insert into team_workspace_access_grants(team_workspace_id,team_id,user_id,access,can_share_owned_memory) values($1,$2,$3,'write',true),($1,$2,$4,'read',false)",
      [workspaceId, teamId, alice, bob]
    );
    await pool.query(
      "insert into workspace_projects(id,team_id,workspace_id,owner_team_member_id,name,key,share_attempt_key) values($1,$2,$3,$4,'Shared','SHARED','deck-attempt')",
      [workspaceProjectId, teamId, workspaceId, aliceMember]
    );
    await pool.query(
      "insert into workspace_project_members(workspace_project_id,team_member_id,access) values($1,$2,'write'),($1,$3,'read')",
      [workspaceProjectId, aliceMember, bobMember]
    );
    await pool.query(
      "update projects set team_backend_id=$2,team_workspace_id=$3,workspace_project_id=$4 where id in($1,$5)",
      [aliceProject, backend, workspaceId, workspaceProjectId, bobProject]
    );
  });
  afterAll(async () => {
    await pool?.end();
  });
  it("keeps reviewed Team Deck creation distinct from ordinary same-key creation", async () => {
    const projectVersion = Number(
      (
        await pool.query<{ version: number }>(
          "select version from workspace_projects where id=$1",
          [workspaceProjectId]
        )
      ).rows[0]!.version
    );
    const memberVersion = Number(
      (
        await pool.query<{ version: number }>(
          "select version from workspace_project_members where workspace_project_id=$1 and team_member_id=$2",
          [workspaceProjectId, aliceMember]
        )
      ).rows[0]!.version
    );
    const payload = {
      idempotencyKey: randomUUID(),
      title: "Midterm",
      scope: "Only chapter 7",
      madeFrom: "Course pack",
      cards: [{ question: "Q?", answer: "A." }]
    };
    const textAction = {
      nonce: "A".repeat(43),
      teamBackendId: backend,
      runnerDeviceId: "device-a",
      deviceCredentialKeyId: "credential-a",
      expectedProjectVersion: projectVersion,
      expectedMemberVersion: memberVersion
    };
    const created = await decks.createTeam(
      alice,
      workspaceProjectId,
      payload,
      textAction
    );
    const receipt = await decks.getTeamByCreationKey(
      alice,
      workspaceProjectId,
      payload.idempotencyKey
    );
    expect(receipt?.deck.id).toBe(created.id);
    expect(receipt?.creationPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      decks.createTeam(alice, workspaceProjectId, payload)
    ).rejects.toBeInstanceOf(DeckConflictError);
    const ordinary = { ...payload, idempotencyKey: randomUUID() };
    await decks.createTeam(alice, workspaceProjectId, ordinary);
    const versions = await pool.query<{
      project_version: number;
      member_version: number;
    }>(
      "select p.version as project_version, m.version as member_version from workspace_projects p join workspace_project_members m on m.workspace_project_id=p.id and m.team_member_id=$2 where p.id=$1",
      [workspaceProjectId, aliceMember]
    );
    await expect(
      decks.createTeam(alice, workspaceProjectId, ordinary, {
        ...textAction,
        expectedProjectVersion: Number(versions.rows[0]!.project_version),
        expectedMemberVersion: Number(versions.rows[0]!.member_version)
      })
    ).rejects.toBeInstanceOf(DeckConflictError);
    await expect(
      decks.createTeam(
        alice,
        workspaceProjectId,
        {
          ...payload,
          idempotencyKey: randomUUID()
        },
        textAction
      )
    ).rejects.toBeInstanceOf(DeckConflictError);
  });
  it("keeps shared cards common and each member's study state Personal", async () => {
    const input = {
      idempotencyKey: randomUUID(),
      title: "Economics",
      scope: "Chapter 7",
      madeFrom: "Course pack",
      cards: [
        {
          question: "What is scarcity?",
          answer: "Limited resources",
          sourceRef: "Course pack p. 7",
          topicLabel: "Scarcity"
        }
      ]
    };
    const created = await decks.createTeam(alice, workspaceProjectId, input);
    expect(
      (await decks.getTeam(bob, workspaceProjectId, created.id)).cards
    ).toEqual(created.cards);
    expect((await decks.createTeam(alice, workspaceProjectId, input)).id).toBe(
      created.id
    );
    await expect(
      decks.createTeam(alice, workspaceProjectId, {
        ...input,
        title: "Changed"
      })
    ).rejects.toBeInstanceOf(DeckConflictError);
    await expect(
      decks.createTeam(bob, workspaceProjectId, {
        ...input,
        idempotencyKey: randomUUID()
      })
    ).rejects.toBeInstanceOf(DeckUnavailableError);
    const cardId = created.cards[0]!.id;
    const link = { teamBackendId: backend, workspaceProjectId };
    await decks.putProgress(
      alice,
      aliceProject,
      created.id,
      cardId,
      { box: 2, nextAt: null, misses: 1 },
      link
    );
    await decks.putProgress(
      bob,
      bobProject,
      created.id,
      cardId,
      { box: 4, nextAt: null, misses: 0 },
      link
    );
    expect((await decks.progress(alice, aliceProject)).progress).toMatchObject([
      { cardId, box: 2, misses: 1 }
    ]);
    expect((await decks.progress(bob, bobProject)).progress).toMatchObject([
      { cardId, box: 4, misses: 0 }
    ]);
    await expect(
      decks.putProgress(
        bob,
        bobProject,
        created.id,
        cardId,
        { box: 8, nextAt: null, misses: 0 },
        { teamBackendId: backend, workspaceProjectId: randomUUID() }
      )
    ).rejects.toBeInstanceOf(DeckUnavailableError);
    await pool.query(
      "update workspace_project_members set access='disabled',disabled_at=now() where workspace_project_id=$1 and team_member_id=$2",
      [workspaceProjectId, bobMember]
    );
    await expect(
      decks.getTeam(bob, workspaceProjectId, created.id)
    ).rejects.toBeInstanceOf(DeckUnavailableError);
    await pool.query(
      "update workspace_project_members set access='read',disabled_at=null where workspace_project_id=$1 and team_member_id=$2",
      [workspaceProjectId, bobMember]
    );
    await pool.query(
      "update workspace_projects set lifecycle='deleted',deleted_at=now() where id=$1",
      [workspaceProjectId]
    );
    await expect(
      decks.getTeam(alice, workspaceProjectId, created.id)
    ).rejects.toBeInstanceOf(DeckUnavailableError);
  });
  it("rejects linked Personal Deck writes and supports private owner isolation", async () => {
    const card = { question: "Private?", answer: "Yes" };
    await expect(
      decks.createPersonal(alice, aliceProject, {
        idempotencyKey: randomUUID(),
        title: "Wrong",
        scope: "",
        madeFrom: "",
        cards: [card]
      })
    ).rejects.toBeInstanceOf(DeckUnavailableError);
    const deck = await decks.createPersonal(alice, privateProject, {
      idempotencyKey: randomUUID(),
      title: "Mine",
      scope: "",
      madeFrom: "",
      cards: [card]
    });
    await expect(
      decks.getPersonal(bob, privateProject, deck.id)
    ).rejects.toBeInstanceOf(DeckUnavailableError);
    await decks.putProgress(alice, privateProject, deck.id, deck.cards[0]!.id, {
      box: 1,
      nextAt: null,
      misses: 0
    });
    expect((await decks.progress(alice, privateProject)).progress).toHaveLength(
      1
    );
    await expect(
      decks.putProgress(bob, bobProject, deck.id, deck.cards[0]!.id, {
        box: 1,
        nextAt: null,
        misses: 0
      })
    ).rejects.toBeInstanceOf(DeckUnavailableError);
  });
});
