import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizePdsJson, type PeerMembershipAnchor } from "@koed/shared";
import {
  createPeerOnlineAuthMembershipLookup,
  createPeerOnlineMembershipRepository,
  type PeerOnlineAuthMembershipLookup
} from "../src/index.js";
import { runDbMigrations } from "../src/migrate.js";
import { bindPeerOnlineGroupOwner } from "../src/peer-online-receiver.js";
import { declarePeerOnlineRestoreQuarantine } from "../src/peer-online-restore-quarantine.js";

const url = process.env.PEER_ONLINE_MEMBERSHIP_TEST_DATABASE_URL;
const protocol = "koed/peer-online-membership/v2";
function device(deviceId: string) {
  const keys = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const encryptionSpki = encryption.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  return {
    deviceId,
    signingPublicKey: keys.publicKey.export({ format: "jwk" }).x!,
    encryptionSpki,
    encryptionSpkiSha256: createHash("sha256")
      .update(Buffer.from(encryptionSpki, "base64url"))
      .digest("base64url"),
    transportSpkiSha256: createHash("sha256")
      .update(`transport:${deviceId}`)
      .digest("base64url"),
    privateKey: keys.privateKey
  };
}
function record(
  author: ReturnType<typeof device>,
  parentHash: string | null,
  body: object,
  groupId: string
) {
  const unsigned = {
    protocol,
    groupId,
    parentHash,
    authorDeviceId: author.deviceId,
    body
  };
  const text = canonicalizePdsJson(unsigned);
  return {
    hash: createHash("sha256")
      .update(`${protocol}/record\n${text}`)
      .digest("base64url"),
    json: canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(`${protocol}/decision\n${text}`),
        author.privateKey
      ).toString("base64url")
    })
  };
}
const member = (d: ReturnType<typeof device>) => ({
  deviceId: d.deviceId,
  signingPublicKey: d.signingPublicKey,
  encryptionSpki: d.encryptionSpki,
  encryptionSpkiSha256: d.encryptionSpkiSha256,
  transportSpkiSha256: d.transportSpkiSha256
});

async function createOwnerUser(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "insert into users (email, display_name) values ($1, $2) returning id",
    [`peer-online-owner-${randomUUID()}@example.com`, "Peer Online Owner"]
  );
  return result.rows[0]!.id;
}

async function createActiveMembershipFixture(
  pool: pg.Pool,
  { bindOwner = true }: { bindOwner?: boolean } = {}
) {
  const groupId = randomUUID();
  const local = device("local");
  const peer = device("peer");
  const genesis = record(
    local,
    null,
    { kind: "genesis", initialMember: member(local) },
    groupId
  );
  const addition = record(
    local,
    genesis.hash,
    { kind: "add", target: member(peer) },
    groupId
  );
  const anchor = { groupId, genesisHash: genesis.hash };
  const repo = createPeerOnlineMembershipRepository(pool);
  await repo.initialize(anchor, genesis.json);
  await repo.append(anchor, addition.json);
  const ownerUserId = await createOwnerUser(pool);
  if (bindOwner) await bindPeerOnlineGroupOwner(pool, anchor, ownerUserId);
  return { anchor, local, peer, ownerUserId, repo, head: addition.hash };
}

