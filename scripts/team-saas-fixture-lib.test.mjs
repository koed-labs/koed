import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXTURE_VERSION,
  fixtureMemoryRows,
  fixtureTeam,
  fixtureUserEmails,
  fixtureUserIds,
  fixtureUsers,
  fixtureWorkspaceAccess,
  fixtureWorkspaceIds,
  fixtureWorkspaces,
  resetFixture,
  seedFixture,
  validateFixture
} from "./team-saas-fixture-lib.mjs";

test("Team SaaS fixture definition is deterministic and realistic", () => {
  assert.equal(FIXTURE_VERSION, "team-saas-fixture-v1");
  assert.equal(fixtureTeam.name, "Koed Fixture Team");
  assert.deepEqual(Object.keys(fixtureUsers).sort(), [
    "alice",
    "bob",
    "carol",
    "david"
  ]);
  assert.deepEqual(Object.keys(fixtureWorkspaces).sort(), [
    "cloud",
    "electron",
    "ingestion"
  ]);
  assert.equal(new Set(fixtureUserIds).size, fixtureUserIds.length);
  assert.equal(new Set(fixtureUserEmails).size, fixtureUserEmails.length);
  assert.equal(new Set(fixtureWorkspaceIds).size, fixtureWorkspaceIds.length);
  assert.equal(
    new Set(fixtureMemoryRows.map((memory) => memory.idempotencyKey)).size,
    fixtureMemoryRows.length
  );
  assert.equal(
    new Set(fixtureMemoryRows.map((memory) => memory.sourceHash)).size,
    fixtureMemoryRows.length
  );
});

test("Team SaaS fixture covers required access states", () => {
  const shareStates = new Set(
    fixtureMemoryRows.map((memory) => memory.shareState)
  );
  assert.ok(shareStates.has("active"));
  assert.ok(shareStates.has("private"));
  assert.ok(shareStates.has("revoked"));
  assert.ok(shareStates.has("personal_deleted_retained"));

  assert.ok(
    fixtureMemoryRows.some(
      (memory) => memory.key === "bob-cloud-removed-member"
    )
  );
  assert.ok(
    fixtureWorkspaceAccess.some(
      ([workspace, user, access]) =>
        workspace === "cloud" && user === "bob" && access === "disabled"
    )
  );
});

test("Team SaaS fixture can seed and validate a live database", async (t) => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    t.skip("DATABASE_URL is not set");
    return;
  }

  const { createRequire } = await import("node:module");
  const { resolve } = await import("node:path");
  const requireFromDbPackage = createRequire(
    resolve("packages/db/package.json")
  );
  const pg = requireFromDbPackage("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const schema = await client.query(
      "select to_regclass('public.semantic_memory_rebuild_jobs') as table_name"
    );
    if (!schema.rows[0]?.table_name) {
      t.skip("Koed database schema is not migrated");
      return;
    }

    await seedFixture(client);
    const result = await validateFixture(client);
    assert.equal(result.users, 4);
    assert.equal(result.workspaces, 3);
    assert.equal(result.memories, fixtureMemoryRows.length);
  } finally {
    await resetFixture(client).catch(() => {});
    await client.end();
  }
});
