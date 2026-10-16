import { createPrivateKey, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalizePdsJson,
  repositoryIdentitySchema,
  type PdsConversationSourceItem,
  createPdsSessionManifest,
  createPdsSessionPackage,
  createPdsSessionPackageRuntimeContext,
  verifyPdsSessionManifest,
  type CreatePdsSessionPackageRuntimeContextInput,
  type PdsSessionManifest,
  type PdsSessionPackage
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  createPersonalDeviceSyncLocalRepository,
  createPersonalDeviceSyncRepository,
  runDbMigrations
} from "../src/index.js";
const databaseUrl = process.env.PDS_CLOSED_RECEIVER_MIGRATION_TEST_DATABASE_URL;
type CryptoFixture = {
  runtimeInput: Omit<CreatePdsSessionPackageRuntimeContextInput, "now"> & {
    now: string;
  };
  originPublicKey: string;
  originPrivateKeyPkcs8: string;
  servingPrivateKeyPkcs8: string;
  sourceFingerprintKey: string;
  tombstoneFloorKey: string;
};
type SourceFixture = {
  manifest: Omit<PdsSessionManifest, "version" | "profileTransition"> & {
    version: "2";
  };
  encryptedPackage: PdsSessionPackage;
  session: Record<string, unknown>;
  turns: Record<string, unknown>[];
  items: Record<string, unknown>[];
  replica: Record<string, unknown>;
  observations: Record<string, unknown>[];
  retained: Record<string, unknown>;
  mappings: Record<string, unknown>[];
};
describe.skipIf(!databaseUrl)(
  "PDS pre-cutover closed receiver migration",
  () => {
    it("reuses its old Session and raw source while accepting exactly one signed boundary", async () => {
      const pool = createDbPool({ connectionString: databaseUrl });
      const folder = await mkdtemp(
        join(tmpdir(), "koed-pds-source-migrations-")
      );
      try {
        expect(
          (
            await pool.query<{ existing: string | null }>(
              "select to_regclass('public.sessions') as existing"
            )
          ).rows[0]!.existing
        ).toBeNull();
        const migrations = fileURLToPath(
          new URL("../drizzle/", import.meta.url)
        );
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
        ) as CryptoFixture;
        const old = JSON.parse(
          await readFile(
            new URL(
              "../../shared/test-fixtures/pds-pre-cutover-closed-receiver-v2.json",
              import.meta.url
            ),
            "utf8"
          )
        ) as SourceFixture;
        const memory = createMemorySourceRepository(pool);
        const userId = (
          await memory.createUser({
            email: `source-upgrade-${randomUUID()}@example.test`
          })
        ).id;
        const groupId = legacy.runtimeInput.groupId;
        const deviceId = old.manifest.originDeviceId;
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
        await pool.query(
          "update personal_sync_policies set enabled_at='2026-07-15T00:00:00.000Z' where group_id=$1",
          [groupDbId]
        );
        type Table =
          | "sessions"
          | "turns"
          | "conversation_items"
          | "pds_logical_replicas"
          | "pds_replica_observations"
          | "pds_retained_packages"
          | "pds_source_item_mappings";
        const seed = async (table: Table, row: Record<string, unknown>) =>
          pool.query(
            `insert into ${table} select (jsonb_populate_record(null::${table},$1::jsonb)).*`,
            [JSON.stringify(row)]
          );
        await seed("sessions", { ...old.session, owner_user_id: userId });
        for (const turn of old.turns)
          await seed("turns", { ...turn, owner_user_id: userId });
        for (const item of old.items)
          await seed("conversation_items", { ...item, owner_user_id: userId });
        await seed("pds_logical_replicas", {
          ...old.replica,
          group_id: groupDbId,
          owner_user_id: userId
        });
        await seed("pds_retained_packages", {
          ...old.retained,
          group_id: groupDbId,
          owner_user_id: userId
        });
        for (const mapping of old.mappings)
          await seed("pds_source_item_mappings", mapping);
        for (const observation of old.observations)
          await seed("pds_replica_observations", observation);
        await runDbMigrations(pool);

        const local = createPersonalDeviceSyncLocalRepository(pool);
        const sessionId = String(old.session.id);

        const runtime = createPdsSessionPackageRuntimeContext({
          ...legacy.runtimeInput,
          now: new Date(legacy.runtimeInput.now)
        });
        const boundary = {
          previousProfile: "pre_repository_cutover" as const,
          previousManifestHash: old.encryptedPackage.header.sourceManifestHash,
          previousSourceSequence: old.manifest.sourceSequence,
          previousClosureHash: old.manifest.sourceClosureHash
        };
        const source = old.manifest;
        const manifest = createPdsSessionManifest({
          runtime,
          originDeploymentId: source.originDeploymentId,
          sourceSequence: (BigInt(source.sourceSequence) + 1n).toString(),
          sourceNativeSessionId: source.sourceNativeSessionId,
          contentEpoch: source.contentEpoch,
          closedSession: source.closedSession,
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
          }),
          profileTransition: boundary
        });
        verifyPdsSessionManifest(
          manifest,
          legacy.originPublicKey,
          manifest.originSignature.signerKeyId
        );
        const pkg = createPdsSessionPackage({
          runtime,
          manifest,
          expiresAt: "2030-07-15T00:00:00.000Z",
          servingSigningPrivateKey: createPrivateKey({
            key: Buffer.from(legacy.servingPrivateKeyPkcs8, "base64"),
            format: "der",
            type: "pkcs8"
          })
        });
        const existing = await local.getPdsClosedReplicaSource({
          logicalSessionId: manifest.closedSession.logicalSessionId,
          externalSessionId: manifest.closedSession.externalSessionId,
          userId,
          groupId,
          sourceFingerprint: manifest.sourceFingerprint,
          closureHash: manifest.sourceClosureHash
        });
        expect(existing).toEqual({
          id: sessionId,
          itemIds: old.items.map((item) => item.id)
        });
        expect(
          await local.getPdsClosedReplicaSource({
            logicalSessionId: manifest.closedSession.logicalSessionId,
            externalSessionId: manifest.closedSession.externalSessionId,
            userId: randomUUID(),
            groupId,
            sourceFingerprint: manifest.sourceFingerprint,
            closureHash: manifest.sourceClosureHash
          })
        ).toBeNull();
        const workerId = "closed-receiver-upgrade";
        await local.receivePdsInbox({
          userId,
          groupId,
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash
        });
        const inbox = (await local.claimPdsInbox({ workerId }))[0]!;
        const retained = await local.retainPdsInboundPackage({
          userId,
          groupId,
          inboxId: inbox.id,
          packageId: manifest.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash,
          originDeploymentId: manifest.originDeploymentId,
          originDeviceId: manifest.originDeviceId,
          sourceSequence: manifest.sourceSequence,
          logicalMemoryId: manifest.logicalMemoryId,
          deletionFloorToken: manifest.deletionFloorToken,
          sourceFingerprint: manifest.sourceFingerprint,
          sourceClosureHash: manifest.sourceClosureHash,
          encryptedEnvelope: pkg
        });
        const input = {
          userId,
          groupId,
          workerId,
          inboxId: inbox.id,
          retainedPackageId: retained.retainedPackageId,
          localSessionId: sessionId,
          sourceFingerprint: manifest.sourceFingerprint,
          closureHash: manifest.sourceClosureHash,
          originDeploymentId: manifest.originDeploymentId,
          originDeviceId: manifest.originDeviceId,
          sourceSequence: manifest.sourceSequence,
          sourceClosedAt: new Date(manifest.closedSession.sourceClosedAt),
          observedAt: new Date(),
          sourceItemIds: existing!.itemIds,
          pdsRepositoryAssignment: manifest.repositoryAssignment
        };
        await expect(local.materializePdsReplica(input)).rejects.toThrow(
          "PdsClosedProfileTransitionRequired"
        );
        await expect(
          local.materializePdsReplica({
            ...input,
            closedProfileTransition: {
              ...boundary,
              previousManifestHash: Buffer.alloc(32, 25).toString("base64url")
            }
          })
        ).rejects.toThrow("PdsClosedProfileBoundaryConflict");
        await expect(
          local.materializePdsReplica({
            ...input,
            closedProfileTransition: boundary,
            sourceItemIds: []
          })
        ).rejects.toThrow("PdsClosedProfileSourceConflict");
        await expect(
          local.materializePdsReplica({
            ...input,
            closedProfileTransition: boundary,
            sourceClosedAt: new Date(0)
          })
        ).rejects.toThrow("PdsClosedProfileBoundaryConflict");
        await expect(
          local.getPdsClosedReplicaSource({
            userId,
            groupId,
            sourceFingerprint: manifest.sourceFingerprint,
            closureHash: manifest.sourceClosureHash,
            logicalSessionId: randomUUID(),
            externalSessionId: manifest.closedSession.externalSessionId
          })
        ).rejects.toThrow("PdsClosedProfileNativeIdentityConflict");
        const result = await local.materializePdsReplica({
          ...input,
          closedProfileTransition: boundary
        });
        expect(result).toMatchObject({
          replicaId: old.replica.id,
          state: "ready",
          conflict: false
        });
        await expect(
          local.materializePdsReplica({
            ...input,
            closedProfileTransition: boundary
          })
        ).resolves.toEqual(result);
        expect(
          (
            await pool.query<{ source_profile_epoch: number }>(
              "select source_profile_epoch from pds_logical_replicas where id=$1",
              [old.replica.id]
            )
          ).rows[0]!.source_profile_epoch
        ).toBe(1);
        expect(
          (await memory.getCapturedSession({ userId }, sessionId))
            ?.repositoryAssignment
        ).toMatchObject({ state: "historical_unresolved", effective: null });
        expect(
          (
            await pool.query(
              "select id,raw_json,source_hash from conversation_items where session_id=$1 order by source_sequence",
              [sessionId]
            )
          ).rows
        ).toEqual(
          old.items.map((item) => ({
            id: item.id,
            raw_json: item.raw_json,
            source_hash: item.source_hash
          }))
        );
        expect(
          canonicalizePdsJson(
            (
              await pool.query<{ encrypted_envelope: unknown }>(
                "select encrypted_envelope from pds_retained_packages where id=$1",
                [old.retained.id]
              )
            ).rows[0]!.encrypted_envelope
          )
        ).toBe(canonicalizePdsJson(old.encryptedPackage));
        expect(
          (
            await pool.query(
              "select id,conversation_item_id from pds_source_item_mappings where replica_id=$1 order by source_ordinal::numeric",
              [old.replica.id]
            )
          ).rows
        ).toEqual(
          old.mappings.map((mapping) => ({
            id: mapping.id,
            conversation_item_id: mapping.conversation_item_id
          }))
        );
        expect(
          (
            await pool.query(
              "select id from pds_replica_observations where replica_id=$1",
              [old.replica.id]
            )
          ).rowCount
        ).toBe(2);
        const assignment = (await memory.getCapturedSession(
          { userId },
          sessionId
        ))!.repositoryAssignment!;
        const identity = repositoryIdentitySchema.parse(
          old.session.repository_automatic_identity
        );
        const moved = await memory.moveCapturedSessionToProject(
          { userId },
          sessionId,
          {
            id: "explicit-project",
            name: "Explicit Project",
            path: identity.root,
            repositoryIdentity: identity,
            expectedAssignmentVersion: assignment.version
          }
        );
        expect(moved?.repositoryAssignment?.effective).toEqual(identity);
        await local.materializePdsReplica({
          ...input,
          closedProfileTransition: boundary
        });
        expect(
          (await memory.getCapturedSession({ userId }, sessionId))
            ?.repositoryAssignment?.effective
        ).toEqual(identity);
        const reset = await memory.resetCapturedSessionProject(
          { userId },
          sessionId,
          moved!.repositoryAssignment!.version
        );
        expect(reset?.repositoryAssignment).toMatchObject({
          state: "historical_unresolved",
          effective: null
        });
        await expect(
          pool.query(
            "update conversation_items set raw_text='altered' where id=$1",
            [old.items[0]!.id]
          )
        ).rejects.toThrow(/read-only/);
      } finally {
        await pool.end();
        await rm(folder, { recursive: true, force: true });
      }
    }, 60_000);
  }
);