function createAuthMembershipLookup(
  pool: pg.Pool,
  anchor: PeerMembershipAnchor,
  expectedOwnerUserId: string
): PeerOnlineAuthMembershipLookup {
  return createPeerOnlineAuthMembershipLookup(pool, {
    anchor,
    expectedOwnerUserId
  });
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  description: string
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe.skipIf(!url)("durable peer membership", () => {
  const name = `koed_peer_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  const target = new URL(url ?? "postgresql://localhost/postgres");
  target.pathname = `/${name}`;
  const pool = new pg.Pool({
    connectionString: target.toString(),
    application_name: name,
    max: 3,
    connectionTimeoutMillis: 5000
  });
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
  it("blocks membership mutations while restore-quarantined but keeps reads available", async () => {
    const groupId = randomUUID();
    const a = device("a");
    const b = device("b");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const add = record(
      a,
      genesis.hash,
      { kind: "add", target: member(b) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash };
    const repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    const attempt = {
      attemptId: randomUUID(),
      expectedHead: genesis.hash,
      approverDeviceId: a.deviceId,
      target: member(b),
      expiresAt: new Date(Date.now() + 60000)
    };
    await repo.createAdmissionAttempt(anchor, attempt);
    await declarePeerOnlineRestoreQuarantine(pool, anchor, "restore detected");
    const authorization = {
      ...attempt,
      groupId,
      transcriptHash: "verified-transcript"
    } as import("../src/peer-online-membership-repository.js").VerifiedPeerAdmissionAuthorization;

    await expect(repo.initialize(anchor, genesis.json)).rejects.toThrow(
      "peer online group quarantined after restore"
    );
    await expect(repo.append(anchor, add.json)).rejects.toThrow(
      "peer online group quarantined after restore"
    );
    await expect(
      repo.createAdmissionAttempt(anchor, {
        ...attempt,
        attemptId: randomUUID()
      })
    ).rejects.toThrow("peer online group quarantined after restore");
    await expect(repo.admit(anchor, authorization, add.json)).rejects.toThrow(
      "peer online group quarantined after restore"
    );
    expect((await repo.load(anchor)).records).toHaveLength(1);
    const attempts = await pool.query(
      "select attempt_id from peer_online_admission_attempts where group_id=$1",
      [groupId]
    );
    expect(attempts.rowCount).toBe(1);
  });

  it("atomically admits once and returns the same outcome after a lost response", async () => {
    const groupId = randomUUID(),
      a = device("a"),
      b = device("b");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const add = record(
      a,
      genesis.hash,
      { kind: "add", target: member(b) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash };
    const repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    const attempt = {
      attemptId: randomUUID(),
      expectedHead: genesis.hash,
      approverDeviceId: "a",
      target: member(b),
      expiresAt: new Date(Date.now() + 2000)
    };
    await repo.createAdmissionAttempt(anchor, attempt);
    const authorization = {
      ...attempt,
      groupId,
      transcriptHash: "verified-transcript"
    } as import("../src/peer-online-membership-repository.js").VerifiedPeerAdmissionAuthorization;
    const results = await Promise.all([
      repo.admit(anchor, authorization, add.json),
      repo.admit(anchor, authorization, add.json)
    ]);
    expect(results).toEqual([
      { status: "historical_receipt", hash: add.hash },
      { status: "historical_receipt", hash: add.hash }
    ]);
    expect((await repo.load(anchor)).records).toHaveLength(2);
    const revoke = record(
      a,
      add.hash,
      { kind: "revoke", targetDeviceId: "b" },
      groupId
    );
    expect((await repo.append(anchor, revoke.json)).status).toBe("accepted");
    expect(
      (await repo.load(anchor)).members.map((entry) => entry.deviceId)
    ).not.toContain("b");
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, attempt.expiresAt.getTime() - Date.now() + 50)
      )
    );
    await repo.createAdmissionAttempt(anchor, {
      ...attempt,
      attemptId: randomUUID(),
      expectedHead: revoke.hash,
      expiresAt: new Date(Date.now() + 60000)
    });
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "select count(*)::int as count from peer_online_admission_attempts where group_id=$1",
          [groupId]
        )
      ).rows[0].count
    ).toBe(2);
    expect(
      await createPeerOnlineMembershipRepository(pool).admit(
        anchor,
        authorization,
        add.json
      )
    ).toEqual(results[0]);
    await expect(
      repo.admit(
        anchor,
        { ...authorization, transcriptHash: "other" },
        add.json
      )
    ).rejects.toThrow("already consumed");
  });
  it("rolls back membership and attempt when outcome persistence fails", async () => {
    const groupId = randomUUID(),
      a = device("a"),
      b = device("b");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash },
      repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    const attempt = {
      attemptId: randomUUID(),
      expectedHead: genesis.hash,
      approverDeviceId: "a",
      target: member(b),
      expiresAt: new Date(Date.now() + 60000)
    };
    await repo.createAdmissionAttempt(anchor, attempt);
    const auth = {
      ...attempt,
      groupId,
      transcriptHash: "verified"
    } as import("../src/peer-online-membership-repository.js").VerifiedPeerAdmissionAuthorization;
    const add = record(
      a,
      genesis.hash,
      { kind: "add", target: member(b) },
      groupId
    );
    // Use a table constraint to inject failure on every pooled connection.
    await pool.query(
      `alter table peer_online_admission_attempts add constraint test_reject_outcome check (outcome_hash is null) not valid`
    );
    try {
      await expect(repo.admit(anchor, auth, add.json)).rejects.toThrow();
      expect((await repo.load(anchor)).records).toHaveLength(1);
    } finally {
      await pool.query(
        `alter table peer_online_admission_attempts drop constraint test_reject_outcome`
      );
    }
    expect(await repo.admit(anchor, auth, add.json)).toEqual({
      status: "historical_receipt",
      hash: add.hash
    });
  });
  it("rejects expired, stale, mismatched and unsigned admissions without consuming them", async () => {
    const groupId = randomUUID(),
      a = device("a"),
      b = device("b"),
      c = device("c");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash };
    const repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    const base = {
      attemptId: randomUUID(),
      expectedHead: genesis.hash,
      approverDeviceId: "a",
      target: member(b),
      expiresAt: new Date(Date.now() + 60000)
    };
    const auth = (attempt: typeof base) =>
      ({
        ...attempt,
        groupId,
        transcriptHash: "verified"
      }) as import("../src/peer-online-membership-repository.js").VerifiedPeerAdmissionAuthorization;
    const add = record(
      a,
      genesis.hash,
      { kind: "add", target: member(b) },
      groupId
    );
    const expired = {
      ...base,
      attemptId: randomUUID(),
      expiresAt: new Date(Date.now() - 1000)
    };
    await expect(repo.createAdmissionAttempt(anchor, expired)).rejects.toThrow(
      "invalid admission expiry"
    );
    await expect(
      repo.createAdmissionAttempt(anchor, {
        ...base,
        expiresAt: new Date(Date.now() + 86400000)
      })
    ).rejects.toThrow("invalid admission expiry");
    await repo.createAdmissionAttempt(anchor, base);
    await expect(
      repo.admit(anchor, auth({ ...base, target: member(c) }), add.json)
    ).rejects.toThrow("invalid admission authorization");
    await expect(
      repo.admit(
        anchor,
        auth(base),
        record(c, genesis.hash, { kind: "add", target: member(b) }, groupId)
          .json
      )
    ).rejects.toThrow("invalid admission evidence");
    await expect(
      repo.admit(
        anchor,
        auth(base),
        record(a, genesis.hash, { kind: "add", target: member(c) }, groupId)
          .json
      )
    ).rejects.toThrow("does not match");
    expect((await repo.load(anchor)).records).toHaveLength(1);
    await repo.append(
      anchor,
      record(a, genesis.hash, { kind: "add", target: member(c) }, groupId).json
    );
    await expect(repo.admit(anchor, auth(base), add.json)).rejects.toThrow(
      "expired or stale"
    );
    expect((await repo.load(anchor)).conflict).toBe(false);
  });
  it("cleans expired unused attempts without reviving old authorizations", async () => {
    const groupId = randomUUID(),
      a = device("a"),
      b = device("b");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash },
      repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    const attempt = {
      attemptId: randomUUID(),
      expectedHead: genesis.hash,
      approverDeviceId: "a",
      target: member(b),
      expiresAt: new Date(Date.now() + 60000)
    };
    await repo.createAdmissionAttempt(anchor, attempt);
    await pool.query(
      "update peer_online_admission_attempts set expires_at=clock_timestamp()-interval '1 second' where group_id=$1",
      [groupId]
    );
    await repo.createAdmissionAttempt(anchor, {
      ...attempt,
      expiresAt: new Date(Date.now() + 120000)
    });
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "select attempt_id from peer_online_admission_attempts where group_id=$1",
          [groupId]
        )
      ).rows
    ).toHaveLength(1);
    await expect(
      repo.admit(
        anchor,
        {
          ...attempt,
          groupId,
          transcriptHash: "verified"
        } as import("../src/peer-online-membership-repository.js").VerifiedPeerAdmissionAuthorization,
        record(a, genesis.hash, { kind: "add", target: member(b) }, groupId)
          .json
      )
    ).rejects.toThrow("invalid admission authorization");
  });
  it("serializes competing admissions without creating a fork", async () => {
    const groupId = randomUUID(),
      a = device("a"),
      b = device("b"),
      c = device("c");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash },
      repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    const attempt = (target: ReturnType<typeof device>) => ({
      attemptId: randomUUID(),
      expectedHead: genesis.hash,
      approverDeviceId: "a",
      target: member(target),
      expiresAt: new Date(Date.now() + 60000)
    });
    const x = attempt(b),
      y = attempt(c);
    await repo.createAdmissionAttempt(anchor, x);
    await repo.createAdmissionAttempt(anchor, y);
    const auth = (v: typeof x) =>
      ({
        ...v,
        groupId,
        transcriptHash: "verified"
      }) as import("../src/peer-online-membership-repository.js").VerifiedPeerAdmissionAuthorization;
    const results = await Promise.allSettled([
      repo.admit(
        anchor,
        auth(x),
        record(a, genesis.hash, { kind: "add", target: member(b) }, groupId)
          .json
      ),
      repo.admit(
        anchor,
        auth(y),
        record(a, genesis.hash, { kind: "add", target: member(c) }, groupId)
          .json
      )
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await repo.load(anchor)).conflict).toBe(false);
  });
  it("serializes forks, survives restart and rejects untrusted input", async () => {
    const groupId = randomUUID();
    const a = device("a"),
      b = device("b"),
      c = device("c");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const repo = createPeerOnlineMembershipRepository(pool);
    const anchor = { groupId, genesisHash: genesis.hash };
    expect((await repo.initialize(anchor, genesis.json)).status).toBe(
      "accepted"
    );
    const first = record(
      a,
      genesis.hash,
      { kind: "add", target: member(b) },
      groupId
    );
    const second = record(
      a,
      genesis.hash,
      { kind: "add", target: member(c) },
      groupId
    );
    expect((await repo.append(anchor, "x".repeat(20000))).status).toBe("limit");
    expect(
      (
        await repo.append(
          anchor,
          record(c, genesis.hash, { kind: "add", target: member(c) }, groupId)
            .json
        )
      ).status
    ).toBe("invalid");
    const unknown = record(
      a,
      Buffer.alloc(32, 7).toString("base64url"),
      { kind: "add", target: member(b) },
      groupId
    );
    expect((await repo.append(anchor, unknown.json)).status).toBe("pending");
    expect((await repo.load(anchor)).records).toHaveLength(1);
    expect(
      (
        await Promise.all([
          repo.append(anchor, first.json),
          repo.append(anchor, second.json)
        ])
      ).map((x) => x.status)
    ).toEqual(["accepted", "accepted"]);
    const snapshot =
      await createPeerOnlineMembershipRepository(pool).load(anchor);
    expect(snapshot.conflict).toBe(true);
    expect(snapshot.members).toEqual([]);
    expect(snapshot.records).toHaveLength(3);
    expect((await repo.append(anchor, first.json)).status).toBe("duplicate");
    await expect(
      repo.load({ ...anchor, genesisHash: second.hash })
    ).rejects.toThrow("anchor mismatch");
    await pool.query(
      "update peer_online_membership_evidence set json = 'corrupt' where group_id = $1 and position = 1",
      [groupId]
    );
    await expect(repo.load(anchor)).rejects.toThrow(
      "corrupt peer membership evidence"
    );
  });
  it("rolls back failed evidence writes and retries safely", async () => {
    const groupId = randomUUID(),
      a = device("a"),
      b = device("b");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash };
    const repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    const change = record(
      a,
      genesis.hash,
      { kind: "add", target: member(b) },
      groupId
    );
    await pool.query(
      `create function peer_test_fail() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`
    );
    await pool.query(
      `create trigger peer_test_fail before update on peer_online_membership_groups for each row execute function peer_test_fail()`
    );
    try {
      await expect(repo.append(anchor, change.json)).rejects.toThrow(
        "injected failure"
      );
    } finally {
      await pool.query(
        "drop trigger peer_test_fail on peer_online_membership_groups"
      );
      await pool.query("drop function peer_test_fail()");
    }
    expect((await repo.load(anchor)).records).toHaveLength(1);
    expect((await repo.append(anchor, change.json)).status).toBe("accepted");
    expect(
      (
        await createPeerOnlineMembershipRepository(pool).load(anchor)
      ).members.map((x) => x.deviceId)
    ).toEqual(["a", "b"]);
  });
  it("rejects excessive counts and oversized stored payloads before replay", async () => {
    const groupId = randomUUID(),
      a = device("a");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash };
    const repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    await pool.query(
      "update peer_online_membership_groups set record_count = 0 where group_id = $1",
      [groupId]
    );
    await expect(repo.load(anchor)).rejects.toThrow(
      "peer membership storage bounds exceeded"
    );
    await pool.query(
      "update peer_online_membership_groups set record_count = 1025 where group_id = $1",
      [groupId]
    );
    await expect(repo.load(anchor)).rejects.toThrow(
      "peer membership storage bounds exceeded"
    );
    await pool.query(
      "update peer_online_membership_groups set record_count = 1, limit_evidence = repeat('x', 16385) where group_id = $1",
      [groupId]
    );
    await expect(repo.load(anchor)).rejects.toThrow(
      "peer membership storage bounds exceeded"
    );
    await pool.query(
      "update peer_online_membership_groups set limit_evidence = null where group_id = $1",
      [groupId]
    );
    await pool.query(
      "update peer_online_membership_evidence set json = repeat('x', 16385) where group_id = $1",
      [groupId]
    );
    await expect(repo.load(anchor)).rejects.toThrow(
      "peer membership storage bounds exceeded"
    );
    await pool.query(
      "update peer_online_membership_evidence set json = $2 where group_id = $1",
      [groupId, genesis.json]
    );
    await pool.query(
      "insert into peer_online_membership_evidence values ($1, 1, 'extra', '{}')",
      [groupId]
    );
    await expect(repo.load(anchor)).rejects.toThrow(
      "corrupt peer membership evidence"
    );
    await pool.query(
      "delete from peer_online_membership_evidence where group_id = $1 and position = 1",
      [groupId]
    );
    await pool.query(
      "update peer_online_membership_groups set conflict = true where group_id = $1",
      [groupId]
    );
    await expect(repo.load(anchor)).rejects.toThrow(
      "corrupt peer membership evidence"
    );
    await pool.query(
      "update peer_online_membership_groups set conflict = false where group_id = $1",
      [groupId]
    );
    await pool.query(
      "update peer_online_membership_evidence set position = 2 where group_id = $1",
      [groupId]
    );
    await expect(repo.load(anchor)).rejects.toThrow(
      "corrupt peer membership evidence"
    );
  });
  it("uses read committed under repeatable-read pool defaults and serializes siblings", async () => {
    const strictPool = new pg.Pool({
      connectionString: target.toString(),
      application_name: name,
      options: "-c default_transaction_isolation=repeatable\\ read"
    });
    const groupId = randomUUID(),
      a = device("a"),
      b = device("b"),
      c = device("c");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash };
    const repo = createPeerOnlineMembershipRepository(strictPool);
    await pool.query(
      `create function peer_test_isolation() returns trigger language plpgsql as $$ begin if current_setting('transaction_isolation') <> 'read committed' then raise exception 'wrong isolation'; end if; return new; end $$`
    );
    await pool.query(
      `create trigger peer_test_isolation before update on peer_online_membership_groups for each row execute function peer_test_isolation()`
    );
    try {
      await repo.initialize(anchor, genesis.json);
      const first = record(
        a,
        genesis.hash,
        { kind: "add", target: member(b) },
        groupId
      );
      const second = record(
        a,
        genesis.hash,
        { kind: "add", target: member(c) },
        groupId
      );
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`koed:peer-online-membership:${groupId}`]
        );
        const attempts = Promise.all([
          repo.append(anchor, first.json),
          repo.append(anchor, second.json)
        ]);
        try {
          let waiting = 0;
          for (let i = 0; i < 100 && waiting < 2; i++) {
            waiting = Number(
              (
                await pool.query<{ count: string }>(
                  "select count(*) from pg_stat_activity where application_name = $1 and wait_event = 'advisory'",
                  [name]
                )
              ).rows[0]!.count
            );
            if (waiting < 2)
              await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(waiting).toBe(2);
        } finally {
          await blocker.query("commit");
        }
        expect((await attempts).map((x) => x.status)).toEqual([
          "accepted",
          "accepted"
        ]);
      } finally {
        blocker.release();
      }
      expect((await repo.load(anchor)).conflict).toBe(true);
    } finally {
      await strictPool.end();
      await pool.query(
        "drop trigger peer_test_isolation on peer_online_membership_groups"
      );
      await pool.query("drop function peer_test_isolation()");
    }
  });
  it("persists authenticated member limit evidence and fails closed after restart", async () => {
    const groupId = randomUUID(),
      a = device("a");
    const genesis = record(
      a,
      null,
      { kind: "genesis", initialMember: member(a) },
      groupId
    );
    const anchor = { groupId, genesisHash: genesis.hash };
    const repo = createPeerOnlineMembershipRepository(pool);
    await repo.initialize(anchor, genesis.json);
    let parent = genesis.hash;
    for (let i = 0; i < 127; i++) {
      const change = record(
        a,
        parent,
        { kind: "add", target: member(device(`m${i}`)) },
        groupId
      );
      expect((await repo.append(anchor, change.json)).status).toBe("accepted");
      parent = change.hash;
    }
    const joining = device("overflow");
    const attempt = {
      attemptId: randomUUID(),
      expectedHead: parent,
      approverDeviceId: "a",
      target: member(joining),
      expiresAt: new Date(Date.now() + 60000)
    };
    await repo.createAdmissionAttempt(anchor, attempt);
    const auth = {
      ...attempt,
      groupId,
      transcriptHash: "verified"
    } as import("../src/peer-online-membership-repository.js").VerifiedPeerAdmissionAuthorization;
    const expired = { ...attempt, attemptId: randomUUID() };
    await repo.createAdmissionAttempt(anchor, expired);
    expired.expiresAt = new Date(Date.now() - 1000);
    await pool.query(
      "update peer_online_admission_attempts set expires_at=$3 where group_id=$1 and attempt_id=$2",
      [groupId, expired.attemptId, expired.expiresAt]
    );
    const expiredAuth = { ...auth, ...expired };
    const expiredOverflow = record(
      a,
      parent,
      { kind: "add", target: member(joining) },
      groupId
    );
    await expect(
      repo.admit(anchor, expiredAuth, expiredOverflow.json)
    ).rejects.toThrow("expired or stale");
    expect((await repo.load(anchor)).incomplete).toBe(false);
    const mismatch = record(
      a,
      parent,
      { kind: "add", target: member(device("other-overflow")) },
      groupId
    );
    await expect(repo.admit(anchor, auth, mismatch.json)).rejects.toThrow(
      "does not match"
    );
    expect((await repo.load(anchor)).incomplete).toBe(false);
    const overflow = record(
      a,
      parent,
      { kind: "add", target: member(joining) },
      groupId
    );
    expect((await repo.admit(anchor, auth, overflow.json)).status).toBe(
      "limit"
    );
    const view = await createPeerOnlineMembershipRepository(pool).load(anchor);
    expect(view.incomplete).toBe(true);
    expect(view.members).toEqual([]);
    expect(view.limitEvidence).toBe(overflow.json);
    const ownerUserId = await createOwnerUser(pool);
    await bindPeerOnlineGroupOwner(pool, anchor, ownerUserId);
    const lookup = createAuthMembershipLookup(pool, anchor, ownerUserId);
    const actual = await lookup(
      groupId,
      "a",
      "overflow",
      new AbortController().signal
    );
    expect(actual).toBeNull();
  }, 120000);

  it("returns the current active membership snapshot for local and peer devices", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const actual = await lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      fixture.peer.deviceId,
      new AbortController().signal
    );

    expect(actual).toEqual({
      revision: fixture.head,
      local: {
        deviceId: fixture.local.deviceId,
        signingPublicKey: fixture.local.signingPublicKey,
        transportSpkiSha256: fixture.local.transportSpkiSha256
      },
      peer: {
        deviceId: fixture.peer.deviceId,
        signingPublicKey: fixture.peer.signingPublicKey,
        transportSpkiSha256: fixture.peer.transportSpkiSha256
      }
    });
  });

  it("returns null when the requested group differs from the trusted anchor", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const actual = await lookup(
      randomUUID(),
      fixture.local.deviceId,
      fixture.peer.deviceId,
      new AbortController().signal
    );
    expect(actual).toBeNull();
  });

  it("returns null when the trusted genesis hash does not match persisted state", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      { ...fixture.anchor, genesisHash: "wrong-genesis" },
      fixture.ownerUserId
    );
    const actual = await lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      fixture.peer.deviceId,
      new AbortController().signal
    );
    expect(actual).toBeNull();
  });

  it("returns null when the requested local device is unknown", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const actual = await lookup(
      fixture.anchor.groupId,
      "unknown-local",
      fixture.peer.deviceId,
      new AbortController().signal
    );
    expect(actual).toBeNull();
  });

  it("returns null when the requested peer is not an active member", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const actual = await lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      "unknown-peer",
      new AbortController().signal
    );
    expect(actual).toBeNull();
  });

  it.each(["local", "peer"] as const)(
    "returns null when the %s membership is revoked",
    async (revokedDevice) => {
      const fixture = await createActiveMembershipFixture(pool);
      const target = revokedDevice === "local" ? fixture.local : fixture.peer;
      const signer = revokedDevice === "local" ? fixture.peer : fixture.local;
      const revocation = record(
        signer,
        fixture.head,
        { kind: "revoke", targetDeviceId: target.deviceId },
        fixture.anchor.groupId
      );
      await fixture.repo.append(fixture.anchor, revocation.json);
      const lookup = createAuthMembershipLookup(
        pool,
        fixture.anchor,
        fixture.ownerUserId
      );
      const actual = await lookup(
        fixture.anchor.groupId,
        fixture.local.deviceId,
        fixture.peer.deviceId,
        new AbortController().signal
      );
      expect(actual).toBeNull();
    }
  );

  it("returns null when membership evidence contains a sibling fork", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const left = record(
      fixture.local,
      fixture.head,
      { kind: "add", target: member(device("left")) },
      fixture.anchor.groupId
    );
    const right = record(
      fixture.local,
      fixture.head,
      { kind: "add", target: member(device("right")) },
      fixture.anchor.groupId
    );
    await fixture.repo.append(fixture.anchor, left.json);
    await fixture.repo.append(fixture.anchor, right.json);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const actual = await lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      fixture.peer.deviceId,
      new AbortController().signal
    );
    expect(actual).toBeNull();
  });

  it("returns null when the trusted owner differs from the database binding", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      randomUUID()
    );
    const actual = await lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      fixture.peer.deviceId,
      new AbortController().signal
    );
    expect(actual).toBeNull();
  });

  it("returns null when the owner binding is missing", async () => {
    const fixture = await createActiveMembershipFixture(pool, {
      bindOwner: false
    });
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    await expect(
      lookup(
        fixture.anchor.groupId,
        fixture.local.deviceId,
        fixture.peer.deviceId,
        new AbortController().signal
      )
    ).resolves.toBeNull();
  });

  it("returns null when the group is restore-quarantined", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    await declarePeerOnlineRestoreQuarantine(
      pool,
      fixture.anchor,
      "restore detected"
    );
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const actual = await lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      fixture.peer.deviceId,
      new AbortController().signal
    );
    expect(actual).toBeNull();
  });

  it("requires a bounded pool connection timeout", async () => {
    const unboundedPool = new pg.Pool({ connectionString: target.toString() });
    try {
      expect(() =>
        createPeerOnlineAuthMembershipLookup(unboundedPool, {
          anchor: { groupId: randomUUID(), genesisHash: "test-genesis" },
          expectedOwnerUserId: randomUUID()
        })
      ).toThrow("from 1 to 10000");
    } finally {
      await unboundedPool.end();
    }
  });

  it("rejects an already-aborted lookup before acquiring a client", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const controller = new AbortController();
    const reason = new DOMException("lookup cancelled", "AbortError");
    controller.abort(reason);
    await expect(
      lookup(
        fixture.anchor.groupId,
        fixture.local.deviceId,
        fixture.peer.deviceId,
        controller.signal
      )
    ).rejects.toBe(reason);
    expect(pool.waitingCount).toBe(0);
  });

  it("aborts promptly while waiting to acquire a pool client", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const held = await Promise.all(
      Array.from({ length: pool.options.max ?? 3 }, () => pool.connect())
    );
    const controller = new AbortController();
    const reason = new DOMException("lookup cancelled", "AbortError");
    const pending = lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      fixture.peer.deviceId,
      controller.signal
    );
    try {
      await waitForCondition(
        async () => pool.waitingCount === 1,
        "pool client acquisition"
      );
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } finally {
      if (!controller.signal.aborted) controller.abort(reason);
      held.forEach((client) => client.release());
      void pending.catch(() => undefined);
    }
    await waitForCondition(
      async () => pool.waitingCount === 0,
      "aborted pool waiter to drain"
    );
    const recovered = await pool.connect();
    recovered.release();
  });

  it("destroys its client when aborted while waiting on the advisory lock", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`koed:peer-online-membership:${fixture.anchor.groupId}`]
    );
    const controller = new AbortController();
    const reason = new DOMException("lookup cancelled", "AbortError");
    const pending = lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      fixture.peer.deviceId,
      controller.signal
    );
    try {
      await waitForCondition(async () => {
        const result = await pool.query<{ count: string }>(
          `select count(*)::text as count from pg_stat_activity
           where application_name=$1 and wait_event_type='Lock'
             and query like '%pg_advisory_xact_lock%'`,
          [name]
        );
        return Number(result.rows[0]!.count) > 0;
      }, "peer-online advisory lock wait");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } finally {
      if (!controller.signal.aborted) controller.abort(reason);
      await blocker.query("rollback");
      blocker.release();
      void pending.catch(() => undefined);
    }
    const recovered = await pool.connect();
    recovered.release();
  });

  it("destroys its client when aborted during the membership row query", async () => {
    const fixture = await createActiveMembershipFixture(pool);
    const lookup = createAuthMembershipLookup(
      pool,
      fixture.anchor,
      fixture.ownerUserId
    );
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query(
      "select group_id from peer_online_membership_groups where group_id=$1 for update",
      [fixture.anchor.groupId]
    );
    const controller = new AbortController();
    const reason = new DOMException("lookup cancelled", "AbortError");
    const pending = lookup(
      fixture.anchor.groupId,
      fixture.local.deviceId,
      fixture.peer.deviceId,
      controller.signal
    );
    try {
      await waitForCondition(async () => {
        const result = await pool.query<{ count: string }>(
          `select count(*)::text as count from pg_stat_activity
           where application_name=$1 and wait_event_type='Lock'
             and query like '%peer_online_membership_groups%'`,
          [name]
        );
        return Number(result.rows[0]!.count) > 0;
      }, "peer-online membership row lock wait");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } finally {
      if (!controller.signal.aborted) controller.abort(reason);
      await blocker.query("rollback");
      blocker.release();
      void pending.catch(() => undefined);
    }
    const recovered = await pool.connect();
    recovered.release();
  });
});
