import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizePdsJson,
  derivePeerSessionKey,
  signPeerOnlineCheckpoint
} from "@koed/shared";
import { runDbMigrations } from "../src/migrate.js";
import { createPeerOnlineMembershipRepository } from "../src/peer-online-membership-repository.js";
import { createPeerOnlineFloorRepository as createRawPeerOnlineFloorRepository } from "../src/peer-online-floor-repository.js";
import { declarePeerOnlineRestoreQuarantine } from "../src/peer-online-restore-quarantine.js";

const url = process.env.PEER_ONLINE_MEMBERSHIP_TEST_DATABASE_URL;
const membershipDomain = "koed/peer-online-membership/v2";
const bindingDomain = "koed/peer-online-session-binding/v1";
const deletionDomain = "koed/peer-online-deletion/v1";
const encoded = (n: number) => Buffer.alloc(32, n).toString("base64url");
const encryptionIdentity = () => {
  const key = generateKeyPairSync("x25519").publicKey;
  const der = key.export({ type: "spki", format: "der" });
  return {
    encryptionSpki: der.toString("base64url"),
    encryptionSpkiSha256: createHash("sha256").update(der).digest("base64url")
  };
};
const signed = (
  domain: string,
  unsigned: object,
  key: ReturnType<typeof generateKeyPairSync>["privateKey"]
) =>
  canonicalizePdsJson({
    unsigned,
    signature: sign(
      null,
      Buffer.from(`${domain}\n${canonicalizePdsJson(unsigned)}`),
      key
    ).toString("base64url")
  });

type TestSessionContext = {
  peerDeviceId: string;
  membershipRevision: string;
};
type FloorRepository = ReturnType<typeof createRawPeerOnlineFloorRepository>;
type ContextAwareFloorRepository = {
  acceptDeletion: (
    anchor: Parameters<FloorRepository["acceptDeletion"]>[0],
    bindingJson: string,
    deletionJson: string,
    localDeviceId: string,
    sessionContext: TestSessionContext
  ) => ReturnType<FloorRepository["acceptDeletion"]>;
  acceptCheckpoint: (
    anchor: Parameters<FloorRepository["acceptCheckpoint"]>[0],
    bindingJson: string,
    envelope: string,
    payload: Uint8Array,
    localDeviceId: string,
    sessionContext: TestSessionContext
  ) => ReturnType<FloorRepository["acceptCheckpoint"]>;
};

const withSessionContext = (repo: FloorRepository) =>
  repo as unknown as ContextAwareFloorRepository;

type DefaultContextFloorRepository = {
  acceptDeletion: (
    anchor: Parameters<FloorRepository["acceptDeletion"]>[0],
    bindingJson: string,
    deletionJson: string
  ) => ReturnType<FloorRepository["acceptDeletion"]>;
  acceptCheckpoint: (
    anchor: Parameters<FloorRepository["acceptCheckpoint"]>[0],
    bindingJson: string,
    envelope: string,
    payload: Uint8Array
  ) => ReturnType<FloorRepository["acceptCheckpoint"]>;
};

const createPeerOnlineFloorRepository = (
  pool: pg.Pool
): DefaultContextFloorRepository => {
  const contextual = withSessionContext(
    createRawPeerOnlineFloorRepository(pool)
  );
  return {
    acceptDeletion: (anchor, bindingJson, deletionJson) =>
      contextual.acceptDeletion(anchor, bindingJson, deletionJson, "origin", {
        peerDeviceId: "origin",
        membershipRevision: anchor.genesisHash
      }),
    acceptCheckpoint: (anchor, bindingJson, envelope, payload) =>
      contextual.acceptCheckpoint(
        anchor,
        bindingJson,
        envelope,
        payload,
        "origin",
        { peerDeviceId: "origin", membershipRevision: anchor.genesisHash }
      )
  };
};

