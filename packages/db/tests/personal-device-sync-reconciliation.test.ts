import { randomUUID } from "node:crypto";
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

describeDb("Personal Device Sync local reconciliation", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("binds a remote PDS subject to the local UUID user without SQL type ambiguity", async () => {
    const user = await pool.query<{ id: string }>(
      `insert into users (email,display_name)
       values ($1,$2) returning id`,
      [`pds-reconciliation-${randomUUID()}@example.test`, "PDS Receiver"]
    );
    const userId = user.rows[0]!.id;
    const groupId = `group-${randomUUID()}`;
    const deviceId = `device-${randomUUID()}`;
    const certificate = {
      deviceId,
      epoch: "1",
      statementSequence: "1",
      statementHash: "head-hash",
      authorityKeyId: `authority-${randomUUID()}`,
      canonicalCertificate: JSON.stringify({
        deviceId,
        epoch: "1",
        statementHash: "head-hash"
      }),
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    };
    const repository = createPersonalDeviceSyncRepository(pool);
    const localRepository = createPersonalDeviceSyncLocalRepository(pool);
    let localSessionId: string;

    try {
      const reconciled = await repository.reconcilePersonalDeviceGroupReplica({
        userId,
        localDeploymentId: `deployment-${randomUUID()}`,
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
        certificates: [certificate]
      });

      expect(reconciled.groupId).toBe(groupId);
      expect(reconciled.members.map((member) => member.deviceId)).toEqual([
        deviceId
      ]);
      const subject = await pool.query<{
        user_id: string;
        subject_id: string;
      }>(
        `select s.user_id,s.subject_id
         from personal_device_group_user_subjects s
         join personal_device_groups g on g.id=s.group_id
         where g.group_id=$1`,
        [groupId]
      );
      expect(subject.rows).toEqual([
        {
          user_id: userId,
          subject_id: userId
        }
      ]);
      const storedCertificate = await pool.query<{
        device_id: string;
        epoch: string;
        statement_hash: string;
      }>(
        `select m.device_id,c.epoch,c.statement_hash
         from personal_device_membership_certificates c
         join personal_device_group_members m on m.id=c.member_id
         join personal_device_groups g on g.id=c.group_id
         where g.group_id=$1`,
        [groupId]
      );
      expect(storedCertificate.rows).toEqual([
        {
          device_id: deviceId,
          epoch: certificate.epoch,
          statement_hash: certificate.statementHash
        }
      ]);

      const packageId = `package-${randomUUID()}`;
      const sourceManifestHash = `manifest-${randomUUID()}`;
      await expect(
        localRepository.receivePdsInbox({
          userId,
          groupId,
          packageId,
          sourceManifestHash
        })
      ).resolves.toBe("new");
      const workerId = `worker-${randomUUID()}`;
      const claimed = await localRepository.claimPdsInbox({
        workerId,
        limit: 100
      });
      expect(claimed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            groupId,
            packageId,
            attemptCount: 1
          })
        ])
      );
      const inbox = claimed.find((entry) => entry.packageId === packageId);
      expect(inbox).toBeDefined();
      const localSession = await pool.query<{ id: string }>(
        `insert into sessions
         (owner_user_id,visibility,external_session_id,source_runtime,capture_method,source_kind,source_adapter_version,source_hash,idempotency_key)
         values ($1,'personal',$2,'codex','transcript','pds','pds-test-v1',$3,$4)
         returning id`,
        [
          userId,
          `pds-session-${randomUUID()}`,
          `source-${randomUUID()}`,
          `pds-session-${randomUUID()}`
        ]
      );
      localSessionId = localSession.rows[0]!.id;
      const sourceItem = await pool.query<{ id: string }>(
        `insert into conversation_items
         (owner_user_id,visibility,session_id,source_kind,source_adapter_version,source_transport,
          external_session_id,external_item_id,source_record_type,source_event_type,source_sequence,
          event_time,observed_at,raw_json,raw_text,source_hash,idempotency_key,canonical_item_key,
          projection_status,projection_work_class)
         values ($1,'personal',$2,'pds','pds-test-v1','replica',$3,$4,'event_msg','user_message',0,
          now(),now(),'{}'::jsonb,'immutable source',$5,$6,$6,'pending','live_capture_projection')
         returning id`,
        [
          userId,
          localSessionId,
          `pds-session-${randomUUID()}`,
          `pds-item-${randomUUID()}`,
          `source-${randomUUID()}`,
          `pds-item-${randomUUID()}`
        ]
      );
      const retained = await localRepository.retainPdsInboundPackage({
        userId,
        groupId,
        inboxId: inbox!.id,
        packageId,
        sourceManifestHash,
        originDeploymentId: `deployment-${randomUUID()}`,
        originDeviceId: deviceId,
        sourceSequence: "1",
        logicalMemoryId: `memory-${randomUUID()}`,
        deletionFloorToken: `floor-${randomUUID()}`,
        sourceFingerprint: `fingerprint-${randomUUID()}`,
        sourceClosureHash: `closure-${randomUUID()}`,
        encryptedEnvelope: { ciphertext: "opaque" }
      });

      await expect(
        localRepository.materializePdsReplica({
          workerId,
          inboxId: inbox!.id,
          userId,
          groupId,
          retainedPackageId: retained.retainedPackageId,
          localSessionId: localSession.rows[0]!.id,
          sourceFingerprint: `fingerprint-materialized-${randomUUID()}`,
          closureHash: `closure-materialized-${randomUUID()}`,
          originDeploymentId: `deployment-${randomUUID()}`,
          originDeviceId: deviceId,
          sourceSequence: "1",
          sourceClosedAt: new Date(),
          observedAt: new Date(),
          sourceItemIds: [sourceItem.rows[0]!.id]
        })
      ).resolves.toMatchObject({
        state: "ready",
        conflict: false
      });
      await expect(
        localRepository.completePdsInbox({
          workerId,
          inboxId: inbox!.id,
          retainedPackageId: retained.retainedPackageId,
          state: "ready"
        })
      ).resolves.toBe(true);
      await expect(
        pool.query(
          `update conversation_items
           set projection_status='projected',projection_version='pds-test',projected_at=now()
           where id=$1`,
          [sourceItem.rows[0]!.id]
        )
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query(
          `update sessions
           set metadata=metadata || jsonb_build_object(
             'threadName','Derived replica title',
             'threadNameSource','provisional',
             'threadNameGeneratedAt',now()
           ),updated_at=now()
           where id=$1`,
          [localSession.rows[0]!.id]
        )
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query("update sessions set source_kind='tampered' where id=$1", [
          localSession.rows[0]!.id
        ])
      ).rejects.toThrow("read-only");
      await expect(
        pool.query(
          "update conversation_items set raw_text='tampered' where id=$1",
          [sourceItem.rows[0]!.id]
        )
      ).rejects.toThrow("read-only");
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
