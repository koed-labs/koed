import { randomUUID } from "node:crypto";
import {
  pinMemoryAnswerTaskSelection,
  validateMemoryAnswerTaskCompletion
} from "./memory-answer-task-request.js";
import type pg from "pg";
import {
  decryptAuthorizedEncryptedFieldPayloadWithClient,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import type {
  ClaimedMemoryAnswerTask,
  EnvelopeEncryptionProvider,
  MemoryAnswerTask as MemoryAnswerTaskRecord,
  MemoryAnswerTaskOrigin,
  MemoryAnswerTaskStatus
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  createMemoryQuestionRepository,
  type CreateFinalMemoryQuestionInput
} from "./memory-question-repository.js";
import {
  assertMemoryAnswerTeamAuthorityWithClient,
  freezeMemoryAnswerTeamAuthorityWithClient,
  MemoryAnswerTeamAuthorityError,
  type MemoryAnswerTeamAuthority
} from "./memory-answer-team-authority.js";

export type {
  ClaimedMemoryAnswerTask,
  MemoryAnswerTaskOrigin,
  MemoryAnswerTaskRecord,
  MemoryAnswerTaskStatus
};

export interface MemoryAnswerTaskClaimBatch {
  task: ClaimedMemoryAnswerTask | null;
  reconciled: MemoryAnswerTaskRecord[];
  teamAuthority?: MemoryAnswerTeamAuthority;
}

export type MemoryAnswerTaskActor = ActorContext & {
  allowTeam?: boolean;
  allowPersonal?: boolean;
};

export class MemoryAnswerTaskAuthorizationError extends Error {
  readonly statusCode = 403;
  constructor() {
    super("Credential cannot access Personal Memory Answer tasks");
    this.name = "MemoryAnswerTaskAuthorizationError";
  }
}

export class MemoryAnswerTaskQueueFullError extends Error {
  readonly statusCode = 429;

  constructor() {
    super("Koed Memory Answer queue is full");
    this.name = "MemoryAnswerTaskQueueFullError";
  }
}

export interface MemoryAnswerTaskRepository {
  acceptMemoryAnswerTask(
    actor: MemoryAnswerTaskActor,
    input: {
      origin: MemoryAnswerTaskOrigin;
      invocationKey?: string;
      request: Record<string, unknown>;
      teamWorkspaceId?: string;
      maxAttempts?: number;
      maxQueued: number;
      retentionMs?: number;
    }
  ): Promise<MemoryAnswerTaskRecord>;
  getMemoryAnswerTask(
    actor: MemoryAnswerTaskActor,
    taskId: string
  ): Promise<MemoryAnswerTaskRecord | null>;
  getMemoryAnswerTaskTeamAuthority(
    actor: MemoryAnswerTaskActor,
    taskId: string
  ): Promise<MemoryAnswerTeamAuthority | null>;
  claimMemoryAnswerTask(
    actor: MemoryAnswerTaskActor,
    input: {
      leaseOwner: string;
      leaseMs: number;
      allowTeam?: boolean;
      scopeFilter?: "personal" | "team";
    }
  ): Promise<MemoryAnswerTaskClaimBatch>;
  heartbeatMemoryAnswerTask(
    actor: MemoryAnswerTaskActor,
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
    actor: MemoryAnswerTaskActor,
    taskId: string
  ): Promise<MemoryAnswerTaskRecord | null>;
  completeMemoryAnswerTask(
    actor: MemoryAnswerTaskActor,
    input: {
      taskId: string;
      leaseOwner: string;
      fenceGeneration: number;
      finalQuestion: CreateFinalMemoryQuestionInput;
      result: Record<string, unknown>;
    }
  ): Promise<MemoryAnswerTaskRecord | null>;
  failMemoryAnswerTask(
    actor: MemoryAnswerTaskActor,
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
  deleteExpiredMemoryAnswerTasks(actor: MemoryAnswerTaskActor): Promise<number>;
}

export interface MemoryAnswerTaskRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

type TaskRow = {
  id: string;
  owner_user_id: string;
  team_workspace_id: string | null;
  team_authorization: MemoryAnswerTeamAuthority | null;
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
  id, owner_user_id, team_workspace_id, team_authorization, origin, invocation_key, request_snapshot,
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
  teamWorkspaceId: row.team_workspace_id ?? null,
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
  const provider = options.envelopeEncryptionProvider;
  const questions = createMemoryQuestionRepository(pool, options);
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

  const decryptWithClient = async (
    client: pg.Pool | pg.PoolClient,
    actor: ActorContext,
    taskId: string,
    sourceColumn: "request_snapshot" | "result_snapshot" | "last_error_message"
  ): Promise<unknown> => {
    const value = await decryptAuthorizedEncryptedFieldPayloadWithClient(
      client,
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

  const assertAuthority = async (
    client: pg.PoolClient,
    actor: MemoryAnswerTaskActor,
    row: TaskRow
  ) => {
    if (!row.team_workspace_id) {
      if (actor.allowPersonal === false)
        throw new MemoryAnswerTaskAuthorizationError();
      return;
    }
    if (!actor.allowTeam) throw new MemoryAnswerTeamAuthorityError();
    if (!row.team_authorization)
      throw new Error("Memory Answer Team authority is missing");
    await assertMemoryAnswerTeamAuthorityWithClient(
      client,
      actor,
      row.team_authorization
    );
  };

  const hydrateTask = async (
    client: pg.PoolClient,
    actor: MemoryAnswerTaskActor,
    row: TaskRow
  ): Promise<MemoryAnswerTaskRecord> => {
    await assertAuthority(client, actor, row);
    let result: Record<string, unknown> | null | undefined;
    let errorMessage: string | null | undefined;
    if (row.result_snapshot) {
      const plaintext = await decryptWithClient(
        client,
        actor,
        row.id,
        "result_snapshot"
      );
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
      const plaintext = await decryptWithClient(
        client,
        actor,
        row.id,
        "last_error_message"
      );
      if (typeof plaintext !== "string") {
        throw new Error("Encrypted Memory Answer task error is invalid");
      }
      errorMessage = plaintext;
    }
    return mapTask(row, { result, errorMessage });
  };

  const selectOwned = async (
    client: pg.PoolClient,
    actor: ActorContext,
    taskId: string
  ): Promise<TaskRow | null> => {
    const result = await client.query<TaskRow>(
      `select ${TASK_COLUMNS}
         from memory_answer_tasks
        where id = $2 and owner_user_id = $1 and visibility = 'personal'
        limit 1 for update`,
      [actor.userId, taskId]
    );
    return result.rows[0] ?? null;
  };

  // Revocation permits queue maintenance, never access to the protected payload.
  const retireDeniedTask = async (
    client: pg.PoolClient,
    row: TaskRow,
    cancelled = false
  ): Promise<MemoryAnswerTaskRecord> => {
    const result = await client.query<TaskRow>(
      `update memory_answer_tasks
          set status = $2, lease_owner = null, lease_until = null,
              fence_generation = fence_generation + 1,
              failed_at = case when $2 = 'failed' then now() else failed_at end,
              cancel_requested_at = case when $2 = 'cancelled' then coalesce(cancel_requested_at, now()) else cancel_requested_at end,
              cancelled_at = case when $2 = 'cancelled' then now() else cancelled_at end,
              status_message = null, last_error_code = 'team_authority_revoked',
              last_error_message = null, updated_at = now(), version = version + 1
        where id = $1 and status in ('accepted', 'running', 'cancel_requested')
        returning ${TASK_COLUMNS}`,
      [row.id, cancelled ? "cancelled" : "failed"]
    );
    return mapTask({
      ...(result.rows[0] ?? row),
      invocation_key: null,
      question_id: null,
      status_message: null,
      result_snapshot: null,
      last_error_code: "team_authority_revoked",
      last_error_message: null
    });
  };

  const withOwnedTask = async (
    actor: MemoryAnswerTaskActor,
    taskId: string,
    operation: (
      client: pg.PoolClient,
      row: TaskRow
    ) => Promise<MemoryAnswerTaskRecord | null>,
    cancelDeniedTeam = false
  ): Promise<MemoryAnswerTaskRecord | null> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const row = await selectOwned(client, actor, taskId);
      let result: MemoryAnswerTaskRecord | null = null;
      if (row) {
        try {
          await assertAuthority(client, actor, row);
        } catch (error) {
          if (
            !cancelDeniedTeam ||
            !actor.allowTeam ||
            !row.team_workspace_id ||
            !(error instanceof MemoryAnswerTeamAuthorityError)
          )
            throw error;
          result = await retireDeniedTask(client, row, true);
        }
        if (!result) result = await operation(client, row);
      }
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    async acceptMemoryAnswerTask(actor, input) {
      requireProvider();
      if (!input.teamWorkspaceId && actor.allowPersonal === false)
        throw new MemoryAnswerTaskAuthorizationError();
      if (input.teamWorkspaceId && !actor.allowTeam)
        throw new MemoryAnswerTeamAuthorityError();
      const pinnedRequest = pinMemoryAnswerTaskSelection(
        input.request,
        actor.userId,
        input.teamWorkspaceId
      );
      const taskId = randomUUID();
      const maxAttempts = Math.min(positiveInteger(input.maxAttempts, 3), 10);
      const retentionMs = Math.min(
        positiveInteger(input.retentionMs, 24 * 60 * 60_000),
        7 * 24 * 60 * 60_000
      );
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select id from users where id = $1 for update", [
          actor.userId
        ]);
        if (input.invocationKey) {
          const existing = await client.query<TaskRow>(
            `select ${TASK_COLUMNS}
               from memory_answer_tasks
              where owner_user_id = $1 and visibility = 'personal'
                and origin = $2 and invocation_key = $3
              limit 1`,
            [actor.userId, input.origin, input.invocationKey]
          );
          if (existing.rows[0]) {
            if (
              (existing.rows[0].team_workspace_id ?? null) !==
              (input.teamWorkspaceId ?? null)
            ) {
              throw new Error("Memory Answer invocation scope does not match");
            }
            const task = await hydrateTask(client, actor, existing.rows[0]);
            await client.query("commit");
            return task;
          }
        }
        const queued = await client.query<{ count: string }>(
          `select count(*)::text as count
             from memory_answer_tasks
            where owner_user_id = $1 and visibility = 'personal'
              and status = 'accepted'`,
          [actor.userId]
        );
        if (
          Number.parseInt(queued.rows[0]?.count ?? "0", 10) >= input.maxQueued
        ) {
          throw new MemoryAnswerTaskQueueFullError();
        }
        const teamAuthority = input.teamWorkspaceId
          ? await freezeMemoryAnswerTeamAuthorityWithClient(client, actor, {
              teamWorkspaceId: input.teamWorkspaceId
            })
          : null;
        const inserted = await client.query<TaskRow>(
          `insert into memory_answer_tasks (
             id, owner_user_id, visibility, origin, invocation_key,
             request_snapshot, status, max_attempts, expires_at, team_workspace_id, team_authorization
           ) values (
             $1, $2, 'personal', $3, $4, $5::jsonb, 'accepted', $6,
             now() + ($7::text::interval), $8, $9::jsonb
           )
           returning ${TASK_COLUMNS}`,
          [
            taskId,
            actor.userId,
            input.origin,
            input.invocationKey ?? null,
            JSON.stringify(encryptedTaskMarker("request_snapshot")),
            maxAttempts,
            `${retentionMs} milliseconds`,
            input.teamWorkspaceId ?? null,
            teamAuthority ? JSON.stringify(teamAuthority) : null
          ]
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("Memory Answer task acceptance failed");
        await encryptWithClient(
          client,
          actor,
          row.id,
          "request_snapshot",
          pinnedRequest
        );
        const task = await hydrateTask(client, actor, row);
        await client.query("commit");
        return task;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async getMemoryAnswerTask(actor, taskId) {
      return withOwnedTask(actor, taskId, (client, row) =>
        hydrateTask(client, actor, row)
      );
    },

    async getMemoryAnswerTaskTeamAuthority(actor, taskId) {
      let authority: MemoryAnswerTeamAuthority | null = null;
      await withOwnedTask(actor, taskId, (_client, row) => {
        authority = row.team_authorization ?? null;
        return Promise.resolve(mapTask(row));
      });
      return authority;
    },

    async claimMemoryAnswerTask(actor, input) {
      const leaseMs = Math.min(positiveInteger(input.leaseMs, 60_000), 300_000);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const reconciled: MemoryAnswerTaskRecord[] = [];
        let row: TaskRow | undefined;
        // Bound both row locks and expensive Team grant checks per claim call.
        for (let checked = 0; checked < 16; checked += 1) {
          const eligible = await client.query<TaskRow>(
            `select ${TASK_COLUMNS} from memory_answer_tasks
            where owner_user_id = $1 and visibility = 'personal'
              and ((team_workspace_id is null and $3) or (team_workspace_id is not null and $2))
              and ($4::text is null or ($4 = 'personal' and team_workspace_id is null) or ($4 = 'team' and team_workspace_id is not null))
              and ((status = 'accepted' and available_at <= now())
                or (status = 'cancel_requested' and lease_until < now())
                or (status = 'running' and lease_until < now()
                    and (available_at <= now() or attempt_count >= max_attempts)))
            order by available_at, created_at, id limit 1 for update skip locked`,
            [
              actor.userId,
              input.allowTeam === true && actor.allowTeam === true,
              actor.allowPersonal !== false,
              input.scopeFilter ?? "personal"
            ]
          );
          const candidate = eligible.rows[0];
          if (!candidate) break;
          try {
            await assertAuthority(client, actor, candidate);
          } catch (error) {
            if (!(error instanceof MemoryAnswerTeamAuthorityError)) throw error;
            reconciled.push(await retireDeniedTask(client, candidate));
            continue;
          }
          if (candidate.status === "cancel_requested") {
            const cancelled = await client.query<TaskRow>(
              `update memory_answer_tasks
              set status = 'cancelled', lease_owner = null, lease_until = null,
                  cancelled_at = now(), updated_at = now(), version = version + 1
            where owner_user_id = $1 and visibility = 'personal'
              and id = $2
              and status = 'cancel_requested' and lease_until < now()
           returning ${TASK_COLUMNS}`,
              [actor.userId, candidate.id]
            );
            reconciled.push(...cancelled.rows.map((item) => mapTask(item)));
            continue;
          }
          if (candidate.attempt_count >= candidate.max_attempts) {
            const exhausted = await client.query<TaskRow>(
              `update memory_answer_tasks
              set status = 'failed', lease_owner = null, lease_until = null,
                  failed_at = now(), last_error_code = 'attempts_exhausted',
                  last_error_message = null, updated_at = now(), version = version + 1
            where owner_user_id = $1 and visibility = 'personal'
              and id = $2
              and (status = 'accepted' or (status = 'running' and lease_until < now()))
              and attempt_count >= max_attempts
           returning ${TASK_COLUMNS}`,
              [actor.userId, candidate.id]
            );
            reconciled.push(...exhausted.rows.map((item) => mapTask(item)));
            continue;
          }
          const result = await client.query<TaskRow>(
            `update memory_answer_tasks task
              set status = 'running', lease_owner = $2,
                  lease_until = clock_timestamp() + ($3::text::interval),
                  fence_generation = fence_generation + 1,
                  attempt_count = attempt_count + 1,
                  started_at = coalesce(started_at, now()),
                  last_progress_at = now(), status_message = 'running',
                  updated_at = now(), version = version + 1
            where task.id = $4 and owner_user_id = $1 and visibility = 'personal'
           returning ${TASK_COLUMNS}`,
            [
              actor.userId,
              input.leaseOwner,
              `${leaseMs} milliseconds`,
              candidate.id
            ]
          );
          row = result.rows[0];
          break;
        }
        let task: ClaimedMemoryAnswerTask | null = null;
        if (row) {
          await assertAuthority(client, actor, row);
          const request = await decryptWithClient(
            client,
            actor,
            row.id,
            "request_snapshot"
          );
          if (
            !request ||
            typeof request !== "object" ||
            Array.isArray(request)
          ) {
            throw new Error("Encrypted Memory Answer task request is invalid");
          }
          task = {
            ...mapTask(row),
            leaseOwner: row.lease_owner!,
            leaseUntil: row.lease_until!.toISOString(),
            request: request as Record<string, unknown>
          };
        }
        await client.query("commit");
        return {
          task,
          ...(row?.team_authorization
            ? { teamAuthority: row.team_authorization }
            : {}),
          reconciled
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
      return withOwnedTask(actor, input.taskId, async (client) => {
        const result = await client.query<TaskRow>(
          `update memory_answer_tasks
            set lease_until = clock_timestamp() + ($5::text::interval),
                last_progress_at = case when $6 then now() else last_progress_at end,
                status_message = coalesce($7, status_message),
                updated_at = now(), version = version + 1
          where owner_user_id = $1 and id = $2 and visibility = 'personal'
            and lease_owner = $3 and fence_generation = $4
            and lease_until >= clock_timestamp() and status in ('running', 'cancel_requested')
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
        return result.rows[0]
          ? await hydrateTask(client, actor, result.rows[0])
          : null;
      });
    },

    async cancelMemoryAnswerTask(actor, taskId) {
      return withOwnedTask(
        actor,
        taskId,
        async (client, existing) => {
          const result = await client.query<TaskRow>(
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
          return hydrateTask(client, actor, result.rows[0] ?? existing);
        },
        true
      );
    },

    async completeMemoryAnswerTask(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const current = await selectOwned(client, actor, input.taskId);
        if (current) await assertAuthority(client, actor, current);
        if (
          !current ||
          current.status !== "running" ||
          current.lease_owner !== input.leaseOwner ||
          current.fence_generation !== input.fenceGeneration
        ) {
          await client.query("rollback");
          return null;
        }
        const liveLease = await client.query<{ valid: boolean }>(
          `select lease_until >= clock_timestamp() as valid from memory_answer_tasks where id = $1`,
          [current.id]
        );
        if (!liveLease.rows[0]?.valid) {
          await client.query("rollback");
          return null;
        }
        const request = await decryptWithClient(
          client,
          actor,
          current.id,
          "request_snapshot"
        );
        validateMemoryAnswerTaskCompletion(
          request,
          current.team_workspace_id,
          input.finalQuestion
        );
        const question = await questions.createFinalMemoryQuestionWithClient(
          client,
          actor,
          {
            ...input.finalQuestion,
            idempotencyKey: `memory-answer-task:${current.id}`
          },
          { teamAuthority: current.team_authorization ?? undefined }
        );
        await encryptWithClient(
          client,
          actor,
          input.taskId,
          "result_snapshot",
          { ...input.result, question_id: question.id }
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
              and lease_until >= clock_timestamp() and status = 'running'
           returning ${TASK_COLUMNS}`,
          [
            actor.userId,
            input.taskId,
            input.leaseOwner,
            input.fenceGeneration,
            question.id,
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
        const task = await hydrateTask(client, actor, result.rows[0]);
        await client.query("commit");
        return task;
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
        const current = await selectOwned(client, actor, input.taskId);
        if (current) await assertAuthority(client, actor, current);
        if (
          !current ||
          current.lease_owner !== input.leaseOwner ||
          current.fence_generation !== input.fenceGeneration ||
          !["running", "cancel_requested"].includes(current.status)
        ) {
          await client.query("rollback");
          return null;
        }
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
              and lease_until >= clock_timestamp() and status in ('running', 'cancel_requested')
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
        const task = await hydrateTask(client, actor, result.rows[0]);
        await client.query("commit");
        return task;
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
              and ((team_workspace_id is null and $3) or (team_workspace_id is not null and $2))
              and status in ('completed', 'failed', 'cancelled')
              and expires_at <= now()
          returning id`,
          [
            actor.userId,
            actor.allowTeam === true,
            actor.allowPersonal !== false
          ]
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
