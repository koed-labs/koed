import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAgentsRepository,
  createManagedConversationRepository,
  createScheduledJobRepository,
  runDbMigrations
} from "@koed/db";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { tickScheduledJobs } from "./runtime-tick.js";

const testUrl = process.env.KOED_HQ602_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("Scheduled Job Local AI Runtime dispatch", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database = "";
  const owner = randomUUID();
  const device = randomUUID();
  const deployment = randomUUID();
  const actor = { userId: owner };
  let projectId: string;
  let sessionId: string;
  let logicalSessionId: string;
  let agentId: string;
  let jobs: ReturnType<typeof createScheduledJobRepository>;
  let managed: ReturnType<typeof createManagedConversationRepository>;
  let agents: ReturnType<typeof createAgentsRepository>;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq602_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const child = new URL(testUrl!);
    child.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: child.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2)", [
      owner,
      `${owner}@example.test`
    ]);
    projectId = (
      await pool.query<{ id: string }>(
        "insert into projects(owner_user_id,name,key) values($1,'Routine','ROUTINE') returning id",
        [owner]
      )
    ).rows[0]!.id;
    sessionId = randomUUID();
    logicalSessionId = (
      await pool.query<{ logical_session_id: string }>(
        `insert into sessions(id,owner_user_id,source_runtime,capture_method,
         automatic_personal_project_id)
       values($1,$2,'codex-cli','api',$3) returning logical_session_id`,
        [sessionId, owner, projectId]
      )
    ).rows[0]!.logical_session_id;
    await pool.query(
      `insert into ai_client_instances(owner_user_id,instance_id,driver_id,display_name,enabled)
       values($1,'codex.jobs','codex','Codex',true)`,
      [owner]
    );
    agents = createAgentsRepository(pool);
    agentId = (
      await agents.create(owner, {
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
      [owner, `hq602-${randomUUID()}`, device, "a".repeat(64)]
    );
    jobs = createScheduledJobRepository(pool);
    managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database ${quote(database)} with (force)`);
    await admin?.end();
  });

  const createJob = async () =>
    jobs.create(owner, device, {
      requestId: randomUUID(),
      agentId,
      conversationSessionId: sessionId,
      projectId,
      title: "Morning brief",
      instruction: "Summarize the plan",
      schedule: { kind: "daily", at: "09:00", tz: "Europe/Oslo" }
    });
  const tick = (now = new Date(0)) =>
    tickScheduledJobs(
      {
        jobs,
        managed,
        agents,
        teamAuthority: async () => {
          throw new Error("Personal Job must not request Team authority");
        }
      },
      { ownerUserId: owner, deviceId: device, deploymentId: deployment },
      now
    );

  const createBoundRun = async (
    permissionMode: "supervised" | "full_access" = "supervised"
  ) => {
    const freshSessionId = randomUUID();
    const logical = (
      await pool.query<{ logical_session_id: string }>(
        `insert into sessions(id,owner_user_id,source_runtime,capture_method,
         automatic_personal_project_id)
       values($1,$2,'codex-cli','api',$3) returning logical_session_id`,
        [freshSessionId, owner, projectId]
      )
    ).rows[0]!.logical_session_id;
    const executionId = randomUUID();
    await pool.query(
      `insert into managed_conversation_executions
         (id,owner_user_id,project_id,provider,ai_client_instance_id,model,
          permission_mode,runner_kind,state,fencing_token_hash,runner_deployment_id,
          runner_device_id,logical_session_id,provider_thread_id)
       values($1,$2,$3,'codex','codex.jobs','custom-model',$4,
         'local_device','running',$5,$6,$7,$8,'provider-thread')`,
      [
        executionId,
        owner,
        projectId,
        permissionMode,
        "c".repeat(64),
        deployment,
        device,
        logical
      ]
    );
    await pool.query(
      `insert into managed_conversation_runtime_bindings
         (execution_id,owner_user_id,deployment_id,device_id,
          execution_generation,source_project_path,project_path)
       values($1,$2,$3,$4,1,'/tmp/hq602-current','/tmp/hq602-current')`,
      [executionId, owner, deployment, device]
    );
    const job = await jobs.create(owner, device, {
      requestId: randomUUID(),
      agentId,
      conversationSessionId: freshSessionId,
      projectId,
      title: "Current Agent authority",
      instruction: "Summarize the plan",
      schedule: { kind: "daily", at: "09:00", tz: "Europe/Oslo" }
    });
    const run = await jobs.runNow(owner, job.id, job.version, randomUUID());
    expect((await tick()).dispatched).toBe(1);
    const commandId = (
      await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id
         from scheduled_job_attempt_dispatch_bindings dispatch
         join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
        where attempt.run_id=$1`,
        [run.id]
      )
    ).rows[0]!.managed_command_id;
    return { job, run, commandId, executionId };
  };

  it("records an unsupported captured Conversation as a no-effect failed attempt", async () => {
    const job = await createJob();
    const run = await jobs.runNow(owner, job.id, job.version, randomUUID());
    expect((await tick()).needsReview).toBe(1);
    const history = await jobs.attemptHistory(owner, job.id, run.id);
    expect(history.events.map((event) => event.status)).toEqual([
      "running",
      "failed"
    ]);
    expect(
      (await jobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
        (item) => item.id === run.id
      )?.status
    ).toBe("failed");
    expect(
      (
        await pool.query(
          "select count(*)::int as count from managed_conversation_commands"
        )
      ).rows[0]?.count
    ).toBe(0);
    expect((await tick()).needsReview).toBe(0);
    expect(
      (await jobs.attemptHistory(owner, job.id, run.id)).attempts
    ).toHaveLength(1);
  });

  it("drains several missed days and handles the current occurrence in one tick", async () => {
    const current = new Date();
    const at = new Date(current.getTime() - 5 * 60_000);
    const job = await jobs.create(owner, device, {
      requestId: randomUUID(),
      agentId,
      conversationSessionId: sessionId,
      projectId,
      title: "Catch up",
      instruction: "Report today's plan",
      schedule: {
        kind: "daily",
        at: `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`,
        tz: "UTC"
      }
    });
    await pool.query("update scheduled_jobs set created_at=$2 where id=$1", [
      job.id,
      new Date(current.getTime() - 4 * 86_400_000 - 60 * 60_000)
    ]);
    const result = await tick(current);
    expect(result.materialized).toBe(5);
    const runs = (await jobs.listRuns(owner, job.id, { limit: 20 })).runs;
    expect(runs.filter((run) => run.status === "missed")).toHaveLength(4);
    expect(runs.filter((run) => run.status === "failed")).toHaveLength(1);
  });

  it("only the assigned device materializes and an overlapping occurrence is skipped", async () => {
    const current = new Date();
    const at = new Date(current.getTime() - 5 * 60_000);
    const job = await jobs.create(owner, device, {
      requestId: randomUUID(),
      agentId,
      conversationSessionId: sessionId,
      projectId,
      title: "Exclusive device",
      instruction: "Check today's plan",
      schedule: {
        kind: "daily",
        at: `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`,
        tz: "UTC"
      }
    });
    await pool.query("update scheduled_jobs set created_at=$2 where id=$1", [
      job.id,
      new Date(current.getTime() - 86_400_000 - 60 * 60_000)
    ]);
    const active = await jobs.runNow(owner, job.id, job.version, randomUUID());
    expect(
      (
        await jobs.startAttempt(owner, job.id, active.id, {
          expectedJobVersion: job.version,
          runnerDeviceId: device,
          fenceToken: "running"
        })
      ).started
    ).toBe(true);
    const wrongDevice = await tickScheduledJobs(
      {
        jobs,
        managed,
        agents,
        teamAuthority: async () => {
          throw new Error("No Team authority for Personal Job");
        }
      },
      {
        ownerUserId: owner,
        deviceId: randomUUID(),
        deploymentId: randomUUID()
      },
      current
    );
    expect(wrongDevice.materialized).toBe(0);
    expect(
      (await jobs.listRuns(owner, job.id, { limit: 20 })).runs
    ).toHaveLength(1);
    expect((await tick(current)).materialized).toBe(2);
    const runs = (await jobs.listRuns(owner, job.id, { limit: 20 })).runs;
    expect(runs.filter((run) => run.status === "missed")).toHaveLength(1);
    expect(
      runs.filter(
        (run) => run.status === "skipped" && run.skipReason === "overlap"
      )
    ).toHaveLength(1);
  });

  it("allows only one of two online devices to claim the same scheduled run", async () => {
    const secondDevice = randomUUID();
    await pool.query(
      `insert into device_credentials(owner_user_id,credential_key_id,upstream_backend_id,
         device_instance_id,verifier_kind,verifier_hash,operation_families)
       values($1,$2,'personal',$3,'secret_hash',$4,array['managed_execution'])`,
      [owner, `hq602-${randomUUID()}`, secondDevice, "b".repeat(64)]
    );
    const job = await createJob();
    const run = await jobs.runNow(owner, job.id, job.version, randomUUID());
    const dependencies = {
      jobs,
      managed,
      agents,
      teamAuthority: async () => {
        throw new Error("Personal Job must not request Team authority");
      }
    };
    const [assigned, otherDevice] = await Promise.all([
      tickScheduledJobs(
        dependencies,
        { ownerUserId: owner, deviceId: device, deploymentId: deployment },
        new Date(0)
      ),
      tickScheduledJobs(
        dependencies,
        {
          ownerUserId: owner,
          deviceId: secondDevice,
          deploymentId: randomUUID()
        },
        new Date(0)
      )
    ]);
    expect(assigned.needsReview).toBe(1);
    expect(otherDevice.materialized).toBe(0);
    expect(otherDevice.needsReview).toBe(0);
    expect(
      (await jobs.attemptHistory(owner, job.id, run.id)).attempts
    ).toHaveLength(1);
  });

  it("commits one attempt, queued prompt, and exact binding together; terminal recovery is idempotent", async () => {
    const executionId = randomUUID();
    await pool.query(
      `insert into managed_conversation_executions
         (id,owner_user_id,project_id,provider,ai_client_instance_id,model,
          permission_mode,runner_kind,state,fencing_token_hash,runner_deployment_id,
          runner_device_id,logical_session_id,provider_thread_id)
       values($1,$2,$3,'codex','codex.jobs','gpt-test','supervised','local_device',
          'running',$4,$5,$6,$7,'provider-thread')`,
      [
        executionId,
        owner,
        projectId,
        "b".repeat(64),
        deployment,
        device,
        logicalSessionId
      ]
    );
    await pool.query(
      `insert into managed_conversation_runtime_bindings
         (execution_id,owner_user_id,deployment_id,device_id,execution_generation,
          source_project_path,project_path)
       values($1,$2,$3,$4,1,'/tmp/hq602','/tmp/hq602')`,
      [executionId, owner, deployment, device]
    );
    const job = await createJob();
    const run = await jobs.runNow(owner, job.id, job.version, randomUUID());
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select id from managed_conversation_executions where id=$1 for update",
        [executionId]
      );
      // The scheduled path already owns the Project/Session/Job when it reaches
      // this row. NOWAIT must abort the entire attempt instead of deadlocking
      // against a human prompt that owns the execution first.
      expect((await tick()).dispatched).toBe(0);
      expect(
        (await jobs.attemptHistory(owner, job.id, run.id)).attempts
      ).toHaveLength(0);
      expect(
        (
          await pool.query(
            "select count(*)::int as count from managed_conversation_commands"
          )
        ).rows[0]?.count
      ).toBe(0);
      await holder.query("select id from projects where id=$1 for share", [
        projectId
      ]);
      await holder.query("commit");
    } catch (error) {
      await holder.query("rollback");
      throw error;
    } finally {
      holder.release();
    }
    expect((await tick()).dispatched).toBe(1);
    const rows = await pool.query<{ command_id: string; count: string }>(
      `select min(dispatch.managed_command_id::text) as command_id,
         count(*)::text as count
       from scheduled_job_attempt_dispatch_bindings dispatch
        join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
       where attempt.run_id=$1`,
      [run.id]
    );
    expect(rows.rows[0]?.count).toBe("1");
    const commandId = rows.rows[0]!.command_id;
    expect(
      await managed.listQueuedScheduledJobCommands(actor, {
        deviceId: device,
        deploymentId: deployment,
        limit: 10
      })
    ).toContain(commandId);
    const claimInput = {
      ownerUserId: owner,
      runnerId: "local-runner",
      deviceId: device,
      deploymentId: deployment,
      limit: 10,
      leaseMs: 30_000
    };
    expect(
      await managed.claimManagedConversationCommands({
        ...claimInput,
        allowedScheduledCommandIds: []
      })
    ).toEqual([]);
    expect(await managed.claimManagedConversationCommands(claimInput)).toEqual(
      []
    );
    expect(
      (
        await pool.query<{ state: string }>(
          "select state from managed_conversation_commands where id=$1",
          [commandId]
        )
      ).rows[0]?.state
    ).toBe("queued");
    expect(
      (
        await managed.claimManagedConversationCommands({
          ...claimInput,
          allowedScheduledCommandIds: [commandId]
        })
      ).map((item) => item.id)
    ).toContain(commandId);
    expect(
      (await jobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
        (item) => item.id === run.id
      )?.status
    ).toBe("running");
    expect((await tick()).dispatched).toBe(0);
    expect(
      (
        await pool.query(
          "select count(*)::int as count from managed_conversation_commands where id=$1",
          [commandId]
        )
      ).rows[0]?.count
    ).toBe(1);
    await pool.query(
      "update managed_conversation_commands set state='completed' where id=$1",
      [commandId]
    );
    await pool.query(
      "update managed_conversation_executions set state='quiesced' where id=$1",
      [executionId]
    );
    expect((await tick()).reconciled).toBe(1);
    expect(
      (await jobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
        (item) => item.id === run.id
      )?.status
    ).toBe("ok");
    expect((await tick()).reconciled).toBe(0);
    expect(
      (await jobs.attemptHistory(owner, job.id, run.id)).events.map(
        (event) => event.status
      )
    ).toEqual(["running", "ok"]);
    expect(
      (await managed.getManagedConversationExecution(actor, executionId))?.id
    ).toBe(executionId);
    await pool.query(
      "update managed_conversation_executions set state='running' where id=$1",
      [executionId]
    );
    const nextJob = await createJob();
    const nextRun = await jobs.runNow(
      owner,
      nextJob.id,
      nextJob.version,
      randomUUID()
    );
    expect((await tick()).dispatched).toBe(1);
    const nextCommand = (
      await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id from scheduled_job_attempt_dispatch_bindings dispatch
       join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
       where attempt.run_id=$1`,
        [nextRun.id]
      )
    ).rows[0]!.managed_command_id;
    await pool.query(
      `update managed_conversation_commands
       set state='dispatching',lease_token=$2,lease_expires_at=now()-interval '1 second',
           attempts=1 where id=$1`,
      [nextCommand, randomUUID()]
    );
    expect((await tick()).needsReview).toBe(1);
    expect(
      (await jobs.listRuns(owner, nextJob.id, { limit: 20 })).runs.find(
        (item) => item.id === nextRun.id
      )?.status
    ).toBe("interrupted");
    expect(
      (
        await pool.query<{ state: string }>(
          "select state from managed_conversation_commands where id=$1",
          [nextCommand]
        )
      ).rows[0]?.state
    ).toBe("indeterminate");
    expect((await tick()).needsReview).toBe(0);
  });

  it("stops a linked scheduled turn on Team authority loss and never resumes it on regrant", async () => {
    const workspaceProjectId = randomUUID();
    const linkedProjectId = (
      await pool.query<{ id: string }>(
        `insert into projects(owner_user_id,name,key,team_backend_id,
         team_workspace_id,workspace_project_id)
       values($1,'Linked routine','LINKED','team-vps',$2,$3) returning id`,
        [owner, randomUUID(), workspaceProjectId]
      )
    ).rows[0]!.id;
    const linkedSessionId = randomUUID();
    const linkedLogicalSessionId = (
      await pool.query<{ logical_session_id: string }>(
        `insert into sessions(id,owner_user_id,source_runtime,capture_method,
         automatic_personal_project_id)
       values($1,$2,'codex-cli','api',$3) returning logical_session_id`,
        [linkedSessionId, owner, linkedProjectId]
      )
    ).rows[0]!.logical_session_id;
    let teamAvailable = true;
    const teamAuthority = async () => {
      if (!teamAvailable) throw new Error("Team membership was revoked");
      return { projectVersion: 7, memberVersion: 3 };
    };
    const linkedJobs = createScheduledJobRepository(pool, { teamAuthority });
    const executionId = randomUUID();
    await pool.query(
      `insert into managed_conversation_executions
         (id,owner_user_id,project_id,provider,ai_client_instance_id,model,
          permission_mode,runner_kind,state,fencing_token_hash,runner_deployment_id,
          runner_device_id,logical_session_id,provider_thread_id)
       values($1,$2,$3,'codex','codex.jobs','gpt-test','supervised','local_device',
          'running',$4,$5,$6,$7,'linked-private-thread')`,
      [
        executionId,
        owner,
        linkedProjectId,
        "b".repeat(64),
        deployment,
        device,
        linkedLogicalSessionId
      ]
    );
    await pool.query(
      `insert into managed_conversation_runtime_bindings
         (execution_id,owner_user_id,deployment_id,device_id,execution_generation,
          source_project_path,project_path)
       values($1,$2,$3,$4,1,'/tmp/hq602-linked','/tmp/hq602-linked')`,
      [executionId, owner, deployment, device]
    );
    const job = await linkedJobs.create(owner, device, {
      requestId: randomUUID(),
      agentId,
      conversationSessionId: linkedSessionId,
      projectId: linkedProjectId,
      title: "Linked brief",
      instruction: "Read my private plan",
      schedule: { kind: "daily", at: "09:00", tz: "Europe/Oslo" }
    });
    const run = await linkedJobs.runNow(
      owner,
      job.id,
      job.version,
      randomUUID()
    );
    const runTick = () =>
      tickScheduledJobs(
        {
          jobs: linkedJobs,
          managed,
          agents,
          teamAuthority
        },
        { ownerUserId: owner, deviceId: device, deploymentId: deployment },
        new Date(0)
      );
    expect((await runTick()).dispatched).toBe(1);
    const oldCommandId = (
      await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id from scheduled_job_attempt_dispatch_bindings dispatch
         join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
         where attempt.run_id=$1`,
        [run.id]
      )
    ).rows[0]!.managed_command_id;
    const oldLease = randomUUID();
    await pool.query(
      `update managed_conversation_commands
       set state='dispatching',lease_token=$2,lease_expires_at=now()+interval '1 minute',
           attempts=1,sequence=1 where id=$1`,
      [oldCommandId, oldLease]
    );
    await pool.query(
      `update managed_conversation_executions
       set runner_id='linked-runner',runner_lease_expires_at=now()+interval '1 minute'
       where id=$1`,
      [executionId]
    );
    // A historical interrupt cannot release a later uncertain scheduled turn.
    await pool.query(
      `insert into managed_conversation_commands
       (owner_user_id,execution_id,idempotency_key,sequence,command_kind,
        request_digest,execution_generation,state,result,created_at,completed_at)
       values($1,$2,$3,0,'interrupt',$4,1,'completed',
         jsonb_build_object('providerQuiesced',true,'scheduledRecoveryCommandId',$5::text),
         now()-interval '2 minutes',now()-interval '1 minute')`,
      [owner, executionId, randomUUID(), "a".repeat(64), oldCommandId]
    );
    // The User can queue the recovery control while the old turn is active.
    // It must still be usable when processed after authority becomes unknown.
    const control = await managed.enqueueManagedConversationControl(actor, {
      executionId,
      executionGeneration: 1,
      idempotencyKey: randomUUID(),
      commandKind: "interrupt"
    });
    teamAvailable = false;
    expect((await runTick()).reconciled).toBe(0);
    expect(
      (await linkedJobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
        (item) => item.id === run.id
      )?.status
    ).toBe("interrupted");
    const history = await linkedJobs.attemptHistory(owner, job.id, run.id);
    expect(history.events.at(-1)).toMatchObject({
      status: "interrupted",
      uncertainty: true,
      outcome:
        "Scheduled Job authority could not be verified; effects require review"
    });
    teamAvailable = true;
    expect((await runTick()).dispatched).toBe(0);
    expect(
      (await linkedJobs.attemptHistory(owner, job.id, run.id)).attempts
    ).toHaveLength(1);
    expect(
      await managed.hasActiveScheduledJobDispatchForExecution(
        actor,
        executionId
      )
    ).toBe(true);
    expect(
      await linkedJobs.getActiveScheduledCommandForExecution(owner, executionId)
    ).toBe(oldCommandId);
    const next = await managed.enqueueManagedConversationPrompt(actor, {
      executionId,
      executionGeneration: 1,
      idempotencyKey: randomUUID(),
      clientUserMessageId: randomUUID(),
      prompt: "Continue this private conversation"
    });
    const claim = {
      ownerUserId: owner,
      runnerId: "linked-runner",
      deviceId: device,
      deploymentId: deployment,
      limit: 10,
      leaseMs: 30_000
    };
    expect(await managed.claimManagedConversationCommands(claim)).toEqual([]);
    expect(
      await linkedJobs.releaseInterruptedManagedCommandAfterProviderAck(
        owner,
        oldCommandId,
        device
      )
    ).toBe(false);
    const controlClaim = (
      await managed.claimManagedConversationControlCommands(claim)
    ).find((item) => item.id === control.id)!;
    expect(controlClaim).toBeDefined();
    expect(
      await managed.completeManagedConversationCommand({
        commandId: control.id,
        leaseToken: controlClaim.leaseToken!,
        result: {
          interrupted: true,
          turnId: "old-turn",
          providerQuiesced: true,
          scheduledRecoveryCommandId: oldCommandId
        }
      })
    ).toBe(true);
    await pool.query(
      "update managed_conversation_executions set state='reconciling' where id=$1",
      [executionId]
    );
    expect(
      await linkedJobs.releaseInterruptedManagedCommandAfterProviderAck(
        owner,
        oldCommandId,
        device
      )
    ).toBe(true);
    expect(
      await managed.hasActiveScheduledJobDispatchForExecution(
        actor,
        executionId
      )
    ).toBe(false);
    expect(
      (await managed.getManagedConversationExecution(actor, executionId))?.state
    ).toBe("running");
    expect(
      (await managed.claimManagedConversationCommands(claim)).map(
        (item) => item.id
      )
    ).toContain(next.id);
    // The old immutable attempt remains terminal despite later private work.
    await expect(
      linkedJobs.assertManagedCommandAuthority(owner, oldCommandId, device, [
        "dispatching"
      ])
    ).rejects.toThrow();
    expect(
      await managed.completeManagedConversationCommand({
        commandId: oldCommandId,
        leaseToken: oldLease,
        result: { forged: true }
      })
    ).toBe(false);
    // A post-claim authority read failure is not a confirmed AI Client
    // failure. Persist interruption even if the Team API remains unreachable.
    const refreshed = await linkedJobs.get(owner, job.id);
    const laterRun = await linkedJobs.runNow(
      owner,
      job.id,
      refreshed.version,
      randomUUID()
    );
    expect((await runTick()).dispatched).toBe(1);
    const laterCommandId = (
      await pool.query<{ managed_command_id: string }>(
        `select dispatch.managed_command_id from scheduled_job_attempt_dispatch_bindings dispatch
         join scheduled_job_attempts attempt on attempt.id=dispatch.attempt_id
         where attempt.run_id=$1`,
        [laterRun.id]
      )
    ).rows[0]!.managed_command_id;
    await pool.query(
      `update managed_conversation_commands
       set state='failed',attempts=1,last_error_code='ScheduledJobAuthorityUnavailable',
           completed_at=now() where id=$1`,
      [laterCommandId]
    );
    expect(
      await linkedJobs.listTerminalManagedCommands(owner, device, 100)
    ).toContain(laterCommandId);
    teamAvailable = false;
    expect((await runTick()).needsReview).toBe(1);
    expect(
      (await linkedJobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
        (item) => item.id === laterRun.id
      )?.status
    ).toBe("interrupted");
    expect(
      (await linkedJobs.attemptHistory(owner, job.id, laterRun.id)).events.at(
        -1
      )
    ).toMatchObject({ status: "interrupted", uncertainty: true });
    expect(
      (
        await pool.query<{ state: string }>(
          "select state from managed_conversation_commands where id=$1",
          [laterCommandId]
        )
      ).rows[0]?.state
    ).toBe("indeterminate");
  });
  it.each([
    [
      "disabled instance",
      "update ai_client_instances set enabled=false where owner_user_id=$1 and instance_id='codex.jobs'"
    ],
    [
      "changed provider",
      "update ai_client_instances set driver_id='pi' where owner_user_id=$1 and instance_id='codex.jobs'"
    ],
    [
      "changed permission",
      "update agents set default_permission_mode='auto_edit' where owner_user_id=$1 and id=$2"
    ],
    [
      "changed explicit model",
      "update agents set default_model='new-model' where owner_user_id=$1 and id=$2"
    ]
  ] as const)(
    "refuses a queued Job after %s",
    async (_case, mutation) => {
      const { job, run, commandId } = await createBoundRun();
      expect(
        await jobs.assertManagedCommandAuthority(owner, commandId, device, [
          "queued"
        ])
      ).toMatchObject({ scheduled: true });
      try {
        await pool.query(
          mutation,
          [owner, agentId].slice(0, mutation.includes("id=$2") ? 2 : 1)
        );
        await expect(
          jobs.assertManagedCommandAuthority(owner, commandId, device, [
            "queued"
          ])
        ).rejects.toThrow();
        expect((await tick()).needsReview).toBe(0);
        expect(
          (await jobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
            (item) => item.id === run.id
          )?.status
        ).toBe("interrupted");
        expect(
          (
            await pool.query<{ state: string }>(
              "select state from managed_conversation_commands where id=$1",
              [commandId]
            )
          ).rows[0]?.state
        ).toBe("canceled");
      } finally {
        await pool.query(
          "update ai_client_instances set enabled=true,driver_id='codex' where owner_user_id=$1 and instance_id='codex.jobs'",
          [owner]
        );
        await pool.query(
          "update agents set default_permission_mode='supervised',default_model=null where owner_user_id=$1 and id=$2",
          [owner, agentId]
        );
      }
    },
    120_000
  );

  it("fences a queued full-access turn when the Agent permission is reduced", async () => {
    await pool.query(
      "update agents set default_permission_mode='full_access' where owner_user_id=$1 and id=$2",
      [owner, agentId]
    );
    try {
      const { job, run, commandId } = await createBoundRun("full_access");
      await pool.query(
        "update agents set default_permission_mode='supervised' where owner_user_id=$1 and id=$2",
        [owner, agentId]
      );
      await expect(
        jobs.assertManagedCommandAuthority(owner, commandId, device, ["queued"])
      ).rejects.toThrow();
      await tick();
      expect(
        (await jobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
          (item) => item.id === run.id
        )?.status
      ).toBe("interrupted");
    } finally {
      await pool.query(
        "update agents set default_permission_mode='supervised' where owner_user_id=$1 and id=$2",
        [owner, agentId]
      );
    }
  }, 120_000);

  it("denies active renewal after Agent permission changes", async () => {
    const { job, run, commandId } = await createBoundRun();
    const [claim] = await managed.claimManagedConversationCommands({
      ownerUserId: owner,
      runnerId: "hq602-active-fence",
      deviceId: device,
      deploymentId: deployment,
      limit: 10,
      leaseMs: 30_000,
      allowedScheduledCommandIds: [commandId]
    });
    expect(claim?.id).toBe(commandId);
    try {
      await pool.query(
        "update agents set default_permission_mode='auto_edit' where owner_user_id=$1 and id=$2",
        [owner, agentId]
      );
      await expect(
        jobs.assertManagedCommandAuthority(owner, commandId, device, [
          "dispatching"
        ])
      ).rejects.toThrow();
      await expect(
        jobs.appendManagedCommandLease(
          owner,
          commandId,
          device,
          claim!.leaseToken!,
          "hq602-active-fence"
        )
      ).rejects.toThrow();
      expect((await tick()).needsReview).toBe(0);
      expect(
        (await jobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
          (item) => item.id === run.id
        )?.status
      ).toBe("interrupted");
      expect(
        (
          await pool.query<{ state: string }>(
            "select state from managed_conversation_commands where id=$1",
            [commandId]
          )
        ).rows[0]?.state
      ).toBe("indeterminate");
    } finally {
      await pool.query(
        "update agents set default_permission_mode='supervised' where owner_user_id=$1 and id=$2",
        [owner, agentId]
      );
    }
  }, 120_000);

  it("does not treat a broad caller state list as terminal authority", async () => {
    const { commandId, executionId } = await createBoundRun();
    const httpStates = [
      "queued",
      "dispatching",
      "completed",
      "failed",
      "indeterminate",
      "canceled"
    ];
    try {
      await pool.query(
        "update managed_conversation_commands set attempts=2 where id=$1",
        [commandId]
      );
      await expect(
        jobs.assertManagedCommandAuthority(owner, commandId, device, httpStates)
      ).rejects.toThrow();
      await pool.query(
        "update managed_conversation_commands set attempts=1 where id=$1",
        [commandId]
      );
      await pool.query(
        "update managed_conversation_executions set state='quiesced' where id=$1",
        [executionId]
      );
      await expect(
        jobs.assertManagedCommandAuthority(owner, commandId, device, httpStates)
      ).rejects.toThrow();
    } finally {
      await jobs.interruptScheduledAuthorityLoss(
        owner,
        commandId,
        device,
        "changed"
      );
    }
  }, 120_000);

  it("preserves a proven terminal outcome after later Agent changes", async () => {
    const { job, run, commandId, executionId } = await createBoundRun();
    await pool.query(
      "update managed_conversation_commands set state='completed' where id=$1",
      [commandId]
    );
    await pool.query(
      "update managed_conversation_executions set state='quiesced' where id=$1",
      [executionId]
    );
    try {
      await pool.query(
        "update ai_client_instances set enabled=false where owner_user_id=$1 and instance_id='codex.jobs'",
        [owner]
      );
      await pool.query(
        "update agents set default_permission_mode='auto_edit',default_model='new-model' where owner_user_id=$1 and id=$2",
        [owner, agentId]
      );
      expect(
        await jobs.assertManagedCommandAuthority(owner, commandId, device, [
          "completed"
        ])
      ).toMatchObject({ scheduled: true });
      expect((await tick()).reconciled).toBe(1);
      expect(
        (await jobs.listRuns(owner, job.id, { limit: 20 })).runs.find(
          (item) => item.id === run.id
        )?.status
      ).toBe("ok");
    } finally {
      await pool.query(
        "update ai_client_instances set enabled=true where owner_user_id=$1 and instance_id='codex.jobs'",
        [owner]
      );
      await pool.query(
        "update agents set default_permission_mode='supervised',default_model=null where owner_user_id=$1 and id=$2",
        [owner, agentId]
      );
    }
  }, 120_000);
});
