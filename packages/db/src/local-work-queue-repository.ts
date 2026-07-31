import { randomUUID } from "node:crypto";
import type pg from "pg";
import { defaultKoedQueuePriority } from "@koed/shared";

export type LocalWorkQueueStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed";

export interface EnqueueLocalWorkQueueJobInput {
  queueName: string;
  jobName: string;
  data: unknown;
  jobKey?: string;
  priority?: number;
  maxAttempts?: number;
  backoffMs?: number;
  delayMs?: number;
}

export interface LocalWorkQueueJobRecord<TData = unknown> {
  id: number;
  queueName: string;
  jobName: string;
  data: TData;
  attemptCount: number;
  maxAttempts: number;
  priority: number;
  lockToken: string;
  createdAt: Date;
}

export interface ClaimLocalWorkQueueJobInput {
  queueName: string;
  leaseMs: number;
}

export interface LocalWorkQueueRuntimeLease {
  requeueAbandonedJobs(): Promise<number>;
  release(): Promise<void>;
}

export interface LocalWorkQueueRepository {
  enqueue(input: EnqueueLocalWorkQueueJobInput): Promise<{ id: number }>;
  tryAcquireRuntimeLease(): Promise<LocalWorkQueueRuntimeLease | null>;
  claim<TData = unknown>(
    input: ClaimLocalWorkQueueJobInput
  ): Promise<LocalWorkQueueJobRecord<TData> | null>;
  complete(input: { id: number; lockToken: string }): Promise<boolean>;
  fail(input: {
    id: number;
    lockToken: string;
    errorMessage: string;
    retry: boolean;
  }): Promise<boolean>;
  getJobCounts(statuses: string[]): Promise<Record<string, number>>;
  getOldestPendingAgeMs(queueName: string): Promise<number | null>;
}

const toPositiveInteger = (
  value: number | undefined,
  fallback: number
): number =>
  Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;

const toNonNegativeInteger = (
  value: number | undefined,
  fallback: number
): number =>
  Number.isInteger(value) && value !== undefined && value >= 0
    ? value
    : fallback;

const mapJobRow = <TData>(row: {
  id: string | number;
  queue_name: string;
  job_name: string;
  data: TData;
  attempt_count: number;
  max_attempts: number;
  priority: number;
  lock_token: string;
  created_at: Date;
}): LocalWorkQueueJobRecord<TData> => ({
  id: Number(row.id),
  queueName: row.queue_name,
  jobName: row.job_name,
  data: row.data,
  attemptCount: row.attempt_count,
  maxAttempts: row.max_attempts,
  priority: row.priority,
  lockToken: row.lock_token,
  createdAt: row.created_at
});

