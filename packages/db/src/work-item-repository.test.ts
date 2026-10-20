import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import {
  createWorkItemRepository,
  nextWorkItemStatus,
  WorkItemConflictError,
  WorkItemCursorError,
  WorkItemGoneError,
  WorkItemTransitionError,
  WorkItemUnavailableError,
  workItemDispatchKey,
  workItemPlanLineKey
} from "./work-item-repository.js";
import type { TrustedWorkItemEvidence } from "./work-item-repository.js";
import type { CreateWorkItem } from "@koed/shared";

const testUrl =
  process.env.KOED_WORK_ITEM_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe("Work Item state table", () => {
  const allowed = [
    ["todo", "dispatch", "doing"],
    ["blocked", "dispatch", "doing"],
    ["doing", "pr_opened", "review"],
    ["doing", "completed_without_pr", "done"],
    ["doing", "execution_failed", "blocked"],
    ["doing", "waiting_for_approval", "doing"],
    ["review", "pr_merged", "done"],
    ["review", "pr_closed_unmerged", "blocked"],
    ["done", "user_untick", "todo"],
    ["blocked", "user_back_to_todo", "todo"]
  ] as const;
  it.each(allowed)("%s + %s => %s", (before, event, after) => {
    expect(nextWorkItemStatus(before, event)).toBe(after);
  });
  it("allows explicit user completion from every state, including closed-unmerged blocked", () => {
    for (const state of ["todo", "doing", "review", "blocked", "done"] as const)
      expect(nextWorkItemStatus(state, "user_mark_done")).toBe("done");
    expect(
      nextWorkItemStatus(
        nextWorkItemStatus("review", "pr_closed_unmerged"),
        "user_mark_done"
      )
    ).toBe("done");
  });
  it("rejects unsupported automatic and user transitions", () => {
    expect(() => nextWorkItemStatus("review", "completed_without_pr")).toThrow(
      WorkItemTransitionError
    );
    expect(() => nextWorkItemStatus("review", "user_untick")).toThrow(
      WorkItemTransitionError
    );
    expect(() => nextWorkItemStatus("done", "dispatch")).toThrow(
      WorkItemTransitionError
    );
    expect(() => nextWorkItemStatus("todo", "pr_merged")).toThrow(
      WorkItemTransitionError
    );
    expect(() => nextWorkItemStatus("doing", "pr_closed_unmerged")).toThrow(
      WorkItemTransitionError
    );
  });
  it("derives durable dispatch and normalized plan line keys", () => {
    const id = randomUUID();
    expect(workItemDispatchKey(id, 2)).toBe(`${id}:2`);
    expect(workItemPlanLineKey(id, "  Buy  milk ")).toBe(
      workItemPlanLineKey(id, "buy milk")
    );
    expect(workItemPlanLineKey(randomUUID(), "buy milk")).not.toBe(
      workItemPlanLineKey(id, "buy milk")
    );
  });
});

