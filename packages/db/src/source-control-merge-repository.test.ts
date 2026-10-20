import { randomBytes, randomUUID } from "node:crypto";
import { createLocalTestKeyEnvelopeEncryptionProvider } from "@koed/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runDbMigrations } from "./migrate.js";
import { createSourceControlMergeRepository } from "./source-control-merge-repository.js";

const url =
  process.env.KOED_HQ408_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);

describe.skipIf(!url)("HQ-408 durable single-use merge journal", () => {
  let first: pg.Pool;
  let second: pg.Pool;
  const owner = randomUUID();
  const prKey = "pr:" + randomUUID();
  const prepared = { exactHead: "a".repeat(40), method: "squash" };
  const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64")
  );
  const makeInput = () => ({
    id: randomUUID(),
    ownerUserId: owner,
    prKey,
    idempotencyKey: `merge:${randomUUID()}`,
    readinessDigest: "b".repeat(64),
    prepared,
    expiresAt: new Date(Date.now() + 60_000)
  });

  beforeAll(async () => {
    first = new pg.Pool({ connectionString: url });
    second = new pg.Pool({ connectionString: url });
    await runDbMigrations(first);
    await first.query("insert into users(id,email) values($1,$2)", [
      owner,
      `hq408-${owner}@example.invalid`
    ]);
  }, 120_000);
  afterAll(async () => {
    try {
      await first?.query(
        "delete from source_control_merge_operations where owner_user_id=$1",
        [owner]
      );
      await first?.query("delete from users where id=$1", [owner]);
    } finally {
      await Promise.all([first?.end(), second?.end()]);
    }
  });

  it("claims one approval once and fences another approval for the same PR across processes", async () => {
    const a = createSourceControlMergeRepository(first, {
      envelopeEncryptionProvider: encryption
    });
    const b = createSourceControlMergeRepository(second, {
      envelopeEncryptionProvider: encryption
    });
    const firstPrepared = await a.prepare(makeInput());
    const secondPrepared = await b.prepare(makeInput());
    const stored = await first.query<{ prepared: string }>(
      "select prepared::text as prepared from source_control_merge_operations where id=$1",
      [firstPrepared.id]
    );
    expect(stored.rows[0]!.prepared).not.toContain(prepared.exactHead);
    expect(stored.rows[0]!.prepared).not.toContain('"method":"squash"');
    const winners = await Promise.all([
      a.claim(owner, firstPrepared.id),
      b.claim(owner, secondPrepared.id)
    ]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    const winner = winners.find(Boolean)!;
    expect(await b.claim(owner, winner.id)).toBeNull();
    expect((await a.unresolved(owner, prKey))?.id).toBe(winner.id);
    await a.setOutcome(owner, winner.id, "unknown", null, null);
    expect(
      await b.claim(
        owner,
        winner.id === firstPrepared.id ? secondPrepared.id : firstPrepared.id
      )
    ).toBeNull();
    await a.setOutcome(owner, winner.id, "rejected", null, null);
    const renewal = await b.claim(
      owner,
      winner.id === firstPrepared.id ? secondPrepared.id : firstPrepared.id
    );
    expect(renewal?.state).toBe("claimed");
    await b.setOutcome(owner, renewal!.id, "rejected", null, null);
  });

  it("does not claim an expired approval", async () => {
    const repo = createSourceControlMergeRepository(first, {
      envelopeEncryptionProvider: encryption
    });
    const expired = await repo.prepare({
      ...makeInput(),
      prKey: `expired:${randomUUID()}`,
      expiresAt: new Date(Date.now() - 1_000)
    });
    expect(await repo.claim(owner, expired.id)).toBeNull();
  });

  it("fences concurrent claims for the same provider PR across different users", async () => {
    const anotherOwner = randomUUID();
    await first.query("insert into users(id,email) values($1,$2)", [
      anotherOwner,
      `hq408-${anotherOwner}@example.invalid`
    ]);
    const a = createSourceControlMergeRepository(first, {
      envelopeEncryptionProvider: encryption
    });
    const b = createSourceControlMergeRepository(second, {
      envelopeEncryptionProvider: encryption
    });
    const key = `cross-owner:${randomUUID()}`;
    try {
      const firstPrepared = await a.prepare({ ...makeInput(), prKey: key });
      const secondPrepared = await b.prepare({
        ...makeInput(),
        ownerUserId: anotherOwner,
        prKey: key
      });
      const winners = await Promise.all([
        a.claim(owner, firstPrepared.id),
        b.claim(anotherOwner, secondPrepared.id)
      ]);
      expect(winners.filter(Boolean)).toHaveLength(1);
      const winner = winners.find(Boolean)!;
      await (winner.ownerUserId === owner ? a : b).setOutcome(
        winner.ownerUserId,
        winner.id,
        "unknown",
        null,
        null
      );
      const loser =
        winner.ownerUserId === owner ? secondPrepared : firstPrepared;
      expect(
        await (loser.ownerUserId === owner ? a : b).claim(
          loser.ownerUserId,
          loser.id
        )
      ).toBeNull();
    } finally {
      await first.query(
        "delete from source_control_merge_operations where pr_key=$1",
        [key]
      );
      await first.query("delete from users where id=$1", [anotherOwner]);
    }
  });

  it("rejects encrypted payload transplants across operation and owner rows", async () => {
    const repo = createSourceControlMergeRepository(first, {
      envelopeEncryptionProvider: encryption
    });
    const original = await repo.prepare({
      ...makeInput(),
      prKey: `custody:${randomUUID()}`
    });
    const other = await repo.prepare({
      ...makeInput(),
      prKey: `custody:${randomUUID()}`
    });
    const saved = await first.query<{ prepared: unknown }>(
      "select prepared from source_control_merge_operations where id=$1",
      [other.id]
    );
    await first.query(
      `update source_control_merge_operations set prepared=(
        select prepared from source_control_merge_operations where id=$1
      ) where id=$2`,
      [original.id, other.id]
    );
    await expect(repo.get(owner, other.id)).rejects.toThrow("custody mismatch");
    await first.query(
      "update source_control_merge_operations set prepared=$1::jsonb where id=$2",
      [JSON.stringify(saved.rows[0]!.prepared), other.id]
    );

    const anotherOwner = randomUUID();
    await first.query("insert into users(id,email) values($1,$2)", [
      anotherOwner,
      `hq408-${anotherOwner}@example.invalid`
    ]);
    try {
      await first.query(
        "update source_control_merge_operations set owner_user_id=$1 where id=$2",
        [anotherOwner, other.id]
      );
      await expect(repo.get(anotherOwner, other.id)).rejects.toThrow(
        "custody mismatch"
      );
    } finally {
      await first.query(
        "update source_control_merge_operations set owner_user_id=$1 where id=$2",
        [owner, other.id]
      );
      await first.query("delete from users where id=$1", [anotherOwner]);
    }
  });
});
