import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { CreateWorkItem, PatchWorkItem, WorkItem } from "@koed/shared";
import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";

export class WorkItemUnavailableError extends Error {}
export class WorkItemConflictError extends Error {
  constructor(
    message: string,
    readonly current: WorkItem | null
  ) {
    super(message);
  }
}
export class WorkItemTransitionError extends Error {}
export class WorkItemCursorError extends Error {}
export class WorkItemGoneError extends Error {}

export interface WorkItemPage {
  items: WorkItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

const cursorTimePattern =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const encodeCursor = (
  ownerUserId: string,
  projectId: string,
  row: Row
): string =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      ownerUserId,
      projectId,
      createdAt: row.cursor_created_at,
      id: row.id
    }),
    "utf8"
  ).toString("base64url");

const decodeCursor = (
  cursor: string,
  ownerUserId: string,
  projectId: string
): { createdAt: string; id: string } => {
  if (
    !/^[A-Za-z0-9_-]{1,1000}$/.test(cursor) ||
    Buffer.from(cursor, "base64url").toString("base64url") !== cursor
  )
    throw new WorkItemCursorError("Work Item cursor is invalid");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new WorkItemCursorError("Work Item cursor is invalid");
  }
  if (!value || typeof value !== "object")
    throw new WorkItemCursorError("Work Item cursor is invalid");
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).sort().join(",") !==
      "createdAt,id,ownerUserId,projectId,v" ||
    payload.v !== 1 ||
    payload.ownerUserId !== ownerUserId ||
    payload.projectId !== projectId ||
    typeof payload.createdAt !== "string" ||
    !cursorTimePattern.test(payload.createdAt) ||
    typeof payload.id !== "string" ||
    !uuidPattern.test(payload.id) ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    new Date(payload.createdAt).toISOString().slice(0, 10) !==
      payload.createdAt.slice(0, 10)
  )
    throw new WorkItemCursorError(
      "Work Item cursor is invalid or belongs to another Project"
    );
  return { createdAt: payload.createdAt, id: payload.id };
};

export const workItemDispatchKey = (itemId: string, versionAtSend: number) =>
  `${itemId}:${versionAtSend}`;

export const workItemPlanLineKey = (sourceRevisionId: string, line: string) => {
  const normalized = line
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
  if (!normalized) throw new Error("Plan line must not be blank");
  return `${sourceRevisionId}:${createHash("sha256").update(normalized).digest("hex")}`;
};

type Row = Record<string, unknown>;
const publicRecord = (row: Row): WorkItem => ({
  id: row.id as string,
  projectId: row.project_id as string,
  kind: row.kind as WorkItem["kind"],
  key: row.key as string | null,
  title: row.title as string,
  goal: row.goal as string,
  origin: row.origin as string,
  originRef: row.origin_ref as string | null,
  idempotencyKey: row.idempotency_key as string | null,
  status: row.status as WorkItem["status"],
  blockedReason: row.blocked_reason as string | null,
  assigneeAgentId: row.assignee_agent_id as string | null,
  executionId: row.execution_id as string | null,
  dispatchKey: row.dispatch_key as string | null,
  prProvider: row.pr_provider as string | null,
  prNumber: row.pr_number as number | null,
  prUrl: row.pr_url as string | null,
  prState: row.pr_state as string | null,
  dueOn:
    row.due_on instanceof Date
      ? `${row.due_on.getFullYear()}-${String(row.due_on.getMonth() + 1).padStart(2, "0")}-${String(row.due_on.getDate()).padStart(2, "0")}`
      : (row.due_on as string | null),
  doneAt: row.done_at ? (row.done_at as Date).toISOString() : null,
  doneBy: row.done_by as string | null,
  createdBy: row.created_by as string,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
  version: row.version as number
});

export type WorkItemTransitionEvent =
  | "dispatch"
  | "pr_opened"
  | "completed_without_pr"
  | "execution_failed"
  | "waiting_for_approval"
  | "pr_merged"
  | "pr_closed_unmerged"
  | "user_mark_done"
  | "user_untick"
  | "user_back_to_todo";