describe.skipIf(!testUrl)("Work Item repository", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  let repository: ReturnType<typeof createWorkItemRepository>;
  let trusted: ReturnType<typeof createWorkItemRepository>;
  const owner = randomUUID();
  const other = randomUUID();
  let project: string;
  const body: CreateWorkItem = {
    kind: "todo",
    title: "Call Alex",
    goal: "Confirm schedule",
    origin: "manual",
    idempotencyKey: "call-alex",
    dueOn: "2026-10-22"
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq401_worker_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    repository = createWorkItemRepository(pool);
    await pool.query(`create table hq401_test_evidence (
      item_id uuid not null, owner_user_id uuid not null, version integer not null,
      event text not null, payload jsonb not null,
      primary key(item_id,owner_user_id,version,event))`);
    trusted = createWorkItemRepository(pool, {
      verifyTrustedTransition: async ({
        client,
        ownerUserId,
        current,
        event
      }) => {
        const result = await client.query<{ payload: TrustedWorkItemEvidence }>(
          `select payload from hq401_test_evidence where item_id=$1 and owner_user_id=$2
             and version=$3 and event=$4`,
          [current.id, ownerUserId, current.version, event]
        );
        return result.rows[0]?.payload ?? null;
      }
    });
    await pool.query(`insert into users(id,email) values ($1,$2),($3,$4)`, [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    const created = await pool.query<{ id: string }>(
      `insert into projects(owner_user_id,name,key) values ($1,'Work','WORK') returning id`,
      [owner]
    );
    project = created.rows[0]!.id;
  }, 120_000);
  afterAll(async () => {
    try {
      await pool?.end();
      if (admin && database) {
        let sessions = -1;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const active = await admin.query<{ count: number }>(
            `select count(*)::integer as count from pg_stat_activity
              where datname=$1 and pid<>pg_backend_pid()`,
            [database]
          );
          sessions = active.rows[0]!.count;
          if (sessions === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (sessions !== 0)
          throw new Error(
            `Work Item fixture has ${sessions} active session(s)`
          );
        await admin.query(`drop database if exists ${quote(database)}`);
      }
    } finally {
      await admin?.end();
    }
  });
  const evidence = async (
    itemId: string,
    version: number,
    payload: TrustedWorkItemEvidence
  ) => {
    await pool.query(
      `insert into hq401_test_evidence(item_id,owner_user_id,version,event,payload)
      values ($1,$2,$3,$4,$5) on conflict(item_id,owner_user_id,version,event)
      do update set payload=excluded.payload`,
      [itemId, owner, version, payload.event, JSON.stringify(payload)]
    );
  };
  it("creates, replays exact payload, rejects drift, scopes owners, and emits after commit", async () => {
    const item = await repository.create(owner, project, body);
    expect(item).toMatchObject({
      projectId: project,
      status: "todo",
      version: 1,
      dueOn: "2026-10-22"
    });
    expect(await repository.create(owner, project, body)).toEqual(item);
    await expect(
      repository.create(owner, project, { ...body, title: "Changed" })
    ).rejects.toBeInstanceOf(WorkItemConflictError);
    expect((await repository.list(owner, project)).items).toContainEqual(item);
    await expect(repository.list(other, project)).rejects.toBeInstanceOf(
      WorkItemUnavailableError
    );
    expect(await repository.getForRealtime(other, item.id)).toBeNull();
    const event = await pool.query<{
      family: string;
      resource_id: string;
      scope: string;
    }>(
      `select family,resource_id,scope from collaboration_outbox where resource_id=$1`,
      [item.id]
    );
    expect(event.rows).toEqual([
      expect.objectContaining({
        family: "work_item_changed",
        resource_id: item.id,
        scope: "personal"
      })
    ]);
  });
  it("serializes concurrent use of one idempotency key", async () => {
    const input = { ...body, idempotencyKey: "parallel" };
    const [first, second] = await Promise.all([
      repository.create(owner, project, input),
      repository.create(owner, project, input)
    ]);
    expect(first.id).toBe(second.id);
    const events = await pool.query<{ count: number }>(
      `select count(*)::integer as count from collaboration_outbox where resource_id=$1`,
      [first.id]
    );
    expect(events.rows[0]?.count).toBe(1);
  });
  it("walks small pages without gaps across equal and microsecond timestamps and scopes cursors", async () => {
    const created = await pool.query<{ id: string }>(
      `insert into projects(owner_user_id,name,key) values ($1,'Pages','PAGES') returning id`,
      [owner]
    );
    const pageProject = created.rows[0]!.id;
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const entry = await repository.create(owner, pageProject, {
        kind: "todo",
        title: `Page ${index}`,
        goal: "Page test",
        origin: "manual"
      });
      ids.push(entry.id);
    }
    for (let index = 0; index < ids.length; index += 1) {
      const fraction = index < 2 ? "123456" : index === 2 ? "123455" : "123454";
      await pool.query(
        `update project_work_items set created_at=$1::timestamptz where id=$2`,
        [`2026-10-20T12:34:56.${fraction}Z`, ids[index]]
      );
    }
    const expected = (
      await pool.query<{ id: string }>(
        `select id from project_work_items where project_id=$1 order by created_at desc,id desc`,
        [pageProject]
      )
    ).rows.map((row) => row.id);
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 4; index += 1) {
      const page = await repository.list(owner, pageProject, {
        limit: 1,
        cursor
      });
      expect(page.items).toHaveLength(1);
      walked.push(page.items[0]!.id);
      expect(page.hasMore).toBe(index < 3);
      expect(page.nextCursor === null).toBe(index === 3);
      if (index === 0) {
        await expect(
          repository.list(owner, project, {
            limit: 1,
            cursor: page.nextCursor!
          })
        ).rejects.toBeInstanceOf(WorkItemCursorError);
        await expect(
          repository.list(other, pageProject, {
            limit: 1,
            cursor: page.nextCursor!
          })
        ).rejects.toBeInstanceOf(WorkItemUnavailableError);
        await expect(
          repository.list(owner, pageProject, { limit: 1, cursor: "invalid!" })
        ).rejects.toBeInstanceOf(WorkItemCursorError);
      }
      cursor = page.nextCursor ?? undefined;
    }
    expect(walked).toEqual(expected);
  });
  it("compares versions, enforces manual transition and ticket deletion rule", async () => {
    const item = (await repository.list(owner, project)).items.find(
      (entry) => entry.idempotencyKey === body.idempotencyKey
    )!;
    const done = await repository.patch(owner, item.id, {
      version: item.version,
      action: "mark_done"
    });
    expect(done).toMatchObject({
      status: "done",
      version: item.version + 1,
      doneBy: owner
    });
    const replay = await repository.create(owner, project, body);
    expect(replay).toEqual(done);
    await expect(
      repository.patch(owner, item.id, {
        version: item.version,
        title: "stale"
      })
    ).rejects.toMatchObject({ current: done });
    const todo = await repository.patch(owner, item.id, {
      version: done.version,
      action: "untick"
    });
    expect(todo).toMatchObject({ status: "todo", doneAt: null, doneBy: null });
    await expect(
      repository.patch(owner, item.id, {
        version: todo.version,
        action: "back_to_todo"
      })
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    const ticket = await repository.create(owner, project, {
      kind: "ticket",
      key: "KOED-1",
      title: "Ship",
      goal: "Ship it",
      origin: "manual"
    });
    await expect(
      repository.deleteTodo(owner, ticket.id)
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    await repository.deleteTodo(owner, item.id);
    expect(await repository.getForRealtime(owner, item.id)).toBeNull();
    expect(
      (await repository.list(owner, project)).items.some(
        (entry) => entry.id === item.id
      )
    ).toBe(false);
    await expect(
      repository.create(owner, project, body)
    ).rejects.toBeInstanceOf(WorkItemGoneError);
    await expect(
      repository.create(owner, project, {
        ...body,
        title: "Drift after deletion"
      })
    ).rejects.toMatchObject({ current: null });
    await expect(repository.deleteTodo(owner, item.id)).rejects.toBeInstanceOf(
      WorkItemUnavailableError
    );
    await expect(
      repository.patch(owner, item.id, {
        version: todo.version,
        title: "Resurrect"
      })
    ).rejects.toBeInstanceOf(WorkItemUnavailableError);
    await expect(
      trusted.transitionTrusted(owner, item.id, todo.version, "dispatch")
    ).rejects.toBeInstanceOf(WorkItemUnavailableError);
    const deleted = await pool.query<{ deleted_at: Date | null }>(
      `select deleted_at from project_work_items where id=$1`,
      [item.id]
    );
    expect(deleted.rows[0]?.deleted_at).toBeInstanceOf(Date);
    const afterDeletionEvents = await pool.query<{ count: number }>(
      `select count(*)::integer as count from collaboration_outbox where resource_id=$1`,
      [item.id]
    );
    expect(afterDeletionEvents.rows[0]?.count).toBe(4);
  });
  it("fails closed when the authoritative Project is inactive or Team-linked", async () => {
    await pool.query(
      `update projects set lifecycle='deleted',deleted_at=now() where id=$1`,
      [project]
    );
    await expect(repository.list(owner, project)).rejects.toBeInstanceOf(
      WorkItemUnavailableError
    );
    const existing = await pool.query<{ id: string }>(
      `select id from project_work_items where project_id=$1 limit 1`,
      [project]
    );
    expect(
      await repository.getForRealtime(owner, existing.rows[0]!.id)
    ).toBeNull();
    await pool.query(
      `update projects set lifecycle='active',deleted_at=null,team_backend_id='team-backend' where id=$1`,
      [project]
    );
    await expect(
      repository.create(owner, project, { ...body, idempotencyKey: "new" })
    ).rejects.toBeInstanceOf(WorkItemUnavailableError);
    await pool.query(`update projects set team_backend_id=null where id=$1`, [
      project
    ]);
  });
  it("persists trusted PR closure as blocked, never done, with owner/version/binding guards", async () => {
    const initial = await repository.create(owner, project, {
      kind: "ticket",
      key: "T-2",
      title: "Review",
      goal: "Review it",
      origin: "manual"
    });
    const executionId = randomUUID(),
      agentId = randomUUID(),
      provider = "github";
    await expect(
      repository.transitionTrusted(
        owner,
        initial.id,
        initial.version,
        "dispatch"
      )
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    await evidence(initial.id, initial.version, {
      event: "dispatch",
      executionId,
      assigneeAgentId: agentId
    });
    await expect(
      trusted.transitionTrusted(other, initial.id, initial.version, "dispatch")
    ).rejects.toBeInstanceOf(WorkItemUnavailableError);
    const doing = await trusted.transitionTrusted(
      owner,
      initial.id,
      initial.version,
      "dispatch"
    );
    expect(doing).toMatchObject({
      status: "doing",
      executionId,
      assigneeAgentId: agentId,
      dispatchKey: workItemDispatchKey(initial.id, initial.version),
      version: initial.version + 1
    });
    await expect(
      trusted.transitionTrusted(owner, initial.id, initial.version, "pr_opened")
    ).rejects.toBeInstanceOf(WorkItemConflictError);
    await evidence(initial.id, doing.version, {
      event: "pr_opened",
      executionId: randomUUID(),
      prProvider: provider,
      prNumber: 212,
      prUrl: "https://example.test/pr/212"
    });
    await expect(
      trusted.transitionTrusted(owner, initial.id, doing.version, "pr_opened")
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    await evidence(initial.id, doing.version, {
      event: "pr_opened",
      executionId,
      prProvider: provider,
      prNumber: 212,
      prUrl: "https://example.test/pr/212"
    });
    const review = await trusted.transitionTrusted(
      owner,
      initial.id,
      doing.version,
      "pr_opened"
    );
    expect(review).toMatchObject({
      status: "review",
      prProvider: provider,
      prNumber: 212,
      prState: "open"
    });
    await evidence(initial.id, review.version, {
      event: "pr_closed_unmerged",
      executionId,
      prProvider: provider,
      prNumber: 213,
      prUrl: "https://example.test/pr/213"
    });
    await expect(
      trusted.transitionTrusted(
        owner,
        initial.id,
        review.version,
        "pr_closed_unmerged"
      )
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    await evidence(initial.id, review.version, {
      event: "pr_closed_unmerged",
      executionId,
      prProvider: provider,
      prNumber: 212,
      prUrl: "https://another-repo.test/pr/212"
    });
    await expect(
      trusted.transitionTrusted(
        owner,
        initial.id,
        review.version,
        "pr_closed_unmerged"
      )
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    expect(await repository.getForRealtime(owner, initial.id)).toMatchObject({
      status: "review",
      version: review.version,
      prState: "open"
    });
    const beforeValidClosure = await pool.query<{ count: number }>(
      `select count(*)::integer as count from collaboration_outbox where resource_id=$1`,
      [initial.id]
    );
    expect(beforeValidClosure.rows[0]?.count).toBe(3);
    await evidence(initial.id, review.version, {
      event: "pr_closed_unmerged",
      executionId,
      prProvider: provider,
      prNumber: 212,
      prUrl: "https://example.test/pr/212"
    });
    const blocked = await trusted.transitionTrusted(
      owner,
      initial.id,
      review.version,
      "pr_closed_unmerged"
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      prState: "closed",
      doneAt: null,
      doneBy: null,
      blockedReason: "PR #212 was closed without merging"
    });
    const manuallyDone = await repository.patch(owner, blocked.id, {
      version: blocked.version,
      action: "mark_done"
    });
    expect(manuallyDone).toMatchObject({ status: "done", doneBy: owner });
    const outbox = await pool.query<{ count: number }>(
      `select count(*)::integer as count from collaboration_outbox where resource_id=$1`,
      [initial.id]
    );
    expect(outbox.rows[0]?.count).toBe(5);
  });
  it("persists no-PR completion, failure, approval wait and merged PR only with bound evidence", async () => {
    const a = await repository.create(owner, project, {
      kind: "todo",
      title: "Solo",
      goal: "Finish solo",
      origin: "manual"
    });
    const executionId = randomUUID(),
      assigneeAgentId = randomUUID();
    await evidence(a.id, a.version, {
      event: "dispatch",
      executionId,
      assigneeAgentId
    });
    const doing = await trusted.transitionTrusted(
      owner,
      a.id,
      a.version,
      "dispatch"
    );
    await evidence(a.id, doing.version, {
      event: "waiting_for_approval",
      executionId
    });
    const waiting = await trusted.transitionTrusted(
      owner,
      a.id,
      doing.version,
      "waiting_for_approval"
    );
    expect(waiting.status).toBe("doing");
    await evidence(a.id, waiting.version, {
      event: "execution_failed",
      executionId,
      reason: "Execution stopped"
    });
    const blocked = await trusted.transitionTrusted(
      owner,
      a.id,
      waiting.version,
      "execution_failed"
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      blockedReason: "Execution stopped"
    });
    await evidence(a.id, blocked.version, {
      event: "dispatch",
      executionId,
      assigneeAgentId
    });
    const retried = await trusted.transitionTrusted(
      owner,
      a.id,
      blocked.version,
      "dispatch"
    );
    expect(retried).toMatchObject({ status: "doing", blockedReason: null });
    await evidence(a.id, retried.version, {
      event: "completed_without_pr",
      executionId
    });
    const done = await trusted.transitionTrusted(
      owner,
      a.id,
      retried.version,
      "completed_without_pr"
    );
    expect(done).toMatchObject({ status: "done", doneBy: null });
    expect(done.doneAt).not.toBeNull();
    const editedDone = await repository.patch(owner, done.id, {
      version: done.version,
      title: "Solo completion edited"
    });
    expect(editedDone).toMatchObject({
      status: "done",
      doneBy: null,
      doneAt: done.doneAt
    });

    const b = await repository.create(owner, project, {
      kind: "ticket",
      key: "T-3",
      title: "Merge",
      goal: "Merge it",
      origin: "manual"
    });
    await evidence(b.id, b.version, {
      event: "dispatch",
      executionId,
      assigneeAgentId
    });
    const running = await trusted.transitionTrusted(
      owner,
      b.id,
      b.version,
      "dispatch"
    );
    await evidence(b.id, running.version, {
      event: "pr_opened",
      executionId,
      prProvider: "github",
      prNumber: 99,
      prUrl: "https://example.test/pr/99"
    });
    const review = await trusted.transitionTrusted(
      owner,
      b.id,
      running.version,
      "pr_opened"
    );
    await evidence(b.id, review.version, {
      event: "pr_merged",
      executionId,
      prProvider: "github",
      prNumber: 99,
      prUrl: "https://example.test/pr/99"
    });
    const merged = await trusted.transitionTrusted(
      owner,
      b.id,
      review.version,
      "pr_merged"
    );
    expect(merged).toMatchObject({
      status: "done",
      prState: "merged",
      doneBy: null
    });
    expect(merged.doneAt).not.toBeNull();
  });
  it("never completes without a PR when one is linked, even in doing state", async () => {
    const item = await repository.create(owner, project, {
      kind: "todo",
      title: "Linked",
      goal: "Check binding",
      origin: "manual"
    });
    const executionId = randomUUID(),
      assigneeAgentId = randomUUID();
    await evidence(item.id, item.version, {
      event: "dispatch",
      executionId,
      assigneeAgentId
    });
    const doing = await trusted.transitionTrusted(
      owner,
      item.id,
      item.version,
      "dispatch"
    );
    await pool.query(
      `update project_work_items set pr_provider='github',pr_number=77,
      pr_url='https://example.test/pr/77',pr_state='open' where id=$1`,
      [item.id]
    );
    await evidence(item.id, doing.version, {
      event: "completed_without_pr",
      executionId
    });
    await expect(
      trusted.transitionTrusted(
        owner,
        item.id,
        doing.version,
        "completed_without_pr"
      )
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
  });
});
