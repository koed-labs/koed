import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createAgentsRepository } from "./agents-repository.js";
import {
  createScheduledJobRepository,
  bindScheduledJobManagedPromptWithClient,
  forgetScheduledJobsWithClient,
  ScheduledJobConflict,
  ScheduledJobAuthorityUnavailable
} from "./scheduled-job-repository.js";
import { createPersonalWorkspaceProjectRepository } from "./personal-workspace-project-repository.js";

const testUrl =
  process.env.KOED_HQ601_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
describe.skipIf(!testUrl)("Scheduled Job durable Personal API", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const owner = randomUUID(),
    other = randomUUID(),
    runnerDeviceId = randomUUID();
  let agentId: string, projectId: string, conversationSessionId: string;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq601_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    projectId = (
      await pool.query<{ id: string }>(
        "insert into projects(owner_user_id,name,key) values($1,'Atlas','ATLAS') returning id",
        [owner]
      )
    ).rows[0]!.id;
    conversationSessionId = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
       values($1,$2,'codex-cli','api',$3)`,
      [conversationSessionId, owner, projectId]
    );
    await pool.query(
      `insert into ai_client_instances(owner_user_id,instance_id,driver_id,display_name,enabled)
       values($1,'codex.jobs','codex','Codex',true)`,
      [owner]
    );
    agentId = (
      await createAgentsRepository(pool).create(owner, {
        name: "Quinn",
        role: "Builder",
        look: {},
        aiClientInstanceId: "codex.jobs",
        defaultPermissionMode: "supervised",
        defaultModel: null
      })
    ).id;
    await pool.query(
      `insert into device_credentials(owner_user_id,credential_key_id,upstream_backend_id,
         device_instance_id,verifier_kind,verifier_hash,operation_families)
       values($1,$2,'personal',$3,'secret_hash',$4,array['managed_execution'])`,
      [owner, `hq601-${randomUUID()}`, runnerDeviceId, "a".repeat(64)]
    );
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    if (admin && database) {
      await admin.query(`drop database ${quote(database)} with (force)`);
      await admin.end();
    }
  });
  const body = () => ({
    requestId: randomUUID(),
    agentId,
    conversationSessionId,
    projectId,
    title: "Morning brief",
    instruction: "Check the plan",
    schedule: { kind: "daily" as const, at: "09:00", tz: "Europe/Oslo" }
  });

  it("binds owner, Agent, Conversation, Project, and enrolled device; creation retry is exact", async () => {
    const repo = createScheduledJobRepository(pool);
    const input = body();
    const created = await repo.create(owner, runnerDeviceId, input);
    expect(created.runnerDeviceId).toBe(runnerDeviceId);
    expect(await repo.create(owner, runnerDeviceId, input)).toEqual(created);
    await expect(
      repo.create(owner, runnerDeviceId, { ...input, title: "Changed" })
    ).rejects.toBeInstanceOf(ScheduledJobConflict);
    await expect(
      repo.create(other, runnerDeviceId, { ...body(), projectId: null })
    ).rejects.toBeInstanceOf(ScheduledJobConflict);
    await expect(
      repo.reassign(owner, created.id, created.version, randomUUID())
    ).rejects.toBeInstanceOf(ScheduledJobConflict);
    const changed = await repo.edit(owner, created.id, {
      expectedVersion: created.version,
      title: "Next brief"
    });
    await expect(
      repo.edit(owner, created.id, {
        expectedVersion: created.version,
        title: "Stale"
      })
    ).rejects.toBeInstanceOf(ScheduledJobConflict);
    expect(changed.version).toBe(created.version + 1);
    expect(
      (
        await pool.query<{ count: string }>(
          `select count(*)::text as count from collaboration_outbox
        where family='scheduled_job_changed' and personal_owner_user_id=$1 and resource_id=$2`,
          [owner, created.id]
        )
      ).rows[0]!.count
    ).toBe("2");
  });

  it("keeps a stable occurrence and old attempt history on retry", async () => {
    const repo = createScheduledJobRepository(pool);
    const job = await repo.create(owner, runnerDeviceId, body());
    const requestId = randomUUID();
    const run = await repo.runNow(owner, job.id, job.version, requestId);
    expect((await repo.runNow(owner, job.id, job.version, requestId)).id).toBe(
      run.id
    );
    const first = await repo.startAttempt(owner, job.id, run.id, {
      expectedJobVersion: job.version,
      runnerDeviceId,
      fenceToken: "first-secret"
    });
    expect(first.started).toBe(true);
    if (!first.started) throw new Error("Expected first attempt");
    expect(
      (await repo.attemptHistory(owner, job.id, run.id)).events.map(
        (event) => event.status
      )
    ).toEqual(["running"]);
    await repo.appendAttemptEvent(owner, job.id, run.id, {
      attemptId: first.attemptId,
      executionId: first.executionId,
      fenceGeneration: first.fenceGeneration,
      fenceToken: "first-secret",
      expectedJobVersion: job.version,
      runnerDeviceId,
      status: "interrupted",
      uncertainty: true,
      error: "runner lost",
      outcome: "effects unknown"
    });
    const queued = await repo.retry(owner, job.id, run.id, job.version);
    expect(queued.id).toBe(run.id);
    const second = await repo.startAttempt(owner, job.id, run.id, {
      expectedJobVersion: job.version,
      runnerDeviceId,
      fenceToken: "second-secret"
    });
    if (!second.started) throw new Error("Expected second attempt");
    expect(second.executionId).not.toBe(first.executionId);
    await expect(
      repo.appendAttemptEvent(owner, job.id, run.id, {
        attemptId: first.attemptId,
        executionId: first.executionId,
        fenceGeneration: first.fenceGeneration,
        fenceToken: "first-secret",
        expectedJobVersion: job.version,
        runnerDeviceId,
        status: "ok"
      })
    ).rejects.toBeInstanceOf(ScheduledJobConflict);
    const history = await repo.attemptHistory(owner, job.id, run.id);
    expect(history.attempts.map((attempt) => attempt.executionId)).toEqual([
      first.executionId,
      second.executionId
    ]);
    expect(
      history.events.map((event) => [
        event.status,
        event.error,
        event.uncertainty
      ])
    ).toEqual([
      ["running", null, false],
      ["interrupted", "runner lost", true],
      ["running", null, false]
    ]);
    expect(
      (await repo.listRuns(owner, job.id, { limit: 20 })).runs[0]!.attempt
    ).toBe(2);
  });

  it("rejects direct history edits and deletes but lets owner forget cascade", async () => {
    const repo = createScheduledJobRepository(pool);
    const job = await repo.create(owner, runnerDeviceId, body());
    const run = await repo.runNow(owner, job.id, job.version, randomUUID());
    const started = await repo.startAttempt(owner, job.id, run.id, {
      expectedJobVersion: job.version,
      runnerDeviceId,
      fenceToken: "forget-fence"
    });
    if (!started.started) throw new Error("Expected an attempt");
    const history = await repo.attemptHistory(owner, job.id, run.id);
    const eventId = history.events[0]!.id;
    await expect(
      pool.query(
        "update scheduled_job_attempt_events set error='rewritten' where id=$1",
        [eventId]
      )
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("delete from scheduled_job_attempt_events where id=$1", [
        eventId
      ])
    ).rejects.toThrow(/cannot be deleted directly/);
    await expect(
      pool.query("delete from scheduled_job_attempts where id=$1", [
        started.attemptId
      ])
    ).rejects.toThrow(/cannot be deleted directly/);
    await expect(
      pool.query("delete from scheduled_job_runs where id=$1", [run.id])
    ).rejects.toThrow(/cannot be deleted directly/);
    const client = await pool.connect();
    try {
      await client.query("begin");
      expect(
        await forgetScheduledJobsWithClient(
          client,
          other,
          conversationSessionId
        )
      ).toBe(0);
      await client.query("commit");
    } finally {
      client.release();
    }
    expect(await repo.get(owner, job.id)).toBeTruthy();
    const ownerClient = await pool.connect();
    try {
      await ownerClient.query("begin");
      expect(
        await forgetScheduledJobsWithClient(
          ownerClient,
          owner,
          conversationSessionId
        )
      ).toBeGreaterThan(0);
      await ownerClient.query("commit");
    } catch (error) {
      await ownerClient.query("rollback");
      throw error;
    } finally {
      ownerClient.release();
    }
    const counts = await pool.query<{
      runs: string;
      attempts: string;
      events: string;
    }>(
      `select (select count(*) from scheduled_job_runs where id=$1)::text as runs,
              (select count(*) from scheduled_job_attempts where id=$2)::text as attempts,
              (select count(*) from scheduled_job_attempt_events where id=$3)::text as events`,
      [run.id, started.attemptId, eventId]
    );
    expect(counts.rows[0]).toEqual({ runs: "0", attempts: "0", events: "0" });
  });

  it("requires live Team proof and pauses a linked Job with the verified Personal receipt", async () => {
    const linkedProjectId = randomUUID(),
      workspaceProjectId = randomUUID(),
      linkedConversationId = randomUUID();
    await pool.query(
      `insert into projects(id,owner_user_id,name,key,team_backend_id,team_workspace_id,workspace_project_id)
       values($1,$2,'Team Atlas','TEAM','team-vps',$3,$4)`,
      [linkedProjectId, owner, randomUUID(), workspaceProjectId]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
       values($1,$2,'codex-cli','api',$3)`,
      [linkedConversationId, owner, linkedProjectId]
    );
    let current = true;
    const repo = createScheduledJobRepository(pool, {
      teamAuthority: async (input) => {
        expect(input).toMatchObject({
          ownerUserId: owner,
          projectId: linkedProjectId,
          teamBackendId: "team-vps",
          workspaceProjectId
        });
        if (!current) throw new Error("Team offline or revoked");
        return { projectVersion: 7, memberVersion: 3 };
      }
    });
    const input = {
      ...body(),
      projectId: linkedProjectId,
      conversationSessionId: linkedConversationId
    };
    const job = await repo.create(owner, runnerDeviceId, input);
    current = false;
    await expect(
      repo.runNow(owner, job.id, job.version, randomUUID())
    ).rejects.toBeInstanceOf(ScheduledJobAuthorityUnavailable);
    current = true;
    const run = await repo.runNow(owner, job.id, job.version, randomUUID());
    const started = await repo.startAttempt(owner, job.id, run.id, {
      expectedJobVersion: job.version,
      runnerDeviceId,
      fenceToken: "team-attempt"
    });
    expect(started.started).toBe(true);
    if (!started.started) throw new Error("Expected Team attempt start");
    const managedExecutionId = randomUUID();
    const managedCommandId = randomUUID();
    await pool.query(
      `insert into managed_conversation_executions
       (id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,
        runner_kind,state,fencing_token_hash,runner_deployment_id,runner_device_id,
        logical_session_id,provider_thread_id)
       values($1,$2,$3,'codex.jobs','gpt-test','supervised','local_device',
              'running',$4,$5,$6,$7,'provider-thread')`,
      [
        managedExecutionId,
        owner,
        linkedProjectId,
        "b".repeat(64),
        randomUUID(),
        runnerDeviceId,
        linkedConversationId
      ]
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into managed_conversation_commands
         (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,
          request_digest,client_user_message_id,execution_generation,encrypted_payload)
         values($1,$2,$3,$4,1,'prompt',$5,$6,1,'{}'::jsonb)`,
        [
          managedCommandId,
          owner,
          managedExecutionId,
          `hq601:team:${randomUUID()}`,
          "c".repeat(64),
          randomUUID()
        ]
      );
      const bindInput = {
        ownerUserId: owner,
        attemptId: started.attemptId,
        attemptExecutionId: started.executionId,
        fenceToken: "team-attempt",
        managedExecutionId,
        managedCommandId
      };
      await expect(
        bindScheduledJobManagedPromptWithClient(client, bindInput)
      ).rejects.toBeInstanceOf(ScheduledJobAuthorityUnavailable);
      await expect(
        bindScheduledJobManagedPromptWithClient(client, {
          ...bindInput,
          teamAuthority: async () => ({ projectVersion: 8, memberVersion: 3 })
        })
      ).rejects.toBeInstanceOf(ScheduledJobConflict);
      await expect(
        bindScheduledJobManagedPromptWithClient(client, {
          ...bindInput,
          teamAuthority: async () => ({ projectVersion: 7, memberVersion: 3 })
        })
      ).resolves.toMatchObject({ attemptId: started.attemptId });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await createPersonalWorkspaceProjectRepository(pool).reconcileInvalidation(
      owner,
      linkedProjectId,
      workspaceProjectId
    );
    const paused = await repo.get(owner, job.id);
    expect(paused).toMatchObject({
      paused: true,
      pausedReason: "shared_project_invalidation"
    });
    await expect(
      repo.startAttempt(owner, job.id, run.id, {
        expectedJobVersion: job.version,
        runnerDeviceId,
        fenceToken: "stale"
      })
    ).rejects.toBeInstanceOf(ScheduledJobConflict);
    const receipt = await pool.query<{ reason: string }>(
      `select reason from personal_workspace_project_reconciliations
       where owner_user_id=$1 and personal_project_id=$2 and workspace_project_id=$3`,
      [owner, linkedProjectId, workspaceProjectId]
    );
    expect(receipt.rows).toEqual([{ reason: "invalidation" }]);
  });

  it("binds two attempts to distinct prompts on the same Managed Execution", async () => {
    const repo = createScheduledJobRepository(pool);
    const job = await repo.create(owner, runnerDeviceId, body());
    const run = await repo.runNow(owner, job.id, job.version, randomUUID());
    const managedExecutionId = randomUUID();
    await pool.query(
      `insert into managed_conversation_executions
       (id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,
        runner_kind,state,fencing_token_hash,runner_deployment_id,runner_device_id,
        logical_session_id,provider_thread_id)
       values($1,$2,$3,'codex.jobs','gpt-test','supervised','local_device',
              'running',$4,$5,$6,$7,'provider-thread')`,
      [
        managedExecutionId,
        owner,
        projectId,
        "b".repeat(64),
        randomUUID(),
        runnerDeviceId,
        conversationSessionId
      ]
    );
    const queueAndBind = async (
      attempt: { attemptId: string; executionId: string },
      token: string,
      sequence: number
    ) => {
      const client = await pool.connect(),
        managedCommandId = randomUUID();
      try {
        await client.query("begin");
        await client.query(
          `insert into managed_conversation_commands
           (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,
            request_digest,client_user_message_id,execution_generation,encrypted_payload)
           values($1,$2,$3,$4,$5,'prompt',$6,$7,1,'{}'::jsonb)`,
          [
            managedCommandId,
            owner,
            managedExecutionId,
            `hq601:${attempt.attemptId}:${sequence}`,
            sequence,
            "c".repeat(64),
            randomUUID()
          ]
        );
        const bound = await bindScheduledJobManagedPromptWithClient(client, {
          ownerUserId: owner,
          attemptId: attempt.attemptId,
          attemptExecutionId: attempt.executionId,
          fenceToken: token,
          managedExecutionId,
          managedCommandId
        });
        expect(bound).toMatchObject({
          managedExecutionId,
          managedCommandId,
          managedExecutionGeneration: 1
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return managedCommandId;
    };
    const first = await repo.startAttempt(owner, job.id, run.id, {
      expectedJobVersion: job.version,
      runnerDeviceId,
      fenceToken: "first-map"
    });
    if (!first.started) throw new Error("Expected first attempt");
    const firstCommand = await queueAndBind(first, "first-map", 1);
    await expect(queueAndBind(first, "first-map", 99)).rejects.toBeInstanceOf(
      ScheduledJobConflict
    );
    const wrong = await pool.connect();
    try {
      await wrong.query("begin");
      await expect(
        bindScheduledJobManagedPromptWithClient(wrong, {
          ownerUserId: other,
          attemptId: first.attemptId,
          attemptExecutionId: first.executionId,
          fenceToken: "first-map",
          managedExecutionId,
          managedCommandId: firstCommand
        })
      ).rejects.toBeInstanceOf(ScheduledJobConflict);
      await wrong.query("rollback");
    } finally {
      wrong.release();
    }
    await expect(
      pool.query(
        "delete from scheduled_job_attempt_dispatch_bindings where attempt_id=$1",
        [first.attemptId]
      )
    ).rejects.toThrow(/cannot be deleted directly/);
    await repo.appendAttemptEvent(owner, job.id, run.id, {
      attemptId: first.attemptId,
      executionId: first.executionId,
      fenceGeneration: first.fenceGeneration,
      fenceToken: "first-map",
      expectedJobVersion: job.version,
      runnerDeviceId,
      status: "interrupted"
    });
    await repo.retry(owner, job.id, run.id, job.version);
    const second = await repo.startAttempt(owner, job.id, run.id, {
      expectedJobVersion: job.version,
      runnerDeviceId,
      fenceToken: "second-map"
    });
    if (!second.started) throw new Error("Expected second attempt");
    await queueAndBind(second, "second-map", 2);
    const stale = await pool.connect();
    try {
      await stale.query("begin");
      await expect(
        bindScheduledJobManagedPromptWithClient(stale, {
          ownerUserId: owner,
          attemptId: first.attemptId,
          attemptExecutionId: first.executionId,
          fenceToken: "first-map",
          managedExecutionId,
          managedCommandId: firstCommand
        })
      ).rejects.toBeInstanceOf(ScheduledJobConflict);
      await stale.query("rollback");
    } finally {
      stale.release();
    }
    expect(first.executionId).not.toBe(second.executionId);
    const bindings = await pool.query<{
      managed_execution_id: string;
      managed_command_id: string;
    }>(
      `select managed_execution_id,managed_command_id
         from scheduled_job_attempt_dispatch_bindings
        where attempt_id=any($1::uuid[]) order by managed_command_id`,
      [[first.attemptId, second.attemptId]]
    );
    expect(bindings.rows).toHaveLength(2);
    expect(
      new Set(bindings.rows.map((row) => row.managed_execution_id))
    ).toEqual(new Set([managedExecutionId]));
    expect(
      new Set(bindings.rows.map((row) => row.managed_command_id)).size
    ).toBe(2);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await forgetScheduledJobsWithClient(client, owner, conversationSessionId);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    expect(
      (
        await pool.query(
          "select 1 from scheduled_job_attempt_dispatch_bindings where attempt_id=any($1::uuid[])",
          [[first.attemptId, second.attemptId]]
        )
      ).rowCount
    ).toBe(0);
  });

  it("rejects a queued prompt when Job, device, Conversation, or Project changed after attempt start", async () => {
    const repo = createScheduledJobRepository(pool);
    for (const change of ["edit", "reassign", "move", "delete"] as const) {
      const localProjectId = randomUUID();
      const localSessionId = randomUUID();
      const managedExecutionId = randomUUID();
      const commandId = randomUUID();
      await pool.query(
        `insert into projects(id,owner_user_id,name,key)
         values($1,$2,$3,$4)`,
        [
          localProjectId,
          owner,
          `Project ${change}`,
          `J${randomUUID().slice(0, 6)}`
        ]
      );
      await pool.query(
        `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
         values($1,$2,'codex-cli','api',$3)`,
        [localSessionId, owner, localProjectId]
      );
      const job = await repo.create(owner, runnerDeviceId, {
        ...body(),
        projectId: localProjectId,
        conversationSessionId: localSessionId
      });
      const run = await repo.runNow(owner, job.id, job.version, randomUUID());
      const attempt = await repo.startAttempt(owner, job.id, run.id, {
        expectedJobVersion: job.version,
        runnerDeviceId,
        fenceToken: `stale-${change}`
      });
      if (!attempt.started) throw new Error("Expected attempt start");
      await pool.query(
        `insert into managed_conversation_executions
         (id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,
          runner_kind,state,fencing_token_hash,runner_deployment_id,runner_device_id,
          logical_session_id,provider_thread_id)
         values($1,$2,$3,'codex.jobs','gpt-test','supervised','local_device',
                'running',$4,$5,$6,$7,'provider-thread')`,
        [
          managedExecutionId,
          owner,
          localProjectId,
          "b".repeat(64),
          randomUUID(),
          runnerDeviceId,
          localSessionId
        ]
      );
      if (change === "edit") {
        await repo.edit(owner, job.id, {
          expectedVersion: job.version,
          title: "Edited after attempt"
        });
      } else if (change === "reassign") {
        await pool.query(
          `update scheduled_jobs set runner_device_id=$2,version=version+1
           where id=$1`,
          [job.id, randomUUID()]
        );
      } else if (change === "move") {
        await pool.query(
          `update sessions set automatic_personal_project_id=null,
              project_assignment_version=project_assignment_version+1
           where id=$1`,
          [localSessionId]
        );
      } else {
        await pool.query(
          "update projects set lifecycle='deleted',deleted_at=now(),version=version+1 where id=$1",
          [localProjectId]
        );
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into managed_conversation_commands
           (id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,
            request_digest,client_user_message_id,execution_generation,encrypted_payload)
           values($1,$2,$3,$4,1,'prompt',$5,$6,1,'{}'::jsonb)`,
          [
            commandId,
            owner,
            managedExecutionId,
            `hq601:stale:${change}:${randomUUID()}`,
            "c".repeat(64),
            randomUUID()
          ]
        );
        await expect(
          bindScheduledJobManagedPromptWithClient(client, {
            ownerUserId: owner,
            attemptId: attempt.attemptId,
            attemptExecutionId: attempt.executionId,
            fenceToken: `stale-${change}`,
            managedExecutionId,
            managedCommandId: commandId
          })
        ).rejects.toBeInstanceOf(ScheduledJobConflict);
      } finally {
        await client.query("rollback");
        client.release();
      }
      expect(
        (
          await pool.query(
            "select 1 from managed_conversation_commands where id=$1",
            [commandId]
          )
        ).rows
      ).toHaveLength(0);
      expect(
        (
          await pool.query(
            `select 1 from scheduled_job_attempt_dispatch_bindings
             where attempt_id=$1`,
            [attempt.attemptId]
          )
        ).rows
      ).toHaveLength(0);
    }
  });

  it("locks proposed Project before Job and rejects a concurrent lifecycle change", async () => {
    const targetProjectId = randomUUID();
    const targetConversationId = randomUUID();
    await pool.query(
      `insert into projects(id,owner_user_id,name,key)
       values($1,$2,'Move target','RACE')`,
      [targetProjectId, owner]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,automatic_personal_project_id)
       values($1,$2,'codex-cli','api',$3)`,
      [targetConversationId, owner, targetProjectId]
    );
    const repo = createScheduledJobRepository(pool);
    const job = await repo.create(owner, runnerDeviceId, body());
    const lifecycle = await pool.connect();
    const contender = await pool.connect();
    try {
      await lifecycle.query("begin");
      await lifecycle.query("select id from projects where id=$1 for update", [
        targetProjectId
      ]);
      const editing = repo.edit(owner, job.id, {
        expectedVersion: job.version,
        projectId: targetProjectId,
        conversationSessionId: targetConversationId
      });
      let waiting = false;
      for (let tries = 0; tries < 80; tries++) {
        const active = await pool.query<{ count: string }>(
          `select count(*)::text as count from pg_stat_activity
            where datname=current_database() and wait_event_type='Lock'
              and query like '%from projects%'`
        );
        if (Number(active.rows[0]!.count) > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      await contender.query("begin");
      await expect(
        contender.query(
          "select id from scheduled_jobs where id=$1 for update nowait",
          [job.id]
        )
      ).resolves.toHaveProperty("rowCount", 1);
      await contender.query("commit");
      await lifecycle.query(
        `update projects set deletion_phase='preparing',delete_batch_id=$2,
           version=version+1 where id=$1`,
        [targetProjectId, randomUUID()]
      );
      await lifecycle.query("commit");
      await expect(editing).rejects.toBeInstanceOf(ScheduledJobConflict);
      expect(await repo.get(owner, job.id)).toMatchObject({
        projectId,
        conversationSessionId,
        version: job.version
      });
    } finally {
      await lifecycle.query("rollback").catch(() => undefined);
      await contender.query("rollback").catch(() => undefined);
      lifecycle.release();
      contender.release();
    }
  });
});
