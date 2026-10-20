import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createAgentsRepository } from "./agents-repository.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { createProjectApiRepository } from "./project-api-repository.js";

const testUrl =
  process.env.KOED_HQ503_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)(
  "private Helper delegation against real Project HQ state",
  () => {
    let admin: pg.Pool;
    let pool: pg.Pool;
    let database: string;
    const owner = randomUUID();
    const foreign = randomUUID();
    const deployment = randomUUID();
    const device = randomUUID();

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: testUrl });
      database = `hq503_worker_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`create database ${quote(database)}`);
      const url = new URL(testUrl!);
      url.pathname = `/${database}`;
      pool = new pg.Pool({ connectionString: url.toString() });
      await runDbMigrations(pool);
      await pool.query("insert into users(id,email) values ($1,$2),($3,$4)", [
        owner,
        `${owner}@example.test`,
        foreign,
        `${foreign}@example.test`
      ]);
      await pool.query(
        `insert into ai_client_instances(owner_user_id,instance_id,driver_id,display_name,enabled)
       values ($1,'codex.helper','codex','Codex',true)`,
        [owner]
      );
    }, 120_000);
    afterAll(async () => {
      await pool?.end();
      if (admin && database)
        await admin.query(`drop database ${quote(database)}`);
      await admin?.end();
    });

    it("creates one cold Helper child, replays it after Chief initialization, and fences changed requests", async () => {
      const projects = createProjectApiRepository(pool);
      const agents = createAgentsRepository(pool);
      const managed = createManagedConversationRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      });
      const project = await projects.create(owner, {
        name: "Private project",
        folderPath: null,
        idempotencyKey: "hq503-cold"
      });
      await projects.reserveHqConversation(owner, project.id);
      const chief = await agents.ensureChief(owner, "codex.helper");
      const helper = await agents.create(owner, {
        name: "Quinn",
        role: "Builder",
        look: chief.look,
        aiClientInstanceId: "codex.helper",
        defaultModel: "gpt-test",
        defaultPermissionMode: "supervised"
      });
      expect(chief.id).not.toBe(helper.id);
      const requestId = `agent-delegation:${randomUUID()}`;
      const cold = {
        projectId: project.id,
        contextKind: "project" as const,
        provider: "codex",
        aiClientInstanceId: "codex.helper",
        model: "gpt-test",
        permissionMode: "supervised" as const,
        runnerKind: "local_device" as const,
        runnerDeploymentId: deployment,
        runnerDeviceId: device,
        idempotencyKey: requestId,
        initialPrompt: "Fix lint errors",
        deferUntilRuntimeBinding: true,
        agentDelegation: {
          parentExecutionId: null,
          parentExecutionGeneration: null,
          agentId: helper.id,
          requestId
        }
      };
      await expect(
        managed.createManagedConversation({ userId: foreign }, cold)
      ).rejects.toThrow();
      const first = await managed.createManagedConversation(
        { userId: owner },
        cold
      );
      const hqBefore = await projects.readHqConversation(owner, project.id);
      expect(hqBefore.conversation?.executionId).toBeNull();
      const mapped = await managed.getManagedAgentDelegationByRequest(
        { userId: owner },
        requestId
      );
      expect(mapped).toMatchObject({
        childExecutionId: first.execution.id,
        parentExecutionId: null,
        parentExecutionGeneration: null,
        projectId: project.id
      });
      const chiefLaunch = await managed.createManagedConversation(
        { userId: owner },
        {
          projectId: project.id,
          hqProjectId: project.id,
          hqPrivatePath: `/private/project-hq/${owner}/${project.id}`,
          contextKind: "independent",
          provider: "codex",
          aiClientInstanceId: "codex.helper",
          model: "gpt-test",
          permissionMode: "supervised",
          runnerKind: "local_device",
          runnerDeploymentId: deployment,
          runnerDeviceId: device,
          idempotencyKey: `project-hq:${project.id}`,
          initialPrompt: "Hello Chief",
          deferUntilRuntimeBinding: true
        }
      );
      await expect(
        pool.query(
          `update managed_agent_delegations set cold_hq_project_id=null
         where owner_user_id=$1 and request_id=$2`,
          [owner, requestId]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `update managed_agent_delegations set parent_execution_id=$3,
         parent_execution_generation=null,cold_hq_project_id=null
         where owner_user_id=$1 and request_id=$2`,
          [owner, requestId, chiefLaunch.execution.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
      const replay = await managed.createManagedConversation(
        { userId: owner },
        cold
      );
      expect(replay.execution.id).toBe(first.execution.id);
      expect(chiefLaunch.execution.id).not.toBe(first.execution.id);
      await expect(
        managed.createManagedConversation(
          { userId: owner },
          {
            ...cold,
            initialPrompt: "Different task"
          }
        )
      ).rejects.toThrow("changed");
      const laterRequestId = `agent-delegation:${randomUUID()}`;
      await expect(
        managed.createManagedConversation(
          { userId: owner },
          {
            ...cold,
            idempotencyKey: laterRequestId,
            agentDelegation: {
              ...cold.agentDelegation,
              requestId: laterRequestId
            }
          }
        )
      ).rejects.toThrow("started");
      const visible = await managed.listManagedAgentDelegations(
        { userId: owner },
        project.id
      );
      expect(visible).toHaveLength(1);
      expect(visible[0]).toMatchObject({
        parentExecutionId: null,
        childExecutionId: first.execution.id,
        agentId: helper.id
      });
      expect(
        await managed.listManagedAgentDelegations(
          { userId: foreign },
          project.id
        )
      ).toEqual([]);
    }, 120_000);

    it("serializes cold delegation against Chief's first start and rejects inactive or foreign Projects", async () => {
      const projects = createProjectApiRepository(pool);
      const managed = createManagedConversationRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      });
      const project = await projects.create(owner, {
        name: "Race project",
        folderPath: null,
        idempotencyKey: "hq503-race"
      });
      await projects.reserveHqConversation(owner, project.id);
      const agents = createAgentsRepository(pool);
      const chief = await agents.ensureChief(owner, "codex.helper");
      const helper = await agents.create(owner, {
        name: "Sage",
        role: null,
        look: chief.look,
        aiClientInstanceId: "codex.helper",
        defaultModel: "gpt-test",
        defaultPermissionMode: "supervised"
      });
      const requestId = `agent-delegation:${randomUUID()}`;
      const cold = {
        projectId: project.id,
        contextKind: "project" as const,
        provider: "codex",
        aiClientInstanceId: "codex.helper",
        model: "gpt-test",
        permissionMode: "supervised" as const,
        runnerKind: "local_device" as const,
        runnerDeploymentId: deployment,
        runnerDeviceId: device,
        idempotencyKey: requestId,
        initialPrompt: "Review the tests",
        deferUntilRuntimeBinding: true,
        agentDelegation: {
          parentExecutionId: null,
          parentExecutionGeneration: null,
          agentId: helper.id,
          requestId
        }
      };
      const chiefStart = {
        projectId: project.id,
        hqProjectId: project.id,
        hqPrivatePath: `/private/project-hq/${owner}/${project.id}`,
        contextKind: "independent" as const,
        provider: "codex",
        aiClientInstanceId: "codex.helper",
        model: "gpt-test",
        permissionMode: "supervised" as const,
        runnerKind: "local_device" as const,
        runnerDeploymentId: deployment,
        runnerDeviceId: device,
        idempotencyKey: `project-hq:${project.id}`,
        initialPrompt: "Hello Chief",
        deferUntilRuntimeBinding: true
      };
      const [child, chiefResult] = await Promise.allSettled([
        managed.createManagedConversation({ userId: owner }, cold),
        managed.createManagedConversation({ userId: owner }, chiefStart)
      ]);
      expect(chiefResult.status).toBe("fulfilled");
      if (child.status === "rejected")
        expect(String(child.reason)).toContain("started");
      else
        expect(
          (
            await managed.getManagedAgentDelegationByRequest(
              { userId: owner },
              requestId
            )
          )?.childExecutionId
        ).toBe(child.value.execution.id);
      const count = await pool.query<{ count: number }>(
        `select count(*)::integer as count from managed_agent_delegations
        where owner_user_id=$1 and project_id=$2`,
        [owner, project.id]
      );
      expect(count.rows[0]?.count).toBe(child.status === "fulfilled" ? 1 : 0);
      await expect(
        managed.createManagedConversation({ userId: foreign }, cold)
      ).rejects.toThrow();
      await pool.query(
        "update projects set deletion_phase='preparing',delete_batch_id=$2 where id=$1",
        [project.id, randomUUID()]
      );
      const afterDeleteRequestId = `agent-delegation:${randomUUID()}`;
      await expect(
        managed.createManagedConversation(
          { userId: owner },
          {
            ...cold,
            idempotencyKey: afterDeleteRequestId,
            agentDelegation: {
              ...cold.agentDelegation,
              requestId: afterDeleteRequestId
            }
          }
        )
      ).rejects.toThrow();
    }, 120_000);

    it("keeps a cold Helper turn private when its owned Project has a Team link", async () => {
      const projects = createProjectApiRepository(pool);
      const project = await projects.create(owner, {
        name: "Linked private HQ",
        folderPath: null,
        idempotencyKey: "hq503-linked"
      });
      await projects.reserveHqConversation(owner, project.id);
      await pool.query(
        `update projects set team_backend_id='team.fixture',team_workspace_id=$2,
         workspace_project_id=$3 where id=$1`,
        [project.id, randomUUID(), randomUUID()]
      );
      const agents = createAgentsRepository(pool);
      const chief = await agents.ensureChief(owner, "codex.helper");
      const helper = await agents.create(owner, {
        name: "Nova",
        role: null,
        look: chief.look,
        aiClientInstanceId: "codex.helper",
        defaultModel: "gpt-test",
        defaultPermissionMode: "supervised"
      });
      const managed = createManagedConversationRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      });
      const requestId = `agent-delegation:${randomUUID()}`;
      const beforeTeam = await pool.query<{ count: number }>(
        "select count(*)::integer as count from collaboration_threads where scope='team'"
      );
      const child = await managed.createManagedConversation(
        { userId: owner },
        {
          projectId: project.id,
          contextKind: "project",
          provider: "codex",
          aiClientInstanceId: "codex.helper",
          model: "gpt-test",
          permissionMode: "supervised",
          runnerKind: "local_device",
          runnerDeploymentId: deployment,
          runnerDeviceId: device,
          idempotencyKey: requestId,
          initialPrompt: "Summarize my private notes",
          deferUntilRuntimeBinding: true,
          agentDelegation: {
            parentExecutionId: null,
            parentExecutionGeneration: null,
            agentId: helper.id,
            requestId
          }
        }
      );
      expect(child.execution.projectId).toBe(project.id);
      expect(
        (await projects.readHqConversation(owner, project.id)).conversation
          ?.executionId
      ).toBeNull();
      const afterTeam = await pool.query<{ count: number }>(
        "select count(*)::integer as count from collaboration_threads where scope='team'"
      );
      expect(afterTeam.rows[0]?.count).toBe(beforeTeam.rows[0]?.count);
      const teamText = await pool.query<{ count: number }>(
        "select count(*)::integer as count from collaboration_messages where scope='team'"
      );
      expect(teamText.rows[0]?.count).toBe(0);
    }, 120_000);

    it("locks Project and captured Session before an active parent, then rejects a concurrent lifecycle fence", async () => {
      const projects = createProjectApiRepository(pool);
      const project = await projects.create(owner, {
        name: "Active private chat",
        folderPath: null,
        idempotencyKey: "hq503-active"
      });
      const agents = createAgentsRepository(pool);
      const chief = await agents.ensureChief(owner, "codex.helper");
      const helper = await agents.create(owner, {
        name: "Active Quinn",
        role: null,
        look: chief.look,
        aiClientInstanceId: "codex.helper",
        defaultModel: "gpt-test",
        defaultPermissionMode: "supervised"
      });
      const managed = createManagedConversationRepository(pool, {
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(
            randomBytes(32).toString("base64url")
          )
      });
      const parent = await managed.createManagedConversation(
        { userId: owner },
        {
          projectId: project.id,
          contextKind: "project",
          provider: "codex",
          aiClientInstanceId: "codex.helper",
          model: "gpt-test",
          permissionMode: "supervised",
          runnerKind: "local_device",
          runnerDeploymentId: deployment,
          runnerDeviceId: device,
          idempotencyKey: `hq503-parent:${randomUUID()}`,
          initialPrompt: "Chief first",
          deferUntilRuntimeBinding: true
        }
      );
      const logical = randomUUID();
      const session = randomUUID();
      await pool.query(
        `insert into sessions(id,owner_user_id,logical_session_id,external_session_id,
        visibility,capture_method,source_kind,source_runtime,source_adapter_version)
       values ($1,$2,$3,$4,'personal','api','codex','codex','codex-transcript-v1')`,
        [session, owner, logical, `hq503-${session}`]
      );
      await pool.query(
        `update managed_conversation_executions set state='running',logical_session_id=$2,
         provider_thread_id=$3 where id=$1`,
        [parent.execution.id, logical, `hq503-${session}`]
      );
      const requestId = `agent-delegation:${randomUUID()}`;
      const active = {
        projectId: project.id,
        contextKind: "project" as const,
        provider: "codex",
        aiClientInstanceId: "codex.helper",
        model: "gpt-test",
        permissionMode: "supervised" as const,
        runnerKind: "local_device" as const,
        runnerDeploymentId: deployment,
        runnerDeviceId: device,
        idempotencyKey: requestId,
        initialPrompt: "Active task",
        deferUntilRuntimeBinding: true,
        agentDelegation: {
          parentExecutionId: parent.execution.id,
          parentExecutionGeneration: parent.execution.executionGeneration,
          agentId: helper.id,
          requestId
        }
      };
      const child = await managed.createManagedConversation(
        { userId: owner },
        active
      );
      expect(
        (
          await managed.getManagedAgentDelegationByRequest(
            { userId: owner },
            requestId
          )
        )?.childExecutionId
      ).toBe(child.execution.id);
      const fence = await pool.connect();
      const fencedRequestId = `agent-delegation:${randomUUID()}`;
      try {
        await fence.query("begin");
        await fence.query(
          "update sessions set forget_batch_id=$2 where id=$1",
          [session, randomUUID()]
        );
        const pending = managed.createManagedConversation(
          { userId: owner },
          {
            ...active,
            idempotencyKey: fencedRequestId,
            agentDelegation: {
              ...active.agentDelegation,
              requestId: fencedRequestId
            }
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await fence.query("commit");
        await expect(pending).rejects.toThrow(
          "Parent private Conversation is unavailable"
        );
      } finally {
        await fence.query("rollback").catch(() => undefined);
        fence.release();
      }
    }, 120_000);
  }
);
