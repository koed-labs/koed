import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createPersonalAgentRepository } from "./personal-agent-repository.js";
import { createHomeRepository } from "./home-repository.js";

const baseUrl = process.env.HOME_AUTHORITY_TEST_DATABASE_URL;
const databaseName = `koed_home_authority_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!baseUrl)("Home authority (PostgreSQL)", () => {
  const configured = baseUrl ? new URL(baseUrl) : null;
  const adminUrl = configured ? new URL(configured) : null;
  if (adminUrl) adminUrl.pathname = "/postgres";
  const testUrl = configured ? new URL(configured) : null;
  if (testUrl) testUrl.pathname = `/${databaseName}`;
  const admin = adminUrl
    ? new pg.Client({ connectionString: adminUrl.toString() })
    : null;
  const pool = testUrl
    ? new pg.Pool({ connectionString: testUrl.toString() })
    : null;
  let connected = false;
  afterAll(async () => {
    await pool?.end();
    if (!admin || !connected) return;
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",
        [databaseName]
      );
      await admin.query(`drop database if exists "${databaseName}"`);
    } finally {
      await admin.end();
    }
  });

  it("pages exact source revisions, shares owner clears, and tracks producer resolution", async () => {
    if (!admin || !pool) throw new Error("Test database URL unavailable");
    await admin.connect();
    connected = true;
    await admin.query(`create database "${databaseName}"`);
    await runDbMigrations(pool);
    const ownerId = randomUUID();
    const otherId = randomUUID();
    await pool.query(
      "insert into users(id,email,display_name) values($1,$2,$3),($4,$5,$6)",
      [
        ownerId,
        `${ownerId}@home.invalid`,
        "Home owner",
        otherId,
        `${otherId}@home.invalid`,
        "Other owner"
      ]
    );
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    );
    const agents = createPersonalAgentRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    const agent = await agents.createPersonalAgent(
      { userId: ownerId },
      {
        requestId: randomUUID(),
        name: "Home Agent",
        role: null,
        soulInstructions: "Test only.",
        instructionSource: "custom",
        defaultProvider: "codex",
        defaultModel: "test-model"
      }
    );
    const deviceId = randomUUID();
    const deploymentId = randomUUID();
    const insertReview = async (
      status: "stale" | "draft",
      number: number,
      updatedAt: string
    ) => {
      const id = randomUUID();
      await pool.query(
        `insert into pull_request_reviews(id,owner_user_id,agent_id,agent_version,target_device_id,target_deployment_id,
         account_id,repository_id,pull_request_number,expected_base_sha,expected_head_sha,connection_generation,status,
         revision,idempotency_key,request_digest,encrypted_selection,updated_at)
         values($1,$2,$3,$4,$5,$6,'account-1','acme/widget',$7,$8,$8,1,$9,1,$10,$11,'{}'::jsonb,$12)`,
        [
          id,
          ownerId,
          agent.agent.id,
          agent.agent.currentVersion,
          deviceId,
          deploymentId,
          number,
          "a".repeat(40),
          status,
          randomUUID(),
          createHash("sha256").update(id).digest("hex"),
          updatedAt
        ]
      );
      return id;
    };
    const insertExecution = async (
      state: "running" | "failed",
      generation = 2
    ) => {
      const id = randomUUID();
      await pool.query(
        `insert into managed_conversation_executions(id,owner_user_id,project_id,provider,state,state_version,
         execution_generation,fencing_token_hash,runner_deployment_id,runner_device_id,ai_client_instance_id,model,
         permission_mode,runner_kind,logical_session_id,provider_thread_id) values($1,$2,'home-project','codex',$3,1,$4,$5,$6,$7,'codex.default','test-model','supervised','local_device',$8,$9)`,
        [
          id,
          ownerId,
          state,
          generation,
          "b".repeat(64),
          deploymentId,
          deviceId,
          randomUUID(),
          `thread-${id}`
        ]
      );
      return id;
    };
    const firstReview = await insertReview(
      "stale",
      11,
      "2026-10-02T10:00:00.123401Z"
    );
    const secondReview = await insertReview(
      "draft",
      12,
      "2026-10-02T10:00:00.123499Z"
    );
    const runningExecution = await insertExecution("running");
    const failedExecution = await insertExecution("failed");
    const standaloneFailedExecution = await insertExecution("failed");
    const failedJobId = randomUUID();
    await pool.query(
      `insert into personal_agent_execution_jobs(id,owner_user_id,conversation_id,attribution_kind,agent_id,agent_version,state)
       values($1,$2,$3,'agent',$4,$5,'failed')`,
      [
        failedJobId,
        ownerId,
        failedExecution,
        agent.agent.id,
        agent.agent.currentVersion
      ]
    );
    const failedAttemptId = randomUUID();
    await pool.query(
      `insert into personal_agent_execution_attempts(id,owner_user_id,job_id,attempt_number,attribution_kind,
       agent_id,agent_version,provider,model,ai_client_instance_id,permission_mode,managed_execution_id,
       managed_execution_generation,status,outcome,completed_at)
       values($1,$2,$3,1,'agent',$4,$5,'codex','test-model','codex.default','supervised',$6,2,'failed','failed',now())`,
      [
        failedAttemptId,
        ownerId,
        failedJobId,
        agent.agent.id,
        agent.agent.currentVersion,
        failedExecution
      ]
    );
    await pool.query(
      "update personal_agent_execution_jobs set last_attempt_id=$2 where id=$1",
      [failedJobId, failedAttemptId]
    );
    const runtimeItemId = randomUUID();
    await pool.query(
      `insert into managed_conversation_runtime_items(id,owner_user_id,execution_id,execution_generation,
       provider_request_id,item_kind,state,request_digest,encrypted_payload)
       values($1,$2,$3,2,'approve-home-test','command_approval','pending',$4,'{}'::jsonb)`,
      [
        runtimeItemId,
        ownerId,
        runningExecution,
        createHash("sha256").update(runtimeItemId).digest("hex")
      ]
    );
    const staleGenerationItem = randomUUID();
    await pool.query(
      `insert into managed_conversation_runtime_items(id,owner_user_id,execution_id,execution_generation,
       provider_request_id,item_kind,state,request_digest,encrypted_payload)
       values($1,$2,$3,1,'approve-old-generation','command_approval','pending',$4,'{}'::jsonb)`,
      [
        staleGenerationItem,
        ownerId,
        runningExecution,
        createHash("sha256").update(staleGenerationItem).digest("hex")
      ]
    );
    const pushId = randomUUID();
    await pool.query(
      `insert into pull_request_operations(id,owner_user_id,review_id,target_device_id,target_deployment_id,
       request_id,request_digest,kind,state,encrypted_payload)
       values($1,$2,$3,$4,$5,$6,$7,'push','uncertain','{}'::jsonb)`,
      [
        pushId,
        ownerId,
        secondReview,
        deviceId,
        deploymentId,
        randomUUID(),
        createHash("sha256").update(pushId).digest("hex")
      ]
    );
    const home = createHomeRepository(pool, {
      envelopeEncryptionProvider: provider
    });
    expect(await home.countNeedsYou(ownerId)).toBe(6);
    const runtime = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "managed_runtime_item",
      limit: 10
    });
    expect(runtime.items.map((row) => row.sourceId)).toEqual([runtimeItemId]);
    const executionsPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "managed_execution",
      limit: 10
    });
    expect(
      executionsPage.items.find((row) => row.state === "blocked")?.sourceId
    ).toBe(standaloneFailedExecution);
    expect(
      (
        await home.listSourcePage({
          ownerUserId: ownerId,
          source: "personal_agent_job",
          limit: 10
        })
      ).items.map((row) => row.sourceId)
    ).toContain(failedJobId);
    await pool.query(
      "update managed_conversation_executions set execution_generation=3,state_version=state_version+1 where id=$1",
      [failedExecution]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(7);
    expect(
      (
        await home.listSourcePage({
          ownerUserId: ownerId,
          source: "managed_execution",
          limit: 10
        })
      ).items
        .filter((row) => row.state === "blocked")
        .map((row) => row.sourceId)
    ).toEqual(
      expect.arrayContaining([failedExecution, standaloneFailedExecution])
    );

    const first = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "pull_request_review",
      limit: 1
    });
    expect(first.items[0]?.sourceId).toBe(pushId); // blocked first despite later activity order
    const afterFirst = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "pull_request_review",
      cursor: first.nextCursor,
      limit: 1
    });
    expect(afterFirst.items[0]?.sourceId).toBe(secondReview);
    const finalPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "pull_request_review",
      cursor: afterFirst.nextCursor,
      limit: 1
    });
    expect(finalPage.items[0]?.sourceId).toBe(firstReview);

    const prItem = afterFirst.items[0]!;
    await expect(
      home.setReminderState({
        ownerUserId: otherId,
        sourceEventId: prItem.sourceEventId,
        source: prItem.source,
        sourceId: prItem.sourceId,
        sourceRevision: prItem.sourceRevision,
        cleared: true
      })
    ).rejects.toMatchObject({ code: "HOME_SOURCE_STALE" });
    await expect(
      home.setReminderState({
        ownerUserId: ownerId,
        sourceEventId: `pr-op:${secondReview}`,
        source: "pull_request_review",
        sourceId: secondReview,
        sourceRevision: prItem.sourceRevision,
        cleared: true
      })
    ).rejects.toMatchObject({ code: "HOME_SOURCE_STALE" });
    await home.setReminderState({
      ownerUserId: ownerId,
      sourceEventId: prItem.sourceEventId,
      source: prItem.source,
      sourceId: prItem.sourceId,
      sourceRevision: prItem.sourceRevision,
      cleared: true
    });
    expect(await home.countNeedsYou(ownerId)).toBe(6);
    expect(
      (await home.listReminderStates(ownerId)).some(
        (state) => state.sourceEventId === prItem.sourceEventId && state.cleared
      )
    ).toBe(true);
    await home.setReminderState({
      ownerUserId: ownerId,
      sourceEventId: prItem.sourceEventId,
      source: prItem.source,
      sourceId: prItem.sourceId,
      sourceRevision: prItem.sourceRevision,
      cleared: false
    });
    expect(await home.countNeedsYou(ownerId)).toBe(7);
    await pool.query(
      "update pull_request_reviews set revision=revision+1,updated_at=now() where id=$1",
      [secondReview]
    );
    await expect(
      home.setReminderState({
        ownerUserId: ownerId,
        sourceEventId: prItem.sourceEventId,
        source: prItem.source,
        sourceId: prItem.sourceId,
        sourceRevision: prItem.sourceRevision,
        cleared: true
      })
    ).rejects.toMatchObject({ code: "HOME_SOURCE_STALE" });

    await home.setReminderState({
      ownerUserId: ownerId,
      sourceEventId: `pr-op:${pushId}`,
      source: "pull_request_review",
      sourceId: pushId,
      sourceRevision: "v2.o1",
      cleared: true
    });
    expect(await home.countNeedsYou(ownerId)).toBe(6);
    await pool.query(
      "update pull_request_operations set state='completed',revision=revision+1,updated_at=now(),completed_at=now() where id=$1",
      [pushId]
    );
    await expect(
      home.listSourcePage({
        ownerUserId: ownerId,
        source: "pull_request_review",
        cursor: first.nextCursor,
        limit: 1
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await pool.query(
      "update pull_request_reviews set status='published',revision=revision+1 where id=$1",
      [firstReview]
    );
    await pool.query(
      "update managed_conversation_runtime_items set state='resolved',resolved_at=now() where id=$1",
      [runtimeItemId]
    );
    await pool.query(
      "update managed_conversation_executions set state='stopped',state_version=state_version+1 where id=any($1::uuid[])",
      [[failedExecution, standaloneFailedExecution]]
    );
    await pool.query(
      "update personal_agent_execution_jobs set state='canceled',version=version+1 where id=$1",
      [failedJobId]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(1);

    for (let index = 0; index < 102; index++) {
      const second = Math.floor(index / 100);
      const micros = String(index + 1).padStart(6, "0");
      await insertReview(
        "stale",
        100 + index,
        `2026-10-02T10:00:${String(second).padStart(2, "0")}.${micros}Z`
      );
    }
    expect(await home.countNeedsYou(ownerId)).toBe(103);
    const bounded = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "pull_request_review",
      limit: 100
    });
    expect(bounded.items).toHaveLength(100);
    expect(bounded.complete).toBe(false);
    const tail = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "pull_request_review",
      cursor: bounded.nextCursor,
      limit: 100
    });
    expect(tail.items).toHaveLength(3);
    expect(tail.complete).toBe(true);
  });
});
