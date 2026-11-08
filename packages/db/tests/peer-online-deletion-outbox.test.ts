import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject
} from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizePdsJson,
  derivePeerSessionKey,
  signPeerOnlineCheckpoint
} from "@koed/shared";
import { runDbMigrations } from "../src/migrate.js";
import { createPeerOnlineMembershipRepository } from "../src/peer-online-membership-repository.js";
import { createPeerOnlineFloorRepository } from "../src/peer-online-floor-repository.js";
import { createPeerOnlineDeletionOutbox } from "../src/peer-online-deletion-outbox.js";
import { declarePeerOnlineRestoreQuarantine } from "../src/peer-online-restore-quarantine.js";

const url = process.env.PEER_ONLINE_MEMBERSHIP_TEST_DATABASE_URL;
const membership = "koed/peer-online-membership/v2";
const bindingDomain = "koed/peer-online-session-binding/v1";
const deletionDomain = "koed/peer-online-deletion/v1";
const encoded = (n: number) => Buffer.alloc(32, n).toString("base64url");
const encryptionIdentity = () => {
  const der = generateKeyPairSync("x25519").publicKey.export({
    type: "spki",
    format: "der"
  });
  return {
    encryptionSpki: der.toString("base64url"),
    encryptionSpkiSha256: createHash("sha256").update(der).digest("base64url")
  };
};
const signed = (domain: string, unsigned: object, key: KeyObject) =>
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
type FloorRepository = ReturnType<typeof createPeerOnlineFloorRepository>;
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

