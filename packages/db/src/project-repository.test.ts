import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import {
  createProjectRepository,
  type VerifiedLocalProjectContext
} from "./project-repository.js";
import { createMemorySourceRepository } from "./repository.js";

const testUrl =
  process.env.KOED_PROJECT_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("Personal Project repository", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  let repository: ReturnType<typeof createProjectRepository>;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq201_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    repository = createProjectRepository(pool);
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
        if (sessions !== 0) {
          throw new Error(
            `Project repository test database still has ${sessions} active session(s)`
          );
        }
        await admin.query(`drop database if exists ${quote(database)}`);
      }
    } finally {
      await admin?.end();
    }
  });

  const fixture = async (
    input: {
      owner?: string;
      localProjectId?: string;
      commonDirHash?: string | null;
      gitDirHash?: string | null;
      folderHash?: string;
      verifiedNewLinkedCheckout?: boolean;
      displayName?: string;
      externalSessionId?: string;
    } = {}
  ): Promise<VerifiedLocalProjectContext> => {
    const ownerUserId = input.owner ?? randomUUID();
    await pool.query(
      `insert into users (id,email) values ($1,$2) on conflict (id) do nothing`,
      [ownerUserId, `${ownerUserId}@example.test`]
    );
    const sessionId = randomUUID();
    const externalSessionId = input.externalSessionId ?? randomUUID();
    await pool.query(
      `insert into sessions (id,owner_user_id,source_runtime,capture_method,external_session_id)
       values ($1,$2,'codex-cli','api',$3)`,
      [sessionId, ownerUserId, externalSessionId]
    );
    const artifact = await pool.query<{ id: string }>(
      `insert into conversation_source_artifacts
         (owner_user_id,session_id,logical_source_id,source_generation_id,
          replica_role,source_kind,source_runtime,external_session_id,
          source_fingerprint,artifact_format,artifact_format_version,
          source_adapter_version,source_created_at,storage_provider,storage_prefix,
          origin_deployment_id,origin_device_id,origin_key_id,origin_public_key,redacted_source_label)
       values ($1,$2,$3,$4,'origin_local','codex','codex-cli',$5,
               '${"a".repeat(64)}','jsonl',1,'codex-transcript-v1',now(),'filesystem','fixture',
               'deployment','device','key','${"A".repeat(43)}','fixture') returning id`,
      [ownerUserId, sessionId, randomUUID(), randomUUID(), externalSessionId]
    );
    return {
      sourceKind: "codex",
      ownerUserId,
      deviceId: "11111111-1111-4111-8111-111111111111",
      localProjectId:
        input.localProjectId ?? `lp_${randomUUID().replaceAll("-", "")}`,
      displayName: input.displayName ?? "Same name",
      commonDirHash: input.commonDirHash ?? null,
      gitDirHash: input.gitDirHash ?? null,
      folderHash: input.folderHash ?? randomUUID(),
      verifiedNewLinkedCheckout: input.verifiedNewLinkedCheckout ?? false,
      hasRemoteCandidate: false,
      hasMovedCheckoutCandidate: false,
      sessionId,
      artifactId: artifact.rows[0]!.id,
      minimumProviderCursorOffset: 0,
      externalSessionId
    };
  };

  it("registers a new context, preserves exact mapping, and keeps owner keys unique", async () => {
    const first = await fixture();
    const a = await repository.associateVerifiedCapturedSession(first);
    const again = await repository.associateVerifiedCapturedSession(first);
    const second = await fixture({ owner: first.ownerUserId });
    const b = await repository.associateVerifiedCapturedSession(second);
    expect(a.projectId).toBeTruthy();
    expect(again.projectId).toBe(a.projectId);
    expect(again.sessionAssigned).toBe(true);
    expect(b.projectId).not.toBe(a.projectId);
    const projects = await pool.query<{ name: string; key: string }>(
      `select name,key from projects where owner_user_id=$1 order by created_at,id`,
      [first.ownerUserId]
    );
    expect(projects.rows.map((row) => row.name)).toEqual([
      "Same name",
      "Same name"
    ]);
    expect(new Set(projects.rows.map((row) => row.key)).size).toBe(2);
  });

  it("publishes one owner Project invalidation for creation and each first Session assignment", async () => {
    const first = await fixture();
    const created = await repository.associateVerifiedCapturedSession(first);
    const second = await fixture({
      owner: first.ownerUserId,
      localProjectId: first.localProjectId
    });
    const reused = await repository.associateVerifiedCapturedSession(second);
    await repository.associateVerifiedCapturedSession(first);
    await repository.associateVerifiedCapturedSession(second);
    expect(reused.projectId).toBe(created.projectId);
    const events = await pool.query<{
      family: string;
      scope: string;
      personal_owner_user_id: string;
      resource_type: string;
      resource_id: string;
    }>(
      `select family,scope,personal_owner_user_id,resource_type,resource_id
         from collaboration_outbox where personal_owner_user_id=$1 order by cursor`,
      [first.ownerUserId]
    );
    expect(events.rows).toEqual([
      {
        family: "project_changed",
        scope: "personal",
        personal_owner_user_id: first.ownerUserId,
        resource_type: "project",
        resource_id: created.projectId
      },
      {
        family: "project_changed",
        scope: "personal",
        personal_owner_user_id: first.ownerUserId,
        resource_type: "project",
        resource_id: created.projectId
      }
    ]);
  });

  it("projects graph threads by the exact effective owner-owned Personal Project ID", async () => {
    const automatic = await fixture();
    const personalProjectId = (
      await repository.associateVerifiedCapturedSession(automatic)
    ).projectId!;
    const overridden = await fixture({
      owner: automatic.ownerUserId,
      localProjectId: automatic.localProjectId
    });
    await repository.associateVerifiedCapturedSession(overridden);
    const priorTrash = await fixture({
      owner: automatic.ownerUserId,
      localProjectId: automatic.localProjectId
    });
    await repository.associateVerifiedCapturedSession(priorTrash);
    const otherOwner = await fixture({
      localProjectId: automatic.localProjectId
    });
    await repository.associateVerifiedCapturedSession(otherOwner);
    await pool.query(
      `update sessions set metadata=jsonb_build_object('threadName', case when id=$1 then 'Automatic' when id=$2 then 'Explicit null' when id=$3 then 'Prior trash' else 'Other owner' end)
       where id=any($4::uuid[])`,
      [
        automatic.sessionId,
        overridden.sessionId,
        priorTrash.sessionId,
        [
          automatic.sessionId,
          overridden.sessionId,
          priorTrash.sessionId,
          otherOwner.sessionId
        ]
      ]
    );
    await pool.query(
      `update sessions set project_override_id=$2,project_override_name='Independent',
        project_override_at=now(),project_override_by_user_id=$3,
        project_override_personal_project_id=null where id=$1`,
      [overridden.sessionId, automatic.localProjectId, automatic.ownerUserId]
    );
    await pool.query(
      `update sessions set trashed_at=now() where id=any($1::uuid[])`,
      [[automatic.sessionId, priorTrash.sessionId]]
    );
    const graph = await createMemorySourceRepository(pool).listLcmGraphThreads(
      { userId: automatic.ownerUserId },
      { limit: 500 }
    );
    const bySession = new Map(
      graph.flatMap(({ threads }) =>
        threads.map((thread) => [thread.sessionId, thread] as const)
      )
    );
    expect(bySession.get(automatic.sessionId)?.personalProjectId).toBe(
      personalProjectId
    );
    expect(bySession.get(overridden.sessionId)?.personalProjectId).toBeNull();
    expect(
      bySession.get(automatic.sessionId)?.conversationTrashedAt
    ).toBeTruthy();
    expect(
      bySession.get(priorTrash.sessionId)?.conversationTrashedAt
    ).toBeTruthy();
    expect(bySession.has(otherOwner.sessionId)).toBe(false);
    await pool.query(`update sessions set trashed_at=null where id=$1`, [
      automatic.sessionId
    ]);
    const restored = await createMemorySourceRepository(
      pool
    ).listLcmGraphThreads({ userId: automatic.ownerUserId }, { limit: 500 });
    const restoredBySession = new Map(
      restored.flatMap(({ threads }) =>
        threads.map((thread) => [thread.sessionId, thread] as const)
      )
    );
    expect(
      restoredBySession.get(automatic.sessionId)?.conversationTrashedAt
    ).toBeNull();
    expect(
      restoredBySession.get(priorTrash.sessionId)?.conversationTrashedAt
    ).toBeTruthy();
  });

  it("keeps a locally changed checkout unresolved until a new confirmation", async () => {
    const captured = await fixture();
    expect(
      await repository.associateVerifiedCapturedSession({
        ...captured,
        requiresConfirmation: true,
        confirmedSeparate: true,
        confirmationVersion: 1
      })
    ).toMatchObject({
      state: "unresolved",
      projectId: null,
      sessionAssigned: false,
      reason: "local_identity_changed"
    });
    const [projects, contexts, sessions] = await Promise.all([
      pool.query<{ count: string }>(
        `select count(*)::text as count from projects where owner_user_id=$1`,
        [captured.ownerUserId]
      ),
      pool.query<{ count: string }>(
        `select count(*)::text as count from project_local_contexts where owner_user_id=$1`,
        [captured.ownerUserId]
      ),
      pool.query<{ automatic_personal_project_id: string | null }>(
        `select automatic_personal_project_id from sessions where id=$1`,
        [captured.sessionId]
      )
    ]);
    expect(projects.rows[0]?.count).toBe("0");
    expect(contexts.rows[0]?.count).toBe("0");
    expect(sessions.rows[0]?.automatic_personal_project_id).toBeNull();
  });

  it("requires the exact accepted source kind for every provider", async () => {
    for (const sourceKind of ["claude-code", "pi"] as const) {
      const captured = await fixture();
      await pool.query(
        `update conversation_source_artifacts set source_kind=$2 where id=$1`,
        [captured.artifactId, sourceKind]
      );
      expect(
        await repository.associateVerifiedCapturedSession(captured)
      ).toMatchObject({
        state: "session_missing",
        projectId: null
      });
      expect(
        await repository.associateVerifiedCapturedSession({
          ...captured,
          sourceKind
        })
      ).toMatchObject({ state: "resolved", sessionAssigned: true });
    }
  });

  it("keeps new sessions unassigned for retained deleted mappings", async () => {
    const first = await fixture();
    const projectId = (await repository.associateVerifiedCapturedSession(first))
      .projectId!;
    await pool.query(
      `update projects set lifecycle='deleted',deleted_at=now() where id=$1`,
      [projectId]
    );
    const next = await fixture({
      owner: first.ownerUserId,
      localProjectId: first.localProjectId
    });
    const result = await repository.associateVerifiedCapturedSession(next);
    expect(result.projectId).toBe(projectId);
    expect(result.sessionAssigned).toBe(false);
    const rows = await pool.query<{
      id: string;
      automatic_personal_project_id: string | null;
    }>(
      `select id,automatic_personal_project_id from sessions where id=any($1::uuid[])`,
      [[first.sessionId, next.sessionId]]
    );
    expect(
      rows.rows.find((row) => row.id === first.sessionId)
        ?.automatic_personal_project_id
    ).toBe(projectId);
    expect(
      rows.rows.find((row) => row.id === next.sessionId)
        ?.automatic_personal_project_id
    ).toBeNull();
    const chosen = await fixture({ owner: first.ownerUserId });
    const chosenProjectId = (
      await repository.associateVerifiedCapturedSession(chosen)
    ).projectId!;
    const afterChoice = await fixture({
      owner: first.ownerUserId,
      localProjectId: first.localProjectId
    });
    const explicit = await repository.associateVerifiedCapturedSession({
      ...afterChoice,
      confirmedProjectId: chosenProjectId,
      confirmationVersion: 1
    });
    expect(explicit).toMatchObject({
      state: "resolved",
      projectId: chosenProjectId,
      sessionAssigned: true
    });
    const original = await pool.query<{
      automatic_personal_project_id: string | null;
    }>(`select automatic_personal_project_id from sessions where id=$1`, [
      first.sessionId
    ]);
    expect(original.rows[0]?.automatic_personal_project_id).toBe(projectId);
  });

  it("does not assign a new Session while Project deletion commits concurrently", async () => {
    const original = await fixture();
    const projectId = (
      await repository.associateVerifiedCapturedSession(original)
    ).projectId!;
    const next = await fixture({
      owner: original.ownerUserId,
      localProjectId: original.localProjectId
    });
    const deleter = await pool.connect();
    let deletionOpen = false;
    try {
      await deleter.query("begin");
      deletionOpen = true;
      await deleter.query(
        `update projects set lifecycle='deleted',deleted_at=now() where id=$1`,
        [projectId]
      );
      let completed = false;
      const association = repository
        .associateVerifiedCapturedSession(next)
        .then((result) => {
          completed = true;
          return result;
        });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(completed).toBe(false);
      await deleter.query("commit");
      deletionOpen = false;
      expect(await association).toMatchObject({
        state: "resolved",
        projectId,
        sessionAssigned: false
      });
      const row = await pool.query<{
        automatic_personal_project_id: string | null;
      }>(`select automatic_personal_project_id from sessions where id=$1`, [
        next.sessionId
      ]);
      expect(row.rows[0]?.automatic_personal_project_id).toBeNull();
    } finally {
      if (deletionOpen) await deleter.query("rollback");
      deleter.release();
    }
  });

  it("applies one separate confirmation once across pending sessions and never reuses it after deletion", async () => {
    const first = await fixture();
    const originalProject = (
      await repository.associateVerifiedCapturedSession(first)
    ).projectId!;
    await pool.query(
      `update projects set lifecycle='deleted',deleted_at=now() where id=$1`,
      [originalProject]
    );
    const a = await fixture({
      owner: first.ownerUserId,
      localProjectId: first.localProjectId
    });
    const b = await fixture({
      owner: first.ownerUserId,
      localProjectId: first.localProjectId
    });
    const [one, two] = await Promise.all([
      repository.associateVerifiedCapturedSession({
        ...a,
        confirmedSeparate: true,
        confirmationVersion: 1
      }),
      repository.associateVerifiedCapturedSession({
        ...b,
        confirmedSeparate: true,
        confirmationVersion: 1
      })
    ]);
    expect(one.projectId).toBeTruthy();
    expect(two.projectId).toBe(one.projectId);
    const count = await pool.query<{ count: string }>(
      `select count(*)::text as count from projects where owner_user_id=$1`,
      [first.ownerUserId]
    );
    expect(count.rows[0]?.count).toBe("2");
    const active = await fixture({
      owner: first.ownerUserId,
      localProjectId: first.localProjectId
    });
    expect(
      (
        await repository.associateVerifiedCapturedSession({
          ...active,
          confirmedSeparate: true,
          confirmationVersion: 2
        })
      ).projectId
    ).toBe(one.projectId);
    await pool.query(
      `update projects set lifecycle='deleted',deleted_at=now() where id=$1`,
      [one.projectId]
    );
    const stale = await fixture({
      owner: first.ownerUserId,
      localProjectId: first.localProjectId
    });
    expect(
      await repository.associateVerifiedCapturedSession({
        ...stale,
        confirmedSeparate: true,
        confirmationVersion: 1
      })
    ).toMatchObject({
      state: "resolved",
      projectId: one.projectId,
      sessionAssigned: false
    });
    const stillTwo = await pool.query<{ count: string }>(
      `select count(*)::text as count from projects where owner_user_id=$1`,
      [first.ownerUserId]
    );
    expect(stillTwo.rows[0]?.count).toBe("2");
    const fresh = await fixture({
      owner: first.ownerUserId,
      localProjectId: first.localProjectId
    });
    const newChoice = await repository.associateVerifiedCapturedSession({
      ...fresh,
      confirmedSeparate: true,
      confirmationVersion: 2
    });
    expect(newChoice.projectId).not.toBe(one.projectId);
    expect(newChoice.sessionAssigned).toBe(true);
  });

  it("does not turn a common hash or remote candidate into authority", async () => {
    const owner = randomUUID();
    const first = await fixture({
      owner,
      commonDirHash: "common",
      gitDirHash: "git-a",
      folderHash: "folder-a"
    });
    const projectId = (await repository.associateVerifiedCapturedSession(first))
      .projectId!;
    const candidate = await fixture({
      owner,
      commonDirHash: "common",
      gitDirHash: "git-b",
      folderHash: "folder-b"
    });
    const unresolved =
      await repository.associateVerifiedCapturedSession(candidate);
    expect(unresolved).toMatchObject({
      state: "unresolved",
      projectId: null,
      sessionAssigned: false
    });
    const confirmed = await repository.associateVerifiedCapturedSession({
      ...candidate,
      confirmedProjectId: projectId,
      confirmationVersion: 1
    });
    expect(confirmed.projectId).toBe(projectId);
    const remoteOnly = await fixture({ owner, commonDirHash: null });
    expect(
      (
        await repository.associateVerifiedCapturedSession({
          ...remoteOnly,
          hasRemoteCandidate: true
        })
      ).state
    ).toBe("unresolved");
  });

  it("atomically reuses one verified group on concurrent first captures", async () => {
    const owner = randomUUID();
    const first = await fixture({
      owner,
      commonDirHash: "verified-group",
      gitDirHash: "verified-a",
      verifiedNewLinkedCheckout: true
    });
    const second = await fixture({
      owner,
      commonDirHash: "verified-group",
      gitDirHash: "verified-b",
      verifiedNewLinkedCheckout: true
    });
    const [a, b] = await Promise.all([
      repository.associateVerifiedCapturedSession(first),
      repository.associateVerifiedCapturedSession(second)
    ]);
    expect(b.projectId).toBe(a.projectId);
    const count = await pool.query<{ count: string }>(
      `select count(*)::text as count from projects where owner_user_id=$1`,
      [owner]
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("does not resolve a moved checkout or an ambiguous override by race order", async () => {
    const owner = randomUUID();
    const first = await fixture({
      owner,
      commonDirHash: "moved",
      gitDirHash: "same-git-dir",
      folderHash: "old-folder"
    });
    const firstProject = (
      await repository.associateVerifiedCapturedSession(first)
    ).projectId!;
    const moved = await fixture({
      owner,
      commonDirHash: "moved",
      gitDirHash: "same-git-dir",
      folderHash: "new-folder",
      verifiedNewLinkedCheckout: true
    });
    const result = await repository.associateVerifiedCapturedSession(moved);
    expect(result).toMatchObject({
      state: "unresolved",
      reason: "moved_checkout"
    });
    const second = await fixture({
      owner,
      commonDirHash: "different",
      gitDirHash: "different-git-dir"
    });
    const secondProject = (
      await repository.associateVerifiedCapturedSession(second)
    ).projectId!;
    await pool.query(
      `insert into project_local_contexts
         (owner_user_id,project_id,device_id,local_project_id,association_state)
       values ($1,$2,$3,$4,'resolved')`,
      [owner, secondProject, randomUUID(), first.localProjectId]
    );
    const legacy = await fixture({ owner });
    await pool.query(
      `update sessions set project_override_id=$2,project_override_name='Chosen',
        project_override_at=now(),project_override_by_user_id=$3 where id=$1`,
      [legacy.sessionId, first.localProjectId, owner]
    );
    const backfill = await repository.backfillLegacyProjectOverrides(owner);
    expect(backfill.ambiguous).toBe(1);
    const row = await pool.query<{
      project_override_personal_project_id: string | null;
    }>(
      `select project_override_personal_project_id from sessions where id=$1`,
      [legacy.sessionId]
    );
    expect(row.rows[0]?.project_override_personal_project_id).toBeNull();
    expect(firstProject).not.toBe(secondProject);
  });

  it("treats locally proven main-checkout moves as unresolved even when path hashes change", async () => {
    const owner = randomUUID();
    const original = await fixture({
      owner,
      commonDirHash: "old-common",
      gitDirHash: "old-git",
      folderHash: "old-folder"
    });
    await repository.associateVerifiedCapturedSession(original);
    const moved = await fixture({
      owner,
      commonDirHash: "new-common",
      gitDirHash: "new-git",
      folderHash: "new-folder"
    });
    expect(
      await repository.associateVerifiedCapturedSession({
        ...moved,
        hasMovedCheckoutCandidate: true
      })
    ).toMatchObject({
      state: "unresolved",
      projectId: null,
      reason: "moved_checkout"
    });
  });

  it("lazily maps only exact older sessions and explicit overrides", async () => {
    const owner = randomUUID();
    const registered = await fixture({ owner });
    const projectId = (
      await repository.associateVerifiedCapturedSession(registered)
    ).projectId!;
    const older = await fixture({ owner });
    const explicit = await fixture({ owner });
    await pool.query(
      `update sessions set automatic_project_id=$2,automatic_project_name='Old name',
        automatic_project_detected_at=now() where id=$1`,
      [older.sessionId, registered.localProjectId]
    );
    await pool.query(
      `update sessions set project_override_id=$2,project_override_name='Existing choice',
        project_override_at=now(),project_override_by_user_id=$3 where id=$1`,
      [explicit.sessionId, registered.localProjectId, owner]
    );
    const unverified = await pool.query<{
      automatic_personal_project_id: string | null;
    }>(`select automatic_personal_project_id from sessions where id=$1`, [
      older.sessionId
    ]);
    expect(unverified.rows[0]?.automatic_personal_project_id).toBeNull();
    expect(
      (
        await repository.associateVerifiedCapturedSession({
          ...older,
          localProjectId: registered.localProjectId
        })
      ).projectId
    ).toBe(projectId);
    expect(await repository.backfillLegacyProjectOverrides(owner)).toEqual({
      mapped: 1,
      ambiguous: 0
    });
    const result = await pool.query<{
      id: string;
      automatic_personal_project_id: string | null;
      project_override_personal_project_id: string | null;
      project_override_id: string | null;
    }>(
      `select id,automatic_personal_project_id,project_override_personal_project_id,project_override_id
         from sessions where id=any($1::uuid[])`,
      [[older.sessionId, explicit.sessionId]]
    );
    expect(
      result.rows.find((row) => row.id === older.sessionId)
        ?.automatic_personal_project_id
    ).toBe(projectId);
    const mapped = result.rows.find((row) => row.id === explicit.sessionId);
    expect(mapped?.project_override_personal_project_id).toBe(projectId);
    expect(mapped?.project_override_id).toBe(registered.localProjectId);
  });

  it("rejects a different owner or a session without a persisted source artifact", async () => {
    const captured = await fixture();
    const otherOwner = randomUUID();
    await pool.query("insert into users (id,email) values ($1,$2)", [
      otherOwner,
      `${otherOwner}@example.test`
    ]);
    expect(
      await repository.associateVerifiedCapturedSession({
        ...captured,
        ownerUserId: otherOwner
      })
    ).toMatchObject({ state: "session_missing", projectId: null });
    await pool.query(
      "delete from conversation_source_artifacts where session_id=$1",
      [captured.sessionId]
    );
    expect(
      await repository.associateVerifiedCapturedSession(captured)
    ).toMatchObject({
      state: "session_missing",
      projectId: null
    });
    const rows = await pool.query<{ count: string }>(
      `select count(*)::text as count from projects where owner_user_id=any($1::uuid[])`,
      [[captured.ownerUserId, otherOwner]]
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("requires the exact accepted artifact frontier before registration", async () => {
    const captured = await fixture();
    expect(
      await repository.associateVerifiedCapturedSession({
        ...captured,
        minimumProviderCursorOffset: 10
      })
    ).toMatchObject({ state: "session_missing", projectId: null });
    expect(
      await repository.associateVerifiedCapturedSession({
        ...captured,
        artifactId: randomUUID()
      })
    ).toMatchObject({ state: "session_missing", projectId: null });
    await pool.query(
      `update conversation_source_artifacts set provider_cursor_offset=10,
        provider_cursor_line=1,current_source_length=10 where id=$1`,
      [captured.artifactId]
    );
    expect(
      await repository.associateVerifiedCapturedSession({
        ...captured,
        minimumProviderCursorOffset: 10
      })
    ).toMatchObject({ state: "resolved", sessionAssigned: true });
  });
});
