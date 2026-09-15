import { createHash, randomUUID } from "node:crypto";
import { canonicalConversationItemKey } from "@koed/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createDbPool,
  createPersonalDeviceSyncLocalRepository,
  createPersonalDeviceSyncRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

describeDb("PDS cumulative checkpoint receiver", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  }, 60_000);

  it("defers gaps, appends immutable prefixes once, and quarantines a divergent suffix", async () => {
    const user = await pool.query<{ id: string }>(
      `insert into users (email,display_name)
       values ($1,$2) returning id`,
      [`pds-checkpoint-${randomUUID()}@example.test`, "Checkpoint Receiver"]
    );
    const userId = user.rows[0]!.id;
    const groupId = `group-${randomUUID()}`;
    const deviceId = `device-${randomUUID()}`;
    const workerId = `worker-${randomUUID()}`;
    const originDeploymentId = `deployment-${randomUUID()}`;
    const logicalMemoryId = `memory-${randomUUID()}`;
    const deletionFloorToken = `floor-${randomUUID()}`;
    const sourceFingerprint = hash(`fingerprint:${randomUUID()}`);
    const externalSessionId = `source-session-${randomUUID()}`;
    const sourceCreatedAt = new Date("2026-09-14T10:00:00.000Z").toISOString();
    const sourceSession = {
      logicalSessionId: randomUUID(),
      externalSessionId,
      sourceKind: "pi",
      sourceAdapterVersion: "pi-session-v1",
      sourceRuntime: "pi" as const,
      captureMethod: "transcript" as const,
      sourceCreatedAt
    };
    const localRepository = createPersonalDeviceSyncLocalRepository(pool);
    const syncRepository = createPersonalDeviceSyncRepository(pool);

    await syncRepository.reconcilePersonalDeviceGroupReplica({
      userId,
      localDeploymentId: `local-${randomUUID()}`,
      group: {
        groupId,
        authorityKeyId: `authority-${randomUUID()}`,
        authorityPublicKey: "authority-public-key",
        recoverySigningKeyId: `recovery-signing-${randomUUID()}`,
        recoverySigningPublicKey: "recovery-signing-public-key",
        recoveryKemKeyId: `recovery-kem-${randomUUID()}`,
        recoveryKemPublicKey: "recovery-kem-public-key",
        recoveryKitHash: "recovery-kit-hash",
        currentEpoch: "1",
        pendingEpoch: null,
        pendingStatementSequence: null,
        pendingStatementHash: null,
        pendingBundleHash: null,
        headSequence: "1",
        headHash: "head-hash",
        state: "active",
        stateReason: null,
        members: [
          {
            deviceId,
            signingKeyId: `signing-${randomUUID()}`,
            signingPublicKey: "signing-public-key",
            kemKeyId: `kem-${randomUUID()}`,
            kemPublicKey: "kem-public-key",
            operationFamilies: ["pds_relay"],
            status: "active",
            admittedSequence: "1",
            revokedSequence: null,
            revokedAt: null
          }
        ],
        policy: {
          enabled: true,
          futureClosedSessionsOnly: true,
          historicalBackfillEnabled: false
        }
      },
      statements: [],
      certificates: [
        {
          deviceId,
          epoch: "1",
          statementSequence: "1",
          statementHash: "head-hash",
          authorityKeyId: `authority-${randomUUID()}`,
          canonicalCertificate: JSON.stringify({ deviceId, epoch: "1" }),
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000)
        }
      ]
    });

    const makeItems = (count: number, divergentPrefix = false) =>
      Array.from({ length: count }, (_, index) => {
        const itemIndex = divergentPrefix && index === 0 ? 100 : index;
        const role = index % 2 === 0 ? "user" : "assistant";
        const text = `checkpoint item ${itemIndex}`;
        const externalItemId = `item-${itemIndex}`;
        const externalTurnId = `turn-${Math.floor(itemIndex / 2)}`;
        const eventTime = new Date(
          Date.parse(sourceCreatedAt) + (itemIndex + 1) * 1_000
        ).toISOString();
        const observedAt = new Date(
          Date.parse(sourceCreatedAt) + (itemIndex + 1) * 1_000 + 100
        ).toISOString();
        const stableSource = {
          provider: "pi",
          externalThreadId: externalSessionId,
          externalTurnId,
          stableItemId: externalItemId,
          component: "message"
        };
        return {
          sourceKind: "pi",
          sourceAdapterVersion: "pi-session-v1",
          sourceTransport: "pds_relay",
          externalSessionId,
          externalThreadId: externalSessionId,
          externalTurnId,
          externalItemId,
          canonicalStableItemId: externalItemId,
          canonicalItemKey: canonicalConversationItemKey(stableSource),
          sourceRecordType: "message",
          sourceEventType:
            role === "assistant" ? "agent_message" : "user_message",
          sourceSequence: index,
          eventTime,
          observedAt,
          observationKind: "snapshot" as const,
          observationComponent: "message",
          rawJson: {
            type: "pi_session_record",
            id: `record-${itemIndex}`,
            message: { role, content: [{ type: "text", text }] }
          },
          rawText: text,
          sourceHash: hash(`source-item:${itemIndex}`),
          idempotencyKey: `source-item:${itemIndex}`,
          metadata: {
            actor: role === "assistant" ? "agent" : "user",
            sourceRole: role
          }
        };
      });

    const inboxFor = async (input: {
      checkpoint: {
        version: "1";
        ordinal: string;
        previousClosureHash: string | null;
        itemCount: string;
      };
      closureHash: string;
      manifestHash: string;
      packageId: string;
      sourceSequence: string;
    }) => {
      await expect(
        localRepository.receivePdsInbox({
          userId,
          groupId,
          packageId: input.packageId,
          sourceManifestHash: input.manifestHash
        })
      ).resolves.toBe("new");
      const claimed = await localRepository.claimPdsInbox({
        workerId,
        limit: 100
      });
      const inbox = claimed.find(
        (entry) => entry.packageId === input.packageId
      );
      expect(inbox).toBeDefined();
      const retained = await localRepository.retainPdsInboundPackage({
        userId,
        groupId,
        inboxId: inbox!.id,
        packageId: input.packageId,
        sourceManifestHash: input.manifestHash,
        originDeploymentId,
        originDeviceId: deviceId,
        sourceSequence: input.sourceSequence,
        logicalMemoryId,
        deletionFloorToken,
        sourceProfile: "cumulative_checkpoint",
        sourceFingerprint,
        sourceClosureHash: input.closureHash,
        checkpoint: input.checkpoint,
        encryptedEnvelope: { ciphertext: "opaque-test-envelope" }
      });
      return {
        inboxId: inbox!.id,
        retainedPackageId: retained.retainedPackageId
      };
    };

    const materialize = async (input: {
      checkpoint: {
        version: "1";
        ordinal: string;
        previousClosureHash: string | null;
        itemCount: string;
      };
      closureHash: string;
      manifestHash: string;
      packageId: string;
      sourceSequence: string;
      sourceItems: ReturnType<typeof makeItems>;
    }) => {
      const retained = await inboxFor(input);
      const result = await localRepository.materializePdsSessionCheckpoint({
        workerId,
        inboxId: retained.inboxId,
        userId,
        groupId,
        retainedPackageId: retained.retainedPackageId,
        packageId: input.packageId,
        sourceManifestHash: input.manifestHash,
        sourceFingerprint,
        closureHash: input.closureHash,
        logicalMemoryId,
        deletionFloorToken,
        originDeploymentId,
        originDeviceId: deviceId,
        sourceSequence: input.sourceSequence,
        sourceCheckpointAt: new Date("2026-09-14T10:05:00.000Z"),
        observedAt: new Date("2026-09-14T10:05:01.000Z"),
        checkpoint: input.checkpoint,
        sourceSession,
        sourceItems: input.sourceItems
      });
      return { ...result, ...retained };
    };

    const closure0 = hash("closure-0");
    const manifest0 = hash("manifest-0");
    const package0 = hash("package-0");
    const genesis = {
      checkpoint: {
        version: "1" as const,
        ordinal: "0",
        previousClosureHash: null,
        itemCount: "2"
      },
      closureHash: closure0,
      manifestHash: manifest0,
      packageId: package0,
      sourceSequence: "1",
      sourceItems: makeItems(2)
    };

    const closure1 = hash("closure-1");
    const manifest1 = hash("manifest-1");
    const package1 = hash("package-1");
    const second = {
      checkpoint: {
        version: "1" as const,
        ordinal: "1",
        previousClosureHash: closure0,
        itemCount: "4"
      },
      closureHash: closure1,
      manifestHash: manifest1,
      packageId: package1,
      sourceSequence: "2",
      sourceItems: makeItems(4)
    };

    try {
      const deferred = await materialize(second);
      expect(deferred).toMatchObject({
        deferred: true,
        conflict: false,
        state: "pending"
      });
      const deferredInbox = await pool.query<{
        state: string;
        attempt_count: number;
      }>("select state,attempt_count from pds_inbox_entries where id=$1", [
        deferred.inboxId
      ]);
      expect(deferredInbox.rows[0]).toEqual({
        state: "awaiting_predecessor",
        attempt_count: 0
      });

      const acceptedGenesis = await materialize(genesis);
      expect(acceptedGenesis).toMatchObject({
        deferred: false,
        conflict: false,
        state: "ready"
      });
      const localSessionId = acceptedGenesis.localSessionId;

      await expect(
        localRepository.receivePdsInbox({
          userId,
          groupId,
          packageId: genesis.packageId,
          sourceManifestHash: genesis.manifestHash
        })
      ).resolves.toBe("idempotent");
      const duplicateCounts = await pool.query<{
        inboxes: string;
        ledgers: string;
        sessions: string;
      }>(
        `select
           (select count(*)::text from pds_inbox_entries where group_id=(select id from personal_device_groups where group_id=$1) and package_id=$2) as inboxes,
           (select count(*)::text from pds_replica_checkpoints c join pds_logical_replicas r on r.id=c.replica_id where r.source_fingerprint=$3) as ledgers,
           (select count(*)::text from pds_logical_replicas where source_fingerprint=$3) as sessions`,
        [groupId, genesis.packageId, sourceFingerprint]
      );
      expect(duplicateCounts.rows[0]).toEqual({
        inboxes: "1",
        ledgers: "1",
        sessions: "1"
      });

      const woken = await pool.query<{ state: string }>(
        "select state from pds_inbox_entries where id=$1",
        [deferred.inboxId]
      );
      expect(woken.rows[0]?.state).toBe("pending");
      const reclaimed = await localRepository.claimPdsInbox({
        workerId,
        limit: 100
      });
      expect(
        reclaimed.find((entry) => entry.packageId === second.packageId)
          ?.attemptCount
      ).toBe(1);
      const acceptedSecond =
        await localRepository.materializePdsSessionCheckpoint({
          workerId,
          inboxId: deferred.inboxId,
          userId,
          groupId,
          retainedPackageId: deferred.retainedPackageId,
          packageId: second.packageId,
          sourceManifestHash: second.manifestHash,
          sourceFingerprint,
          closureHash: second.closureHash,
          logicalMemoryId,
          deletionFloorToken,
          originDeploymentId,
          originDeviceId: deviceId,
          sourceSequence: second.sourceSequence,
          sourceCheckpointAt: new Date("2026-09-14T10:06:00.000Z"),
          observedAt: new Date("2026-09-14T10:06:01.000Z"),
          checkpoint: second.checkpoint,
          sourceSession,
          sourceItems: second.sourceItems
        });
      expect(acceptedSecond).toMatchObject({
        replicaId: acceptedGenesis.replicaId,
        localSessionId,
        deferred: false,
        conflict: false,
        state: "ready"
      });
      await expect(
        localRepository.completePdsInbox({
          workerId,
          inboxId: deferred.inboxId,
          retainedPackageId: deferred.retainedPackageId,
          state: "ready"
        })
      ).resolves.toBe(true);

      // A crash before inbox completion can replay an older accepted prefix after the head advances.
      const replay = await localRepository.materializePdsSessionCheckpoint({
        workerId,
        inboxId: acceptedGenesis.inboxId,
        userId,
        groupId,
        retainedPackageId: acceptedGenesis.retainedPackageId,
        packageId: genesis.packageId,
        sourceManifestHash: genesis.manifestHash,
        sourceFingerprint,
        closureHash: genesis.closureHash,
        logicalMemoryId,
        deletionFloorToken,
        originDeploymentId,
        originDeviceId: deviceId,
        sourceSequence: genesis.sourceSequence,
        sourceCheckpointAt: new Date("2026-09-14T10:05:00.000Z"),
        observedAt: new Date("2026-09-14T10:05:01.000Z"),
        checkpoint: genesis.checkpoint,
        sourceSession,
        sourceItems: genesis.sourceItems
      });
      expect(replay).toMatchObject({
        replicaId: acceptedGenesis.replicaId,
        localSessionId,
        deferred: false,
        conflict: false,
        state: "ready"
      });
      await expect(
        localRepository.completePdsInbox({
          workerId,
          inboxId: acceptedGenesis.inboxId,
          retainedPackageId: acceptedGenesis.retainedPackageId,
          state: "ready"
        })
      ).resolves.toBe(true);

      const stored = await pool.query<{
        item_count: string;
        mapped_items: string;
        session_count: string;
      }>(
        `select r.checkpoint_item_count as item_count,
           (select count(*)::text from pds_source_item_mappings m where m.replica_id=r.id) as mapped_items,
           (select count(*)::text from sessions s where s.id=r.local_session_id) as session_count
         from pds_logical_replicas r where r.id=$1`,
        [acceptedGenesis.replicaId]
      );
      expect(stored.rows[0]).toEqual({
        item_count: "4",
        mapped_items: "4",
        session_count: "1"
      });

      await expect(
        pool.query(
          `update conversation_items set raw_text='tampered'
           where id=(select id from conversation_items where session_id=$1 limit 1)`,
          [localSessionId]
        )
      ).rejects.toThrow("read-only");
      await expect(
        pool.query(
          `insert into conversation_items
             (owner_user_id,visibility,session_id,source_kind,source_adapter_version,source_transport,
              external_session_id,external_thread_id,external_item_id,source_record_type,source_event_type,
              source_sequence,event_time,observed_at,raw_json,raw_text,source_hash,idempotency_key,canonical_item_key)
           values ($1,'personal',$2,'pi','pi-session-v1','pds_relay',$3,$3,$4,'message','user_message',99,
              now(),now(),'{}'::jsonb,'unauthorized',$5,$6,$7)`,
          [
            userId,
            localSessionId,
            externalSessionId,
            `unauthorized-${randomUUID()}`,
            hash("unauthorized"),
            randomUUID(),
            `unauthorized:${randomUUID()}`
          ]
        )
      ).rejects.toThrow("trusted checkpoint appends");

      const closure2 = hash("closure-2");
      const divergent = await materialize({
        checkpoint: {
          version: "1",
          ordinal: "2",
          previousClosureHash: closure1,
          itemCount: "5"
        },
        closureHash: closure2,
        manifestHash: hash("manifest-divergent"),
        packageId: hash("package-divergent"),
        sourceSequence: "3",
        sourceItems: makeItems(5, true)
      });
      expect(divergent).toMatchObject({
        replicaId: acceptedGenesis.replicaId,
        localSessionId,
        deferred: false,
        conflict: true,
        state: "quarantined"
      });
      const quarantine = await pool.query<{
        state: string;
        conflict_state: string | null;
      }>(
        `select r.materialization_state as state,c.state as conflict_state
         from pds_logical_replicas r left join pds_conflicts c on c.id=r.conflict_id
         where r.id=$1`,
        [acceptedGenesis.replicaId]
      );
      expect(quarantine.rows[0]).toEqual({
        state: "quarantined",
        conflict_state: "quarantined"
      });
    } finally {
      await pool.query(
        "delete from local_personal_identities where owner_user_id=$1",
        [userId]
      );
      await pool.query(
        "delete from conversation_items where owner_user_id=$1",
        [userId]
      );
      await pool.query("delete from sessions where owner_user_id=$1", [userId]);
      await pool.query("delete from users where id=$1", [userId]);
    }
  });
});