describe.skipIf(!url)("peer online local deletion outbox", () => {
  const name = `koed_outbox_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(url ?? "postgresql://localhost/postgres");
  target.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url });
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
  });
  async function fixture() {
    const keys = generateKeyPairSync("ed25519"),
      groupId = randomUUID(),
      owner = randomUUID(),
      localSessionId = randomUUID(),
      encryption = encryptionIdentity();
    const member = {
      deviceId: "origin",
      signingPublicKey: keys.publicKey.export({ format: "jwk" }).x!,
      ...encryption,
      transportSpkiSha256: encoded(2)
    };
    const genesisUnsigned = {
      protocol: membership,
      groupId,
      parentHash: null,
      authorDeviceId: "origin",
      body: { kind: "genesis", initialMember: member }
    };
    const genesisHash = createHash("sha256")
      .update(`${membership}/record\n${canonicalizePdsJson(genesisUnsigned)}`)
      .digest("base64url");
    const anchor = { groupId, genesisHash };
    await createPeerOnlineMembershipRepository(pool).initialize(
      anchor,
      signed(`${membership}/decision`, genesisUnsigned, keys.privateKey)
    );
    const identity = {
      groupId,
      originDeviceId: "origin",
      originSessionId: encoded(3)
    };
    const sessionKey = derivePeerSessionKey(identity);
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
    const checkpoint = signPeerOnlineCheckpoint(
      {
        ...identity,
        membershipHeadHash: genesisHash,
        bindingHash,
        sequence: "0",
        predecessorHash: null
      },
      Buffer.from("payload"),
      keys.privateKey
    );
    await pool.query("insert into users(id,email) values($1,$2)", [
      owner,
      `${owner}@example.test`
    ]);
    await pool.query(
      "insert into sessions(id,owner_user_id,source_runtime,capture_method) values($1,$2,'codex','api')",
      [localSessionId, owner]
    );
    expect(
      (
        await withSessionContext(
          createPeerOnlineFloorRepository(pool)
        ).acceptCheckpoint(
          anchor,
          binding,
          checkpoint.envelope,
          checkpoint.payload,
          "origin",
          { peerDeviceId: "origin", membershipRevision: genesisHash }
        )
      ).status
    ).toBe("accepted");
    const deletion = (head: string, eventId = encoded(5)) =>
      signed(
        deletionDomain,
        {
          protocol: deletionDomain,
          ...identity,
          sessionKey,
          authorDeviceId: "origin",
          membershipHeadHash: head,
          eventId
        },
        keys.privateKey
      );
    return {
      owner,
      localSessionId,
      anchor,
      sessionKey,
      binding,
      checkpoint,
      deletion,
      keys
    };
  }
  async function advance(f: Awaited<ReturnType<typeof fixture>>) {
    const next = generateKeyPairSync("ed25519");
    const unsigned = {
      protocol: membership,
      groupId: f.anchor.groupId,
      parentHash: f.anchor.genesisHash,
      authorDeviceId: "origin",
      body: {
        kind: "add",
        target: {
          deviceId: "other",
          signingPublicKey: next.publicKey.export({ format: "jwk" }).x!,
          ...encryptionIdentity(),
          transportSpkiSha256: encoded(11)
        }
      }
    };
    const head = createHash("sha256")
      .update(`${membership}/record\n${canonicalizePdsJson(unsigned)}`)
      .digest("base64url");
    expect(
      (
        await createPeerOnlineMembershipRepository(pool).append(
          f.anchor,
          signed(`${membership}/decision`, unsigned, f.keys.privateKey)
        )
      ).status
    ).toBe("accepted");
    return head;
  }
  it("reprepares one canonical floor after membership changes", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool);
    await repo.request(
      f.anchor.groupId,
      f.sessionKey,
      f.owner,
      f.localSessionId
    );
    const old = f.deletion(f.anchor.genesisHash);
    expect((await repo.prepare(f.anchor, f.sessionKey, old)).status).toBe(
      "prepared"
    );
    const oldHash = createHash("sha256")
      .update(`${deletionDomain}/record\n${old}`)
      .digest("base64url");
    const head = await advance(f);
    const current = f.deletion(head);
    expect((await repo.prepare(f.anchor, f.sessionKey, current)).status).toBe(
      "prepared"
    );
    const row = (
      await pool.query<Record<string, unknown>>(
        "select s.deletion,s.deletion_hash,o.prepared_deletion from peer_online_sessions s join peer_online_deletion_outbox o using(group_id,session_key) where s.group_id=$1 and s.session_key=$2",
        [f.anchor.groupId, f.sessionKey]
      )
    ).rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("Expected deletion outbox row");
    expect(row.deletion).toBe(old);
    expect(row.prepared_deletion).toBe(current);
    expect(row.deletion_hash).toBe(oldHash);
    expect((await repo.pending(f.anchor))[0]!.prepared_deletion).toBe(current);
    expect(
      (
        await withSessionContext(
          createPeerOnlineFloorRepository(pool)
        ).acceptDeletion(f.anchor, f.binding, current, "origin", {
          peerDeviceId: "other",
          membershipRevision: head
        })
      ).status
    ).toBe("deleted");
    expect(
      (
        await withSessionContext(
          createPeerOnlineFloorRepository(pool)
        ).acceptDeletion(f.anchor, f.binding, current, "origin", {
          peerDeviceId: "other",
          membershipRevision: f.anchor.genesisHash
        })
      ).status
    ).toBe("fenced");
    expect(
      (
        await pool.query<{ deletion: string | null }>(
          "select deletion from peer_online_sessions where group_id=$1 and session_key=$2",
          [f.anchor.groupId, f.sessionKey]
        )
      ).rows[0]?.deletion
    ).toBe(old); // A committed deletion floor is terminal; reprepare changes only the outbox.
  });
  it("reconciles a previously received deletion floor when preparing", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool);
    const old = f.deletion(f.anchor.genesisHash);
    const oldHash = createHash("sha256")
      .update(`${deletionDomain}/record\n${old}`)
      .digest("base64url");
    expect(
      (
        await createPeerOnlineFloorRepository(pool).acceptDeletion(
          f.anchor,
          f.binding,
          old,
          "origin",
          {
            peerDeviceId: "origin",
            membershipRevision: f.anchor.genesisHash
          }
        )
      ).status
    ).toBe("accepted");
    await repo.request(
      f.anchor.groupId,
      f.sessionKey,
      f.owner,
      f.localSessionId
    );
    const head = await advance(f),
      current = f.deletion(head);
    expect((await repo.prepare(f.anchor, f.sessionKey, current)).status).toBe(
      "prepared"
    );
    const row = (
      await pool.query<Record<string, unknown>>(
        "select s.deletion,s.deletion_hash,o.prepared_deletion from peer_online_sessions s join peer_online_deletion_outbox o using(group_id,session_key) where s.group_id=$1 and s.session_key=$2",
        [f.anchor.groupId, f.sessionKey]
      )
    ).rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("Expected deletion outbox row");
    expect(row.deletion).toBe(old);
    expect(row.deletion_hash).toBe(oldHash);
    expect(row.prepared_deletion).toBe(current);
    expect((await repo.pending(f.anchor))[0]!.prepared_deletion).toBe(current);
  });
  it("rejects a corrupted existing floor without preparing a record", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool),
      deletion = f.deletion(f.anchor.genesisHash);
    await repo.request(
      f.anchor.groupId,
      f.sessionKey,
      f.owner,
      f.localSessionId
    );
    await pool.query(
      "update peer_online_sessions set deletion_hash='wrong-hash',deletion=$3 where group_id=$1 and session_key=$2",
      [f.anchor.groupId, f.sessionKey, deletion]
    );
    expect(await repo.prepare(f.anchor, f.sessionKey, deletion)).toEqual({
      status: "invalid"
    });
    const prepared = await pool.query<{
      prepared_deletion: string | null;
    }>(
      "select prepared_deletion from peer_online_deletion_outbox where group_id=$1 and session_key=$2",
      [f.anchor.groupId, f.sessionKey]
    );
    expect(prepared.rows[0]?.prepared_deletion).toBeNull();
  });
  it("rejects a different logical deletion for an existing floor", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool);
    await repo.request(
      f.anchor.groupId,
      f.sessionKey,
      f.owner,
      f.localSessionId
    );
    const original = f.deletion(f.anchor.genesisHash);
    expect((await repo.prepare(f.anchor, f.sessionKey, original)).status).toBe(
      "prepared"
    );
    const different = f.deletion(f.anchor.genesisHash, encoded(6));
    expect(await repo.prepare(f.anchor, f.sessionKey, different)).toEqual({
      status: "invalid"
    });
    const row = (
      await pool.query<Record<string, unknown>>(
        "select s.deletion,o.prepared_deletion from peer_online_sessions s join peer_online_deletion_outbox o using(group_id,session_key) where s.group_id=$1 and s.session_key=$2",
        [f.anchor.groupId, f.sessionKey]
      )
    ).rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("Expected deletion outbox row");
    expect(row.deletion).toBe(original);
    expect(row.prepared_deletion).toBe(original);
  });
  it("does not return a prepared record after membership changes until reprepared", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool);
    await repo.request(
      f.anchor.groupId,
      f.sessionKey,
      f.owner,
      f.localSessionId
    );
    const old = f.deletion(f.anchor.genesisHash);
    await repo.prepare(f.anchor, f.sessionKey, old);
    expect((await repo.pending(f.anchor))[0]!.prepared_deletion).toBe(old);
    await expect(
      repo.pending({ ...f.anchor, genesisHash: encoded(99) })
    ).rejects.toThrow("peer membership anchor mismatch");
    const head = await advance(f);
    expect((await repo.pending(f.anchor))[0]!.prepared_deletion).toBeNull();
    const current = f.deletion(head);
    await repo.prepare(f.anchor, f.sessionKey, current);
    expect((await repo.pending(f.anchor))[0]!.prepared_deletion).toBe(current);
  });
  it("commits local visibility and permanent pending intent together, surviving a new pool", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool);
    await pool.query(
      "insert into memory_events(owner_user_id,visibility,event_type,capture_method,session_id) values($1,'personal','captured','api',$2)",
      [f.owner, f.localSessionId]
    );
    expect(
      (
        await repo.request(
          f.anchor.groupId,
          f.sessionKey,
          f.owner,
          f.localSessionId
        )
      ).status
    ).toBe("pending");
    const visible = await pool.query<Record<string, unknown>>(
      "select s.personal_deleted_at as session_deleted,e.personal_deleted_at as event_deleted from sessions s join memory_events e on e.session_id=s.id where s.id=$1",
      [f.localSessionId]
    );
    expect(visible.rows[0]!.session_deleted).toBeInstanceOf(Date);
    expect(visible.rows[0]!.event_deleted).toBeInstanceOf(Date);
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "select 1 from peer_online_checkpoints where group_id=$1 and session_key=$2",
          [f.anchor.groupId, f.sessionKey]
        )
      ).rowCount
    ).toBe(0);
    const reopened = new pg.Pool({ connectionString: target.toString() });
    try {
      expect(
        await createPeerOnlineDeletionOutbox(reopened).pending(f.anchor)
      ).toHaveLength(1);
    } finally {
      await reopened.end();
    }
    expect(
      (
        await createPeerOnlineFloorRepository(pool).acceptCheckpoint(
          f.anchor,
          f.binding,
          f.checkpoint.envelope,
          f.checkpoint.payload,
          "origin",
          {
            peerDeviceId: "origin",
            membershipRevision: f.anchor.genesisHash
          }
        )
      ).status
    ).toBe("deleted");
    expect(
      (
        await repo.request(
          f.anchor.groupId,
          f.sessionKey,
          f.owner,
          f.localSessionId
        )
      ).status
    ).toBe("pending");
  });
  it("withholds a prepared deletion while restore-quarantined", async () => {
    const f = await fixture();
    const repo = createPeerOnlineDeletionOutbox(pool);
    await repo.request(
      f.anchor.groupId,
      f.sessionKey,
      f.owner,
      f.localSessionId
    );
    const deletion = f.deletion(f.anchor.genesisHash);
    expect((await repo.prepare(f.anchor, f.sessionKey, deletion)).status).toBe(
      "prepared"
    );
    await declarePeerOnlineRestoreQuarantine(
      pool,
      f.anchor,
      "restore detected"
    );
    await expect(repo.pending(f.anchor)).rejects.toThrow(
      "peer online group quarantined after restore"
    );
  });

  it("allows local deletion intent but blocks send eligibility while quarantined", async () => {
    const f = await fixture();
    const repo = createPeerOnlineDeletionOutbox(pool);
    await pool.query(
      "insert into memory_events(owner_user_id,visibility,event_type,capture_method,session_id) values($1,'personal','captured','api',$2)",
      [f.owner, f.localSessionId]
    );
    await declarePeerOnlineRestoreQuarantine(
      pool,
      f.anchor,
      "restore detected"
    );
    expect(
      (
        await repo.request(
          f.anchor.groupId,
          f.sessionKey,
          f.owner,
          f.localSessionId
        )
      ).status
    ).toBe("pending");
    const visibility = await pool.query<Record<string, unknown>>(
      "select s.personal_deleted_at as session_deleted,e.personal_deleted_at as event_deleted from sessions s join memory_events e on e.session_id=s.id where s.id=$1",
      [f.localSessionId]
    );
    expect(visibility.rows[0]?.session_deleted).toBeInstanceOf(Date);
    expect(visibility.rows[0]?.event_deleted).toBeInstanceOf(Date);
    await expect(repo.pending(f.anchor)).rejects.toThrow(
      "peer online group quarantined after restore"
    );
    await expect(
      repo.prepare(f.anchor, f.sessionKey, f.deletion(f.anchor.genesisHash))
    ).rejects.toThrow("peer online group quarantined after restore");
    const outbox = await pool.query<{ prepared_deletion: string | null }>(
      "select prepared_deletion from peer_online_deletion_outbox where group_id=$1 and session_key=$2",
      [f.anchor.groupId, f.sessionKey]
    );
    expect(outbox.rows[0]?.prepared_deletion).toBeNull();
  });

  it("rejects a different owner and rolls back on outbox failure", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool);
    expect(
      (
        await repo.request(
          f.anchor.groupId,
          f.sessionKey,
          randomUUID(),
          f.localSessionId
        )
      ).status
    ).toBe("invalid");
    await pool.query(
      "alter table peer_online_deletion_outbox add constraint test_outbox_failure check(false) not valid"
    );
    try {
      await expect(
        repo.request(f.anchor.groupId, f.sessionKey, f.owner, f.localSessionId)
      ).rejects.toThrow();
    } finally {
      await pool.query(
        "alter table peer_online_deletion_outbox drop constraint test_outbox_failure"
      );
    }
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "select personal_deleted_at from sessions where id=$1",
          [f.localSessionId]
        )
      ).rows[0]!.personal_deleted_at
    ).toBeNull();
    expect(await repo.pending(f.anchor)).toHaveLength(0);
  });
  it("retains intent through membership changes and prepares only at the current head", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool);
    await repo.request(
      f.anchor.groupId,
      f.sessionKey,
      f.owner,
      f.localSessionId
    );
    const next = generateKeyPairSync("ed25519");
    const target = {
      deviceId: "other",
      signingPublicKey: next.publicKey.export({ format: "jwk" }).x!,
      ...encryptionIdentity(),
      transportSpkiSha256: encoded(11)
    };
    const unsigned = {
      protocol: membership,
      groupId: f.anchor.groupId,
      parentHash: f.anchor.genesisHash,
      authorDeviceId: "origin",
      body: { kind: "add", target }
    };
    const nextHead = createHash("sha256")
      .update(`${membership}/record\n${canonicalizePdsJson(unsigned)}`)
      .digest("base64url");
    expect(
      (
        await createPeerOnlineMembershipRepository(pool).append(
          f.anchor,
          signed(`${membership}/decision`, unsigned, f.keys.privateKey)
        )
      ).status
    ).toBe("accepted");
    expect(
      (
        await repo.prepare(
          f.anchor,
          f.sessionKey,
          f.deletion(f.anchor.genesisHash)
        )
      ).status
    ).toBe("invalid");
    expect(await repo.pending(f.anchor)).toHaveLength(1);
    expect(
      (await repo.prepare(f.anchor, f.sessionKey, f.deletion(nextHead))).status
    ).toBe("prepared");
    expect(await repo.pending(f.anchor)).toHaveLength(1);
  });
  it("rolls back the intent if local visibility update fails", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool);
    await pool.query(
      "alter table sessions add constraint test_visibility_failure check (personal_deleted_at is null) not valid"
    );
    try {
      await expect(
        repo.request(f.anchor.groupId, f.sessionKey, f.owner, f.localSessionId)
      ).rejects.toThrow();
    } finally {
      await pool.query(
        "alter table sessions drop constraint test_visibility_failure"
      );
    }
    expect(await repo.pending(f.anchor)).toHaveLength(0);
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "select personal_deleted_at from sessions where id=$1",
          [f.localSessionId]
        )
      ).rows[0]!.personal_deleted_at
    ).toBeNull();
  });
  it("rolls back intent and visibility when its database connection dies mid-transaction", async () => {
    const f = await fixture();
    const event = await pool.query<{ id: string }>(
      "insert into memory_events(owner_user_id,visibility,event_type,capture_method,session_id) values($1,'personal','captured','api',$2) returning id",
      [f.owner, f.localSessionId]
    );
    const blocker = await pool.connect();
    const app = `outbox_crash_${randomUUID()}`;
    const worker = new pg.Pool({
      connectionString: target.toString(),
      application_name: app,
      max: 1
    });
    worker.on("connect", (client) => client.on("error", () => {})); // Expected after backend termination.
    worker.on("error", () => {});
    try {
      await blocker.query("begin");
      await blocker.query(
        "select id from memory_events where id=$1 for update",
        [event.rows[0]!.id]
      );
      const request = createPeerOnlineDeletionOutbox(worker).request(
        f.anchor.groupId,
        f.sessionKey,
        f.owner,
        f.localSessionId
      );
      const failed = expect(request).rejects.toThrow();
      let pid: number | undefined;
      for (let i = 0; i < 100; i++) {
        const active = await pool.query<{ pid: number }>(
          "select pid from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
          [app]
        );
        pid = active.rows[0]?.pid;
        if (pid) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pid).toBeDefined();
      await pool.query("select pg_terminate_backend($1)", [pid]);
      await failed;
      await blocker.query("rollback");
      expect(
        await createPeerOnlineDeletionOutbox(pool).pending(f.anchor)
      ).toHaveLength(0);
      expect(
        (
          await pool.query<Record<string, unknown>>(
            "select personal_deleted_at from sessions where id=$1",
            [f.localSessionId]
          )
        ).rows[0]!.personal_deleted_at
      ).toBeNull();
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await worker.end();
    }
  });
  it("serializes checkpoint races and never treats a signed record as peer acknowledgement", async () => {
    const f = await fixture(),
      repo = createPeerOnlineDeletionOutbox(pool),
      floor = createPeerOnlineFloorRepository(pool);
    const results = await Promise.all([
      repo.request(f.anchor.groupId, f.sessionKey, f.owner, f.localSessionId),
      floor.acceptCheckpoint(
        f.anchor,
        f.binding,
        f.checkpoint.envelope,
        f.checkpoint.payload,
        "origin",
        {
          peerDeviceId: "origin",
          membershipRevision: f.anchor.genesisHash
        }
      )
    ]);
    expect(results[0].status).toBe("pending");
    expect(["duplicate", "deleted"]).toContain(results[1].status);
    expect(
      (
        await repo.prepare(
          f.anchor,
          f.sessionKey,
          f.deletion(f.anchor.genesisHash)
        )
      ).status
    ).toBe("prepared");
    expect(await repo.pending(f.anchor)).toHaveLength(1);
  });
});
