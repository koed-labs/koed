import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizePdsJson } from "@koed/shared";
import { runDbMigrations } from "../src/migrate.js";
import {
  createPeerOnlineMembershipRepository,
  transaction
} from "../src/peer-online-membership-repository.js";
import {
  assertPeerOnlineNotQuarantined,
  declarePeerOnlineRestoreQuarantine
} from "../src/peer-online-restore-quarantine.js";

const url = process.env.PEER_ONLINE_MEMBERSHIP_TEST_DATABASE_URL;
const membershipDomain = "koed/peer-online-membership/v2";

async function createGroup(pool: pg.Pool) {
  const groupId = randomUUID();
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const encryptionSpki = encryption.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const member = {
    deviceId: "restore-test",
    signingPublicKey: signing.publicKey.export({ format: "jwk" }).x!,
    encryptionSpki,
    encryptionSpkiSha256: createHash("sha256")
      .update(Buffer.from(encryptionSpki, "base64url"))
      .digest("base64url"),
    transportSpkiSha256: createHash("sha256")
      .update("transport")
      .digest("base64url")
  };
  const unsigned = {
    protocol: membershipDomain,
    groupId,
    parentHash: null,
    authorDeviceId: member.deviceId,
    body: { kind: "genesis", initialMember: member }
  };
  const text = canonicalizePdsJson(unsigned);
  const genesisHash = createHash("sha256")
    .update(`${membershipDomain}/record\n${text}`)
    .digest("base64url");
  const genesisJson = canonicalizePdsJson({
    unsigned,
    signature: sign(
      null,
      Buffer.from(`${membershipDomain}/decision\n${text}`),
      signing.privateKey
    ).toString("base64url")
  });
  const anchor = { groupId, genesisHash };
  const repository = createPeerOnlineMembershipRepository(pool);
  await repository.initialize(anchor, genesisJson);
  return { anchor, genesisJson, repository };
}

describe.skipIf(!url)("peer-online restore quarantine", () => {
  const name = `koed_restore_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url });
  const target = new URL(url ?? "postgresql://localhost/postgres");
  target.pathname = `/${name}`;
  let pool = new pg.Pool({ connectionString: target.toString() });
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

  it("rejects unknown groups and declarations with a wrong anchor", async () => {
    const groupId = randomUUID();
    await expect(
      declarePeerOnlineRestoreQuarantine(
        pool,
        { groupId, genesisHash: "missing-anchor" },
        "restore"
      )
    ).rejects.toThrow("peer membership group not found");
    const { anchor } = await createGroup(pool);
    await expect(
      declarePeerOnlineRestoreQuarantine(
        pool,
        { ...anchor, genesisHash: "wrong" },
        "restore"
      )
    ).rejects.toThrow("peer membership anchor mismatch");
    await expect(
      declarePeerOnlineRestoreQuarantine(pool, anchor, "   ")
    ).rejects.toThrow("invalid peer online quarantine reason");
  });

  it("persists one-way idempotent declaration across pool restart", async () => {
    const { anchor } = await createGroup(pool);
    await declarePeerOnlineRestoreQuarantine(pool, anchor, "restore detected");
    await declarePeerOnlineRestoreQuarantine(
      pool,
      anchor,
      "new diagnostic reason"
    );
    await pool.end();
    pool = new pg.Pool({ connectionString: target.toString() });
    const result = await pool.query<{ reason: string; genesis_hash: string }>(
      "select reason,genesis_hash from peer_online_restore_quarantines where group_id=$1",
      [anchor.groupId]
    );
    expect(result.rows).toEqual([
      { reason: "restore detected", genesis_hash: anchor.genesisHash }
    ]);
  });

  it("rejects a quarantine declaration anchored to a different genesis", async () => {
    const { anchor } = await createGroup(pool);
    await declarePeerOnlineRestoreQuarantine(pool, anchor, "restore detected");
    await expect(
      transaction(pool, anchor.groupId, (client) =>
        assertPeerOnlineNotQuarantined(client, {
          ...anchor,
          genesisHash: "tampered-anchor"
        })
      )
    ).rejects.toThrow("peer online quarantine anchor mismatch");
  });

  it("blocks direct SQL update, delete, and truncate of the latch", async () => {
    const { anchor } = await createGroup(pool);
    await declarePeerOnlineRestoreQuarantine(pool, anchor, "restore detected");

    await expect(
      pool.query(
        "update peer_online_restore_quarantines set reason='cleared' where group_id=$1",
        [anchor.groupId]
      )
    ).rejects.toThrow("peer online restore quarantine is immutable");
    await expect(
      pool.query(
        "delete from peer_online_restore_quarantines where group_id=$1",
        [anchor.groupId]
      )
    ).rejects.toThrow("peer online restore quarantine is immutable");
    await expect(
      pool.query("truncate peer_online_restore_quarantines")
    ).rejects.toThrow("peer online restore quarantine is immutable");

    const persisted = await pool.query(
      "select 1 from peer_online_restore_quarantines where group_id=$1",
      [anchor.groupId]
    );
    expect(persisted.rowCount).toBe(1);
  });
});
