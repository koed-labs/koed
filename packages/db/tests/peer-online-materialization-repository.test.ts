import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbMigrations } from "../src/migrate.js";
import { materializePeerOnlineCheckpoint } from "../src/peer-online-materialization-repository.js";

const url = process.env.PEER_ONLINE_MEMBERSHIP_TEST_DATABASE_URL;
describe.skipIf(!url)("peer online materialization", () => {
  const name = `koed_materialize_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  const target = new URL(url ?? "postgresql://localhost/postgres");
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString() });
  let created = false;
  beforeAll(async () => {
    await admin.query(`create database "${name}"`);
    created = true;
    await runDbMigrations(pool);
  }, 120000);
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`drop database "${name}" with (force)`);
    await admin.end();
  }, 60000);
  it("rejects direct materialization while restore-quarantined", async () => {
    const owner = randomUUID();
    const group = randomUUID();
    const key = randomUUID();
    await pool.query("insert into users(id,email) values ($1,$2)", [
      owner,
      `${owner}@test.invalid`
    ]);
    await pool.query(
      "insert into peer_online_membership_groups values ($1,'genesis',1,false,false,null)",
      [group]
    );
    await pool.query(
      "insert into peer_online_restore_quarantines(group_id,genesis_hash,reason) values($1,'genesis','restore detected')",
      [group]
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(
        materializePeerOnlineCheckpoint(pool, client, {
          ownerUserId: owner,
          groupId: group,
          sessionKey: key,
          bindingHash: "binding",
          checkpointSequence: "0",
          checkpointHash: "hash",
          sourceSession: {
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            externalSessionId: key
          },
          items: []
        })
      ).rejects.toThrow("peer online group quarantined after restore");
      await client.query("rollback");
    } finally {
      client.release();
    }
    const replicas = await pool.query(
      "select 1 from peer_online_replicas where group_id=$1",
      [group]
    );
    expect(replicas.rowCount).toBe(0);
  });

  it("atomically creates a read-only replica and source items", async () => {
    const owner = randomUUID(),
      group = randomUUID(),
      key = randomUUID();
    await pool.query("insert into users(id,email) values ($1,$2)", [
      owner,
      `${owner}@test.invalid`
    ]);
    await pool.query(
      "insert into peer_online_membership_groups values ($1,'genesis',1,false,false,null)",
      [group]
    );
    const client = await pool.connect();
    const input = {
      ownerUserId: owner,
      groupId: group,
      sessionKey: key,
      bindingHash: "binding",
      checkpointSequence: "0",
      checkpointHash: "hash",
      sourceSession: {
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        externalSessionId: key
      },
      items: [
        {
          sourceKind: "codex",
          sourceAdapterVersion: "codex-transcript-v1",
          sourceTransport: "pds_relay",
          sourceRecordType: "message",
          sourceSequence: 0,
          rawJson: { role: "user", content: "hello" },
          sourceHash: "itemhash",
          idempotencyKey: `item-${key}`
        }
      ]
    };
    const seed = async () => {
      await client.query(
        "insert into peer_online_sessions(group_id,session_key,binding_hash,binding,checkpoint_sequence,checkpoint_hash) values ($1,$2,'binding','binding','0','hash')",
        [group, key]
      );
      await client.query(
        "insert into peer_online_checkpoints values ($1,$2,'0','hash','envelope','payload')",
        [group, key]
      );
    };
    try {
      await client.query("begin");
      await seed();
      const first = await materializePeerOnlineCheckpoint(pool, client, input);
      expect(
        (
          await pool.query("select id from sessions where id=$1", [
            first.sessionId
          ])
        ).rowCount
      ).toBe(0);
      await client.query("rollback");
      await client.query("begin");
      await seed();
      const result = await materializePeerOnlineCheckpoint(pool, client, input);
      await client.query("commit");
      expect(
        (
          await pool.query("select id from sessions where id=$1", [
            result.sessionId
          ])
        ).rowCount
      ).toBe(1);
      await expect(
        pool.query("delete from sessions where id=$1", [result.sessionId])
      ).rejects.toThrow(/read-only/);
      await expect(
        pool.query("insert into conversation_items(session_id) values ($1)", [
          result.sessionId
        ])
      ).rejects.toThrow(/read-only/);
      await expect(
        pool.query(
          "insert into pds_session_closures(source_session_id) values ($1)",
          [result.sessionId]
        )
      ).rejects.toThrow(/cannot become origin writers/);
      await expect(
        pool.query(
          "update conversation_items set source_hash='changed' where session_id=$1",
          [result.sessionId]
        )
      ).rejects.toThrow(/read-only/);
      await expect(
        pool.query(
          "update sessions set source_fingerprint='changed' where id=$1",
          [result.sessionId]
        )
      ).rejects.toThrow(/read-only/);
      await client.query("begin");
      await client.query(
        "update peer_online_sessions set checkpoint_sequence='1',checkpoint_hash='next' where group_id=$1 and session_key=$2",
        [group, key]
      );
      await client.query(
        "insert into peer_online_checkpoints values ($1,$2,'1','next','envelope','payload')",
        [group, key]
      );
      await expect(
        materializePeerOnlineCheckpoint(pool, client, {
          ...input,
          checkpointSequence: "1",
          checkpointHash: "next",
          items: [{ ...input.items[0]!, sourceHash: "tampered" }]
        })
      ).rejects.toThrow(/source history changed/);
      await client.query("rollback");
      expect(
        (
          await pool.query<Record<string, unknown>>(
            "select checkpoint_sequence from peer_online_sessions where group_id=$1 and session_key=$2",
            [group, key]
          )
        ).rows[0]!.checkpoint_sequence
      ).toBe("0");
      await client.query("begin");
      await client.query(
        "update peer_online_sessions set checkpoint_sequence='1',checkpoint_hash='next' where group_id=$1 and session_key=$2",
        [group, key]
      );
      await client.query(
        "insert into peer_online_checkpoints values ($1,$2,'1','next','envelope','payload')",
        [group, key]
      );
      const secondItem = {
        ...input.items[0]!,
        sourceSequence: 1,
        sourceHash: "second",
        idempotencyKey: `second-${key}`,
        rawJson: { role: "user", content: "second" }
      };
      await materializePeerOnlineCheckpoint(pool, client, {
        ...input,
        checkpointSequence: "1",
        checkpointHash: "next",
        items: [...input.items, secondItem]
      });
      await client.query("commit");
      expect(
        (
          await pool.query<Record<string, unknown>>(
            "select count(*)::integer as count from peer_online_source_items where group_id=$1 and session_key=$2",
            [group, key]
          )
        ).rows[0]!.count
      ).toBe(2);
      await client.query("begin");
      await client.query(
        "update peer_online_sessions set deletion_hash='deleted',deletion='{}' where group_id=$1 and session_key=$2",
        [group, key]
      );
      await expect(
        materializePeerOnlineCheckpoint(pool, client, input)
      ).rejects.toThrow(/floor mismatch/);
      await client.query("rollback");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
