import { canonicalConversationItemKey } from "@koed/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createDbPool,
  createMemorySourceRepository,
  createPersonalDeviceSyncLocalRepository,
  createPersonalDeviceSyncRepository,
  runDbMigrations
} from "../src/index.js";
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb("PDS automatic checkpoint publication", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: process.env.DATABASE_URL });
    await runDbMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  it("publishes completed prefixes, allows resumed capture, deduplicates and rolls back failed publication", async () => {
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

    await repository.reconcilePersonalDeviceGroupReplica({
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

    const memory = createMemorySourceRepository(pool);
    const session = await memory.createCapturedSession(
      { userId },
      {
        idempotencyKey: randomUUID(),
        externalSessionId: randomUUID(),
        sourceRuntime: "pi",
        sourceKind: "pi",
        sourceAdapterVersion: "pi-session-v1",
        captureMethod: "transcript"
      }
    );
    const add = async (n: number, complete: boolean) => {
      const contentBlock = { type: "text", text: `turn ${n}` };
      const stableItemId = `item-${n}:0`;
      return memory.createConversationItems(
        { userId },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: "pi",
              sourceAdapterVersion: "pi-session-v1",
              sourceTransport: "transcript_watcher",
              sourceRecordType: "message",
              sourceEventType: complete ? "agent_message" : "user_message",
              sourceSequence: n,
              sourceHash: `hash-${n}`,
              externalItemId: stableItemId,
              externalSessionId: session.externalSessionId!,
              externalThreadId: session.externalSessionId!,
              externalTurnId: `turn-${n}`,
              canonicalStableItemId: stableItemId,
              observationComponent: "message",
              canonicalItemKey: canonicalConversationItemKey({
                provider: "pi",
                externalThreadId: session.externalSessionId!,
                externalTurnId: `turn-${n}`,
                stableItemId,
                component: "message"
              }),
              rawText: `turn ${n}`,
              rawJson: {
                type: "pi_session_record",
                contentBlock,
                sourceRecord: {
                  id: `item-${n}`,
                  type: "message",
                  message: {
                    role: complete ? "assistant" : "user",
                    content: [contentBlock],
                    ...(complete ? { stopReason: "stop" } : {})
                  }
                }
              },
              idempotencyKey: `${session.id}-${n}`,
              metadata: {
                actor: complete ? "agent" : "user",
                sourceRole: complete ? "agent" : "user"
              }
            }
          ]
        }
      );
    };
    await add(0, false);
    expect(
      await localRepository.listPdsCheckpointCandidates()
    ).not.toContainEqual({ userId, groupId, sessionId: session.id });
    await add(1, true);
    expect(await localRepository.listPdsCheckpointCandidates()).toContainEqual({
      userId,
      groupId,
      sessionId: session.id
    });
    const published: Array<{
      count: number;
      ordinal: string;
      previous: string | null;
    }> = [];
    const input = {
      userId,
      groupId,
      sessionId: session.id,
      originDeploymentId: "origin",
      originDeviceId: deviceId,
      build: async (
        value: Parameters<
          Parameters<
            typeof localRepository.checkpointPdsSourceSession
          >[0]["build"]
        >[0]
      ) => {
        const checkpoint = value.checkpoint!;
        published.push({
          count: value.source.items.length,
          ordinal: checkpoint.ordinal,
          previous: checkpoint.previousClosureHash
        });
        return {
          sourceClosureHash: checkpoint.ordinal.padStart(43, "h"),
          packageId: `pkg-${randomUUID()}`,
          sourceManifestHash: `manifest-${randomUUID()}`,
          sourceFingerprint: "fingerprint",
          logicalMemoryId: "memory",
          deletionFloorToken: "floor",
          encryptedEnvelope: { test: true }
        };
      }
    };
    await expect(
      localRepository.checkpointPdsSourceSession({
        ...input,
        build: async () => {
          throw new Error("build-failed");
        }
      })
    ).rejects.toThrow("build-failed");
    expect(
      (
        await pool.query<{ count: string }>(
          "select count(*) from pds_session_closures where source_session_id=$1",
          [session.id]
        )
      ).rows[0]?.count
    ).toBe("0");
    const concurrent = await Promise.all([
      localRepository.checkpointPdsSourceSession(input),
      localRepository.checkpointPdsSourceSession(input)
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(published).toEqual([{ count: 2, ordinal: "0", previous: null }]);
    await expect(
      localRepository.checkpointPdsSourceSession(input)
    ).resolves.toBeNull();
    await add(2, false);
    await expect(
      localRepository.checkpointPdsSourceSession(input)
    ).resolves.toBeNull();
    await add(3, true);
    await localRepository.checkpointPdsSourceSession(input);
    expect(published[1]).toEqual({
      count: 4,
      ordinal: "1",
      previous: "0".padStart(43, "h")
    });
    expect(
      (
        await pool.query<{ count: string }>(
          "select count(*) from pds_source_item_mappings where conversation_item_id in (select id from conversation_items where session_id=$1)",
          [session.id]
        )
      ).rows[0]?.count
    ).toBe("4");
    expect(
      (await localRepository.listPdsCheckpointCandidates()).filter(
        (c) => c.sessionId === session.id
      )
    ).toEqual([]);
    const checkpointRows = await pool.query<{
      id: string;
      checkpoint_ordinal: string;
    }>(
      `select o.id,c.checkpoint_ordinal from pds_outbox_entries o
       join pds_session_closures c on c.id=o.closure_id
       where c.source_session_id=$1 and c.publication_kind='checkpoint'
       order by c.checkpoint_ordinal`,
      [session.id]
    );
    expect(checkpointRows.rows).toHaveLength(2);
    const v1Session = await memory.createCapturedSession(
      { userId },
      {
        idempotencyKey: randomUUID(),
        externalSessionId: randomUUID(),
        sourceRuntime: "pi",
        sourceKind: "pi",
        sourceAdapterVersion: "pi-session-v1",
        captureMethod: "transcript"
      }
    );
    const v1PackageId = `closed-v1-${randomUUID()}`;
    const v1ManifestHash = `closed-v1-manifest-${randomUUID()}`;
    await pool.query(
      `insert into pds_retained_packages
         (group_id,owner_user_id,package_id,source_manifest_hash,
          origin_deployment_id,origin_device_id,source_sequence,encrypted_envelope)
       select g.id,$1,$2,$3,'origin',$4,'1000','{}'::jsonb
       from personal_device_groups g where g.group_id=$5`,
      [userId, v1PackageId, v1ManifestHash, deviceId, groupId]
    );
    await pool.query(
      `insert into pds_session_closures
         (group_id,owner_user_id,source_session_id,source_sequence,
          terminal_cursor,terminal_item_count,source_closure_hash,package_id,
          source_manifest_hash,closed_at)
       select g.id,$1,$2,'1000','1','1','closed-v1-hash',$3,$4,now()
       from personal_device_groups g where g.group_id=$5`,
      [userId, v1Session.id, v1PackageId, v1ManifestHash, groupId]
    );
    await pool.query(
      `insert into pds_outbox_entries (closure_id,idempotency_key)
       select c.id,$1 from pds_session_closures c where c.package_id=$2`,
      [`pds:${groupId}:${v1PackageId}`, v1PackageId]
    );
    const v1Outbox = await pool.query<{
      id: string;
      state: string;
      dispatch_epoch: string | null;
    }>(
      `select o.id,o.state,o.dispatch_epoch from pds_outbox_entries o
       join pds_session_closures c on c.id=o.closure_id
       where c.package_id=$1`,
      [v1PackageId]
    );
    await pool.query(
      "update personal_device_groups set current_epoch='2' where group_id=$1",
      [groupId]
    );
    await pool.query(
      `update pds_outbox_entries set state='acked',attempt_count=7,
         last_error_class='old-error',transport_id='stale-transport'
       where id=$1`,
      [checkpointRows.rows[0]!.id]
    );
    await pool.query(
      `update pds_outbox_entries set state='uploading',attempt_count=3,
         lease_owner='active-worker',lease_until=now()+interval '1 hour'
       where id=$1`,
      [checkpointRows.rows[1]!.id]
    );
    await expect(
      localRepository.getPdsOutboxEncryptedEnvelope({
        workerId: "active-worker",
        outboxId: checkpointRows.rows[1]!.id
      })
    ).resolves.toMatchObject({ groupId, userId });
    await expect(
      localRepository.refreshPdsCheckpointRecipients({ userId, groupId })
    ).resolves.toBe(1);
    const requeued = await pool.query<{
      state: string;
      attempt_count: number;
      last_error_class: string | null;
      transport_id: string | null;
      dispatch_epoch: string | null;
      lease_owner: string | null;
    }>(
      `select state,attempt_count,last_error_class,transport_id,dispatch_epoch,lease_owner
       from pds_outbox_entries where id=$1`,
      [checkpointRows.rows[0]!.id]
    );
    expect(requeued.rows[0]).toEqual({
      state: "pending",
      attempt_count: 0,
      last_error_class: null,
      transport_id: null,
      dispatch_epoch: "2",
      lease_owner: null
    });
    const liveLease = await pool.query<{
      state: string;
      dispatch_epoch: string | null;
      lease_owner: string | null;
    }>(
      "select state,dispatch_epoch,lease_owner from pds_outbox_entries where id=$1",
      [checkpointRows.rows[1]!.id]
    );
    expect(liveLease.rows[0]).toMatchObject({
      state: "uploading",
      dispatch_epoch: "1",
      lease_owner: "active-worker"
    });
    expect(v1Outbox.rows[0]).toMatchObject({
      state: "pending",
      dispatch_epoch: null
    });
    await pool.query(
      "update pds_outbox_entries set lease_until=now()-interval '1 second' where id=$1",
      [checkpointRows.rows[1]!.id]
    );
    await expect(
      localRepository.refreshPdsCheckpointRecipients({ userId, groupId })
    ).resolves.toBe(1);
    const reclaimed = await pool.query<{
      state: string;
      dispatch_epoch: string | null;
      lease_owner: string | null;
    }>(
      "select state,dispatch_epoch,lease_owner from pds_outbox_entries where id=$1",
      [checkpointRows.rows[1]!.id]
    );
    expect(reclaimed.rows[0]).toMatchObject({
      state: "pending",
      dispatch_epoch: "2",
      lease_owner: null
    });
    await add(4, true);
    await pool.query(
      "update personal_device_group_members set status='revoked' where device_id=$1",
      [deviceId]
    );
    await expect(
      localRepository.checkpointPdsSourceSession(input)
    ).rejects.toThrow("PdsPublicationMembershipError");
    expect(published).toHaveLength(2);
  });
});
