import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type CreateRecurringAgentTask,
  type UpdateRecurringAgentTask
} from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createMemorySourceRepository } from "./repository.js";

const baseUrl = process.env.RECURRING_AGENT_TASK_TEST_DATABASE_URL;
const databaseName = `koed_recurring_tasks_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!baseUrl)(
  "Recurring Agent task authority (disposable PostgreSQL)",
  () => {
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
    let repository: ReturnType<typeof createMemorySourceRepository>;
    let ownerId: string;
    let agentId: string;
    let deviceId: string;
    let deploymentA: string;
    let deploymentB: string;
    const agentAlias = "selected-instance";
    const canonicalA = "canonical-instance-a";
    const canonicalB = "canonical-instance-b";
    const actor = () => ({ userId: ownerId });
    const launch = (
      targetDeploymentId: string,
      canonicalAiClientInstanceId: string
    ) => ({
      targetDeploymentId,
      canonicalAiClientInstanceId
    });
    const taskFields = () => ({
      title: "Weekly check-in",
      prompt: "Review the current project status.",
      schedule: {
        kind: "interval" as const,
        everyMinutes: 5,
        anchorAt: new Date(Date.now() - 60_000).toISOString()
      },
      context: { projectId: null, contextKind: "independent" as const },
      execution: {
        provider: "codex" as const,
        aiClientInstanceId: agentAlias,
        targetDeviceId: deviceId,
        model: "test-model",
        reasoningEffort: null,
        permissionMode: "supervised" as const
      }
    });
    const definition = (requestId: string): CreateRecurringAgentTask => ({
      ...taskFields(),
      requestId
    });
    const updateDefinition = (
      expectedRevision: number
    ): UpdateRecurringAgentTask => ({
      ...taskFields(),
      expectedRevision
    });

    beforeAll(async () => {
      if (!admin || !pool)
        throw new Error("Disposable test database URL unavailable");
      await admin.connect();
      connected = true;
      await admin.query(`create database "${databaseName}"`);
      await runDbMigrations(pool);
      ownerId = randomUUID();
      deviceId = randomUUID();
      deploymentA = randomUUID();
      deploymentB = randomUUID();
      await pool.query(
        "insert into users(id,email,display_name) values($1,$2,$3)",
        [ownerId, `${ownerId}@recurring-task.invalid`, "Recurring task owner"]
      );
      repository = createMemorySourceRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      });
      const agent = await repository.createPersonalAgent(actor(), {
        requestId: randomUUID(),
        name: "Schedule Agent",
        role: null,
        soulInstructions: "Test only.",
        instructionSource: "custom",
        defaultProvider: null,
        defaultModel: null
      });
      agentId = agent.agent.id;
    });

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

    it("resolves an idempotent create retry alongside an update without changing task identity", async () => {
      const input = definition(randomUUID());
      const created = await repository.createRecurringAgentTask(actor(), {
        agentId,
        input,
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      const edited = updateDefinition(created.revision);
      edited.title = "Updated schedule";

      const [retry, update] = await Promise.all([
        repository.createRecurringAgentTask(actor(), {
          agentId,
          input,
          validatedLaunch: launch(deploymentA, canonicalA)
        }),
        repository.updateRecurringAgentTask(actor(), {
          taskId: created.id,
          input: edited,
          validatedLaunch: launch(deploymentA, canonicalA)
        })
      ]);

      expect(retry.id).toBe(created.id);
      expect(update.id).toBe(created.id);
      const current = await repository.getRecurringAgentTask(
        actor(),
        created.id
      );
      expect(current?.revision).toBe(2);
      expect(current?.title).toBe("Updated schedule");
    });

    it("fences concurrent and expired reservation claims, then recovers a committed native delivery by request id", async () => {
      if (!pool) throw new Error("Disposable test database unavailable");
      const task = await repository.createRecurringAgentTask(actor(), {
        agentId,
        input: definition(randomUUID()),
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      expect(task.status).toBe("paused");
      expect(task.nextRunAt).toBeNull();
      expect(task.execution.aiClientInstanceId).toBe(agentAlias);

      const active = await repository.controlRecurringAgentTask(actor(), {
        taskId: task.id,
        input: {
          action: "resume",
          activationConsent: true,
          expectedRevision: task.revision
        },
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      expect(active.status).toBe("active");
      await expect(
        repository.controlRecurringAgentTask(actor(), {
          taskId: task.id,
          input: {
            action: "resume",
            activationConsent: true,
            expectedRevision: active.revision
          },
          validatedLaunch: launch(deploymentA, canonicalA)
        })
      ).rejects.toMatchObject({ code: "RECURRING_AGENT_TASK_ALREADY_ACTIVE" });
      expect(
        (await repository.getRecurringAgentTask(actor(), task.id))?.revision
      ).toBe(active.revision);
      await pool.query(
        "update recurring_agent_tasks set next_run_at=$3::timestamptz where id=$1 and owner_user_id=$2",
        [
          task.id,
          ownerId,
          task.schedule.kind === "interval"
            ? task.schedule.anchorAt
            : task.nextRunAt
        ]
      );
      const claimScope = {
        ownerUserId: ownerId,
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentA,
        runnerId: "recurring-test-runner-a",
        leaseMs: 1_000
      };
      const claims = await Promise.all([
        repository.claimNextDueRecurringAgentTaskOccurrence({
          ...claimScope,
          now: new Date(Date.now() - 3_000)
        }),
        repository.claimNextDueRecurringAgentTaskOccurrence({
          ...claimScope,
          runnerId: "recurring-test-runner-b",
          now: new Date(Date.now() - 3_000)
        })
      ]);
      const first = claims.find((value) => value !== null);
      expect(claims.filter(Boolean)).toHaveLength(1);
      if (!first) throw new Error("Expected a schedule reservation");
      expect(first.occurrence.id).toBe(first.occurrence.conversationId);
      const occurrenceIdentity = await pool.query<{
        request_id: string;
        conversation_id: string;
      }>(
        "select request_id,conversation_id from recurring_agent_task_occurrences where id=$1",
        [first.occurrence.id]
      );
      expect(occurrenceIdentity.rows[0]).toEqual({
        request_id: first.occurrence.id,
        conversation_id: first.occurrence.id
      });
      expect(first.launchSnapshot.aiClientInstanceId).toBe(agentAlias);
      expect(first.canonicalAiClientInstanceId).toBe(canonicalA);

      const reclaimedAt = new Date();
      const reclaimed =
        await repository.claimNextDueRecurringAgentTaskOccurrence({
          ...claimScope,
          runnerId: "recurring-test-runner-recovery",
          now: reclaimedAt
        });
      expect(reclaimed?.occurrence.id).toBe(first.occurrence.id);
      expect(reclaimed?.leaseToken).not.toBe(first.leaseToken);
      expect(
        await repository.settleRecurringAgentTaskOccurrence({
          ownerUserId: ownerId,
          occurrenceId: first.occurrence.id,
          outcome: "needs_review",
          runnerId: first.runnerId,
          leaseToken: first.leaseToken,
          now: new Date(reclaimedAt.getTime() + 1)
        })
      ).toBeNull();
      if (!reclaimed)
        throw new Error("Expected expired reservation to be reclaimed");
      const dispatchTime = new Date(reclaimedAt.getTime() + 50);
      expect(
        await repository.markRecurringAgentTaskOccurrenceSubmissionStarted({
          ownerUserId: ownerId,
          occurrenceId: reclaimed.occurrence.id,
          runnerId: reclaimed.runnerId,
          leaseToken: reclaimed.leaseToken,
          now: dispatchTime
        })
      ).toBe(true);
      expect(
        await repository.renewRecurringAgentTaskOccurrenceLease({
          ownerUserId: ownerId,
          occurrenceId: reclaimed.occurrence.id,
          runnerId: reclaimed.runnerId,
          leaseToken: reclaimed.leaseToken,
          leaseMs: 1_000,
          now: new Date(dispatchTime.getTime() + 50)
        })
      ).toBe(true);

      const native = await repository.submitPersonalAgentChatMessage(actor(), {
        conversationId: reclaimed.occurrence.conversationId,
        targetDeploymentId: deploymentA,
        requestId: reclaimed.occurrence.id,
        text: reclaimed.prompt,
        context: {
          projectId: reclaimed.context.projectId,
          contextKind: reclaimed.context.contextKind,
          targetDeviceId: reclaimed.targetDeviceId
        },
        recipients: [reclaimed.launchSnapshot]
      });
      const delivery = native.deliveries[0];
      if (!delivery)
        throw new Error("Expected the native Personal chat delivery");
      await pool.query(
        "update personal_agent_chat_deliveries set agent_version=agent_version+1 where owner_user_id=$1 and id=$2",
        [ownerId, delivery.id]
      );
      expect(
        await repository.linkRecurringAgentTaskOccurrenceNativeResult({
          ownerUserId: ownerId,
          occurrenceId: reclaimed.occurrence.id,
          requestId: reclaimed.occurrence.id,
          messageId: native.message.id,
          deliveryId: delivery.id,
          executionId: delivery.executionId,
          commandId: delivery.commandId
        })
      ).toBeNull();
      expect(
        await repository.settleRecurringAgentTaskOccurrence({
          ownerUserId: ownerId,
          occurrenceId: reclaimed.occurrence.id,
          deliveryId: delivery.id,
          executionId: delivery.executionId,
          outcome: "completed"
        })
      ).toBeNull();
      await pool.query(
        "update personal_agent_chat_deliveries set agent_version=agent_version-1 where owner_user_id=$1 and id=$2",
        [ownerId, delivery.id]
      );
      // The API lost its response: leave the recurring occurrence unlinked and let
      // the expired lease reconciliation discover the existing native idempotency row.
      const preExpiry =
        await repository.getNextRecurringAgentTaskOccurrenceForReconciliation({
          ownerUserId: ownerId,
          targetDeviceId: deviceId,
          targetDeploymentId: deploymentA
        });
      expect(preExpiry).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const recovered =
        await repository.getNextRecurringAgentTaskOccurrenceForReconciliation({
          ownerUserId: ownerId,
          targetDeviceId: deviceId,
          targetDeploymentId: deploymentA
        });
      expect(recovered?.nativeState).toBe("queued");
      expect(recovered?.nativeDeliveryId).toBe(delivery.id);
      const linked =
        await repository.linkRecurringAgentTaskOccurrenceNativeResult({
          ownerUserId: ownerId,
          occurrenceId: reclaimed.occurrence.id,
          requestId: reclaimed.occurrence.id,
          messageId: native.message.id,
          deliveryId: delivery.id,
          executionId: delivery.executionId,
          commandId: delivery.commandId
        });
      expect(linked?.status).toBe("dispatched");
      await pool.query(
        "update personal_agent_chat_deliveries set status='completed',completed_at=now(),updated_at=now() where owner_user_id=$1 and id=$2",
        [ownerId, delivery.id]
      );
      await pool.query(
        "update personal_agent_chat_turns set status='completed',updated_at=now() where owner_user_id=$1 and id=$2",
        [ownerId, delivery.turnId]
      );
      const complete =
        await repository.getNextRecurringAgentTaskOccurrenceForReconciliation({
          ownerUserId: ownerId,
          targetDeviceId: deviceId,
          targetDeploymentId: deploymentA
        });
      expect(complete?.nativeState).toBe("completed");
      const settled = await repository.settleRecurringAgentTaskOccurrence({
        ownerUserId: ownerId,
        occurrenceId: reclaimed.occurrence.id,
        deliveryId: delivery.id,
        executionId: delivery.executionId,
        outcome: "completed"
      });
      expect(settled?.status).toBe("completed");
    });

    it("requires an explicit rebinding before Run Now and preserves owner request identity", async () => {
      const task = await repository.createRecurringAgentTask(actor(), {
        agentId,
        input: definition(randomUUID()),
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      const updateInput = updateDefinition(task.revision);
      const updated = await repository.updateRecurringAgentTask(actor(), {
        taskId: task.id,
        input: updateInput,
        validatedLaunch: launch(deploymentB, canonicalB)
      });
      expect(updated.status).toBe("paused");
      expect(updated.revision).toBe(task.revision + 1);
      const requestId = randomUUID();
      await expect(
        repository.reserveRecurringAgentTaskRunNow(actor(), {
          taskId: task.id,
          input: { requestId, expectedRevision: updated.revision },
          validatedLaunch: launch(deploymentA, canonicalA)
        })
      ).rejects.toMatchObject({
        code: "RECURRING_AGENT_TASK_LAUNCH_BINDING_CHANGED"
      });
      const duplicateReservations = await Promise.all([
        repository.reserveRecurringAgentTaskRunNow(actor(), {
          taskId: task.id,
          input: { requestId, expectedRevision: updated.revision },
          validatedLaunch: launch(deploymentB, canonicalB)
        }),
        repository.reserveRecurringAgentTaskRunNow(actor(), {
          taskId: task.id,
          input: { requestId, expectedRevision: updated.revision },
          validatedLaunch: launch(deploymentB, canonicalB)
        })
      ]);
      expect(duplicateReservations.map((value) => value.id)).toEqual([
        requestId,
        requestId
      ]);
      const occurrence = duplicateReservations[0]!;
      expect(occurrence.id).toBe(requestId);
      expect(occurrence.conversationId).toBe(requestId);
      expect(
        await repository.claimNextDueRecurringAgentTaskOccurrence({
          ownerUserId: ownerId,
          targetDeviceId: deviceId,
          targetDeploymentId: deploymentA,
          runnerId: "old-deployment",
          leaseMs: 30_000
        })
      ).toBeNull();
      const claim = await repository.claimNextDueRecurringAgentTaskOccurrence({
        ownerUserId: ownerId,
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentB,
        runnerId: "new-deployment",
        leaseMs: 30_000
      });
      expect(claim?.occurrence.id).toBe(requestId);
      expect(claim?.canonicalAiClientInstanceId).toBe(canonicalB);
      if (!claim) throw new Error("Expected the validated Run Now reservation");
      const reviewed = await repository.settleRecurringAgentTaskOccurrence({
        ownerUserId: ownerId,
        occurrenceId: requestId,
        outcome: "needs_review",
        errorCode: "preflight_changed",
        runnerId: claim.runnerId,
        leaseToken: claim.leaseToken
      });
      expect(reviewed?.status).toBe("needs_review");
      const reviewTask = await repository.getRecurringAgentTask(
        actor(),
        task.id
      );
      expect(reviewTask?.status).toBe("needs_review");
      expect(reviewTask?.lastErrorCode).toBe("preflight_changed");
    });

    it("reclaims an expired paused Run Now without changing identity and blocks resume until it is canceled", async () => {
      if (!pool) throw new Error("Disposable test database unavailable");
      const task = await repository.createRecurringAgentTask(actor(), {
        agentId,
        input: definition(randomUUID()),
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      const requestId = randomUUID();
      const manual = await repository.reserveRecurringAgentTaskRunNow(actor(), {
        taskId: task.id,
        input: { requestId, expectedRevision: task.revision },
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      const claimScope = {
        ownerUserId: ownerId,
        targetDeviceId: deviceId,
        targetDeploymentId: deploymentA,
        leaseMs: 1_000
      };
      const first = await repository.claimNextDueRecurringAgentTaskOccurrence({
        ...claimScope,
        runnerId: "paused-run-now-first"
      });
      expect(first?.occurrence.id).toBe(manual.id);
      expect(first?.occurrence.trigger).toBe("manual");
      if (!first)
        throw new Error("Expected the paused Run Now to be claimable");
      const reclaimed =
        await repository.claimNextDueRecurringAgentTaskOccurrence({
          ...claimScope,
          runnerId: "paused-run-now-recovery",
          now: new Date(Date.parse(first.leaseExpiresAt) + 1)
        });
      expect(reclaimed?.occurrence.id).toBe(first.occurrence.id);
      expect(reclaimed?.leaseToken).not.toBe(first.leaseToken);
      if (!reclaimed)
        throw new Error("Expected the expired paused Run Now reservation");

      await expect(
        repository.controlRecurringAgentTask(actor(), {
          taskId: task.id,
          input: {
            action: "resume",
            activationConsent: true,
            expectedRevision: task.revision
          },
          validatedLaunch: launch(deploymentA, canonicalA)
        })
      ).rejects.toMatchObject({
        code: "RECURRING_AGENT_TASK_PRE_DISPATCH_PENDING"
      });
      const canceled = await repository.controlRecurringAgentTask(actor(), {
        taskId: task.id,
        input: { action: "pause", expectedRevision: task.revision }
      });
      expect(canceled.status).toBe("paused");
      expect(
        await repository.markRecurringAgentTaskOccurrenceSubmissionStarted({
          ownerUserId: ownerId,
          occurrenceId: requestId,
          runnerId: reclaimed.runnerId,
          leaseToken: reclaimed.leaseToken
        })
      ).toBe(false);
      const canceledPage = await repository.listRecurringAgentTaskOccurrences(
        actor(),
        {
          taskId: task.id
        }
      );
      expect(canceledPage.occurrences[0]?.status).toBe("canceled");

      const resumed = await repository.controlRecurringAgentTask(actor(), {
        taskId: task.id,
        input: {
          action: "resume",
          activationConsent: true,
          expectedRevision: canceled.revision
        },
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      expect(resumed.status).toBe("active");
      await pool.query(
        "update recurring_agent_tasks set next_run_at=$2::timestamptz where id=$1 and owner_user_id=$3",
        [
          task.id,
          task.schedule.kind === "interval"
            ? task.schedule.anchorAt
            : task.nextRunAt,
          ownerId
        ]
      );
      const scheduled =
        await repository.claimNextDueRecurringAgentTaskOccurrence({
          ...claimScope,
          runnerId: "resumed-schedule"
        });
      expect(scheduled?.occurrence.trigger).toBe("scheduled");
    });

    it("retires active schedules transactionally without restoring paused or archived tasks", async () => {
      const retiringAgent = await repository.createPersonalAgent(actor(), {
        requestId: randomUUID(),
        name: "Retirement test Agent",
        role: null,
        soulInstructions: "Test only.",
        instructionSource: "custom",
        defaultProvider: null,
        defaultModel: null
      });
      const makeTask = async () =>
        repository.createRecurringAgentTask(actor(), {
          agentId: retiringAgent.agent.id,
          input: definition(randomUUID()),
          validatedLaunch: launch(deploymentA, canonicalA)
        });
      const active = await makeTask();
      const paused = await makeTask();
      const archived = await makeTask();
      await repository.controlRecurringAgentTask(actor(), {
        taskId: active.id,
        input: {
          action: "resume",
          activationConsent: true,
          expectedRevision: active.revision
        },
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      await repository.controlRecurringAgentTask(actor(), {
        taskId: archived.id,
        input: { action: "archive", expectedRevision: archived.revision }
      });
      const manual = await repository.reserveRecurringAgentTaskRunNow(actor(), {
        taskId: paused.id,
        input: { requestId: randomUUID(), expectedRevision: paused.revision },
        validatedLaunch: launch(deploymentA, canonicalA)
      });
      expect(manual.status).toBe("reserved");

      const retired = await repository.retirePersonalAgent({
        actor: actor(),
        agentId: retiringAgent.agent.id,
        requestId: randomUUID(),
        expectedVersion: retiringAgent.agent.currentVersion
      });
      expect(retired?.lifecycle).toBe("retired");
      expect(
        (await repository.getRecurringAgentTask(actor(), active.id))?.status
      ).toBe("needs_review");
      expect(
        (await repository.getRecurringAgentTask(actor(), paused.id))?.status
      ).toBe("paused");
      expect(
        (await repository.getRecurringAgentTask(actor(), archived.id))?.status
      ).toBe("archived");
      const canceledManual = await repository.listRecurringAgentTaskOccurrences(
        actor(),
        {
          taskId: paused.id
        }
      );
      expect(canceledManual.occurrences[0]?.status).toBe("canceled");

      const restored = await repository.restorePersonalAgent({
        actor: actor(),
        agentId: retiringAgent.agent.id,
        requestId: randomUUID(),
        expectedVersion: retiringAgent.agent.currentVersion
      });
      expect(restored?.lifecycle).toBe("active");
      expect(
        (await repository.getRecurringAgentTask(actor(), active.id))?.status
      ).toBe("needs_review");
    });
  }
);
