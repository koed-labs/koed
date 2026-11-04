import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createPersonalDeviceSyncRepository,
  runDbMigrations
} from "../src/index.js";
import { createPeerLifecycleFixture } from "./fixtures/personal-peer-lifecycle.js";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";
import { createPeerSyncHarness } from "./fixtures/personal-peer-sync.js";

const originUrl = process.env.P1_SOURCE_ORIGIN_DATABASE_URL;
const receiverUrl = process.env.P1_SOURCE_RECEIVER_DATABASE_URL;

describe.skipIf(!originUrl || !receiverUrl)(
  "peer-online development slice",
  () => {
    let originPool: pg.Pool;
    let receiverPool: pg.Pool;
    beforeAll(async () => {
      if (originUrl === receiverUrl)
        throw new Error("Peer fixtures require distinct databases");
      originPool = createDbPool({ connectionString: originUrl });
      receiverPool = createDbPool({ connectionString: receiverUrl });
      const [a, b] = await Promise.all([
        originPool.query<{ name: string }>("select current_database() as name"),
        receiverPool.query<{ name: string }>(
          "select current_database() as name"
        )
      ]);
      if (a.rows[0].name === b.rows[0].name)
        throw new Error("Peer fixtures require distinct databases");
      await Promise.all([
        runDbMigrations(originPool),
        runDbMigrations(receiverPool)
      ]);
    }, 60_000);
    afterAll(async () => {
      await Promise.all([originPool?.end(), receiverPool?.end()]);
    });
    it("materializes an encrypted checkpoint in a separate peer database", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("peer slice first message");
      const packageData = await harness.publish(source);
      const replica = await harness.receive(packageData);
      expect(replica.localSessionId).toBeTruthy();
      expect(replica.localSessionId).not.toBe(source.id);
      expect(await harness.replicaText(replica.localSessionId)).toContain(
        "peer slice first message"
      );
      await expect(
        harness.writeSourceJournal(
          replica.localSessionId,
          source.externalSessionId!
        )
      ).rejects.toThrow(/read.only/i);
      await expect(
        harness.writeReplicaItem(
          replica.localSessionId,
          source.externalSessionId!
        )
      ).rejects.toThrow(/only trusted checkpoint appends/i);
      expect(await harness.replicaText(replica.localSessionId)).toContain(
        "peer slice first message"
      );
      await expect(
        receiverPool.query(
          "update conversation_items set raw_text='tampered' where session_id=$1",
          [replica.localSessionId]
        )
      ).rejects.toThrow("read-only");
    });

    it("preserves read-only provenance when replica removal is attempted", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("replica provenance");
      const replica = await harness.receive(await harness.publish(source));
      await expect(
        receiverPool.query(
          "delete from pds_logical_replicas where local_session_id=$1",
          [replica.localSessionId]
        )
      ).rejects.toThrow(/attached replica/i);
      await expect(
        receiverPool.query("delete from sessions where id=$1", [
          replica.localSessionId
        ])
      ).rejects.toThrow(/read.only|attached replica/i);
      await expect(
        receiverPool.query(
          "delete from users where id=(select owner_user_id from sessions where id=$1)",
          [replica.localSessionId]
        )
      ).rejects.toThrow();
      await expect(
        harness.writeReplicaItem(
          replica.localSessionId,
          source.externalSessionId!
        )
      ).rejects.toThrow(/only trusted checkpoint appends/i);
      await expect(
        harness.writeSourceJournal(
          replica.localSessionId,
          source.externalSessionId!
        )
      ).rejects.toThrow(/read.only/i);
      expect(await harness.replicaText(replica.localSessionId)).toContain(
        "replica provenance"
      );
    });

    it("preserves attached closed replicas while permitting unattached cleanup", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("closed replica setup");
      const replica = await harness.receive(await harness.publish(source));
      const local = await harness.captureOnReceiver();
      const closed = await receiverPool.query<{ id: string; group_id: string }>(
        "insert into pds_logical_replicas (group_id, owner_user_id, source_fingerprint, closure_hash, local_session_id) select group_id, owner_user_id, gen_random_uuid()::text, gen_random_uuid()::text, $1 from pds_logical_replicas where local_session_id=$2 returning id, group_id",
        [local.id, replica.localSessionId]
      );
      await expect(
        receiverPool.query(
          "update pds_logical_replicas set local_session_id=null where id=$1",
          [closed.rows[0]!.id]
        )
      ).rejects.toThrow(/attached replica/i);
      await expect(
        receiverPool.query("delete from personal_device_groups where id=$1", [
          closed.rows[0]!.group_id
        ])
      ).rejects.toThrow(/attached replica/i);
      await expect(
        receiverPool.query("delete from pds_logical_replicas where id=$1", [
          closed.rows[0]!.id
        ])
      ).rejects.toThrow(/attached replica/i);
      const unattached = await receiverPool.query<{ id: string }>(
        "insert into pds_logical_replicas (group_id, owner_user_id, source_fingerprint, closure_hash) select group_id, owner_user_id, gen_random_uuid()::text, gen_random_uuid()::text from pds_logical_replicas where id=$1 returning id",
        [closed.rows[0]!.id]
      );
      expect(
        (
          await receiverPool.query(
            "delete from pds_logical_replicas where id=$1",
            [unattached.rows[0]!.id]
          )
        ).rowCount
      ).toBe(1);
    });

    it("avoids a replay deadlock when a conflicting upsert proposes a different Session", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("closed upsert ordering");
      const replica = await harness.receive(await harness.publish(source));
      const first = await harness.captureOnReceiver();
      const second = await harness.captureOnReceiver();
      const closed = await receiverPool.query<{ id: string }>(
        "insert into pds_logical_replicas (group_id, owner_user_id, source_fingerprint, closure_hash, local_session_id) select group_id, owner_user_id, gen_random_uuid()::text, gen_random_uuid()::text, $1 from pds_logical_replicas where local_session_id=$2 returning id",
        [first.id, replica.localSessionId]
      );
      const replay = await receiverPool.connect();
      const upsert = await receiverPool.connect();
      try {
        await replay.query("begin");
        await upsert.query("begin");
        await upsert.query("set local statement_timeout='1s'");
        await replay.query("select koed_lock_pds_source_authority($1)", [
          first.id
        ]);
        await upsert.query(
          `insert into pds_logical_replicas (group_id,owner_user_id,materialization_profile,source_fingerprint,closure_hash,local_session_id)
          select group_id,owner_user_id,materialization_profile,source_fingerprint,closure_hash,$2 from pds_logical_replicas where id=$1
          on conflict (group_id,source_fingerprint,closure_hash) where materialization_profile='closed_v1'
          do update set local_session_id=coalesce(pds_logical_replicas.local_session_id,excluded.local_session_id)`,
          [closed.rows[0]!.id, second.id]
        );
        await upsert.query("commit");
        await replay.query(
          "select 1 from pds_logical_replicas where id=$1 for update",
          [closed.rows[0]!.id]
        );
        await replay.query("commit");
      } finally {
        await replay.query("rollback").catch(() => undefined);
        await upsert.query("rollback").catch(() => undefined);
        replay.release();
        upsert.release();
      }
    });

    it("removes the authority coordination row when an ordinary Session is deleted", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const local = await harness.captureOnReceiver();
      const artifact = await harness.writeSourceJournal(
        local.id,
        local.externalSessionId!
      );
      expect(
        (
          await receiverPool.query(
            "select 1 from pds_session_invariant_locks where session_id=$1",
            [local.id]
          )
        ).rowCount
      ).toBe(1);
      await receiverPool.query(
        "delete from conversation_source_artifacts where id=$1",
        [artifact.id]
      );
      await receiverPool.query("delete from sessions where id=$1", [local.id]);
      expect(
        (
          await receiverPool.query(
            "select 1 from pds_session_invariant_locks where session_id=$1",
            [local.id]
          )
        ).rowCount
      ).toBe(0);
    });

    it.each([false, true])(
      "serializes session deletion with coordination writes (existing row: %s)",
      async (existing) => {
        const harness = await createPeerSyncHarness(originPool, receiverPool);
        const local = await harness.captureOnReceiver();
        if (existing)
          await receiverPool.query(
            "select koed_lock_pds_source_authority($1)",
            [local.id]
          );
        const writer = await receiverPool.connect();
        const deleter = await receiverPool.connect();
        try {
          await writer.query("begin");
          await deleter.query("begin");
          await writer.query("select koed_lock_pds_source_authority($1)", [
            local.id
          ]);
          const deletion = deleter.query("delete from sessions where id=$1", [
            local.id
          ]);
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            const state = await receiverPool.query<{
              wait_event_type: string | null;
            }>("select wait_event_type from pg_stat_activity where pid=$1", [
              deleter.processID
            ]);
            if (state.rows[0]?.wait_event_type === "Lock") {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await writer.query("commit");
          await expect(deletion).resolves.toMatchObject({ rowCount: 1 });
          await deleter.query("commit");
          expect(
            (
              await receiverPool.query(
                "select 1 from pds_session_invariant_locks where session_id=$1",
                [local.id]
              )
            ).rowCount
          ).toBe(0);
        } finally {
          await writer.query("rollback").catch(() => undefined);
          await deleter.query("rollback").catch(() => undefined);
          writer.release();
          deleter.release();
        }
      }
    );

    it("enforces replica source authority against direct database changes", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("authority test");
      const replica = await harness.receive(await harness.publish(source));
      const artifact = await harness.writeSourceJournal(
        replica.localSessionId,
        source.externalSessionId!,
        "peer_personal"
      );
      await expect(
        receiverPool.query(
          "update conversation_source_artifacts set replica_role='origin_local' where id=$1",
          [artifact.id]
        )
      ).rejects.toThrow(/read.only/i);
    });

    it("rejects attaching a replica to a session with a local-origin artifact", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("replica assignment guard");
      const replica = await harness.receive(await harness.publish(source));
      const local = await harness.captureOnReceiver();
      await harness.writeSourceJournal(local.id, local.externalSessionId!);
      await expect(
        receiverPool.query(
          "insert into pds_logical_replicas (group_id, owner_user_id, source_fingerprint, closure_hash, local_session_id) select group_id, owner_user_id, gen_random_uuid()::text, gen_random_uuid()::text, $1 from pds_logical_replicas where local_session_id=$2",
          [local.id, replica.localSessionId]
        )
      ).rejects.toThrow(/read.only/i);
    });

    it.each(
      ["read committed", "repeatable read", "serializable"].flatMap(
        (isolation) =>
          ["source", "replica"].map((winner) => [isolation, winner] as const)
      )
    )(
      "serializes concurrent source and replica authority at %s with %s first",
      async (isolation, winner) => {
        const harness = await createPeerSyncHarness(originPool, receiverPool);
        const source = await harness.capture("race fixture");
        const replica = await harness.receive(await harness.publish(source));
        const local = await harness.captureOnReceiver();
        const artifact = await harness.writeSourceJournal(
          local.id,
          local.externalSessionId!,
          "peer_personal"
        );
        const a = await receiverPool.connect();
        const b = await receiverPool.connect();
        try {
          await a.query(`begin isolation level ${isolation}`);
          await b.query(`begin isolation level ${isolation}`);
          await b.query("select 1 from pds_logical_replicas limit 1");
          const sourceWrite =
            "update conversation_source_artifacts set replica_role='origin_local' where id=$1";
          const replicaWrite =
            "insert into pds_logical_replicas (group_id, owner_user_id, source_fingerprint, closure_hash, local_session_id) select group_id, owner_user_id, gen_random_uuid()::text, gen_random_uuid()::text, $1 from pds_logical_replicas where local_session_id=$2";
          const sourceArgs = [artifact.id];
          const replicaArgs = [local.id, replica.localSessionId];
          await a.query(
            winner === "source" ? sourceWrite : replicaWrite,
            winner === "source" ? sourceArgs : replicaArgs
          );
          const contender = b.query(
            winner === "source" ? replicaWrite : sourceWrite,
            winner === "source" ? replicaArgs : sourceArgs
          );
          const rejection = expect(contender).rejects.toThrow(
            /read.only|could not serialize/i
          );
          const pid = (
            await receiverPool.query<{ pid: number }>(
              "select pid from pg_stat_activity where pid = $1",
              [b.processID]
            )
          ).rows[0]?.pid;
          expect(pid).toBe(b.processID);
          let blocked = false;
          for (let i = 0; i < 100; i++) {
            const state = await receiverPool.query<{
              wait_event_type: string | null;
            }>("select wait_event_type from pg_stat_activity where pid=$1", [
              b.processID
            ]);
            if (state.rows[0]?.wait_event_type === "Lock") {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await a.query("commit");
          await rejection;
          await b.query("rollback");
        } finally {
          await a.query("rollback").catch(() => undefined);
          await b.query("rollback").catch(() => undefined);
          a.release();
          b.release();
        }
      }
    );

    it("delivers retained checkpoints after a simulated offline interval", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("offline first");
      const first = await harness.publish(source);
      await harness.append(source, "offline second");
      const second = await harness.publish(source);
      expect(await harness.hasInbox(first)).toBe(false);
      expect(await harness.hasInbox(second)).toBe(false);
      const retained = await originPool.query(
        "select package_id from pds_retained_packages where package_id = any($1::text[])",
        [[first.header.packageId, second.header.packageId]]
      );
      expect(retained.rowCount).toBe(2);
      expect((await harness.receive(second)).deferred).toBe(true);
      const initial = await harness.receive(first);
      const resumed = await harness.receive(second);
      expect(resumed.localSessionId).toBe(initial.localSessionId);
      expect(await harness.replicaText(resumed.localSessionId)).toContain(
        "offline second"
      );
    });

    it("does not materialize a signed checkpoint with incompatible predecessor history", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("valid history");
      const first = await harness.publish(source);
      const original = await harness.receive(first);
      await harness.append(source, "conflicting history");
      const conflict = await harness.publish(source, true);
      await expect(harness.receive(conflict)).rejects.toThrow(
        /conflict|checkpoint|predecessor/i
      );
      expect(await harness.replicaText(original.localSessionId)).not.toContain(
        "conflicting history"
      );
    });

    it("defers a missing predecessor until the earlier checkpoint arrives and retry is explicit", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("predecessor");
      const first = await harness.publish(source);
      await harness.append(source, "successor");
      const second = await harness.publish(source);
      expect((await harness.receive(second)).deferred).toBe(true);
      const initial = await harness.receive(first);
      const next = await harness.receive(second);
      expect(next.deferred).toBe(false);
      expect(next.localSessionId).toBe(initial.localSessionId);
      expect(await harness.replicaText(next.localSessionId)).toContain(
        "successor"
      );
    });

    it("rejects a checkpoint covered by a later authenticated deletion floor", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("deleted checkpoint");
      const pkg = await harness.publish(source);
      const control = harness.createMatchingDeletion(pkg);
      const altered = structuredClone(control);
      altered.tombstone.draft.deletionFloorToken = "A".repeat(43);
      await expect(harness.receive(pkg, altered)).rejects.toThrow(
        "PDS tombstone authorization signature is invalid"
      );
      expect(await harness.hasInbox(pkg)).toBe(false);
      await expect(harness.receive(pkg, control)).rejects.toThrow(
        "deletion floor"
      );
      expect(await harness.hasInbox(pkg)).toBe(false);
      await expect(harness.receive(pkg)).rejects.toThrow("deletion floor");
    });

    it("redelivers a verified package without duplicating its replica", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("duplicate delivery");
      const pkg = await harness.publish(source);
      const first = await harness.receive(pkg);
      const counts = () =>
        receiverPool.query<{
          replicas: string;
          observations: string;
          items: string;
        }>(
          `select
        (select count(*) from pds_logical_replicas where local_session_id=$1) as replicas,
        (select count(*) from pds_replica_observations where replica_id in (select id from pds_logical_replicas where local_session_id=$1)) as observations,
        (select count(*) from conversation_items where session_id=$1) as items`,
          [first.localSessionId]
        );
      const before = (await counts()).rows[0];
      const again = await harness.receive(pkg);
      expect((await counts()).rows[0]).toEqual(before);
      expect(again.localSessionId).toBe(first.localSessionId);
      expect(
        (await harness.replicaText(first.localSessionId)).match(
          /duplicate delivery/g
        )
      ).toHaveLength(2);
    });

    it("rejects an unauthorized recipient key before inserting inbox state", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const pkg = await harness.publish(
        await harness.capture("wrong recipient")
      );
      await expect(harness.receiveWithWrongRecipient(pkg)).rejects.toThrow();
      expect(await harness.hasInbox(pkg)).toBe(false);
    });

    it("rejects a tampered signed package", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("tamper test");
      const pkg = await harness.publish(source);
      const tampered = structuredClone(pkg);
      tampered.header.sourceManifestHash = "A".repeat(43);
      await expect(harness.receive(tampered)).rejects.toThrow();
    });

    it("materializes a later cumulative checkpoint without duplicating earlier items", async () => {
      const harness = await createPeerSyncHarness(originPool, receiverPool);
      const source = await harness.capture("first checkpoint message");
      const first = await harness.receive(await harness.publish(source));
      await harness.append(source, "second checkpoint message");
      const second = await harness.receive(await harness.publish(source));
      expect(second.localSessionId).toBe(first.localSessionId);
      const text = await harness.replicaText(second.localSessionId);
      expect(text).toContain("first checkpoint message");
      expect(text).toContain("second checkpoint message");
      expect(text.match(/first checkpoint message/g)).toHaveLength(2);
    });

    it("materializes a separately originated checkpoint in the other direction", async () => {
      const forward = await createPeerSyncHarness(originPool, receiverPool);
      const forwardSource = await forward.capture("forward direction");
      await forward.receive(await forward.publish(forwardSource));
      expect(forward.reverseContext).toBeDefined();
      const reverse = await createPeerSyncHarness(
        receiverPool,
        originPool,
        forward.reverseContext
      );
      const source = await reverse.capture("reverse direction");
      const replica = await reverse.receive(await reverse.publish(source));
      expect(await reverse.replicaText(replica.localSessionId)).toContain(
        "reverse direction"
      );
    });

    it("initializes both peers with the same signed lifecycle", async () => {
      const lifecycle = createPeerLifecycleFixture();
      const fixture = personalSourceDeviceFixture(lifecycle);
      const origin = await fixture.initialize(originPool, fixture.origin);
      const receiver = await fixture.initialize(receiverPool, fixture.receiver);
      expect(origin.userId).toBeTruthy();
      expect(receiver.userId).toBeTruthy();
      const [left, right] = await Promise.all([
        createPersonalDeviceSyncRepository(originPool).getPersonalDeviceGroup(
          origin.userId,
          fixture.groupId
        ),
        createPersonalDeviceSyncRepository(receiverPool).getPersonalDeviceGroup(
          receiver.userId,
          fixture.groupId
        )
      ]);
      expect(left?.headHash).toBe(lifecycle.expectedHead);
      expect(right?.headHash).toBe(lifecycle.expectedHead);
    });
  }
);
