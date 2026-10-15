import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  createRecurringAgentTaskSchema,
  decryptEnvelopeToUtf8,
  latestDueRecurringAgentTask,
  nextRecurringAgentTaskAt,
  recurringAgentOccurrenceSchema,
  recurringAgentTaskControlSchema,
  recurringAgentTaskSchema,
  recurringAgentTaskRunNowSchema,
  updateRecurringAgentTaskSchema,
  type CreateRecurringAgentTask,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type RecurringAgentOccurrence,
  type RecurringAgentOccurrencePage,
  type RecurringAgentSchedule,
  type RecurringAgentTask,
  type RecurringAgentTaskContext,
  type RecurringAgentTaskControl,
  type RecurringAgentTaskExecution,
  type RecurringAgentTaskRunNow,
  type UpdateRecurringAgentTask
} from "@koed/shared";
import type { ActorContext } from "./types.js";

type Client = pg.Pool | pg.PoolClient;
type Envelope = EncryptedPayloadEnvelope;

interface TaskRow {
  id: string;
  owner_user_id: string;
  agent_id: string;
  title: string;
  schedule: RecurringAgentSchedule;
  target_device_id: string;
  target_deployment_id: string;
  encrypted_definition: Envelope;
  status: RecurringAgentTask["status"];
  revision: number;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_error_code: string | null;
  creation_request_id: string;
  creation_request_digest: string;
  created_at: Date;
  updated_at: Date;
}

