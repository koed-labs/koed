import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  calculateConversationSourceRootDigest,
  conversationSourceRewriteGenerationId,
  createEncryptedJsonPackage,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  decryptEncryptedJsonPackage,
  generateConversationSourceReplicationOriginKeyPair,
  generateRecipientKeyMaterial,
  parseConversationSourceReplicationSourceDescriptor,
  signConversationSourceClosureManifest,
  signConversationSourceReplicationManifest,
  type ConversationSourceReplicationSourceDescriptor
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  type ConversationSourceArtifactRecord
} from "../src/index.js";
import { createConversationSourceReplicationService } from "../../../apps/worker/src/conversation-source-replication-service.js";

const databaseUrl = process.env.DATABASE_URL;
const timestamp = "2026-10-07T00:00:00.000Z";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (rows: unknown[]) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

describe.skipIf(!databaseUrl)(
  "Encrypted paginated source replication in PostgreSQL",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    }, 60_000);
    afterAll(() => pool?.end());

    it("binds a native thread once while converging the same logical replica Session", async () => {
      const repository = createMemorySourceRepository(pool);
      const owner = await repository.createUser({
        email: `native-binding-${randomUUID()}@example.test`
      });
      const actor = { userId: owner.id };
      const externalSessionId = randomUUID();
      const externalThreadId = randomUUID();
      const input = {
        externalSessionId,
        idempotencyKey: `binding:${externalSessionId}`
      };
      const original = await repository.createCapturedSession(actor, input);
      const bound = await repository.createCapturedSession(actor, {
        ...input,
        externalThreadId,
        metadata: { syntheticBinding: "accepted" }
      });
      expect(bound.id).toBe(original.id);
      expect((await repository.createCapturedSession(actor, input)).id).toBe(
        original.id
      );
      expect(
        (
          await repository.createCapturedSession(actor, {
            idempotencyKey: input.idempotencyKey,
            externalThreadId
          })
        ).id
      ).toBe(original.id);
      await expect(
        repository.createCapturedSession(actor, {
          ...input,
          externalThreadId: randomUUID(),
          metadata: { syntheticBinding: "conflicting" }
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "captured_session_thread_conflict"
      });
      await expect(
        repository.createCapturedSession(actor, {
          idempotencyKey: input.idempotencyKey,
          externalThreadId: randomUUID()
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "captured_session_thread_conflict"
      });
      const stored = await pool.query<{
        external_thread_id: string;
        metadata: Record<string, unknown>;
      }>("select external_thread_id,metadata from sessions where id=$1", [
        original.id
      ]);
      expect(stored.rows[0]!.external_thread_id).toBe(externalThreadId);
      expect(stored.rows[0]!.metadata.syntheticBinding).toBe("accepted");
      expect(
        (
          await pool.query<{ count: string }>(
            "select count(*)::text as count from sessions where owner_user_id=$1",
            [owner.id]
          )
        ).rows[0]!.count
      ).toBe("1");
    });

    it.each(["migration", "revert"] as const)(
      "materializes a signed %s successor once across two logical deployments",
      async (kind) => {
        const home = mkdtempSync(join(tmpdir(), "koed-source-replication-"));
        const originProvider = createLocalTestKeyEnvelopeEncryptionProvider(
          Buffer.alloc(32, 41).toString("base64")
        );
        const targetProvider = createLocalTestKeyEnvelopeEncryptionProvider(
          Buffer.alloc(32, 42).toString("base64")
        );
        const origin = createMemorySourceRepository(pool, {
          envelopeEncryptionProvider: originProvider
        });
        const target = createMemorySourceRepository(pool, {
          envelopeEncryptionProvider: targetProvider
        });
        const originUser = await origin.createUser({
          email: `replication-origin-${randomUUID()}@example.test`
        });
        const targetUser = await target.createUser({
          email: `replication-target-${randomUUID()}@example.test`
        });
        const outsider = await target.createUser({
          email: `replication-outsider-${randomUUID()}@example.test`
        });
        const originActor = { userId: originUser.id };
        const targetActor = { userId: targetUser.id };
        const originDeploymentId = randomUUID();
        const targetDeploymentId = randomUUID();
        const originDeviceId = randomUUID();
        const threadId = randomUUID();
        const logicalSourceId = randomUUID();
        const logicalSessionId = randomUUID();
        const keys = generateConversationSourceReplicationOriginKeyPair();
        const recipient = await generateRecipientKeyMaterial(targetProvider, {
          keyId: `synthetic-recipient:${randomUUID()}`,
          keyVersion: 1
        });
        const recipientPublic =
          createRecipientPublicKeyEnvelopeEncryptionProvider(recipient);
        const recipientPrivate =
          await createRecipientPrivateKeyEnvelopeEncryptionProvider(
            targetProvider,
            recipient
          );
        const transport = async <T>(
          payload: T,
          operationKind: string
        ): Promise<T> => {
          const operationId = randomUUID();
          const encrypted = await createEncryptedJsonPackage(recipientPublic, {
            objectClass: "sync_package",
            payload,
            scope: {
              deploymentId: targetDeploymentId,
              tenantId: targetUser.id
            },
            provenance: {
              rowFamily: "conversation_source_replication",
              sourceId: operationId
            },
            ciphertextLocation: "conversation_source_replication.payload",
            aad: {
              operationId,
              operationKind,
              protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
              targetDeploymentId
            },
            metadata: {
              operationKind,
              protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL
            }
          });
          return decryptEncryptedJsonPackage<T>(recipientPrivate, encrypted);
        };
        const history = {
          historyMode: "paginated" as const,
          externalThreadId: threadId,
          threadKind: "conversation" as const,
          subagentHistoryStartOrdinal: null
        };
        const event = (payload: Record<string, unknown>, ordinal?: number) => ({
          timestamp,
          type: "event_msg",
          payload,
          ...(ordinal === undefined ? {} : { ordinal })
        });
        const completed = (
          id: string,
          type: "UserMessage" | "AgentMessage",
          text: string,
          ordinal: number,
          turn = "turn-1"
        ) =>
          event(
            {
              type: "item_completed",
              thread_id: threadId,
              turn_id: turn,
              started_at_ms: null,
              completed_at_ms: Date.parse(timestamp),
              item: {
                id,
                type,
                content: [
                  {
                    type: type === "UserMessage" ? "text" : "Text",
                    text,
                    ...(type === "UserMessage" ? { text_elements: [] } : {})
                  }
                ]
              }
            },
            ordinal
          );
        const nativeHeader = {
          timestamp,
          type: "session_meta",
          ordinal: 0,
          payload: { id: threadId, history_mode: "paginated" }
        };
        const paginated = [
          nativeHeader,
          event({ type: "task_started", turn_id: "turn-1" }, 1),
          completed("item-1", "UserMessage", "Original prompt", 2),
          completed("item-2", "AgentMessage", "Original answer", 3),
          event({ type: "task_complete", turn_id: "turn-1" }, 4)
        ];
        const legacy = [
          { timestamp, type: "session_meta", payload: { id: threadId } },
          event({ type: "task_started", turn_id: "turn-1" }),
          event({
            type: "user_message",
            message: "Original prompt",
            text_elements: []
          }),
          event({
            type: "agent_message",
            message: "Original answer",
            phase: null
          }),
          event({ type: "task_complete", turn_id: "turn-1" })
        ];
        const parentRows = kind === "migration" ? legacy : paginated;
        const continuationHeader = {
          ...nativeHeader,
          ordinal: 2,
          payload: {
            ...nativeHeader.payload,
            history_base: {
              thread_id: threadId,
              end_ordinal_exclusive: 2,
              end_byte_offset: encode(paginated.slice(0, 2)).length
            }
          }
        };
        const prefix = encode(
          kind === "migration" ? paginated : [continuationHeader]
        );
        const successorRows = [
          ...(kind === "migration" ? paginated : [continuationHeader]),
          event(
            { type: "task_started", turn_id: "turn-2" },
            kind === "migration" ? 5 : 3
          ),
          completed(
            "future-user",
            "UserMessage",
            "After rewrite",
            kind === "migration" ? 6 : 4,
            "turn-2"
          ),
          completed(
            "future-agent",
            "AgentMessage",
            "New answer",
            kind === "migration" ? 7 : 5,
            "turn-2"
          ),
          event(
            { type: "task_complete", turn_id: "turn-2" },
            kind === "migration" ? 8 : 6
          )
        ];
        const session = await origin.createCapturedSession(originActor, {
          logicalSessionId,
          externalSessionId: threadId,
          sourceRuntime: "codex-cli",
          captureMethod: "transcript",
          sourceKind: "codex",
          sourceAdapterVersion:
            kind === "migration"
              ? "codex-transcript-v1"
              : "codex-transcript-v2",
          sourceFingerprint: sha(Buffer.from(threadId)),
          idempotencyKey: `session:${threadId}`,
          metadata: { codexHistory: history }
        });
        const parent = await origin.ensureConversationSourceArtifact(
          originActor,
          {
            sessionId: session.id,
            logicalSourceId,
            sourceGenerationId: randomUUID(),
            replicaRole: "origin_local",
            sourceKind: "codex",
            sourceRuntime: "codex-cli",
            externalSessionId: threadId,
            sourceFingerprint: sha(Buffer.from(threadId)),
            artifactFormat: "codex_rollout_jsonl",
            artifactFormatVersion: 1,
            sourceAdapterVersion:
              kind === "migration"
                ? "codex-transcript-v1"
                : "codex-transcript-v2",
            journalStartOffset: 0,
            journalStartLine: 0,
            liveStartOffset: 0,
            liveStartLine: 0,
            currentSourceLength: encode(parentRows).length,
            sourceCreatedAt: timestamp,
            storageProvider: "envelope_db",
            storagePrefix: `synthetic/${logicalSourceId}`,
            originDeploymentId,
            originDeviceId,
            originKeyId: keys.originKeyId,
            originPublicKey: keys.publicKeyBase64url,
            redactedSourceLabel: `rollout-fixture-${threadId}.jsonl`
          }
        );
        const replicate = async (
          artifact: ConversationSourceArtifactRecord,
          rows: unknown[]
        ) => {
          const bytes = encode(rows);
          const source = parseConversationSourceReplicationSourceDescriptor({
            sourceKind: "codex",
            sourceComponentSchemaVersion: 1,
            sourceComponentId: "main",
            sourceComponentRole: "primary",
            parentSourceComponentId: null,
            contentFraming: "jsonl",
            logicalSessionId,
            externalSessionId: threadId,
            forkedFromExternalThreadId: null,
            sourceFingerprint: artifact.sourceFingerprint,
            artifactFormat: artifact.artifactFormat,
            artifactFormatVersion: 1,
            sourceAdapterVersion: artifact.sourceAdapterVersion,
            sourceRuntime: "codex-cli",
            redactedSourceLabel: artifact.redactedSourceLabel,
            originDeploymentId,
            originDeviceId,
            journalStartOffset: 0,
            journalStartLine: 0,
            liveStartOffset: artifact.liveStartOffset,
            liveStartLine: artifact.liveStartLine,
            project: null,
            ...(artifact.sourceAdapterVersion === "codex-transcript-v2"
              ? { codexHistory: history }
              : {})
          });
          const importedSource =
            parseConversationSourceReplicationSourceDescriptor(
              await transport<ConversationSourceReplicationSourceDescriptor>(
                source,
                "register_generation"
              )
            );
          const targetSession = await target.createCapturedSession(
            targetActor,
            {
              logicalSessionId: importedSource.logicalSessionId,
              externalSessionId: logicalSourceId,
              externalThreadId: importedSource.codexHistory?.externalThreadId,
              sourceRuntime: importedSource.sourceRuntime,
              captureMethod: "transcript",
              sourceKind: "codex",
              sourceAdapterVersion: importedSource.sourceAdapterVersion,
              sourceFingerprint: importedSource.sourceFingerprint,
              idempotencyKey: `hosted-source:${logicalSourceId}:${artifact.sourceGenerationId}`,
              metadata: importedSource.codexHistory
                ? { codexHistory: importedSource.codexHistory }
                : {}
            }
          );
          const registered =
            await target.registerConversationSourceReplicaGeneration(
              targetActor,
              {
                ...importedSource,
                logicalSourceId,
                sourceGenerationId: artifact.sourceGenerationId,
                sourceCreatedAt: artifact.sourceCreatedAt,
                storageProvider: "envelope_db",
                storagePrefix: `target/${artifact.sourceGenerationId}`,
                originKeyId: artifact.originKeyId,
                originPublicKey: artifact.originPublicKey,
                sessionId: targetSession.id,
                externalSessionId: logicalSourceId,
                replicaRole: "hosted_personal",
                currentSourceLength: artifact.liveStartOffset,
                ...(artifact.priorGenerationClosure
                  ? { priorGenerationClosure: artifact.priorGenerationClosure }
                  : {}),
                priorGenerationClosure:
                  artifact.priorGenerationClosure ?? undefined
              }
            );
          const signed = signConversationSourceReplicationManifest(
            {
              protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
              sourceComponentSchemaVersion: 1,
              sourceComponentId: "main",
              sourceComponentRole: "primary",
              parentSourceComponentId: null,
              contentFraming: "jsonl",
              logicalSourceId,
              sourceGenerationId: artifact.sourceGenerationId,
              originKeyId: keys.originKeyId,
              segmentIndex: 0,
              startByteCursor: 0,
              endByteCursor: bytes.length,
              startItemCursor: 0,
              endItemCursor: rows.length,
              previousContentDigest: null,
              plaintextDigest: sha(bytes),
              sourceFormat: artifact.artifactFormat,
              adapterVersion: artifact.sourceAdapterVersion,
              sourceCreatedAt: timestamp,
              priorGenerationClosure: artifact.priorGenerationClosure as {
                sourceGenerationId: string;
                contentDigest: string;
                closedAt: string;
              } | null
            },
            keys.privateKey
          );
          const payload = {
            signedManifest: signed,
            plaintextBytes: bytes.toString("base64url")
          };
          const envelope = await originProvider.encrypt({
            plaintext: JSON.stringify(payload),
            scope: { tenantId: originUser.id },
            provenance: {
              rowFamily: "conversation_source_segments",
              sourceId: artifact.sourceGenerationId
            },
            ciphertextLocation:
              "conversation_source_segments.encryption_envelope",
            aad: { ownerUserId: originUser.id }
          });
          const proof = {
            signedManifest: signed.manifest as unknown as Record<
              string,
              unknown
            >,
            originSignature: signed.signature,
            manifestDigest:
              calculateConversationSourceReplicationManifestDigest(
                signed.manifest
              ),
            previousContentDigest: null,
            contentDigest:
              calculateConversationSourceReplicationContentDigest(signed)
          };
          const appended = await origin.appendConversationSourceSegment(
            originActor,
            {
              artifactId: artifact.id,
              expectedProviderOffset: 0,
              expectedProviderLine: 0,
              sourceEndOffset: bytes.length,
              sourceEndLine: rows.length,
              plaintextDigest: sha(bytes),
              plaintextSize: bytes.length,
              storedSize: envelope.ciphertext.length,
              ciphertextDigest: sha(Buffer.from(envelope.ciphertext)),
              storageKey: `origin/${artifact.id}/0`,
              storageProvider: "envelope_db",
              encryptionEnvelope: envelope as unknown as Record<
                string,
                unknown
              >,
              currentSourceLength: bytes.length,
              ...proof
            }
          );
          const stored = (
            await origin.listConversationSourceSegments(originActor, {
              artifactId: artifact.id,
              afterOffset: 0,
              limit: 10
            })
          )[0]!;
          const decrypted = JSON.parse(
            Buffer.from(
              await originProvider.decrypt(stored.encryptionEnvelope as never)
            ).toString("utf8")
          ) as typeof payload;
          const received = await transport(decrypted, "append_segment");
          expect(received.plaintextBytes).toBe(bytes.toString("base64url"));
          const targetEnvelope = await targetProvider.encrypt({
            plaintext: JSON.stringify(received),
            scope: { tenantId: targetUser.id },
            provenance: {
              rowFamily: "conversation_source_segments",
              sourceId: artifact.sourceGenerationId
            },
            ciphertextLocation:
              "conversation_source_segments.encryption_envelope",
            aad: { ownerUserId: targetUser.id }
          });
          const acceptance = {
            artifactId: registered.id,
            segmentIndex: 0,
            sourceStartOffset: 0,
            sourceEndOffset: bytes.length,
            sourceStartLine: 0,
            sourceEndLine: rows.length,
            plaintextDigest: sha(bytes),
            plaintextSize: bytes.length,
            storedSize: targetEnvelope.ciphertext.length,
            ciphertextDigest: sha(Buffer.from(targetEnvelope.ciphertext)),
            storageKey: `target/${registered.id}/0`,
            storageProvider: "envelope_db",
            encryptionEnvelope: targetEnvelope as unknown as Record<
              string,
              unknown
            >,
            currentSourceLength: bytes.length,
            ...proof
          };
          expect(
            (
              await target.acceptConversationSourceReplicaSegment(
                targetActor,
                acceptance
              )
            ).status
          ).toBe("accepted");
          expect(
            (
              await target.acceptConversationSourceReplicaSegment(
                targetActor,
                acceptance
              )
            ).status
          ).toBe("replayed");
          const signedClosure = signConversationSourceClosureManifest(
            {
              protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
              sourceComponentSchemaVersion: 1,
              sourceComponentId: "main",
              sourceComponentRole: "primary",
              parentSourceComponentId: null,
              contentFraming: "jsonl",
              logicalSourceId,
              sourceGenerationId: artifact.sourceGenerationId,
              originKeyId: keys.originKeyId,
              sourceCreatedAt: timestamp,
              priorGenerationClosure: signed.manifest.priorGenerationClosure,
              segmentCount: 1,
              endByteCursor: bytes.length,
              endItemCursor: rows.length,
              chainHeadDigest: appended.segment.contentDigest,
              sourceRootDigest: calculateConversationSourceRootDigest([
                appended.segment.contentDigest
              ]),
              closedAt: timestamp
            },
            keys.privateKey
          );
          // Stage the origin's already-captured frontier; target capture runs the real worker.
          await origin.advanceConversationSourceConsumerCursor(originActor, {
            artifactId: artifact.id,
            consumerKind: "canonical_live",
            expectedSourceOffset: artifact.liveStartOffset,
            sourceOffset: bytes.length,
            sourceLine: rows.length,
            segmentIndex: 0,
            lastVerifiedDigest: sha(bytes)
          });
          const closed = await origin.finalizeConversationSourceArtifact(
            originActor,
            { artifactId: artifact.id, signedClosure }
          );
          const receivedClosure = await transport(
            signedClosure,
            "close_generation"
          );
          await target.finalizeConversationSourceArtifact(targetActor, {
            artifactId: registered.id,
            signedClosure: receivedClosure
          });
          expect(
            (
              await target.finalizeConversationSourceArtifact(targetActor, {
                artifactId: registered.id,
                signedClosure: receivedClosure
              })
            ).replayed
          ).toBe(true);
          return { closed: closed.artifact, replica: registered };
        };
        const failures: unknown[] = [];
        const service = createConversationSourceReplicationService({
          repository: target,
          koedHome: home,
          envelopeEncryptionProvider: targetProvider,
          wakePool: pool,
          fetch: async () => {
            throw new Error("Unexpected network request");
          },
          logger: {
            info: () => {},
            warn: (fields) => {
              failures.push(fields);
            }
          }
        });
        try {
          const first = await replicate(parent, parentRows);
          const firstPass = await service.processOnce();
          expect(failures).toEqual([]);
          expect(firstPass.materialized).toBe(1);
          const rewrite = {
            kind:
              kind === "migration"
                ? ("codex_legacy_to_paginated" as const)
                : ("codex_paginated_continuation" as const),
            journalStartOffset: 0,
            journalStartLine: 0,
            liveStartOffset: prefix.length,
            liveStartLine: kind === "migration" ? paginated.length : 1,
            prefixDigest: sha(prefix),
            currentSourceLength: encode(successorRows).length,
            ...(kind === "revert"
              ? {
                  redactedSourceLabel: `rollout-fixture-${threadId}_${randomUUID()}.jsonl`
                }
              : {})
          };
          const successorInput = {
            parentArtifactId: first.closed.id,
            expectedParentClosureHash: first.closed.closureHash!,
            sourceGenerationId: conversationSourceRewriteGenerationId(
              first.closed.sourceGenerationId,
              rewrite.prefixDigest
            ),
            originDeploymentId,
            originDeviceId,
            originKeyId: keys.originKeyId,
            originPublicKey: keys.publicKeyBase64url,
            sourceCreatedAt: timestamp,
            storageProvider: "envelope_db",
            storagePrefix: `synthetic/${logicalSourceId}/successor`,
            sourceRewrite: rewrite
          };
          const successor = (
            await origin.createConversationSourceSuccessorGeneration(
              originActor,
              successorInput
            )
          ).artifact;
          expect(
            (
              await origin.createConversationSourceSuccessorGeneration(
                originActor,
                successorInput
              )
            ).replayed
          ).toBe(true);
          const second = await replicate(successor, successorRows);
          const successorPass = await service.processOnce();
          expect(failures).toEqual([]);
          expect(successorPass.materialized).toBeGreaterThan(0);
          await service.processOnce();
          expect(failures).toEqual([]);
          expect((await service.processOnce()).materialized).toBe(0);
          const items = await pool.query<{ count: string }>(
            "select count(*)::text as count from conversation_items where session_id=$1 and source_event_type in ('user_message','agent_message','item_completed')",
            [second.replica.sessionId]
          );
          expect(items.rows[0]!.count).toBe("4");
          const cursor = await target.getConversationSourceConsumerCursor(
            targetActor,
            { artifactId: second.replica.id, consumerKind: "remote_processing" }
          );
          expect(cursor?.sourceOffset).toBe(encode(successorRows).length);
          expect(
            (
              await target.getCapturedSession(
                targetActor,
                second.replica.sessionId
              )
            )?.metadata.codexHistory
          ).toEqual(history);
          expect(
            (
              await target.getConversationSourceArtifact(
                targetActor,
                second.replica.id
              )
            )?.priorGenerationClosure
          ).toMatchObject({
            sourceGenerationId: first.closed.sourceGenerationId,
            contentDigest: first.closed.closureHash
          });
          expect(
            await origin.getConversationSourceArtifact(
              originActor,
              second.replica.id
            )
          ).toBeNull();
          expect(
            await target.getConversationSourceArtifactByCodexThreadIdentity(
              targetActor,
              { externalThreadId: threadId }
            )
          ).toMatchObject({
            id: second.replica.id,
            sourceGenerationId: successor.sourceGenerationId,
            externalSessionId: logicalSourceId
          });
          expect(
            await target.getConversationSourceArtifactByCodexThreadIdentity(
              { userId: outsider.id },
              { externalThreadId: threadId }
            )
          ).toBeNull();
          expect(
            await target.getConversationSourceArtifactByCodexThreadIdentity(
              targetActor,
              {
                externalThreadId: threadId,
                sourceComponentId: "agent.unrelated"
              }
            )
          ).toBeNull();
          await pool.query(
            kind === "migration"
              ? "update sessions set invalidated_at=now() where id=$1 and owner_user_id=$2"
              : "update sessions set personal_deleted_at=now() where id=$1 and owner_user_id=$2",
            [second.replica.sessionId, targetUser.id]
          );
          expect(
            await target.getConversationSourceArtifactByCodexThreadIdentity(
              targetActor,
              { externalThreadId: threadId }
            )
          ).toBeNull();
        } finally {
          await service.stop();
          rmSync(home, { recursive: true, force: true });
        }
      },
      60_000
    );
  }
);
