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
  sealPeerOnlineCheckpoint,
  signPeerOnlineBinding,
  type PeerOnlineSessionSnapshotItem
} from "@koed/shared";
import { runDbMigrations } from "../src/migrate.js";
import { createPeerOnlineFloorRepository } from "../src/peer-online-floor-repository.js";
import { createPeerOnlineMembershipRepository } from "../src/peer-online-membership-repository.js";
import { declarePeerOnlineRestoreQuarantine } from "../src/peer-online-restore-quarantine.js";
import {
  bindPeerOnlineGroupOwner,
  createPeerOnlineCheckpointReceiver
} from "../src/peer-online-receiver.js";

const url = process.env.PEER_ONLINE_MEMBERSHIP_TEST_DATABASE_URL;
const membershipDomain = "koed/peer-online-membership/v2";
const encoded = (n: number) => Buffer.alloc(32, n).toString("base64url");
const spki = (key: KeyObject) =>
  key.export({ type: "spki", format: "der" }).toString("base64url");
const spkiHash = (key: KeyObject) =>
  createHash("sha256")
    .update(Buffer.from(spki(key), "base64url"))
    .digest("base64url");

function device(deviceId: string, transport: number) {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    deviceId,
    signing,
    encryption,
    member: {
      deviceId,
      signingPublicKey: signing.publicKey.export({ format: "jwk" }).x!,
      encryptionSpki: spki(encryption.publicKey),
      encryptionSpkiSha256: spkiHash(encryption.publicKey),
      transportSpkiSha256: encoded(transport)
    }
  };
}

function decision(unsigned: object, key: KeyObject) {
  const canonical = canonicalizePdsJson(unsigned);
  return {
    json: canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(`${membershipDomain}/decision\n${canonical}`),
        key
      ).toString("base64url")
    }),
    hash: createHash("sha256")
      .update(`${membershipDomain}/record\n${canonical}`)
      .digest("base64url")
  };
}

const source = {
  sourceKind: "codex",
  sourceAdapterVersion: "codex-transcript-v1",
  externalSessionId: "thread-1"
};
const item = (n: number, content = `message ${n}`) =>
  ({
    sourceRecordType: "message",
    sourceSequence: String(n),
    externalItemId: `item-${n}`,
    rawJson: JSON.stringify({ role: "user", content, n }),
    sourceHash: `hash-${n}-${content}`
  }) satisfies PeerOnlineSessionSnapshotItem;

type TestSessionContext = {
  peerDeviceId: string;
  membershipRevision: string;
};
type Receiver = ReturnType<typeof createPeerOnlineCheckpointReceiver>;
type ReceiverInput = Parameters<Receiver["receive"]>[0];
type ReceiverResult = Awaited<ReturnType<Receiver["receive"]>>;

function receiveWithSessionContext(
  receiver: Receiver,
  input: ReceiverInput,
  sessionContext: TestSessionContext | undefined
): Promise<ReceiverResult> {
  const receive = receiver.receive as unknown as (
    input: ReceiverInput,
    sessionContext?: TestSessionContext
  ) => Promise<ReceiverResult>;
  return receive(input, sessionContext);
}

