import type pg from "pg";

export type ProjectActivityKind =
  | "work_item_created"
  | "work_item_status"
  | "work_item_done"
  | "source_added"
  | "source_ready"
  | "source_failed"
  | "pr_opened"
  | "pr_merged"
  | "assertion_created";

export type ProjectActivityWriteKind = Extract<
  ProjectActivityKind,
  | "work_item_created"
  | "work_item_status"
  | "work_item_done"
  | "source_added"
  | "source_ready"
  | "source_failed"
  | "pr_opened"
  | "pr_merged"
>;

const availableWriteKinds = new Set<ProjectActivityWriteKind>([
  "work_item_created",
  "work_item_status",
  "work_item_done",
  "source_added",
  "source_ready",
  "source_failed",
  "pr_opened",
  "pr_merged"
]);

export class ProjectActivityUnavailableError extends Error {}
export class ProjectActivityCursorError extends Error {}

type Cursor = {
  v: 1;
  ownerUserId: string;
  projectId: string;
  sequence: string;
};
const encode = (ownerUserId: string, projectId: string, sequence: string) =>
  Buffer.from(
    JSON.stringify({ v: 1, ownerUserId, projectId, sequence } satisfies Cursor)
  ).toString("base64url");
const decode = (
  value: string,
  ownerUserId: string,
  projectId: string
): bigint => {
  if (
    !/^[A-Za-z0-9_-]{1,500}$/.test(value) ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  )
    throw new ProjectActivityCursorError("Project activity cursor is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new ProjectActivityCursorError("Project activity cursor is invalid");
  }
  if (!parsed || typeof parsed !== "object")
    throw new ProjectActivityCursorError("Project activity cursor is invalid");
  const cursor = parsed as Record<string, unknown>;
  if (
    Object.keys(cursor).sort().join(",") !==
      "ownerUserId,projectId,sequence,v" ||
    cursor.v !== 1 ||
    cursor.ownerUserId !== ownerUserId ||
    cursor.projectId !== projectId ||
    typeof cursor.sequence !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(cursor.sequence)
  )
    throw new ProjectActivityCursorError(
      "Project activity cursor is invalid or belongs to another Project"
    );
  const sequence = BigInt(cursor.sequence);
  if (sequence > 9223372036854775807n)
    throw new ProjectActivityCursorError("Project activity cursor is invalid");
  return sequence;
};

const activeProject = async (
  client: pg.PoolClient | pg.Pool,
  ownerUserId: string,
  projectId: string,
  lock: "share" | "update" | null = null
) => {
  const result = await client.query(
    `select id from projects where owner_user_id=$1 and id=$2 and lifecycle='active' and deletion_phase is null ${lock === "update" ? "for update" : lock === "share" ? "for share" : ""}`,
    [ownerUserId, projectId]
  );
  if (!result.rowCount)
    throw new ProjectActivityUnavailableError(
      "Project activity is unavailable"
    );
};

/** Called only by a trusted writer in the same transaction as its source mutation.
 * The caller must acquire the Project row FOR UPDATE before mutating its source.
 */
export const appendProjectActivityWithClient = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    projectId: string;
    actorUserId: string;
    kind: ProjectActivityWriteKind;
    ref: string;
  }
) => {
  if (!availableWriteKinds.has(input.kind))
    throw new Error("Personal Project activity kind is unavailable");
  if (input.actorUserId !== input.ownerUserId)
    throw new Error("Personal Project activity actor is not the owner");
  await activeProject(client, input.ownerUserId, input.projectId, "update");
  if (!input.ref.trim())
    throw new Error("Project activity reference is required");
  const result = await client.query<{ sequence: string }>(
    `insert into project_activity(owner_user_id,project_id,sequence,actor_user_id,kind,ref,at)
     select $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5,clock_timestamp() from project_activity
       where owner_user_id=$1 and project_id=$2
     on conflict (owner_user_id,project_id,kind,ref) do nothing returning sequence`,
    [
      input.ownerUserId,
      input.projectId,
      input.actorUserId,
      input.kind,
      input.ref
    ]
  );
  return result.rows[0]?.sequence ?? null;
};