export type TrustedWorkItemTransitionEvent = Exclude<
  WorkItemTransitionEvent,
  "user_mark_done" | "user_untick" | "user_back_to_todo"
>;

export type TrustedWorkItemEvidence =
  | { event: "dispatch"; executionId: string; assigneeAgentId: string }
  | {
      event: "pr_opened";
      executionId: string;
      prProvider: string;
      prNumber: number;
      prUrl: string;
    }
  | {
      event: "completed_without_pr" | "waiting_for_approval";
      executionId: string;
    }
  | { event: "execution_failed"; executionId: string; reason: string }
  | {
      event: "pr_merged" | "pr_closed_unmerged";
      executionId: string;
      prProvider: string;
      prNumber: number;
      prUrl: string;
    };

export type VerifyTrustedWorkItemTransition = (input: {
  client: pg.PoolClient;
  ownerUserId: string;
  current: WorkItem;
  event: TrustedWorkItemTransitionEvent;
}) => Promise<TrustedWorkItemEvidence | null>;

export function nextWorkItemStatus(
  status: WorkItem["status"],
  event: WorkItemTransitionEvent
): WorkItem["status"] {
  if (event === "user_mark_done") return "done";
  if (event === "user_untick" && status === "done") return "todo";
  if (event === "user_back_to_todo" && status === "blocked") return "todo";
  if (event === "dispatch" && (status === "todo" || status === "blocked"))
    return "doing";
  if (event === "pr_opened" && status === "doing") return "review";
  if (event === "completed_without_pr" && status === "doing") return "done";
  if (event === "execution_failed" && status === "doing") return "blocked";
  if (event === "waiting_for_approval" && status === "doing") return "doing";
  if (event === "pr_merged" && status === "review") return "done";
  if (event === "pr_closed_unmerged" && status === "review") return "blocked";
  throw new WorkItemTransitionError(
    `Illegal Work Item transition: ${status} / ${event}`
  );
}

const lockActiveProject = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string
) => {
  const result = await client.query(
    `select id from projects where id=$1 and owner_user_id=$2 and lifecycle='active'
       and team_backend_id is null and team_workspace_id is null and workspace_project_id is null
       for share`,
    [projectId, ownerUserId]
  );
  if (!result.rowCount)
    throw new WorkItemUnavailableError("Project is unavailable");
};

const emitChanged = async (
  client: pg.PoolClient,
  ownerUserId: string,
  itemId: string
) => {
  await appendCollaborationOutboxEventWithClient(client, {
    family: "work_item_changed",
    scope: "personal",
    personalOwnerUserId: ownerUserId,
    teamId: null,
    teamWorkspaceId: null,
    threadId: null,
    messageId: null,
    shareGrantId: null,
    logicalMemoryId: null,
    resourceType: "project_work_item",
    resourceId: itemId,
    actorPrincipalId: ownerUserId,
    mutationId: randomUUID()
  });
};

const inTransaction = async <T>(
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

const creationPayloadHash = (input: CreateWorkItem) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        key: input.key ?? null,
        title: input.title,
        goal: input.goal,
        origin: input.origin,
        originRef: input.originRef ?? null,
        dueOn: input.dueOn ?? null
      })
    )
    .digest("hex");

