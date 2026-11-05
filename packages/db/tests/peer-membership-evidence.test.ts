import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { canonicalizePdsJson } from "../../shared/src/personal-device-sync-jcs.js";
import {
  initialize,
  inspect
} from "../../shared/src/peer-membership-history.test-support.js";
import { createDbPool } from "../src/connection.js";
import { createEvidenceFixture } from "./fixtures/peer-membership-evidence.js";

const url = process.env.PEER_MEMBERSHIP_EVIDENCE_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const key = generateKeyPairSync("ed25519");
const publicKey = key.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64url");
const signRecord = (unsigned: object) => {
  const canonical = canonicalizePdsJson(unsigned);
  return {
    json: canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(`koed/peer-membership/test-v1/decision\n${canonical}`),
        key.privateKey
      ).toString("base64url")
    }),
    hash: createHash("sha256")
      .update("koed/peer-membership/test-v1/record\n")
      .update(canonical)
      .digest("base64url")
  };
};
const genesis = signRecord({
  protocol: "koed/peer-membership/test-v1",
  groupId: "group",
  parentHash: null,
  authorDeviceId: "alice",
  body: {
    kind: "genesis",
    initialMember: { deviceId: "alice", signingPublicKey: publicKey }
  }
});
const anchor = { groupId: "group", genesisHash: genesis.hash };
const add = (deviceId: string) => {
  const target = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  return signRecord({
    protocol: "koed/peer-membership/test-v1",
    groupId: "group",
    parentHash: genesis.hash,
    authorDeviceId: "alice",
    body: { kind: "add", target: { deviceId, signingPublicKey: target } }
  });
};

describeDb("test-only peer membership evidence persistence", () => {
  let schema: string;
  let pool: ReturnType<typeof createDbPool>;
  beforeAll(() => {
    pool = createDbPool({ connectionString: url! });
  });
  beforeEach(async () => {
    schema = `peer_evidence_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`create schema "${schema}"`);
    await createEvidenceFixture(pool, schema, anchor).setup(genesis.json);
  });
  afterEach(async () => {
    await pool.query(`drop schema if exists "${schema}" cascade`);
  });
  afterAll(async () => {
    await pool.end();
  });
  it("replays a committed fork after opening a fresh pool and rolls back incomplete transactions", async () => {
    const first = add("bob");
    const second = add("carol");
    const fixture = createEvidenceFixture(pool, schema, anchor);
    await fixture.append(first.json);
    await expect(
      fixture.append(second.json, { failAfterInsert: true })
    ).rejects.toThrow("injected rollback");
    expect(inspect(await fixture.load()).recordCount).toBe(2);
    await expect(
      fixture.append(second.json, { failBeforeCommit: true })
    ).rejects.toThrow("injected rollback");
    const fresh = createDbPool({ connectionString: url! });
    try {
      const reopened = createEvidenceFixture(fresh, schema, anchor);
      const rolledBack = inspect(await reopened.load());
      expect(rolledBack.conflict).toBe(false);
      expect(rolledBack.recordCount).toBe(2);
      await reopened.append(second.json);
    } finally {
      await fresh.end();
    }
    const freshAgain = createDbPool({ connectionString: url! });
    try {
      const recovered = await createEvidenceFixture(
        freshAgain,
        schema,
        anchor
      ).load();
      expect(inspect(recovered).conflict).toBe(true);
      expect(inspect(recovered).recordCount).toBe(3);
      expect(inspect(recovered).records.map((entry) => entry.evidence)).toEqual(
        [genesis.json, first.json, second.json]
      );
      expect(
        inspect(recovered)
          .records.slice(1)
          .map((entry) => entry.parentHash)
      ).toEqual([genesis.hash, genesis.hash]);
      expect(inspect(recovered).effectiveMembers.size).toBe(0);
    } finally {
      await freshAgain.end();
    }
    expect(initialize(anchor, genesis.json).status).toBe("accepted");
  });
  it("reads status and evidence from a consistent snapshot during a fork commit", async () => {
    const fixture = createEvidenceFixture(pool, schema, anchor);
    await fixture.append(add("first").json);
    let release!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reader = fixture.load(async () => {
      started();
      await paused;
    });
    try {
      await ready;
      await fixture.append(add("second").json);
    } finally {
      release();
    }
    const oldSnapshot = inspect(await reader);
    expect(oldSnapshot.conflict).toBe(false);
    expect(oldSnapshot.recordCount).toBe(2);
    const newSnapshot = inspect(await fixture.load());
    expect(newSnapshot.conflict).toBe(true);
    expect(newSnapshot.recordCount).toBe(3);
  });
  it("serializes concurrent sibling writers without losing evidence", async () => {
    const otherSchema = `peer_evidence_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`create schema "${otherSchema}"`);
    const secondPool = createDbPool({ connectionString: url! });
    try {
      const firstFixture = createEvidenceFixture(pool, otherSchema, anchor);
      const secondFixture = createEvidenceFixture(
        secondPool,
        otherSchema,
        anchor
      );
      await firstFixture.setup(genesis.json);
      let release!: () => void;
      let acquired!: () => void;
      let seenPid!: (pid: number) => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const pidPromise = new Promise<number>((resolve) => {
        seenPid = resolve;
      });
      const first = firstFixture.append(add("dave").json, {
        afterLock: async () => {
          acquired();
          await hold;
        }
      });
      await locked;
      const second = secondFixture.append(add("erin").json, {
        beforeLock: seenPid
      });
      try {
        const pid = await pidPromise;
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i += 1) {
          const result = await pool.query<{ blocked: boolean }>(
            "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
            [pid]
          );
          blocked = result.rows[0]!.blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release();
      }
      expect(await Promise.all([first, second])).toEqual([
        "accepted",
        "accepted"
      ]);
      const replay = inspect(await firstFixture.load());
      expect(replay.conflict).toBe(true);
      expect(replay.recordCount).toBe(3);
      expect(replay.effectiveMembers.size).toBe(0);
    } finally {
      await secondPool.end();
      await pool.query(`drop schema "${otherSchema}" cascade`);
    }
  });
  it("persists an incomplete latch and rejects an incorrect trusted anchor", async () => {
    const fixture = createEvidenceFixture(pool, schema, anchor);
    await expect(
      fixture.append("x".repeat(16385), { failBeforeCommit: true })
    ).rejects.toThrow("injected rollback");
    expect(inspect(await fixture.load()).incomplete).toBe(false);
    expect(await fixture.append("x".repeat(16385))).toBe("limit");
    const fresh = createDbPool({ connectionString: url! });
    try {
      const state = await createEvidenceFixture(fresh, schema, anchor).load();
      expect(inspect(state).incomplete).toBe(true);
      expect(inspect(state).effectiveMembers.size).toBe(0);
      await expect(
        createEvidenceFixture(fresh, schema, {
          ...anchor,
          groupId: "wrong"
        }).load()
      ).rejects.toThrow("invalid genesis evidence");
    } finally {
      await fresh.end();
    }
  });
});
