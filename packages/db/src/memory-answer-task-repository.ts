import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  createEncryptedPayloadRepository,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import type { ActorContext } from "./types.js";

export type MemoryAnswerTaskOrigin = "mcp" | "pi_extension";
export type MemoryAnswerTaskStatus =
  | "accepted"
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled";

export interface MemoryAnswerTaskRecord {
  id: string;
  origin: MemoryAnswerTaskOrigin;
  invocationKey: string | null;
  questionId: string | null;
  status: MemoryAnswerTaskStatus;
  statusMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  fenceGeneration: number;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  result: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ClaimedMemoryAnswerTask extends MemoryAnswerTaskRecord {
  leaseOwner: string;
  leaseUntil: string;
  request: Record<string, unknown>;
}

export interface MemoryAnswerTaskRepository {
  acceptMemoryAnswerTask(
    actor: ActorContext,
    input: {
      origin: MemoryAnswerTaskOrigin;
      invocationKey?: string;
      request: Record<string, unknown>;
      maxAttempts?: number;
      retentionMs?: number;
    }
  ): Promise<MemoryAnswerTaskRecord>;
  getMemoryAnswerTask(
    actor: ActorContext,
    taskId: string
  ): Promise<MemoryAnswerTaskRecord | null>;
  claimMemoryAnswerTask(
    actor: ActorContext,
    input: { leaseOwner: string; leaseMs: number }
  ): Promise<ClaimedMemoryAnswerTask | null>;
  heartbeatMemoryAnswerTask(
    actor: ActorContext,
    input: {
      taskId: string;
      leaseOwner: string;
      fenceGeneration: number;
      leaseMs: number;
      madeProgress?: boolean;
      statusMessage?: string;
    }
  ): Promise<MemoryAnswerTaskRecord | null>;
  cancelMemoryAnswerTask(
    actor: ActorContext,
    taskId: string
  ): Promise<MemoryAnswerTaskRecord | null>;
  completeMemoryAnswerTask(
    actor: ActorContext,
    input: {
      taskId: string;
      leaseOwner: string;
      fenceGeneration: number;
      questionId: string;
      result: Record<string, unknown>;
    }
  ): Promise<MemoryAnswerTaskRecord | null>;
  failMemoryAnswerTask(
    actor: ActorContext,
    input: {
      taskId: string;
      leaseOwner: string;
      fenceGeneration: number;
      errorCode: string;
      errorMessage: string;
      retry: boolean;
      retryDelayMs?: number;
    }
  ): Promise<MemoryAnswerTaskRecord | null>;
  deleteExpiredMemoryAnswerTasks(actor: ActorContext): Promise<number>;
}

export interface MemoryAnswerTaskRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

type TaskRow = {
  id: string;
  owner_user_id: string;
  origin: MemoryAnswerTaskOrigin;
  invocation_key: string | null;
  request_snapshot: Record<string, unknown>;
  result_snapshot: Record<string, unknown> | null;
  question_id: string | null;
  status: MemoryAnswerTaskStatus;
  status_message: string | null;
  attempt_count: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_until: Date | null;
  fence_generation: number;
  cancel_requested_at: Date | null;
  cancelled_at: Date | null;
  started_at: Date | null;
  last_progress_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  version: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

const TASK_COLUMNS = `
  id, owner_user_id, origin, invocation_key, request_snapshot,
  result_snapshot, question_id, status, status_message, attempt_count,
  max_attempts, available_at, lease_owner, lease_until, fence_generation,
  cancel_requested_at, cancelled_at, started_at, last_progress_at,
  completed_at, failed_at, last_error_code, last_error_message, version,
  expires_at, created_at, updated_at
`;

const ENCRYPTED_TASK_VALUE = "[koed encrypted memory answer task]";
const encryptedTaskMarker = (sourceColumn: string) => ({
  contentEncrypted: true,
  encryptedSourceTable: "memory_answer_tasks",
  encryptedSourceColumn: sourceColumn
});

const date = (value: Date | null): string | null =>
  value?.toISOString() ?? null;

const mapTask = (
  row: TaskRow,
  hydrated: {
    result?: Record<string, unknown> | null;
    errorMessage?: string | null;
  } = {}
): MemoryAnswerTaskRecord => ({
  id: row.id,
  origin: row.origin,
  invocationKey: row.invocation_key,
  questionId: row.question_id,
  status: row.status,
  statusMessage: row.status_message,
  attemptCount: row.attempt_count,
  maxAttempts: row.max_attempts,
  fenceGeneration: row.fence_generation,
  cancelRequestedAt: date(row.cancel_requested_at),
  startedAt: date(row.started_at),
  lastProgressAt: date(row.last_progress_at),
  completedAt: date(row.completed_at),
  failedAt: date(row.failed_at),
  cancelledAt: date(row.cancelled_at),
  lastErrorCode: row.last_error_code,
  lastErrorMessage:
    hydrated.errorMessage === undefined
      ? row.last_error_message
      : hydrated.errorMessage,
  result: hydrated.result === undefined ? row.result_snapshot : hydrated.result,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  expiresAt: row.expires_at.toISOString()
});

const positiveInteger = (
  value: number | undefined,
  fallback: number
): number =>
  Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;

export const createMemoryAnswerTaskRepository = (
  pool: pg.Pool,
  options: MemoryAnswerTaskRepositoryOptions = {}
): MemoryAnswerTaskRepository => {
  const encryptedPayloads = createEncryptedPayloadRepository(pool);
  const provider = options.envelopeEncryptionProvider;
  const requireProvider = (): EnvelopeEncryptionProvider => {
    if (!provider) {
      throw new Error(
        "Envelope encryption provider is required for Memory Answer tasks"
      );
    }
    return provider;
  };

  const encryptWithClient = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    taskId: string,
    sourceColumn: "request_snapshot" | "result_snapshot" | "last_error_message",
    plaintext: unknown
  ): Promise<void> => {
    await upsertEncryptedFieldPayloadWithClient(
      client,
      actor,
      requireProvider(),
      {
        sourceTable: "memory_answer_tasks",
        sourceId: taskId,
        sourceColumn,
        plaintext,
        visibility: "personal",
        rowFamily: "memory_answer_task",
        scope: { tenantId: actor.userId, objectClass: "memory_answer_task" },
        aad: { taskId }
      }
    );
  };

  const decrypt = async (
    actor: ActorContext,
    taskId: string,
    sourceColumn: "request_snapshot" | "result_snapshot" | "last_error_message"
  ): Promise<unknown> => {
    const value = await encryptedPayloads.decryptAuthorizedEncryptedField(
      actor,
      requireProvider(),
      { sourceTable: "memory_answer_tasks", sourceId: taskId, sourceColumn }
    );
    if (!value) {
      throw new Error(
        `Encrypted Memory Answer task ${sourceColumn} is missing`
      );
    }
    return value.plaintext;
  };

  const hydrateTask = async (
    actor: ActorContext,
    row: TaskRow
  ): Promise<MemoryAnswerTaskRecord> => {
    let result: Record<string, unknown> | null | undefined;
    let errorMessage: string | null | undefined;
    if (row.result_snapshot) {
      const plaintext = await decrypt(actor, row.id, "result_snapshot");
      if (
        !plaintext ||
        typeof plaintext !== "object" ||
        Array.isArray(plaintext)
      ) {
        throw new Error("Encrypted Memory Answer task result is invalid");
      }
      result = plaintext as Record<string, unknown>;
    }
    if (row.last_error_message === ENCRYPTED_TASK_VALUE) {
      const plaintext = await decrypt(actor, row.id, "last_error_message");
      if (typeof plaintext !== "string") {
        throw new Error("Encrypted Memory Answer task error is invalid");
      }
      errorMessage = plaintext;
    }
    return mapTask(row, { result, errorMessage });
  };

  const selectOwned = async (
    actor: ActorContext,
    taskId: string
  ): Promise<TaskRow | null> => {
    const result = await pool.query<TaskRow>(
      `select ${TASK_COLUMNS}
         from memory_answer_tasks
        where id = $2 and owner_user_id = $1 and visibility = 'personal'
        limit 1`,
      [actor.userId, taskId]
    );
    return result.rows[0] ?? null;
  };

  return {
    async acceptMemoryAnswerTask(actor, input) {
      requireProvider();
      const taskId = randomUUID();
      const maxAttempts = Math.min(positiveInteger(input.maxAttempts, 3), 10);
      const retentionMs = Math.min(
        positiveInteger(input.retentionMs, 24 * 60 * 60_000),
        7 * 24 * 60 * 60_000
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        const inserted = await client.query<TaskRow>(
          `insert into memory_answer_tasks (
             id, owner_user_id, visibility, origin, invocation_key,
             request_snapshot, status, max_attempts, expires_at
           ) values (
             $1, $2, 'personal', $3, $4, $5::jsonb, 'accepted', $6,
             now() + ($7::text::interval)
           )
           on conflict (owner_user_id, origin, invocation_key)
             where invocation_key is not null
             do nothing
           returning ${TASK_COLUMNS}`,
          [
            taskId,
            actor.userId,
            input.origin,
            input.invocationKey ?? null,
            JSON.stringify(encryptedTaskMarker("request_snapshot")),
            maxAttempts,
            `${retentionMs} milliseconds`
          ]
        );
        let row = inserted.rows[0];
        if (row) {
          await encryptWithClient(
            client,
            actor,
            row.id,
            "request_snapshot",
            input.request
          );
        } else {
          const existing = await client.query<TaskRow>(
            `select ${TASK_COLUMNS}
               from memory_answer_tasks
              where owner_user_id = $1 and visibility = 'personal'
                and origin = $2 and invocation_key = $3
              limit 1`,
            [actor.userId, input.origin, input.invocationKey]
          );
          row = existing.rows[0];
          if (!row) throw new Error("Memory Answer task acceptance failed");
        }
        await client.query("commit");
        return await hydrateTask(actor, row);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async getMemoryAnswerTask(actor, taskId) {
      const row = await selectOwned(actor, taskId);
      return row ? await hydrateTask(actor, row) : null;
    },

    async claimMemoryAnswerTask(actor, input) {
      const leaseMs = Math.min(positiveInteger(input.leaseMs, 60_000), 300_000);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `update memory_answer_tasks
              set status = 'cancelled', lease_owner = null, lease_until = null,
                  cancelled_at = now(), updated_at = now(), version = version + 1
            where owner_user_id = $1 and visibility = 'personal'
              and status = 'cancel_requested' and lease_until < now()`,
          [actor.userId]
        );
        await client.query(
          `update memory_answer_tasks
              set status = 'failed', lease_owner = null, lease_until = null,
                  failed_at = now(), last_error_code = 'attempts_exhausted',
                  last_error_message = null, updated_at = now(), version = version + 1
            where owner_user_id = $1 and visibility = 'personal'
              and status = 'running' and lease_until < now()
              and attempt_count >= max_attempts`,
          [actor.userId]
        );
        const result = await client.query<TaskRow>(
          `with candidate as (
             select id as candidate_id
               from memory_answer_tasks
              where owner_user_id = $1 and visibility = 'personal'
                and available_at <= now()
                and attempt_count < max_attempts
                and (status = 'accepted' or (status = 'running' and lease_until < now()))
              order by available_at, created_at, id
              for update skip locked
              limit 1
           )
           update memory_answer_tasks task
              set status = 'running', lease_owner = $2,
                  lease_until = now() + ($3::text::interval),
                  fence_generation = fence_generation + 1,
                  attempt_count = attempt_count + 1,
                  started_at = coalesce(started_at, now()),
                  last_progress_at = now(), status_message = 'running',
                  updated_at = now(), version = version + 1
             from candidate
            where task.id = candidate.candidate_id
           returning ${TASK_COLUMNS}`,
          [actor.userId, input.leaseOwner, `${leaseMs} milliseconds`]
        );
        await client.query("commit");
        const row = result.rows[0];
        if (!row) return null;
        const request = await decrypt(actor, row.id, "request_snapshot");
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          throw new Error("Encrypted Memory Answer task request is invalid");
        }
        return {
          ...(await hydrateTask(actor, row)),
          leaseOwner: row.lease_owner!,
          leaseUntil: row.lease_until!.toISOString(),
          request: request as Record<string, unknown>
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async heartbeatMemoryAnswerTask(actor, input) {
      const leaseMs = Math.min(positiveInteger(input.leaseMs, 60_000), 300_000);
      const result = await pool.query<TaskRow>(
        `update memory_answer_tasks
            set lease_until = now() + ($5::text::interval),
                last_progress_at = case when $6 then now() else last_progress_at end,
                status_message = coalesce($7, status_message),
                updated_at = now(), version = version + 1
          where owner_user_id = $1 and id = $2 and visibility = 'personal'
            and lease_owner = $3 and fence_generation = $4
            and lease_until >= now() and status in ('running', 'cancel_requested')
         returning ${TASK_COLUMNS}`,
        [
          actor.userId,
          input.taskId,
          input.leaseOwner,
          input.fenceGeneration,
          `${leaseMs} milliseconds`,
          input.madeProgress === true,
          input.statusMessage ?? null
        ]
      );
      return result.rows[0] ? await hydrateTask(actor, result.rows[0]) : null;
    },

    async cancelMemoryAnswerTask(actor, taskId) {
      const result = await pool.query<TaskRow>(
        `update memory_answer_tasks
            set status = case when status = 'accepted' then 'cancelled' else 'cancel_requested' end,
                cancel_requested_at = coalesce(cancel_requested_at, now()),
                cancelled_at = case when status = 'accepted' then now() else cancelled_at end,
                status_message = 'cancellation requested',
                updated_at = now(), version = version + 1
          where owner_user_id = $1 and id = $2 and visibility = 'personal'
            and status in ('accepted', 'running')
         returning ${TASK_COLUMNS}`,
        [actor.userId, taskId]
      );
      const row = result.rows[0] ?? (await selectOwned(actor, taskId));
      return row ? await hydrateTask(actor, row) : null;
    },

    async completeMemoryAnswerTask(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await encryptWithClient(
          client,
          actor,
          input.taskId,
          "result_snapshot",
          input.result
        );
        const result = await client.query<TaskRow>(
          `update memory_answer_tasks
              set status = 'completed', question_id = $5,
                  result_snapshot = $6::jsonb, lease_owner = null,
                  lease_until = null, completed_at = now(), status_message = 'completed',
                  last_error_code = null, last_error_message = null,
                  updated_at = now(), version = version + 1
            where owner_user_id = $1 and id = $2 and visibility = 'personal'
              and lease_owner = $3 and fence_generation = $4
              and lease_until >= now() and status = 'running'
           returning ${TASK_COLUMNS}`,
          [
            actor.userId,
            input.taskId,
            input.leaseOwner,
            input.fenceGeneration,
            input.questionId,
            JSON.stringify(encryptedTaskMarker("result_snapshot"))
          ]
        );
        if (!result.rows[0]) {
          await client.query("rollback");
          return null;
        }
        await client.query(
          `delete from encrypted_field_payloads
            where owner_user_id = $1 and visibility = 'personal'
              and source_table = 'memory_answer_tasks' and source_id = $2
              and source_column = 'last_error_message'`,
          [actor.userId, input.taskId]
        );
        await client.query("commit");
        return await hydrateTask(actor, result.rows[0]);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async failMemoryAnswerTask(actor, input) {
      const retryDelayMs = Math.min(
        Math.max(input.retryDelayMs ?? 0, 0),
        60 * 60_000
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        await encryptWithClient(
          client,
          actor,
          input.taskId,
          "last_error_message",
          input.errorMessage
        );
        const result = await client.query<TaskRow>(
          `update memory_answer_tasks
              set status = case
                    when status = 'cancel_requested' then 'cancelled'
                    when $5 and attempt_count < max_attempts then 'accepted'
                    else 'failed'
                  end,
                  available_at = case
                    when $5 and attempt_count < max_attempts
                      then now() + ($6::text::interval)
                    else available_at
                  end,
                  lease_owner = null, lease_until = null,
                  failed_at = case
                    when status = 'cancel_requested' then null
                    when $5 and attempt_count < max_attempts then null else now()
                  end,
                  cancelled_at = case
                    when status = 'cancel_requested' then now() else cancelled_at
                  end,
                  last_error_code = $7, last_error_message = $8,
                  status_message = case
                    when status = 'cancel_requested' then 'cancelled'
                    when $5 and attempt_count < max_attempts then 'retry scheduled'
                    else 'failed'
                  end,
                  updated_at = now(), version = version + 1
            where owner_user_id = $1 and id = $2 and visibility = 'personal'
              and lease_owner = $3 and fence_generation = $4
              and lease_until >= now() and status in ('running', 'cancel_requested')
           returning ${TASK_COLUMNS}`,
          [
            actor.userId,
            input.taskId,
            input.leaseOwner,
            input.fenceGeneration,
            input.retry,
            `${retryDelayMs} milliseconds`,
            input.errorCode,
            ENCRYPTED_TASK_VALUE
          ]
        );
        if (!result.rows[0]) {
          await client.query("rollback");
          return null;
        }
        await client.query("commit");
        return await hydrateTask(actor, result.rows[0]);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteExpiredMemoryAnswerTasks(actor) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const tasks = await client.query<{ id: string }>(
          `delete from memory_answer_tasks
            where owner_user_id = $1 and visibility = 'personal'
              and status in ('completed', 'failed', 'cancelled')
              and expires_at <= now()
          returning id`,
          [actor.userId]
        );
        if (tasks.rows.length > 0) {
          await client.query(
            `delete from encrypted_field_payloads
              where owner_user_id = $1 and visibility = 'personal'
                and source_table = 'memory_answer_tasks'
                and source_id = any($2::uuid[])`,
            [actor.userId, tasks.rows.map((row) => row.id)]
          );
        }
        await client.query("commit");
        return tasks.rowCount ?? 0;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
};
