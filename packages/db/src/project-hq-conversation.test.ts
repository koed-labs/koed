import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createProjectApiRepository } from "./project-api-repository.js";
import { createProjectRepository } from "./project-repository.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { createMemorySourceRepository } from "./repository.js";
import { capturedSessionMayLeavePersonalBoundary } from "./project-hq-privacy.js";

const testUrl =
  process.env.KOED_HQ204_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("private Project HQ Conversation", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const owner = randomUUID();
  const other = randomUUID();
  const device = randomUUID();
  const deployment = randomUUID();

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq204_worker_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values ($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database ${quote(database)}`);
    await admin?.end();
  });

  it("replays the same selected document without changing its encrypted start command", async () => {
    const docOwner = randomUUID();
    await pool.query("insert into users(id,email) values ($1,$2)", [
      docOwner,
      `${docOwner}@example.test`
    ]);
    const projects = createProjectApiRepository(pool);
    const project = await projects.create(docOwner, {
      name: "Document action",
      folderPath: null,
      idempotencyKey: "hq406-selected-document"
    });
    await projects.reserveHqConversation(docOwner, project.id);
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    const selectedDocumentSourceId = randomUUID();
    const launch = {
      projectId: project.id,
      hqProjectId: project.id,
      hqPrivatePath: `/private/project-hq/${docOwner}/${project.id}`,
      contextKind: "independent" as const,
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "gpt-test",
      permissionMode: "supervised" as const,
      runnerKind: "local_device" as const,
      runnerDeploymentId: deployment,
      runnerDeviceId: device,
      idempotencyKey: `project-hq:${project.id}`,
      initialPrompt: "Turn Plan.md into to-dos",
      selectedDocumentSourceId,
      deferUntilRuntimeBinding: true
    };
    const first = await managed.createManagedConversation(
      { userId: docOwner },
      launch
    );
    const replay = await managed.createManagedConversation(
      { userId: docOwner },
      launch
    );
    expect(replay.execution.id).toBe(first.execution.id);
    expect(replay.command.payload).toMatchObject({
      prompt: "Turn Plan.md into to-dos",
      selectedDocumentSourceId
    });
    await expect(
      managed.createManagedConversation(
        { userId: docOwner },
        {
          ...launch,
          selectedDocumentSourceId: randomUUID()
        }
      )
    ).rejects.toThrow("another document");
  }, 120_000);

  it("reserves lazily, binds one validated managed execution, and excludes its capture", async () => {
    const projects = createProjectApiRepository(pool);
    const managed = createManagedConversationRepository(pool, {
      envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64url")
      )
    });
    const project = await projects.create(owner, {
      name: "Study notes",
      folderPath: null,
      idempotencyKey: "hq204-study"
    });
    const before = await pool.query(
      "select 1 from project_hq_conversations where project_id=$1",
      [project.id]
    );
    expect(before.rowCount).toBe(0);
    await expect(
      projects.reserveHqConversation(other, project.id)
    ).rejects.toThrow("Project not found");
    const [first, second] = await Promise.all([
      projects.reserveHqConversation(owner, project.id),
      projects.reserveHqConversation(owner, project.id)
    ]);
    expect(first).toEqual(second);
    expect(first.executionId).toBeNull();
    const privatePath = `/private/project-hq/${owner}/${project.id}`;
    const launch = {
      projectId: project.id,
      hqProjectId: project.id,
      hqPrivatePath: privatePath,
      contextKind: "independent" as const,
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "gpt-test",
      permissionMode: "supervised" as const,
      runnerKind: "local_device" as const,
      runnerDeploymentId: deployment,
      runnerDeviceId: device,
      idempotencyKey: `project-hq:${project.id}`,
      initialPrompt: "First exact user message  ",
      deferUntilRuntimeBinding: true
    };
    const [a, b] = await Promise.all([
      managed.createManagedConversation({ userId: owner }, launch),
      managed.createManagedConversation({ userId: owner }, launch)
    ]);
    expect(a.execution.id).toBe(b.execution.id);
    expect(a.command.payload?.prompt).toBe("First exact user message  ");
    await expect(
      managed.createManagedConversation(
        { userId: owner },
        {
          ...launch,
          initialPrompt: "Different concurrent first message"
        }
      )
    ).rejects.toThrow("already started with another first message");
    const bound = await projects.reserveHqConversation(owner, project.id);
    expect(bound.executionId).toBe(a.execution.id);
    const count = await pool.query<{ count: number }>(
      "select count(*)::integer as count from managed_conversation_executions where owner_user_id=$1 and project_id=$2",
      [owner, project.id]
    );
    expect(count.rows[0]?.count).toBe(1);

    await managed.upsertManagedConversationRuntimeBinding(
      { userId: owner },
      {
        executionId: a.execution.id,
        deploymentId: deployment,
        deviceId: device,
        executionGeneration: a.execution.executionGeneration,
        projectPath: privatePath
      }
    );

    const early = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,external_session_id,
        visibility,capture_method,source_kind,source_runtime,source_adapter_version,cwd)
       values ($1,$2,$3,$4,'personal','transcript','codex','codex','codex-transcript-v1',$5)`,
      [early, owner, randomUUID(), `early-${early}`, privatePath]
    );
    expect(
      await capturedSessionMayLeavePersonalBoundary(pool, owner, early)
    ).toBe(false);

    const sibling = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,external_session_id,
        visibility,capture_method,source_kind,source_runtime,source_adapter_version,cwd)
       values ($1,$2,$3,$4,'personal','transcript','codex','codex','codex-transcript-v1',$5)`,
      [sibling, owner, randomUUID(), `sibling-${sibling}`, "/ordinary/project"]
    );
    expect(
      await capturedSessionMayLeavePersonalBoundary(pool, owner, sibling)
    ).toBe(true);
    const deploymentIdentity = randomUUID();
    await pool.query(
      "insert into deployment_identities(id,protocol_deployment_id,locality,profile) values ($1,$2,'local','developer')",
      [deploymentIdentity, randomUUID()]
    );
    const bindProtocolAlias = async (localSessionId: string) => {
      const logicalMemoryId = randomUUID();
      const originSessionId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into logical_memories
          (id,owner_user_id,owner_principal_id,origin_deployment_identity_id,source_kind,logical_key)
         values ($1,$2,$2,$3,'captured_session',$4)`,
          [
            logicalMemoryId,
            owner,
            deploymentIdentity,
            `hq204-alias:${logicalMemoryId}`
          ]
        );
        await client.query(
          `insert into captured_session_logical_memories
          (logical_memory_id,source_session_id,owner_principal_id)
         values ($1,$2,$3)`,
          [logicalMemoryId, originSessionId, owner]
        );
        await client.query(
          `insert into local_captured_session_logical_memories
          (logical_memory_id,local_session_id,owner_user_id)
         values ($1,$2,$3)`,
          [logicalMemoryId, localSessionId, owner]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return originSessionId;
    };
    const ordinaryOriginId = await bindProtocolAlias(sibling);
    expect(
      await capturedSessionMayLeavePersonalBoundary(
        pool,
        owner,
        ordinaryOriginId
      )
    ).toBe(true);
    expect(
      await capturedSessionMayLeavePersonalBoundary(
        pool,
        other,
        ordinaryOriginId
      )
    ).toBe(false);
    const privateOriginId = await bindProtocolAlias(early);
    expect(
      await capturedSessionMayLeavePersonalBoundary(
        pool,
        owner,
        privateOriginId
      )
    ).toBe(false);

    const session = randomUUID();
    const logical = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,logical_session_id,external_session_id,
        visibility,capture_method,source_kind,source_runtime,source_adapter_version,metadata)
       values ($1,$2,$3,$4,'personal','api','codex','codex','codex-transcript-v1',$5::jsonb)`,
      [
        session,
        owner,
        logical,
        `hq204-${session}`,
        JSON.stringify({ managedConversation: true })
      ]
    );
    expect(
      await capturedSessionMayLeavePersonalBoundary(pool, owner, session)
    ).toBe(false);
    await pool.query("update sessions set cwd=$2 where id=$1", [
      session,
      privatePath
    ]);
    const artifact = await pool.query<{ id: string }>(
      `insert into conversation_source_artifacts
         (owner_user_id,session_id,logical_source_id,source_generation_id,
          replica_role,source_kind,source_runtime,external_session_id,
          source_fingerprint,artifact_format,artifact_format_version,
          source_adapter_version,source_created_at,storage_provider,storage_prefix,
          origin_deployment_id,origin_device_id,origin_key_id,origin_public_key,redacted_source_label)
       values ($1,$2,$3,$4,'origin_local','codex','codex',$5,
               $6,'jsonl',1,'codex-transcript-v1',now(),'filesystem','fixture',
               'deployment','device','key',$7,'fixture') returning id`,
      [
        owner,
        session,
        randomUUID(),
        randomUUID(),
        `hq204-${session}`,
        "a".repeat(64),
        "A".repeat(43)
      ]
    );
    const associated = await createProjectRepository(
      pool
    ).associateVerifiedCapturedSession({
      sourceKind: "codex",
      ownerUserId: owner,
      deviceId: device,
      localProjectId: `private-hq-${project.id}`,
      displayName: "Private HQ runtime",
      commonDirHash: null,
      gitDirHash: null,
      folderHash: randomUUID(),
      verifiedNewLinkedCheckout: false,
      hasRemoteCandidate: false,
      hasMovedCheckoutCandidate: false,
      sessionId: session,
      artifactId: artifact.rows[0]!.id,
      minimumProviderCursorOffset: 0,
      externalSessionId: `hq204-${session}`
    });
    expect(associated).toMatchObject({
      state: "resolved",
      projectId: project.id,
      sessionAssigned: true
    });
    const projectCount = await pool.query<{ count: number }>(
      "select count(*)::integer as count from projects where owner_user_id=$1",
      [owner]
    );
    expect(projectCount.rows[0]?.count).toBe(1);
    const firstMessageId = randomUUID();
    await pool.query(
      `insert into messages
        (id,session_id,owner_user_id,visibility,role,content,source_runtime,capture_method)
       values ($1,$2,$3,'personal','user','Actual captured HQ prompt','codex','api')`,
      [firstMessageId, session, owner]
    );
    await pool.query(
      `update managed_conversation_executions
          set state='stopped',logical_session_id=$2,provider_thread_id=$3 where id=$1`,
      [a.execution.id, logical, `hq204-${logical}`]
    );
    const reopened = await projects.readHqConversation(owner, project.id);
    expect(reopened.conversation?.executionId).toBe(a.execution.id);
    expect(reopened.execution).toMatchObject({
      state: "stopped",
      capturedSessionId: session,
      threadId: `hq204-${logical}`
    });
    expect(reopened.execution?.graphProjectId).toBe("unassigned");
    expect(reopened.execution?.graphThreadId).toBe(`hq204-${session}`);
    const timeline = await createMemorySourceRepository(
      pool
    ).listLcmGraphEvents(
      { userId: owner },
      {
        projectId: reopened.execution!.graphProjectId!,
        threadId: reopened.execution!.graphThreadId!,
        limit: 10
      }
    );
    expect(timeline.map((event) => event.id)).toContain(firstMessageId);
    await pool.query(
      "update managed_conversation_executions set state='running' where id=$1",
      [a.execution.id]
    );
    const deletePreview = await projects.deletePreview(owner, project.id);
    expect(deletePreview.activeExecutions.map((item) => item.id)).toContain(
      a.execution.id
    );
    const deleteBatch = randomUUID();
    await projects.beginDelete(owner, project.id, {
      version: deletePreview.project.version,
      batchId: deleteBatch,
      executionSetHash: deletePreview.executionSetHash
    });
    await expect(
      managed.enqueueManagedConversationPrompt(
        { userId: owner },
        {
          executionId: a.execution.id,
          executionGeneration: a.execution.executionGeneration,
          idempotencyKey: "hq-during-delete",
          clientUserMessageId: randomUUID(),
          prompt: "Must pause for Project deletion"
        }
      )
    ).rejects.toThrow("Project is unavailable for managed execution");
    await projects.cancelDelete(owner, project.id, deleteBatch);
    const finalPreview = await projects.deletePreview(owner, project.id);
    const finalBatch = randomUUID();
    await projects.beginDelete(owner, project.id, {
      version: finalPreview.project.version,
      batchId: finalBatch,
      executionSetHash: finalPreview.executionSetHash
    });
    const stopped = await pool.query<{ state_version: number }>(
      "update managed_conversation_executions set state='stopped',state_version=state_version+1 where id=$1 returning state_version",
      [a.execution.id]
    );
    await projects.recordRuntimeAck(owner, project.id, finalBatch, {
      executionId: a.execution.id,
      executionGeneration: a.execution.executionGeneration,
      state: "stopped",
      stateVersion: stopped.rows[0]!.state_version
    });
    await projects.markDeleteReady(owner, project.id, finalBatch);
    const deleted = await projects.completeDelete(
      owner,
      project.id,
      finalBatch
    );
    expect(deleted.lifecycle).toBe("deleted");
    const trashed = await pool.query<{ trashed_at: Date | null }>(
      "select trashed_at from sessions where id=$1",
      [session]
    );
    expect(trashed.rows[0]?.trashed_at).not.toBeNull();
    const restored = await projects.restore(owner, project.id, {
      version: deleted.version,
      batchId: finalBatch
    });
    expect(restored.lifecycle).toBe("active");
    const restoredSession = await pool.query<{ trashed_at: Date | null }>(
      "select trashed_at from sessions where id=$1",
      [session]
    );
    expect(restoredSession.rows[0]?.trashed_at).toBeNull();
    expect(
      (await projects.readHqConversation(owner, project.id)).execution
        ?.capturedSessionId
    ).toBe(session);
    await pool.query(
      "update managed_conversation_executions set state='running' where id=$1",
      [a.execution.id]
    );
    // Project hard purge detaches captured Sessions before removing the row.
    await pool.query(
      "update sessions set automatic_personal_project_id=null where id=$1",
      [session]
    );
    await pool.query(
      "delete from project_delete_operations where project_id=$1",
      [project.id]
    );
    await pool.query("delete from projects where id=$1 and owner_user_id=$2", [
      project.id,
      owner
    ]);
    const deletedHandle = await pool.query(
      "select 1 from project_hq_conversations where project_id=$1",
      [project.id]
    );
    expect(deletedHandle.rowCount).toBe(0);
    expect(
      await capturedSessionMayLeavePersonalBoundary(pool, owner, session)
    ).toBe(false);
    await expect(
      managed.enqueueManagedConversationPrompt(
        { userId: owner },
        {
          executionId: a.execution.id,
          executionGeneration: a.execution.executionGeneration,
          idempotencyKey: "hq-after-hard-purge",
          clientUserMessageId: randomUUID(),
          prompt: "Do not resume a deleted Project"
        }
      )
    ).rejects.toThrow("Project is unavailable for managed execution");
    await pool.query(
      "update managed_conversation_commands set state='queued',blocked_on_kind=null,blocked_on_id=null where id=$1",
      [a.command.id]
    );
    expect(
      await managed.claimManagedConversationCommands({
        ownerUserId: owner,
        runnerId: randomUUID(),
        deviceId: device,
        deploymentId: deployment,
        leaseMs: 30_000
      })
    ).toEqual([]);
    await pool.query(
      "update managed_conversation_executions set state='running', logical_session_id=$2, provider_thread_id=$3 where id=$1",
      [a.execution.id, logical, `hq204-${logical}`]
    );
    expect(
      await managed.acquireManagedConversationExecutionLease({
        executionId: a.execution.id,
        executionGeneration: a.execution.executionGeneration,
        deploymentId: deployment,
        deviceId: device,
        runnerId: randomUUID(),
        leaseMs: 30_000
      })
    ).toBe(false);
    await pool.query("update sessions set metadata='{}'::jsonb where id=$1", [
      session
    ]);
    await pool.query(
      "delete from managed_conversation_runtime_bindings where execution_id=$1",
      [a.execution.id]
    );
    expect(
      await capturedSessionMayLeavePersonalBoundary(pool, owner, session)
    ).toBe(false);
  }, 120_000);
});
