import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  repositoryReviewOptionsSchema,
  repositoryReviewSchema,
  repositoryReviewActionSchema,
  type RepositoryChangeInput,
  type RepositoryReviewOptions,
  type RepositoryReview
} from "@koed/shared";
import {
  mapRepositoryAssignment,
  type RepositoryAssignmentRow
} from "./repository-assignment.js";
import {
  recordRepositoryChange,
  mapRepositoryChange,
  lockRepositoryCheckout,
  repositoryReviewFailure,
  type RepositoryChangeRow
} from "./repository-change-events.js";

type Actor = { userId: string };
type ReviewRow = {
  id: string;
  owner_user_id: string;
  event_id: string;
  event_revision: number;
  options: RepositoryReviewOptions;
  sessions: RepositoryReview["sessions"];
  status: RepositoryReview["status"];
  selected_session_ids: string[] | null;
};
const transaction = async <T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
const eventFor = async (
  client: pg.PoolClient,
  actor: Actor,
  id: string
): Promise<RepositoryChangeRow> => {
  const row = (
    await client.query<RepositoryChangeRow>(
      "select * from repository_change_events where id=$1 and owner_user_id=$2",
      [id, actor.userId]
    )
  ).rows[0];
  return row ?? repositoryReviewFailure(404, "Repository change not found.");
};
const reviewFor = (
  row: ReviewRow,
  event: RepositoryChangeRow
): RepositoryReview =>
  repositoryReviewSchema.parse({
    id: row.id,
    event: mapRepositoryChange(event),
    options: row.options,
    sessions: row.sessions,
    count: row.sessions.length,
    status: row.status
  });
export const createRepositoryReviewRepository = (pool: pg.Pool) => ({
  async recordRepositoryChange(actor: Actor, input: RepositoryChangeInput) {
    return transaction(pool, (client) =>
      recordRepositoryChange(client, actor.userId, input)
    );
  },
  async listRepositoryChanges(actor: Actor, checkoutId?: string) {
    const result = await pool.query<RepositoryChangeRow>(
      `select * from repository_change_events where owner_user_id=$1 and status='pending' and ($2::text is null or checkout_id=$2) order by created_at desc,revision desc limit 100`,
      [actor.userId, checkoutId ?? null]
    );
    return result.rows.map(mapRepositoryChange);
  },
  async createRepositoryAssignmentReview(
    actor: Actor,
    eventId: string,
    rawOptions: RepositoryReviewOptions
  ) {
    const options = repositoryReviewOptionsSchema.parse(rawOptions);
    return transaction(pool, async (client) => {
      let event = await eventFor(client, actor, eventId);
      await lockRepositoryCheckout(
        client,
        actor.userId,
        event.originating_device_id,
        event.checkout_id
      );
      event = await eventFor(client, actor, eventId);
      if (event.status !== "pending")
        repositoryReviewFailure(409, "Repository change is no longer pending.");
      const rows = await client.query<
        RepositoryAssignmentRow & {
          id: string;
          metadata: Record<string, unknown>;
        }
      >(
        `select s.id,s.metadata,s.repository_assignment_state,s.repository_assignment_version,s.repository_automatic_identity,s.repository_override_identity from sessions s where s.owner_user_id=$1 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null and (
     (s.repository_automatic_identity->>'checkoutId'=$2 and s.repository_automatic_identity->>'originatingDeviceId'=$3)
     or ($5 and exists(select 1 from session_repository_observations o where o.session_id=s.id and o.owner_user_id=$1 and o.identity->>'checkoutId'=$2 and o.identity->>'originatingDeviceId'=$3))
   ) and (repository_scope_matches(s.repository_automatic_identity,repository_scope_id($4::jsonb)) or ($6 and s.repository_override_identity is not null) or ($5 and (s.repository_automatic_identity is null or s.repository_automatic_identity->>'kind'='unresolved')))
   and ($6 or s.repository_override_identity is null) order by s.id limit 501`,
        [
          actor.userId,
          event.checkout_id,
          event.originating_device_id,
          event.previous_identity,
          options.includeUnresolved,
          options.includeOverrides
        ]
      );
      if (rows.rows.length > 500)
        repositoryReviewFailure(
          409,
          "This review exceeds 500 sessions. Review a smaller checkout set."
        );
      const sessions = rows.rows.map((row) => ({
        id: row.id,
        name:
          typeof row.metadata.threadName === "string"
            ? row.metadata.threadName
            : "Captured Session",
        cwd: typeof row.metadata.cwd === "string" ? row.metadata.cwd : null,
        assignment: mapRepositoryAssignment(row)
      }));
      const result = await client.query<ReviewRow>(
        `insert into repository_assignment_reviews(id,owner_user_id,event_id,event_revision,options,sessions) values($1,$2,$3,$4,$5,$6) returning *`,
        [
          randomUUID(),
          actor.userId,
          event.id,
          event.revision,
          options,
          JSON.stringify(sessions)
        ]
      );
      return reviewFor(result.rows[0]!, event);
    });
  },
  async getRepositoryAssignmentReview(actor: Actor, reviewId: string) {
    return transaction(pool, async (client) => {
      const row =
        (
          await client.query<ReviewRow>(
            "select * from repository_assignment_reviews where id=$1 and owner_user_id=$2",
            [reviewId, actor.userId]
          )
        ).rows[0] ??
        repositoryReviewFailure(404, "Repository review not found.");
      return reviewFor(row, await eventFor(client, actor, row.event_id));
    });
  },
  async executeRepositoryAssignmentReview(
    actor: Actor,
    reviewId: string,
    rawAction: unknown
  ) {
    const action = repositoryReviewActionSchema.parse(rawAction);
    return transaction(pool, async (client) => {
      let row =
        (
          await client.query<ReviewRow>(
            "select * from repository_assignment_reviews where id=$1 and owner_user_id=$2",
            [reviewId, actor.userId]
          )
        ).rows[0] ??
        repositoryReviewFailure(404, "Repository review not found.");
      let event = await eventFor(client, actor, row.event_id);
      await lockRepositoryCheckout(
        client,
        actor.userId,
        event.originating_device_id,
        event.checkout_id
      );
      row = (
        await client.query<ReviewRow>(
          "select * from repository_assignment_reviews where id=$1 and owner_user_id=$2 for update",
          [reviewId, actor.userId]
        )
      ).rows[0]!;
      event = await eventFor(client, actor, row.event_id);
      if (row.event_revision !== action.expectedRevision)
        repositoryReviewFailure(409, "Repository review revision changed.");
      if (row.status !== "reviewed") {
        if (row.status === "dismissed") return reviewFor(row, event);
        repositoryReviewFailure(
          409,
          "Repository review has already been completed."
        );
      }
      if (
        event.status !== "pending" ||
        event.revision !== action.expectedRevision ||
        row.event_revision !== action.expectedRevision
      )
        repositoryReviewFailure(
          409,
          "Repository review is stale. Inspect the current change again."
        );
      const status = "dismissed";
      await client.query(
        "update repository_change_events set status=$2,completed_at=now() where id=$1",
        [event.id, status]
      );
      row = (
        await client.query<ReviewRow>(
          "update repository_assignment_reviews set status=$2,selected_session_ids=$3,completed_at=now() where id=$1 returning *",
          [reviewId, status, JSON.stringify([])]
        )
      ).rows[0]!;
      event = { ...event, status };
      return reviewFor(row, event);
    });
  }
});
export type RepositoryReviewRepository = ReturnType<
  typeof createRepositoryReviewRepository
>;
