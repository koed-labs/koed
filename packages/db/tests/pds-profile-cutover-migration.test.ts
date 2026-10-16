import { createPrivateKey, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalizePdsJson,
  createPdsSessionCheckpointManifest,
  createPdsSessionCheckpointPackage,
  createPdsSessionPackageRuntimeContext,
  isPdsSessionCheckpointManifest,
  verifyPdsSessionCheckpointManifest,
  type CreatePdsSessionPackageRuntimeContextInput,
  type PdsConversationSourceItem,
  type PdsSessionCheckpointManifest,
  type PdsSessionPackage
} from "@koed/shared";
import { pdsCheckpointMaterializationSource } from "../../../apps/worker/src/personal-device-sync-runtime.js";
import {
  createDbPool,
  createMemorySourceRepository,
  createPersonalDeviceSyncLocalRepository,
  createPersonalDeviceSyncRepository,
  runDbMigrations
} from "../src/index.js";

// This migration test requires a dedicated empty disposable database.
const databaseUrl = process.env.PDS_PROFILE_MIGRATION_TEST_DATABASE_URL;
type LegacyFixture = {
  manifest: Omit<
    PdsSessionCheckpointManifest,
    "version" | "profileTransition"
  > & { version: "3" };
  encryptedPackage: PdsSessionPackage;
  runtimeInput: Omit<CreatePdsSessionPackageRuntimeContextInput, "now"> & {
    now: string;
  };
  originPublicKey: string;
  originPrivateKeyPkcs8: string;
  servingPrivateKeyPkcs8: string;
  sourceFingerprintKey: string;
  tombstoneFloorKey: string;
};

