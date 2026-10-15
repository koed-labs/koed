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
import { describe, expect, it, vi } from "vitest";
import {
  crossIdentitySyncDigest,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  decryptEncryptedJsonPackage,
  isCapturedSessionSyncPackageV2,
  storeUpstreamCredentialSecret,
  type EncryptedJsonPackage,
  type RecipientKeyMaterial
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
import { uploadChunkSchema } from "../../../apps/api/src/cross-identity-sync/schemas.js";
import { buildServer } from "../../../apps/api/src/server/build-server.js";
import { createCrossIdentitySyncService } from "../../../apps/worker/src/cross-identity-sync-service.js";
import type { EmbeddingWorkflow } from "../../../apps/worker/src/embedding-workflow.js";

const sourceUrl = process.env.DIRECTED_PROFILE_SOURCE_TEST_DATABASE_URL;
const targetUrl = process.env.DIRECTED_PROFILE_TARGET_TEST_DATABASE_URL;
const mode = process.env.DIRECTED_PROFILE_TEST_MODE ?? "queued";
type State = {
  order: string[];
  tables: Record<string, Record<string, unknown>[]>;
};
type Fixture = {
  notice: string;
  mode: string;
  sourceRootKey: string;
  targetRootKey: string;
  targetPrivateRootKey: string;
  sourceOwnerId: string;
  targetOwnerId: string;
  relationshipId: string;
  sourceSessionId: string;
  sourceReplicaId: string;
  targetReplicaId: string;
  targetDeviceCredentialId: string;
  sourceRemoteDeploymentId: string;
  decodedChunks: Array<{ package: unknown }>;
  source: State;
  target: State;
};
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe.skipIf(!sourceUrl || !targetUrl)(
  "Directed Sync retained V1 cutover rehearsal",
  () => {
    it(`reconciles ${mode} V1 state and completes V2 through the authenticated target API`, async () => {
      const sourcePool = createDbPool({ connectionString: sourceUrl });
      const targetPool = createDbPool({ connectionString: targetUrl });
      const scratch = fileURLToPath(
        new URL("../../../scratch/", import.meta.url)
      );
      await mkdir(scratch, { recursive: true });
      const folder = await mkdtemp(join(scratch, "directed-cutover-"));
      const saved = {
        KOED_HOME: process.env.KOED_HOME,
        KOED_DEPLOYMENT_PROFILE: process.env.KOED_DEPLOYMENT_PROFILE,
        KOED_TEAM_COLLABORATION_ENABLED:
          process.env.KOED_TEAM_COLLABORATION_ENABLED,
        API_TOKEN_PEPPER: process.env.API_TOKEN_PEPPER
      };
      let app: Awaited<ReturnType<typeof buildServer>> | undefined;
      try {
        const fixture = JSON.parse(
          await readFile(
            new URL(
              `../../shared/test-fixtures/directed-pre-cutover-v1-${mode}.json`,
              import.meta.url
            ),
            "utf8"
          )
        ) as Fixture;
        expect(fixture.mode).toBe(mode);
        const migrations = fileURLToPath(
          new URL("../drizzle/", import.meta.url)
        );
        const journal = JSON.parse(
          await readFile(join(migrations, "meta/_journal.json"), "utf8")
        ) as { entries: Array<{ idx: number; tag: string }> };
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
        for (const [pool, state] of [
          [sourcePool, fixture.source],
          [targetPool, fixture.target]
        ] as const) {
          expect(
            (
              await pool.query<{ existing: string | null }>(
                "select to_regclass('public.sessions') as existing"
              )
            ).rows[0]!.existing
          ).toBeNull();
          await runDbMigrations(pool, { migrationsFolder: folder });
          const seedClient = await pool.connect();
          try {
            await seedClient.query("begin");
            // Normal source triggers recreate replay entries during restore. Restore
            // the archived replay rows and queue last, with all guards still enabled.
            const order = [
              ...state.order.filter((table) => table !== "sync_outbox_entries"),
              ...state.order.filter((table) => table === "sync_outbox_entries")
            ];
            for (const table of order)
              for (const row of state.tables[table]!) {
                const conflict =
                  table === "sync_semantic_changes"
                    ? "cursor"
                    : table === "sync_outbox_entries"
                      ? "sync_relationship_id,idempotency_key"
                      : null;
                const update = conflict
                  ? ` on conflict (${conflict}) do update set ${Object.keys(row)
                      .map((key) => `${quote(key)}=excluded.${quote(key)}`)
                      .join(",")}`
                  : "";
                await seedClient.query(
                  `insert into ${quote(table)} select (jsonb_populate_record(null::${quote(table)},$1::jsonb)).*${update}`,
                  [JSON.stringify(row)]
                );
              }
            const sequences = await seedClient.query<{
              table_name: string;
              column_name: string;
              sequence_name: string | null;
            }>(
              "select table_name,column_name,pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) as sequence_name from information_schema.columns where table_schema='public' and column_default like 'nextval(%'"
            );
            for (const row of sequences.rows)
              if (row.sequence_name)
                await seedClient.query(
                  `select setval($1::regclass,greatest(coalesce(max(${quote(row.column_name)}),1),1),true) from ${quote(row.table_name)}`,
                  [row.sequence_name]
                );
            await seedClient.query("commit");
          } catch (error) {
            await seedClient.query("rollback");
            throw error;
          } finally {
            seedClient.release();
          }
          await runDbMigrations(pool);
        }
        const sourceRoot = createLocalTestKeyEnvelopeEncryptionProvider(
          fixture.sourceRootKey
        );
        const targetRoot = createLocalTestKeyEnvelopeEncryptionProvider(
          fixture.targetRootKey
        );
        const targetPrivateRoot = createLocalTestKeyEnvelopeEncryptionProvider(
          fixture.targetPrivateRootKey
        );
        const source = createMemorySourceRepository(sourcePool, {
          envelopeEncryptionProvider: sourceRoot,
          ownerPrivateReplicaEnvelopeEncryptionProvider: sourceRoot
        });
        const target = createMemorySourceRepository(targetPool, {
          envelopeEncryptionProvider: targetRoot,
          ownerPrivateReplicaEnvelopeEncryptionProvider: targetPrivateRoot
        });
        const oldUpload =
          fixture.source.tables.sync_package_upload_sessions![0]!;
        const oldChunks = fixture.source.tables.sync_package_chunks!;
        for (const row of oldChunks)
          expect(
            uploadChunkSchema.safeParse({
              checksum_sha256: row.chunk_checksum,
              byte_count: row.byte_count,
              encrypted_package: row.encrypted_payload
            }).success
          ).toBe(false);
        const oldTargetCipher = await targetPool.query<
          { id: string } & Record<string, unknown>
        >(
          "select id,chunk_index,chunk_checksum,byte_count,encrypted_payload from sync_package_chunks order by id"
        );
        const recipientRow = fixture.target.tables.sync_recipient_keys![0]!;
        const material = await target.getSyncRecipientKey(
          String(recipientRow.deployment_identity_id),
          String(recipientRow.key_id),
          Number(recipientRow.key_version)
        );
        expect(material).not.toBeNull();
        const provider =
          await createRecipientPrivateKeyEnvelopeEncryptionProvider(
            targetRoot,
            material as RecipientKeyMaterial
          );
        const decoded = [];
        for (const row of [...oldChunks].sort(
          (a, b) => Number(a.chunk_index) - Number(b.chunk_index)
        ))
          decoded.push(
            await decryptEncryptedJsonPackage(
              provider,
              row.encrypted_payload as EncryptedJsonPackage
            )
          );
        expect(decoded).toEqual(fixture.decodedChunks);
        for (const chunk of fixture.decodedChunks)
          expect(isCapturedSessionSyncPackageV2(chunk.package)).toBe(false);
        await expect(
          source.getSyncPackageBySequence({
            relationshipId: fixture.relationshipId,
            sourceSequence: 1
          })
        ).rejects.toThrow();
        const oldTargetItems = await targetPool.query(
          "select id,raw_json,raw_text,source_hash from conversation_items order by id"
        );
        const home = join(folder, "home");
        await mkdir(home);
        process.env.KOED_HOME = home;
        process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
        process.env.KOED_TEAM_COLLABORATION_ENABLED = "true";
        process.env.API_TOKEN_PEPPER = "directed-profile-fixture-pepper";
        const credential = storeUpstreamCredentialSecret(home, {
          backendId: "legacy-target",
          credentialKeyId: "legacy-fixture-device",
          secret: "synthetic-fixture-secret"
        });
        await sourcePool.query(
          "update deployment_identities set metadata=jsonb_set(metadata,'{credentialReference}',to_jsonb($2::text)) where id=$1",
          [fixture.sourceRemoteDeploymentId, credential.reference]
        );
        const targetDeployment =
          fixture.target.tables.deployment_identities!.find(
            (row) => row.locality === "local"
          )!;
        app = await buildServer({
          repository: target,
          envelopeEncryptionProvider: targetRoot,
          ownerPrivateReplicaEnvelopeEncryptionProvider: targetPrivateRoot,
          inspectDeploymentIdentity: () => ({
            health: "healthy",
            deploymentId: String(targetDeployment.protocol_deployment_id),
            deviceInstanceId: "00000000-0000-4000-8000-000000000002",
            remoteOperationsAllowed: true,
            message: "Synthetic fixture identity",
            platformProtection: "verified"
          })
        });
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const embeddingWorkflow = {
          embedSources: vi.fn(async () => {})
        } as unknown as EmbeddingWorkflow;
        const targetWorker = createCrossIdentitySyncService({
          repository: target,
          recipientKeyEncryptionProvider: targetRoot,
          embeddingWorkflow,
          koedHome: home,
          isSourceIdentityHealthy: () => false,
          fetch: async () => {
            throw new Error("Unexpected target outbound request");
          },
          staleAfterSeconds: 3600,
          logger
        });
        const paths: string[] = [];
        const responses: Array<{ path: string; status: number; body: string }> =
          [];
        const fetchFn: typeof fetch = async (input, init) => {
          const url = new URL(String(input));
          paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
          if (
            (init?.method ?? "GET") === "GET" &&
            url.pathname ===
              `/v1/cross-identity-sync/relationships/${fixture.relationshipId}`
          )
            await targetWorker.processOnce();
          const headers = Object.fromEntries(
            new Headers(init?.headers).entries()
          );
          const result = await app!.inject({
            method: (init?.method ?? "GET") as "GET" | "POST" | "PUT",
            url: url.pathname + url.search,
            headers,
            ...(init?.body
              ? {
                  payload: JSON.parse(String(init.body)) as Record<
                    string,
                    unknown
                  >
                }
              : {})
          });
          responses.push({
            path: url.pathname,
            status: result.statusCode,
            body: result.body
          });
          return new Response(result.body, {
            status: result.statusCode,
            headers: { "content-type": "application/json" }
          });
        };
        const sourceWorker = createCrossIdentitySyncService({
          repository: source,
          recipientKeyEncryptionProvider: sourceRoot,
          embeddingWorkflow,
          koedHome: home,
          isSourceIdentityHealthy: () => true,
          fetch: fetchFn,
          staleAfterSeconds: 3600,
          logger
        });
        await sourceWorker.processOnce();
        expect(logger.warn.mock.calls, JSON.stringify(responses)).toEqual([]);
        expect(paths).toEqual([
          `POST /v1/cross-identity-sync/relationships/${fixture.relationshipId}/profile-transition`
        ]);
        const adopted = await source.getSyncRelationshipForService(
          fixture.relationshipId,
          "source"
        );
        expect(adopted).toMatchObject({
          packageSequence: 1,
          sourceCursor: mode === "ack_lost" ? Number(oldUpload.to_cursor) : 0,
          sourceRepositorySnapshotHash: null
        });
        const sourceCipher = await sourcePool.query(
          "select id,chunk_index,chunk_checksum,byte_count,encrypted_payload from sync_package_chunks where upload_session_id=$1 order by chunk_index",
          [oldUpload.id]
        );
        expect(sourceCipher.rows).toEqual(
          [...oldChunks]
            .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index))
            .map((row) => ({
              id: row.id,
              chunk_index: row.chunk_index,
              chunk_checksum: row.chunk_checksum,
              byte_count: row.byte_count,
              encrypted_payload: row.encrypted_payload
            }))
        );
        for (let pass = 0; pass < 4; pass++) {
          const progress = await sourceWorker.processOnce();
          if (!progress.outbox) break;
        }
        expect(logger.warn.mock.calls, JSON.stringify(responses)).toEqual([]);
        expect(
          await source.getSyncRelationshipForService(
            fixture.relationshipId,
            "source"
          )
        ).toMatchObject({
          state: "ready",
          packageSequence: 2,
          sourceCursor: Number(oldUpload.to_cursor)
        });
        expect(
          await target.getSyncRelationshipForService(
            fixture.relationshipId,
            "target"
          )
        ).toMatchObject({
          state: "ready",
          packageSequence: 2,
          targetProcessingCursor: Number(oldUpload.to_cursor)
        });
        const fresh = await source.getSyncPackageBySequence({
          relationshipId: fixture.relationshipId,
          sourceSequence: 2
        });
        expect(fresh?.upload.packageManifest).toMatchObject({
          format: "koed.captured-session-sync/v2",
          formatVersion: 2
        });
        expect(fresh).not.toBeNull();
        for (const chunk of fresh!.chunks) {
          const wire = {
            checksum_sha256: chunk.chunkChecksum,
            byte_count: chunk.byteCount,
            encrypted_package: chunk.encryptedPayload
          };
          expect(uploadChunkSchema.safeParse(wire).success).toBe(true);
          expect(
            uploadChunkSchema.safeParse({
              ...wire,
              encrypted_package: {
                ...chunk.encryptedPayload,
                manifest: {
                  ...chunk.encryptedPayload.manifest,
                  metadata: {
                    ...chunk.encryptedPayload.manifest.metadata,
                    formatVersion: 1
                  }
                }
              }
            }).success
          ).toBe(false);
          const plaintext = await decryptEncryptedJsonPackage<{
            package: unknown;
          }>(provider, chunk.encryptedPayload);
          expect(isCapturedSessionSyncPackageV2(plaintext.package)).toBe(true);
        }
        if (oldTargetCipher.rows.length)
          expect(
            (
              await targetPool.query(
                "select id,chunk_index,chunk_checksum,byte_count,encrypted_payload from sync_package_chunks where id=any($1::uuid[]) order by id",
                [oldTargetCipher.rows.map((row) => row.id)]
              )
            ).rows
          ).toEqual(oldTargetCipher.rows);
        expect(fresh?.upload.protocolPackageId).not.toBe(
          oldUpload.protocol_package_id
        );
        expect(
          (
            await source.getCapturedSession(
              { userId: fixture.sourceOwnerId },
              fixture.sourceSessionId
            )
          )?.repositoryAssignment
        ).toMatchObject({ state: "historical_unresolved", effective: null });
        expect(
          (
            await sourcePool.query(
              "select id,raw_json,raw_text,source_hash from conversation_items order by id"
            )
          ).rows
        ).toEqual(
          [...fixture.source.tables.conversation_items!]
            .sort((a, b) => String(a.id).localeCompare(String(b.id)))
            .map((row) => ({
              id: row.id,
              raw_json: row.raw_json,
              raw_text: row.raw_text,
              source_hash: row.source_hash
            }))
        );
        if (mode === "ack_lost")
          expect(
            (
              await targetPool.query(
                "select id,raw_json,raw_text,source_hash from conversation_items order by id"
              )
            ).rows
          ).toEqual(oldTargetItems.rows);
        const targetSessionId = String(
          (
            await targetPool.query<{ local_session_id: string }>(
              "select local_session_id from local_captured_session_logical_memories where logical_memory_id=(select logical_memory_id from cross_identity_sync_relationships where id=$1)",
              [fixture.relationshipId]
            )
          ).rows[0]!.local_session_id
        );
        expect(
          (
            await target.getCapturedSession(
              { userId: fixture.targetOwnerId },
              targetSessionId
            )
          )?.repositoryAssignment
        ).toMatchObject({ state: "historical_unresolved", effective: null });
        expect(
          (
            await targetPool.query(
              "select id from memory_events where session_id=$1",
              [targetSessionId]
            )
          ).rowCount
        ).toBe(4);
        expect(
          crossIdentitySyncDigest(
            (
              await sourcePool.query<{ encrypted_payload: unknown }>(
                "select encrypted_payload from sync_package_chunks where upload_session_id=$1 order by chunk_index",
                [oldUpload.id]
              )
            ).rows.map((row) => row.encrypted_payload)
          )
        ).toBe(
          crossIdentitySyncDigest(
            [...oldChunks]
              .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index))
              .map((row) => row.encrypted_payload)
          )
        );
      } finally {
        await app?.close();
        await sourcePool.end();
        await targetPool.end();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(folder, { recursive: true, force: true });
      }
    }, 120_000);
  }
);
