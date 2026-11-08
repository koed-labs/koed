import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigrationBaseline } from "./fixtures/migration-baseline.js";
import { runDbMigrations } from "../src/migrate.js";

const url = process.env.PEER_ONLINE_MEMBERSHIP_TEST_DATABASE_URL;
const legacyRows = [
  {
    groupId: "legacy-group-a",
    sessionKey: "legacy-session-a1",
    bindingHash: "binding-hash-a1",
    binding: '{"legacy":"binding-a1"}',
    deletionHash: "deletion-hash-a1",
    deletion: '{"legacy":"tombstone-a1"}'
  },
  {
    groupId: "legacy-group-a",
    sessionKey: "legacy-session-a2",
    bindingHash: "binding-hash-a2",
    binding: '{"legacy":"binding-a2"}',
    deletionHash: "deletion-hash-a2",
    deletion: '{"legacy":"tombstone-a2"}'
  },
  {
    groupId: "legacy-group-b",
    sessionKey: "legacy-session-b1",
    bindingHash: "binding-hash-b1",
    binding: '{"legacy":"binding-b1"}',
    deletionHash: "deletion-hash-b1",
    deletion: '{"legacy":"tombstone-b1"}'
  }
];

async function seedLegacyRows(pool: pg.Pool) {
  await pool.query(
    `insert into peer_online_membership_groups
      (group_id, genesis_hash, record_count, conflict, incomplete)
     values ($1, 'genesis-a', 1, false, false),
            ($2, 'genesis-b', 1, false, false)`,
    ["legacy-group-a", "legacy-group-b"]
  );
  for (const row of legacyRows)
    await pool.query(
      `insert into peer_online_sessions
        (group_id, session_key, binding_hash, binding, deletion_hash, deletion)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        row.groupId,
        row.sessionKey,
        row.bindingHash,
        row.binding,
        row.deletionHash,
        row.deletion
      ]
    );
  const row = legacyRows[0]!;
  await pool.query(
    `update peer_online_sessions
     set checkpoint_sequence='4', checkpoint_hash='legacy-checkpoint'
     where group_id=$1 and session_key=$2`,
    [row.groupId, row.sessionKey]
  );
  await pool.query(
    `insert into peer_online_checkpoints
      (group_id, session_key, sequence, hash, envelope, payload)
     values ($1, $2, '4', 'legacy-checkpoint', 'legacy-envelope', 'legacy-payload')`,
    [row.groupId, row.sessionKey]
  );
}

async function expectSqlFailure(
  pool: pg.Pool,
  query: string,
  params: string[],
  message: string
) {
  let error: unknown;
  try {
    await pool.query(query, params);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "23514", message });
}

async function assertLegacyFloors(pool: pg.Pool) {
  const actual = await pool.query(
    `select group_id as "groupId", session_key as "sessionKey",
            binding_hash as "bindingHash", binding,
            deletion_hash as "deletionHash", deletion,
            checkpoint_sequence as "checkpointSequence",
            checkpoint_hash as "checkpointHash"
     from peer_online_sessions order by group_id, session_key`
  );
  expect(actual.rows).toEqual(
    legacyRows.map((row) => ({
      ...row,
      checkpointSequence: null,
      checkpointHash: null
    }))
  );
  const checkpoints = await pool.query(
    "select 1 from peer_online_checkpoints where group_id=$1 and session_key=$2",
    [legacyRows[0]!.groupId, legacyRows[0]!.sessionKey]
  );
  expect(checkpoints.rowCount).toBe(0);
}

async function assertLegacyFloorGuards(pool: pg.Pool) {
  const row = legacyRows[0]!;
  const params = [row.groupId, row.sessionKey];
  const immutable = "peer online deletion floor is immutable";
  const blocked = "peer online checkpoint blocked by deletion floor";
  const operations = [
    {
      name: "replace floor",
      query:
        "update peer_online_sessions set deletion_hash='changed' where group_id=$1 and session_key=$2",
      message: immutable
    },
    {
      name: "clear floor",
      query:
        "update peer_online_sessions set deletion_hash=null, deletion=null where group_id=$1 and session_key=$2",
      message: immutable
    },
    {
      name: "update unrelated session state",
      query:
        "update peer_online_sessions set checkpoint_sequence='0' where group_id=$1 and session_key=$2",
      message: immutable
    },
    {
      name: "delete floor",
      query:
        "delete from peer_online_sessions where group_id=$1 and session_key=$2",
      message: immutable
    },
    {
      name: "insert checkpoint",
      query: `insert into peer_online_checkpoints
        (group_id, session_key, sequence, hash, envelope, payload)
        values ($1, $2, '0', 'blocked', 'blocked', 'blocked')`,
      message: blocked
    }
  ];
  for (const operation of operations)
    await expectSqlFailure(pool, operation.query, params, operation.message);
  await expectSqlFailure(
    pool,
    "truncate table peer_online_sessions cascade",
    [],
    immutable
  );
  await expectSqlFailure(
    pool,
    "truncate table peer_online_checkpoints",
    [],
    "peer online checkpoint history is immutable"
  );
}

describe.skipIf(!url)("peer online deletion floor migration", () => {
  const name = `koed_floor_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  const target = new URL(url ?? "postgresql://localhost/postgres");
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString() });
  let created = false;
  let disposeBaseline: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await admin.query(`create database "${name}"`);
    created = true;
    const baseline = await createMigrationBaseline("0060_smooth_ultimates");
    disposeBaseline = baseline.dispose;
    await baseline.apply(pool);
    await seedLegacyRows(pool);
    await runDbMigrations(pool, { migrationsFolder: baseline.source });
  }, 120_000);

  afterAll(async () => {
    try {
      await pool.end();
    } finally {
      try {
        if (created) await admin.query(`drop database "${name}" with (force)`);
      } finally {
        try {
          await admin.end();
        } finally {
          await disposeBaseline?.();
        }
      }
    }
  });

  it("preserves legacy tombstones and guards their floors", async () => {
    await assertLegacyFloors(pool);
    await assertLegacyFloorGuards(pool);
  });
});
