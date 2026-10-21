import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createWorkspaceProjectRepository } from "./workspace-project-repository.js";

// Run only once the canonical HQ-504 migration creates the nonce-hash receipt.
const testUrl = process.env.KOED_HQ504_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const nonce = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");

describe.skipIf(!testUrl)("HQ-504 Team text-action nonce receipts", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  let repository: ReturnType<typeof createWorkspaceProjectRepository>;
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const aliceMember = randomUUID();
  const bobMember = randomUUID();
  let workspaceProjectId: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq504_team_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    repository = createWorkspaceProjectRepository(pool);
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      alice,
      `${alice}@example.test`,
      bob,
      `${bob}@example.test`
    ]);
    await pool.query(
      "insert into teams(id,name) values($1,'Text action Team')",
      [teamId]
    );
    await pool.query(
      `insert into team_memberships(id,team_id,user_id,role)
       values($1,$3,$4,'member'),($2,$3,$5,'member')`,
      [aliceMember, bobMember, teamId, alice, bob]
    );
    await pool.query(
      "insert into team_workspaces(id,team_id,name) values($1,$2,'Team work')",
      [workspaceId, teamId]
    );
    await pool.query(
      `insert into team_workspace_access_grants
        (team_workspace_id,team_id,user_id,access,can_share_owned_memory)
       values($1,$2,$3,'write',true),($1,$2,$4,'write',true)`,
      [workspaceId, teamId, alice, bob]
    );
    const project = await repository.create(alice, {
      teamId,
      workspaceId,
      name: "Shared actions",
      key: "SAC",
      shareAttemptKey: `hq504-${randomUUID()}`
    });
    workspaceProjectId = project.id;
    await repository.join(bob, workspaceProjectId);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(
        `drop database if exists ${quote(database)} with (force)`
      );
    await admin?.end();
  });

  it("binds an exact member's item and action ID to the nonce hash", async () => {
    const actionId = randomUUID();
    const effectNonce = nonce();
    const current = await repository.lifecycle(alice, workspaceProjectId);
    const item = await repository.createWorkItem(alice, workspaceProjectId, {
      idempotencyKey: actionId,
      textActionId: actionId,
      textActionNonce: effectNonce,
      kind: "todo",
      title: "Exact Team to-do",
      goal: "Exact Team to-do",
      status: "todo",
      expectedProjectVersion: current.version,
      expectedMemberVersion: current.memberVersion
    });
    expect(
      await repository.workItemTextActionEffect(
        alice,
        workspaceProjectId,
        actionId
      )
    ).toEqual({ item, effectNonceHash: hash(effectNonce) });
    expect(
      await repository.workItemTextActionEffect(
        bob,
        workspaceProjectId,
        actionId
      )
    ).toBeNull();
    const replayActionId = randomUUID();
    const replayVersion = await repository.lifecycle(alice, workspaceProjectId);
    await expect(
      repository.createWorkItem(alice, workspaceProjectId, {
        idempotencyKey: replayActionId,
        textActionId: replayActionId,
        textActionNonce: effectNonce,
        kind: "todo",
        title: "Reused nonce",
        goal: "Reused nonce",
        status: "todo",
        expectedProjectVersion: replayVersion.version,
        expectedMemberVersion: replayVersion.memberVersion
      })
    ).rejects.toThrow("nonce was already consumed");
    const now = await repository.lifecycle(alice, workspaceProjectId);
    await expect(
      repository.createWorkItem(alice, workspaceProjectId, {
        idempotencyKey: actionId,
        textActionId: actionId,
        textActionNonce: nonce(),
        kind: "todo",
        title: "Exact Team to-do",
        goal: "Exact Team to-do",
        status: "todo",
        expectedProjectVersion: now.version,
        expectedMemberVersion: now.memberVersion
      })
    ).rejects.toThrow();
  }, 120_000);

  it("does not adopt an ordinary idempotency collision or guessed nonce", async () => {
    const actionId = randomUUID();
    await repository.createWorkItem(alice, workspaceProjectId, {
      idempotencyKey: actionId,
      kind: "todo",
      title: "Ordinary item",
      goal: "Ordinary item",
      status: "todo"
    });
    const current = await repository.lifecycle(alice, workspaceProjectId);
    await expect(
      repository.createWorkItem(alice, workspaceProjectId, {
        idempotencyKey: actionId,
        textActionId: actionId,
        textActionNonce: nonce(),
        kind: "todo",
        title: "Ordinary item",
        goal: "Ordinary item",
        status: "todo",
        expectedProjectVersion: current.version,
        expectedMemberVersion: current.memberVersion
      })
    ).rejects.toThrow();
    expect(
      await repository.workItemTextActionEffect(
        alice,
        workspaceProjectId,
        actionId
      )
    ).toBeNull();

    const guessedActionId = randomUUID();
    const privateNonce = nonce();
    const guessedNonce = nonce();
    const after = await repository.lifecycle(alice, workspaceProjectId);
    await repository.createWorkItem(alice, workspaceProjectId, {
      idempotencyKey: guessedActionId,
      textActionId: guessedActionId,
      textActionNonce: guessedNonce,
      kind: "todo",
      title: "Guessed receipt",
      goal: "Guessed receipt",
      status: "todo",
      expectedProjectVersion: after.version,
      expectedMemberVersion: after.memberVersion
    });
    const effect = await repository.workItemTextActionEffect(
      alice,
      workspaceProjectId,
      guessedActionId
    );
    expect(effect?.effectNonceHash).toBe(hash(guessedNonce));
    expect(effect?.effectNonceHash).not.toBe(hash(privateNonce));
    expect(
      await repository.workItemTextActionEffect(
        bob,
        workspaceProjectId,
        guessedActionId
      )
    ).toBeNull();
  }, 120_000);
});
