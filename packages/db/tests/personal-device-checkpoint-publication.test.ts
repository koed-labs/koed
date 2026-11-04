import { canonicalConversationItemKey } from "@koed/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPdsLocalSyncService } from "../../../apps/worker/src/personal-device-sync-service.js";
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
    const repositoryIdentity = {
      kind: "portable_repository" as const,
      key: "gr_publication_fixture",
      root: "/source/checkout",
      branch: "capture-branch",
      reason: "origin" as const,
      checkoutId: "source-checkout",
      originatingDeviceId: deviceId,
      selectedRemote: "origin",
      anchorDisplay: "example.test/team/publication"
    };
    const session = await memory.createCapturedSession(
      { userId },
      {
        idempotencyKey: randomUUID(),
        externalSessionId: randomUUID(),
        sourceRuntime: "pi",
        sourceKind: "pi",
        sourceAdapterVersion: "pi-session-v1",
        captureMethod: "transcript",
        cwd: "/source/checkout/subdirectory",
        repositoryIdentity
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
        expect(value.source.repositoryAssignment).toEqual({
          state: "recorded",
          version: 1,
          automatic: repositoryIdentity,
          override: null,
          effective: repositoryIdentity
        });
        expect(value.source.capturedCwd).toBe("/source/checkout/subdirectory");
        expect(value.source.branchObservation).toBe("capture-branch");
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

    // Committed rows must yield to other work until their next reconciliation.
    await pool.query(
      `update pds_outbox_entries set state='committed',transport_id='transport',
         retry_at='1960-01-01T00:00:00Z',lease_owner=null,lease_until=null where id=$1`,
      [checkpointRows.rows[0]!.id]
    );
    await pool.query(
      `update pds_outbox_entries set state='committed',transport_id='transport-2',
         retry_at=now()+interval '1 hour',lease_owner=null,lease_until=null where id=$1`,
      [checkpointRows.rows[1]!.id]
    );
    expect(await localRepository.getPdsLocalSyncWakeAt()).toBe(
      "1960-01-01T00:00:00.000Z"
    );
    expect(
      await localRepository.getPdsLocalSyncWakeAt({
        excludeSourceAcknowledgements: true
      })
    ).not.toBe("1960-01-01T00:00:00.000Z");
    const claimed = await localRepository.claimPdsCommittedOutbox({
      workerId: "retry-test"
    });
    expect(claimed.map((row) => row.id)).not.toContain(
      checkpointRows.rows[1]!.id
    );
    expect(claimed.map((row) => row.id)).toContain(checkpointRows.rows[0]!.id);
    expect(
      await localRepository.releasePdsCommittedOutbox({
        workerId: "retry-test",
        outboxId: checkpointRows.rows[0]!.id
      })
    ).toBe(true);
    await pool.query(
      "update pds_outbox_entries set retry_at=now() where id=$1",
      [checkpointRows.rows[1]!.id]
    );
    const restarted = createPersonalDeviceSyncLocalRepository(pool);
    const next = await restarted.claimPdsCommittedOutbox({
      workerId: "retry-test"
    });
    expect(next.map((row) => row.id)).not.toContain(checkpointRows.rows[0]!.id);
    expect(next.map((row) => row.id)).toContain(checkpointRows.rows[1]!.id);
    expect(await restarted.getPdsLocalSyncWakeAt()).not.toBeNull();
    await pool.query(
      "update pds_outbox_entries set lease_until=now()-interval '1 second' where id=$1",
      [checkpointRows.rows[1]!.id]
    );
    expect(
      (await restarted.claimPdsCommittedOutbox({ workerId: "new-lease" })).map(
        (row) => row.id
      )
    ).toContain(checkpointRows.rows[1]!.id);
    expect(
      await restarted.completePdsOutbox({
        workerId: "retry-test",
        outboxId: checkpointRows.rows[1]!.id,
        state: "acked",
        transportId: "transport-2"
      })
    ).toBe(false);
    expect(
      await restarted.completePdsOutbox({
        workerId: "new-lease",
        outboxId: checkpointRows.rows[1]!.id,
        state: "acked",
        transportId: "transport-2"
      })
    ).toBe(true);

    const artifact = await pool.query<{ id: string }>(
      `insert into pds_portable_artifacts
       (group_id,owner_user_id,artifact_id,work_identity,artifact_class,source_package_id,
        source_manifest_hash,source_fingerprint,source_closure_hash,producer_device_id,
        claim_generation,compatibility_contract_hash,payload_hash,transport_manifest_hash,
        semantic_claim_completed_at,encrypted_envelope)
       select id,$1,$2,$2,'memory_event/v1','source','hash','fingerprint','closure',
         $3,'1','contract','payload','manifest',now(),'{}'::jsonb
       from personal_device_groups where group_id=$4 returning id`,
      [userId, randomUUID(), deviceId, groupId]
    );
    const artifactOutbox = await pool.query<{ id: string }>(
      `insert into pds_artifact_outbox_entries
       (artifact_id,idempotency_key,state,lease_owner,lease_until)
       values ($1,$2,'uploading','old','1971-01-01T00:00:00Z') returning id`,
      [artifact.rows[0]!.id, randomUUID()]
    );
    const artifactId = artifactOutbox.rows[0]!.id;
    const futureRetry = await pool.query<{ retry_at: Date }>(
      "update pds_artifact_outbox_entries set retry_at=now()+interval '5 seconds' where id=$1 returning retry_at",
      [artifactId]
    );
    expect(
      (await memory.claimPdsArtifactOutbox({ workerId: "too-early" })).map(
        (row) => row.id
      )
    ).not.toContain(artifactId);
    expect(await restarted.getPdsLocalSyncWakeAt()).toBe(
      futureRetry.rows[0]!.retry_at.toISOString()
    );
    expect(
      await restarted.getPdsLocalSyncWakeAt({
        excludeArtifactAcknowledgements: true
      })
    ).toBe(futureRetry.rows[0]!.retry_at.toISOString());
    await pool.query(
      "update pds_artifact_outbox_entries set state='committed',retry_at='1960-01-01T00:00:00Z',lease_until=null where id=$1",
      [artifactId]
    );
    expect(await restarted.getPdsLocalSyncWakeAt()).toBe(
      "1960-01-01T00:00:00.000Z"
    );
    expect(
      await restarted.getPdsLocalSyncWakeAt({
        excludeArtifactAcknowledgements: true
      })
    ).not.toBe("1960-01-01T00:00:00.000Z");
    await pool.query(
      "update pds_artifact_outbox_entries set state='uploading',lease_until='1971-01-01T00:00:00Z',retry_at='1970-01-01T00:00:00Z' where id=$1",
      [artifactId]
    );
    expect(await restarted.getPdsLocalSyncWakeAt()).toBe(
      "1971-01-01T00:00:00.000Z"
    );
    const recovered = await memory.claimPdsArtifactOutbox({
      workerId: "restart"
    });
    expect(recovered.map((row) => row.id)).toContain(artifactId);
    await pool.query(
      "update pds_artifact_outbox_entries set lease_until=now()-interval '1 second' where id=$1",
      [artifactId]
    );
    expect(
      await memory.retryPdsArtifactOutbox({
        workerId: "restart",
        outboxId: artifactId,
        retryAt: new Date(),
        errorClass: "Error"
      })
    ).toBe(false);
    expect(
      (await memory.claimPdsArtifactOutbox({ workerId: "new" })).map(
        (row) => row.id
      )
    ).toContain(artifactId);
    expect(
      await memory.completePdsArtifactOutbox({
        workerId: "new",
        outboxId: artifactId,
        state: "committed",
        transportId: "transport"
      })
    ).toBe(true);
    expect(
      (
        await memory.claimPdsArtifactOutbox({
          workerId: "new",
          state: "committed"
        })
      ).map((row) => row.id)
    ).toContain(artifactId);
    await pool.query(
      "update pds_artifact_outbox_entries set lease_until=now()-interval '1 second' where id=$1",
      [artifactId]
    );
    expect(
      await memory.releasePdsCommittedArtifactOutbox({
        workerId: "new",
        outboxId: artifactId
      })
    ).toBe(false);
    expect(
      (
        await memory.claimPdsArtifactOutbox({
          workerId: "new",
          state: "committed"
        })
      ).map((row) => row.id)
    ).toContain(artifactId);
    expect(
      await memory.releasePdsCommittedArtifactOutbox({
        workerId: "new",
        outboxId: artifactId
      })
    ).toBe(true);
    expect(
      (
        await memory.claimPdsArtifactOutbox({
          workerId: "new",
          state: "committed"
        })
      ).map((row) => row.id)
    ).not.toContain(artifactId);

    // Concurrent runs of one service must not share publication leases.
    for (const kind of ["source", "artifact"] as const) {
      for (const staleOutcome of ["complete", "retry"] as const) {
        await pool.query(
          "update pds_outbox_entries set retry_at=now()+interval '1 hour' where closure_id in (select c.id from pds_session_closures c join personal_device_groups g on g.id=c.group_id where g.group_id=$1)",
          [groupId]
        );
        await pool.query(
          "update pds_artifact_outbox_entries set retry_at=now()+interval '1 hour' where artifact_id=$1",
          [artifact.rows[0]!.id]
        );
        const table =
          kind === "source"
            ? "pds_outbox_entries"
            : "pds_artifact_outbox_entries";
        const outboxId =
          kind === "source" ? checkpointRows.rows[0]!.id : artifactId;
        await pool.query(
          `update ${table} set state='pending',retry_at=now(),lease_owner=null,lease_until=null,transport_id=null where id=$1`,
          [outboxId]
        );
        await pool.query(
          "update pds_portable_artifacts set state='ready' where id=$1",
          [artifact.rows[0]!.id]
        );
        const calls: Array<{
          workerId: string;
          resolve: (value: { state: "committed"; transportId: string }) => void;
          reject: (error: Error) => void;
        }> = [];
        let notify!: () => void;
        const waitForCall = () =>
          new Promise<void>((resolve) => {
            notify = resolve;
          });
        let called = waitForCall();
        const publish = (input: { workerId: string }) =>
          new Promise<{ state: "committed"; transportId: string }>(
            (resolve, reject) => {
              calls.push({ workerId: input.workerId, resolve, reject });
              notify();
            }
          );
        const service = createPdsLocalSyncService({
          repository: memory,
          secureRuntime: {
            heartbeatGroups: async () => [groupId],
            poll: async () => [],
            publish,
            publishArtifact: publish,
            outboundState: async () => "committed",
            materialize: async () => {
              throw new Error("unexpected materialize");
            }
          },
          wakePool: pool,
          logger: { warn() {} } as unknown as Parameters<
            typeof createPdsLocalSyncService
          >[0]["logger"],
          workerId: "same-service"
        });
        const first = service.run();
        await called;
        await pool.query(
          `update ${table} set lease_until=now()-interval '1 second' where id=$1`,
          [outboxId]
        );
        called = waitForCall();
        const second = service.run();
        await called;
        const oldOwner = calls[0]!.workerId;
        if (staleOutcome === "complete")
          calls[0]!.resolve({ state: "committed", transportId: "stale" });
        else calls[0]!.reject(new Error("stale"));
        await first;
        const row = await pool.query<{
          state: string;
          lease_owner: string;
          transport_id: string | null;
        }>(`select state,lease_owner,transport_id from ${table} where id=$1`, [
          outboxId
        ]);
        expect(row.rows[0]).toMatchObject({
          state: "uploading",
          lease_owner: calls[1]!.workerId,
          transport_id: null
        });
        const staleRetry = {
          workerId: oldOwner,
          outboxId,
          errorClass: "Error",
          retryAt: new Date()
        };
        const staleComplete = {
          workerId: oldOwner,
          outboxId,
          state: "committed" as const,
          transportId: "stale"
        };
        expect(
          await (kind === "source"
            ? memory.retryPdsOutbox(staleRetry)
            : memory.retryPdsArtifactOutbox(staleRetry))
        ).toBe(false);
        expect(
          await (kind === "source"
            ? memory.completePdsOutbox(staleComplete)
            : memory.completePdsArtifactOutbox(staleComplete))
        ).toBe(false);
        calls[1]!.resolve({ state: "committed", transportId: "fresh" });
        await second;
        const completed = await pool.query<{
          state: string;
          transport_id: string;
        }>(`select state,transport_id from ${table} where id=$1`, [outboxId]);
        expect(completed.rows[0]).toMatchObject({
          state: "committed",
          transport_id: "fresh"
        });
        await service.stop();
      }
    }
  });
});
