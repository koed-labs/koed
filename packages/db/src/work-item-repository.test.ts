import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
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
import { createAgentsRepository } from "./agents-repository.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { createMemorySourceRepository } from "./repository.js";

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
  let dispatchAgentId: string;
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
    await pool.query(
      `insert into ai_client_instances(owner_user_id,instance_id,driver_id,display_name,enabled)
       values($1,'codex.dispatch','codex','Dispatch',true)`,
      [owner]
    );
    dispatchAgentId = (
      await createAgentsRepository(pool).create(owner, {
        name: "Quinn",
        role: "Builder",
        look: {},
        aiClientInstanceId: "codex.dispatch",
        defaultPermissionMode: "supervised",
        defaultModel: null
      })
    ).id;
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
  it("atomically dispatches once under concurrent Send and rejects unleased completion", async () => {
    const item = await repository.create(owner, project, {
      ...body,
      title: "Ship dispatch",
      idempotencyKey: `dispatch-${randomUUID()}`
    });
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    const launch = {
      projectId: project,
      contextKind: "project" as const,
      provider: "codex",
      aiClientInstanceId: "codex.dispatch",
      model: "gpt-test",
      permissionMode: "supervised" as const,
      runnerKind: "local_device" as const,
      runnerDeploymentId: randomUUID(),
      runnerDeviceId: randomUUID(),
      idempotencyKey: `work-item:${item.id}:${item.version}`,
      initialPrompt: "Complete this work item",
      deferUntilRuntimeBinding: true,
      workItemDispatch: {
        itemId: item.id,
        agentId: dispatchAgentId,
        version: item.version
      }
    };
    const [a, b] = await Promise.all([
      managed.createManagedConversation({ userId: owner }, launch),
      managed.createManagedConversation({ userId: owner }, launch)
    ]);
    expect(a.execution.id).toBe(b.execution.id);
    const sent = await repository.getForRealtime(owner, item.id);
    expect(sent).toMatchObject({
      status: "doing",
      executionId: a.execution.id,
      dispatchKey: `${item.id}:${item.version}`,
      assigneeAgentId: dispatchAgentId
    });
    const count = await pool.query<{ count: number }>(
      `select count(*)::integer as count from managed_conversation_executions
       where owner_user_id=$1 and project_id=$2`,
      [owner, project]
    );
    expect(count.rows[0]?.count).toBe(1);
    await expect(
      managed.createManagedConversation({ userId: other }, launch)
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      repository.completeFromManagedCommandLease({
        ownerUserId: owner,
        itemId: item.id,
        expectedVersion: sent!.version,
        commandId: a.command.id,
        leaseToken: randomUUID()
      })
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    expect((await repository.getForRealtime(owner, item.id))?.status).toBe(
      "doing"
    );
    const lease = randomUUID();
    await pool.query(
      `update managed_conversation_commands set state='dispatching',lease_token=$2,
         lease_expires_at=now()+interval '1 minute',blocked_on_kind=null,blocked_on_id=null
       where id=$1`,
      [a.command.id, lease]
    );
    const facade = createMemorySourceRepository(pool);
    const completed = await facade.completeForManagedExecutionLease({
      ownerUserId: owner,
      executionId: a.execution.id,
      commandId: a.command.id,
      leaseToken: lease
    });
    expect(completed.status).toBe("done");
    await expect(
      repository.completeForManagedExecutionLease({
        ownerUserId: owner,
        executionId: a.execution.id,
        commandId: a.command.id,
        leaseToken: lease
      })
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    const reassigned = await repository.create(owner, project, {
      ...body,
      title: "Reassign after failure",
      idempotencyKey: `reassign-${randomUUID()}`
    });
    const first = await managed.createManagedConversation(
      { userId: owner },
      {
        ...launch,
        idempotencyKey: `work-item:${reassigned.id}:1`,
        workItemDispatch: {
          itemId: reassigned.id,
          agentId: dispatchAgentId,
          version: 1
        }
      }
    );
    await managed.upsertManagedConversationRuntimeBinding(
      { userId: owner },
      {
        executionId: first.execution.id,
        deploymentId: launch.runnerDeploymentId,
        deviceId: launch.runnerDeviceId,
        executionGeneration: first.execution.executionGeneration,
        projectPath: "/tmp/hq404-retry-fixture"
      }
    );
    const nextAgent = await createAgentsRepository(pool).create(owner, {
      name: "Rook",
      role: "Reviewer",
      look: {},
      aiClientInstanceId: "codex.dispatch",
      defaultPermissionMode: "supervised",
      defaultModel: null
    });
    await expect(
      managed.createManagedConversation(
        { userId: owner },
        {
          ...launch,
          idempotencyKey: `work-item:${reassigned.id}:2`,
          workItemDispatch: {
            itemId: reassigned.id,
            agentId: nextAgent.id,
            version: 2
          }
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await pool.query(
      `update managed_conversation_executions set state='failed' where id=$1`,
      [first.execution.id]
    );
    const blocked = (await repository.list(owner, project)).items.find(
      (row) => row.id === reassigned.id
    );
    expect(blocked?.status).toBe("blocked");
    await pool.query(
      `update ai_client_instances set enabled=false where owner_user_id=$1 and instance_id='codex.dispatch'`,
      [owner]
    );
    await expect(
      managed.retryWorkItemConversation(
        { userId: owner },
        {
          projectId: project,
          itemId: reassigned.id,
          agentId: dispatchAgentId,
          expectedVersion: blocked!.version
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await pool.query(
      `update ai_client_instances set enabled=true where owner_user_id=$1 and instance_id='codex.dispatch'`,
      [owner]
    );
    const retry = await managed.retryWorkItemConversation(
      { userId: owner },
      {
        projectId: project,
        itemId: reassigned.id,
        agentId: dispatchAgentId,
        expectedVersion: blocked!.version
      }
    );
    expect(retry.execution.id).toBe(first.execution.id);
    expect(retry.execution.executionGeneration).toBe(
      first.execution.executionGeneration + 1
    );
    expect(retry.command.commandKind).toBe("start");
    expect(
      (await repository.getForRealtime(owner, reassigned.id))?.status
    ).toBe("doing");
    const claimedRetry = await managed.claimManagedConversationCommands({
      ownerUserId: owner,
      runnerId: randomUUID(),
      deploymentId: launch.runnerDeploymentId,
      deviceId: launch.runnerDeviceId,
      limit: 8,
      leaseMs: 60_000
    });
    const resumed = claimedRetry.find(
      (command) => command.id === retry.command.id
    );
    expect(resumed).toMatchObject({
      commandKind: "start",
      executionGeneration: retry.execution.executionGeneration,
      execution: {
        id: first.execution.id,
        executionGeneration: retry.execution.executionGeneration
      }
    });
    expect(
      await managed.completeManagedConversationCommand({
        commandId: resumed!.id,
        leaseToken: resumed!.leaseToken!,
        result: { providerTurnId: "fake-provider-retry-turn" }
      })
    ).toBe(true);
    const staleLease = randomUUID();
    await pool.query(
      `update managed_conversation_commands set state='dispatching',lease_token=$2,
         lease_expires_at=now()+interval '1 minute',blocked_on_kind=null,blocked_on_id=null
       where id=$1`,
      [first.command.id, staleLease]
    );
    await expect(
      repository.completeForManagedExecutionLease({
        ownerUserId: owner,
        executionId: first.execution.id,
        commandId: first.command.id,
        leaseToken: staleLease
      })
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    await pool.query(
      `update managed_conversation_executions set state='failed' where id=$1`,
      [first.execution.id]
    );
    const reblocked = (await repository.list(owner, project)).items.find(
      (row) => row.id === reassigned.id
    );
    const second = await managed.createManagedConversation(
      { userId: owner },
      {
        ...launch,
        idempotencyKey: `work-item:${reassigned.id}:${reblocked!.version}`,
        workItemDispatch: {
          itemId: reassigned.id,
          agentId: nextAgent.id,
          version: reblocked!.version
        }
      }
    );
    expect(second.execution.id).not.toBe(first.execution.id);
    expect(
      (await repository.getForRealtime(owner, reassigned.id))?.assigneeAgentId
    ).toBe(nextAgent.id);
    await managed.upsertManagedConversationRuntimeBinding(
      { userId: owner },
      {
        executionId: second.execution.id,
        deploymentId: launch.runnerDeploymentId,
        deviceId: launch.runnerDeviceId,
        executionGeneration: second.execution.executionGeneration,
        projectPath: "/tmp/hq404-retry-fixture"
      }
    );
    const logicalSessionId = randomUUID();
    await pool.query(
      `update managed_conversation_executions set logical_session_id=$2,
         provider_thread_id='provider-thread-404',state='failed' where id=$1`,
      [second.execution.id, logicalSessionId]
    );
    const blockedWithSession = (
      await repository.list(owner, project)
    ).items.find((row) => row.id === reassigned.id);
    const continued = await managed.retryWorkItemConversation(
      { userId: owner },
      {
        projectId: project,
        itemId: reassigned.id,
        agentId: nextAgent.id,
        expectedVersion: blockedWithSession!.version
      }
    );
    expect(continued.execution.id).toBe(second.execution.id);
    expect(continued.execution.logicalSessionId).toBe(logicalSessionId);
    expect(continued.command.commandKind).toBe("prompt");
  });
  it("keeps a running Agent linked when a completed item is unticked or a blocked item returns to To do", async () => {
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    for (const nextAction of ["untick", "back_to_todo"] as const) {
      const item = await repository.create(owner, project, {
        ...body,
        title: `Keep running ${nextAction}`,
        idempotencyKey: `running-${nextAction}-${randomUUID()}`
      });
      const launch = {
        projectId: project,
        contextKind: "project" as const,
        provider: "codex",
        aiClientInstanceId: "codex.dispatch",
        model: "gpt-test",
        permissionMode: "supervised" as const,
        runnerKind: "local_device" as const,
        runnerDeploymentId: randomUUID(),
        runnerDeviceId: randomUUID(),
        idempotencyKey: `work-item:${item.id}:${item.version}`,
        initialPrompt: "Complete this work item",
        deferUntilRuntimeBinding: true,
        workItemDispatch: {
          itemId: item.id,
          agentId: dispatchAgentId,
          version: item.version
        }
      };
      const sent = await managed.createManagedConversation(
        { userId: owner },
        launch
      );
      const running = await repository.getForRealtime(owner, item.id);
      const moved =
        nextAction === "untick"
          ? await repository.patch(owner, item.id, {
              version: running!.version,
              action: "mark_done"
            })
          : (await pool.query(
              `update project_work_items set status='blocked', version=version+1 where id=$1 returning version`,
              [item.id]
            ),
            await repository.getForRealtime(owner, item.id))!;
      await expect(
        repository.patch(owner, item.id, {
          version: moved.version,
          action: nextAction
        })
      ).rejects.toBeInstanceOf(WorkItemTransitionError);
      const preserved = await repository.getForRealtime(owner, item.id);
      expect(preserved?.executionId).toBe(sent.execution.id);
      expect(preserved?.assigneeAgentId).toBe(dispatchAgentId);
      await expect(
        managed.createManagedConversation(
          { userId: owner },
          {
            ...launch,
            idempotencyKey: `work-item:${item.id}:${preserved!.version}`,
            workItemDispatch: {
              itemId: item.id,
              agentId: dispatchAgentId,
              version: preserved!.version
            }
          }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      await pool.query(
        `update managed_conversation_executions set state='failed' where id=$1`,
        [sent.execution.id]
      );
      const detached = await repository.patch(owner, item.id, {
        version: preserved!.version,
        action: nextAction
      });
      expect(detached.status).toBe("todo");
      expect(detached.executionId).toBeNull();
    }
  });
  it("links a verified review request to only the current dispatch and replays idempotently", async () => {
    const item = await repository.create(owner, project, {
      ...body,
      title: "Open review",
      idempotencyKey: `review-${randomUUID()}`
    });
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    const launch = await managed.createManagedConversation(
      { userId: owner },
      {
        projectId: project,
        contextKind: "project",
        provider: "codex",
        aiClientInstanceId: "codex.dispatch",
        model: "gpt-test",
        permissionMode: "supervised",
        runnerKind: "local_device",
        runnerDeploymentId: randomUUID(),
        runnerDeviceId: randomUUID(),
        idempotencyKey: `work-item:${item.id}:1`,
        initialPrompt: "Open a review",
        deferUntilRuntimeBinding: true,
        workItemDispatch: {
          itemId: item.id,
          agentId: dispatchAgentId,
          version: 1
        }
      }
    );
    const proof = {
      ownerUserId: owner,
      executionId: launch.execution.id,
      executionGeneration: launch.execution.executionGeneration,
      provider: "github.com",
      number: 42,
      url: "https://github.com/acme/repo/pull/42"
    };
    expect(await repository.hasActiveManagedWorkItem(proof)).toBe(true);
    await expect(
      repository.linkReviewRequestFromSourceControl({
        ...proof,
        executionGeneration: 9
      })
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    expect(
      await repository.linkReviewRequestFromSourceControl({
        ...proof,
        ownerUserId: other
      })
    ).toBeNull();
    const linked = await repository.linkReviewRequestFromSourceControl(proof);
    expect(linked).toMatchObject({
      status: "review",
      prProvider: "github.com",
      prNumber: 42,
      prUrl: proof.url,
      prState: "open"
    });
    expect(await repository.linkReviewRequestFromSourceControl(proof)).toEqual(
      linked
    );
    await expect(
      repository.linkReviewRequestFromSourceControl({ ...proof, number: 43 })
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    await expect(
      repository.completeForManagedExecutionLease({
        ownerUserId: owner,
        executionId: launch.execution.id,
        commandId: launch.command.id,
        leaseToken: randomUUID()
      })
    ).rejects.toBeInstanceOf(WorkItemTransitionError);
    expect(await repository.hasActiveManagedWorkItem(proof)).toBe(false);
  });
  it("ignores a provider review request from an ordinary technical Managed Conversation", async () => {
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    const regular = await managed.createManagedConversation(
      { userId: owner },
      {
        projectId: "technical/local-project",
        contextKind: "project",
        provider: "codex",
        aiClientInstanceId: "codex.dispatch",
        model: "gpt-test",
        permissionMode: "supervised",
        runnerKind: "local_device",
        runnerDeploymentId: randomUUID(),
        runnerDeviceId: randomUUID(),
        idempotencyKey: `ordinary-review-${randomUUID()}`,
        initialPrompt: "Open an ordinary PR",
        deferUntilRuntimeBinding: true
      }
    );
    expect(
      await repository.linkReviewRequestFromSourceControl({
        ownerUserId: owner,
        executionId: regular.execution.id,
        executionGeneration: regular.execution.executionGeneration,
        provider: "github.com",
        number: 11,
        url: "https://github.com/acme/repo/pull/11"
      })
    ).toBeNull();
  });
  it.each(["execution fence", "command revocation"])(
    "rejects completion when a concurrent %s wins the runtime lock",
    async (failure) => {
      const item = await repository.create(owner, project, {
        ...body,
        title: `Lease race ${failure}`,
        idempotencyKey: `lease-race-${randomUUID()}`
      });
      const managed = createManagedConversationRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      });
      const launch = await managed.createManagedConversation(
        { userId: owner },
        {
          projectId: project,
          contextKind: "project",
          provider: "codex",
          aiClientInstanceId: "codex.dispatch",
          model: "gpt-test",
          permissionMode: "supervised",
          runnerKind: "local_device",
          runnerDeploymentId: randomUUID(),
          runnerDeviceId: randomUUID(),
          idempotencyKey: `work-item:${item.id}:1`,
          initialPrompt: "Complete this",
          deferUntilRuntimeBinding: true,
          workItemDispatch: {
            itemId: item.id,
            agentId: dispatchAgentId,
            version: 1
          }
        }
      );
      const lease = randomUUID();
      await pool.query(
        `update managed_conversation_commands set state='dispatching',lease_token=$2,
           lease_expires_at=now()+interval '1 minute',blocked_on_kind=null,blocked_on_id=null
         where id=$1`,
        [launch.command.id, lease]
      );
      const lock = await pool.connect();
      try {
        await lock.query("begin");
        if (failure === "execution fence")
          await lock.query(
            `select 1 from managed_conversation_executions where id=$1 for update`,
            [launch.execution.id]
          );
        else
          await lock.query(
            `select 1 from managed_conversation_commands where id=$1 for update`,
            [launch.command.id]
          );
        const pending = createMemorySourceRepository(
          pool
        ).completeForManagedExecutionLease({
          ownerUserId: owner,
          executionId: launch.execution.id,
          commandId: launch.command.id,
          leaseToken: lease
        });
        const rejected = expect(pending).rejects.toBeInstanceOf(
          WorkItemTransitionError
        );
        if (failure === "execution fence")
          await lock.query(
            `update managed_conversation_executions set state='failed' where id=$1`,
            [launch.execution.id]
          );
        else
          await lock.query(
            `update managed_conversation_commands set state='failed',
            lease_token=null,lease_expires_at=null where id=$1`,
            [launch.command.id]
          );
        await lock.query("commit");
        await rejected;
        expect((await repository.getForRealtime(owner, item.id))?.status).toBe(
          "doing"
        );
      } finally {
        await lock.query("rollback").catch(() => undefined);
        lock.release();
      }
    }
  );
  it("rejects a Source removed after brief read but before dispatch commit", async () => {
    const source = await pool.query<{ id: string }>(
      `insert into project_sources(owner_user_id,project_id,kind,name,uri,status,added_by)
       values($1,$2,'repo','Koed repo','https://github.com/acme/repo','ready',$1) returning id`,
      [owner, project]
    );
    const sources = await repository.briefSources(owner, project);
    const selected = sources.find((row) => row.id === source.rows[0]!.id)!;
    const item = await repository.create(owner, project, {
      ...body,
      title: "Use removed Source",
      idempotencyKey: `source-race-${randomUUID()}`
    });
    await pool.query(
      `update project_sources set remove_batch_id=$2 where id=$1`,
      [selected.id, randomUUID()]
    );
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    await expect(
      managed.createManagedConversation(
        { userId: owner },
        {
          projectId: project,
          contextKind: "project",
          provider: "codex",
          aiClientInstanceId: "codex.dispatch",
          model: "gpt-test",
          permissionMode: "supervised",
          runnerKind: "local_device",
          runnerDeploymentId: randomUUID(),
          runnerDeviceId: randomUUID(),
          idempotencyKey: `work-item:${item.id}:1`,
          initialPrompt: `Use ${selected.name}`,
          deferUntilRuntimeBinding: true,
          workItemDispatch: {
            itemId: item.id,
            agentId: dispatchAgentId,
            version: 1,
            sources: [
              { id: selected.id, currentRevisionId: selected.currentRevisionId }
            ]
          }
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await repository.getForRealtime(owner, item.id))?.status).toBe(
      "todo"
    );
    const commands = await pool.query<{ count: number }>(
      `select count(*)::integer as count from managed_conversation_commands
       where idempotency_key=$1`,
      [`work-item:${item.id}:1`]
    );
    expect(commands.rows[0]?.count).toBe(0);
  });
  it("does not replay removed Source excerpts when a start failed before session creation", async () => {
    const source = await pool.query<{ id: string }>(
      `insert into project_sources(owner_user_id,project_id,kind,name,uri,status,added_by)
       values($1,$2,'repo','Retry repo','https://github.com/acme/retry','ready',$1) returning id`,
      [owner, project]
    );
    const selected = (await repository.briefSources(owner, project)).find(
      (row) => row.id === source.rows[0]!.id
    )!;
    const item = await repository.create(owner, project, {
      ...body,
      title: "Retry Source fence",
      idempotencyKey: `retry-source-${randomUUID()}`
    });
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    const deploymentId = randomUUID();
    const deviceId = randomUUID();
    const launched = await managed.createManagedConversation(
      { userId: owner },
      {
        projectId: project,
        contextKind: "project",
        provider: "codex",
        aiClientInstanceId: "codex.dispatch",
        model: "gpt-test",
        permissionMode: "supervised",
        runnerKind: "local_device",
        runnerDeploymentId: deploymentId,
        runnerDeviceId: deviceId,
        idempotencyKey: `work-item:${item.id}:1`,
        initialPrompt: `Use removed excerpt from ${selected.name}`,
        deferUntilRuntimeBinding: true,
        workItemDispatch: {
          itemId: item.id,
          agentId: dispatchAgentId,
          version: 1,
          sources: [
            { id: selected.id, currentRevisionId: selected.currentRevisionId }
          ]
        }
      }
    );
    await managed.upsertManagedConversationRuntimeBinding(
      { userId: owner },
      {
        executionId: launched.execution.id,
        deploymentId,
        deviceId,
        executionGeneration: launched.execution.executionGeneration,
        projectPath: "/tmp/hq404-retry-source-fixture"
      }
    );
    await pool.query(
      `update managed_conversation_executions set state='failed' where id=$1`,
      [launched.execution.id]
    );
    const blocked = (await repository.list(owner, project)).items.find(
      (row) => row.id === item.id
    )!;
    expect(blocked.status).toBe("blocked");
    await pool.query(
      `update project_sources set remove_batch_id=$2 where id=$1`,
      [selected.id, randomUUID()]
    );
    await expect(
      managed.retryWorkItemConversation(
        { userId: owner },
        {
          projectId: project,
          itemId: item.id,
          agentId: dispatchAgentId,
          expectedVersion: blocked.version
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    const after = await pool.query<{ execution_generation: number }>(
      `select execution_generation from managed_conversation_executions where id=$1`,
      [launched.execution.id]
    );
    expect(after.rows[0]?.execution_generation).toBe(1);
    const commands = await pool.query<{ count: number }>(
      `select count(*)::integer as count from managed_conversation_commands
       where execution_id=$1`,
      [launched.execution.id]
    );
    expect(commands.rows[0]?.count).toBe(1);
  });
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