interface OccurrenceRow {
  id: string;
  owner_user_id: string;
  task_id: string;
  task_revision: number;
  trigger: "scheduled" | "manual";
  scheduled_at: Date;
  status: RecurringAgentOccurrence["status"];
  conversation_id: string;
  request_id: string;
  target_device_id: string;
  target_deployment_id: string;
  agent_id: string;
  agent_version: number;
  encrypted_launch: Envelope;
  message_id: string | null;
  delivery_id: string | null;
  execution_id: string | null;
  command_id: string | null;
  error_code: string | null;
  write_dispatched: boolean;
  lease_token: string | null;
  lease_expires_at: Date | null;
  claimed_by_runner_id: string | null;
  reconciliation_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface StoredDefinition {
  prompt: string;
  context: RecurringAgentTaskContext;
  execution: RecurringAgentTaskExecution;
  targetDeploymentId: string;
  canonicalAiClientInstanceId: string;
}

interface FrozenLaunch extends StoredDefinition {
  taskId: string;
  taskRevision: number;
  agentId: string;
  agentVersion: number;
  launchSnapshot: {
    kind: "agent";
    agentId: string;
    agentVersion: number;
    provider: string;
    aiClientInstanceId: string;
    targetDeviceId: string;
    model: string;
    reasoningEffort: string | null;
    permissionMode: string;
    selectedResourceIds: string[];
  };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (code: string, message: string) =>
  Object.assign(new Error(message), { code, statusCode: 400 });
const conflict = (code: string, message: string) =>
  Object.assign(new Error(message), { code, statusCode: 409 });
const notFound = () =>
  Object.assign(new Error("Recurring Agent task was not found"), {
    code: "RECURRING_AGENT_TASK_NOT_FOUND",
    statusCode: 404
  });
const encryptionUnavailable = () =>
  Object.assign(new Error("Recurring Agent task encryption is unavailable"), {
    code: "RECURRING_AGENT_TASK_ENCRYPTION_UNAVAILABLE",
    statusCode: 503
  });
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;
const requireUuid = (value: string, label: string): string => {
  if (!UUID.test(value))
    throw invalid("RECURRING_AGENT_TASK_INVALID", `${label} is invalid`);
  return value;
};
const asTime = (value: string | Date | undefined, fallback: Date): Date => {
  if (value === undefined) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw invalid(
      "RECURRING_AGENT_TASK_INVALID_TIME",
      "A valid time is required"
    );
  return date;
};
const validatedBinding = (binding: ValidatedRecurringAgentLaunchBinding) => {
  const targetDeploymentId = requireUuid(
    binding.targetDeploymentId,
    "Target deployment id"
  );
  const canonicalAiClientInstanceId =
    binding.canonicalAiClientInstanceId.trim();
  if (!canonicalAiClientInstanceId || canonicalAiClientInstanceId.length > 128)
    throw invalid(
      "RECURRING_AGENT_TASK_INVALID_LAUNCH",
      "Validated AI Client instance is invalid"
    );
  return { targetDeploymentId, canonicalAiClientInstanceId };
};

export interface RecurringAgentTaskPage {
  tasks: RecurringAgentTask[];
  nextCursor: string | null;
}

export type RecurringAgentTaskOccurrencePage = RecurringAgentOccurrencePage;

export interface CreateRecurringAgentTaskInput {
  agentId: string;
  input: CreateRecurringAgentTask;
  validatedLaunch: ValidatedRecurringAgentLaunchBinding;
}

export interface UpdateRecurringAgentTaskInput {
  taskId: string;
  input: UpdateRecurringAgentTask;
  validatedLaunch: ValidatedRecurringAgentLaunchBinding;
}

export interface ControlRecurringAgentTaskInput {
  taskId: string;
  input: RecurringAgentTaskControl;
  validatedLaunch?: ValidatedRecurringAgentLaunchBinding;
}

export interface ValidatedRecurringAgentLaunchBinding {
  targetDeploymentId: string;
  canonicalAiClientInstanceId: string;
}

export interface RecurringAgentRunnerScope {
  ownerUserId: string;
  targetDeviceId: string;
  targetDeploymentId: string;
  runnerId: string;
  leaseMs: number;
  now?: string | Date;
}

export interface ClaimedRecurringAgentTaskOccurrence {
  occurrence: RecurringAgentOccurrence;
  ownerUserId: string;
  agentId: string;
  agentVersion: number;
  canonicalAiClientInstanceId: string;
  prompt: string;
  launchSnapshot: FrozenLaunch["launchSnapshot"];
  context: RecurringAgentTaskContext;
  targetDeviceId: string;
  targetDeploymentId: string;
  runnerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  writeDispatched: boolean;
}

export type RecurringNativeDeliveryState =
  | "missing"
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "uncertain"
  | "blocked"
  | "canceled"
  | "skipped";

export interface RecurringAgentOccurrenceReconciliation {
  occurrence: RecurringAgentOccurrence;
  nativeState: RecurringNativeDeliveryState;
  nativeMessageId: string | null;
  nativeDeliveryId: string | null;
  nativeExecutionId: string | null;
  nativeCommandId: string | null;
  nativeErrorCode: string | null;
}

export interface RecurringAgentTaskRepository {
  listRecurringAgentTasks(
    actor: ActorContext,
    input?: {
      agentId?: string;
      status?: RecurringAgentTask["status"];
      limit?: number;
      before?: string | null;
    }
  ): Promise<RecurringAgentTaskPage>;
  getRecurringAgentTask(
    actor: ActorContext,
    taskId: string
  ): Promise<RecurringAgentTask | null>;
  createRecurringAgentTask(
    actor: ActorContext,
    input: CreateRecurringAgentTaskInput
  ): Promise<RecurringAgentTask>;
  updateRecurringAgentTask(
    actor: ActorContext,
    input: UpdateRecurringAgentTaskInput
  ): Promise<RecurringAgentTask>;
  controlRecurringAgentTask(
    actor: ActorContext,
    input: ControlRecurringAgentTaskInput
  ): Promise<RecurringAgentTask>;
  listRecurringAgentTaskOccurrences(
    actor: ActorContext,
    input: { taskId: string; limit?: number; before?: string | null }
  ): Promise<RecurringAgentTaskOccurrencePage>;
  reserveRecurringAgentTaskRunNow(
    actor: ActorContext,
    input: {
      taskId: string;
      input: RecurringAgentTaskRunNow;
      validatedLaunch: ValidatedRecurringAgentLaunchBinding;
      now?: string | Date;
    }
  ): Promise<RecurringAgentOccurrence>;
  claimNextDueRecurringAgentTaskOccurrence(
    input: RecurringAgentRunnerScope
  ): Promise<ClaimedRecurringAgentTaskOccurrence | null>;
  renewRecurringAgentTaskOccurrenceLease(input: {
    ownerUserId: string;
    occurrenceId: string;
    runnerId: string;
    leaseToken: string;
    leaseMs: number;
    now?: string | Date;
  }): Promise<boolean>;
  markRecurringAgentTaskOccurrenceSubmissionStarted(input: {
    ownerUserId: string;
    occurrenceId: string;
    runnerId: string;
    leaseToken: string;
    now?: string | Date;
  }): Promise<boolean>;
  linkRecurringAgentTaskOccurrenceNativeResult(input: {
    ownerUserId: string;
    occurrenceId: string;
    requestId: string;
    messageId: string;
    deliveryId: string;
    executionId: string | null;
    commandId?: string | null;
  }): Promise<RecurringAgentOccurrence | null>;
  getNextRecurringAgentTaskOccurrenceForReconciliation(
    input: Pick<
      RecurringAgentRunnerScope,
      "ownerUserId" | "targetDeviceId" | "targetDeploymentId"
    >
  ): Promise<RecurringAgentOccurrenceReconciliation | null>;
  settleRecurringAgentTaskOccurrence(input: {
    ownerUserId: string;
    occurrenceId: string;
    deliveryId?: string | null;
    executionId?: string | null;
    outcome: "completed" | "needs_review" | "canceled";
    errorCode?: string | null;
    now?: string | Date;
    runnerId?: string;
    leaseToken?: string;
  }): Promise<RecurringAgentOccurrence | null>;
}

export const createRecurringAgentTaskRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider }
): RecurringAgentTaskRepository => {
  const provider = () => {
    if (!options.envelopeEncryptionProvider) throw encryptionUnavailable();
    return options.envelopeEncryptionProvider;
  };
  const encryptJson = async (
    ownerUserId: string,
    sourceTable: string,
    sourceId: string,
    sourceColumn: string,
    value: unknown
  ): Promise<Envelope> =>
    provider().encrypt({
      plaintext: JSON.stringify(value),
      scope: {
        tenantId: ownerUserId,
        objectClass: "personal_recurring_agent_task"
      },
      provenance: {
        rowFamily: "personal_recurring_agent_task",
        sourceTable,
        sourceId,
        sourceColumn
      },
      ciphertextLocation: `${sourceTable}.${sourceColumn}`,
      aad: { ownerUserId, sourceTable, sourceId, sourceColumn }
    });
  const decryptJson = async <T>(value: Envelope): Promise<T> =>
    JSON.parse(await decryptEnvelopeToUtf8(provider(), value)) as T;
  const encodeTask = async (row: TaskRow): Promise<RecurringAgentTask> => {
    const definition = await decryptJson<StoredDefinition>(
      row.encrypted_definition
    );
    return recurringAgentTaskSchema.parse({
      id: row.id,
      agentId: row.agent_id,
      title: row.title,
      prompt: definition.prompt,
      schedule: row.schedule,
      context: definition.context,
      execution: definition.execution,
      status: row.status,
      revision: row.revision,
      nextRunAt: iso(row.next_run_at),
      lastRunAt: iso(row.last_run_at),
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    });
  };
  const encodeOccurrence = (row: OccurrenceRow): RecurringAgentOccurrence =>
    recurringAgentOccurrenceSchema.parse({
      id: row.id,
      taskId: row.task_id,
      taskRevision: row.task_revision,
      trigger: row.trigger,
      scheduledAt: row.scheduled_at.toISOString(),
      status: row.status,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      deliveryId: row.delivery_id,
      executionId: row.execution_id,
      errorCode: row.error_code,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      completedAt: iso(row.completed_at)
    });
  const transaction = async <T>(
    callback: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  const readTaskRow = async (
    client: Client,
    ownerUserId: string,
    taskId: string,
    lock = false
  ): Promise<TaskRow | null> => {
    const result = await client.query<TaskRow>(
      `select * from recurring_agent_tasks
        where owner_user_id=$1 and id=$2${lock ? " for update" : ""}`,
      [ownerUserId, taskId]
    );
    return result.rows[0] ?? null;
  };
  const readCurrentAgent = async (
    client: Client,
    ownerUserId: string,
    agentId: string,
    lock = false
  ): Promise<{ lifecycle: string; current_version: number } | null> => {
    const result = await client.query<{
      lifecycle: string;
      current_version: number;
    }>(
      `select lifecycle,current_version from personal_agent_identities
        where owner_user_id=$1 and id=$2${lock ? " for share" : ""}`,
      [ownerUserId, agentId]
    );
    return result.rows[0] ?? null;
  };
  const definitionFor = (
    input: Pick<CreateRecurringAgentTask, "prompt" | "context" | "execution">,
    binding: ValidatedRecurringAgentLaunchBinding
  ): StoredDefinition => ({
    prompt: input.prompt,
    context: input.context,
    execution: input.execution,
    ...validatedBinding(binding)
  });
  const frozenLaunch = async (
    ownerUserId: string,
    row: TaskRow,
    task: RecurringAgentTask,
    agentVersion: number,
    occurrenceId: string
  ): Promise<{ encrypted: Envelope; launch: FrozenLaunch }> => {
    const definition = await decryptJson<StoredDefinition>(
      row.encrypted_definition
    );
    const launch: FrozenLaunch = {
      taskId: row.id,
      taskRevision: row.revision,
      agentId: row.agent_id,
      agentVersion,
      targetDeploymentId: definition.targetDeploymentId,
      canonicalAiClientInstanceId: definition.canonicalAiClientInstanceId,
      prompt: task.prompt,
      context: task.context,
      execution: task.execution,
      launchSnapshot: {
        kind: "agent",
        agentId: row.agent_id,
        agentVersion,
        provider: task.execution.provider,
        aiClientInstanceId: task.execution.aiClientInstanceId,
        targetDeviceId: task.execution.targetDeviceId,
        model: task.execution.model,
        reasoningEffort: task.execution.reasoningEffort,
        permissionMode: task.execution.permissionMode,
        selectedResourceIds: []
      }
    };
    return {
      encrypted: await encryptJson(
        ownerUserId,
        "recurring_agent_task_occurrences",
        occurrenceId,
        "encrypted_launch",
        launch
      ),
      launch
    };
  };
  const claimResult = async (
    client: Client,
    row: OccurrenceRow,
    runnerId: string,
    token: string,
    expiresAt: Date
  ): Promise<ClaimedRecurringAgentTaskOccurrence> => {
    const frozen = await decryptJson<FrozenLaunch>(row.encrypted_launch);
    if (!row.target_deployment_id)
      throw conflict(
        "RECURRING_AGENT_TASK_CLAIM_INVALID",
        "Occurrence is not bound to a deployment"
      );
    return {
      occurrence: encodeOccurrence(row),
      ownerUserId: row.owner_user_id,
      agentId: row.agent_id,
      agentVersion: row.agent_version,
      canonicalAiClientInstanceId: frozen.canonicalAiClientInstanceId,
      prompt: frozen.prompt,
      launchSnapshot: frozen.launchSnapshot,
      context: frozen.context,
      targetDeviceId: row.target_device_id,
      targetDeploymentId: row.target_deployment_id,
      runnerId,
      leaseToken: token,
      leaseExpiresAt: expiresAt.toISOString(),
      writeDispatched: row.write_dispatched
    };
  };

  return {
    async listRecurringAgentTasks(actor, input = {}) {
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw invalid(
          "RECURRING_AGENT_TASK_INVALID_PAGE",
          "Task page size is invalid"
        );
      if (input.agentId) requireUuid(input.agentId, "Agent id");
      if (input.before && !UUID.test(input.before))
        throw invalid(
          "RECURRING_AGENT_TASK_INVALID_CURSOR",
          "Task cursor is invalid"
        );
      const result = await pool.query<TaskRow>(
        `select t.* from recurring_agent_tasks t
          where t.owner_user_id=$1
            and ($2::uuid is null or t.agent_id=$2)
            and ($3::text is null or t.status=$3)
            and ($4::uuid is null or (t.updated_at,t.id) < (
              select cursor.updated_at,cursor.id from recurring_agent_tasks cursor
               where cursor.owner_user_id=$1 and cursor.id=$4
            ))
          order by t.updated_at desc,t.id desc limit $5`,
        [
          actor.userId,
          input.agentId ?? null,
          input.status ?? null,
          input.before ?? null,
          limit + 1
        ]
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const tasks = await Promise.all(rows.map(encodeTask));
      return { tasks, nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null };
    },

    async getRecurringAgentTask(actor, taskId) {
      requireUuid(taskId, "Task id");
      const row = await readTaskRow(pool, actor.userId, taskId);
      return row ? encodeTask(row) : null;
    },

    async createRecurringAgentTask(actor, request) {
      const agentId = requireUuid(request.agentId, "Agent id");
      const input = createRecurringAgentTaskSchema.parse(request.input);
      const binding = validatedBinding(request.validatedLaunch);
      const digest = hash({ agentId, definition: input, binding });
      return transaction(async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`recurring-agent-task:create:${actor.userId}:${input.requestId}`]
        );
        const existing = await client.query<TaskRow>(
          "select * from recurring_agent_tasks where owner_user_id=$1 and creation_request_id=$2 for update",
          [actor.userId, input.requestId]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].creation_request_digest !== digest)
            throw conflict(
              "RECURRING_AGENT_TASK_IDEMPOTENCY_CONFLICT",
              "Request id was already used for another task"
            );
          return encodeTask(existing.rows[0]);
        }
        const agent = await readCurrentAgent(
          client,
          actor.userId,
          agentId,
          true
        );
        if (!agent) throw notFound();
        if (agent.lifecycle !== "active")
          throw conflict(
            "PERSONAL_AGENT_RETIRED",
            "Restore this Agent before scheduling it"
          );
        const id = randomUUID();
        const definition = await encryptJson(
          actor.userId,
          "recurring_agent_tasks",
          id,
          "encrypted_definition",
          definitionFor(input, binding)
        );
        const inserted = await client.query<TaskRow>(
          `insert into recurring_agent_tasks
             (id,owner_user_id,agent_id,title,schedule,target_device_id,target_deployment_id,encrypted_definition,
              status,revision,next_run_at,creation_request_id,creation_request_digest)
           values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,'paused',1,null,$9,$10)
           returning *`,
          [
            id,
            actor.userId,
            agentId,
            input.title,
            JSON.stringify(input.schedule),
            input.execution.targetDeviceId,
            binding.targetDeploymentId,
            JSON.stringify(definition),
            input.requestId,
            digest
          ]
        );
        return encodeTask(inserted.rows[0]!);
      });
    },

    async updateRecurringAgentTask(actor, request) {
      const taskId = requireUuid(request.taskId, "Task id");
      const input = updateRecurringAgentTaskSchema.parse(request.input);
      const binding = validatedBinding(request.validatedLaunch);
      return transaction(async (client) => {
        const row = await readTaskRow(client, actor.userId, taskId, true);
        if (!row) throw notFound();
        if (row.revision !== input.expectedRevision)
          throw conflict(
            "RECURRING_AGENT_TASK_REVISION_CONFLICT",
            "Task changed; reload before editing"
          );
        if (row.status === "archived")
          throw conflict(
            "RECURRING_AGENT_TASK_ARCHIVED",
            "Archived tasks cannot be edited"
          );
        const agent = await readCurrentAgent(
          client,
          actor.userId,
          row.agent_id,
          true
        );
        if (!agent || agent.lifecycle !== "active")
          throw conflict(
            "PERSONAL_AGENT_RETIRED",
            "Restore this Agent before editing its schedule"
          );
        const encrypted = await encryptJson(
          actor.userId,
          "recurring_agent_tasks",
          taskId,
          "encrypted_definition",
          definitionFor(input, binding)
        );
        await client.query(
          `update recurring_agent_tasks set title=$3,schedule=$4::jsonb,target_device_id=$5,
             target_deployment_id=$6,encrypted_definition=$7::jsonb,status='paused',revision=revision+1,next_run_at=null,
             last_error_code=null,updated_at=now()
            where id=$1 and owner_user_id=$2`,
          [
            taskId,
            actor.userId,
            input.title,
            JSON.stringify(input.schedule),
            input.execution.targetDeviceId,
            binding.targetDeploymentId,
            JSON.stringify(encrypted)
          ]
        );
        await client.query(
          `update recurring_agent_task_occurrences set status='canceled',lease_token=null,
             lease_expires_at=null,claimed_by_runner_id=null,completed_at=now(),updated_at=now()
            where owner_user_id=$1 and task_id=$2 and status='reserved' and write_dispatched=false`,
          [actor.userId, taskId]
        );
        const updated = await readTaskRow(client, actor.userId, taskId);
        return encodeTask(updated!);
      });
    },

    async controlRecurringAgentTask(actor, request) {
      const taskId = requireUuid(request.taskId, "Task id");
      const input = recurringAgentTaskControlSchema.parse(request.input);
      const binding = request.validatedLaunch
        ? validatedBinding(request.validatedLaunch)
        : null;
      const now = new Date();
      return transaction(async (client) => {
        const row = await readTaskRow(client, actor.userId, taskId, true);
        if (!row) throw notFound();
        if (row.revision !== input.expectedRevision)
          throw conflict(
            "RECURRING_AGENT_TASK_REVISION_CONFLICT",
            "Task changed; reload before changing its state"
          );
        if (input.action === "archive" && row.status === "archived")
          return encodeTask(row);
        if (input.action === "pause" && row.status === "archived")
          throw conflict(
            "RECURRING_AGENT_TASK_ARCHIVED",
            "Archived tasks cannot be paused"
          );
        if (input.action === "resume" && row.status === "archived")
          throw conflict(
            "RECURRING_AGENT_TASK_ARCHIVED",
            "Archived tasks cannot be resumed"
          );
        if (input.action === "resume" && row.status === "active")
          throw conflict(
            "RECURRING_AGENT_TASK_ALREADY_ACTIVE",
            "This task is already active"
          );
        if (
          input.action === "resume" &&
          row.status === "needs_review" &&
          input.acknowledgeReview !== true
        ) {
          throw conflict(
            "RECURRING_AGENT_TASK_REVIEW_ACK_REQUIRED",
            "Acknowledge the previous run before resuming"
          );
        }
        if (input.action === "resume") {
          const pending = await client.query<{ id: string }>(
            `select id from recurring_agent_task_occurrences
              where owner_user_id=$1 and task_id=$2 and task_revision=$3
                and status='reserved' and write_dispatched=false
              order by created_at,id limit 1 for update`,
            [actor.userId, taskId, row.revision]
          );
          if (pending.rows[0])
            throw conflict(
              "RECURRING_AGENT_TASK_PRE_DISPATCH_PENDING",
              "Resolve the pending Run Now occurrence before resuming this schedule"
            );
          if (!binding)
            throw invalid(
              "RECURRING_AGENT_TASK_INVALID_LAUNCH",
              "Current launch validation is required to resume"
            );
          const saved = await decryptJson<StoredDefinition>(
            row.encrypted_definition
          );
          if (
            binding.targetDeploymentId !== row.target_deployment_id ||
            binding.canonicalAiClientInstanceId !==
              saved.canonicalAiClientInstanceId ||
            row.target_device_id !== saved.execution.targetDeviceId
          ) {
            throw conflict(
              "RECURRING_AGENT_TASK_LAUNCH_BINDING_CHANGED",
              "The saved AI Client or deployment changed; edit the task before resuming"
            );
          }
          const agent = await readCurrentAgent(
            client,
            actor.userId,
            row.agent_id,
            true
          );
          if (!agent || agent.lifecycle !== "active")
            throw conflict(
              "PERSONAL_AGENT_RETIRED",
              "Restore this Agent before resuming its schedule"
            );
          const nextRunAt = nextRecurringAgentTaskAt(
            row.schedule,
            now.getTime()
          );
          await client.query(
            `update recurring_agent_tasks set status='active',revision=revision+1,next_run_at=$3,
              last_error_code=null,updated_at=now() where id=$1 and owner_user_id=$2`,
            [taskId, actor.userId, nextRunAt]
          );
        } else {
          const status =
            input.action === "archive"
              ? "archived"
              : row.status === "needs_review"
                ? "needs_review"
                : "paused";
          await client.query(
            `update recurring_agent_tasks set status=$3,revision=revision+1,next_run_at=null,
              updated_at=now() where id=$1 and owner_user_id=$2`,
            [taskId, actor.userId, status]
          );
          await client.query(
            `update recurring_agent_task_occurrences set status='canceled',lease_token=null,
              lease_expires_at=null,claimed_by_runner_id=null,completed_at=now(),updated_at=now()
             where owner_user_id=$1 and task_id=$2 and status='reserved' and write_dispatched=false`,
            [actor.userId, taskId]
          );
        }
        const updated = await readTaskRow(client, actor.userId, taskId);
        return encodeTask(updated!);
      });
    },

    async listRecurringAgentTaskOccurrences(actor, input) {
      const taskId = requireUuid(input.taskId, "Task id");
      const limit = input.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw invalid(
          "RECURRING_AGENT_TASK_INVALID_PAGE",
          "Occurrence page size is invalid"
        );
      if (input.before && !UUID.test(input.before))
        throw invalid(
          "RECURRING_AGENT_TASK_INVALID_CURSOR",
          "Occurrence cursor is invalid"
        );
      if (!(await readTaskRow(pool, actor.userId, taskId))) throw notFound();
      const result = await pool.query<OccurrenceRow>(
        `select o.* from recurring_agent_task_occurrences o
          where o.owner_user_id=$1 and o.task_id=$2
            and ($3::uuid is null or (o.created_at,o.id) < (
              select cursor.created_at,cursor.id from recurring_agent_task_occurrences cursor
               where cursor.owner_user_id=$1 and cursor.task_id=$2 and cursor.id=$3
            ))
          order by o.created_at desc,o.id desc limit $4`,
        [actor.userId, taskId, input.before ?? null, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      return {
        occurrences: rows.map(encodeOccurrence),
        nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null
      };
    },

    async reserveRecurringAgentTaskRunNow(actor, request) {
      const taskId = requireUuid(request.taskId, "Task id");
      const input = recurringAgentTaskRunNowSchema.parse(request.input);
      const binding = validatedBinding(request.validatedLaunch);
      const now = asTime(request.now, new Date());
      return transaction(async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`recurring-agent-task:run-now:${actor.userId}:${input.requestId}`]
        );
        const resolveDuplicate = async (candidate: OccurrenceRow) => {
          if (
            candidate.task_id !== taskId ||
            candidate.task_revision !== input.expectedRevision ||
            candidate.trigger !== "manual"
          )
            throw conflict(
              "RECURRING_AGENT_TASK_IDEMPOTENCY_CONFLICT",
              "Request id was already used for another occurrence"
            );
          const frozen = await decryptJson<FrozenLaunch>(
            candidate.encrypted_launch
          );
          if (
            candidate.target_device_id !==
              frozen.launchSnapshot.targetDeviceId ||
            candidate.target_deployment_id !== binding.targetDeploymentId ||
            frozen.canonicalAiClientInstanceId !==
              binding.canonicalAiClientInstanceId
          ) {
            throw conflict(
              "RECURRING_AGENT_TASK_LAUNCH_BINDING_CHANGED",
              "The saved AI Client or deployment changed; edit the task before running it"
            );
          }
          return encodeOccurrence(candidate);
        };
        const existing = await client.query<OccurrenceRow>(
          "select * from recurring_agent_task_occurrences where owner_user_id=$1 and request_id=$2",
          [actor.userId, input.requestId]
        );
        if (existing.rows[0]) return resolveDuplicate(existing.rows[0]);
        const row = await readTaskRow(client, actor.userId, taskId, true);
        if (!row) throw notFound();
        const racedExisting = await client.query<OccurrenceRow>(
          "select * from recurring_agent_task_occurrences where owner_user_id=$1 and request_id=$2 for update",
          [actor.userId, input.requestId]
        );
        if (racedExisting.rows[0])
          return resolveDuplicate(racedExisting.rows[0]);
        if (row.revision !== input.expectedRevision)
          throw conflict(
            "RECURRING_AGENT_TASK_REVISION_CONFLICT",
            "Task changed; reload before running it"
          );
        if (row.status === "archived" || row.status === "needs_review")
          throw conflict(
            "RECURRING_AGENT_TASK_NOT_RUNNABLE",
            "Task must be active or paused and clear of review before Run Now"
          );
        const saved = await decryptJson<StoredDefinition>(
          row.encrypted_definition
        );
        if (
          binding.targetDeploymentId !== row.target_deployment_id ||
          binding.canonicalAiClientInstanceId !==
            saved.canonicalAiClientInstanceId ||
          row.target_device_id !== saved.execution.targetDeviceId
        ) {
          throw conflict(
            "RECURRING_AGENT_TASK_LAUNCH_BINDING_CHANGED",
            "The saved AI Client or deployment changed; edit the task before running it"
          );
        }
        const active = await client.query(
          "select 1 from recurring_agent_task_occurrences where task_id=$1 and status in ('reserved','dispatched') for update",
          [taskId]
        );
        if (active.rowCount)
          throw conflict(
            "RECURRING_AGENT_TASK_ALREADY_RUNNING",
            "This task already has an active occurrence"
          );
        const agent = await readCurrentAgent(
          client,
          actor.userId,
          row.agent_id,
          true
        );
        if (!agent || agent.lifecycle !== "active")
          throw conflict(
            "PERSONAL_AGENT_RETIRED",
            "Restore this Agent before running it"
          );
        const task = await encodeTask(row);
        const occurrenceId = input.requestId;
        const frozen = await frozenLaunch(
          actor.userId,
          row,
          task,
          agent.current_version,
          occurrenceId
        );
        const inserted = await client.query<OccurrenceRow>(
          `insert into recurring_agent_task_occurrences
             (id,owner_user_id,task_id,task_revision,trigger,scheduled_at,status,
              conversation_id,request_id,target_device_id,target_deployment_id,agent_id,
              agent_version,encrypted_launch)
           values ($1,$2,$3,$4,'manual',$5,'reserved',$1,$1,$6,$7,$8,$9,$10::jsonb)
           on conflict (owner_user_id,request_id) do nothing
           returning *`,
          [
            occurrenceId,
            actor.userId,
            taskId,
            row.revision,
            now,
            row.target_device_id,
            row.target_deployment_id,
            row.agent_id,
            agent.current_version,
            JSON.stringify(frozen.encrypted)
          ]
        );
        if (inserted.rows[0]) return encodeOccurrence(inserted.rows[0]);
        const duplicate = await client.query<OccurrenceRow>(
          "select * from recurring_agent_task_occurrences where owner_user_id=$1 and request_id=$2 for update",
          [actor.userId, input.requestId]
        );
        if (!duplicate.rows[0])
          throw conflict(
            "RECURRING_AGENT_TASK_CREATE_CONFLICT",
            "Run Now reservation could not be resolved"
          );
        return resolveDuplicate(duplicate.rows[0]);
      });
    },

    async claimNextDueRecurringAgentTaskOccurrence(scope) {
      const ownerUserId = requireUuid(scope.ownerUserId, "Owner id");
      const targetDeploymentId = requireUuid(
        scope.targetDeploymentId,
        "Deployment id"
      );
      if (!scope.targetDeviceId.trim() || !scope.runnerId.trim())
        throw invalid(
          "RECURRING_AGENT_TASK_INVALID_CLAIM",
          "Device and runner are required"
        );
      if (
        !Number.isInteger(scope.leaseMs) ||
        scope.leaseMs < 1_000 ||
        scope.leaseMs > 300_000
      )
        throw invalid(
          "RECURRING_AGENT_TASK_INVALID_LEASE",
          "Lease duration is invalid"
        );
      const now = asTime(scope.now, new Date());
      const leaseExpiresAt = new Date(now.getTime() + scope.leaseMs);
      return transaction(async (client) => {
        // A manual Run Now reserves identity before a runner is known. Bind that reservation once.
        const manualTask = await client.query<TaskRow>(
          `select t.* from recurring_agent_tasks t
            where t.owner_user_id=$1 and t.target_device_id=$2 and t.target_deployment_id=$3
              and t.status in ('paused','active') and exists (
                select 1 from recurring_agent_task_occurrences o
                 where o.task_id=t.id and o.owner_user_id=t.owner_user_id
                   and o.trigger='manual' and o.status='reserved' and o.write_dispatched=false
                   and o.lease_token is null)
            order by (select min(o.created_at) from recurring_agent_task_occurrences o
              where o.task_id=t.id and o.owner_user_id=t.owner_user_id
                and o.trigger='manual' and o.status='reserved' and o.lease_token is null),t.id
            limit 1 for update skip locked`,
          [ownerUserId, scope.targetDeviceId, targetDeploymentId]
        );
        if (manualTask.rows[0]) {
          const taskRow = manualTask.rows[0];
          const manual = await client.query<OccurrenceRow>(
            `select o.* from recurring_agent_task_occurrences o
            where o.owner_user_id=$1 and o.task_id=$2 and o.target_device_id=$3
              and o.target_deployment_id=$4 and o.trigger='manual'
              and o.status='reserved' and o.write_dispatched=false
              and o.lease_token is null and o.task_revision=$5
            order by o.created_at,o.id limit 1 for update skip locked`,
            [
              ownerUserId,
              taskRow.id,
              scope.targetDeviceId,
              targetDeploymentId,
              taskRow.revision
            ]
          );
          if (!manual.rows[0]) return null;
          const row = manual.rows[0];
          const agent = await readCurrentAgent(
            client,
            ownerUserId,
            row.agent_id,
            true
          );
          if (
            !agent ||
            agent.lifecycle !== "active" ||
            agent.current_version !== row.agent_version
          ) {
            await client.query(
              `update recurring_agent_task_occurrences set status='needs_review',error_code='agent_version_changed',
                completed_at=$2,updated_at=$2 where id=$1`,
              [row.id, now]
            );
            if (taskRow.status !== "archived")
              await client.query(
                `update recurring_agent_tasks set status='needs_review',revision=revision+1,next_run_at=null,
                last_error_code='agent_version_changed',updated_at=$3 where id=$1 and owner_user_id=$2`,
                [row.task_id, ownerUserId, now]
              );
            return null;
          }
          const token = randomUUID();
          const updated = await client.query<OccurrenceRow>(
            `update recurring_agent_task_occurrences set lease_token=$2,
                lease_expires_at=$3,claimed_by_runner_id=$4,updated_at=$5
              where id=$1 and status='reserved' and lease_token is null returning *`,
            [row.id, token, leaseExpiresAt, scope.runnerId, now]
          );
          return updated.rows[0]
            ? claimResult(
                client,
                updated.rows[0],
                scope.runnerId,
                token,
                leaseExpiresAt
              )
            : null;
        }

        // Reclaim only a reservation for which the durable submit-intent bit is still false.
        const expiredTask = await client.query<{ id: string }>(
          `select t.id from recurring_agent_tasks t
            join recurring_agent_task_occurrences o on o.task_id=t.id and o.owner_user_id=t.owner_user_id
           where t.owner_user_id=$1 and t.target_device_id=$2 and t.target_deployment_id=$3
             and o.target_device_id=$2 and o.target_deployment_id=$3
             and o.status='reserved' and o.write_dispatched=false and o.lease_expires_at <= $4
             and ((o.trigger='scheduled' and t.status='active') or (o.trigger='manual' and t.status in ('paused','active')))
             and t.revision=o.task_revision
           order by o.lease_expires_at,o.id limit 1 for update of t skip locked`,
          [ownerUserId, scope.targetDeviceId, targetDeploymentId, now]
        );
        if (expiredTask.rows[0]) {
          const taskRow = await readTaskRow(
            client,
            ownerUserId,
            expiredTask.rows[0].id,
            true
          );
          const selectedExpired = await client.query<OccurrenceRow>(
            `select * from recurring_agent_task_occurrences
              where owner_user_id=$1 and task_id=$2 and target_device_id=$3
                and target_deployment_id=$4 and status='reserved' and write_dispatched=false
                and lease_expires_at <= $5 limit 1 for update skip locked`,
            [
              ownerUserId,
              expiredTask.rows[0].id,
              scope.targetDeviceId,
              targetDeploymentId,
              now
            ]
          );
          const row = selectedExpired.rows[0];
          if (!taskRow || !row) return null;
          const agent = await readCurrentAgent(
            client,
            ownerUserId,
            row.agent_id,
            true
          );
          if (
            !taskRow ||
            !agent ||
            agent.lifecycle !== "active" ||
            agent.current_version !== row.agent_version
          ) {
            await client.query(
              `update recurring_agent_task_occurrences set status='needs_review',error_code='agent_version_changed',
                completed_at=$2,updated_at=$2 where id=$1`,
              [row.id, now]
            );
            if (taskRow && taskRow.status !== "archived")
              await client.query(
                `update recurring_agent_tasks set status='needs_review',revision=revision+1,next_run_at=null,
                last_error_code='agent_version_changed',updated_at=$3 where id=$1 and owner_user_id=$2`,
                [row.task_id, ownerUserId, now]
              );
            return null;
          }
          const token = randomUUID();
          const updated = await client.query<OccurrenceRow>(
            `update recurring_agent_task_occurrences set lease_token=$2,
                lease_expires_at=$3,claimed_by_runner_id=$4,updated_at=$5
              where id=$1 and status='reserved' and write_dispatched=false
                and lease_expires_at <= $5 returning *`,
            [row.id, token, leaseExpiresAt, scope.runnerId, now]
          );
          return updated.rows[0]
            ? claimResult(
                client,
                updated.rows[0],
                scope.runnerId,
                token,
                leaseExpiresAt
              )
            : null;
        }

        const tasks = await client.query<TaskRow>(
          `select t.* from recurring_agent_tasks t
            where t.owner_user_id=$1 and t.target_device_id=$2 and t.target_deployment_id=$3
              and t.status='active' and t.next_run_at <= $4
              and not exists (select 1 from recurring_agent_task_occurrences o
                where o.task_id=t.id and o.status in ('reserved','dispatched'))
            order by t.next_run_at,t.id limit 1 for update of t skip locked`,
          [ownerUserId, scope.targetDeviceId, targetDeploymentId, now]
        );
        const row = tasks.rows[0];
        if (!row) return null;
        const due = latestDueRecurringAgentTask(
          row.schedule,
          row.next_run_at!.toISOString(),
          now.getTime()
        );
        if (!due) return null;
        const agent = await readCurrentAgent(
          client,
          ownerUserId,
          row.agent_id,
          true
        );
        if (!agent || agent.lifecycle !== "active") {
          await client.query(
            `update recurring_agent_tasks set status='needs_review',revision=revision+1,next_run_at=null,
              last_error_code='agent_retired',updated_at=$3 where id=$1 and owner_user_id=$2`,
            [row.id, ownerUserId, now]
          );
          return null;
        }
        const task = await encodeTask(row);
        const occurrenceId = randomUUID();
        const frozen = await frozenLaunch(
          ownerUserId,
          row,
          task,
          agent.current_version,
          occurrenceId
        );
        const token = randomUUID();
        const inserted = await client.query<OccurrenceRow>(
          `insert into recurring_agent_task_occurrences
             (id,owner_user_id,task_id,task_revision,trigger,scheduled_at,status,
              conversation_id,request_id,target_device_id,target_deployment_id,agent_id,
              agent_version,encrypted_launch,lease_token,lease_expires_at,claimed_by_runner_id)
           values ($1,$2,$3,$4,'scheduled',$5,'reserved',$1,$1,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
           returning *`,
          [
            occurrenceId,
            ownerUserId,
            row.id,
            row.revision,
            due.scheduledAt,
            row.target_device_id,
            targetDeploymentId,
            row.agent_id,
            agent.current_version,
            JSON.stringify(frozen.encrypted),
            token,
            leaseExpiresAt,
            scope.runnerId
          ]
        );
        await client.query(
          `update recurring_agent_tasks set next_run_at=$3,updated_at=$4
            where id=$1 and owner_user_id=$2 and revision=$5`,
          [row.id, ownerUserId, due.nextRunAt, now, row.revision]
        );
        return claimResult(
          client,
          inserted.rows[0]!,
          scope.runnerId,
          token,
          leaseExpiresAt
        );
      });
    },

    async renewRecurringAgentTaskOccurrenceLease(request) {
      const ownerUserId = requireUuid(request.ownerUserId, "Owner id");
      const occurrenceId = requireUuid(request.occurrenceId, "Occurrence id");
      if (
        !Number.isInteger(request.leaseMs) ||
        request.leaseMs < 1_000 ||
        request.leaseMs > 300_000
      )
        throw invalid(
          "RECURRING_AGENT_TASK_INVALID_LEASE",
          "Lease duration is invalid"
        );
      const now = asTime(request.now, new Date());
      const result = await pool.query(
        `update recurring_agent_task_occurrences set lease_expires_at=$6,updated_at=$5
          where owner_user_id=$1 and id=$2 and claimed_by_runner_id=$3 and lease_token=$4
            and status='reserved' and lease_expires_at>$5`,
        [
          ownerUserId,
          occurrenceId,
          request.runnerId,
          request.leaseToken,
          now,
          new Date(now.getTime() + request.leaseMs)
        ]
      );
      return result.rowCount === 1;
    },

    async markRecurringAgentTaskOccurrenceSubmissionStarted(request) {
      const now = asTime(request.now, new Date());
      const ownerUserId = requireUuid(request.ownerUserId, "Owner id");
      const occurrenceId = requireUuid(request.occurrenceId, "Occurrence id");
      return transaction(async (client) => {
        const identity = await client.query<{
          task_id: string;
          agent_id: string;
        }>(
          `select task_id,agent_id from recurring_agent_task_occurrences
            where owner_user_id=$1 and id=$2`,
          [ownerUserId, occurrenceId]
        );
        const taskId = identity.rows[0]?.task_id;
        const agentId = identity.rows[0]?.agent_id;
        if (!taskId || !agentId) return false;
        const task = await readTaskRow(client, ownerUserId, taskId, true);
        const agent = await readCurrentAgent(
          client,
          ownerUserId,
          agentId,
          true
        );
        if (!task || !agent || agent.lifecycle !== "active") return false;
        const selected = await client.query<OccurrenceRow>(
          `select * from recurring_agent_task_occurrences
            where owner_user_id=$1 and id=$2 for update`,
          [ownerUserId, occurrenceId]
        );
        const row = selected.rows[0];
        if (
          !row ||
          row.status !== "reserved" ||
          row.write_dispatched ||
          row.claimed_by_runner_id !== request.runnerId ||
          row.lease_token !== request.leaseToken ||
          !row.lease_expires_at ||
          row.lease_expires_at <= now ||
          row.task_revision !== task.revision ||
          row.agent_version !== agent.current_version ||
          row.target_device_id !== task.target_device_id ||
          row.target_deployment_id !== task.target_deployment_id ||
          (row.trigger === "scheduled" && task.status !== "active") ||
          (row.trigger === "manual" &&
            task.status !== "active" &&
            task.status !== "paused")
        )
          return false;
        const updated = await client.query(
          `update recurring_agent_task_occurrences set write_dispatched=true,updated_at=$5
            where owner_user_id=$1 and id=$2 and claimed_by_runner_id=$3 and lease_token=$4
              and status='reserved' and write_dispatched=false and lease_expires_at>$5`,
          [ownerUserId, occurrenceId, request.runnerId, request.leaseToken, now]
        );
        return updated.rowCount === 1;
      });
    },

    async linkRecurringAgentTaskOccurrenceNativeResult(input) {
      requireUuid(input.ownerUserId, "Owner id");
      requireUuid(input.occurrenceId, "Occurrence id");
      requireUuid(input.requestId, "Request id");
      requireUuid(input.messageId, "Message id");
      requireUuid(input.deliveryId, "Delivery id");
      if (input.executionId) requireUuid(input.executionId, "Execution id");
      return transaction(async (client) => {
        const native = await client.query(
          `select d.id,d.message_id,d.execution_id,d.command_id
             from personal_agent_chat_deliveries d
             join personal_agent_chat_turns t on t.id=d.turn_id and t.owner_user_id=d.owner_user_id
             join personal_agent_chat_roots r on r.conversation_id=d.conversation_id and r.owner_user_id=d.owner_user_id
             join recurring_agent_task_occurrences o on o.id=$6 and o.owner_user_id=d.owner_user_id
            where d.owner_user_id=$1 and d.id=$2 and d.message_id=$3 and d.conversation_id=$4
              and t.request_id=$5 and t.conversation_id=$4 and o.request_id=$5
              and d.recipient_kind='agent' and d.agent_id=o.agent_id and d.agent_version=o.agent_version
              and r.target_device_id=o.target_device_id and r.target_deployment_id=o.target_deployment_id
            limit 1`,
          [
            input.ownerUserId,
            input.deliveryId,
            input.messageId,
            input.occurrenceId,
            input.requestId,
            input.occurrenceId
          ]
        );
        const nativeRow = native.rows[0] as
          | {
              id: string;
              message_id: string;
              execution_id: string | null;
              command_id: string | null;
            }
          | undefined;
        if (!nativeRow || nativeRow.execution_id !== input.executionId)
          return null;
        const updated = await client.query<OccurrenceRow>(
          `update recurring_agent_task_occurrences set status='dispatched',message_id=$3,
              delivery_id=$4,execution_id=$5,command_id=$6,lease_token=null,lease_expires_at=null,
              claimed_by_runner_id=null,error_code=null,updated_at=now()
            where owner_user_id=$1 and id=$2 and request_id=$7 and status in ('reserved','dispatched')
              and write_dispatched=true returning *`,
          [
            input.ownerUserId,
            input.occurrenceId,
            input.messageId,
            input.deliveryId,
            input.executionId,
            nativeRow.command_id,
            input.requestId
          ]
        );
        return updated.rows[0] ? encodeOccurrence(updated.rows[0]) : null;
      });
    },

    async getNextRecurringAgentTaskOccurrenceForReconciliation(scope) {
      requireUuid(scope.ownerUserId, "Owner id");
      requireUuid(scope.targetDeploymentId, "Deployment id");
      return transaction(async (client) => {
        const result = await client.query<
          OccurrenceRow & {
            native_state: RecurringNativeDeliveryState | null;
            native_message_id: string | null;
            native_delivery_id: string | null;
            native_execution_id: string | null;
            native_command_id: string | null;
            native_error_code: string | null;
          }
        >(
          `select o.*,
              coalesce(d.status,'missing') as native_state,
              d.message_id as native_message_id,d.id as native_delivery_id,
              d.execution_id as native_execution_id,d.command_id as native_command_id,
              d.error_code as native_error_code
             from recurring_agent_task_occurrences o
             left join lateral (
               select d.* from personal_agent_chat_turns native_turn
               join personal_agent_chat_roots native_root on native_root.conversation_id=native_turn.conversation_id
                 and native_root.owner_user_id=native_turn.owner_user_id
                 and native_root.target_device_id=o.target_device_id
                 and native_root.target_deployment_id=o.target_deployment_id
               left join personal_agent_chat_deliveries d on d.turn_id=native_turn.id and d.owner_user_id=native_turn.owner_user_id
                 and d.recipient_kind='agent' and d.agent_id=o.agent_id and d.agent_version=o.agent_version
               where native_turn.owner_user_id=o.owner_user_id and native_turn.conversation_id=o.conversation_id
                 and native_turn.request_id=o.request_id order by d.ordinal limit 1
             ) d on true
            where o.owner_user_id=$1 and o.target_device_id=$2 and o.target_deployment_id=$3
              and (o.status='dispatched' or (o.status='reserved' and o.write_dispatched=true and o.lease_expires_at <= now()))
            order by coalesce(o.reconciliation_checked_at,o.updated_at),o.id
            limit 1 for update of o skip locked`,
          [scope.ownerUserId, scope.targetDeviceId, scope.targetDeploymentId]
        );
        const row = result.rows[0];
        if (!row) return null;
        await client.query(
          "update recurring_agent_task_occurrences set reconciliation_checked_at=now() where owner_user_id=$1 and id=$2",
          [scope.ownerUserId, row.id]
        );
        const nativeState = (row.native_state ??
          "missing") as RecurringNativeDeliveryState;
        return {
          occurrence: encodeOccurrence(row),
          nativeState,
          nativeMessageId: row.native_message_id,
          nativeDeliveryId: row.native_delivery_id,
          nativeExecutionId: row.native_execution_id,
          nativeCommandId: row.native_command_id,
          nativeErrorCode: row.native_error_code
        };
      });
    },

    async settleRecurringAgentTaskOccurrence(input) {
      const now = asTime(input.now, new Date());
      const ownerUserId = requireUuid(input.ownerUserId, "Owner id");
      const occurrenceId = requireUuid(input.occurrenceId, "Occurrence id");
      if (Boolean(input.runnerId) !== Boolean(input.leaseToken))
        throw invalid(
          "RECURRING_AGENT_TASK_INVALID_FENCE",
          "Both runner and lease token are required"
        );
      return transaction(async (client) => {
        const taskIdentity = await client.query<{ task_id: string }>(
          `select task_id from recurring_agent_task_occurrences where owner_user_id=$1 and id=$2`,
          [ownerUserId, occurrenceId]
        );
        const taskId = taskIdentity.rows[0]?.task_id;
        if (!taskId) return null;
        await readTaskRow(client, ownerUserId, taskId, true);
        const selected = await client.query<OccurrenceRow>(
          `select * from recurring_agent_task_occurrences where owner_user_id=$1 and id=$2 for update`,
          [ownerUserId, occurrenceId]
        );
        const row = selected.rows[0];
        if (!row) return null;
        if (
          input.runnerId &&
          (row.status !== "reserved" ||
            row.claimed_by_runner_id !== input.runnerId ||
            row.lease_token !== input.leaseToken ||
            row.lease_expires_at === null ||
            row.lease_expires_at <= now)
        )
          return null;
        const native = await client.query<{
          delivery_id: string | null;
          message_id: string | null;
          execution_id: string | null;
          command_id: string | null;
          delivery_status: string | null;
          turn_status: string | null;
        }>(
          `select d.id as delivery_id,d.message_id,d.execution_id,d.command_id,
                  d.status as delivery_status,t.status as turn_status
             from personal_agent_chat_turns t
             left join personal_agent_chat_deliveries d on d.turn_id=t.id and d.owner_user_id=t.owner_user_id
               and d.recipient_kind='agent' and d.agent_id=$6 and d.agent_version=$7
             join personal_agent_chat_roots r on r.conversation_id=t.conversation_id and r.owner_user_id=t.owner_user_id
            where t.owner_user_id=$1 and t.conversation_id=$2 and t.request_id=$3
              and r.target_device_id=$4 and r.target_deployment_id=$5
            order by d.ordinal limit 1`,
          [
            ownerUserId,
            row.conversation_id,
            row.request_id,
            row.target_device_id,
            row.target_deployment_id,
            row.agent_id,
            row.agent_version
          ]
        );
        const nativeRow = native.rows[0];
        if (
          input.deliveryId &&
          (!nativeRow || nativeRow.delivery_id !== input.deliveryId)
        )
          return null;
        if (
          input.executionId &&
          (!nativeRow || nativeRow.execution_id !== input.executionId)
        )
          return null;
        if (row.delivery_id && nativeRow?.delivery_id !== row.delivery_id)
          return null;
        if (row.execution_id && nativeRow?.execution_id !== row.execution_id)
          return null;
        if (
          input.outcome === "completed" &&
          nativeRow?.delivery_status !== "completed"
        )
          return null;
        if (
          input.outcome === "canceled" &&
          nativeRow?.delivery_status !== "canceled"
        )
          return null;
        if (input.outcome === "needs_review") {
          const definiteNativeFailure =
            ["failed", "uncertain", "skipped"].includes(
              nativeRow?.delivery_status ?? ""
            ) || ["failed", "uncertain"].includes(nativeRow?.turn_status ?? "");
          const expiredUnresolvedIntent =
            row.status === "reserved" &&
            row.write_dispatched &&
            row.lease_expires_at !== null &&
            row.lease_expires_at <= now &&
            !nativeRow?.delivery_id;
          const dispatchedDeliveryMissing =
            row.status === "dispatched" && !nativeRow?.delivery_id;
          const fencedPreflightFailure = Boolean(
            input.runnerId && row.status === "reserved" && !row.write_dispatched
          );
          if (
            !definiteNativeFailure &&
            !expiredUnresolvedIntent &&
            !dispatchedDeliveryMissing &&
            !fencedPreflightFailure
          )
            return null;
        }
        const updated = await client.query<OccurrenceRow>(
          `update recurring_agent_task_occurrences set status=$3,error_code=$4,
              message_id=coalesce(message_id,$6),delivery_id=coalesce(delivery_id,$7),
              execution_id=coalesce(execution_id,$8),command_id=coalesce(command_id,$9),
              lease_token=null,lease_expires_at=null,claimed_by_runner_id=null,
              completed_at=$5,updated_at=$5 where id=$1 and owner_user_id=$2
                and status in ('reserved','dispatched') returning *`,
          [
            occurrenceId,
            ownerUserId,
            input.outcome,
            input.errorCode ?? null,
            now,
            nativeRow?.message_id ?? null,
            nativeRow?.delivery_id ?? null,
            nativeRow?.execution_id ?? null,
            nativeRow?.command_id ?? null
          ]
        );
        const settled = updated.rows[0];
        if (!settled) return encodeOccurrence(row);
        if (input.outcome === "needs_review") {
          await client.query(
            `update recurring_agent_tasks set status=case when status='archived' then 'archived' else 'needs_review' end,
                revision=revision+1,next_run_at=null,last_error_code=$3,updated_at=$4
              where id=$1 and owner_user_id=$2`,
            [
              row.task_id,
              row.owner_user_id,
              input.errorCode ?? "native_effect_uncertain",
              now
            ]
          );
        } else if (input.outcome === "completed") {
          await client.query(
            `update recurring_agent_tasks set last_run_at=$3,
                last_error_code=case when status in ('needs_review','archived') then last_error_code else null end,
                updated_at=$3
              where id=$1 and owner_user_id=$2`,
            [row.task_id, row.owner_user_id, now]
          );
        }
        return encodeOccurrence(settled);
      });
    }
  };
};
