import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import {
  claimCuratedGrantSourceWork,
  enqueueCuratedGrantSourceWorkForAssertions,
  enqueueDueCuratedGrantExpiryWork,
  finishCuratedGrantSourceWork,
  registerContinuousCuratedGrantSourceWork
} from "../src/curated-shared-source-work.js";

const databaseUrl = process.env.KOED_HQ713_CURATED_WORK_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("HQ713 durable Curated source work", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("registers the first row, preserves its approval on replay, and fences coalesced retries", async () => {
    const owner = randomUUID();
    const sessionId = randomUUID();
    const logicalMemoryId = randomUUID();
    const deploymentId = randomUUID();
    const pendingShareId = randomUUID();
    const consentId = randomUUID();
    const backendId = `hq713-${randomUUID()}`;
    const upstreamUserId = randomUUID();
    const teamId = randomUUID();
    const teamWorkspaceId = randomUUID();
    const previewHash = "a".repeat(64);
    const initialCommitmentHash = "b".repeat(64);
    await pool.query(
      `insert into users (id,email,display_name) values ($1,$2,'HQ713 owner')`,
      [owner, `hq713-curated-${owner}@example.test`]
    );
    await pool.query(
      `insert into deployment_identities
         (id,protocol_deployment_id,locality,profile)
       values ($1,$2,'local','local_personal')`,
      [deploymentId, randomUUID()]
    );
    await pool.query(
      `insert into sessions
         (id,owner_user_id,visibility,source_runtime,capture_method)
       values ($1,$2,'personal','codex','api')`,
      [sessionId, owner]
    );
    await pool.query(
      `with memory as (
         insert into logical_memories
           (id,owner_user_id,owner_principal_id,origin_deployment_identity_id,
            source_kind,logical_key)
         values ($1,$2,$2,$3,'captured_session',$4)
         returning id
       ), binding as (
         insert into captured_session_logical_memories
           (logical_memory_id,source_session_id,owner_principal_id)
         select id,$5,$2 from memory
       )
       insert into local_captured_session_logical_memories
         (logical_memory_id,local_session_id,owner_user_id)
       select id,$5,$2 from memory`,
      [
        logicalMemoryId,
        owner,
        deploymentId,
        `captured-session:${sessionId}`,
        sessionId
      ]
    );
    await pool.query(
      `insert into collaboration_shared_memory_enrollments
         (backend_id,local_owner_user_id,upstream_user_id,remote_device_id)
       values ($1,$2,$3,$4)`,
      [backendId, owner, upstreamUserId, randomUUID()]
    );
    const binding = {
      backendId,
      localOwnerUserId: owner,
      upstreamUserId,
      originalPendingShareId: pendingShareId,
      consentId,
      previewHash,
      initialCommitmentHash,
      localSessionId: sessionId,
      logicalMemoryId,
      sourceDeploymentProtocolId: randomUUID(),
      sourceOwnerPrincipalId: owner,
      teamId,
      teamWorkspaceId,
      nextExpiryAt: null
    };
    expect(await registerContinuousCuratedGrantSourceWork(pool, binding)).toBe(
      true
    );
    expect(await registerContinuousCuratedGrantSourceWork(pool, binding)).toBe(
      true
    );
    expect(
      await registerContinuousCuratedGrantSourceWork(pool, {
        ...binding,
        consentId: randomUUID()
      })
    ).toBe(false);
    const row = await pool.query<{
      count: string;
      consent_id: string;
      requested_generation: string;
    }>(
      `select count(*)::text as count,max(consent_id::text) as consent_id,
              max(requested_generation)::text as requested_generation
         from collaboration_curated_grant_source_work
        where original_pending_share_id=$1`,
      [pendingShareId]
    );
    expect(row.rows[0]).toMatchObject({
      count: "1",
      consent_id: consentId,
      requested_generation: "1"
    });

    const [first] = await claimCuratedGrantSourceWork(pool);
    expect(first?.originalPendingShareId).toBe(pendingShareId);
    expect(first?.generation).toBe(1);
    const client = await pool.connect();
    try {
      await client.query("begin");
      expect(
        await enqueueCuratedGrantSourceWorkForAssertions(client, owner, [
          randomUUID()
        ])
      ).toBe(1);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    expect(
      await finishCuratedGrantSourceWork(pool, {
        workId: first!.workId,
        leaseToken: first!.leaseToken,
        generation: first!.generation,
        outcome: "delivered"
      })
    ).toBe(true);
    const [second] = await claimCuratedGrantSourceWork(pool);
    expect(second?.generation).toBe(2);
    expect(
      await finishCuratedGrantSourceWork(pool, {
        workId: second!.workId,
        leaseToken: second!.leaseToken,
        generation: second!.generation,
        outcome: "retry"
      })
    ).toBe(true);
    const retried = await pool.query<{
      requested_generation: string;
      delivered_generation: string;
      state: string;
    }>(
      `select requested_generation::text,delivered_generation::text,state
         from collaboration_curated_grant_source_work
        where original_pending_share_id=$1`,
      [pendingShareId]
    );
    expect(retried.rows[0]).toMatchObject({
      requested_generation: "3",
      delivered_generation: "1",
      state: "failed"
    });
    await pool.query(
      `update collaboration_curated_grant_source_work
          set available_at=now()-interval '1 second'
        where original_pending_share_id=$1`,
      [pendingShareId]
    );
    const [third] = await claimCuratedGrantSourceWork(pool);
    expect(third?.generation).toBe(3);
    await pool.query(
      `update collaboration_curated_grant_source_work
          set locked_at=now()-interval '6 minutes'
        where original_pending_share_id=$1`,
      [pendingShareId]
    );
    const [reclaimed] = await claimCuratedGrantSourceWork(pool);
    expect(reclaimed?.generation).toBe(4);
    expect(
      await finishCuratedGrantSourceWork(pool, {
        workId: third!.workId,
        leaseToken: third!.leaseToken,
        generation: third!.generation,
        outcome: "delivered"
      })
    ).toBe(false);
    expect(
      await finishCuratedGrantSourceWork(pool, {
        workId: reclaimed!.workId,
        leaseToken: reclaimed!.leaseToken,
        generation: reclaimed!.generation,
        outcome: "delivered",
        nextExpiryAt: new Date(Date.now() - 1_000).toISOString()
      })
    ).toBe(true);
    expect(await enqueueDueCuratedGrantExpiryWork(pool)).toBe(1);
    const [expired] = await claimCuratedGrantSourceWork(pool);
    expect(expired?.generation).toBe(5);
  });
});
