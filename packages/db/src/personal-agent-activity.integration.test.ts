import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import { afterAll, describe, expect, it } from "vitest";
import { upsertEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";
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

      const insertNativeDelivery = async (input: {
        deliveryId: string;
        status: "completed" | "running";
        createdAt: string;
        prompt: string;
        jobId?: string | null;
      }) => {
        const conversationId = randomUUID();
        const turnId = randomUUID();
        const messageId = randomUUID();
        const requestId = randomUUID();
        await pool.query(
          `insert into personal_agent_conversations
             (conversation_id, owner_user_id, active_agent_id)
           values ($1, $2, $3)`,
          [conversationId, ownerId, agent.agent.id]
        );
        await pool.query(
          `insert into personal_agent_chat_roots
             (conversation_id, owner_user_id, project_id, context_kind,
              target_device_id, target_deployment_id, workspace_id, title)
           values ($1, $2, null, 'independent', 'activity-device',
                   $3, $4, 'Native activity conversation')`,
          [conversationId, ownerId, randomUUID(), randomUUID()]
        );
        await pool.query(
          `insert into personal_agent_chat_turns
             (id, conversation_id, owner_user_id, request_id, request_digest,
              user_message_id, ordinal, status)
           values ($1, $2, $3, $4, $5, $6, 1, 'completed')`,
          [
            turnId,
            conversationId,
            ownerId,
            requestId,
            "c".repeat(64),
            messageId
          ]
        );
        await pool.query(
          `insert into personal_agent_chat_messages
             (id, conversation_id, owner_user_id, turn_id, sequence, kind,
              state, created_at)
           values ($1, $2, $3, $4, 1, 'user', 'completed', $5)`,
          [messageId, conversationId, ownerId, turnId, input.createdAt]
        );
        const client = await pool.connect();
        try {
          await upsertEncryptedFieldPayloadWithClient(
            client,
            ownerActor,
            provider,
            {
              sourceTable: "personal_agent_chat_messages",
              sourceId: messageId,
              sourceColumn: "body",
              plaintext: input.prompt,
              plaintextContentType: "text/plain",
              rowFamily: "personal_agent_chat_message",
              aad: { conversationId, messageId }
            }
          );
        } finally {
          client.release();
        }
        const launch = {
          kind: "agent",
          agentId: agent.agent.id,
          agentVersion: 1,
          provider: "codex",
          aiClientInstanceId: "codex.default",
          targetDeviceId: "activity-device",
          model: "gpt-test",
          reasoningEffort: null,
          permissionMode: "supervised",
          selectedResourceIds: []
        };
        await pool.query(
          `insert into personal_agent_chat_deliveries
             (id, conversation_id, owner_user_id, turn_id, message_id,
              recipient_kind, agent_id, agent_version, agent_name, ordinal,
              launch_snapshot, job_id, status, started_at, completed_at,
              created_at, updated_at)
           values ($1, $2, $3, $4, $5, 'agent', $6, 1, 'Activity Agent', 0,
                   $7::jsonb, $8, $9, $10, $11, $10, $12)`,
          [
            input.deliveryId,
            conversationId,
            ownerId,
            turnId,
            messageId,
            agent.agent.id,
            JSON.stringify(launch),
            input.jobId ?? null,
            input.status,
            input.createdAt,
            input.status === "completed" ? input.createdAt : null,
            input.createdAt
          ]
        );
        return { conversationId, deliveryId: input.deliveryId };
      };

      const nativeDeliveryId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const linkedDeliveryId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const staleDeliveryId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const nativeConversation = await insertNativeDelivery({
        deliveryId: nativeDeliveryId,
        status: "completed",
        createdAt: "2026-10-04T10:00:00.000Z",
        prompt: "Review the encrypted native conversation history"
      });
      await insertNativeDelivery({
        deliveryId: linkedDeliveryId,
        status: "completed",
        createdAt: "2026-10-02T10:00:00.000Z",
        prompt: "This delivery is already represented by a Job",
        jobId: secondId
      });
      await insertNativeDelivery({
        deliveryId: staleDeliveryId,
        status: "running",
        createdAt: "2026-10-03T10:00:00.000Z",
        prompt: "This persisted delivery has no current execution lease"
      });

      const nativeFirstPage = await repository.listPersonalAgentHistoryJobs(
        ownerActor,
        { agentId: agent.agent.id, limit: 2 }
      );
      expect(nativeFirstPage.jobs[0]).toMatchObject({
        id: nativeDeliveryId,
        conversationId: nativeConversation.conversationId,
        title: "Review the encrypted native conversation history",
        goal: "Review the encrypted native conversation history",
        state: "succeeded",
        attribution: {
          kind: "agent",
          agentId: agent.agent.id,
          agentVersion: 1
        },
        executionSettings: {
          provider: "codex",
          model: "gpt-test",
          aiClientInstanceId: "codex.default",
          reasoningEffort: null,
          permissionMode: "supervised"
        },
        attempts: [],
        latestAttempt: null
      });
      expect(
        nativeFirstPage.jobs.some((job) => job.id === linkedDeliveryId)
      ).toBe(false);
      const nativePages = [nativeFirstPage];
      let nextCursor = nativeFirstPage.nextCursor;
      while (nextCursor) {
        const page = await repository.listPersonalAgentHistoryJobs(ownerActor, {
          agentId: agent.agent.id,
          limit: 2,
          before: nextCursor
        });
        nativePages.push(page);
        nextCursor = page.nextCursor;
      }
      const combinedIds = nativePages.flatMap((page) =>
        page.jobs.map((job) => job.id)
      );
      expect(combinedIds.filter((id) => id === nativeDeliveryId)).toHaveLength(
        1
      );
      expect(combinedIds).toContain(firstId);
      expect(combinedIds).toContain(secondId);
      expect(combinedIds).not.toContain(linkedDeliveryId);
      expect(
        (
          await repository.listPersonalAgentHistoryJobs(
            { userId: otherOwnerId },
            { agentId: agent.agent.id, limit: 20 }
          )
        ).jobs
      ).toEqual([]);

      const jobCountBeforeRead = await pool.query<{ count: string }>(
        `select count(*)::text as count from personal_agent_execution_jobs
          where owner_user_id = $1 and agent_id = $2`,
        [ownerId, agent.agent.id]
      );
      const nativeDetail = await repository.getPersonalAgent(
        ownerActor,
        agent.agent.id
      );
      expect(nativeDetail?.history.jobs.map((job) => job.id)).toContain(
        nativeDeliveryId
      );
      expect(nativeDetail?.history.stats.totalJobs).toBe(11);
      expect(nativeDetail?.history.stats.jobs_succeeded).toBe(1);
      expect(nativeDetail?.soulInstructions).toBe("");
      const jobCountAfterRead = await pool.query<{ count: string }>(
        `select count(*)::text as count from personal_agent_execution_jobs
          where owner_user_id = $1 and agent_id = $2`,
        [ownerId, agent.agent.id]
      );
      expect(jobCountAfterRead.rows[0]?.count).toBe(
        jobCountBeforeRead.rows[0]?.count
      );
      const activityWithNativeStaleDelivery =
        await repository.getPersonalAgentActivity(ownerActor, {
          agentIds: [agent.agent.id]
        });
      expect(activityWithNativeStaleDelivery[0]).toMatchObject({
        status: "unknown",
        freshness: "stale",
        // Nine legacy running attempt rows are persisted by the fixtures above,
        // and this stale native delivery contributes one more persisted item.
        persistedRunningAttempts: 10,
        runningAttempts: 0
      });

      const legacyVersion = await repository.getPersonalAgentVersion(
        ownerActor,
        {
          agentId: agent.agent.id,
          version: 1
        }
      );
      expect(legacyVersion?.soulInstructions).toBe(
        "Keep this encrypted and never load it for activity."
      );
      const metadataOnlyAgent = await repository.createPersonalAgent(
        ownerActor,
        {
          requestId: randomUUID(),
          name: "Appearance Only Agent",
          role: "",
          soulInstructions: "",
          instructionSource: "generated",
          defaultProvider: null,
          defaultModel: null
        }
      );
      expect(metadataOnlyAgent.soulInstructions).toBe("");
      const metadataOnlyVersion = await repository.getPersonalAgentVersion(
        ownerActor,
        {
          agentId: metadataOnlyAgent.agent.id,
          version: 1
        }
      );
      expect(metadataOnlyVersion).toMatchObject({
        soulInstructions: "",
        role: ""
      });
      const metadataSoulPayload = await pool.query<{ count: string }>(
        `select count(*)::text as count from encrypted_field_payloads
          where owner_user_id = $1
            and source_table = 'personal_agent_identity_versions'
            and source_id = $2 and source_column = 'soul_instructions'
            and invalidated_at is null`,
        [ownerId, metadataOnlyVersion?.id]
      );
      expect(metadataSoulPayload.rows[0]?.count).toBe("0");
    });
  }
);