describe.skipIf(!url)("peer online checkpoint receiver", () => {
  const name = `koed_receiver_${randomUUID().replaceAll("-", "")}`;
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
  });

  async function fixture(options: { bindOwner?: boolean } = {}) {
    const groupId = randomUUID();
    const owner = randomUUID();
    const a = device("a", 1);
    const b = device("b", 2);
    const c = device("c", 3);
    const genesis = decision(
      {
        protocol: membershipDomain,
        groupId,
        parentHash: null,
        authorDeviceId: "a",
        body: { kind: "genesis", initialMember: a.member }
      },
      a.signing.privateKey
    );
    const anchor = { groupId, genesisHash: genesis.hash };
    const membership = createPeerOnlineMembershipRepository(pool);
    expect((await membership.initialize(anchor, genesis.json)).status).toBe(
      "accepted"
    );
    const addB = decision(
      {
        protocol: membershipDomain,
        groupId,
        parentHash: genesis.hash,
        authorDeviceId: "a",
        body: { kind: "add", target: b.member }
      },
      a.signing.privateKey
    );
    expect((await membership.append(anchor, addB.json)).status).toBe(
      "accepted"
    );
    const add = decision(
      {
        protocol: membershipDomain,
        groupId,
        parentHash: addB.hash,
        authorDeviceId: "a",
        body: { kind: "add", target: c.member }
      },
      a.signing.privateKey
    );
    expect((await membership.append(anchor, add.json)).status).toBe("accepted");
    await pool.query("insert into users(id,email) values($1,$2)", [
      owner,
      `${owner}@example.test`
    ]);
    if (options.bindOwner !== false)
      await bindPeerOnlineGroupOwner(pool, anchor, owner);
    const identity = {
      groupId,
      originDeviceId: "a",
      originSessionId: encoded(3)
    };
    const binding = signPeerOnlineBinding(
      identity,
      source,
      a.signing.privateKey
    );
    const authority = {
      groupId,
      head: add.hash,
      members: [a.member, b.member, c.member].map(
        ({ deviceId, encryptionSpkiSha256 }) => ({
          deviceId,
          encryptionSpkiSha256
        })
      )
    };
    const recipients = [
      { deviceId: "a", publicKey: a.encryption.publicKey },
      { deviceId: "b", publicKey: b.encryption.publicKey },
      { deviceId: "c", publicKey: c.encryption.publicKey }
    ];
    const seal = (
      sequence: string,
      predecessorHash: string | null,
      items: PeerOnlineSessionSnapshotItem[],
      sourceSession = source,
      membershipHeadHash = add.hash,
      members = authority.members
    ) => {
      const activeDeviceIds = new Set(members.map((member) => member.deviceId));
      return sealPeerOnlineCheckpoint({
        context: {
          ...identity,
          membershipHeadHash,
          bindingHash: binding.bindingHash,
          sequence,
          predecessorHash
        },
        snapshot: { sourceSession, items },
        authority: { ...authority, head: membershipHeadHash, members },
        recipients: recipients.filter((recipient) =>
          activeDeviceIds.has(recipient.deviceId)
        ),
        signingKey: a.signing.privateKey
      });
    };
    const receiver = createPeerOnlineCheckpointReceiver(pool, {
      anchor,
      deviceId: "b",
      encryptionPrivateKey: b.encryption.privateKey
    });
    const defaultContext = {
      peerDeviceId: "a",
      membershipRevision: add.hash
    };
    const receive = (
      sealed: { envelope: string; payload: Buffer },
      sessionContext: TestSessionContext | undefined = defaultContext
    ) =>
      receiveWithSessionContext(
        receiver,
        { bindingJson: binding.json, ...sealed },
        sessionContext
      );
    const createMemberAdd = (
      next: ReturnType<typeof device>,
      parentHash = add.hash
    ) =>
      decision(
        {
          protocol: membershipDomain,
          groupId,
          parentHash,
          authorDeviceId: "a",
          body: { kind: "add", target: next.member }
        },
        a.signing.privateKey
      );
    const appendMember = async (
      next: ReturnType<typeof device>,
      parentHash = add.hash
    ) => {
      const record = createMemberAdd(next, parentHash);
      expect((await membership.append(anchor, record.json)).status).toBe(
        "accepted"
      );
      return record;
    };
    const replicaItems = async () =>
      (
        await pool.query<{ raw_json: { content: string } }>(
          `select c.raw_json from peer_online_replicas r
           join conversation_items c on c.session_id=r.local_session_id
           where r.group_id=$1 and r.session_key=$2 order by c.source_sequence`,
          [groupId, binding.sessionKey]
        )
      ).rows.map((row) => row.raw_json.content);
    const receipts = async () =>
      (
        await pool.query<{ sequence: string }>(
          "select sequence from peer_online_checkpoints where group_id=$1 and session_key=$2 order by sequence",
          [groupId, binding.sessionKey]
        )
      ).rows.map((row) => row.sequence);
    return {
      a,
      b,
      c,
      anchor,
      add,
      defaultContext,
      authority,
      owner,
      binding,
      membership,
      seal,
      receive,
      appendMember,
      createMemberAdd,
      receiver,
      replicaItems,
      receipts
    };
  }

  it("materializes an appended read-only replica and acknowledges only committed checkpoints", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    const result = await f.receive(first);
    expect(result).toEqual({
      status: "accepted",
      ack: { sessionKey: f.binding.sessionKey, sequence: "0", hash: first.hash }
    });
    const second = f.seal("1", first.hash, [item(0), item(1)]);
    expect((await f.receive(second)).status).toBe("accepted");
    expect(await f.replicaItems()).toEqual(["message 0", "message 1"]);
    expect(await f.receive(second)).toEqual({
      status: "duplicate",
      ack: {
        sessionKey: f.binding.sessionKey,
        sequence: "1",
        hash: second.hash
      }
    });
    expect(await f.replicaItems()).toEqual(["message 0", "message 1"]);
    const owners = await pool.query<{ owner_user_id: string }>(
      "select s.owner_user_id from peer_online_replicas r join sessions s on s.id=r.local_session_id where r.session_key=$1",
      [f.binding.sessionKey]
    );
    expect(owners.rows[0]?.owner_user_id).toBe(f.owner);
    await expect(
      pool.query(
        "update conversation_items set source_hash='changed' where session_id=(select local_session_id from peer_online_replicas where session_key=$1)",
        [f.binding.sessionKey]
      )
    ).rejects.toThrow(/read-only/);
  });

  it("accepts a checkpoint from an active transport peer distinct from its signed origin", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    const result = await f.receive(first, {
      peerDeviceId: "c",
      membershipRevision: f.add.hash
    });
    expect(result.status).toBe("accepted");
    expect(await f.receipts()).toEqual(["0"]);
    expect(await f.replicaItems()).toEqual(["message 0"]);
  });

  it("fences a checkpoint when the membership head changes after authentication", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    const context = {
      peerDeviceId: "a",
      membershipRevision: f.add.hash
    };
    await f.appendMember(device("d", 4));
    expect(await f.receive(first, context)).toEqual({ status: "fenced" });
    expect(await f.receipts()).toEqual([]);
    expect(await f.replicaItems()).toEqual([]);
  });

  it("fences an inactive or unknown transport peer before writing", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    expect(
      await f.receive(first, {
        peerDeviceId: "unknown",
        membershipRevision: f.add.hash
      })
    ).toEqual({ status: "fenced" });
    expect(await f.receipts()).toEqual([]);
    expect(await f.replicaItems()).toEqual([]);
  });

  it("fences a revoked transport peer at the current membership revision", async () => {
    const f = await fixture();
    const revocation = decision(
      {
        protocol: membershipDomain,
        groupId: f.anchor.groupId,
        parentHash: f.add.hash,
        authorDeviceId: "a",
        body: { kind: "revoke", targetDeviceId: "c" }
      },
      f.a.signing.privateKey
    );
    expect((await f.membership.append(f.anchor, revocation.json)).status).toBe(
      "accepted"
    );
    const currentMembers = f.authority.members.filter(
      (member) => member.deviceId !== "c"
    );
    const first = f.seal(
      "0",
      null,
      [item(0)],
      undefined,
      revocation.hash,
      currentMembers
    );
    expect(
      await f.receive(first, {
        peerDeviceId: "c",
        membershipRevision: revocation.hash
      })
    ).toEqual({ status: "fenced" });
    expect(await f.receipts()).toEqual([]);
    expect(await f.replicaItems()).toEqual([]);
  });

  it("fences checkpoint receipt when membership evidence has a sibling fork", async () => {
    const f = await fixture();
    await f.appendMember(device("d", 4));
    await f.appendMember(device("e", 5));
    const first = f.seal("0", null, [item(0)]);
    expect(
      await f.receive(first, {
        peerDeviceId: "a",
        membershipRevision: f.add.hash
      })
    ).toEqual({ status: "fenced" });
    expect(await f.receipts()).toEqual([]);
    expect(await f.replicaItems()).toEqual([]);
  });

  it("fences checkpoint receipt when membership is incomplete", async () => {
    const f = await fixture();
    let parent = f.add.hash;
    for (let index = 0; index < 125; index++) {
      const record = await f.appendMember(
        device(`limit-${index}`, index + 4),
        parent
      );
      parent = record.hash;
    }
    const overflow = device("overflow", 999);
    const attempt = {
      attemptId: randomUUID(),
      expectedHead: parent,
      approverDeviceId: "a",
      target: overflow.member,
      expiresAt: new Date(Date.now() + 60_000)
    };
    await f.membership.createAdmissionAttempt(f.anchor, attempt);
    const authorization = {
      ...attempt,
      groupId: f.anchor.groupId,
      transcriptHash: "verified"
    } as import("../src/peer-online-membership-repository.js").VerifiedPeerAdmissionAuthorization;
    const overflowRecord = f.createMemberAdd(overflow, parent);
    expect(
      (await f.membership.admit(f.anchor, authorization, overflowRecord.json))
        .status
    ).toBe("limit");
    expect((await f.membership.load(f.anchor)).incomplete).toBe(true);
    const first = f.seal("0", null, [item(0)]);
    expect(
      await f.receive(first, {
        peerDeviceId: "a",
        membershipRevision: parent
      })
    ).toEqual({ status: "fenced" });
    expect(await f.receipts()).toEqual([]);
    expect(await f.replicaItems()).toEqual([]);
  }, 120_000);

  it("does not trust a session context embedded in wire input", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    const input = {
      bindingJson: f.binding.json,
      ...first,
      sessionContext: {
        peerDeviceId: "a",
        membershipRevision: f.add.hash
      }
    } as ReceiverInput;
    expect(
      await receiveWithSessionContext(f.receiver, input, undefined)
    ).toEqual({ status: "fenced" });
    expect(await f.receipts()).toEqual([]);
    expect(await f.replicaItems()).toEqual([]);
  });

  it("fences a duplicate receipt when its session revision has gone stale", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    const context = {
      peerDeviceId: "a",
      membershipRevision: f.add.hash
    };
    expect((await f.receive(first, context)).status).toBe("accepted");
    await f.appendMember(device("d", 4));
    expect(await f.receive(first, context)).toEqual({ status: "fenced" });
    expect(await f.receipts()).toEqual(["0"]);
    expect(await f.replicaItems()).toEqual(["message 0"]);
  });

  it("rejects a new checkpoint while restore-quarantined without writes", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    await declarePeerOnlineRestoreQuarantine(
      pool,
      f.anchor,
      "restore detected"
    );
    await expect(f.receive(first)).rejects.toThrow(
      "peer online group quarantined after restore"
    );
    expect(await f.receipts()).toEqual([]);
    expect(await f.replicaItems()).toEqual([]);
  });

  it("rejects a duplicate checkpoint while restore-quarantined without another ACK", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    expect((await f.receive(first)).status).toBe("accepted");
    const beforeItems = await f.replicaItems();
    await declarePeerOnlineRestoreQuarantine(
      pool,
      f.anchor,
      "restore detected"
    );
    await expect(f.receive(first)).rejects.toThrow(
      "peer online group quarantined after restore"
    );
    expect(await f.receipts()).toEqual(["0"]);
    expect(await f.replicaItems()).toEqual(beforeItems);
  });

  it("blocks group-owner binding while restore-quarantined", async () => {
    const f = await fixture({ bindOwner: false });
    await declarePeerOnlineRestoreQuarantine(
      pool,
      f.anchor,
      "restore detected"
    );
    await expect(
      bindPeerOnlineGroupOwner(pool, f.anchor, f.owner)
    ).rejects.toThrow("peer online group quarantined after restore");
    const owners = await pool.query(
      "select 1 from peer_online_group_owners where group_id=$1",
      [f.anchor.groupId]
    );
    expect(owners.rowCount).toBe(0);
  });

  it("keeps an out-of-order checkpoint pending until its predecessor commits", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    const second = f.seal("1", first.hash, [item(0), item(1)]);
    expect(await f.receive(second)).toEqual({ status: "pending" });
    expect(await f.receipts()).toEqual([]);
    expect((await f.receive(first)).status).toBe("accepted");
    expect((await f.receive(second)).status).toBe("accepted");
    expect(await f.receipts()).toEqual(["0", "1"]);
  });

  it("rolls back the receipt when the origin rewrites history", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    expect((await f.receive(first)).status).toBe("accepted");
    const rewritten = f.seal("1", first.hash, [item(0, "edited"), item(1)]);
    expect(await f.receive(rewritten)).toEqual({ status: "invalid" });
    expect(await f.receipts()).toEqual(["0"]);
    expect(await f.replicaItems()).toEqual(["message 0"]);
  });

  it("rejects a snapshot whose source identity is not the signed binding's", async () => {
    const f = await fixture();
    const forged = f.seal("0", null, [item(0)], {
      ...source,
      externalSessionId: "someone-else"
    });
    expect(await f.receive(forged)).toEqual({ status: "invalid" });
    expect(await f.receipts()).toEqual([]);
  });

  it("rejects tampered ciphertext without storing a receipt", async () => {
    const f = await fixture();
    const sealed = f.seal("0", null, [item(0)]);
    const payload = Buffer.from(sealed.payload);
    expect(payload.length).toBeGreaterThanOrEqual(2);
    payload[payload.length - 2] = payload[payload.length - 2]! ^ 1;
    expect(
      (
        await f.receiver.receive(
          {
            bindingJson: f.binding.json,
            envelope: sealed.envelope,
            payload
          },
          f.defaultContext
        )
      ).status
    ).toBe("invalid");
    expect(await f.receipts()).toEqual([]);
  });

  it("never accepts its own Sessions back as replicas", async () => {
    const f = await fixture();
    const self = createPeerOnlineCheckpointReceiver(pool, {
      anchor: f.anchor,
      deviceId: "a",
      encryptionPrivateKey: f.a.encryption.privateKey
    });
    const sealed = f.seal("0", null, [item(0)]);
    expect(
      await self.receive(
        { bindingJson: f.binding.json, ...sealed },
        { peerDeviceId: "b", membershipRevision: f.add.hash }
      )
    ).toEqual({ status: "invalid" });
    expect(await f.receipts()).toEqual([]);
  });

  it("is fenced without an owner binding and after this device is revoked", async () => {
    const unbound = await fixture({ bindOwner: false });
    expect(await unbound.receive(unbound.seal("0", null, [item(0)]))).toEqual({
      status: "fenced"
    });
    const f = await fixture();
    const sealed = f.seal("0", null, [item(0)]);
    const revoke = decision(
      {
        protocol: membershipDomain,
        groupId: f.anchor.groupId,
        parentHash: f.add.hash,
        authorDeviceId: "a",
        body: { kind: "revoke", targetDeviceId: "b" }
      },
      f.a.signing.privateKey
    );
    expect((await f.membership.append(f.anchor, revoke.json)).status).toBe(
      "accepted"
    );
    expect(await f.receive(sealed)).toEqual({ status: "fenced" });
    expect(await f.receipts()).toEqual([]);
  });

  it("hides a materialized replica on group-wide deletion and blocks resurrection", async () => {
    const f = await fixture();
    const first = f.seal("0", null, [item(0)]);
    expect((await f.receive(first)).status).toBe("accepted");
    const deletionDomain = "koed/peer-online-deletion/v1";
    const unsigned = {
      protocol: deletionDomain,
      groupId: f.anchor.groupId,
      originDeviceId: "a",
      originSessionId: encoded(3),
      sessionKey: f.binding.sessionKey,
      authorDeviceId: "a",
      membershipHeadHash: f.add.hash,
      eventId: encoded(9)
    };
    const deletion = canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(`${deletionDomain}\n${canonicalizePdsJson(unsigned)}`),
        f.a.signing.privateKey
      ).toString("base64url")
    });
    expect(
      (
        await createPeerOnlineFloorRepository(pool).acceptDeletion(
          f.anchor,
          f.binding.json,
          deletion,
          "b",
          f.defaultContext
        )
      ).status
    ).toBe("accepted");
    const visible = await pool.query<{ live: string }>(
      `select count(*)::text as live from peer_online_replicas r
       join conversation_items c on c.session_id=r.local_session_id
       join sessions s on s.id=r.local_session_id
       where r.session_key=$1 and c.personal_deleted_at is null and s.personal_deleted_at is null`,
      [f.binding.sessionKey]
    );
    expect(visible.rows[0]?.live).toBe("0");
    expect(await f.receive(first)).toEqual({ status: "deleted" });
    expect(
      await f.receive(f.seal("1", first.hash, [item(0), item(1)]))
    ).toEqual({ status: "deleted" });
  });

  it("refuses to rebind a group to a different owner", async () => {
    const f = await fixture();
    const other = randomUUID();
    await pool.query("insert into users(id,email) values($1,$2)", [
      other,
      `${other}@example.test`
    ]);
    await expect(
      bindPeerOnlineGroupOwner(pool, f.anchor, other)
    ).rejects.toThrow(/different owner/);
    await expect(
      pool.query(
        "update peer_online_group_owners set owner_user_id=$2 where group_id=$1",
        [f.anchor.groupId, other]
      )
    ).rejects.toThrow(/immutable/);
  });
});
