import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createPersonalAgentRepository } from "./personal-agent-repository.js";

const baseUrl = process.env.PERSONAL_AGENT_ACTIVITY_TEST_DATABASE_URL;
const databaseName = `koed_agent_activity_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!baseUrl)(
  "Personal Agent activity and history (PostgreSQL)",
  () => {
    const configuredUrl = baseUrl ? new URL(baseUrl) : null;
    const adminUrl = configuredUrl ? new URL(configuredUrl) : null;
    if (adminUrl) adminUrl.pathname = "/postgres";
    const testUrl = configuredUrl ? new URL(configuredUrl) : null;
    if (testUrl) testUrl.pathname = `/${databaseName}`;
    const admin = adminUrl
      ? new pg.Client({ connectionString: adminUrl.toString() })
      : null;
    const pool = testUrl
      ? new pg.Pool({ connectionString: testUrl.toString() })
      : null;
    let adminConnected = false;

    afterAll(async () => {
      await pool?.end();
      if (!admin || !adminConnected) return;
      try {
        await admin.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1",
          [databaseName]
        );
        await admin.query(`drop database if exists "${databaseName}"`);
      } finally {
        await admin.end();
      }
    });

    it("verifies only current leased attempts, isolates owners, and pages exact timestamp tuples", async () => {
      if (!admin || !pool) throw new Error("Test database URL is unavailable");
      await admin.connect();
      adminConnected = true;
      await admin.query(`create database "${databaseName}"`);
      await runDbMigrations(pool);

      const ownerId = randomUUID();
      const otherOwnerId = randomUUID();
      await pool.query(
        "insert into users (id, email, display_name) values ($1, $2, $3), ($4, $5, $6)",
        [
          ownerId,
          `${ownerId}@agent-activity.invalid`,
          "Activity Owner",
          otherOwnerId,
          `${otherOwnerId}@agent-activity.invalid`,
          "Other Owner"
        ]
      );
      const provider = createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      );
      const repository = createPersonalAgentRepository(pool, {
        envelopeEncryptionProvider: provider
      });
      const ownerActor = { userId: ownerId };
      const agent = await repository.createPersonalAgent(ownerActor, {
        requestId: randomUUID(),
        name: "Activity Agent",
        role: "Activity test",
        soulInstructions: "Keep this encrypted and never load it for activity.",
        instructionSource: "custom",
        defaultProvider: "codex",
        defaultModel: "gpt-test"
      });
      const otherAgent = await repository.createPersonalAgent(
        { userId: otherOwnerId },
        {
          requestId: randomUUID(),
          name: "Other Activity Agent",
          role: "Owner isolation test",
          soulInstructions: "Other owner's secret.",
          instructionSource: "custom",
          defaultProvider: "codex",
          defaultModel: "gpt-test"
        }
      );

      const insertJob = async (input: {
        jobId: string;
        executionId: string;
        commandId: string;
        attemptId: string;
        createdAt: string;
        generation: number;
        attemptGeneration?: number;
        commandState: "dispatching" | "completed";
        lease: string;
        projectId?: string;
        projectName?: string;
      }) => {
        const sessionId = randomUUID();
        const messageId = randomUUID();
        await pool.query(
          `insert into managed_conversation_executions (
         id, owner_user_id, project_id, provider, state, state_version,
           execution_generation, fencing_token_hash, runner_deployment_id,
           runner_device_id, runner_id, runner_lease_expires_at,
           logical_session_id, provider_thread_id, started_at,
           ai_client_instance_id, model, permission_mode, runner_kind
         ) values ($1, $2, 'activity-test-project', 'codex', 'running', 1,
                   $3, $4, $5, $6, 'activity-test-runner', $7, $8, $9, now(),
                   'codex.default', 'gpt-test', 'supervised', 'local_device')`,
          [
            input.executionId,
            ownerId,
            input.generation,
            "a".repeat(64),
            randomUUID(),
            randomUUID(),
            input.lease,
            sessionId,
            `thread-${input.executionId}`
          ]
        );
        const envelope = await provider.encrypt({
          plaintext: JSON.stringify({ prompt: `Goal ${input.jobId}` }),
          scope: {
            tenantId: ownerId,
            objectClass: "managed_conversation_command"
          },
          provenance: {
            rowFamily: "managed_conversation_command",
            sourceTable: "managed_conversation_commands",
            sourceId: input.commandId
          },
          ciphertextLocation: "managed_conversation_commands"
        });
        if (input.projectId && input.projectName) {
          await pool.query(
            `insert into sessions (
               owner_user_id, visibility, source_runtime, capture_method,
               logical_session_id, automatic_project_id, automatic_project_name,
               automatic_project_detected_at
             ) values ($1, 'personal', 'codex', 'api', $2, $3, $4, now())`,
            [ownerId, sessionId, input.projectId, input.projectName]
          );
        }
        await pool.query(
          `insert into managed_conversation_commands (
           id, owner_user_id, execution_id, idempotency_key, sequence,
           command_kind, client_user_message_id, execution_generation,
           request_digest, encrypted_payload, state
         ) values ($1, $2, $3, $4, 1, 'prompt', $5, $6, $7, $8, $9)`,
          [
            input.commandId,
            ownerId,
            input.executionId,
            input.commandId,
            messageId,
            input.attemptGeneration ?? input.generation,
            "b".repeat(64),
            envelope,
            input.commandState
          ]
        );
        await pool.query(
          `insert into personal_agent_execution_jobs (
           id, owner_user_id, conversation_id, command_id, attribution_kind,
           agent_id, agent_version, state, attempts_started, created_at,
           updated_at, project_id
         ) values ($1, $2, $3, $4, 'agent', $5, 1, 'running', 1, $6, $6, $7)`,
          [
            input.jobId,
            ownerId,
            input.executionId,
            input.commandId,
            agent.agent.id,
            input.createdAt,
            input.projectId ?? null
          ]
        );
        await pool.query(
          `insert into personal_agent_execution_attempts (
           id, owner_user_id, job_id, command_id, attempt_number,
           attribution_kind, agent_id, agent_version, provider, model,
           ai_client_instance_id, permission_mode, managed_execution_id,
           managed_execution_generation, status, started_at
         ) values ($1, $2, $3, $4, 1, 'agent', $5, 1, 'codex', 'gpt-test',
                   'codex.default', 'supervised', $6, $7, 'running', $8)`,
          [
            input.attemptId,
            ownerId,
            input.jobId,
            input.commandId,
            agent.agent.id,
            input.executionId,
            input.generation,
            input.createdAt
          ]
        );
      };

      const firstId = "11111111-1111-4111-8111-111111111111";
      const secondId = "22222222-2222-4222-8222-222222222222";
      const thirdId = "33333333-3333-4333-8333-333333333333";
      const firstExecutionId = randomUUID();
      await insertJob({
        jobId: firstId,
        executionId: firstExecutionId,
        commandId: randomUUID(),
        attemptId: randomUUID(),
        createdAt: "2026-09-30T10:00:00.000200Z",
        generation: 2,
        commandState: "dispatching",
        lease: "2099-01-01T00:00:00Z",
        projectId: "activity-project",
        projectName: "Review workspace"
      });
      await insertJob({
        jobId: secondId,
        executionId: randomUUID(),
        commandId: randomUUID(),
        attemptId: randomUUID(),
        createdAt: "2026-09-30T10:00:00.000200Z",
        generation: 2,
        attemptGeneration: 1,
        commandState: "dispatching",
        lease: "2099-01-01T00:00:00Z"
      });
      await insertJob({
        jobId: thirdId,
        executionId: randomUUID(),
        commandId: randomUUID(),
        attemptId: randomUUID(),
        createdAt: "2026-09-30T10:00:00.000100Z",
        generation: 1,
        commandState: "dispatching",
        lease: "2000-01-01T00:00:00Z"
      });

      const activity = await repository.getPersonalAgentActivity(ownerActor, {
        agentIds: [agent.agent.id, otherAgent.agent.id]
      });
      expect(activity).toEqual([
        expect.objectContaining({
          agentId: agent.agent.id,
          status: "running",
          freshness: "fresh",
          runningAttempts: 1,
          persistedRunningAttempts: 3,
          activeJobsCount: 1,
          activeJobs: [
            expect.objectContaining({ id: firstId, goal: `Goal ${firstId}` })
          ],
          projectSummary: {
            projects: [
              {
                id: "activity-project",
                name: "Review workspace",
                status: "active",
                startedAt: "2026-09-30T10:00:00.000Z"
              }
            ],
            count: 1,
            truncated: false
          }
        }),
        expect.objectContaining({
          agentId: otherAgent.agent.id,
          status: "unknown",
          availability: "unavailable",
          freshness: "unknown"
        })
      ]);

      await pool.query(
        `update managed_conversation_executions
         set runner_lease_expires_at = '2000-01-01T00:00:00Z'
         where id = $1 and owner_user_id = $2`,
        [firstExecutionId, ownerId]
      );
      const expiredActivity = await repository.getPersonalAgentActivity(
        ownerActor,
        { agentIds: [agent.agent.id] }
      );
      expect(expiredActivity[0]).toMatchObject({
        status: "unknown",
        availability: "available",
        freshness: "stale",
        runningAttempts: 0,
        persistedRunningAttempts: 3,
        activeJobs: [],
        activeJobsCount: 0
      });

      const firstPage = await repository.listPersonalAgentHistoryJobs(
        ownerActor,
        {
          agentId: agent.agent.id,
          limit: 2
        }
      );
      const otherAgentPage = await repository.listPersonalAgentHistoryJobs(
        ownerActor,
        { agentId: otherAgent.agent.id, limit: 20 }
      );
      const otherOwnerPage = await repository.listPersonalAgentHistoryJobs(
        { userId: otherOwnerId },
        { agentId: agent.agent.id, limit: 20 }
      );
      const secondPage = await repository.listPersonalAgentHistoryJobs(
        ownerActor,
        {
          agentId: agent.agent.id,
          limit: 2,
          before: firstPage.nextCursor ?? undefined
        }
      );
      expect(firstPage.jobs.map((job) => job.id)).toEqual([secondId, firstId]);
      expect(firstPage.hasMore).toBe(true);
      expect(secondPage.jobs.map((job) => job.id)).toEqual([thirdId]);
      expect(secondPage.hasMore).toBe(false);
      expect(otherAgentPage.jobs).toEqual([]);
      expect(otherOwnerPage.jobs).toEqual([]);
      expect([
        ...firstPage.jobs.map((job) => job.id),
        ...secondPage.jobs.map((job) => job.id)
      ]).toEqual([secondId, firstId, thirdId]);
      expect(firstPage.jobs[0]).toMatchObject({
        goal: `Goal ${secondId}`,
        agentName: "Activity Agent",
        attempts: [expect.objectContaining({ attemptNumber: 1 })]
      });

      for (let index = 0; index < 6; index += 1) {
        await insertJob({
          jobId: randomUUID(),
          executionId: randomUUID(),
          commandId: randomUUID(),
          attemptId: randomUUID(),
          createdAt: `2026-09-30T10:01:00.000${index}Z`,
          generation: 2,
          commandState: "completed",
          lease: "2000-01-01T00:00:00Z",
          projectId: `activity-project-${index}`,
          projectName: `Older workspace ${index}`
        });
      }
      const cappedProjectActivity = await repository.getPersonalAgentActivity(
        ownerActor,
        { agentIds: [agent.agent.id] }
      );
      expect(cappedProjectActivity[0]?.projectSummary).toMatchObject({
        count: 7,
        truncated: true
      });
      expect(cappedProjectActivity[0]?.projectSummary?.projects).toHaveLength(
        5
      );
    });
  }
);
