import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  CapturedSessionRecord,
  ConversationSourceArtifactRecord,
  ConversationSourceDownloadAuthorizationRecord,
  ConversationSourceSegmentRecord
} from "@koed/db";
import {
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  calculateConversationSourceDownloadRequestHash,
  calculateConversationSourceDownloadScopeHash,
  calculateConversationSourceReplicationPlaintextDigest,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  decryptEncryptedJsonPackage,
  generateConversationSourceReplicationOriginKeyPair,
  generateRecipientKeyMaterial,
  signConversationSourceReplicationManifest
} from "@koed/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ApiRouteContext } from "../server/context.js";
import { registerConversationSourceReplicationRoutes } from "./routes.js";

const iso = "2026-08-12T00:00:00.000Z";

describe("Conversation Source download component binding", () => {
  it("downloads auxiliary bytes and rejects replaying that grant as main", async () => {
    const ids = {
      user: randomUUID(),
      credential: randomUUID(),
      deployment: randomUUID(),
      session: randomUUID(),
      logicalSession: randomUUID(),
      logicalSource: randomUUID(),
      generation: randomUUID(),
      mainArtifact: randomUUID(),
      auxiliaryArtifact: randomUUID(),
      authorization: randomUUID(),
      segment: randomUUID()
    };
    const root = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
    const recipient = await generateRecipientKeyMaterial(root, {
      keyId: "sync-recipient:test",
      keyVersion: 1
    });
    const recipientPrivate =
      await createRecipientPrivateKeyEnvelopeEncryptionProvider(
        root,
        recipient
      );
    const origin = generateConversationSourceReplicationOriginKeyPair();
    const auxiliaryBytes = Buffer.from(
      '{"type":"assistant","message":"auxiliary bytes"}\n'
    );
    const signedManifest = signConversationSourceReplicationManifest(
      {
        protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
        sourceComponentSchemaVersion: 1,
        sourceComponentId: "agent.researcher",
        sourceComponentRole: "auxiliary",
        parentSourceComponentId: "main",
        contentFraming: "jsonl",
        logicalSourceId: ids.logicalSource,
        sourceGenerationId: ids.generation,
        originKeyId: origin.originKeyId,
        segmentIndex: 0,
        startByteCursor: 0,
        endByteCursor: auxiliaryBytes.byteLength,
        startItemCursor: 0,
        endItemCursor: 1,
        previousContentDigest: null,
        plaintextDigest:
          calculateConversationSourceReplicationPlaintextDigest(auxiliaryBytes),
        sourceFormat: "codex-jsonl",
        adapterVersion: "codex-transcript-v1",
        sourceCreatedAt: iso,
        priorGenerationClosure: null
      },
      origin.privateKey
    );
    const sourcePayload = {
      signedManifest,
      plaintextBytes: auxiliaryBytes.toString("base64url")
    };
    const encryptedSourcePayload = await root.encrypt({
      plaintext: JSON.stringify(sourcePayload),
      scope: { objectClass: "conversation_source_segment" },
      provenance: {
        rowFamily: "conversation_source_segments",
        sourceId: ids.segment
      },
      ciphertextLocation: "conversation_source_segments.payload",
      aad: { artifactId: ids.auxiliaryArtifact, segmentIndex: 0 }
    });
    const session: CapturedSessionRecord = {
      id: ids.session,
      logicalSessionId: ids.logicalSession,
      ownerUserId: ids.user,
      visibility: "personal",
      externalSessionId: "source-session",
      forkedFromExternalThreadId: null,
      sourceRuntime: "codex",
      captureMethod: "transcript",
      model: null,
      cwd: null,
      sourceKind: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceFingerprint: "1".repeat(64),
      capturedProject: {},
      importObservedAt: null,
      metadata: {},
      capturedProjectProvenance: {},
      automaticProject: null,
      projectOverride: null,
      project: null,
      projectAssignmentSource: null,
      projectAssignmentUpdatedAt: null,
      createdAt: iso
    };
    const artifact = (
      id: string,
      sourceComponentId: string,
      sourceComponentRole: "primary" | "auxiliary"
    ): ConversationSourceArtifactRecord => ({
      id,
      ownerUserId: ids.user,
      sessionId: ids.session,
      logicalSourceId: ids.logicalSource,
      sourceGenerationId: ids.generation,
      sourceComponentId,
      sourceComponentRole,
      parentSourceComponentId:
        sourceComponentRole === "auxiliary" ? "main" : null,
      contentFraming: "jsonl",
      replicaRole: "origin_local",
      sourceKind: "codex",
      sourceRuntime: "codex",
      externalSessionId: "source-session",
      sourceFingerprint: "1".repeat(64),
      artifactFormat: "codex_rollout_jsonl",
      artifactFormatVersion: 1,
      sourceAdapterVersion: "codex-transcript-v1",
      lifecycle: "active",
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: 0,
      liveStartLine: 0,
      providerCursorOffset: auxiliaryBytes.byteLength,
      providerCursorLine: 1,
      currentSourceLength: auxiliaryBytes.byteLength,
      currentJournalSequence: 0,
      sourceCreatedAt: iso,
      sourceModifiedAt: iso,
      storageProvider: "envelope_db",
      storagePrefix: `${ids.generation}/${sourceComponentId}`,
      closureHash: null,
      closureManifest: null,
      closureSignature: null,
      sourceSetClosureHash: null,
      sourceSetClosureManifest: null,
      sourceSetClosureSignature: null,
      sourceSetFinalizedAt: null,
      originDeploymentId: ids.deployment,
      originDeviceId: randomUUID(),
      originKeyId: origin.originKeyId,
      originPublicKey: origin.publicKeyBase64url,
      originKeyStatus: "active",
      priorGenerationClosure: null,
      redactedSourceLabel: "Conversation source",
      createdAt: iso,
      updatedAt: iso,
      finalizedAt: null
    });
    const main = artifact(ids.mainArtifact, "main", "primary");
    const auxiliary = artifact(
      ids.auxiliaryArtifact,
      "agent.researcher",
      "auxiliary"
    );
    const segment: ConversationSourceSegmentRecord = {
      id: ids.segment,
      artifactId: ids.auxiliaryArtifact,
      segmentIndex: 0,
      sourceStartOffset: 0,
      sourceEndOffset: auxiliaryBytes.byteLength,
      sourceStartLine: 0,
      sourceEndLine: 1,
      plaintextDigest: signedManifest.manifest.plaintextDigest,
      ciphertextDigest: createHash("sha256")
        .update(encryptedSourcePayload.ciphertext)
        .digest("hex"),
      plaintextSize: auxiliaryBytes.byteLength,
      storedSize: encryptedSourcePayload.ciphertext.length,
      storageKey: "auxiliary/0",
      storageProvider: "envelope_db",
      encryptionEnvelope: encryptedSourcePayload as unknown as Record<
        string,
        unknown
      >,
      signedManifest: signedManifest as unknown as Record<string, unknown>,
      originSignature: signedManifest.signature,
      manifestDigest: "2".repeat(64),
      previousContentDigest: null,
      contentDigest: "3".repeat(64),
      createdAt: iso,
      sealedAt: iso
    };
    const authorizationInput = {
      sourceGenerationId: ids.generation,
      sourceComponentId: "agent.researcher",
      targetDeploymentId: ids.deployment,
      firstSegmentIndex: 0,
      recipientKey: {
        algorithm: recipient.algorithm,
        keyId: recipient.keyId,
        keyVersion: recipient.keyVersion,
        publicJwk: recipient.publicJwk
      }
    };
    let createdAuthorization: ConversationSourceDownloadAuthorizationRecord | null =
      null;
    const repository = {
      getConversationSourceArtifactByGeneration: vi.fn(
        async (_actor: unknown, _generation: string, component: string) =>
          component === "agent.researcher" ? auxiliary : main
      ),
      getCapturedSession: vi.fn(async () => session),
      executeActionGrant: vi.fn(async (input: any) => {
        if (
          input.actionGrant !== "hrg_auxiliary" ||
          input.targetId !== ids.auxiliaryArtifact ||
          input.scopeHash !==
            calculateConversationSourceDownloadScopeHash(authorizationInput) ||
          input.requestHash !==
            calculateConversationSourceDownloadRequestHash(authorizationInput)
        ) {
          return null;
        }
        return input.execute({ sourceJournal: repository });
      }),
      createConversationSourceDownloadAuthorization: vi.fn(
        async (_actor: unknown, input: any) => {
          createdAuthorization = {
            id: ids.authorization,
            ownerUserId: ids.user,
            deviceCredentialId: ids.credential,
            artifactId: input.artifactId,
            recipientKey: input.recipientKey,
            initiatingOperationKind: null,
            initiatingOperationId: null,
            firstSegmentIndex: 0,
            lastSegmentIndex: 0,
            createdAt: iso,
            expiresAt: input.expiresAt,
            lastUsedAt: null,
            revokedAt: null,
            revocationReason: null
          };
          return createdAuthorization;
        }
      ),
      getConversationSourceDownloadAuthorization: vi.fn(
        async () => createdAuthorization
      ),
      listConversationSourceSegmentsByIndex: vi.fn(
        async (_actor: unknown, input: { artifactId: string }) =>
          input.artifactId === ids.auxiliaryArtifact ? [segment] : []
      ),
      touchConversationSourceDownloadAuthorization: vi.fn(async () => true)
    };
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      reply
        .status(
          error instanceof z.ZodError
            ? 400
            : ((error as { statusCode?: number }).statusCode ?? 500)
        )
        .send({
          error: error instanceof Error ? error.message : String(error)
        });
    });
    registerConversationSourceReplicationRoutes(app, {
      config: { deploymentProfile: "developer" },
      auth: {
        authenticateDeviceCredential: async () => ({
          user: {
            id: ids.user,
            email: "owner@example.test",
            displayName: "Owner",
            passwordHash: null
          },
          credential: {
            id: ids.credential,
            upstreamBackendId: "upstream-test",
            deviceInstanceId: randomUUID(),
            operationFamilies: ["sync"],
            metadata: { protocolDeploymentId: ids.deployment }
          }
        })
      },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      encryption: { envelopeEncryptionProvider: root },
      requireRepository: () => repository
    } as unknown as ApiRouteContext);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/v1/conversation-source-replication/download-authorizations",
      headers: { "x-koed-action-grant": "hrg_auxiliary" },
      payload: authorizationInput
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({
      sourceGenerationId: ids.generation,
      sourceComponentId: "agent.researcher",
      source: { sourceComponentId: "agent.researcher" }
    });
    expect(
      repository.createConversationSourceDownloadAuthorization
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ artifactId: ids.auxiliaryArtifact })
    );

    const replayedAsMain = await app.inject({
      method: "POST",
      url: "/v1/conversation-source-replication/download-authorizations",
      headers: { "x-koed-action-grant": "hrg_auxiliary" },
      payload: { ...authorizationInput, sourceComponentId: "main" }
    });
    expect(replayedAsMain.statusCode).toBe(403);

    const createdBody = JSON.parse(created.body) as {
      authorizationId: string;
      capability: string;
    };
    const downloaded = await app.inject({
      method: "GET",
      url: `/v1/conversation-source-replication/download-authorizations/${createdBody.authorizationId}/segments`,
      headers: {
        "x-koed-source-download-capability": createdBody.capability
      }
    });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    const downloadedBody = JSON.parse(downloaded.body) as {
      packages: Array<{ encryptedPackage: unknown }>;
    };
    const decrypted = await decryptEncryptedJsonPackage<{
      operation: string;
      segment: { plaintextBytes: string };
    }>(recipientPrivate, downloadedBody.packages[0]!.encryptedPackage as any);
    expect(decrypted.operation).toBe("download_segment");
    expect(Buffer.from(decrypted.segment.plaintextBytes, "base64url")).toEqual(
      auxiliaryBytes
    );
    expect(
      repository.listConversationSourceSegmentsByIndex
    ).toHaveBeenCalledWith(
      { userId: ids.user },
      expect.objectContaining({ artifactId: ids.auxiliaryArtifact })
    );

    await app.close();
  });
});
