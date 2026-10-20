import { randomUUID } from "node:crypto";
import {
  crossIdentitySyncDeterministicUuid,
  curatedWithdrawalManifestHash
} from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createDbPool } from "../src/connection.js";
import { createCuratedMemoryRepository } from "../src/curated-memory-repository.js";
import { runDbMigrations } from "../src/migrate.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Curated classification transaction and ACKs", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let ownerId: string;
  let projectA: string;
  let projectB: string;
  let workItemId: string;
  let assertionId: string;
  const actor = () => ({ userId: ownerId });

  beforeAll(async () => {
    databaseName = `hq301_classification_${randomUUID().replaceAll("-", "")}`;
    admin = createDbPool({ connectionString: databaseUrl! });
    await admin.query(`create database "${databaseName}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = createDbPool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    ownerId = randomUUID();
    projectA = randomUUID();
    projectB = randomUUID();
    assertionId = randomUUID();
    workItemId = randomUUID();
    await pool.query("insert into users(id,email) values($1,$2)", [
      ownerId,
      `${ownerId}@example.test`
    ]);
    await pool.query(
      `insert into projects(id,owner_user_id,name,key) values
         ($1,$3,'Project A',$4),($2,$3,'Project B',$5)`,
      [projectA, projectB, ownerId, `A-${randomUUID()}`, `B-${randomUUID()}`]
    );
    await pool.query(
      `insert into project_work_items (
         id,owner_user_id,project_id,kind,title,goal,origin,
         creation_payload_hash,created_by
       ) values ($1,$2,$3,'todo','Evidence','A real Work Item',
         'manual',$4,$2)`,
      [workItemId, ownerId, projectA, "a".repeat(64)]
    );
    await pool.query(
      `insert into curated_memory_assertions (
         id,owner_user_id,visibility,assertion_text,normalized_assertion,
         sensitivity,confidence,tags,metadata,status,observed_at,
         scope,project_id
       ) values ($1,$2,'personal','Work Item claim','work item claim',
         'normal',90,'{}','{}','current',now(),'project',$3)`,
      [assertionId, ownerId, projectA]
    );
    await pool.query(
      `insert into curated_memory_sources (
         assertion_id,source_type,source_role,project_work_item_id,metadata
       ) values ($1,'project_work_item','primary_evidence',$2,'{}')`,
      [assertionId, workItemId]
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseName) {
      await admin.query(
        `drop database if exists "${databaseName}" with (force)`
      );
      await admin.end();
    }
  });

  it("allows Project to Me for a real Work Item and fences a deleted target Project", async () => {
    const repository = createCuratedMemoryRepository(pool);
    await expect(
      repository.prepareCuratedClassification(actor(), {
        assertionId,
        expectedVersion: 1,
        scope: "project",
        projectId: projectB
      })
    ).rejects.toThrow("source Project does not match");
    const toMe = await repository.prepareCuratedClassification(actor(), {
      assertionId,
      expectedVersion: 1,
      scope: "me"
    });
    expect(toMe).toMatchObject({ state: "pending", manifest: [] });
    const beforeCommit = await pool.query<{ scope: string }>(
      "select scope from curated_memory_assertions where id=$1",
      [assertionId]
    );
    expect(beforeCommit.rows[0]?.scope).toBe("project");
    expect(
      await repository.commitCuratedClassification(actor(), toMe.id)
    ).toMatchObject({
      state: "complete"
    });
    const personal = await pool.query<{
      scope: string;
      project_id: string | null;
      classification_version: number;
    }>(
      "select scope,project_id,classification_version from curated_memory_assertions where id=$1",
      [assertionId]
    );
    expect(personal.rows[0]).toEqual({
      scope: "me",
      project_id: null,
      classification_version: 2
    });
    const backToProject = await repository.prepareCuratedClassification(
      actor(),
      {
        assertionId,
        expectedVersion: 2,
        scope: "project",
        projectId: projectA
      }
    );
    await pool.query(
      "update projects set deletion_phase='preparing',delete_batch_id=$2 where id=$1",
      [projectA, randomUUID()]
    );
    await expect(
      repository.commitCuratedClassification(actor(), backToProject.id)
    ).rejects.toThrow("Project is unavailable");
    expect(personal.rows[0]?.scope).toBe("me");
    await pool.query(
      "update projects set deletion_phase=null,delete_batch_id=null where id=$1",
      [projectA]
    );
    expect(
      await repository.commitCuratedClassification(actor(), backToProject.id)
    ).toMatchObject({ state: "complete" });
  });

  it("requires all immutable backend ACKs before Personal classification commits", async () => {
    const repository = createCuratedMemoryRepository(pool);
    const deploymentId = randomUUID();
    const protocolDeploymentId = randomUUID();
    const sourceSessionId = randomUUID();
    const logicalMemoryId = randomUUID();
    const pendingAssertionId = randomUUID();
    await pool.query(
      `insert into deployment_identities (
         id,protocol_deployment_id,locality,profile
       ) values ($1,$2,'local','local_personal')`,
      [deploymentId, protocolDeploymentId]
    );
    await pool.query(
      `insert into sessions(id,owner_user_id,visibility,source_runtime,capture_method)
       values ($1,$2,'personal','codex','transcript')`,
      [sourceSessionId, ownerId]
    );
    const bindingClient = await pool.connect();
    try {
      await bindingClient.query("begin");
      await bindingClient.query(
        `insert into logical_memories (
         id,owner_user_id,owner_principal_id,origin_deployment_identity_id,
         source_kind,logical_key
       ) values ($1,$2,$2,$3,'captured_session',$4)`,
        [logicalMemoryId, ownerId, deploymentId, `hq301-${randomUUID()}`]
      );
      await bindingClient.query(
        `insert into captured_session_logical_memories (
         logical_memory_id,source_session_id,owner_principal_id
       ) values ($1,$2,$3)`,
        [logicalMemoryId, sourceSessionId, ownerId]
      );
      await bindingClient.query(
        `insert into local_captured_session_logical_memories (
         logical_memory_id,local_session_id,owner_user_id
       ) values ($1,$2,$3)`,
        [logicalMemoryId, sourceSessionId, ownerId]
      );
      await bindingClient.query("commit");
    } catch (error) {
      await bindingClient.query("rollback");
      throw error;
    } finally {
      bindingClient.release();
    }
    for (const backendId of ["backend_a", "backend_b"]) {
      const enrollment = await pool.query<{ id: string }>(
        `insert into collaboration_shared_memory_enrollments (
           backend_id,local_owner_user_id,upstream_user_id,remote_device_id
         ) values ($1,$2,$3,$4) returning id`,
        [backendId, ownerId, randomUUID(), randomUUID()]
      );
      await pool.query(
        `insert into collaboration_shared_memory_companion_bindings (
           enrollment_id,share_grant_id,logical_memory_id,team_id,
           team_workspace_id,companion_thread_id,shared_session_id
         ) values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          enrollment.rows[0]!.id,
          randomUUID(),
          logicalMemoryId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID()
        ]
      );
    }
    await pool.query(
      `insert into curated_memory_assertions (
         id,owner_user_id,visibility,assertion_text,normalized_assertion,
         sensitivity,confidence,tags,metadata,status,observed_at
       ) values ($1,$2,'personal','Remote claim','remote claim',
         'normal',90,'{}','{}','current',now())`,
      [pendingAssertionId, ownerId]
    );
    const operation = await repository.prepareCuratedClassification(actor(), {
      assertionId: pendingAssertionId,
      expectedVersion: 1,
      scope: "me"
    });
    expect(operation.manifest).toHaveLength(2);
    await expect(
      repository.commitCuratedClassification(actor(), operation.id)
    ).rejects.toThrow("withdrawal is pending");
    for (const [index, group] of operation.manifest.entries()) {
      const mutationId = crossIdentitySyncDeterministicUuid({
        protocol: "koed.curated-withdrawal-group/v1",
        operationId: operation.id,
        backendId: group.backendId,
        sourceLogicalMemoryId: group.source.logicalMemoryId
      });
      const receiptHash = curatedWithdrawalManifestHash({
        mutationId,
        assertionId: pendingAssertionId,
        source: group.source,
        sourceDeploymentProtocolId: protocolDeploymentId,
        sourceOwnerPrincipalId: ownerId,
        classificationVersion: 1,
        items: []
      });
      await expect(
        repository.recordCuratedClassificationAck(
          actor(),
          operation.id,
          group.backendId,
          logicalMemoryId,
          { mutationId, manifestHash: "f".repeat(64), appliedVersion: 1 },
          "f".repeat(64)
        )
      ).rejects.toThrow("receipt conflicts");
      const recorded = await repository.recordCuratedClassificationAck(
        actor(),
        operation.id,
        group.backendId,
        logicalMemoryId,
        { mutationId, manifestHash: receiptHash, appliedVersion: 1 },
        receiptHash
      );
      expect(recorded.backendAcks).toHaveLength(index + 1);
      if (index === 0) {
        await expect(
          repository.commitCuratedClassification(actor(), operation.id)
        ).rejects.toThrow("withdrawal is pending");
      }
    }
    await pool.query(`
      create function hq301_injected_personal_commit_failure()
      returns trigger language plpgsql as $$
      begin raise exception 'injected Personal commit failure'; end $$
    `);
    await pool.query(`
      create trigger hq301_injected_personal_commit_failure
      after update of scope on curated_memory_assertions
      for each row when (new.id = '${pendingAssertionId}'::uuid)
      execute function hq301_injected_personal_commit_failure()
    `);
    await expect(
      repository.commitCuratedClassification(actor(), operation.id)
    ).rejects.toThrow("injected Personal commit failure");
    const afterFailure = await pool.query<{
      state: string;
      scope: string;
      fence_count: string;
    }>(
      `select operation.state,assertion.scope,
              (select count(*)::text from team_memory_curated_assertion_fences
                where logical_memory_id=$2 and assertion_id=$3) as fence_count
         from curated_memory_classification_operations operation
         join curated_memory_assertions assertion on assertion.id=operation.assertion_id
        where operation.id=$1`,
      [operation.id, logicalMemoryId, pendingAssertionId]
    );
    expect(afterFailure.rows[0]).toEqual({
      state: "ready",
      scope: "unscoped",
      fence_count: "0"
    });
    await pool.query(
      "drop trigger hq301_injected_personal_commit_failure on curated_memory_assertions"
    );
    await pool.query("drop function hq301_injected_personal_commit_failure()");
    expect(
      await repository.commitCuratedClassification(actor(), operation.id)
    ).toMatchObject({
      state: "complete"
    });
    const fence = await pool.query<{
      classification_version: number;
    }>(
      `select classification_version from team_memory_curated_assertion_fences
        where logical_memory_id=$1 and assertion_id=$2`,
      [logicalMemoryId, pendingAssertionId]
    );
    expect(fence.rows[0]?.classification_version).toBe(1);
  });

  it("keeps retained Note and Work Item evidence in Personal recall through Project trash", async () => {
    const repository = createCuratedMemoryRepository(pool);
    const noteId = randomUUID();
    const noteRevisionId = randomUUID();
    const sourceId = randomUUID();
    const sourceRevisionId = randomUUID();
    const noteAssertionId = randomUUID();
    const memoryEventId = randomUUID();
    await pool.query(
      `insert into memory_events (
         id,owner_user_id,visibility,event_type,capture_method
       ) values ($1,$2,'personal','captured','api')`,
      [memoryEventId, ownerId]
    );
    await pool.query(
      `insert into personal_notes (
         id,owner_user_id,idempotency_key_hash,request_hash
       ) values ($1,$2,$3,$4)`,
      [noteId, ownerId, "a".repeat(64), "b".repeat(64)]
    );
    await pool.query(
      `insert into personal_note_revisions (
         id,note_id,owner_user_id,revision,idempotency_key_hash,
         request_hash,content_hash,memory_event_id,projection_state,projected_at
       ) values ($1,$2,$3,1,$4,$5,$6,$7,'available',now())`,
      [
        noteRevisionId,
        noteId,
        ownerId,
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        memoryEventId
      ]
    );
    await pool.query(
      `insert into project_sources (
         id,owner_user_id,project_id,kind,name,status,added_by,current_revision_id
       ) values ($1,$2,$3,'doc','Retained Note','ready',$2,$4)`,
      [sourceId, ownerId, projectA, noteRevisionId]
    );
    await pool.query(
      `insert into project_source_revisions (
         id,owner_user_id,source_id,revision,idempotency_key_hash,
         content_hash,byte_length,media_type,state,note_revision_id
       ) values ($1,$2,$3,1,$4,$5,12,'text/plain','ready',$6)`,
      [
        sourceRevisionId,
        ownerId,
        sourceId,
        "f".repeat(64),
        "0".repeat(64),
        noteRevisionId
      ]
    );
    await pool.query(
      `insert into curated_memory_assertions (
         id,owner_user_id,visibility,assertion_text,normalized_assertion,
         sensitivity,confidence,tags,metadata,status,observed_at
       ) values ($1,$2,'personal','Retained Note claim','retained note claim',
         'normal',90,'{}','{}','current',now())`,
      [noteAssertionId, ownerId]
    );
    await pool.query(
      `insert into curated_memory_sources (
         assertion_id,source_type,source_role,project_source_revision_id,metadata
       ) values ($1,'project_source_note_revision','primary_evidence',$2,'{}')`,
      [noteAssertionId, sourceRevisionId]
    );
    const recall = (query: string) =>
      repository.searchCuratedMemoryAssertions(actor(), { query });
    expect(
      (await recall("Retained Note claim")).map((row) => row.id)
    ).toContain(noteAssertionId);
    expect((await recall("Work Item claim")).map((row) => row.id)).toContain(
      assertionId
    );
    await pool.query(
      `update project_sources set deleted_at=now(),delete_batch_id=$2
        where id=$1`,
      [sourceId, randomUUID()]
    );
    await pool.query(
      `update project_work_items set deleted_at=now(),delete_batch_id=$2
        where id=$1`,
      [workItemId, randomUUID()]
    );
    await pool.query(
      `update projects set lifecycle='deleted',deleted_at=now(),
         deletion_phase='complete',delete_batch_id=$2 where id=$1`,
      [projectA, randomUUID()]
    );
    expect(
      (await recall("Retained Note claim")).map((row) => row.id)
    ).toContain(noteAssertionId);
    expect((await recall("Work Item claim")).map((row) => row.id)).toContain(
      assertionId
    );
    await pool.query(
      "update personal_note_revisions set forgotten_at=now() where id=$1",
      [noteRevisionId]
    );
    expect(
      (await recall("Retained Note claim")).map((row) => row.id)
    ).not.toContain(noteAssertionId);
    await repository.reconcileCuratedMemoryLifecycle(actor());
    const status = await pool.query<{ status: string }>(
      "select status from curated_memory_assertions where id=$1",
      [noteAssertionId]
    );
    expect(status.rows[0]?.status).toBe("suppressed");
  });
});
