import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapturedSessionRepository } from "./captured-session-repository.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { runDbMigrations } from "./migrate.js";
import { createProjectApiRepository } from "./project-api-repository.js";

const testUrl = process.env.KOED_HQ702_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("managed Project policy capture", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database = "";
  const owner = randomUUID();
  const deployment = randomUUID();
  const device = randomUUID();
  const credential = randomUUID();
  const workspaceProject = randomUUID();
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64url")
  );

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq702_managed_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query("insert into users(id,email) values($1,$2)", [
      owner,
      `${owner}@test.invalid`
    ]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(
        `drop database if exists ${quote(database)} with (force)`
      );
    await admin?.end();
  });

  const setup = async () => {
    const project = await createProjectApiRepository(pool, {
      envelopeEncryptionProvider: provider
    }).create(owner, {
      name: `Managed capture ${randomUUID()}`,
      folderPath: null,
      idempotencyKey: randomUUID()
    });
    await pool.query(
      `update projects set team_backend_id='managed-capture-fixture',
        workspace_project_id=$2,project_share_policy_version=1,
        project_share_policy_device_credential_id=$3,
        project_share_policy_enabled_at=now()-interval '1 minute'
       where id=$1`,
      [project.id, workspaceProject, credential]
    );
    return {
      project,
      managed: createManagedConversationRepository(pool, {
        envelopeEncryptionProvider: provider
      }),
      captured: createCapturedSessionRepository(pool)
    };
  };

  const snapshot = async (logicalSessionId: string) => {
    const result = await pool.query<{
      automatic_personal_project_id: string | null;
      project_share_capture_policy_version: number | null;
      project_share_capture_workspace_project_id: string | null;
      project_share_capture_device_credential_id: string | null;
      project_share_capture_link_epoch: string | null;
    }>(
      `select automatic_personal_project_id,project_share_capture_policy_version,
              project_share_capture_workspace_project_id,
              project_share_capture_device_credential_id,project_share_capture_link_epoch
         from sessions where owner_user_id=$1 and logical_session_id=$2`,
      [owner, logicalSessionId]
    );
    return result.rows[0]!;
  };

  const start = async (
    f: Awaited<ReturnType<typeof setup>>,
    options: { hq?: boolean; idempotencyKey?: string } = {}
  ) => {
    if (options.hq)
      await createProjectApiRepository(pool).reserveHqConversation(
        owner,
        f.project.id
      );
    return f.managed.createManagedConversation(
      { userId: owner },
      {
        projectId: f.project.id,
        ...(options.hq
          ? {
              hqProjectId: f.project.id,
              hqPrivatePath: `/private/project-hq/${owner}/${f.project.id}`
            }
          : {}),
        contextKind: "independent",
        provider: "codex",
        aiClientInstanceId: "codex.default",
        model: "test",
        permissionMode: "supervised",
        runnerKind: "local_device",
        runnerDeploymentId: deployment,
        runnerDeviceId: device,
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        deferUntilRuntimeBinding: true
      }
    );
  };

  const capture = async (
    f: Awaited<ReturnType<typeof setup>>,
    logicalSessionId: string
  ) =>
    f.captured.createCapturedSession(
      { userId: owner },
      {
        logicalSessionId,
        externalSessionId: `managed-${randomUUID()}`,
        sourceRuntime: "codex",
        sourceKind: "codex",
        sourceAdapterVersion: "codex-app-server-v1"
      }
    );

  const bind = async (
    f: Awaited<ReturnType<typeof setup>>,
    launched: Awaited<ReturnType<typeof start>>,
    logicalSessionId: string
  ) =>
    f.managed.bindManagedConversationRuntime(
      { userId: owner },
      {
        executionId: launched.execution.id,
        expectedStateVersion: launched.execution.stateVersion,
        executionGeneration: launched.execution.executionGeneration,
        runnerId: randomUUID(),
        logicalSessionId,
        providerThreadId: `thread-${logicalSessionId}`
      }
    );

  it.each(["capture-first", "runtime-first"] as const)(
    "stamps an ordinary managed Session with %s ordering",
    async (order) => {
      const f = await setup();
      const launched = await start(f);
      const logicalSessionId = randomUUID();
      if (order === "capture-first") {
        await capture(f, logicalSessionId);
        await bind(f, launched, logicalSessionId);
      } else {
        await bind(f, launched, logicalSessionId);
        await capture(f, logicalSessionId);
      }
      const state = await snapshot(logicalSessionId);
      expect(state).toMatchObject({
        automatic_personal_project_id: f.project.id,
        project_share_capture_policy_version: 1,
        project_share_capture_workspace_project_id: workspaceProject,
        project_share_capture_device_credential_id: credential
      });
      expect(state.project_share_capture_link_epoch).toMatch(/^[0-9a-f-]{36}$/);
    },
    120_000
  );

  it("does not stamp Project HQ, a resumed old Session, or a changed link epoch", async () => {
    const hq = await setup();
    const hqLaunch = await start(hq, { hq: true });
    const hqSession = randomUUID();
    await capture(hq, hqSession);
    await bind(hq, hqLaunch, hqSession);
    expect(
      (await snapshot(hqSession)).project_share_capture_policy_version
    ).toBeNull();

    const old = await setup();
    const oldSession = randomUUID();
    await capture(old, oldSession);
    await pool.query(
      `update sessions set created_at=now()-interval '5 minutes' where logical_session_id=$1`,
      [oldSession]
    );
    const oldLaunch = await start(old);
    await bind(old, oldLaunch, oldSession);
    expect(
      (await snapshot(oldSession)).project_share_capture_policy_version
    ).toBeNull();

    const relinked = await setup();
    const relinkedLaunch = await start(relinked);
    await pool.query(
      `update projects set share_policy_link_epoch=gen_random_uuid() where id=$1`,
      [relinked.project.id]
    );
    const relinkedSession = randomUUID();
    await capture(relinked, relinkedSession);
    await bind(relinked, relinkedLaunch, relinkedSession);
    expect(
      (await snapshot(relinkedSession)).project_share_capture_policy_version
    ).toBeNull();
  }, 120_000);
});
