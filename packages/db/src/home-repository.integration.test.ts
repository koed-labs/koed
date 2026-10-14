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

    const nativeExecution = await insertExecution("running");
    const nativeCommand = randomUUID();
    await pool.query(
      `insert into managed_conversation_commands
       (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,request_digest,
        execution_generation,state,attempts,last_error_code,created_at,updated_at,completed_at)
       values($1,$2,$3,$4,1,'start',$5,2,'failed',1,'native_action_failed',now(),now(),now())`,
      [
        nativeCommand,
        ownerId,
        nativeExecution,
        randomUUID(),
        createHash("sha256").update(nativeCommand).digest("hex")
      ]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    expect(await home.countNeedsYou(otherId)).toBe(0);
    const nativeCommandPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(nativeCommandPage.items).toHaveLength(1);
    expect(nativeCommandPage.items[0]).toMatchObject({
      sourceEventId: `command:${nativeCommand}`,
      sourceId: nativeCommand,
      source: "native_agent_activity",
      state: "blocked",
      kind: "intervention",
      destination: { kind: "execution", executionId: nativeExecution }
    });
    const originalNativeCommandRevision =
      nativeCommandPage.items[0]!.sourceRevision;
    await home.setReminderState({
      ownerUserId: ownerId,
      sourceEventId: `command:${nativeCommand}`,
      source: "native_agent_activity",
      sourceId: nativeCommand,
      sourceRevision: originalNativeCommandRevision,
      cleared: true
    });
    expect(await home.countNeedsYou(ownerId)).toBe(103);
    await pool.query(
      `update managed_conversation_commands set attempts=attempts+1,updated_at=now()
        where id=$1`,
      [nativeCommand]
    );
    await pool.query(
      `update managed_conversation_executions
          set state_version=state_version+1,updated_at=now(),provider='claude'
        where id=$1`,
      [nativeExecution]
    );
    const bookkeepingOnlyPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(bookkeepingOnlyPage.items[0]?.sourceRevision).toBe(
      originalNativeCommandRevision
    );
    expect(await home.countNeedsYou(ownerId)).toBe(103);
    await pool.query(
      `update managed_conversation_commands
          set last_error_code='native_action_failed_again'
        where id=$1`,
      [nativeCommand]
    );
    const changedCommandPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(changedCommandPage.items[0]?.sourceRevision).not.toBe(
      originalNativeCommandRevision
    );
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    await home.setReminderState({
      ownerUserId: ownerId,
      sourceEventId: `command:${nativeCommand}`,
      source: "native_agent_activity",
      sourceId: nativeCommand,
      sourceRevision: changedCommandPage.items[0]!.sourceRevision,
      cleared: true
    });
    expect(await home.countNeedsYou(ownerId)).toBe(103);
    const unrelatedPrReview = await insertReview(
      "draft",
      77,
      "2026-10-02T10:00:00.124000Z"
    );
    await pool.query(
      `update pull_request_reviews set execution_id=$2,status='uncertain' where id=$1`,
      [unrelatedPrReview, nativeExecution]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    expect(
      (
        await home.listSourcePage({
          ownerUserId: ownerId,
          source: "native_agent_activity",
          limit: 10
        })
      ).items.map((item) => item.sourceEventId)
    ).toContain(`command:${nativeCommand}`);
    await pool.query(
      `update pull_request_reviews set status='published',revision=revision+1 where id=$1`,
      [unrelatedPrReview]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(103);

    const conversationId = randomUUID();
    const turnId = randomUUID();
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    await pool.query(
      `insert into personal_agent_conversations(conversation_id,owner_user_id,active_agent_id)
       values($1,$2,$3)`,
      [conversationId, ownerId, agent.agent.id]
    );
    await pool.query(
      `insert into personal_agent_chat_roots
       (conversation_id,owner_user_id,context_kind,target_device_id,target_deployment_id,workspace_id,title)
       values($1,$2,'independent','home-device',$3,$4,'Native chat title')`,
      [conversationId, ownerId, deploymentId, randomUUID()]
    );
    await pool.query(
      `insert into personal_agent_chat_turns
       (id,conversation_id,owner_user_id,request_id,request_digest,user_message_id,ordinal,status)
       values($1,$2,$3,$4,$5,$6,1,'completed')`,
      [
        turnId,
        conversationId,
        ownerId,
        randomUUID(),
        createHash("sha256").update(turnId).digest("hex"),
        messageId
      ]
    );
    await pool.query(
      `insert into personal_agent_chat_messages
       (id,conversation_id,owner_user_id,turn_id,sequence,kind,state)
       values($1,$2,$3,$4,1,'user','completed')`,
      [messageId, conversationId, ownerId, turnId]
    );
    await pool.query(
      `insert into personal_agent_chat_deliveries
       (id,conversation_id,owner_user_id,turn_id,message_id,recipient_kind,agent_id,agent_version,
        agent_name,ordinal,launch_snapshot,execution_id,command_id,status,error_code,started_at,created_at,updated_at)
       values($1,$2,$3,$4,$5,'agent',$6,$7,'Home Agent',0,'{}'::jsonb,$8,$9,'failed',
        'native_action_failed_again',now(),now(),now())`,
      [
        deliveryId,
        conversationId,
        ownerId,
        turnId,
        messageId,
        agent.agent.id,
        agent.agent.currentVersion,
        nativeExecution,
        nativeCommand
      ]
    );
    await pool.query(
      `update managed_conversation_executions
          set state='failed',last_error_code='native_action_failed_again',state_version=state_version+1
        where id=$1`,
      [nativeExecution]
    );
    const nativeExecutionVersion = await pool.query<{
      state_version: number;
    }>(
      "select state_version from managed_conversation_executions where id=$1",
      [nativeExecution]
    );
    await pool.query(
      `insert into home_reminder_states
       (owner_user_id,source_event_id,source_kind,source_id,source_revision,cleared)
       values($1,$2,'managed_execution',$3,$4,true)`,
      [
        ownerId,
        `execution:${nativeExecution}`,
        nativeExecution,
        `v${nativeExecutionVersion.rows[0]!.state_version}`
      ]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(103);
    expect(
      (await home.listReminderStates(ownerId, [`delivery:${deliveryId}`])).find(
        (state) => state.sourceEventId === `delivery:${deliveryId}`
      )
    ).toMatchObject({
      source: "native_agent_activity",
      sourceId: deliveryId,
      cleared: true
    });
    const deliveryPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(deliveryPage.items).toHaveLength(1);
    expect(deliveryPage.items[0]).toMatchObject({
      sourceEventId: `delivery:${deliveryId}`,
      sourceId: deliveryId,
      state: "blocked",
      title: "Home Agent needs attention",
      destination: { kind: "execution", executionId: conversationId }
    });
    expect(deliveryPage.items[0]?.updatedAt).toBe(
      (
        await pool.query<{ completed_at: Date }>(
          "select completed_at from managed_conversation_commands where id=$1",
          [nativeCommand]
        )
      ).rows[0]!.completed_at.toISOString()
    );
    const managedFailurePage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "managed_execution",
      limit: 10
    });
    expect(
      managedFailurePage.items.some((item) => item.sourceId === nativeExecution)
    ).toBe(false);
    const deliveryRevision = deliveryPage.items[0]!.sourceRevision;
    await home.setReminderState({
      ownerUserId: ownerId,
      sourceEventId: `delivery:${deliveryId}`,
      source: "native_agent_activity",
      sourceId: deliveryId,
      sourceRevision: deliveryRevision,
      cleared: false
    });
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    await home.setReminderState({
      ownerUserId: ownerId,
      sourceEventId: `delivery:${deliveryId}`,
      source: "native_agent_activity",
      sourceId: deliveryId,
      sourceRevision: deliveryRevision,
      cleared: true
    });
    expect(await home.countNeedsYou(ownerId)).toBe(103);
    await pool.query(
      `update personal_agent_chat_deliveries set updated_at=now() where id=$1`,
      [deliveryId]
    );
    await pool.query(
      `update personal_agent_chat_roots set title='Changed display title',updated_at=now()
        where conversation_id=$1`,
      [conversationId]
    );
    await pool.query(
      `update managed_conversation_commands set attempts=attempts+1,updated_at=now()
        where id=$1`,
      [nativeCommand]
    );
    await pool.query(
      `update managed_conversation_executions
          set state_version=state_version+1,updated_at=now(),provider='codex'
        where id=$1`,
      [nativeExecution]
    );
    const deliveryBookkeepingPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(deliveryBookkeepingPage.items[0]?.sourceRevision).toBe(
      deliveryRevision
    );
    expect(await home.countNeedsYou(ownerId)).toBe(103);
    await pool.query(
      `update personal_agent_chat_deliveries
          set status='uncertain',error_code='delivery_uncertain',updated_at=now()
        where id=$1`,
      [deliveryId]
    );
    await pool.query(
      `update managed_conversation_commands
          set state='indeterminate',last_error_code='delivery_uncertain'
        where id=$1`,
      [nativeCommand]
    );
    await pool.query(
      `update managed_conversation_executions set last_error_code='delivery_uncertain' where id=$1`,
      [nativeExecution]
    );
    const uncertainDeliveryPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(uncertainDeliveryPage.items[0]?.sourceRevision).not.toBe(
      deliveryRevision
    );
    expect(uncertainDeliveryPage.items[0]?.updatedAt).toBe(
      deliveryBookkeepingPage.items[0]?.updatedAt
    );
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    await pool.query(
      `update personal_agent_chat_deliveries set status='skipped',updated_at=now() where id=$1`,
      [deliveryId]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(103);
    expect(
      (
        await home.listSourcePage({
          ownerUserId: ownerId,
          source: "native_agent_activity",
          limit: 10
        })
      ).items
    ).toHaveLength(0);
    expect(
      (
        await home.listSourcePage({
          ownerUserId: ownerId,
          source: "managed_execution",
          limit: 10
        })
      ).items.some((item) => item.sourceId === nativeExecution)
    ).toBe(false);

    const followupCommand = randomUUID();
    await pool.query(
      `insert into managed_conversation_commands
       (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,request_digest,
        client_user_message_id,encrypted_payload,execution_generation,state,attempts,last_error_code)
       values($1,$2,$3,$4,2,'prompt',$5,$6,'{}'::jsonb,2,'failed',1,'private_followup_failed')`,
      [
        followupCommand,
        ownerId,
        nativeExecution,
        randomUUID(),
        createHash("sha256").update(followupCommand).digest("hex"),
        randomUUID()
      ]
    );
    await pool.query(
      `update managed_conversation_executions
          set state='running',last_error_code=null,state_version=state_version+1
        where id=$1`,
      [nativeExecution]
    );
    const followupPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(followupPage.items).toHaveLength(1);
    expect(followupPage.items[0]?.sourceEventId).toBe(
      `command:${followupCommand}`
    );
    expect(await home.countNeedsYou(ownerId)).toBe(104);

    const teamId = randomUUID();
    const teamProjectId = randomUUID();
    const teamChannelId = randomUUID();
    const teamRequestMessageId = randomUUID();
    const teamRequestId = randomUUID();
    const teamExecution = await insertExecution("running");
    const teamCommand = randomUUID();
    await pool.query(
      "insert into teams(id,name,created_by_user_id) values($1,'Home test team',$2)",
      [teamId, ownerId]
    );
    await pool.query(
      `insert into team_memberships(team_id,user_id,role,status,accepted_at)
       values($1,$2,'owner','enabled',now())`,
      [teamId, ownerId]
    );
    await pool.query(
      `insert into collaboration_team_shared_projects(id,team_id,created_by_user_id,creation_request_hash)
       values($1,$2,$3,$4)`,
      [
        teamProjectId,
        teamId,
        ownerId,
        createHash("sha256").update(teamProjectId).digest("hex")
      ]
    );
    await pool.query(
      `insert into collaboration_threads(id,scope,kind,team_id,team_project_id,name_marker,normalized_name_hash)
       values($1,'team','team_project_channel',$2,$3,'[koed encrypted collaboration name]',$4)`,
      [
        teamChannelId,
        teamId,
        teamProjectId,
        createHash("sha256").update(teamChannelId).digest("hex")
      ]
    );
    await pool.query(
      `insert into collaboration_thread_audiences(thread_id,version,member_set_hash)
       values($1,1,$2)`,
      [teamChannelId, createHash("sha256").update(teamId).digest("hex")]
    );
    await pool.query(
      `insert into collaboration_messages
       (id,thread_id,thread_sequence,version,audience_version,scope,team_id,sender_kind,
        body_marker,metadata_marker,provenance_kind,provenance_id,provenance_marker)
       values($1,$2,1,1,1,'team',$3,'system','[koed encrypted collaboration message]',
        '[koed encrypted collaboration metadata]','team_agent_request',$4,
        '[koed encrypted collaboration provenance]')`,
      [teamRequestMessageId, teamChannelId, teamId, teamRequestId]
    );
    await pool.query(
      `insert into team_agent_offers(team_id,owner_user_id,agent_id,enabled)
       values($1,$2,$3,true)`,
      [teamId, ownerId, agent.agent.id]
    );
    await pool.query(
      `insert into managed_conversation_commands
       (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,request_digest,
        execution_generation,state,attempts,created_at,updated_at,completed_at)
       values($1,$2,$3,$4,1,'start',$5,2,'completed',1,now(),now(),now())`,
      [
        teamCommand,
        ownerId,
        teamExecution,
        randomUUID(),
        createHash("sha256").update(teamCommand).digest("hex")
      ]
    );
    await pool.query(
      `insert into team_agent_requests
       (id,team_id,team_project_id,channel_id,request_message_id,requester_user_id,owner_user_id,
        agent_id,agent_version,agent_name,status,managed_execution_id,managed_command_id,
        idempotency_key_hash,request_hash)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,'Home Agent','accepted',$10,$11,$12,$13)`,
      [
        teamRequestId,
        teamId,
        teamProjectId,
        teamChannelId,
        teamRequestMessageId,
        otherId,
        ownerId,
        agent.agent.id,
        agent.agent.currentVersion,
        teamExecution,
        teamCommand,
        createHash("sha256")
          .update(`${teamRequestId}:idempotency`)
          .digest("hex"),
        createHash("sha256").update(`${teamRequestId}:request`).digest("hex")
      ]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(105);
    const teamPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    const teamItem = teamPage.items.find(
      (item) => item.sourceEventId === `team-request:${teamRequestId}`
    );
    expect(teamItem).toMatchObject({
      sourceId: teamRequestId,
      kind: "publication",
      state: "review",
      title: "Home Agent finished work; outcome ready to publish",
      summary: "The accepted Team assignment has no published outcome yet.",
      destination: { kind: "execution", executionId: teamExecution }
    });
    await home.setReminderState({
      ownerUserId: ownerId,
      sourceEventId: `team-request:${teamRequestId}`,
      source: "native_agent_activity",
      sourceId: teamRequestId,
      sourceRevision: teamItem!.sourceRevision,
      cleared: true
    });
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    await pool.query(
      `update team_agent_requests set native_status_frozen='succeeded',version=version+1,updated_at=now()
        where id=$1`,
      [teamRequestId]
    );
    await pool.query(
      `update managed_conversation_executions
          set state='stopped',state_version=state_version+1,last_error_code='unrelated_execution_status'
        where id=$1`,
      [teamExecution]
    );
    const frozenTeamPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(
      frozenTeamPage.items.find(
        (item) => item.sourceEventId === `team-request:${teamRequestId}`
      )?.sourceRevision
    ).toBe(teamItem!.sourceRevision);
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    await pool.query(
      `update team_agent_requests set native_status_frozen='interrupted',version=version+1
        where id=$1`,
      [teamRequestId]
    );
    const stoppedTeamPage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 10
    });
    expect(
      stoppedTeamPage.items.find(
        (item) => item.sourceEventId === `team-request:${teamRequestId}`
      )
    ).toMatchObject({
      title: "Home Agent work stopped; outcome ready to publish"
    });
    expect(await home.countNeedsYou(ownerId)).toBe(105);

    const firstNativePage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      limit: 1
    });
    expect(firstNativePage.items.map((item) => item.sourceEventId)).toEqual([
      `command:${followupCommand}`
    ]);
    expect(firstNativePage.nextCursor).not.toBeNull();
    const secondNativePage = await home.listSourcePage({
      ownerUserId: ownerId,
      source: "native_agent_activity",
      cursor: firstNativePage.nextCursor,
      limit: 1
    });
    expect(secondNativePage.items.map((item) => item.sourceEventId)).toEqual([
      `team-request:${teamRequestId}`
    ]);
    expect(secondNativePage.complete).toBe(true);
    expect(
      (
        await home.listSourcePage({
          ownerUserId: otherId,
          source: "native_agent_activity",
          limit: 10
        })
      ).items
    ).toEqual([]);
    await expect(
      home.setReminderState({
        ownerUserId: otherId,
        sourceEventId: `command:${followupCommand}`,
        source: "native_agent_activity",
        sourceId: followupCommand,
        sourceRevision: followupPage.items[0]!.sourceRevision,
        cleared: true
      })
    ).rejects.toMatchObject({ code: "HOME_SOURCE_STALE" });
    await pool.query(
      `update managed_conversation_commands
          set last_error_code='private_followup_failed_again'
        where id=$1`,
      [followupCommand]
    );
    await expect(
      home.listSourcePage({
        ownerUserId: ownerId,
        source: "native_agent_activity",
        cursor: firstNativePage.nextCursor,
        limit: 1
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    await pool.query(
      `update team_agent_offers set enabled=false where team_id=$1 and owner_user_id=$2`,
      [teamId, ownerId]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    expect(
      (
        await home.listSourcePage({
          ownerUserId: ownerId,
          source: "native_agent_activity",
          limit: 10
        })
      ).items.map((item) => item.sourceEventId)
    ).not.toContain(`team-request:${teamRequestId}`);
    await pool.query(
      `update team_agent_offers set enabled=true where team_id=$1 and owner_user_id=$2`,
      [teamId, ownerId]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(105);
    await pool.query(
      `update team_memberships set status='disabled',disabled_at=now()
        where team_id=$1 and user_id=$2`,
      [teamId, ownerId]
    );
    expect(await home.countNeedsYou(ownerId)).toBe(104);
    expect(
      (
        await home.listSourcePage({
          ownerUserId: ownerId,
          source: "native_agent_activity",
          limit: 10
        })
      ).items.map((item) => item.sourceEventId)
    ).not.toContain(`team-request:${teamRequestId}`);
  });
});