describe.skipIf(!url)("peer online durable floor and checkpoint", () => {
  const name = `koed_floor_${randomUUID().replaceAll("-", "")}`;
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
    try {
      await pool.end();
    } finally {
      try {
        if (created) await admin.query(`drop database "${name}" with (force)`);
      } finally {
        await admin.end();
      }
    }
  });
  async function fixture() {
    const keys = generateKeyPairSync("ed25519"),
      encryption = encryptionIdentity(),
      groupId = randomUUID();
    const member = {
      deviceId: "origin",
      signingPublicKey: keys.publicKey.export({ format: "jwk" }).x!,
      ...encryption,
      transportSpkiSha256: encoded(2)
    };
    const unsigned = {
      protocol: membershipDomain,
      groupId,
      parentHash: null,
      authorDeviceId: "origin",
      body: { kind: "genesis", initialMember: member }
    };
    const genesisHash = createHash("sha256")
      .update(`${membershipDomain}/record\n${canonicalizePdsJson(unsigned)}`)
      .digest("base64url");
    const genesis = canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(
          `${membershipDomain}/decision\n${canonicalizePdsJson(unsigned)}`
        ),
        keys.privateKey
      ).toString("base64url")
    });
    const anchor = { groupId, genesisHash };
    await createPeerOnlineMembershipRepository(pool).initialize(
      anchor,
      genesis
    );
    const identity = {
        groupId,
        originDeviceId: "origin",
        originSessionId: encoded(3)
      },
      sessionKey = derivePeerSessionKey(identity);
    const binding = signed(
      bindingDomain,
      {
        protocol: bindingDomain,
        ...identity,
        sessionKey,
        sourceIdentityCommitment: encoded(4)
      },
      keys.privateKey
    );
    const bindingHash = createHash("sha256")
      .update(`${bindingDomain}/record\n${binding}`)
      .digest("base64url");
    const deletion = signed(
      deletionDomain,
      {
        protocol: deletionDomain,
        ...identity,
        sessionKey,
        authorDeviceId: "origin",
        membershipHeadHash: genesisHash,
        eventId: encoded(5)
      },
      keys.privateKey
    );
    const checkpoint = (sequence: string, predecessorHash: string | null) =>
      signPeerOnlineCheckpoint(
        {
          ...identity,
          membershipHeadHash: genesisHash,
          bindingHash,
          sequence,
          predecessorHash
        },
        Buffer.from("encrypted"),
        keys.privateKey
      );
    return {
      anchor,
      binding,
      deletion,
      checkpoint,
      keys,
      identity,
      sessionKey,
      genesisHash
    };
  }
  it("fences deletion from a transport peer absent from the active membership", async () => {
    const f = await fixture();
    const repo = withSessionContext(createRawPeerOnlineFloorRepository(pool));
    const result = await repo.acceptDeletion(
      f.anchor,
      f.binding,
      f.deletion,
      "origin",
      {
        peerDeviceId: "unknown-peer",
        membershipRevision: f.genesisHash
      }
    );
    expect(result.status).toBe("fenced");
    expect(
      (
        await pool.query(
          "select 1 from peer_online_sessions where group_id=$1",
          [f.anchor.groupId]
        )
      ).rowCount
    ).toBe(0);
  });

  it("fences a checkpoint when the trusted local device is not active", async () => {
    const f = await fixture();
    const repo = withSessionContext(createRawPeerOnlineFloorRepository(pool));
    const checkpoint = f.checkpoint("0", null);
    const result = await repo.acceptCheckpoint(
      f.anchor,
      f.binding,
      checkpoint.envelope,
      checkpoint.payload,
      "unknown-local",
      {
        peerDeviceId: "origin",
        membershipRevision: f.genesisHash
      }
    );
    expect(result.status).toBe("fenced");
    expect(
      (
        await pool.query(
          "select 1 from peer_online_checkpoints where group_id=$1",
          [f.anchor.groupId]
        )
      ).rowCount
    ).toBe(0);
  });

  it("fences a valid deletion when its authenticated membership revision is stale", async () => {
    const f = await fixture();
    const repo = withSessionContext(createRawPeerOnlineFloorRepository(pool));
    const second = generateKeyPairSync("ed25519");
    const member = {
      deviceId: "other",
      signingPublicKey: second.publicKey.export({ format: "jwk" }).x!,
      ...encryptionIdentity(),
      transportSpkiSha256: encoded(11)
    };
    const unsigned = {
      protocol: membershipDomain,
      groupId: f.anchor.groupId,
      parentHash: f.genesisHash,
      authorDeviceId: "origin",
      body: { kind: "add", target: member }
    };
    const record = canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(
          `${membershipDomain}/decision\n${canonicalizePdsJson(unsigned)}`
        ),
        f.keys.privateKey
      ).toString("base64url")
    });
    expect(
      (
        await createPeerOnlineMembershipRepository(pool).append(
          f.anchor,
          record
        )
      ).status
    ).toBe("accepted");
    const result = await repo.acceptDeletion(
      f.anchor,
      f.binding,
      f.deletion,
      "origin",
      { peerDeviceId: "origin", membershipRevision: f.genesisHash }
    );
    expect(result.status).toBe("fenced");
    expect(
      (
        await pool.query(
          "select 1 from peer_online_sessions where group_id=$1",
          [f.anchor.groupId]
        )
      ).rowCount
    ).toBe(0);
  });

  it("persists a permanent deletion floor that blocks checkpoint retries", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      cp = f.checkpoint("0", null);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("accepted");
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("deleted");
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("duplicate");
  });
  it("blocks checkpoint and deletion acceptance while restore-quarantined", async () => {
    const f = await fixture();
    const repo = createPeerOnlineFloorRepository(pool);
    const checkpoint = f.checkpoint("0", null);
    await declarePeerOnlineRestoreQuarantine(
      pool,
      f.anchor,
      "restore detected"
    );
    await expect(
      repo.acceptCheckpoint(
        f.anchor,
        f.binding,
        checkpoint.envelope,
        checkpoint.payload
      )
    ).rejects.toThrow("peer online group quarantined after restore");
    await expect(
      repo.acceptDeletion(f.anchor, f.binding, f.deletion)
    ).rejects.toThrow("peer online group quarantined after restore");
    const sessions = await pool.query(
      "select 1 from peer_online_sessions where group_id=$1",
      [f.anchor.groupId]
    );
    expect(sessions.rowCount).toBe(0);
  });

  it("enforces session retention quota and purges checkpoint rows on deletion", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      zero = f.checkpoint("0", null);
    const accepted = await repo.acceptCheckpoint(
      f.anchor,
      f.binding,
      zero.envelope,
      zero.payload
    );
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted")
      throw new Error("checkpoint not accepted");
    await pool.query(
      `insert into peer_online_checkpoints (group_id, session_key, sequence, hash, envelope, payload)
      select $1, $2, n::text, 'fixture', 'fixture', 'fixture' from generate_series(100, 114) n`,
      [f.anchor.groupId, f.sessionKey]
    );
    const one = f.checkpoint("1", accepted.hash);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          one.envelope,
          one.payload
        )
      ).status
    ).toBe("quota_exceeded");
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          zero.envelope,
          zero.payload
        )
      ).status
    ).toBe("duplicate");
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");
    expect(
      (
        await pool.query(
          "select 1 from peer_online_checkpoints where group_id=$1",
          [f.anchor.groupId]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          one.envelope,
          one.payload
        )
      ).status
    ).toBe("deleted");
  });
  it("enforces group quota and recovers capacity after rows are removed", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      cp = f.checkpoint("0", null);
    await pool.query(
      "insert into peer_online_sessions (group_id, session_key, binding_hash, binding) values ($1, 'other', 'fixture', 'fixture')",
      [f.anchor.groupId]
    );
    await pool.query(
      `insert into peer_online_checkpoints (group_id, session_key, sequence, hash, envelope, payload)
      select $1, 'other', n::text, 'fixture', 'fixture', 'fixture' from generate_series(1, 128) n`,
      [f.anchor.groupId]
    );
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("quota_exceeded");
    await pool.query(
      "delete from peer_online_checkpoints where group_id=$1 and session_key='other'",
      [f.anchor.groupId]
    );
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("accepted");
  });
  it("enforces stored-byte quota independently of count", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      zero = f.checkpoint("0", null);
    const accepted = await repo.acceptCheckpoint(
      f.anchor,
      f.binding,
      zero.envelope,
      zero.payload
    );
    if (accepted.status !== "accepted")
      throw new Error("checkpoint not accepted");
    await pool.query(
      `insert into peer_online_checkpoints (group_id, session_key, sequence, hash, envelope, payload)
      values ($1, $2, '100', 'fixture', 'fixture', repeat('x', 33554432))`,
      [f.anchor.groupId, f.sessionKey]
    );
    const one = f.checkpoint("1", accepted.hash);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          one.envelope,
          one.payload
        )
      ).status
    ).toBe("quota_exceeded");
  });
  it("rolls back deletion floor if checkpoint purge fails", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      cp = f.checkpoint("0", null);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("accepted");
    await pool.query(
      `create function test_block_floor_purge() returns trigger language plpgsql as $$ begin raise exception 'purge failed'; end $$`
    );
    await pool.query(
      "create trigger test_block_floor_purge before delete on peer_online_checkpoints for each row execute function test_block_floor_purge()"
    );
    try {
      await expect(
        repo.acceptDeletion(f.anchor, f.binding, f.deletion)
      ).rejects.toThrow("purge failed");
    } finally {
      await pool.query(
        "drop trigger test_block_floor_purge on peer_online_checkpoints"
      );
      await pool.query("drop function test_block_floor_purge()");
    }
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("duplicate");
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");
  });
  it("rejects ordinary SQL updates to an accepted deletion floor", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool);
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");

    await expect(
      pool.query(
        "update peer_online_sessions set deletion_hash='changed' where group_id=$1 and session_key=$2",
        [f.anchor.groupId, f.sessionKey]
      )
    ).rejects.toMatchObject({
      code: "23514",
      message: "peer online deletion floor is immutable"
    });
  });
  it("rejects clearing both deletion fields after tombstoning", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool);
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");

    await expect(
      pool.query(
        "update peer_online_sessions set deletion_hash=null, deletion=null where group_id=$1 and session_key=$2",
        [f.anchor.groupId, f.sessionKey]
      )
    ).rejects.toMatchObject({
      code: "23514",
      message: "peer online deletion floor is immutable"
    });
  });
  it("rejects unrelated session updates after tombstoning", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool);
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");

    await expect(
      pool.query(
        "update peer_online_sessions set checkpoint_sequence='0' where group_id=$1 and session_key=$2",
        [f.anchor.groupId, f.sessionKey]
      )
    ).rejects.toMatchObject({
      code: "23514",
      message: "peer online deletion floor is immutable"
    });
  });
  it("rejects ordinary SQL deletion of an accepted deletion floor", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool);
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");

    await expect(
      pool.query(
        "delete from peer_online_sessions where group_id=$1 and session_key=$2",
        [f.anchor.groupId, f.sessionKey]
      )
    ).rejects.toMatchObject({
      code: "23514",
      message: "peer online deletion floor is immutable"
    });
  });
  it("rejects updates to accepted checkpoint records", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      checkpoint = f.checkpoint("0", null);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          checkpoint.envelope,
          checkpoint.payload
        )
      ).status
    ).toBe("accepted");

    await expect(
      pool.query(
        "update peer_online_checkpoints set envelope='changed' where group_id=$1 and session_key=$2 and sequence='0'",
        [f.anchor.groupId, f.sessionKey]
      )
    ).rejects.toMatchObject({
      code: "23514",
      message: "peer online checkpoint is immutable"
    });
  });
  it("rejects ordinary SQL checkpoint inserts after an accepted deletion", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool);
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");

    await expect(
      pool.query(
        `insert into peer_online_checkpoints
          (group_id, session_key, sequence, hash, envelope, payload)
        values ($1, $2, '0', 'blocked', 'blocked', 'blocked')`,
        [f.anchor.groupId, f.sessionKey]
      )
    ).rejects.toMatchObject({
      code: "23514",
      message: "peer online checkpoint blocked by deletion floor"
    });
  });
  it("purges existing checkpoints when a deletion floor is first written", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      checkpoint = f.checkpoint("0", null);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          checkpoint.envelope,
          checkpoint.payload
        )
      ).status
    ).toBe("accepted");

    const deletionHash = createHash("sha256")
      .update(`${deletionDomain}/record\n${f.deletion}`)
      .digest("base64url");
    await pool.query(
      "update peer_online_sessions set deletion_hash=$3,deletion=$4 where group_id=$1 and session_key=$2",
      [f.anchor.groupId, f.sessionKey, deletionHash, f.deletion]
    );
    const floor = await pool.query(
      "select checkpoint_sequence,checkpoint_hash from peer_online_sessions where group_id=$1 and session_key=$2",
      [f.anchor.groupId, f.sessionKey]
    );
    expect(floor.rows[0]).toEqual({
      checkpoint_sequence: null,
      checkpoint_hash: null
    });
    const rows = await pool.query(
      "select 1 from peer_online_checkpoints where group_id=$1 and session_key=$2",
      [f.anchor.groupId, f.sessionKey]
    );
    expect(rows.rowCount).toBe(0);
  });
  it("serializes concurrent checkpoint and deletion acceptance", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      checkpoint = f.checkpoint("0", null);
    const [checkpointResult, deletionResult] = await Promise.all([
      repo.acceptCheckpoint(
        f.anchor,
        f.binding,
        checkpoint.envelope,
        checkpoint.payload
      ),
      repo.acceptDeletion(f.anchor, f.binding, f.deletion)
    ]);
    expect(deletionResult.status).toBe("accepted");
    expect(["accepted", "deleted"]).toContain(checkpointResult.status);

    const floor = await pool.query<{ deletion_hash: string | null }>(
      "select deletion_hash from peer_online_sessions where group_id=$1 and session_key=$2",
      [f.anchor.groupId, f.sessionKey]
    );
    const checkpoints = await pool.query(
      "select 1 from peer_online_checkpoints where group_id=$1 and session_key=$2",
      [f.anchor.groupId, f.sessionKey]
    );
    expect(floor.rows[0]?.deletion_hash).not.toBeNull();
    expect(checkpoints.rowCount).toBe(0);
  });
  it("blocks first checkpoint when deletion arrives before any checkpoint", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      cp = f.checkpoint("0", null);
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("accepted");
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("deleted");
    expect(
      (
        await pool.query(
          "select 1 from peer_online_checkpoints where group_id=$1",
          [f.anchor.groupId]
        )
      ).rowCount
    ).toBe(0);
  });
  it("serializes concurrent deletion and checkpoint acceptance without resurrection", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      cp = f.checkpoint("0", null);
    const results = await Promise.all([
      repo.acceptDeletion(f.anchor, f.binding, f.deletion),
      repo.acceptCheckpoint(f.anchor, f.binding, cp.envelope, cp.payload)
    ]);
    expect(results[0].status).toBe("accepted");
    expect(["accepted", "deleted"]).toContain(results[1].status);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("deleted");
  });
  it("rolls back checkpoint state when persistence fails", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      cp = f.checkpoint("0", null);
    await pool.query(
      "alter table peer_online_checkpoints add constraint test_checkpoint_failure check (false) not valid"
    );
    try {
      await expect(
        repo.acceptCheckpoint(f.anchor, f.binding, cp.envelope, cp.payload)
      ).rejects.toThrow();
    } finally {
      await pool.query(
        "alter table peer_online_checkpoints drop constraint test_checkpoint_failure"
      );
    }
    const rows = await pool.query(
      "select * from peer_online_sessions where group_id=$1",
      [f.anchor.groupId]
    );
    expect(rows.rowCount).toBe(0);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("accepted");
  });
  it("rejects a substituted binding for an established session", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      cp = f.checkpoint("0", null);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("accepted");
    const changed = signed(
      bindingDomain,
      {
        protocol: bindingDomain,
        ...f.identity,
        sessionKey: f.sessionKey,
        sourceIdentityCommitment: encoded(9)
      },
      f.keys.privateKey
    );
    expect(
      (await repo.acceptDeletion(f.anchor, changed, f.deletion)).status
    ).toBe("invalid");
  });
  it("rejects checkpoints and deletions after current membership head changes", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      cp = f.checkpoint("0", null);
    const second = generateKeyPairSync("ed25519");
    const member = {
      deviceId: "other",
      signingPublicKey: second.publicKey.export({ format: "jwk" }).x!,
      ...encryptionIdentity(),
      transportSpkiSha256: encoded(11)
    };
    const unsigned = {
      protocol: membershipDomain,
      groupId: f.anchor.groupId,
      parentHash: f.genesisHash,
      authorDeviceId: "origin",
      body: { kind: "add", target: member }
    };
    const json = canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(
          `${membershipDomain}/decision\n${canonicalizePdsJson(unsigned)}`
        ),
        f.keys.privateKey
      ).toString("base64url")
    });
    expect(
      (await createPeerOnlineMembershipRepository(pool).append(f.anchor, json))
        .status
    ).toBe("accepted");
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          cp.envelope,
          cp.payload
        )
      ).status
    ).toBe("fenced");
    expect(
      (await repo.acceptDeletion(f.anchor, f.binding, f.deletion)).status
    ).toBe("fenced");
  });
  it("enforces chain order and recognizes exact duplicates", async () => {
    const f = await fixture(),
      repo = createPeerOnlineFloorRepository(pool),
      zero = f.checkpoint("0", null);
    const hash = createHash("sha256")
      .update(`koed/peer-online-checkpoint/v1/record\n${zero.envelope}`)
      .digest("base64url");
    const one = f.checkpoint("1", hash);
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          one.envelope,
          one.payload
        )
      ).status
    ).toBe("pending");
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          zero.envelope,
          zero.payload
        )
      ).status
    ).toBe("accepted");
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          zero.envelope,
          zero.payload
        )
      ).status
    ).toBe("duplicate");
    const conflicting = signPeerOnlineCheckpoint(
      {
        ...f.identity,
        membershipHeadHash: f.genesisHash,
        bindingHash: createHash("sha256")
          .update(`${bindingDomain}/record\n${f.binding}`)
          .digest("base64url"),
        sequence: "0",
        predecessorHash: null
      },
      Buffer.from("different"),
      f.keys.privateKey
    );
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          conflicting.envelope,
          conflicting.payload
        )
      ).status
    ).toBe("invalid");
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          one.envelope,
          one.payload
        )
      ).status
    ).toBe("accepted");
    expect(
      (
        await repo.acceptCheckpoint(
          f.anchor,
          f.binding,
          f.checkpoint("2", encoded(8)).envelope,
          one.payload
        )
      ).status
    ).toBe("invalid");
  });
});
