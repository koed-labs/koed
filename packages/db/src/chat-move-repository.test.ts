import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import {
  ChatMoveConflictError,
  createChatMoveRepository
} from "./chat-move-repository.js";
import { createCapturedSessionRepository } from "./captured-session-repository.js";

const testUrl =
  process.env.KOED_HQ107_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("HQ-107 exact Project-policy move journal", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const owner = randomUUID();
  const sessionId = randomUUID();
  const sourceProjectId = randomUUID();
  const destinationProjectId = randomUUID();
  const backendId = "hq107-team";
  const workspaceId = randomUUID();
  const logicalMemoryId = randomUUID();
  const teamId = randomUUID();
  const grantId = randomUUID();
  const unrelatedGrantId = randomUUID();

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq107_worker_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values ($1,$2)", [
      owner,
      `${owner}@example.test`
    ]);
    await pool.query(
      `insert into projects(id,owner_user_id,name,key,team_backend_id,team_workspace_id,workspace_project_id)
       values ($1,$3,'Shared','shared',$4,$5,$6),($2,$3,'Personal','personal',null,null,null)`,
      [
        sourceProjectId,
        destinationProjectId,
        owner,
        backendId,
        workspaceId,
        randomUUID()
      ]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
       values ($1,$2,'codex-cli','api',$3)`,
      [sessionId, owner, sourceProjectId]
    );
    await pool.query(
      `insert into project_policy_session_grants(owner_user_id,session_id,project_id,backend_id,
       logical_memory_id,team_id,team_workspace_id,share_grant_id,policy_generation,mapping_version,grant_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,1,1,1)`,
      [
        owner,
        sessionId,
        sourceProjectId,
        backendId,
        logicalMemoryId,
        teamId,
        workspaceId,
        grantId
      ]
    );
  }, 120_000);

  afterAll(async () => {
    try {
      await pool?.end();
      if (admin && database)
        await admin.query(`drop database ${quote(database)} with (force)`);
    } finally {
      await admin?.end();
    }
  });

  it("captures only immutable old-policy provenance, blocks late binding and requires exact frozen ACK before detach", async () => {
    const moves = createChatMoveRepository(pool);
    const pending = await moves.prepare(
      owner,
      sessionId,
      sourceProjectId,
      destinationProjectId
    );
    expect(pending?.bindings.map((binding) => binding.shareGrantId)).toEqual([
      grantId
    ]);
    expect(pending?.bindings[0]?.mappingVersion).toBe(1);
    await expect(
      pool.query(
        `insert into project_policy_session_grants(owner_user_id,session_id,project_id,backend_id,
       logical_memory_id,team_id,team_workspace_id,share_grant_id,policy_generation,mapping_version,grant_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,1,1,1)`,
        [
          owner,
          sessionId,
          sourceProjectId,
          backendId,
          logicalMemoryId,
          teamId,
          workspaceId,
          unrelatedGrantId
        ]
      )
    ).rejects.toThrow();
    await expect(
      moves.complete(owner, sessionId, pending!.batchId)
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    const ack = await moves.reserve(
      owner,
      sessionId,
      pending!.batchId,
      pending!.bindings[0]!.id,
      4
    );
    expect(ack.reviewedGrantVersion).toBe(4);
    await moves.ack(owner, sessionId, pending!.batchId, {
      ...ack,
      state: "review_required",
      actionGrantId: randomUUID()
    });
    const reviewed = (await moves.get(owner, sessionId, pending!.batchId))!
      .acks[0]!;
    await moves.ack(owner, sessionId, pending!.batchId, {
      ...reviewed,
      state: "dispatched"
    });
    await expect(
      moves.ack(owner, sessionId, pending!.batchId, {
        ...reviewed,
        state: "dispatched"
      })
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    await moves.ack(owner, sessionId, pending!.batchId, {
      ...reviewed,
      state: "frozen"
    });
    expect(await moves.complete(owner, sessionId, pending!.batchId)).toBe(
      destinationProjectId
    );
    const placed = await pool.query<{
      project_assignment_version: number;
      project_override_personal_project_id: string;
    }>(
      "select project_assignment_version,project_override_personal_project_id from sessions where id=$1",
      [sessionId]
    );
    expect(placed.rows[0]).toMatchObject({
      project_assignment_version: 2,
      project_override_personal_project_id: destinationProjectId
    });
    expect(
      await moves.undo(owner, sessionId, pending!.batchId, destinationProjectId)
    ).toBe(sourceProjectId);
    await expect(
      moves.undo(owner, sessionId, pending!.batchId, destinationProjectId)
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    const second = await moves.prepare(
      owner,
      sessionId,
      sourceProjectId,
      destinationProjectId
    );
    expect(second?.sourceMappingVersion).toBe(3);
    expect(second?.bindings[0]?.mappingVersion).toBe(1);
    const secondAck = await moves.reserve(
      owner,
      sessionId,
      second!.batchId,
      second!.bindings[0]!.id,
      5
    );
    await moves.ack(owner, sessionId, second!.batchId, {
      ...secondAck,
      state: "resolved"
    });
    expect(await moves.complete(owner, sessionId, second!.batchId)).toBe(
      destinationProjectId
    );
    expect(
      (
        await pool.query<{ count: string }>(
          "select count(*) as count from project_policy_session_grants where share_grant_id=$1",
          [grantId]
        )
      ).rows[0]?.count
    ).toBe("1");
  });

  it("allows parent erasure to cascade immutable provenance", async () => {
    await pool.query("delete from sessions where id=$1 and owner_user_id=$2", [
      sessionId,
      owner
    ]);
    expect(
      (
        await pool.query<{ count: string }>(
          "select count(*) as count from project_policy_session_grants where session_id=$1",
          [sessionId]
        )
      ).rows[0]?.count
    ).toBe("0");
  });

  it("releases a terminal Native review fence while preserving uncertain dispatch", async () => {
    const pendingSession = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
       values ($1,$2,'codex-cli','api',$3)`,
      [pendingSession, owner, sourceProjectId]
    );
    await pool.query(
      `insert into project_policy_session_grants(owner_user_id,session_id,project_id,backend_id,
       logical_memory_id,team_id,team_workspace_id,share_grant_id,policy_generation,mapping_version,grant_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,1,1,1)`,
      [
        owner,
        pendingSession,
        sourceProjectId,
        backendId,
        randomUUID(),
        teamId,
        workspaceId,
        randomUUID()
      ]
    );
    const moves = createChatMoveRepository(pool);
    await expect(
      moves.prepare(owner, pendingSession, sourceProjectId, randomUUID())
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    expect(
      (
        await pool.query<{ count: string }>(
          `select count(*) as count from chat_move_operations where session_id=$1`,
          [pendingSession]
        )
      ).rows[0]?.count
    ).toBe("0");
    const first = (await moves.prepare(
      owner,
      pendingSession,
      sourceProjectId,
      destinationProjectId
    ))!;
    const reserved = await moves.reserve(
      owner,
      pendingSession,
      first.batchId,
      first.bindings[0]!.id,
      2
    );
    const review = {
      ...reserved,
      actionGrantId: randomUUID(),
      state: "review_required" as const
    };
    await moves.ack(owner, pendingSession, first.batchId, review);
    await moves.cancel(owner, pendingSession, first.batchId);
    expect((await moves.get(owner, pendingSession, first.batchId))?.state).toBe(
      "cancelled"
    );
    const second = (await moves.prepare(
      owner,
      pendingSession,
      sourceProjectId,
      null
    ))!;
    expect(second.batchId).not.toBe(first.batchId);
    const secondReserved = await moves.reserve(
      owner,
      pendingSession,
      second.batchId,
      second.bindings[0]!.id,
      2
    );
    await moves.ack(owner, pendingSession, second.batchId, {
      ...secondReserved,
      state: "dispatched"
    });
    await expect(
      moves.cancel(owner, pendingSession, second.batchId)
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    await expect(
      moves.prepare(
        owner,
        pendingSession,
        sourceProjectId,
        destinationProjectId
      )
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
  });

  it("rejects a local-context alias whose canonical destination is shared", async () => {
    const alias = `local-${randomUUID()}`;
    const otherSession = randomUUID();
    await pool.query(
      `insert into project_local_contexts(owner_user_id,project_id,device_id,local_project_id)
       values ($1,$2,$3,$4)`,
      [owner, sourceProjectId, randomUUID(), alias]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
       values ($1,$2,'codex-cli','api',$3)`,
      [otherSession, owner, destinationProjectId]
    );
    const repository = createCapturedSessionRepository(pool);
    const moved = await repository.moveCapturedSessionToProject(
      { userId: owner },
      otherSession,
      { id: alias, name: "Shared alias", path: null },
      destinationProjectId
    );
    expect(moved).toBeNull();
    const row = await pool.query<{ project_override_id: string | null }>(
      "select project_override_id from sessions where id=$1",
      [otherSession]
    );
    expect(row.rows[0]?.project_override_id).toBeNull();
    await pool.query("update sessions set delete_batch_id=$2 where id=$1", [
      otherSession,
      randomUUID()
    ]);
    expect(
      await repository.moveCapturedSessionToLooseChats(
        { userId: owner },
        otherSession,
        destinationProjectId
      )
    ).toBeNull();
    expect(
      await repository.resetCapturedSessionProject(
        { userId: owner },
        otherSession,
        destinationProjectId
      )
    ).toBeNull();
  });

  it("rejects a changed old Workspace Project link/version before review and detach", async () => {
    const linkedSession = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
       values ($1,$2,'codex-cli','api',$3)`,
      [linkedSession, owner, sourceProjectId]
    );
    await pool.query(
      `insert into project_policy_session_grants(owner_user_id,session_id,project_id,backend_id,
       logical_memory_id,team_id,team_workspace_id,share_grant_id,policy_generation,mapping_version,grant_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,1,1,1)`,
      [
        owner,
        linkedSession,
        sourceProjectId,
        backendId,
        randomUUID(),
        teamId,
        workspaceId,
        randomUUID()
      ]
    );
    const moves = createChatMoveRepository(pool);
    const pending = (await moves.prepare(
      owner,
      linkedSession,
      sourceProjectId,
      destinationProjectId
    ))!;
    const reservation = await moves.reserve(
      owner,
      linkedSession,
      pending.batchId,
      pending.bindings[0]!.id,
      1
    );
    const review = {
      ...reservation,
      actionGrantId: randomUUID(),
      state: "review_required" as const
    };
    await moves.ack(owner, linkedSession, pending.batchId, review);
    await pool.query("update projects set version=version+1 where id=$1", [
      sourceProjectId
    ]);
    await expect(
      moves.reviewReservation(
        owner,
        linkedSession,
        pending.batchId,
        review.actionGrantId
      )
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
    await moves.ack(owner, linkedSession, pending.batchId, {
      ...review,
      state: "resolved"
    });
    await expect(
      moves.complete(owner, linkedSession, pending.batchId)
    ).rejects.toBeInstanceOf(ChatMoveConflictError);
  });
});
