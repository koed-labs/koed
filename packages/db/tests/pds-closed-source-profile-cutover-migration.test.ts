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
  createPdsSessionManifest,
  createPdsSessionPackage,
  createPdsSessionPackageRuntimeContext,
  createPdsRepositoryAssignment,
  verifyPdsSessionManifest,
  type CreatePdsSessionPackageRuntimeContextInput,
  type PdsSessionManifest,
  type PdsSessionPackage
} from "@koed/shared";
import { pdsConversationItemsForClosure } from "../../../apps/api/src/personal-device-sync/local-source.js";
import {
  createDbPool,
  createMemorySourceRepository,
  createPersonalDeviceSyncLocalRepository,
  createPersonalDeviceSyncRepository,
  runDbMigrations
} from "../src/index.js";
const databaseUrl = process.env.PDS_CLOSED_SOURCE_MIGRATION_TEST_DATABASE_URL;
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
  closure: Record<string, unknown>;
  retained: Record<string, unknown>;
  mappings: Record<string, unknown>[];
  sequence: Record<string, unknown>;
};
describe.skipIf(!databaseUrl)(
  "PDS pre-cutover closed source publisher migration",
  () => {
    it("republishes exactly one sealed source without rewriting its old publication", async () => {
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
        const prior = journal.entries.filter((entry) => entry.idx < 58);
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
              "../../shared/test-fixtures/pds-pre-cutover-closed-source-v2.json",
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
          | "pds_session_closures"
          | "pds_retained_packages"
          | "pds_source_item_mappings"
          | "pds_origin_sequences";
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
        await seed("pds_session_closures", {
          ...old.closure,
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
        await seed("pds_origin_sequences", {
          ...old.sequence,
          group_id: groupDbId
        });
        const oldOutboxId = randomUUID();
        await pool.query(
          "insert into pds_outbox_entries (id,closure_id,idempotency_key,state,attempt_count,transport_id) values ($1,$2,$3,'pending',3,$4)",
          [
            oldOutboxId,
            old.closure.id,
            `old:${old.manifest.packageId}`,
            old.encryptedPackage.header.transportId
          ]
        );
        await runDbMigrations(pool);

        const local = createPersonalDeviceSyncLocalRepository(pool);
        const sessionId = String(old.session.id);
        expect(await local.listPdsCheckpointCandidates()).toContainEqual({
          userId,
          groupId,
          sessionId,
          closedProfileUpgrade: true
        });
        expect(
          await local.claimPdsOutbox({ workerId: "current-worker" })
        ).toEqual([]);
        await pool.query(
          "update pds_outbox_entries set state='committed',lease_owner='old-worker',lease_until=now()+interval '1 hour' where id=$1",
          [oldOutboxId]
        );
        expect(
          await local.beginPdsOutboxNetworkAction({
            workerId: "old-worker",
            outboxId: oldOutboxId
          })
        ).toBe(false);
        expect(
          await local.getPdsOutboxEncryptedEnvelope({
            workerId: "old-worker",
            outboxId: oldOutboxId
          })
        ).toBeNull();
        const runtime = createPdsSessionPackageRuntimeContext({
          ...legacy.runtimeInput,
          now: new Date(legacy.runtimeInput.now)
        });
        let signed: PdsSessionManifest | undefined;
        const input = {
          userId,
          groupId,
          sessionId,
          originDeploymentId: old.manifest.originDeploymentId,
          originDeviceId: deviceId,
          build: async (
            value: Parameters<
              Parameters<
                typeof local.republishPdsClosedSourceSession
              >[0]["build"]
            >[0]
          ) => {
            expect(value.closedProfileTransition).toEqual({
              previousProfile: "pre_repository_cutover",
              previousManifestHash:
                old.encryptedPackage.header.sourceManifestHash,
              previousClosureHash: old.manifest.sourceClosureHash,
              previousSourceSequence: old.manifest.sourceSequence
            });
            expect(value.source.repositoryAssignment).toMatchObject({
              state: "historical_unresolved",
              effective: null
            });
            const manifest = createPdsSessionManifest({
              runtime,
              originDeploymentId: old.manifest.originDeploymentId,
              sourceSequence: value.sourceSequence,
              sourceNativeSessionId: value.source.externalSessionId,
              contentEpoch: old.manifest.contentEpoch,
              closedSession: {
                ...old.manifest.closedSession,
                sourceClosedAt: value.closedAt.toISOString(),
                observedClosedAt: value.closedAt.toISOString()
              },
              repositoryAssignment: createPdsRepositoryAssignment(
                value.source.repositoryAssignment!,
                old.manifest.contentEpoch,
                Buffer.alloc(32, 19).toString("base64url"),
                {
                  capturedCwd: value.source.capturedCwd,
                  branchObservation: value.source.branchObservation
                }
              ),
              profileTransition: value.closedProfileTransition,
              terminalCursor: String(value.source.items.length),
              items: pdsConversationItemsForClosure(value.source),
              sourceFingerprintKey: legacy.sourceFingerprintKey,
              tombstoneFloorKey: legacy.tombstoneFloorKey,
              originSigningPrivateKey: createPrivateKey({
                key: Buffer.from(legacy.originPrivateKeyPkcs8, "base64"),
                format: "der",
                type: "pkcs8"
              })
            });
            signed = verifyPdsSessionManifest(
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
            return {
              sourceClosureHash: manifest.sourceClosureHash,
              packageId: manifest.packageId,
              sourceManifestHash: pkg.header.sourceManifestHash,
              sourceFingerprint: manifest.sourceFingerprint,
              logicalMemoryId: manifest.logicalMemoryId,
              deletionFloorToken: manifest.deletionFloorToken,
              encryptedEnvelope: pkg
            };
          }
        };
        await expect(
          local.republishPdsClosedSourceSession({
            ...input,
            build: async () => {
              throw new Error("upgrade-build-failed");
            }
          })
        ).rejects.toThrow("upgrade-build-failed");
        expect(
          (
            await pool.query<{ state: string }>(
              "select state from pds_outbox_entries where id=$1",
              [oldOutboxId]
            )
          ).rows[0]!.state
        ).toBe("committed");

        expect(
          (
            await pool.query<{ count: string }>(
              "select count(*) from pds_session_closures where source_session_id=$1",
              [sessionId]
            )
          ).rows[0]!.count
        ).toBe("1");
        await expect(
          local.republishPdsClosedSourceSession({
            ...input,
            build: async (value) => ({
              ...(await input.build(value)),
              sourceClosureHash: "changed-closure"
            })
          })
        ).rejects.toThrow("PdsClosedProfileClosureConflict");
        const result = await local.republishPdsClosedSourceSession(input);
        expect(result).not.toBeNull();
        const superseded = (
          await pool.query<{
            state: string;
            superseded_from_state: string;
            superseded_by_closure_id: string;
            lease_owner: string | null;
            transport_id: string;
            attempt_count: number;
          }>(
            "select state,superseded_from_state,superseded_by_closure_id,lease_owner,transport_id,attempt_count from pds_outbox_entries where id=$1",
            [oldOutboxId]
          )
        ).rows[0]!;
        expect(superseded).toEqual({
          state: "superseded",
          superseded_from_state: "committed",
          superseded_by_closure_id: result!.id,
          lease_owner: null,
          transport_id: old.encryptedPackage.header.transportId,
          attempt_count: 3
        });
        expect(
          await local.completePdsOutbox({
            workerId: "old-worker",
            outboxId: oldOutboxId,
            state: "acked"
          })
        ).toBe(false);
        await expect(
          pool.query(
            "update pds_outbox_entries set state='pending',superseded_by_closure_id=null,superseded_from_state=null,superseded_at=null where id=$1",
            [oldOutboxId]
          )
        ).rejects.toThrow(/history is immutable/);
        const claim = await local.claimPdsOutbox({
          workerId: "current-worker"
        });
        expect(claim.map((entry) => entry.closureId)).toEqual([result!.id]);

        expect(signed?.rawClosure).toEqual(old.manifest.rawClosure);
        expect(signed?.sourceFingerprint).toBe(old.manifest.sourceFingerprint);
        expect(signed?.logicalMemoryId).toBe(old.manifest.logicalMemoryId);
        expect(signed?.closedSession).toEqual(old.manifest.closedSession);
        expect(BigInt(signed!.sourceSequence)).toBe(
          BigInt(old.manifest.sourceSequence) + 1n
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
          (
            await pool.query(
              "select id,conversation_item_id from pds_source_item_mappings where closure_id=$1 order by source_ordinal::numeric",
              [old.closure.id]
            )
          ).rows
        ).toEqual(
          old.mappings.map((mapping) => ({
            id: mapping.id,
            conversation_item_id: mapping.conversation_item_id
          }))
        );
        await expect(
          local.republishPdsClosedSourceSession(input)
        ).resolves.toBeNull();
        expect(await local.listPdsCheckpointCandidates()).not.toContainEqual({
          userId,
          groupId,
          sessionId
        });
        await expect(
          pool.query(
            "update pds_session_closures set source_profile_epoch=1 where id=$1",
            [old.closure.id]
          )
        ).rejects.toThrow(/immutable/);
        const rows = await pool.query<{
          closed_at: Date;
          source_profile_epoch: number;
        }>(
          "select closed_at,source_profile_epoch from pds_session_closures where source_session_id=$1 order by source_sequence::numeric",
          [sessionId]
        );
        expect(rows.rows.map((row) => row.source_profile_epoch)).toEqual([
          0, 1
        ]);
        expect(rows.rows[1]!.closed_at).toEqual(rows.rows[0]!.closed_at);
        await expect(
          pool.query(
            "insert into conversation_items select (jsonb_populate_record(null::conversation_items,$1::jsonb)).*",
            [
              JSON.stringify({
                ...old.items[0],
                id: randomUUID(),
                owner_user_id: userId,
                idempotency_key: randomUUID()
              })
            ]
          )
        ).rejects.toThrow(/cannot accept later items/);
      } finally {
        await pool.end();
        await rm(folder, { recursive: true, force: true });
      }
    }, 60_000);
  }
);
