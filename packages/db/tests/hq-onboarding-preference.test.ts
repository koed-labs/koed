import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/connection.js";
import { createCuratedMemoryRepository } from "../src/curated-memory-repository.js";
import { runDbMigrations } from "../src/migrate.js";

const databaseUrl = process.env.KOED_HQ506_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("HQ onboarding preference evidence", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let ownerId: string;
  let otherId: string;
  let noteId: string;
  let eventId: string;

  beforeAll(async () => {
    databaseName = `hq506_preference_${randomUUID().replaceAll("-", "")}`;
    admin = createDbPool({ connectionString: databaseUrl! });
    await admin.query(`create database "${databaseName}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = createDbPool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    ownerId = randomUUID();
    otherId = randomUUID();
    noteId = randomUUID();
    eventId = randomUUID();
    await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
      ownerId,
      `${ownerId}@example.test`,
      otherId,
      `${otherId}@example.test`
    ]);
    await pool.query(
      `insert into memory_events(id,owner_user_id,visibility,event_type,capture_method)
       values($1,$2,'personal','captured','api')`,
      [eventId, ownerId]
    );
    await pool.query(
      `insert into personal_notes(id,owner_user_id,idempotency_key_hash,request_hash)
       values($1,$2,$3,$4)`,
      [noteId, ownerId, "a".repeat(64), "b".repeat(64)]
    );
    await pool.query(
      `insert into personal_note_revisions(
         id,note_id,owner_user_id,revision,idempotency_key_hash,request_hash,
         content_hash,memory_event_id,projection_state,projected_at
       ) values($1,$2,$3,1,$4,$5,$6,$7,'available',now())`,
      [
        randomUUID(),
        noteId,
        ownerId,
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        eventId
      ]
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseName) {
      await admin.query(
        `drop database if exists "${databaseName}" with (force)`
      );
      await admin.end();
    }
  });

  it("serializes parallel retries as one pending Me preference and creates no assertion", async () => {
    const repository = createCuratedMemoryRepository(pool);
    const input = {
      noteId,
      memoryEventId: eventId,
      claim: "I mostly use Koed for studying."
    };
    const proposals = await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.createOnboardingPreferenceProposal(
          { userId: ownerId },
          input
        )
      )
    );
    expect(new Set(proposals.map((proposal) => proposal.id)).size).toBe(1);
    expect(proposals[0]).toMatchObject({
      proposedClaim: input.claim,
      scopeHint: "me",
      kindHint: "preference",
      operation: "store",
      status: "pending"
    });
    const rows = await pool.query<{ count: number }>(
      "select count(*)::integer as count from curated_memory_proposals where owner_user_id=$1",
      [ownerId]
    );
    expect(rows.rows[0]?.count).toBe(1);
    const assertions = await pool.query<{ count: number }>(
      "select count(*)::integer as count from curated_memory_assertions where owner_user_id=$1",
      [ownerId]
    );
    expect(assertions.rows[0]?.count).toBe(0);
    await expect(
      repository.createOnboardingPreferenceProposal(
        { userId: ownerId },
        {
          ...input,
          claim: "I mostly use Koed for building software."
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a foreign owner, wrong event, and superseded current Note", async () => {
    const repository = createCuratedMemoryRepository(pool);
    const input = {
      noteId,
      memoryEventId: eventId,
      claim: "I mostly use Koed for studying."
    };
    await expect(
      repository.createOnboardingPreferenceProposal({ userId: otherId }, input)
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      repository.createOnboardingPreferenceProposal(
        { userId: ownerId },
        { ...input, memoryEventId: randomUUID() }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await pool.query(
      "update personal_note_revisions set forgotten_at=now() where note_id=$1",
      [noteId]
    );
    await expect(
      repository.createOnboardingPreferenceProposal({ userId: ownerId }, input)
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
