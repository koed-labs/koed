import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { createWorkItemRepository } from "./work-item-repository.js";
import { createPersonalWorkspaceProjectRepository } from "./personal-workspace-project-repository.js";

const testUrl = process.env.KOED_HQ712_SHARED_DISPATCH_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("private shared Work Item dispatch binding", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database = "";
  const owner = randomUUID();
  const other = randomUUID();
  const projectId = randomUUID();
  const teamPrincipal = randomUUID();
  const teamBackendId = "team-vps";
  const workspaceProjectId = randomUUID();
  const teamWorkItemId = randomUUID();
  const agentId = randomUUID();
  const deployment = randomUUID();
  const device = randomUUID();

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq712_private_dispatch_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const child = new URL(testUrl!);
    child.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: child.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    await pool.query(
      `insert into projects(id,owner_user_id,name,key,
      team_backend_id,team_workspace_id,workspace_project_id)
      values($1,$2,'Private work','PRIVATE',$3,$4,$5)`,
      [projectId, owner, teamBackendId, randomUUID(), workspaceProjectId]
    );
    await pool.query(
      `insert into personal_workspace_project_principal_bindings
      (local_user_id,team_backend_id,team_principal_user_id,
       local_credential_key_id,team_credential_key_id)
      values($1,$2,$3,'local-key','team-key')`,
      [owner, teamBackendId, teamPrincipal]
    );
    await pool.query(
      `insert into ai_client_instances
      (owner_user_id,instance_id,driver_id,display_name,enabled)
      values($1,'codex.shared','codex','Shared',true)`,
      [owner]
    );
    await pool.query(
      `insert into agents(id,owner_user_id,name,
      ai_client_instance_id,default_permission_mode)
      values($1,$2,'Quinn','codex.shared','supervised')`,
      [agentId, owner]
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database ${quote(database)}`);
    await admin?.end();
  });

  it("creates one private execution and rejects changed binding, owner, or Agent", async () => {
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    const workItems = createWorkItemRepository(pool);
    expect(await workItems.getSharedDispatchLink(owner, projectId)).toEqual({
      teamBackendId,
      workspaceProjectId,
      teamPrincipalUserId: teamPrincipal
    });
    expect(await workItems.getSharedDispatchLink(other, projectId)).toBeNull();
    const key = `shared-work-item:${workspaceProjectId}:${teamWorkItemId}:7`;
    const dispatch = {
      teamBackendId,
      teamPrincipalUserId: teamPrincipal,
      workspaceProjectId,
      teamWorkItemId,
      teamWorkItemVersion: 7,
      expectedProjectVersion: 9,
      expectedMemberVersion: 4,
      agentId
    };
    const launch = {
      projectId,
      contextKind: "project" as const,
      provider: "codex",
      aiClientInstanceId: "codex.shared",
      model: "gpt-test",
      permissionMode: "supervised" as const,
      runnerKind: "local_device" as const,
      runnerDeploymentId: deployment,
      runnerDeviceId: device,
      idempotencyKey: key,
      initialPrompt: "Private Team ticket goal",
      deferUntilRuntimeBinding: true,
      sharedWorkItemDispatch: dispatch
    };
    const first = await managed.createManagedConversation(
      { userId: owner },
      launch
    );
    const replay = await managed.createManagedConversation(
      { userId: owner },
      launch
    );
    expect(replay.execution.id).toBe(first.execution.id);
    expect(
      await managed.getSharedWorkItemDispatchForExecution(
        { userId: owner },
        first.execution.id
      )
    ).toEqual(dispatch);
    expect(
      await managed.getSharedWorkItemDispatchForExecution(
        { userId: other },
        first.execution.id
      )
    ).toBeNull();
    expect(
      await managed.listSharedWorkItemDispatches(
        { userId: owner },
        {
          personalProjectId: projectId,
          teamBackendId,
          workspaceProjectId
        }
      )
    ).toEqual([{ teamWorkItemId, executionId: first.execution.id, agentId }]);
    expect(
      await managed.listSharedWorkItemDispatches(
        { userId: other },
        {
          personalProjectId: projectId,
          teamBackendId,
          workspaceProjectId
        }
      )
    ).toEqual([]);
    expect(
      await managed.getSharedWorkItemDispatch(
        { userId: owner },
        {
          projectId,
          idempotencyKey: key
        }
      )
    ).toEqual({
      executionId: first.execution.id,
      agentId,
      teamBackendId,
      teamPrincipalUserId: teamPrincipal,
      workspaceProjectId,
      teamWorkItemId,
      teamWorkItemVersion: 7,
      expectedProjectVersion: 9,
      expectedMemberVersion: 4,
      textActionId: null
    });
    expect(
      await managed.getSharedWorkItemDispatch(
        { userId: other },
        {
          projectId,
          idempotencyKey: key
        }
      )
    ).toBeNull();
    const stored = await pool.query<{ encrypted_payload: string }>(
      `select encrypted_payload::text from managed_conversation_commands
       where owner_user_id=$1 and idempotency_key=$2`,
      [owner, key]
    );
    expect(stored.rows[0]!.encrypted_payload).not.toContain(
      "Private Team ticket goal"
    );
    expect(stored.rows[0]!.encrypted_payload).not.toContain(teamWorkItemId);
    await expect(
      managed.createManagedConversation(
        { userId: owner },
        {
          ...launch,
          sharedWorkItemDispatch: { ...dispatch, agentId: randomUUID() }
        }
      )
    ).rejects.toThrow("Agent is unavailable");
    await pool.query(
      `update personal_workspace_project_principal_bindings
      set team_principal_user_id=$3 where local_user_id=$1 and team_backend_id=$2`,
      [owner, teamBackendId, randomUUID()]
    );
    await expect(
      managed.createManagedConversation(
        { userId: owner },
        { ...launch, idempotencyKey: `${key}:new` }
      )
    ).rejects.toThrow("link changed");
    await pool.query(
      `update personal_workspace_project_principal_bindings
       set team_principal_user_id=$3 where local_user_id=$1 and team_backend_id=$2`,
      [owner, teamBackendId, teamPrincipal]
    );
  });

  it("atomically fences an old Team command while allowing an explicit private prompt after detach", async () => {
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    const key = `shared-work-item:${workspaceProjectId}:${randomUUID()}:1`;
    const itemId = key.split(":")[2]!;
    const created = await managed.createManagedConversation(
      { userId: owner },
      {
        projectId,
        contextKind: "project",
        provider: "codex",
        aiClientInstanceId: "codex.shared",
        model: "gpt-test",
        permissionMode: "supervised",
        runnerKind: "local_device",
        runnerDeploymentId: deployment,
        runnerDeviceId: device,
        idempotencyKey: key,
        initialPrompt: "A private brief",
        deferUntilRuntimeBinding: true,
        sharedWorkItemDispatch: {
          teamBackendId,
          teamPrincipalUserId: teamPrincipal,
          workspaceProjectId,
          teamWorkItemId: itemId,
          teamWorkItemVersion: 1,
          expectedProjectVersion: 1,
          expectedMemberVersion: 1,
          agentId
        }
      }
    );
    const sessionId = randomUUID();
    const oldLease = randomUUID();
    await pool.query(
      `update managed_conversation_executions set state='running',
       logical_session_id=$2,provider_thread_id='private-thread',
       runner_id='runner',runner_lease_expires_at=now()+interval '1 minute'
       where id=$1`,
      [created.execution.id, sessionId]
    );
    await pool.query(
      `update managed_conversation_commands set state='dispatching',
       blocked_on_kind=null,blocked_on_id=null,
       lease_token=$2,lease_expires_at=now()+interval '1 minute'
       where id=$1`,
      [created.command.id, oldLease]
    );
    const result = await createPersonalWorkspaceProjectRepository(
      pool
    ).reconcileInvalidation(owner, projectId, workspaceProjectId);
    expect(result.cleared).toBe(true);
    expect(
      await managed.getSharedWorkItemDispatchForExecution(
        { userId: owner },
        created.execution.id
      )
    ).toBeNull();
    expect(
      await managed.listSharedWorkItemDispatches(
        { userId: owner },
        {
          personalProjectId: projectId,
          teamBackendId,
          workspaceProjectId
        }
      )
    ).toEqual([]);
    expect(
      await managed.renewManagedConversationCommandLease({
        commandId: created.command.id,
        leaseToken: oldLease,
        runnerId: "runner",
        executionId: created.execution.id,
        leaseMs: 30_000
      })
    ).toBe(false);
    const execution = await managed.getManagedConversationExecution(
      { userId: owner },
      created.execution.id
    );
    expect(execution?.state).toBe("running");
    expect(execution?.executionGeneration).toBe(2);
    const prompt = await managed.enqueueManagedConversationPrompt(
      { userId: owner },
      {
        executionId: created.execution.id,
        executionGeneration: 2,
        idempotencyKey: `private-after-detach:${randomUUID()}`,
        clientUserMessageId: randomUUID(),
        prompt: "Continue privately"
      }
    );
    expect(prompt.state).toBe("queued");
    expect(prompt.executionGeneration).toBe(2);
  });
});