describe.skipIf(!databaseUrl)("PDS pre-cutover profile migration", () => {
  it("preserves signed V3 bytes, ledger, Session and unresolved assignment through a V4 baseline", async () => {
    const pool = createDbPool({ connectionString: databaseUrl });
    const folder = await mkdtemp(
      fileURLToPath(
        new URL("../../../scratch/pds-profile-migrations-", import.meta.url)
      )
    );
    try {
      expect(
        (
          await pool.query<{ existing: string | null }>(
            "select to_regclass('public.sessions') as existing"
          )
        ).rows[0]!.existing
      ).toBeNull();
      const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
      const journal = JSON.parse(
        await readFile(join(migrations, "meta/_journal.json"), "utf8")
      ) as {
        entries: Array<{ idx: number; tag: string }>;
      };
      await mkdir(join(folder, "meta"));
      const prior = journal.entries.filter((entry) => entry.idx < 46);
      for (const entry of prior)
        await copyFile(
          join(migrations, `${entry.tag}.sql`),
          join(folder, `${entry.tag}.sql`)
        );
      await writeFile(
        join(folder, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: prior })
      );
      await runDbMigrations(pool, { migrationsFolder: folder });
      const legacy = JSON.parse(
        await readFile(
          new URL(
            "../../shared/test-fixtures/pds-pre-cutover-v3.json",
            import.meta.url
          ),
          "utf8"
        )
      ) as LegacyFixture;
      expect(isPdsSessionCheckpointManifest(legacy.manifest)).toBe(false);
      const runtime = createPdsSessionPackageRuntimeContext({
        ...legacy.runtimeInput,
        now: new Date(legacy.runtimeInput.now)
      });
      const source = legacy.manifest;
      const manifest = createPdsSessionCheckpointManifest({
        runtime,
        originDeploymentId: source.originDeploymentId,
        sourceSequence: "8",
        sourceNativeSessionId: source.sourceNativeSessionId,
        contentEpoch: source.contentEpoch,
        sourceSession: source.sourceSession,
        repositoryAssignment: source.repositoryAssignment,
        checkpoint: {
          version: "1",
          ordinal: "1",
          previousClosureHash: source.sourceClosureHash
        },
        profileTransition: {
          previousProfile: "pre_repository_cutover",
          previousOrdinal: "0",
          previousSourceSequence: source.sourceSequence,
          previousClosureHash: source.sourceClosureHash,
          previousManifestHash:
            legacy.encryptedPackage.header.sourceManifestHash
        },
        terminalCursor: source.terminal.cursor,
        items: source.rawClosure.records.map(
          (record) =>
            JSON.parse(
              Buffer.from(record.payload, "base64url").toString("utf8")
            ) as PdsConversationSourceItem
        ),
        sourceFingerprintKey: legacy.sourceFingerprintKey,
        tombstoneFloorKey: legacy.tombstoneFloorKey,
        originSigningPrivateKey: createPrivateKey({
          key: Buffer.from(legacy.originPrivateKeyPkcs8, "base64"),
          format: "der",
          type: "pkcs8"
        })
      });
      verifyPdsSessionCheckpointManifest(
        manifest,
        legacy.originPublicKey,
        manifest.originSignature.signerKeyId
      );
      expect(manifest.rawClosure).toEqual(source.rawClosure);
      const upgradedPackage = createPdsSessionCheckpointPackage({
        runtime,
        manifest,
        expiresAt: "2030-07-15T00:00:00.000Z",
        servingSigningPrivateKey: createPrivateKey({
          key: Buffer.from(legacy.servingPrivateKeyPkcs8, "base64"),
          format: "der",
          type: "pkcs8"
        })
      });
      const groupId = legacy.runtimeInput.groupId;
      const deviceId = source.originDeviceId;
      const memory = createMemorySourceRepository(pool);
      const userId = (
        await memory.createUser({
          email: `pds-profile-${randomUUID()}@example.test`
        })
      ).id;
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
      const groupDbId = (
        await pool.query<{ id: string }>(
          "select id from personal_device_groups where group_id=$1",
          [groupId]
        )
      ).rows[0]!.id;
      const historical = {
        state: "historical_unresolved" as const,
        version: 1,
        automatic: null,
        override: null,
        effective: null
      };
      const mapped = pdsCheckpointMaterializationSource(
        groupId,
        manifest,
        historical
      );
      const session = (
        await pool.query<{ id: string }>(
          `insert into sessions
        (owner_user_id,visibility,logical_session_id,external_session_id,source_runtime,capture_method,source_kind,source_adapter_version,metadata)
        values ($1,'personal',$2,$3,$4,'transcript',$5,$6,$7::jsonb) returning id`,
          [
            userId,
            source.sourceSession.logicalSessionId,
            source.sourceSession.externalSessionId,
            source.sourceSession.sourceRuntime,
            source.sourceSession.sourceAdapter,
            source.sourceSession.sourceAdapterVersion,
            JSON.stringify({
              pds: {
                groupId,
                sourceCreatedAt: source.sourceSession.sourceCreatedAt
              }
            })
          ]
        )
      ).rows[0]!;
      const items = await memory.createConversationItems(
        { userId },
        {
          items: mapped.sourceItems.map((item) => ({
            ...item,
            sessionId: session.id
          }))
        }
      );
      await memory.createConversationItems(
        { userId },
        {
          items: [
            {
              sessionId: session.id,
              sourceKind: mapped.sourceSession.sourceKind,
              sourceAdapterVersion: mapped.sourceSession.sourceAdapterVersion,
              sourceTransport: "pds_relay",
              externalSessionId: source.sourceSession.externalSessionId,
              externalThreadId: source.sourceSession.externalSessionId,
              sourceRecordType: "pds_turn_completed",
              sourceEventType: "pds_turn_completed",
              sourceSequence: Number(source.checkpoint.itemCount),
              externalItemId: `pds-checkpoint-terminal:${source.sourceFingerprint}:0`,
              eventTime: source.originSignedAt,
              observedAt: source.originSignedAt,
              observationKind: "control",
              observationComponent: "control",
              rawJson: {
                type: "pds_turn_completed",
                role: "system",
                content: ""
              },
              sourceHash: source.sourceClosureHash,
              idempotencyKey: `pds-checkpoint-terminal:${groupId}:${source.sourceFingerprint}:0`,
              metadata: {
                transcriptType: "pds_turn_completed",
                sourceRole: "system",
                pds: {
                  originDeviceId: deviceId,
                  sourceSequence: source.sourceSequence,
                  checkpointOrdinal: "0"
                }
              }
            }
          ]
        }
      );
      const originalItems = (
        await pool.query<{
          id: string;
          source_hash: string;
          raw_json: unknown;
        }>(
          "select id,source_hash,raw_json from conversation_items where session_id=$1 order by id",
          [session.id]
        )
      ).rows;
      const replicaId = randomUUID();
      const retainedId = randomUUID();
      const oldBytes = canonicalizePdsJson(legacy.encryptedPackage);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "select set_config('koed.pds_replica_append_id',$1,true)",
          [replicaId]
        );
        await client.query(
          `insert into pds_retained_packages
          (id,group_id,owner_user_id,package_id,source_manifest_hash,source_profile,origin_deployment_id,origin_device_id,source_sequence,logical_memory_id,deletion_floor_token,source_fingerprint,source_closure_hash,checkpoint_ordinal,checkpoint_item_count,encrypted_envelope)
          values ($1,$2,$3,$4,$5,'cumulative_checkpoint',$6,$7,$8,$9,$10,$11,$12,'0',$13,$14::jsonb)`,
          [
            retainedId,
            groupDbId,
            userId,
            source.packageId,
            legacy.encryptedPackage.header.sourceManifestHash,
            source.originDeploymentId,
            deviceId,
            source.sourceSequence,
            source.logicalMemoryId,
            source.deletionFloorToken,
            source.sourceFingerprint,
            source.sourceClosureHash,
            source.checkpoint.itemCount,
            oldBytes
          ]
        );
        await client.query(
          `insert into pds_logical_replicas
          (id,group_id,owner_user_id,materialization_profile,source_fingerprint,closure_hash,checkpoint_ordinal,checkpoint_item_count,local_session_id,materialization_state)
          values ($1,$2,$3,'cumulative_checkpoint',$4,$5,'0',$6,$7,'ready')`,
          [
            replicaId,
            groupDbId,
            userId,
            source.sourceFingerprint,
            source.sourceClosureHash,
            source.checkpoint.itemCount,
            session.id
          ]
        );
        await client.query(
          `insert into pds_replica_checkpoints
          (replica_id,retained_package_id,checkpoint_ordinal,source_closure_hash,item_count,source_manifest_hash,accepted_at)
          values ($1,$2,'0',$3,$4,$5,now())`,
          [
            replicaId,
            retainedId,
            source.sourceClosureHash,
            source.checkpoint.itemCount,
            legacy.encryptedPackage.header.sourceManifestHash
          ]
        );
        await client.query(
          `insert into pds_replica_observations
          (replica_id,retained_package_id,origin_deployment_id,origin_device_id,source_sequence,source_closed_at,observed_at)
          values ($1,$2,$3,$4,$5,now(),now())`,
          [
            replicaId,
            retainedId,
            source.originDeploymentId,
            deviceId,
            source.sourceSequence
          ]
        );
        for (let index = 0; index < items.length; index++)
          await client.query(
            "insert into pds_source_item_mappings (replica_id,conversation_item_id,source_ordinal) values ($1,$2,$3)",
            [replicaId, items[index]!.id, String(index)]
          );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await runDbMigrations(pool);
      const local = createPersonalDeviceSyncLocalRepository(pool);
      const workerId = `worker-${randomUUID()}`;
      await local.receivePdsInbox({
        userId,
        groupId,
        packageId: manifest.packageId,
        sourceManifestHash: upgradedPackage.header.sourceManifestHash
      });
      const inbox = (await local.claimPdsInbox({ workerId, limit: 10 }))[0]!;
      const retained = await local.retainPdsInboundPackage({
        userId,
        groupId,
        inboxId: inbox.id,
        packageId: manifest.packageId,
        sourceManifestHash: upgradedPackage.header.sourceManifestHash,
        originDeploymentId: manifest.originDeploymentId,
        originDeviceId: deviceId,
        sourceSequence: manifest.sourceSequence,
        logicalMemoryId: manifest.logicalMemoryId,
        deletionFloorToken: manifest.deletionFloorToken,
        sourceProfile: "cumulative_checkpoint",
        sourceFingerprint: manifest.sourceFingerprint,
        sourceClosureHash: manifest.sourceClosureHash,
        checkpoint: manifest.checkpoint,
        encryptedEnvelope: upgradedPackage
      });
      const materialization = {
        workerId,
        inboxId: inbox.id,
        userId,
        groupId,
        retainedPackageId: retained.retainedPackageId,
        packageId: manifest.packageId,
        sourceManifestHash: upgradedPackage.header.sourceManifestHash,
        sourceFingerprint: manifest.sourceFingerprint,
        closureHash: manifest.sourceClosureHash,
        logicalMemoryId: manifest.logicalMemoryId,
        deletionFloorToken: manifest.deletionFloorToken,
        originDeploymentId: manifest.originDeploymentId,
        originDeviceId: deviceId,
        sourceSequence: manifest.sourceSequence,
        sourceCheckpointAt: new Date(manifest.originSignedAt),
        observedAt: new Date(),
        checkpoint: manifest.checkpoint,
        profileTransition: manifest.profileTransition,
        ...mapped
      };
      await expect(
        local.materializePdsSessionCheckpoint({
          ...materialization,
          profileTransition: null
        })
      ).rejects.toThrow("PdsSourceProfileBaselineRequired");
      await expect(
        local.materializePdsSessionCheckpoint({
          ...materialization,
          profileTransition: {
            ...manifest.profileTransition!,
            previousManifestHash: source.packageId
          }
        })
      ).rejects.toThrow("PdsSourceProfileBoundaryConflict");
      const result =
        await local.materializePdsSessionCheckpoint(materialization);
      expect(
        (
          await pool.query<{
            id: string;
            source_hash: string;
            raw_json: unknown;
          }>(
            "select id,source_hash,raw_json from conversation_items where id=any($1::uuid[]) order by id",
            [originalItems.map((item) => item.id as string)]
          )
        ).rows
      ).toEqual(originalItems);
      expect(result).toMatchObject({
        replicaId,
        localSessionId: session.id,
        state: "ready",
        conflict: false,
        deferred: false
      });
      expect(
        (await memory.getCapturedSession({ userId }, session.id))
          ?.repositoryAssignment
      ).toMatchObject({ ...historical, version: historical.version + 1 });
      const persisted = await pool.query<{ encrypted_envelope: unknown }>(
        "select encrypted_envelope from pds_retained_packages where id=$1",
        [retainedId]
      );
      expect(canonicalizePdsJson(persisted.rows[0]!.encrypted_envelope)).toBe(
        oldBytes
      );

      expect(
        (
          await pool.query(
            "select checkpoint_ordinal from pds_replica_checkpoints where replica_id=$1 order by checkpoint_ordinal::numeric",
            [replicaId]
          )
        ).rows
      ).toEqual([{ checkpoint_ordinal: "0" }, { checkpoint_ordinal: "1" }]);
      await expect(
        pool.query(
          "update pds_logical_replicas set source_profile_epoch=0 where id=$1",
          [replicaId]
        )
      ).rejects.toThrow("contiguous append");
    } finally {
      await pool.end();
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);
});
