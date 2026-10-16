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

test("Personal bulk repository assignment preserves materialized Team snapshots and fixture authorization", async (t) => {
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
  let original;
  try {
    await runDbMigrations(pool);
    // Use the repo-owned, three-provider synthetic fixture lineage, without real runtime keys.
    const runtime = await createFixtureRuntime(pool, { environment: {} });
    await seedFixture(client, runtime);
    await validateFixture(client, runtime);
    const repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: runtime.personalProvider
    });
    const actor = { userId: fixtureUsers.bob.id };
    original = (
      await client.query(
        "select repository_assignment_state,repository_assignment_version,repository_automatic_identity,repository_override_identity from sessions where id=$1",
        [memory.sessionId]
      )
    ).rows[0];
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
    await repo.executeRepositoryAssignmentReview(actor, review.id, {
      action: "apply",
      expectedRevision: event.revision,
      sessionIds: [memory.sessionId]
    });
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
    await repo.resetCapturedSessionProject(actor, memory.sessionId, 2);
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
    if (original)
      await client.query(
        "update sessions set repository_assignment_state=$2,repository_assignment_version=$3,repository_automatic_identity=$4,repository_override_identity=$5,project_override_id=null,project_override_name=null,project_override_path=null,project_override_at=null,project_override_by_user_id=null where id=$1",
        [
          memory.sessionId,
          original.repository_assignment_state,
          original.repository_assignment_version,
          original.repository_automatic_identity,
          original.repository_override_identity
        ]
      );
    await client.query(
      "delete from repository_assignment_reviews where event_id=$1",
      [eventId]
    );
    await client.query("delete from repository_change_events where id=$1", [
      eventId
    ]);
    client.release();
    await pool.end();
  }
});