export const createLocalWorkQueueRepository = (
  pool: pg.Pool
): LocalWorkQueueRepository => ({
  async enqueue(input) {
    const maxAttempts = toPositiveInteger(input.maxAttempts, 1);
    const priority = toNonNegativeInteger(
      input.priority,
      defaultKoedQueuePriority
    );
    const backoffMs = input.backoffMs ?? null;
    const delayMs = toNonNegativeInteger(input.delayMs, 0);
    const result = await pool.query<{ id: string }>(
      `
        insert into local_work_queue (
          queue_name,
          job_name,
          job_key,
          data,
          priority,
          max_attempts,
          backoff_ms,
          available_at
        )
        values ($1, $2, $3, $4::jsonb, $5, $6, $7, now() + ($8::text::interval))
        on conflict (queue_name, job_key)
          where job_key is not null
          do update set
            job_name = case
              when local_work_queue.status in ('failed', 'completed') then excluded.job_name
              else local_work_queue.job_name
            end,
            data = case
              when local_work_queue.status in ('failed', 'completed') then excluded.data
              else local_work_queue.data
            end,
            status = case
              when local_work_queue.status in ('failed', 'completed') then 'pending'
              else local_work_queue.status
            end,
            attempt_count = case
              when local_work_queue.status in ('failed', 'completed') then 0
              else local_work_queue.attempt_count
            end,
            priority = case
              when local_work_queue.status in ('failed', 'completed') then excluded.priority
              else local_work_queue.priority
            end,
            max_attempts = case
              when local_work_queue.status in ('failed', 'completed') then excluded.max_attempts
              else local_work_queue.max_attempts
            end,
            backoff_ms = case
              when local_work_queue.status in ('failed', 'completed') then excluded.backoff_ms
              else local_work_queue.backoff_ms
            end,
            available_at = case
              when local_work_queue.status in ('failed', 'completed') then excluded.available_at
              else local_work_queue.available_at
            end,
            locked_at = case
              when local_work_queue.status in ('failed', 'completed') then null
              else local_work_queue.locked_at
            end,
            locked_until = case
              when local_work_queue.status in ('failed', 'completed') then null
              else local_work_queue.locked_until
            end,
            lock_token = case
              when local_work_queue.status in ('failed', 'completed') then null
              else local_work_queue.lock_token
            end,
            completed_at = case
              when local_work_queue.status in ('failed', 'completed') then null
              else local_work_queue.completed_at
            end,
            failed_at = case
              when local_work_queue.status in ('failed', 'completed') then null
              else local_work_queue.failed_at
            end,
            last_error = case
              when local_work_queue.status in ('failed', 'completed') then null
              else local_work_queue.last_error
            end,
            updated_at = case
              when local_work_queue.status in ('failed', 'completed') then now()
              else local_work_queue.updated_at
            end
        returning id
      `,
      [
        input.queueName,
        input.jobName,
        input.jobKey ?? null,
        JSON.stringify(input.data ?? {}),
        priority,
        maxAttempts,
        backoffMs,
        `${delayMs} milliseconds`
      ]
    );
    return { id: Number(result.rows[0]?.id) };
  },

  async tryAcquireRuntimeLease() {
    const client = await pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        `
          select pg_try_advisory_lock(
            hashtextextended('koed-local-work-queue-runtime', 0)
          ) as acquired
        `
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return null;
      }

      let released = false;
      return {
        async requeueAbandonedJobs() {
          const recovered = await client.query(
            `
              update local_work_queue
              set status = 'pending',
                  attempt_count = greatest(attempt_count - 1, 0),
                  available_at = now(),
                  lock_token = null,
                  locked_at = null,
                  locked_until = null,
                  last_error = null,
                  updated_at = now()
              where status = 'active'
            `
          );
          return recovered.rowCount ?? 0;
        },
        async release() {
          if (released) return;
          released = true;
          try {
            await client.query(
              `
                select pg_advisory_unlock(
                  hashtextextended('koed-local-work-queue-runtime', 0)
                )
              `
            );
          } finally {
            client.release();
          }
        }
      };
    } catch (error) {
      client.release(true);
      throw error;
    }
  },

  async claim<TData = unknown>(input: ClaimLocalWorkQueueJobInput) {
    const lockToken = randomUUID();
    const leaseMs = toPositiveInteger(input.leaseMs, 60_000);
    const result = await pool.query<{
      id: string;
      queue_name: string;
      job_name: string;
      data: TData;
      attempt_count: number;
      max_attempts: number;
      priority: number;
      lock_token: string;
      created_at: Date;
    }>(
      `
        with expired_failed as (
          update local_work_queue
          set status = 'failed',
              failed_at = now(),
              last_error = 'Local queue lease expired after max attempts.',
              lock_token = null,
              locked_at = null,
              locked_until = null,
              updated_at = now()
          where queue_name = $1
            and status = 'active'
            and locked_until <= now()
            and attempt_count >= max_attempts
        ), expired_pending as (
          update local_work_queue
          set status = 'pending',
              lock_token = null,
              locked_at = null,
              locked_until = null,
              updated_at = now()
          where queue_name = $1
            and status = 'active'
            and locked_until <= now()
            and attempt_count < max_attempts
        ), next_job as (
          select id
          from local_work_queue
          where queue_name = $1
            and status = 'pending'
            and available_at <= now()
          order by priority asc, available_at asc, id asc
          for update skip locked
          limit 1
        )
        update local_work_queue q
        set status = 'active',
            attempt_count = q.attempt_count + 1,
            lock_token = $2,
            locked_at = now(),
            locked_until = now() + ($3::text::interval),
            updated_at = now()
        from next_job
        where q.id = next_job.id
        returning q.id,
                  q.queue_name,
                  q.job_name,
                  q.data,
                  q.attempt_count,
                  q.max_attempts,
                  q.priority,
                  q.lock_token,
                  q.created_at
      `,
      [input.queueName, lockToken, `${leaseMs} milliseconds`]
    );
    const row = result.rows[0];
    return row ? mapJobRow<TData>(row) : null;
  },

  async complete(input) {
    const result = await pool.query(
      `
        update local_work_queue
        set status = 'completed',
            completed_at = now(),
            failed_at = null,
            last_error = null,
            lock_token = null,
            locked_at = null,
            locked_until = null,
            updated_at = now()
        where id = $1 and lock_token = $2 and status = 'active'
      `,
      [input.id, input.lockToken]
    );
    return (result.rowCount ?? 0) > 0;
  },

  async fail(input) {
    const result = await pool.query(
      `
        update local_work_queue
        set status = case when $3::boolean then 'pending' else 'failed' end,
            available_at = case
              when $3::boolean then now() + (coalesce(backoff_ms, 0)::text || ' milliseconds')::interval
              else available_at
            end,
            failed_at = case when $3::boolean then failed_at else now() end,
            last_error = $4,
            lock_token = null,
            locked_at = null,
            locked_until = null,
            updated_at = now()
        where id = $1 and lock_token = $2 and status = 'active'
      `,
      [input.id, input.lockToken, input.retry, input.errorMessage]
    );
    return (result.rowCount ?? 0) > 0;
  },

  async getJobCounts(statuses) {
    if (statuses.length === 0) {
      return {};
    }
    const result = await pool.query<{ status: string; count: string }>(
      `
        select case
                 when status = 'pending' and available_at > now() then 'delayed'
                 else status
               end as status,
               count(*)::text as count
        from local_work_queue
        where status = any($1::text[])
           or ('delayed' = any($1::text[]) and status = 'pending')
        group by 1
      `,
      [statuses]
    );
    return Object.fromEntries(
      statuses.map((status) => [
        status,
        Number(result.rows.find((row) => row.status === status)?.count ?? 0)
      ])
    );
  },

  async getOldestPendingAgeMs(queueName) {
    const result = await pool.query<{ age_ms: string | null }>(
      `select extract(epoch from (now() - min(created_at))) * 1000 as age_ms
       from local_work_queue
       where queue_name = $1 and status = 'pending'`,
      [queueName]
    );
    const value = result.rows[0]?.age_ms;
    return value === null || value === undefined
      ? null
      : Math.max(0, Number(value));
  }
});