const transaction = async <T>(
  pool: pg.Pool,
  action: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const readActiveProject = async <T>(
  pool: pg.Pool,
  ownerUserId: string,
  projectId: string,
  read: (client: pg.PoolClient) => Promise<T>
): Promise<T> =>
  transaction(pool, async (client) => {
    await activeProject(client, ownerUserId, projectId, "share");
    return read(client);
  });

export const createProjectActivityRepository = (pool: pg.Pool) => ({
  async summary(ownerUserId: string, projectId: string) {
    return readActiveProject(pool, ownerUserId, projectId, async (client) => {
      // PostgreSQL now() is the server clock. Seven UTC calendar dates include
      // today, from the start of day six dates ago through the current instant.
      const result = await client.query<{
        day: string;
        count: number;
        done: number;
        merged: number;
      }>(
        `with dates as (select generate_series(
         (now() at time zone 'UTC')::date - 6,
         (now() at time zone 'UTC')::date, interval '1 day')::date as day)
       select to_char(dates.day,'YYYY-MM-DD') as day, count(a.sequence)::integer as count,
         count(a.sequence) filter (where a.kind='work_item_done')::integer as done,
         count(a.sequence) filter (where a.kind='pr_merged')::integer as merged
         from dates left join project_activity a on a.owner_user_id=$1 and a.project_id=$2
          and a.at >= dates.day::timestamp at time zone 'UTC'
          and a.at < (dates.day+1)::timestamp at time zone 'UTC' and a.at <= now()
        group by dates.day order by dates.day`,
        [ownerUserId, projectId]
      );
      return {
        days: result.rows.map((row) => ({ date: row.day, count: row.count })),
        total: result.rows.reduce((sum, row) => sum + row.count, 0),
        outcomes: {
          days: result.rows.map((row) => ({
            date: row.day,
            count: row.done + row.merged
          })),
          done: result.rows.reduce((sum, row) => sum + row.done, 0),
          merged: result.rows.reduce((sum, row) => sum + row.merged, 0)
        }
      };
    });
  },
  async list(
    ownerUserId: string,
    projectId: string,
    input: { after?: string; limit?: number } = {}
  ) {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ProjectActivityCursorError(
        "Project activity page limit is invalid"
      );
    const after = input.after
      ? decode(input.after, ownerUserId, projectId)
      : 0n;
    return readActiveProject(pool, ownerUserId, projectId, async (client) => {
      const rows = await client.query<{
        sequence: string;
        actor_user_id: string;
        kind: ProjectActivityKind;
        ref: string;
        at: Date;
      }>(
        `select sequence,actor_user_id,kind,ref,at from project_activity
        where owner_user_id=$1 and project_id=$2 and sequence>$3 order by sequence limit $4`,
        [ownerUserId, projectId, after.toString(), limit + 1]
      );
      const selected = rows.rows.slice(0, limit);
      return {
        items: selected.map((row) => ({
          cursor: encode(ownerUserId, projectId, row.sequence),
          actorUserId: row.actor_user_id,
          kind: row.kind,
          ref: row.ref,
          at: row.at.toISOString()
        })),
        hasMore: rows.rows.length > limit,
        nextCursor: selected.length
          ? encode(ownerUserId, projectId, selected.at(-1)!.sequence)
          : null
      };
    });
  },
  async seen(ownerUserId: string, projectId: string) {
    return readActiveProject(pool, ownerUserId, projectId, async (client) => {
      const row = await client.query<{ seen_sequence: string; seen_at: Date }>(
        `select seen_sequence,seen_at from project_seen where owner_user_id=$1 and project_id=$2`,
        [ownerUserId, projectId]
      );
      return {
        cursor: encode(
          ownerUserId,
          projectId,
          row.rows[0]?.seen_sequence ?? "0"
        ),
        at: row.rows[0]?.seen_at.toISOString() ?? null
      };
    });
  },
  async acknowledge(ownerUserId: string, projectId: string, cursor: string) {
    const sequence = decode(cursor, ownerUserId, projectId);
    return transaction(pool, async (client) => {
      await activeProject(client, ownerUserId, projectId, "update");
      if (sequence > 0n) {
        const exists = await client.query(
          `select 1 from project_activity where owner_user_id=$1 and project_id=$2 and sequence=$3`,
          [ownerUserId, projectId, sequence.toString()]
        );
        if (!exists.rowCount)
          throw new ProjectActivityCursorError(
            "Project activity cursor is not a committed event"
          );
      }
      const result = await client.query<{
        seen_sequence: string;
        seen_at: Date;
      }>(
        `insert into project_seen(owner_user_id,project_id,seen_sequence) values ($1,$2,$3)
         on conflict(owner_user_id,project_id) do update set
          seen_sequence=greatest(project_seen.seen_sequence,excluded.seen_sequence),
          seen_at=case when excluded.seen_sequence > project_seen.seen_sequence then now() else project_seen.seen_at end
         returning seen_sequence,seen_at`,
        [ownerUserId, projectId, sequence.toString()]
      );
      return {
        cursor: encode(ownerUserId, projectId, result.rows[0]!.seen_sequence),
        at: result.rows[0]!.seen_at.toISOString()
      };
    });
  }
});
export type ProjectActivityRepository = ReturnType<
  typeof createProjectActivityRepository
>;
