import { generateKeyPairSync, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PDS_PROJECT_SELECTION_PROTOCOL,
  signPdsProjectSelection
} from "@koed/shared";
import {
  createDbPool,
  runDbMigrations,
  createPersonalProjectSelectionRepository
} from "../src/index.js";

describe.skipIf(!process.env.DATABASE_URL)(
  "Personal Project selection journal",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: process.env.DATABASE_URL });
      await runDbMigrations(pool);
    }, 60_000);
    afterAll(() => pool?.end());
    const fixture = async () => {
      const user = await pool.query<{ id: string }>(
        "insert into users (email) values ($1) returning id",
        [`project-selection-${randomUUID()}@example.test`]
      );
      const identity = await pool.query<{ id: string }>(
        "insert into local_personal_identities (owner_user_id,opaque_identity_id) values ($1,$2) returning id",
        [user.rows[0]!.id, randomUUID()]
      );
      const groupId = randomUUID();
      await pool.query(
        `insert into personal_device_groups (local_personal_identity_id,group_id,authority_key_id,authority_public_key,recovery_signing_key_id,recovery_signing_public_key,recovery_kem_key_id,recovery_kem_public_key,recovery_kit_hash,current_epoch,head_sequence,head_hash)
      values ($1,$2,'authority','public','recovery','public','kem','public','hash','1','1','head')`,
        [identity.rows[0]!.id, groupId]
      );
      const scope = {
        userId: user.rows[0]!.id,
        groupId,
        associationId: randomUUID(),
        selectionId: randomUUID()
      };
      await pool.query(
        `insert into personal_sync_policies (group_id,enabled,updated_by_user_id)
        select id,true,$2 from personal_device_groups where group_id=$1`,
        [groupId, scope.userId]
      );
      const key = generateKeyPairSync("ed25519").privateKey;
      const record = (
        revisionId: string,
        replaces: string[],
        anchor: string | null = "gr_fixture"
      ) =>
        signPdsProjectSelection(
          {
            protocol: PDS_PROJECT_SELECTION_PROTOCOL,
            groupId,
            associationId: scope.associationId,
            selectionId: scope.selectionId,
            authorDeviceId: "source_device",
            authorSigningKeyId: "source_key",
            revisionId,
            replaces,
            operation:
              anchor === null
                ? { kind: "delete" }
                : { kind: "set", anchorFingerprint: anchor }
          },
          key
        );
      return {
        scope,
        record,
        repository: createPersonalProjectSelectionRepository(pool)
      };
    };
    it("persists quiet-checkout updates and deletion, rejects stale resolution, and survives reconnect/replay", async () => {
      const { scope, record, repository } = await fixture();
      const initial = record("initial", []);
      expect(await repository.read(scope)).toMatchObject({ state: "absent" });
      await repository.appendVerified({
        userId: scope.userId,
        record: initial,
        reviewedHeads: []
      });
      const remove = record("remove", ["initial"], null);
      const update = record("update", ["initial"], "gr_second");
      await repository.appendVerified({
        userId: scope.userId,
        record: remove,
        reviewedHeads: ["initial"]
      });
      await repository.appendVerified({ userId: scope.userId, record: update });
      expect(await repository.read(scope)).toMatchObject({
        state: "conflict",
        heads: ["remove", "update"]
      });
      await expect(
        repository.appendVerified({
          userId: scope.userId,
          record: record("resolution", ["remove"], null),
          reviewedHeads: ["remove"]
        })
      ).rejects.toThrow("changed");
      const resolution = record("resolution", ["remove", "update"], null);
      await repository.appendVerified({
        userId: scope.userId,
        record: resolution,
        reviewedHeads: ["update", "remove"]
      });
      const reconnected = createPersonalProjectSelectionRepository(pool);
      expect(await reconnected.read(scope)).toMatchObject({
        state: "deleted",
        heads: ["resolution"]
      });
      expect(
        await reconnected.appendVerified({
          userId: scope.userId,
          record: initial
        })
      ).toMatchObject({ inserted: false, state: { state: "deleted" } });
      await expect(
        reconnected.appendVerified({
          userId: scope.userId,
          record: record("initial", [], "gr_other")
        })
      ).rejects.toThrow("reused");
      await expect(
        reconnected.read({ ...scope, userId: randomUUID() })
      ).rejects.toThrow("unavailable");
      await expect(
        reconnected.read({ ...scope, selectionId: "other" })
      ).rejects.toThrow("identity differs");
    });
    it("requires owner acceptance for each local checkout and never infers it from a received anchor", async () => {
      const { scope, record, repository } = await fixture();
      await repository.appendVerified({
        userId: scope.userId,
        record: record("received", [])
      });
      const checkout = {
        userId: scope.userId,
        originatingDeviceId: "profileA",
        checkoutId: "checkoutA"
      };
      expect(await repository.readAccepted(checkout)).toBeNull();
      await repository.accept({
        ...scope,
        ...checkout,
        localProjectId: "localA"
      });
      expect(await repository.readAccepted(checkout)).toMatchObject({
        associationId: scope.associationId,
        state: { state: "selected", anchorFingerprint: "gr_fixture" }
      });
      expect(
        await repository.readAccepted({
          ...checkout,
          originatingDeviceId: "profileB"
        })
      ).toBeNull();
      expect(
        await repository.readAccepted({
          ...checkout,
          checkoutId: "replacement_checkout"
        })
      ).toBeNull();
      expect(
        await repository.readAccepted({ ...checkout, userId: randomUUID() })
      ).toBeNull();
      await repository.appendVerified({
        userId: scope.userId,
        record: record("delete", ["received"], null)
      });
      expect(await repository.readAccepted(checkout)).toMatchObject({
        state: { state: "deleted" }
      });
      await repository.forgetAcceptance(checkout);
      expect(await repository.readAccepted(checkout)).toBeNull();
      expect(await repository.read(scope)).toMatchObject({ state: "deleted" });
    });
    it("durably delivers configuration without capture and respects leases and publication pause", async () => {
      const { scope, record, repository } = await fixture();
      await repository.appendVerified({
        userId: scope.userId,
        record: record("initial", []),
        reviewedHeads: []
      });
      const claimed = await repository.claimDelivery({
        userId: scope.userId,
        groupId: scope.groupId,
        workerId: "workerA"
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.record.revision.revisionId).toBe("initial");
      const lease = {
        userId: scope.userId,
        groupId: scope.groupId,
        workerId: "workerA",
        outboxId: claimed[0]!.id
      };
      expect(
        await repository.claimDelivery({
          userId: scope.userId,
          groupId: scope.groupId,
          workerId: "workerB"
        })
      ).toEqual([]);
      expect(await repository.beginDelivery(lease)).toBe(true);
      await pool.query(
        `update personal_sync_policies p set publication_paused=true from personal_device_groups g where g.id=p.group_id and g.group_id=$1`,
        [scope.groupId]
      );
      expect(await repository.beginDelivery(lease)).toBe(false);
      expect(
        await repository.settleDelivery({
          ...lease,
          workerId: "workerB",
          state: "acked"
        })
      ).toBe(false);
      expect(
        await repository.settleDelivery({
          ...lease,
          state: "committed",
          transportId: "transport",
          retryAt: new Date(0)
        })
      ).toBe(true);
      expect(
        await repository.claimDelivery({
          userId: scope.userId,
          groupId: scope.groupId,
          workerId: "workerB"
        })
      ).toEqual([]);
      await pool.query(
        `update personal_sync_policies p set publication_paused=false from personal_device_groups g where g.id=p.group_id and g.group_id=$1`,
        [scope.groupId]
      );
      const reconnect = createPersonalProjectSelectionRepository(pool);
      const retry = await reconnect.claimDelivery({
        userId: scope.userId,
        groupId: scope.groupId,
        workerId: "workerB"
      });
      expect(retry[0]).toMatchObject({
        state: "committed",
        transportId: "transport"
      });
      expect(
        await reconnect.settleDelivery({
          ...lease,
          workerId: "workerB",
          state: "acked",
          transportId: "transport"
        })
      ).toBe(true);
      expect(
        await reconnect.claimDelivery({
          userId: scope.userId,
          groupId: scope.groupId,
          workerId: "workerC"
        })
      ).toEqual([]);
      await reconnect.appendVerified({
        userId: scope.userId,
        record: record("incoming", ["initial"], null)
      });
      expect(
        await reconnect.claimDelivery({
          userId: scope.userId,
          groupId: scope.groupId,
          workerId: "workerC"
        })
      ).toEqual([]);
    });
    it("republishes immutable configuration for a new recipient epoch including acknowledged deletions", async () => {
      const { scope, record, repository } = await fixture();
      const set = record("set", []);
      const remove = record("delete", ["set"], null);
      for (const entry of [set, remove])
        await repository.appendVerified({
          userId: scope.userId,
          record: entry,
          reviewedHeads: entry.revision.replaces
        });
      expect(
        await repository.refreshRecipients({
          userId: scope.userId,
          groupId: scope.groupId,
          epoch: "1",
          authorDeviceId: "source_device"
        })
      ).toBe(2);
      const delivery = await repository.claimDelivery({
        userId: scope.userId,
        groupId: scope.groupId,
        workerId: "epoch_worker"
      });
      for (const entry of delivery)
        await repository.settleDelivery({
          outboxId: entry.id,
          workerId: "epoch_worker",
          state: "acked",
          transportId: "old_transport"
        });
      expect(
        await repository.refreshRecipients({
          userId: scope.userId,
          groupId: scope.groupId,
          epoch: "1",
          authorDeviceId: "source_device"
        })
      ).toBe(0);
      await pool.query(
        "update personal_device_groups set current_epoch='2' where group_id=$1",
        [scope.groupId]
      );
      expect(
        await repository.refreshRecipients({
          userId: scope.userId,
          groupId: scope.groupId,
          epoch: "1",
          authorDeviceId: "source_device"
        })
      ).toBe(0);
      expect(
        await repository.refreshRecipients({
          userId: scope.userId,
          groupId: scope.groupId,
          epoch: "2",
          authorDeviceId: "source_device"
        })
      ).toBe(2);
      const replay = await repository.claimDelivery({
        userId: scope.userId,
        groupId: scope.groupId,
        workerId: "new_epoch_worker"
      });
      expect(
        replay
          .map((entry) => entry.record)
          .sort((a, b) =>
            a.revision.revisionId.localeCompare(b.revision.revisionId)
          )
      ).toEqual([remove, set]);
      expect(
        await repository.beginDelivery({
          userId: scope.userId,
          groupId: scope.groupId,
          workerId: "new_epoch_worker",
          outboxId: replay[0]!.id,
          expectedEpoch: "1"
        })
      ).toBe(false);
      expect(
        await repository.beginDelivery({
          userId: scope.userId,
          groupId: scope.groupId,
          workerId: "new_epoch_worker",
          outboxId: replay[0]!.id,
          expectedEpoch: "2"
        })
      ).toBe(true);
      expect(await repository.read(scope)).toMatchObject({
        state: "deleted",
        heads: ["delete"]
      });
    });
    it("keeps missing history unresolved and rolls back cycles or cross-association parents", async () => {
      const { scope, record, repository } = await fixture();
      await repository.appendVerified({
        userId: scope.userId,
        record: record("later", ["earlier"], null)
      });
      expect(await repository.read(scope)).toMatchObject({
        state: "incomplete",
        missingRevisions: ["earlier"]
      });
      await expect(
        repository.appendVerified({
          userId: scope.userId,
          record: record("earlier", ["later"])
        })
      ).rejects.toThrow("cycle");
      await repository.appendVerified({
        userId: scope.userId,
        record: record("earlier", [])
      });
      expect(await repository.read(scope)).toMatchObject({ state: "deleted" });
      const otherKey = generateKeyPairSync("ed25519").privateKey;
      const cross = signPdsProjectSelection(
        {
          ...record("cross", ["later"]).revision,
          associationId: "other",
          selectionId: "other_selection"
        },
        otherKey
      );
      await expect(
        repository.appendVerified({ userId: scope.userId, record: cross })
      ).rejects.toThrow("another association");
    });
  }
);
