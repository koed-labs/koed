import { randomUUID } from "node:crypto";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { createPersonalAgentRepository } from "../src/personal-agent-repository.js";

const databaseUrl =
  process.env.PERSONAL_AGENT_ATTEMPT_TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Personal Agent attempt command idempotency", () => {
  let pool: pg.Pool;
  let repository: ReturnType<typeof createPersonalAgentRepository>;
  const ownerId = randomUUID();
  const agentId = randomUUID();
  const executionId = randomUUID();
  const firstCommandId = randomUUID();
  const continuationCommandId = randomUUID();
  const jobId = randomUUID();
  const firstAttemptId = randomUUID();
  const startedAt = new Date("2026-09-30T12:00:00.000Z");

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    await runDbMigrations(pool);
    repository = createPersonalAgentRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        Buffer.alloc(32, 57).toString("base64")
      )
    });

    await pool.query(
      `insert into users(id,email,display_name)
       values($1,$2,'Attempt owner')`,
      [ownerId, `${ownerId}@example.test`]
    );
    await pool.query(
      `insert into personal_agent_identities(
         id,owner_user_id,name,role,default_provider,default_model,current_version,
         creation_request_id,creation_request_fingerprint
       ) values($1,$2,'Review Agent','Private','codex','test-model',1,$3,$4)`,
      [agentId, ownerId, randomUUID(), "a".repeat(64)]
    );
    await pool.query(
      `insert into personal_agent_identity_versions(
         agent_id,owner_user_id,version,name,role,soul_instructions,
         instruction_source,created_by_user_id,request_id,request_fingerprint
       ) values($1,$2,1,'Review Agent','Private',
         '[koed encrypted personal agent soul]','custom',$2,$3,$4)`,
      [agentId, ownerId, randomUUID(), "b".repeat(64)]
    );
    await pool.query(
      `insert into managed_conversation_executions(
         id,owner_user_id,project_id,provider,state,execution_generation,
         fencing_token_hash,runner_deployment_id,runner_device_id,runner_id,
         runner_lease_expires_at,logical_session_id,provider_thread_id,started_at,
         ai_client_instance_id,model,permission_mode,runner_kind
       ) values($1,$2,'project-local','codex','running',1,$3,$4,$5,'runner',
         now()+interval '1 hour',$6,$7,now(),'codex.default','test-model',
         'supervised','local_device')`,
      [
        executionId,
        ownerId,
        "c".repeat(64),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        `thread-${randomUUID()}`
      ]
    );
    await pool.query(
      `insert into managed_conversation_commands(
         id,owner_user_id,execution_id,idempotency_key,sequence,command_kind,
         request_digest,client_user_message_id,execution_generation,
         encrypted_payload,state
       ) values
         ($1,$3,$4,'initial',1,'prompt',$5,$6,1,'{}'::jsonb,'completed'),
         ($2,$3,$4,'followup',2,'prompt',$5,$7,1,'{}'::jsonb,'dispatching')`,
      [
        firstCommandId,
        continuationCommandId,
        ownerId,
        executionId,
        "d".repeat(64),
        randomUUID(),
        randomUUID()
      ]
    );
    await pool.query(
      `insert into personal_agent_execution_jobs(
         id,owner_user_id,conversation_id,attribution_kind,agent_id,agent_version,
         state,attempts_started,attempts_succeeded,last_attempt_id,command_id,
         idempotency_key,title,project_id
       ) values($1,$2,$3,'agent',$4,1,'running',1,0,$5,$6,'job-key',
         'Reviewed work','project-local')`,
      [jobId, ownerId, executionId, agentId, firstAttemptId, firstCommandId]
    );
    await pool.query(
      `insert into personal_agent_execution_attempts(
         id,owner_user_id,job_id,command_id,attempt_number,attribution_kind,
         agent_id,agent_version,provider,model,ai_client_instance_id,
         permission_mode,managed_execution_id,managed_execution_generation,
         status,outcome,started_at,completed_at
       ) values($1,$2,$3,$4,1,'agent',$5,1,'codex','test-model',
         'codex.default','supervised',$6,1,'running',null,$7,null)`,
      [
        firstAttemptId,
        ownerId,
        jobId,
        firstCommandId,
        agentId,
        executionId,
        startedAt
      ]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a new attempt for a waiting Job follow-up and reuses it on command retry", async () => {
    const actor = { userId: ownerId };
    const firstOutput = {
      actor,
      jobId,
      attemptId: firstAttemptId,
      outputText: "First turn asks a question.",
      outputReference: { runtimeItemIds: [randomUUID()] },
      eventId: "reused-output-event"
    };
    await repository.recordPersonalAgentTurnOutput(firstOutput);
    await repository.completePersonalAgentExecutionAttempt({
      actor,
      jobId,
      attemptId: firstAttemptId,
      outcome: "succeeded",
      jobState: "waiting"
    });
    const input = {
      jobId,
      commandId: continuationCommandId,
      attemptNumber: 2,
      attribution: { kind: "agent" as const, agentId, agentVersion: 1 },
      provider: "codex",
      model: "test-model",
      aiClientInstanceId: "codex.default",
      reasoningEffort: null,
      permissionMode: "supervised" as const,
      managedExecutionId: executionId,
      managedExecutionGeneration: 1,
      status: "running" as const,
      outcome: null,
      startedAt: new Date("2026-09-30T12:01:00.000Z").toISOString(),
      completedAt: null
    };

    const followupAttempt =
      await repository.createPersonalAgentExecutionAttempt(actor, input);
    expect(followupAttempt).toMatchObject({
      jobId,
      commandId: continuationCommandId,
      attemptNumber: 2,
      status: "running"
    });
    expect(followupAttempt.id).not.toBe(firstAttemptId);

    const followupOutput = {
      actor,
      jobId,
      attemptId: followupAttempt.id,
      outputText: "Second turn completes the reviewed work.",
      outputReference: { runtimeItemIds: [randomUUID()] }
    };
    await expect(
      repository.recordPersonalAgentTurnOutput({
        ...followupOutput,
        eventId: "reused-output-event"
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await repository.recordPersonalAgentTurnOutput(followupOutput);

    await repository.completePersonalAgentExecutionAttempt({
      actor,
      jobId,
      attemptId: followupAttempt.id,
      outcome: "succeeded",
      jobState: "waiting"
    });

    const retry = await repository.createPersonalAgentExecutionAttempt(actor, {
      ...input,
      attemptNumber: 3,
      startedAt: new Date("2026-09-30T12:02:00.000Z").toISOString()
    });
    expect(retry).toMatchObject({
      id: followupAttempt.id,
      jobId,
      commandId: continuationCommandId,
      attemptNumber: 2,
      status: "succeeded",
      outcome: "succeeded"
    });

    await repository.recordPersonalAgentTurnOutput(followupOutput);
    const output = await repository.getPersonalAgentTurnOutput(actor, {
      jobId
    });
    expect(output).toBe(
      "First turn asks a question.\n\nSecond turn completes the reviewed work."
    );

    const counts = await pool.query<{
      attempts_started: number;
      attempt_count: string;
    }>(
      `select j.attempts_started,
              (select count(*)::text from personal_agent_execution_attempts a
                where a.owner_user_id=j.owner_user_id and a.job_id=j.id) as attempt_count
         from personal_agent_execution_jobs j where j.id=$1 and j.owner_user_id=$2`,
      [jobId, ownerId]
    );
    expect(counts.rows[0]).toEqual({ attempts_started: 2, attempt_count: "2" });
  });
});
