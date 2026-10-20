import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { CreateWorkItem, PatchWorkItem, WorkItem } from "@koed/shared";
import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { appendProjectActivityWithClient } from "./project-activity-repository.js";

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
  projectId: string,
  lock: "share" | "update" = "update"
) => {
  const result = await client.query(
    `select id from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null
       and team_backend_id is null and team_workspace_id is null and workspace_project_id is null
       for ${lock}`,
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
  async getSharedDispatchLink(ownerUserId: string, personalProjectId: string) {
    const result = await pool.query<{
      team_backend_id: string;
      workspace_project_id: string;
      team_principal_user_id: string;
    }>(
      `select project.team_backend_id,project.workspace_project_id,
              binding.team_principal_user_id
         from projects project
         join personal_workspace_project_principal_bindings binding
           on binding.local_user_id=project.owner_user_id
          and binding.team_backend_id=project.team_backend_id
        where project.id=$1 and project.owner_user_id=$2
          and project.lifecycle='active' and project.deletion_phase is null
          and project.team_backend_id is not null
          and project.workspace_project_id is not null
          and not exists (
            select 1 from personal_workspace_project_share_attempts attempt
             where attempt.personal_project_id=project.id
               and attempt.state='pending'
          )`,
      [personalProjectId, ownerUserId]
    );
    const row = result.rows[0];
    return row
      ? {
          teamBackendId: row.team_backend_id,
          workspaceProjectId: row.workspace_project_id,
          teamPrincipalUserId: row.team_principal_user_id
        }
      : null;
  },
  async hasActiveManagedWorkItem(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
  }): Promise<boolean> {
    const found = await pool.query(
      `select 1 from project_work_items wi
         join projects project on project.id=wi.project_id and project.owner_user_id=wi.owner_user_id
         join managed_conversation_executions execution on execution.id=wi.execution_id
       where wi.owner_user_id=$1 and wi.execution_id=$2 and wi.status='doing'
         and wi.deleted_at is null and wi.dispatch_key is not null
         and project.lifecycle='active' and project.deletion_phase is null
         and project.team_backend_id is null and project.team_workspace_id is null
         and project.workspace_project_id is null
         and execution.owner_user_id=$1 and execution.project_id=wi.project_id::text
         and execution.execution_generation=$3
         and execution.state in ('starting','running','reconciling') limit 1`,
      [input.ownerUserId, input.executionId, input.executionGeneration]
    );
    return Boolean(found.rowCount);
  },
  async briefSources(
    ownerUserId: string,
    projectId: string
  ): Promise<
    Array<{
      id: string;
      kind: string;
      name: string;
      uri: string | null;
      currentRevisionId: string | null;
    }>
  > {
    return inTransaction(pool, async (client) => {
      await lockActiveProject(client, ownerUserId, projectId, "share");
      const rows = await client.query<{
        id: string;
        kind: string;
        name: string;
        uri: string | null;
        currentRevisionId: string | null;
      }>(
        `select id,kind,name,uri,current_revision_id as "currentRevisionId" from project_sources
         where owner_user_id=$1 and project_id=$2 and deleted_at is null
           and remove_batch_id is null and status='ready'
         order by created_at desc,id desc limit 20`,
        [ownerUserId, projectId]
      );
      return rows.rows;
    });
  },
  async list(
    ownerUserId: string,
    projectId: string,
    input: { limit?: number; cursor?: string } = {}
  ): Promise<WorkItemPage> {
    return inTransaction(pool, async (client) => {
      await lockActiveProject(client, ownerUserId, projectId, "share");
      const ended = await client.query<{ id: string }>(
        `update project_work_items wi set status='blocked',
           blocked_reason=case execution.state
             when 'failed' then 'Agent execution failed'
             when 'fenced' then 'Agent execution was interrupted'
             else 'Agent execution was cancelled' end,
           version=wi.version+1,updated_at=now()
          from managed_conversation_executions execution
         where wi.owner_user_id=$1 and wi.project_id=$2 and wi.status='doing'
           and wi.execution_id=execution.id and execution.owner_user_id=$1
           and execution.state in ('failed','stopped','fenced')
         returning wi.id`,
        [ownerUserId, projectId]
      );
      for (const row of ended.rows)
        await emitChanged(client, ownerUserId, row.id);
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
       and wi.deleted_at is null and p.lifecycle='active' and p.deletion_phase is null and p.team_backend_id is null
       and p.team_workspace_id is null and p.workspace_project_id is null`,
      [itemId, ownerUserId]
    );
    return result.rows[0] ? publicRecord(result.rows[0]) : null;
  },
  async completeFromManagedCommandLease(input: {
    ownerUserId: string;
    itemId: string;
    expectedVersion: number;
    commandId: string;
    leaseToken: string;
  }): Promise<WorkItem> {
    if (
      !uuidPattern.test(input.leaseToken) ||
      !uuidPattern.test(input.commandId) ||
      !Number.isSafeInteger(input.expectedVersion)
    )
      throw new WorkItemTransitionError(
        "Trusted completion evidence is invalid"
      );
    return inTransaction(pool, async (client) => {
      const scope = await client.query<{ project_id: string }>(
        `select project_id from project_work_items
         where id=$1 and owner_user_id=$2 and deleted_at is null`,
        [input.itemId, input.ownerUserId]
      );
      if (!scope.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      await lockActiveProject(
        client,
        input.ownerUserId,
        scope.rows[0].project_id
      );
      const found = await client.query<Row>(
        `select wi.* from project_work_items wi
          join projects p on p.id=wi.project_id and p.owner_user_id=wi.owner_user_id
         where wi.id=$1 and wi.owner_user_id=$2 and wi.deleted_at is null
           and p.lifecycle='active' and p.deletion_phase is null
           and p.team_backend_id is null and p.team_workspace_id is null
           and p.workspace_project_id is null
         for update of wi`,
        [input.itemId, input.ownerUserId]
      );
      if (!found.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      const current = publicRecord(found.rows[0]);
      if (current.version !== input.expectedVersion)
        throw new WorkItemConflictError("Version conflict", current);
      if (
        current.status !== "doing" ||
        !current.executionId ||
        !current.dispatchKey ||
        current.prProvider ||
        current.prNumber ||
        current.prUrl ||
        current.prState
      )
        throw new WorkItemTransitionError(
          "Work Item cannot complete without a merged PR"
        );
      const execution = await client.query<{ execution_generation: number }>(
        `select execution_generation from managed_conversation_executions
         where id=$1 and owner_user_id=$2 and project_id=$3
           and state in ('starting','running','reconciling') for update`,
        [current.executionId, input.ownerUserId, current.projectId]
      );
      if (!execution.rows[0])
        throw new WorkItemTransitionError(
          "Managed runtime lease is unavailable"
        );
      const command = await client.query(
        `select 1 from managed_conversation_commands
         where id=$1 and owner_user_id=$2 and execution_id=$3
           and lease_token=$4 and lease_expires_at>now()
           and state='dispatching' and execution_generation=$5 for update`,
        [
          input.commandId,
          input.ownerUserId,
          current.executionId,
          input.leaseToken,
          execution.rows[0].execution_generation
        ]
      );
      if (!command.rowCount)
        throw new WorkItemTransitionError(
          "Managed runtime lease is unavailable"
        );
      const changed = await client.query<Row>(
        `update project_work_items set status='done',done_at=now(),done_by=null,
           version=version+1,updated_at=now()
         where id=$1 and owner_user_id=$2 and version=$3 returning *`,
        [input.itemId, input.ownerUserId, input.expectedVersion]
      );
      const completed = publicRecord(changed.rows[0]!);
      await appendProjectActivityWithClient(client, {
        ownerUserId: input.ownerUserId,
        projectId: completed.projectId,
        actorUserId: input.ownerUserId,
        kind: "work_item_done",
        ref: `${completed.id}:${completed.version}`
      });
      await emitChanged(client, input.ownerUserId, completed.id);
      return completed;
    });
  },
  async completeForManagedExecutionLease(input: {
    ownerUserId: string;
    executionId: string;
    commandId: string;
    leaseToken: string;
  }): Promise<WorkItem> {
    const found = await pool.query<{ id: string; version: number }>(
      `select id,version from project_work_items
       where owner_user_id=$1 and execution_id=$2 and status='doing' and deleted_at is null`,
      [input.ownerUserId, input.executionId]
    );
    if (found.rows.length !== 1)
      throw new WorkItemTransitionError(
        "Managed execution has no unique active Work Item"
      );
    return this.completeFromManagedCommandLease({
      ownerUserId: input.ownerUserId,
      itemId: found.rows[0]!.id,
      expectedVersion: found.rows[0]!.version,
      commandId: input.commandId,
      leaseToken: input.leaseToken
    });
  },
  async linkReviewRequestFromSourceControl(input: {
    ownerUserId: string;
    executionId: string;
    executionGeneration: number;
    provider: string;
    number: number;
    url: string;
  }): Promise<WorkItem | null> {
    return inTransaction(pool, async (client) => {
      const linked = await client.query<{ id: string; project_id: string }>(
        `select id,project_id from project_work_items
         where execution_id=$1 and owner_user_id=$2 and deleted_at is null`,
        [input.executionId, input.ownerUserId]
      );
      if (!linked.rows[0]) return null;
      await lockActiveProject(
        client,
        input.ownerUserId,
        linked.rows[0].project_id
      );
      const found = await client.query<Row>(
        `select * from project_work_items where owner_user_id=$1 and execution_id=$2
           and project_id=$3 and id=$4 and deleted_at is null for update`,
        [
          input.ownerUserId,
          input.executionId,
          linked.rows[0].project_id,
          linked.rows[0].id
        ]
      );
      if (!found.rows[0]) return null;
      const current = publicRecord(found.rows[0]);
      const currentExecution = await client.query<{
        execution_generation: number;
        state: string;
      }>(
        `select execution_generation,state from managed_conversation_executions
         where id=$1 and owner_user_id=$2 and project_id=$3 for update`,
        [input.executionId, input.ownerUserId, current.projectId]
      );
      if (!currentExecution.rows[0])
        throw new WorkItemTransitionError("Review execution binding changed");
      if (
        current.status === "review" &&
        current.prProvider === input.provider &&
        current.prNumber === input.number &&
        current.prUrl === input.url
      )
        return current;
      if (
        currentExecution.rows[0].execution_generation !==
          input.executionGeneration ||
        !["starting", "running", "reconciling"].includes(
          currentExecution.rows[0].state
        ) ||
        current.status !== "doing" ||
        !current.dispatchKey ||
        current.prUrl ||
        !input.provider.trim() ||
        !Number.isSafeInteger(input.number) ||
        input.number < 1 ||
        !input.url.startsWith("https://")
      )
        throw new WorkItemTransitionError(
          "Review request is not bound to an active dispatch"
        );
      const changed = await client.query<Row>(
        `update project_work_items set status='review',pr_provider=$3,pr_number=$4,
           pr_url=$5,pr_state='open',version=version+1,updated_at=now()
         where id=$1 and owner_user_id=$2 returning *`,
        [current.id, input.ownerUserId, input.provider, input.number, input.url]
      );
      const updated = publicRecord(changed.rows[0]!);
      await appendProjectActivityWithClient(client, {
        ownerUserId: input.ownerUserId,
        projectId: updated.projectId,
        actorUserId: input.ownerUserId,
        kind: "work_item_status",
        ref: `${updated.id}:${updated.version}`
      });
      await appendProjectActivityWithClient(client, {
        ownerUserId: input.ownerUserId,
        projectId: updated.projectId,
        actorUserId: input.ownerUserId,
        kind: "pr_opened",
        ref: `${updated.id}:${updated.version}`
      });
      await emitChanged(client, input.ownerUserId, updated.id);
      return updated;
    });
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
      await appendProjectActivityWithClient(client, {
        ownerUserId,
        projectId,
        actorUserId: ownerUserId,
        kind: "work_item_created",
        ref: item.id
      });
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
         and p.lifecycle='active' and p.deletion_phase is null and p.team_backend_id is null and p.team_workspace_id is null
         and p.workspace_project_id is null and wi.deleted_at is null for update of wi`,
        [itemId, ownerUserId]
      );
      if (!found.rows[0])
        throw new WorkItemUnavailableError("Work Item is unavailable");
      const current = publicRecord(found.rows[0]);
      if (current.version !== input.version)
        throw new WorkItemConflictError("Version conflict", current);
      if (
        (input.action === "untick" || input.action === "back_to_todo") &&
        current.executionId
      ) {
        const prior = await client.query<{ state: string }>(
          `select state from managed_conversation_executions
           where id=$1 and owner_user_id=$2 for update`,
          [current.executionId, ownerUserId]
        );
        if (
          !prior.rows[0] ||
          !["stopped", "failed", "fenced"].includes(prior.rows[0].state)
        )
          throw new WorkItemTransitionError(
            "Stop and reconcile the Agent execution before moving this Work Item to To do"
          );
      }
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
         assignee_agent_id=case when $7 in ('untick','back_to_todo') then null else assignee_agent_id end,
         execution_id=case when $7 in ('untick','back_to_todo') then null else execution_id end,
         dispatch_key=case when $7 in ('untick','back_to_todo') then null else dispatch_key end,
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
      if (item.status !== current.status)
        await appendProjectActivityWithClient(client, {
          ownerUserId,
          projectId: item.projectId,
          actorUserId: ownerUserId,
          kind: item.status === "done" ? "work_item_done" : "work_item_status",
          ref: `${item.id}:${item.version}`
        });
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
      if (updated.status !== current.status)
        await appendProjectActivityWithClient(client, {
          ownerUserId,
          projectId: updated.projectId,
          actorUserId: ownerUserId,
          kind:
            updated.status === "done" ? "work_item_done" : "work_item_status",
          ref: `${updated.id}:${updated.version}`
        });
      if (event === "pr_opened" || event === "pr_merged")
        await appendProjectActivityWithClient(client, {
          ownerUserId,
          projectId: updated.projectId,
          actorUserId: ownerUserId,
          kind: event,
          ref: `${updated.id}:${updated.version}`
        });
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
         and p.lifecycle='active' and p.deletion_phase is null and p.team_backend_id is null and p.team_workspace_id is null
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
