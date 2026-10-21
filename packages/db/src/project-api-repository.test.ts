import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "./migrate.js";
import { createCapturedSessionRepository } from "./captured-session-repository.js";
import { createWorkItemRepository } from "./work-item-repository.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { createCrossIdentitySyncRepository } from "./cross-identity-sync-repository.js";
import { createSharedMemoryRepository } from "./shared-memory-repository.js";
import { crossIdentitySyncDeterministicUuid } from "@koed/shared";
import {
  createProjectApiRepository,
  ProjectCapabilityError,
  ProjectConflictError
} from "./project-api-repository.js";

const testUrl =
  process.env.KOED_HQ202_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!testUrl)("Personal Project API lifecycle", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  let projects: ReturnType<typeof createProjectApiRepository>;
  const owner = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq202_worker_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${quote(database)}`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    await pool.query(`insert into users(id,email) values ($1,$2),($3,$4)`, [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    await pool.query(
      `insert into deployment_identities
       (protocol_deployment_id,locality,profile)
       values ($1,'local','developer')`,
      [randomUUID()]
    );
    projects = createProjectApiRepository(pool);
  }, 120_000);
  afterAll(async () => {
    try {
      await pool?.end();
      if (admin && database) {
        for (let attempt = 0; attempt < 50; attempt++) {
          const active = await admin.query<{ count: number }>(
            `select count(*)::integer as count from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
            [database]
          );
          if (active.rows[0]!.count === 0) break;
          if (attempt === 49)
            throw new Error("HQ202 test database retained active connections");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await admin.query(`drop database ${quote(database)}`);
      }
    } finally {
      await admin?.end();
    }
  });

  it("owns create/rename/folder/idempotency and preserves exact pagination", async () => {
    const first = await projects.create(owner, {
      name: "Atlas",
      folderPath: "/atlas",
      idempotencyKey: "one"
    });
    expect(
      await projects.create(owner, {
        name: "Atlas",
        folderPath: "/atlas",
        idempotencyKey: "one"
      })
    ).toEqual(first);
    await expect(
      projects.create(owner, { name: "Else", idempotencyKey: "one" })
    ).rejects.toBeInstanceOf(ProjectConflictError);
    const second = await projects.create(owner, {
      name: "Atlas",
      idempotencyKey: "two"
    });
    expect(second.key).not.toBe(first.key);
    const page = await projects.list(owner, {
      limit: 1,
      includeDeleted: false
    });
    expect(page.nextCursor).toBeTruthy();
    const next = await projects.list(owner, {
      limit: 1,
      includeDeleted: false,
      cursor: page.nextCursor!
    });
    expect(
      new Set([...page.projects, ...next.projects].map((item) => item.id))
    ).toEqual(new Set([first.id, second.id]));
    await expect(
      projects.list(owner, {
        limit: 1,
        includeDeleted: false,
        cursor: Buffer.from(
          JSON.stringify({ createdAt: "2026-01-01 00:00:00+00", id: "oops" })
        ).toString("base64url")
      })
    ).rejects.toBeInstanceOf(ProjectConflictError);
    const renamed = await projects.patch(owner, first.id, {
      version: first.version,
      name: "Atlas Research",
      folderPath: "/research"
    });
    expect(renamed.name).toBe("Atlas Research");
    expect(renamed.folderPath).toBe("/research");
    await expect(
      projects.patch(other, first.id, {
        version: renamed.version,
        name: "Wrong owner"
      })
    ).rejects.toThrow();
    await expect(
      projects.patch(owner, first.id, { version: first.version, name: "Stale" })
    ).rejects.toBeInstanceOf(ProjectConflictError);
  });

  it("retains an offline cancelled source release across batches without resuming old grants", async () => {
    const project = await projects.create(owner, {
      name: "Cancellation recovery",
      idempotencyKey: "cancel-recovery"
    });
    const sessionId = randomUUID();
    const logicalMemoryId = randomUUID();
    const oldBatch = randomUUID();
    const backendId = "team-cancel";
    const deployment = await pool.query<{ id: string }>(
      `select id from deployment_identities where locality='local' limit 1`
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,
       automatic_personal_project_id) values ($1,$2,'codex-cli','api',$3)`,
      [sessionId, owner, project.id]
    );
    const seed = await pool.connect();
    try {
      await seed.query("begin");
      await seed.query(
        `insert into logical_memories(id,protocol_logical_id,owner_user_id,
         owner_principal_id,origin_deployment_identity_id,source_kind,logical_key)
         values ($1,$1,$2,$2,$3,'captured_session',$4)`,
        [
          logicalMemoryId,
          owner,
          deployment.rows[0]!.id,
          `captured-session:${sessionId}`
        ]
      );
      await seed.query(
        `insert into captured_session_logical_memories
         (logical_memory_id,source_session_id,owner_principal_id)
         values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, owner]
      );
      await seed.query(
        `insert into local_captured_session_logical_memories
         (logical_memory_id,local_session_id,owner_user_id) values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, owner]
      );
      await seed.query("commit");
    } catch (error) {
      await seed.query("rollback");
      throw error;
    } finally {
      seed.release();
    }
    const repository = createProjectApiRepository(pool, {
      configuredBackendIds: () => [backendId]
    });
    const preview = await repository.deletePreview(owner, project.id);
    await repository.beginDelete(owner, project.id, {
      version: project.version,
      batchId: oldBatch,
      executionSetHash: preview.executionSetHash
    });
    const active = await repository.getDeleteOperation(owner, project.id);
    expect(active?.sources[0]?.backends).toEqual([
      { backendId, relationshipIds: [] }
    ]);
    await repository.cancelDelete(owner, project.id, oldBatch);
    expect(await repository.getDeleteOperation(owner, project.id)).toBeNull();
    expect(
      (await repository.listPendingReleaseOperations(owner, project.id)).map(
        (operation) => operation.batchId
      )
    ).toEqual([oldBatch]);
    await repository.recordBackendAck(owner, project.id, oldBatch, {
      logicalMemoryId,
      backendId,
      generation: 1,
      holdVersion: 2,
      sealed: false,
      cancelled: true
    });
    await repository.finishRestoreRelease(owner, project.id, oldBatch);
    expect(
      await repository.listPendingReleaseOperations(owner, project.id)
    ).toEqual([]);
    expect(
      (await repository.getDeleteOperationByBatch(owner, project.id, oldBatch))
        ?.state
    ).toBe("cancelled");
    const current = await repository.get(owner, project.id);
    const newBatch = randomUUID();
    await repository.beginDelete(owner, project.id, {
      version: current.version,
      batchId: newBatch,
      executionSetHash: preview.executionSetHash
    });
    expect(
      (await repository.getDeleteOperation(owner, project.id))?.batchId
    ).toBe(newBatch);
    expect(
      (await repository.getDeleteOperationByBatch(owner, project.id, oldBatch))
        ?.backendAcks
    ).toEqual([expect.objectContaining({ cancelled: true, sealed: false })]);
  });

  it("blocks pending local-context reassociation but permits a confirmed replacement after deletion", async () => {
    const original = await projects.create(owner, {
      name: "Old context",
      idempotencyKey: "context-old"
    });
    const replacement = await projects.create(owner, {
      name: "New context",
      idempotencyKey: "context-new"
    });
    const deviceId = randomUUID();
    const localProjectId = `local-${randomUUID()}`;
    const sessionId = randomUUID();
    await pool.query(
      `insert into project_local_contexts
       (owner_user_id,project_id,device_id,local_project_id)
       values ($1,$2,$3,$4)`,
      [owner, original.id, deviceId, localProjectId]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,
       automatic_personal_project_id) values ($1,$2,'codex-cli','api',$3)`,
      [sessionId, owner, original.id]
    );
    const preview = await projects.deletePreview(owner, original.id);
    const batchId = randomUUID();
    await projects.beginDelete(owner, original.id, {
      version: original.version,
      batchId,
      executionSetHash: preview.executionSetHash
    });
    await expect(
      pool.query(
        `update project_local_contexts set project_id=$4
         where owner_user_id=$1 and device_id=$2 and local_project_id=$3`,
        [owner, deviceId, localProjectId, replacement.id]
      )
    ).rejects.toThrow("Local Project context is unavailable during deletion");
    await projects.markDeleteReady(owner, original.id, batchId);
    await projects.completeDelete(owner, original.id, batchId);
    await pool.query(
      `update project_local_contexts set project_id=$4
       where owner_user_id=$1 and device_id=$2 and local_project_id=$3`,
      [owner, deviceId, localProjectId, replacement.id]
    );
    const context = await pool.query<{ project_id: string }>(
      `select project_id from project_local_contexts
       where owner_user_id=$1 and device_id=$2 and local_project_id=$3`,
      [owner, deviceId, localProjectId]
    );
    const session = await pool.query<{
      automatic_personal_project_id: string;
      trashed_at: string | null;
    }>(
      `select automatic_personal_project_id,trashed_at from sessions where id=$1`,
      [sessionId]
    );
    expect(context.rows[0]?.project_id).toBe(replacement.id);
    expect(session.rows[0]?.automatic_personal_project_id).toBe(original.id);
    expect(session.rows[0]?.trashed_at).toBeTruthy();
  });

  it("trashes only its exact batch, hides active chat, retains direct retrieval, and restores", async () => {
    const project = await projects.create(owner, {
      name: "Conversation",
      idempotencyKey: "delete"
    });
    const sessionId = randomUUID();
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,
      automatic_personal_project_id) values ($1,$2,'codex-cli','api',$3)`,
      [sessionId, owner, project.id]
    );
    const captured = createCapturedSessionRepository(pool);
    const workItems = createWorkItemRepository(pool);
    const keep = await workItems.create(owner, project.id, {
      kind: "todo",
      title: "Keep",
      goal: "Retain this",
      origin: "manual",
      idempotencyKey: "keep"
    });
    const manual = await workItems.create(owner, project.id, {
      kind: "todo",
      title: "Manual",
      goal: "Remove first",
      origin: "manual",
      idempotencyKey: "manual"
    });
    await workItems.deleteTodo(owner, manual.id);
    expect(
      (await captured.listCapturedSessionSummaries({ userId: owner })).some(
        (item) => item.sessionId === sessionId
      )
    ).toBe(true);
    expect(
      (await projects.hq(owner, project.id)).sections.conversations
    ).toEqual({ availability: "available", count: 1 });
    const preview = await projects.deletePreview(owner, project.id);
    expect(preview.activeExecutions).toEqual([]);
    const batchId = randomUUID();
    const pending = await projects.beginDelete(owner, project.id, {
      version: project.version,
      batchId,
      executionSetHash: preview.executionSetHash
    });
    expect(pending.deletionPhase).toBe("preparing");
    await expect(
      projects.patch(owner, project.id, {
        version: pending.version,
        name: "Blocked"
      })
    ).rejects.toBeInstanceOf(ProjectConflictError);
    await projects.markDeleteReady(owner, project.id, batchId);
    const deleted = await projects.completeDelete(owner, project.id, batchId);
    expect(deleted.lifecycle).toBe("deleted");
    expect(
      (await captured.listCapturedSessionSummaries({ userId: owner })).some(
        (item) => item.sessionId === sessionId
      )
    ).toBe(false);
    expect(await workItems.getForRealtime(owner, keep.id)).toBeNull();
    expect(
      await captured.getCapturedSession({ userId: owner }, sessionId)
    ).not.toBeNull();
    const independentSync = createCrossIdentitySyncRepository(pool);
    expect(
      await independentSync.getCapturedSessionSyncSource(
        { userId: owner },
        sessionId
      )
    ).toMatchObject({ originSessionId: sessionId });
    expect(
      await independentSync.prepareCapturedSessionSyncCandidateRevision(
        { userId: owner },
        sessionId
      )
    ).toBeNull();
    const restored = await projects.restore(owner, project.id, {
      version: deleted.version,
      batchId
    });
    expect(restored.lifecycle).toBe("active");
    expect(
      (await projects.listPendingReleaseOperations(owner, project.id)).map(
        (item) => item.batchId
      )
    ).toEqual([batchId]);
    await projects.finishRestoreRelease(owner, project.id, batchId);
    expect(
      await projects.listPendingReleaseOperations(owner, project.id)
    ).toEqual([]);
    expect(
      (await captured.listCapturedSessionSummaries({ userId: owner })).some(
        (item) => item.sessionId === sessionId
      )
    ).toBe(true);
    expect(await workItems.getForRealtime(owner, keep.id)).not.toBeNull();
    expect(await workItems.getForRealtime(owner, manual.id)).toBeNull();
    const trashed = await pool.query<{ trashed_at: string | null }>(
      `select trashed_at from sessions where id=$1`,
      [sessionId]
    );
    expect(trashed.rows[0]!.trashed_at).toBeNull();
    const secondPreview = await projects.deletePreview(owner, project.id);
    const secondBatch = randomUUID();
    await projects.beginDelete(owner, project.id, {
      version: restored.version,
      batchId: secondBatch,
      executionSetHash: secondPreview.executionSetHash
    });
    expect(
      (await projects.getDeleteOperation(owner, project.id))?.batchId
    ).toBe(secondBatch);
  });

  it("serializes first preview admission and fences stale or reactivated access", async () => {
    const deployment = await pool.query<{ id: string }>(
      `select id from deployment_identities where locality='local' limit 1`
    );
    const logicalMemoryId = randomUUID();
    const seed = await pool.connect();
    try {
      await seed.query("begin");
      await seed.query(
        `insert into logical_memories(id,protocol_logical_id,owner_user_id,
      owner_principal_id,origin_deployment_identity_id,source_kind,logical_key)
      values ($1,$1,$2,$2,$3,'captured_session',$4)`,
        [
          logicalMemoryId,
          owner,
          deployment.rows[0]!.id,
          `captured-session:${randomUUID()}`
        ]
      );
      await seed.query(
        `insert into captured_session_logical_memories
        (logical_memory_id,source_session_id,owner_principal_id) values ($1,$2,$3)`,
        [logicalMemoryId, randomUUID(), owner]
      );
      await seed.query("commit");
    } catch (error) {
      await seed.query("rollback");
      throw error;
    } finally {
      seed.release();
    }
    await pool.query(`create table hq202_preview_probe(logical_memory_id uuid not null,
      source_admission_generation bigint not null default 0)`);
    await pool.query(`create trigger hq202_preview_probe_admission before insert or update
      on hq202_preview_probe for each row execute function koed_bind_candidate_admission()`);
    await pool.query(`create table hq202_grant_probe(logical_memory_id uuid,
      logical_grant_id uuid not null,lifecycle text not null,revoked_at timestamptz,
      frozen_at timestamptz,
      owner_user_id uuid,team_id uuid,team_workspace_id uuid,consent_id uuid)`);
    await pool.query(`create trigger hq202_grant_probe_admission before insert or update
      on hq202_grant_probe for each row execute function koed_guard_grant_admission()`);
    const grantId = randomUUID();
    await pool.query(
      `insert into hq202_grant_probe(logical_memory_id,logical_grant_id,
      lifecycle,owner_user_id,team_id,team_workspace_id,consent_id)
      values ($1,$2,'active',$3,$4,$5,$6)`,
      [
        logicalMemoryId,
        grantId,
        owner,
        randomUUID(),
        randomUUID(),
        randomUUID()
      ]
    );
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      const preview = await a.query<{ source_admission_generation: string }>(
        `insert into hq202_preview_probe(logical_memory_id) values ($1)
          returning source_admission_generation`,
        [logicalMemoryId]
      );
      expect(Number(preview.rows[0]!.source_admission_generation)).toBe(0);
      await b.query("begin");
      let holdFinished = false;
      const hold = b
        .query(
          `insert into shared_memory_source_admission(logical_memory_id,owner_user_id)
        values ($1,$2) on conflict do nothing`,
          [logicalMemoryId, owner]
        )
        .then(async () => {
          await b.query(
            `update shared_memory_source_admission set generation=1,
            held_batch_id=$2,held_at=now(),hold_version=1 where logical_memory_id=$1`,
            [logicalMemoryId, randomUUID()]
          );
          holdFinished = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(holdFinished).toBe(false);
      await a.query("commit");
      await hold;
      await b.query("commit");
      await expect(
        pool.query(
          `insert into hq202_preview_probe(logical_memory_id)
        values ($1)`,
          [logicalMemoryId]
        )
      ).rejects.toThrow();
      await expect(
        pool.query(
          `insert into hq202_grant_probe(logical_memory_id,
        logical_grant_id,lifecycle) values ($1,$2,'active')`,
          [logicalMemoryId, randomUUID()]
        )
      ).rejects.toThrow();
      await pool.query(
        `update hq202_grant_probe set revoked_at=now()
        where logical_grant_id=$1`,
        [grantId]
      );
      await expect(
        pool.query(
          `update hq202_grant_probe set revoked_at=null
        where logical_grant_id=$1`,
          [grantId]
        )
      ).rejects.toThrow();
      await pool.query(
        `update shared_memory_source_admission set held_batch_id=null,
        held_at=null,sealed_at=null,hold_version=2 where logical_memory_id=$1`,
        [logicalMemoryId]
      );
      const fresh = await pool.query<{ source_admission_generation: string }>(
        `insert into hq202_preview_probe(logical_memory_id) values ($1)
          returning source_admission_generation`,
        [logicalMemoryId]
      );
      expect(Number(fresh.rows[0]!.source_admission_generation)).toBe(1);
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it("binds real candidate previews and Pending Shares to the original source generation", async () => {
    const logicalMemoryId = randomUUID(),
      sessionId = randomUUID(),
      teamId = randomUUID();
    const workspaceId = randomUUID(),
      revisionId = randomUUID(),
      previewId = randomUUID();
    const deployment = await pool.query<{
      id: string;
    }>(`select id from deployment_identities
      where locality='local' limit 1`);
    await pool.query(
      `insert into teams(id,name,created_by_user_id) values ($1,'Admission test',$2)`,
      [teamId, owner]
    );
    await pool.query(
      `insert into team_workspaces(id,team_id,name) values ($1,$2,'Source')`,
      [workspaceId, teamId]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method)
      values ($1,$2,'codex-cli','api')`,
      [sessionId, owner]
    );
    const seed = await pool.connect();
    try {
      await seed.query("begin");
      await seed.query(
        `insert into logical_memories(id,protocol_logical_id,owner_user_id,
        owner_principal_id,origin_deployment_identity_id,source_kind,logical_key)
        values ($1,$1,$2,$2,$3,'captured_session',$4)`,
        [
          logicalMemoryId,
          owner,
          deployment.rows[0]!.id,
          `captured-session:${sessionId}`
        ]
      );
      await seed.query(
        `insert into captured_session_logical_memories
        (logical_memory_id,source_session_id,owner_principal_id) values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, owner]
      );
      await seed.query(
        `insert into logical_memory_source_revisions
        (id,logical_memory_id,owner_principal_id,source_kind,revision,binding_hash)
        values ($1,$2,$3,'captured_session',1,$4)`,
        [revisionId, logicalMemoryId, owner, "a".repeat(64)]
      );
      await seed.query(
        `insert into captured_session_source_revisions
        (source_revision_id,logical_memory_id,owner_principal_id,source_kind,
          revision,source_cursor,source_session_id)
        values ($1,$2,$3,'captured_session',1,1,$4)`,
        [revisionId, logicalMemoryId, owner, sessionId]
      );
      await seed.query("commit");
    } catch (error) {
      await seed.query("rollback");
      throw error;
    } finally {
      seed.release();
    }
    const preview = async (id: string, hash: string) =>
      pool.query<{ source_admission_generation: string }>(
        `insert into shared_memory_candidate_previews
        (id,preview_hash,authority_source,authority_reference_id,owner_user_id,
         logical_memory_id,source_revision_id,team_id,team_workspace_id,
         source_capabilities,activation_representation,representation,maximum_fidelity,
         include_curated_memory,mode,source_revision,source_hash,redacted_content_hash,
         item_count,candidate_manifest,candidate_manifest_hash,byte_count,
         representation_policy_revision,representation_policy_hash,
         content_policy_version,content_policy_hash,classifier_version,classifier_hash,expires_at)
       values ($1,$2,'device_action_grant',$3,$4,$5,$6,$7,$8,
         array['lcm_rollups']::shared_memory_representation[],'lcm_rollups',
         'lcm_rollups','lcm_rollups',false,'snapshot',1,$9,$9,
         1,'[{}]'::jsonb,$9,1,1,$9,1,$9,1,$9,now()+interval '1 hour')
       returning source_admission_generation`,
        [
          id,
          hash,
          randomUUID(),
          owner,
          logicalMemoryId,
          revisionId,
          teamId,
          workspaceId,
          "b".repeat(64)
        ]
      );
    expect(
      Number(
        (await preview(previewId, "c".repeat(64))).rows[0]!
          .source_admission_generation
      )
    ).toBe(0);
    const pendingId = randomUUID();
    await pool.query(
      `insert into pending_share_operations
      (id,mutation_id,request_hash,logical_grant_id,consent_id,authority_source,
       authority_reference_id,preview_id,preview_hash,preview_revision,
       owner_user_id,logical_memory_id,source_revision_id,team_id,team_workspace_id,
       source_capabilities,activation_representation,representation,maximum_fidelity,
       include_curated_memory,mode,source_revision,source_hash)
      values ($1,$2,$3,$4,$5,'device_action_grant',$6,$7,$8,1,
        $9,$10,$11,$12,$13,array['lcm_rollups']::shared_memory_representation[],
        'lcm_rollups','lcm_rollups','lcm_rollups',false,'snapshot',1,$14)`,
      [
        pendingId,
        randomUUID(),
        "d".repeat(64),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        previewId,
        "c".repeat(64),
        owner,
        logicalMemoryId,
        revisionId,
        teamId,
        workspaceId,
        "b".repeat(64)
      ]
    );
    const bound = await pool.query<{ source_admission_generation: string }>(
      `select source_admission_generation from pending_share_operations where id=$1`,
      [pendingId]
    );
    expect(Number(bound.rows[0]!.source_admission_generation)).toBe(0);
    await pool.query(
      `update shared_memory_source_admission set generation=1,
      held_batch_id=$2,held_at=now(),hold_version=1 where logical_memory_id=$1`,
      [logicalMemoryId, randomUUID()]
    );
    await expect(preview(randomUUID(), "e".repeat(64))).rejects.toThrow();
    await expect(
      pool.query(
        `insert into pending_share_operations
      (mutation_id,request_hash,logical_grant_id,consent_id,authority_source,
       authority_reference_id,preview_id,preview_hash,preview_revision,
       owner_user_id,logical_memory_id,source_revision_id,team_id,team_workspace_id,
       source_capabilities,activation_representation,representation,maximum_fidelity,
       include_curated_memory,mode,source_revision,source_hash)
      select $2,$3,$4,$5,authority_source,$6,preview_id,preview_hash,preview_revision,
        owner_user_id,logical_memory_id,source_revision_id,team_id,team_workspace_id,
        source_capabilities,activation_representation,representation,maximum_fidelity,
        include_curated_memory,mode,source_revision,source_hash
      from pending_share_operations where id=$1`,
        [
          pendingId,
          randomUUID(),
          "e".repeat(64),
          randomUUID(),
          randomUUID(),
          randomUUID()
        ]
      )
    ).rejects.toThrow("Pending Share source admission changed");
    await expect(
      pool.query(
        `insert into team_memory_share_grants
      (logical_memory_id,team_id,team_workspace_id,source_capabilities,
       activation_representation,mode)
      values ($1,$2,$3,array['lcm_rollups']::shared_memory_representation[],
        'lcm_rollups','snapshot')`,
        [logicalMemoryId, teamId, workspaceId]
      )
    ).rejects.toThrow("Share Grant source admission changed");
    await expect(
      pool.query(
        `update pending_share_operations set state='activated'
      where id=$1`,
        [pendingId]
      )
    ).rejects.toThrow();
    await pool.query(
      `update shared_memory_source_admission set held_batch_id=null,
      held_at=null,hold_version=2 where logical_memory_id=$1`,
      [logicalMemoryId]
    );
    const freshPreviewId = randomUUID();
    expect(
      Number(
        (await preview(freshPreviewId, "f".repeat(64))).rows[0]!
          .source_admission_generation
      )
    ).toBe(1);
    await expect(
      pool.query(
        `update pending_share_operations set state='activated'
      where id=$1`,
        [pendingId]
      )
    ).rejects.toThrow();
    await expect(
      pool.query(
        `update pending_share_operations set
      replacement_mutation_id=$2,replacement_request_hash=$3,
      replacement_consent_id=$4,replacement_authority_source='device_action_grant',
      replacement_authority_reference_id=$5,replacement_preview_id=$6,
      replacement_preview_hash=$7,replacement_preview_revision=1,
      replacement_representation='lcm_rollups',replacement_maximum_fidelity='lcm_rollups',
      replacement_include_curated_memory=false,replacement_mode='snapshot',
      replacement_source_revision_id=$8,replacement_source_revision=1,
      replacement_source_hash=$9,replacement_expected_grant_version=1
      where id=$1`,
        [
          pendingId,
          randomUUID(),
          "d".repeat(64),
          randomUUID(),
          randomUUID(),
          freshPreviewId,
          "f".repeat(64),
          revisionId,
          "b".repeat(64)
        ]
      )
    ).rejects.toThrow();
  });

  it("fences new managed work during delete but still queues the confirmed stop", async () => {
    const project = await projects.create(owner, {
      name: "Active execution",
      idempotencyKey: "execution"
    });
    const deviceId = randomUUID(),
      deploymentId = randomUUID(),
      executionId = randomUUID();
    const localProjectId = `local-${randomUUID()}`;
    await pool.query(
      `insert into project_local_contexts
      (owner_user_id,project_id,device_id,local_project_id)
      values ($1,$2,$3,$4)`,
      [owner, project.id, deviceId, localProjectId]
    );
    await pool.query(
      `insert into managed_conversation_executions
      (id,owner_user_id,project_id,state,fencing_token_hash,runner_deployment_id,
       runner_device_id,ai_client_instance_id,model,permission_mode,runner_kind)
      values ($1,$2,$3,'starting',$4,$5,$6,'client','model','supervised','local_device')`,
      [
        executionId,
        owner,
        localProjectId,
        "a".repeat(64),
        deploymentId,
        deviceId
      ]
    );
    await pool.query(
      `update project_local_contexts set association_state='unresolved',project_id=null
      where owner_user_id=$1 and device_id=$2 and local_project_id=$3`,
      [owner, deviceId, localProjectId]
    );
    await expect(
      projects.deletePreview(owner, project.id)
    ).rejects.toBeInstanceOf(ProjectCapabilityError);
    await pool.query(
      `update project_local_contexts set association_state='resolved',project_id=$4
      where owner_user_id=$1 and device_id=$2 and local_project_id=$3`,
      [owner, deviceId, localProjectId, project.id]
    );
    const preview = await projects.deletePreview(owner, project.id);
    expect(preview.activeExecutions.map((item) => item.id)).toEqual([
      executionId
    ]);
    const batchId = randomUUID();
    await projects.beginDelete(owner, project.id, {
      version: project.version,
      batchId,
      executionSetHash: preview.executionSetHash
    });
    const managed = createManagedConversationRepository(pool, {});
    await expect(
      managed.enqueueManagedConversationPrompt(
        { userId: owner },
        {
          executionId,
          executionGeneration: 1,
          idempotencyKey: "blocked-prompt",
          clientUserMessageId: randomUUID(),
          prompt: "Continue work"
        }
      )
    ).rejects.toThrow("Project is unavailable for managed execution");
    const stop = await managed.enqueueManagedConversationControl(
      { userId: owner },
      {
        executionId,
        executionGeneration: 1,
        idempotencyKey: `project-delete:${batchId}:${executionId}`,
        commandKind: "stop"
      }
    );
    expect(stop.commandKind).toBe("stop");
  });

  it("includes a retained inactive child source while admission remains restrictive", async () => {
    const project = await projects.create(owner, {
      name: "Retained source",
      idempotencyKey: "retained"
    });
    const sessionId = randomUUID(),
      priorBatch = randomUUID(),
      teamId = randomUUID();
    const workspaceId = randomUUID(),
      deviceCredentialId = randomUUID();
    const deployment = await pool.query<{
      id: string;
      protocol_deployment_id: string;
    }>(
      `select id,protocol_deployment_id from deployment_identities where locality='local' limit 1`
    );
    const protocolDeploymentId = deployment.rows[0]!.protocol_deployment_id;
    const logicalMemoryId = crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v1",
      sourceDeploymentId: protocolDeploymentId,
      sourceUserId: owner,
      originSessionId: sessionId,
      identity: "logical-memory"
    });
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,
      automatic_personal_project_id) values ($1,$2,'codex-cli','api',$3)`,
      [sessionId, owner, project.id]
    );
    const seed = await pool.connect();
    try {
      await seed.query("begin");
      await seed.query(
        `insert into logical_memories(id,protocol_logical_id,owner_user_id,
        owner_principal_id,origin_deployment_identity_id,source_kind,logical_key,lifecycle)
        values ($1,$1,$2,$2,$3,'captured_session',$4,'revoked')`,
        [
          logicalMemoryId,
          owner,
          deployment.rows[0]!.id,
          `captured-session:${sessionId}`
        ]
      );
      await seed.query(
        `insert into captured_session_logical_memories
        (logical_memory_id,source_session_id,owner_principal_id) values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, owner]
      );
      await seed.query(
        `insert into local_captured_session_logical_memories
        (logical_memory_id,local_session_id,owner_user_id) values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, owner]
      );
      await seed.query("commit");
    } catch (error) {
      await seed.query("rollback");
      throw error;
    } finally {
      seed.release();
    }
    await pool.query(
      `update sessions set personal_deleted_at=now(),invalidated_at=now(),
      trashed_at=now(),delete_batch_id=$2 where id=$1`,
      [sessionId, priorBatch]
    );
    await pool.query(
      `insert into teams(id,name,created_by_user_id) values ($1,'Retained',$2)`,
      [teamId, owner]
    );
    await pool.query(
      `insert into team_workspaces(id,team_id,name) values ($1,$2,'Sources')`,
      [workspaceId, teamId]
    );
    await pool.query(
      `insert into team_memberships(team_id,user_id,role) values ($1,$2,'owner')`,
      [teamId, owner]
    );
    await pool.query(
      `insert into team_workspace_access_grants
      (team_workspace_id,team_id,user_id,access,can_share_owned_memory)
      values ($1,$2,$3,'write',true)`,
      [workspaceId, teamId, owner]
    );
    await pool.query(
      `insert into device_credentials
      (id,owner_user_id,credential_key_id,upstream_backend_id,device_instance_id,
       verifier_kind,verifier_hash,operation_families,metadata)
      values ($1,$2,$3,'team-a',$4,'secret_hash',$5,
        array['share_grant_management'], $6::jsonb)`,
      [
        deviceCredentialId,
        owner,
        `hq202-${randomUUID()}`,
        randomUUID(),
        "a".repeat(64),
        JSON.stringify({ protocolDeploymentId, sourceOwnerPrincipalId: owner })
      ]
    );
    const source = {
      kind: "captured_session" as const,
      sessionId,
      logicalMemoryId
    };
    const shared = createSharedMemoryRepository(pool, {
      resolveTeamEncryptionProvider: async () => {
        throw new Error("unused");
      },
      resolveOwnerPrivateReplicaEncryptionProvider: async () => {
        throw new Error("unused");
      },
      resolvePersonalEncryptionProvider: async () => {
        throw new Error("unused");
      }
    });
    const provenance = {
      source,
      sourceDeploymentProtocolId: protocolDeploymentId,
      sourceOwnerPrincipalId: owner,
      deviceCredentialId
    };
    expect(
      await shared.inspectSourceAdmissionProvenance(
        { userId: owner },
        provenance
      )
    ).toBe(true);
    await expect(
      shared.createSharedMemoryCandidatePreview(
        { userId: owner },
        {
          logicalMemoryId,
          ...provenance,
          teamId,
          teamWorkspaceId: workspaceId,
          sourceCapabilities: ["lcm_rollups"],
          activationRepresentation: "lcm_rollups",
          candidateHash: "b".repeat(64),
          sourceRevision: 1,
          itemCount: 1,
          excludedItemCount: 0,
          manifest: [{ sourceId: randomUUID(), revisionHash: "c".repeat(64) }],
          byteCount: 1,
          mode: "snapshot",
          maximumFidelity: "lcm_rollups",
          includeCuratedMemory: false,
          authority: {
            source: "device_action_grant",
            referenceId: randomUUID(),
            action: "workspace.memory.share_owned"
          }
        }
      )
    ).rejects.toThrow("Candidate source principal is not bound to this User");
    const batchId = randomUUID();
    const held = await shared.changeSourceAdmission(
      { userId: owner },
      {
        ...provenance,
        logicalMemoryId,
        batchId,
        expectedGeneration: 0,
        expectedHoldVersion: 0,
        operation: "prepare"
      }
    );
    expect(held).toMatchObject({
      generation: 1,
      heldBatchId: batchId,
      sealed: false
    });
    const coordinatorRepo = createProjectApiRepository(pool, {
      configuredBackendIds: () => ["team-a"]
    });
    const preview = await coordinatorRepo.deletePreview(owner, project.id);
    await coordinatorRepo.beginDelete(owner, project.id, {
      version: project.version,
      batchId,
      executionSetHash: preview.executionSetHash
    });
    const operation = await coordinatorRepo.getDeleteOperation(
      owner,
      project.id
    );
    expect(operation?.sources).toEqual([
      {
        sessionId,
        logicalMemoryId,
        backends: [{ backendId: "team-a", relationshipIds: [] }]
      }
    ]);
    const seal = await shared.changeSourceAdmission(
      { userId: owner },
      {
        ...provenance,
        logicalMemoryId,
        batchId,
        expectedGeneration: 1,
        expectedHoldVersion: 1,
        operation: "seal"
      }
    );
    await coordinatorRepo.recordBackendAck(owner, project.id, batchId, {
      logicalMemoryId,
      backendId: "team-a",
      generation: seal.generation,
      holdVersion: seal.holdVersion,
      sealed: true
    });
    await coordinatorRepo.markDeleteReady(owner, project.id, batchId);
    await coordinatorRepo.completeDelete(owner, project.id, batchId);
    const retained = await pool.query<{
      delete_batch_id: string;
      trashed_at: string;
    }>(`select delete_batch_id,trashed_at from sessions where id=$1`, [
      sessionId
    ]);
    expect(retained.rows[0]!.delete_batch_id).toBe(priorBatch);
    expect(retained.rows[0]!.trashed_at).toBeTruthy();
  });

  it("retains revoked explicit-share backend history after registry removal", async () => {
    const localOwner = randomUUID();
    const unrelatedOwner = randomUUID();
    await pool.query(`insert into users(id,email) values ($1,$2),($3,$4)`, [
      localOwner,
      `${localOwner}@example.test`,
      unrelatedOwner,
      `${unrelatedOwner}@example.test`
    ]);
    const project = await projects.create(localOwner, {
      name: "Historical share",
      idempotencyKey: "historical-share"
    });
    const sessionId = randomUUID();
    const logicalMemoryId = randomUUID();
    const deployment = await pool.query<{ id: string }>(
      `select id from deployment_identities where locality='local' limit 1`
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,
       automatic_personal_project_id) values ($1,$2,'codex-cli','api',$3)`,
      [sessionId, localOwner, project.id]
    );
    const seed = await pool.connect();
    try {
      await seed.query("begin");
      await seed.query(
        `insert into logical_memories(id,protocol_logical_id,owner_user_id,
         owner_principal_id,origin_deployment_identity_id,source_kind,logical_key)
         values ($1,$1,$2,$2,$3,'captured_session',$4)`,
        [
          logicalMemoryId,
          localOwner,
          deployment.rows[0]!.id,
          `captured-session:${sessionId}`
        ]
      );
      await seed.query(
        `insert into captured_session_logical_memories
         (logical_memory_id,source_session_id,owner_principal_id)
         values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, localOwner]
      );
      await seed.query(
        `insert into local_captured_session_logical_memories
         (logical_memory_id,local_session_id,owner_user_id)
         values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, localOwner]
      );
      await seed.query("commit");
    } catch (error) {
      await seed.query("rollback");
      throw error;
    } finally {
      seed.release();
    }
    await pool.query(
      `insert into collaboration_shared_memory_enrollments
       (backend_id,local_owner_user_id,upstream_user_id,remote_device_id,revoked_at)
       values ('removed-team',$1,$1,$2,now()),('other-team',$3,$3,$4,now())`,
      [localOwner, randomUUID(), unrelatedOwner, randomUUID()]
    );
    const repository = createProjectApiRepository(pool, {
      configuredBackendIds: () => []
    });
    const preview = await repository.deletePreview(localOwner, project.id);
    const batchId = randomUUID();
    await repository.beginDelete(localOwner, project.id, {
      version: project.version,
      batchId,
      executionSetHash: preview.executionSetHash
    });
    const operation = await repository.getDeleteOperation(
      localOwner,
      project.id
    );
    expect(operation?.sources).toEqual([
      {
        sessionId,
        logicalMemoryId,
        backends: [{ backendId: "removed-team", relationshipIds: [] }]
      }
    ]);
    const grant = {
      logicalMemoryId,
      backendId: "removed-team",
      shareGrantId: randomUUID(),
      reviewedGrantVersion: 2
    };
    const [first, overlap] = await Promise.all([
      repository.reserveGrantFreezeReview(
        localOwner,
        project.id,
        batchId,
        grant
      ),
      repository.reserveGrantFreezeReview(
        localOwner,
        project.id,
        batchId,
        grant
      )
    ]);
    expect(overlap).toEqual(first);
    expect(
      await repository.reserveGrantFreezeReview(
        localOwner,
        project.id,
        batchId,
        grant
      )
    ).toEqual(first);
    await expect(
      repository.reserveGrantFreezeReview(localOwner, project.id, batchId, {
        ...grant,
        logicalMemoryId: randomUUID()
      })
    ).rejects.toBeInstanceOf(ProjectConflictError);
    const reviewId = randomUUID();
    await repository.recordGrantFreezeAck(localOwner, project.id, batchId, {
      ...first,
      state: "review_required",
      actionGrantId: reviewId
    });
    expect(
      await repository.reserveGrantFreezeReview(
        localOwner,
        project.id,
        batchId,
        grant
      )
    ).toMatchObject({
      commandRequestId: first.commandRequestId,
      actionGrantId: reviewId
    });
    const next = await repository.reserveGrantFreezeReview(
      localOwner,
      project.id,
      batchId,
      { ...grant, reviewedGrantVersion: 3 }
    );
    expect(next.commandRequestId).not.toBe(first.commandRequestId);
    await expect(
      repository.recordGrantFreezeAck(localOwner, project.id, batchId, {
        ...first,
        state: "review_required",
        actionGrantId: reviewId
      })
    ).rejects.toBeInstanceOf(ProjectConflictError);
    await expect(
      repository.reserveGrantFreezeReview(
        localOwner,
        project.id,
        batchId,
        grant
      )
    ).rejects.toBeInstanceOf(ProjectConflictError);
    const nextReviewId = randomUUID();
    await repository.recordGrantFreezeAck(localOwner, project.id, batchId, {
      ...next,
      state: "review_required",
      actionGrantId: nextReviewId
    });
    await expect(
      repository.recordGrantFreezeAck(localOwner, project.id, batchId, {
        ...next,
        state: "review_required",
        actionGrantId: randomUUID()
      })
    ).rejects.toBeInstanceOf(ProjectConflictError);
    await repository.recordGrantFreezeAck(localOwner, project.id, batchId, {
      ...next,
      state: "frozen",
      actionGrantId: nextReviewId,
      grantVersion: 4
    });
    await repository.recordGrantFreezeAck(localOwner, project.id, batchId, {
      ...next,
      state: "review_required",
      actionGrantId: nextReviewId
    });
    expect(
      (
        await repository.getDeleteOperationByBatch(
          localOwner,
          project.id,
          batchId
        )
      )?.grantFreezeAcks
    ).toEqual([
      expect.objectContaining({
        commandRequestId: next.commandRequestId,
        reviewedGrantVersion: 3,
        grantVersion: 4,
        state: "frozen"
      })
    ]);
    await expect(
      repository.markDeleteReady(localOwner, project.id, batchId)
    ).rejects.toBeInstanceOf(ProjectConflictError);
  });

  it("retains a pending policy issue backend in the Project deletion manifest", async () => {
    const localOwner = randomUUID();
    await pool.query(`insert into users(id,email) values ($1,$2)`, [
      localOwner,
      `${localOwner}@example.test`
    ]);
    const project = await projects.create(localOwner, {
      name: "Pending policy deletion",
      idempotencyKey: "pending-policy-deletion"
    });
    const sessionId = randomUUID();
    const logicalMemoryId = randomUUID();
    const deployment = await pool.query<{ id: string }>(
      `select id from deployment_identities where locality='local' limit 1`
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,source_runtime,capture_method,
        automatic_personal_project_id) values ($1,$2,'codex-cli','api',$3)`,
      [sessionId, localOwner, project.id]
    );
    const seed = await pool.connect();
    try {
      await seed.query("begin");
      await seed.query(
        `insert into logical_memories(id,protocol_logical_id,owner_user_id,
          owner_principal_id,origin_deployment_identity_id,source_kind,logical_key)
         values ($1,$1,$2,$2,$3,'captured_session',$4)`,
        [
          logicalMemoryId,
          localOwner,
          deployment.rows[0]!.id,
          `captured-session:${sessionId}`
        ]
      );
      await seed.query(
        `insert into captured_session_logical_memories
          (logical_memory_id,source_session_id,owner_principal_id)
         values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, localOwner]
      );
      await seed.query(
        `insert into local_captured_session_logical_memories
          (logical_memory_id,local_session_id,owner_user_id) values ($1,$2,$3)`,
        [logicalMemoryId, sessionId, localOwner]
      );
      await seed.query("commit");
    } catch (error) {
      await seed.query("rollback");
      throw error;
    } finally {
      seed.release();
    }
    const linkEpoch = (
      await pool.query<{ share_policy_link_epoch: string }>(
        `select share_policy_link_epoch from projects where id=$1`,
        [project.id]
      )
    ).rows[0]!.share_policy_link_epoch;
    await pool.query(
      `insert into project_share_local_issues
        (owner_user_id,session_id,logical_memory_id,project_id,backend_id,
         workspace_project_id,link_epoch,policy_version,mapping_revision,
         source_revision,state)
       values ($1,$2,$5,$3,'policy-team',$4,$6,1,1,1,'staged')`,
      [
        localOwner,
        sessionId,
        project.id,
        randomUUID(),
        logicalMemoryId,
        linkEpoch
      ]
    );
    const repository = createProjectApiRepository(pool, {
      configuredBackendIds: () => []
    });
    const preview = await repository.deletePreview(localOwner, project.id);
    await repository.beginDelete(localOwner, project.id, {
      version: project.version,
      batchId: randomUUID(),
      executionSetHash: preview.executionSetHash
    });
    const operation = await repository.getDeleteOperation(
      localOwner,
      project.id
    );
    expect(operation?.sources).toEqual([
      {
        sessionId,
        logicalMemoryId,
        backends: [{ backendId: "policy-team", relationshipIds: [] }]
      }
    ]);
  });
});