export const createWorkItemRepository = (
  pool: pg.Pool,
  options: { verifyTrustedTransition?: VerifyTrustedWorkItemTransition } = {}
) => ({
  async list(
    ownerUserId: string,
    projectId: string,
    input: { limit?: number; cursor?: string } = {}
  ): Promise<WorkItemPage> {
    return inTransaction(pool, async (client) => {
      await lockActiveProject(client, ownerUserId, projectId);
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new WorkItemCursorError("Work Item page limit is invalid");
      const after = input.cursor
        ? decodeCursor(input.cursor, ownerUserId, projectId)
        : null;
      const rows = await client.query<Row>(
        `select *, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
           from project_work_items where owner_user_id=$1 and project_id=$2 and deleted_at is null
           and ($3::timestamptz is null or (created_at,id) < ($3::timestamptz,$4::uuid))
           order by created_at desc,id desc limit $5`,
        [
          ownerUserId,
          projectId,
          after?.createdAt ?? null,
          after?.id ?? null,
          limit + 1
        ]
      );
      const hasMore = rows.rows.length > limit;
      const pageRows = rows.rows.slice(0, limit);
      return {
        items: pageRows.map(publicRecord),
        hasMore,
        nextCursor: hasMore
          ? encodeCursor(ownerUserId, projectId, pageRows.at(-1)!)
          : null
      };
    });
  },
  async getForRealtime(
    ownerUserId: string,
    itemId: string
  ): Promise<WorkItem | null> {
    const result = await pool.query<Row>(
      `select wi.* from project_work_items wi join projects p on p.id=wi.project_id
       and p.owner_user_id=wi.owner_user_id where wi.id=$1 and wi.owner_user_id=$2
       and wi.deleted_at is null and p.lifecycle='active' and p.team_backend_id is null
       and p.team_workspace_id is null and p.workspace_project_id is null`,
      [itemId, ownerUserId]
    );
    return result.rows[0] ? publicRecord(result.rows[0]) : null;
  },
  async create(
    ownerUserId: string,
    projectId: string,
    input: CreateWorkItem
  ): Promise<WorkItem> {
    return inTransaction(pool, async (client) => {
      await lockActiveProject(client, ownerUserId, projectId);
      if (input.idempotencyKey)
        await client.query(
          `select pg_advisory_xact_lock(hashtextextended($1,0))`,
          [
            `work-item-create:${ownerUserId}:${projectId}:${input.origin}:${input.idempotencyKey}`
          ]
        );
      const existing = input.idempotencyKey
        ? await client.query<Row>(
            `select * from project_work_items where owner_user_id=$1 and project_id=$2
         and origin=$3 and idempotency_key=$4 for update`,
            [ownerUserId, projectId, input.origin, input.idempotencyKey]
          )
        : null;
      if (existing?.rows[0]) {
        const deleted = existing.rows[0].deleted_at !== null;
        if (
          existing.rows[0].creation_payload_hash !== creationPayloadHash(input)
        )
          throw new WorkItemConflictError(
            "Idempotency key has a different payload",
            deleted ? null : publicRecord(existing.rows[0])
          );
        if (deleted) throw new WorkItemGoneError("Work Item was deleted");
        return publicRecord(existing.rows[0]);
      }
      const result = await client.query<Row>(
        `insert into project_work_items
         (owner_user_id,project_id,kind,key,title,goal,origin,origin_ref,idempotency_key,creation_payload_hash,due_on,created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1) returning *`,
        [
          ownerUserId,
          projectId,
          input.kind,
          input.key ?? null,
          input.title,
          input.goal,
          input.origin,
          input.originRef ?? null,
          input.idempotencyKey ?? null,
          creationPayloadHash(input),
          input.dueOn ?? null
        ]
      );
      const item = publicRecord(result.rows[0]!);
      await emitChanged(client, ownerUserId, item.id);
      return item;
    });
  },
  async patch(
    ownerUserId: string,
    itemId: string,
    input: PatchWorkItem
  ): Promise<WorkItem> {
    return inTransaction(pool, async (client) => {
      const binding = await client.query<{ project_id: string }>(
        `select project_id from project_work_items where id=$1 and owner_user_id=$2 and deleted_at is null`,
        [itemId, ownerUserId]
      );
      if (!binding.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      await lockActiveProject(client, ownerUserId, binding.rows[0].project_id);
      const found = await client.query<Row>(
        `select wi.* from project_work_items wi join projects p on p.id=wi.project_id
         and p.owner_user_id=wi.owner_user_id where wi.id=$1 and wi.owner_user_id=$2
         and p.lifecycle='active' and p.team_backend_id is null and p.team_workspace_id is null
         and p.workspace_project_id is null and wi.deleted_at is null for update of wi`,
        [itemId, ownerUserId]
      );
      if (!found.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      const current = publicRecord(found.rows[0]);
      if (current.version !== input.version)
        throw new WorkItemConflictError("Version conflict", current);
      const status =
        input.action === "mark_done"
          ? nextWorkItemStatus(current.status, "user_mark_done")
          : input.action === "untick"
            ? nextWorkItemStatus(current.status, "user_untick")
            : input.action === "back_to_todo"
              ? nextWorkItemStatus(current.status, "user_back_to_todo")
              : current.status;
      const result = await client.query<Row>(
        `update project_work_items set title=$3,goal=$4,due_on=$5,status=$6,
         blocked_reason=case when $6='blocked' then blocked_reason else null end,
         done_at=case when $6='done' then coalesce(done_at,now()) else null end,
         done_by=case when $7='mark_done' then $2 when $6='done' then done_by else null end,
         version=version+1,updated_at=now() where id=$1 and owner_user_id=$2 returning *`,
        [
          itemId,
          ownerUserId,
          input.title ?? current.title,
          input.goal ?? current.goal,
          input.dueOn === undefined ? current.dueOn : input.dueOn,
          status,
          input.action ?? null
        ]
      );
      const item = publicRecord(result.rows[0]!);
      await emitChanged(client, ownerUserId, item.id);
      return item;
    });
  },
  async transitionTrusted(
    ownerUserId: string,
    itemId: string,
    expectedVersion: number,
    event: TrustedWorkItemTransitionEvent
  ): Promise<WorkItem> {
    // Production stays unavailable until HQ-404/HQ-405 install evidence
    // adapters for their exact Managed Conversation and provider bindings.
    if (!options.verifyTrustedTransition)
      throw new WorkItemTransitionError(
        "Trusted Work Item transition is unavailable"
      );
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new WorkItemTransitionError("Expected version is invalid");
    if (
      ![
        "dispatch",
        "pr_opened",
        "completed_without_pr",
        "execution_failed",
        "waiting_for_approval",
        "pr_merged",
        "pr_closed_unmerged"
      ].includes(event)
    )
      throw new WorkItemTransitionError("Trusted transition event is invalid");
    return inTransaction(pool, async (client) => {
      const binding = await client.query<{ project_id: string }>(
        `select project_id from project_work_items where id=$1 and owner_user_id=$2 and deleted_at is null`,
        [itemId, ownerUserId]
      );
      if (!binding.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      await lockActiveProject(client, ownerUserId, binding.rows[0].project_id);
      const found = await client.query<Row>(
        `select * from project_work_items where id=$1 and owner_user_id=$2 and deleted_at is null for update`,
        [itemId, ownerUserId]
      );
      if (!found.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      const current = publicRecord(found.rows[0]);
      if (current.version !== expectedVersion)
        throw new WorkItemConflictError("Version conflict", current);
      const status = nextWorkItemStatus(current.status, event);
      const evidence = await options.verifyTrustedTransition!({
        client,
        ownerUserId,
        current,
        event
      });
      if (!evidence || evidence.event !== event)
        throw new WorkItemTransitionError(
          "Trusted transition evidence is unavailable"
        );
      if (event === "dispatch") {
        if (
          evidence.event !== "dispatch" ||
          !evidence.executionId ||
          !evidence.assigneeAgentId
        )
          throw new WorkItemTransitionError("Dispatch binding is invalid");
      } else {
        if (
          !evidence.executionId ||
          current.executionId !== evidence.executionId
        )
          throw new WorkItemTransitionError("Execution binding changed");
      }
      if (
        event === "completed_without_pr" &&
        (current.prProvider ||
          current.prNumber ||
          current.prUrl ||
          current.prState)
      )
        throw new WorkItemTransitionError(
          "A linked PR cannot complete without a merge"
        );
      if (event === "pr_opened") {
        if (
          evidence.event !== "pr_opened" ||
          current.prProvider ||
          current.prNumber ||
          !evidence.prProvider ||
          !Number.isSafeInteger(evidence.prNumber) ||
          evidence.prNumber < 1 ||
          !evidence.prUrl
        )
          throw new WorkItemTransitionError("PR opening evidence is invalid");
      }
      if (event === "pr_merged" || event === "pr_closed_unmerged") {
        if (
          (evidence.event !== "pr_merged" &&
            evidence.event !== "pr_closed_unmerged") ||
          current.prProvider !== evidence.prProvider ||
          current.prNumber !== evidence.prNumber ||
          !current.prUrl ||
          current.prUrl !== evidence.prUrl
        )
          throw new WorkItemTransitionError("PR binding changed");
      }
      if (
        event === "execution_failed" &&
        (evidence.event !== "execution_failed" || !evidence.reason.trim())
      )
        throw new WorkItemTransitionError("Failure evidence is invalid");
      const blockedReason =
        event === "execution_failed" && evidence.event === "execution_failed"
          ? evidence.reason
          : event === "pr_closed_unmerged"
            ? `PR #${current.prNumber} was closed without merging`
            : null;
      const prProvider =
        event === "dispatch"
          ? null
          : event === "pr_opened" && evidence.event === "pr_opened"
            ? evidence.prProvider
            : current.prProvider;
      const prNumber =
        event === "dispatch"
          ? null
          : event === "pr_opened" && evidence.event === "pr_opened"
            ? evidence.prNumber
            : current.prNumber;
      const prUrl =
        event === "dispatch"
          ? null
          : event === "pr_opened" && evidence.event === "pr_opened"
            ? evidence.prUrl
            : current.prUrl;
      const prState =
        event === "dispatch"
          ? null
          : event === "pr_opened"
            ? "open"
            : event === "pr_merged"
              ? "merged"
              : event === "pr_closed_unmerged"
                ? "closed"
                : current.prState;
      const result = await client.query<Row>(
        `update project_work_items set status=$3,blocked_reason=$4,
           assignee_agent_id=$5,execution_id=$6,dispatch_key=$7,
           pr_provider=$8,pr_number=$9,pr_url=$10,pr_state=$11,
           done_at=case when $3='done' then now() else null end,done_by=null,
           version=version+1,updated_at=now()
         where id=$1 and owner_user_id=$2 and version=$12 returning *`,
        [
          itemId,
          ownerUserId,
          status,
          blockedReason,
          event === "dispatch" && evidence.event === "dispatch"
            ? evidence.assigneeAgentId
            : current.assigneeAgentId,
          event === "dispatch" && evidence.event === "dispatch"
            ? evidence.executionId
            : current.executionId,
          event === "dispatch"
            ? workItemDispatchKey(itemId, current.version)
            : current.dispatchKey,
          prProvider,
          prNumber,
          prUrl,
          prState,
          expectedVersion
        ]
      );
      if (!result.rows[0])
        throw new WorkItemConflictError("Version conflict", current);
      const updated = publicRecord(result.rows[0]);
      await emitChanged(client, ownerUserId, updated.id);
      return updated;
    });
  },
  async deleteTodo(ownerUserId: string, itemId: string): Promise<void> {
    await inTransaction(pool, async (client) => {
      const binding = await client.query<{ project_id: string }>(
        `select project_id from project_work_items where id=$1 and owner_user_id=$2 and deleted_at is null`,
        [itemId, ownerUserId]
      );
      if (!binding.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      await lockActiveProject(client, ownerUserId, binding.rows[0].project_id);
      const found = await client.query<Row>(
        `select wi.* from project_work_items wi join projects p on p.id=wi.project_id
         and p.owner_user_id=wi.owner_user_id where wi.id=$1 and wi.owner_user_id=$2
         and p.lifecycle='active' and p.team_backend_id is null and p.team_workspace_id is null
         and p.workspace_project_id is null and wi.deleted_at is null for update of wi`,
        [itemId, ownerUserId]
      );
      if (!found.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      const item = publicRecord(found.rows[0]);
      if (item.kind !== "todo")
        throw new WorkItemTransitionError("Only to-dos can be deleted");
      await client.query(
        `update project_work_items set deleted_at=now(),updated_at=now(),version=version+1
         where id=$1 and owner_user_id=$2 and deleted_at is null`,
        [itemId, ownerUserId]
      );
      await emitChanged(client, ownerUserId, itemId);
    });
  }
});
export type WorkItemRepository = ReturnType<typeof createWorkItemRepository>;
