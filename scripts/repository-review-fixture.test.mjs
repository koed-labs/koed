import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertFixtureEnvironment,
  createFixtureRuntime,
  fixtureMemoryRows,
  fixtureUsers,
  normalizedFixtureSnapshot,
  seedFixture,
  validateFixture
} from "./team-saas-fixture-lib.mjs";

const teamSnapshot = (snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot).filter(
      ([key]) =>
        /^(team_|shared_memory_|source_owner_)/.test(key) ||
        key === "decryptedSharedMemory"
    )
  );

test("Personal source correction preserves materialized Team snapshots and fixture authorization", async (t) => {
  const databaseUrl =
    process.env.KOED_REPOSITORY_REVIEW_FIXTURE_DATABASE_URL?.trim();
  if (!databaseUrl)
    return t.skip(
      "KOED_REPOSITORY_REVIEW_FIXTURE_DATABASE_URL must name a disposable fixture database"
    );
  assertFixtureEnvironment();
  const { createDbPool, runDbMigrations, createMemorySourceRepository } =
    await import("../packages/db/dist/index.js");
  const pool = createDbPool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const eventId = randomUUID();
  const memory = fixtureMemoryRows.find(
    (row) => row.key === "bob-electron-timeline"
  );
  let transactionStarted = false;
  try {
    await runDbMigrations(pool);
    // Use the repo-owned, three-provider synthetic fixture lineage, without real runtime keys.
    const seedRuntime = await createFixtureRuntime(pool, { environment: {} });
    await seedFixture(client, seedRuntime);
    await validateFixture(client, seedRuntime);
    await client.query("begin");
    transactionStarted = true;
    const { createSavepointPool } =
      await import("../packages/db/dist/savepoint-pool.js");
    const testPool = createSavepointPool(client, "source_correction_fixture");
    // Team reads retain their production read-only transaction on a separate connection.
    // normalizedFixtureSnapshot compares all pending table writes through client as well.
    const runtime = seedRuntime;
    const repo = createMemorySourceRepository(testPool, {
      envelopeEncryptionProvider: runtime.personalProvider
    });
    const actor = { userId: fixtureUsers.bob.id };
    const a = {
      kind: "portable_repository",
      key: "gr_fixture_electron",
      root: "/fixture/koed/electron-team-app",
      branch: "main",
      reason: "origin",
      checkoutId: "checkout_fixture_repository_review",
      originatingDeviceId: "fixture_repository_device",
      selectedRemote: "origin",
      anchorDisplay: "example.test/fixture/electron"
    };
    const b = {
      ...a,
      key: "gr_fixture_destination",
      anchorDisplay: "example.test/fixture/destination"
    };
    await client.query(
      "update sessions set repository_assignment_state='recorded',repository_assignment_version=1,repository_automatic_identity=$2,repository_override_identity=null where id=$1",
      [memory.sessionId, a]
    );
    const before = teamSnapshot(
      await normalizedFixtureSnapshot(client, runtime)
    );
    assert.ok(before.decryptedSharedMemory.length > 0);
    assert.ok(before.team_memory_share_grants.length > 0);
    const event = await repo.recordRepositoryChange(actor, {
      id: eventId,
      kind: "anchor_change",
      originatingDeviceId: a.originatingDeviceId,
      checkoutId: a.checkoutId,
      originatingRevision: 1,
      previousIdentity: a,
      targetIdentity: b
    });
    const review = await repo.createRepositoryAssignmentReview(
      actor,
      event.id,
      { includeOverrides: false, includeUnresolved: false }
    );
    assert.deepEqual(
      review.sessions.map((session) => session.id),
      [memory.sessionId]
    );
    // Current corrections select owned recorded context, not a caller-invented anchor.
    await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: b
    });
    const correction = await repo.previewPersonalSourceCorrection(
      actor,
      memory.sessionId,
      {
        axis: "git",
        action: "set",
        repository: b,
        expectedVersion: 1
      }
    );
    await repo.applyPersonalSourceCorrection(
      actor,
      memory.sessionId,
      correction.preview.reviewId,
      { expectedVersion: 1 }
    );
    assert.equal(
      (await repo.getCapturedSession(actor, memory.sessionId))
        .repositoryAssignment.effective.key,
      b.key
    );
    assert.deepEqual(
      teamSnapshot(await normalizedFixtureSnapshot(client, runtime)),
      before
    );
    // This rechecks positive, private, revoked, removed-member, and retained-knowledge truth-sheet outcomes.
    await validateFixture(client, runtime);
    const reset = await repo.previewPersonalSourceCorrection(
      actor,
      memory.sessionId,
      {
        axis: "git",
        action: "reset",
        expectedVersion: 2
      }
    );
    await repo.applyPersonalSourceCorrection(
      actor,
      memory.sessionId,
      reset.preview.reviewId,
      { expectedVersion: 2 }
    );
    assert.equal(
      (await repo.getCapturedSession(actor, memory.sessionId))
        .repositoryAssignment.effective.key,
      a.key
    );
    assert.deepEqual(
      teamSnapshot(await normalizedFixtureSnapshot(client, runtime)),
      before
    );
  } finally {
    try {
      if (transactionStarted) await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  }
});
