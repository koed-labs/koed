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
      if (a.rows[0]?.name === b.rows[0]?.name)
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
