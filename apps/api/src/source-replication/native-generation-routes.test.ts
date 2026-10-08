import { randomUUID } from "node:crypto";
import {
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  calculateConversationSourceGenerationRegistrationDigest,
  calculateConversationSourceReplicationOperationDigest,
  createEncryptedJsonPackage,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  generateConversationSourceReplicationOriginKeyPair,
  generateRecipientKeyMaterial,
  type ConversationSourceReplicationSourceDescriptor
} from "@koed/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { registerConversationSourceReplicationRoutes } from "./routes.js";

const fixture = async () => {
  const userId = randomUUID();
  const deploymentId = randomUUID();
  const logicalSourceId = randomUUID();
  const sourceGenerationId = randomUUID();
  const nativeThreadId = randomUUID();
  const root = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 53).toString("base64")
  );
  const recipient = await generateRecipientKeyMaterial(root, {
    keyId: `synthetic-recipient:${randomUUID()}`,
    keyVersion: 1
  });
  const publicProvider =
    createRecipientPublicKeyEnvelopeEncryptionProvider(recipient);
  const keys = generateConversationSourceReplicationOriginKeyPair();
  const registration = {
    protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
    logicalSourceId,
    sourceGenerationId,
    originKeyId: keys.originKeyId,
    publicKey: keys.publicKeyBase64url,
    sourceCreatedAt: "2026-10-07T00:00:00.000Z",
    priorGenerationClosure: null,
    lifecycle: "active" as const
  };
  const source: ConversationSourceReplicationSourceDescriptor = {
    sourceKind: "codex",
    sourceRuntime: "codex-cli",
    sourceComponentSchemaVersion: 1,
    sourceComponentId: "main",
    sourceComponentRole: "primary",
    parentSourceComponentId: null,
    contentFraming: "jsonl",
    logicalSessionId: randomUUID(),
    externalSessionId: nativeThreadId,
    forkedFromExternalThreadId: null,
    sourceFingerprint: "1".repeat(64),
    artifactFormat: "codex_rollout_jsonl",
    artifactFormatVersion: 1,
    sourceAdapterVersion: "codex-transcript-v2",
    redactedSourceLabel: "rollout-fixture.jsonl",
    originDeploymentId: randomUUID(),
    originDeviceId: randomUUID(),
    journalStartOffset: 0,
    journalStartLine: 0,
    liveStartOffset: 0,
    liveStartLine: 0,
    project: null,
    codexHistory: {
      historyMode: "paginated",
      externalThreadId: nativeThreadId,
      threadKind: "conversation",
      subagentHistoryStartOrdinal: null
    }
  };
  const sessionId = randomUUID();
  const repository = {
    ensureLocalSyncDeployment: vi.fn(async () => ({ id: randomUUID() })),
    getSyncRecipientKey: vi.fn(async () => recipient),
    createCapturedSession: vi.fn(async () => ({ id: sessionId })),
    registerConversationSourceReplicaGeneration: vi.fn(async () => ({
      logicalSourceId,
      sourceGenerationId,
      currentJournalSequence: -1
    })),
    releaseManagedConversationCommandsForSourceGeneration: vi.fn(
      async () => undefined
    )
  };
  let operationFamilies = ["sync"];
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    reply
      .status(
        error instanceof z.ZodError
          ? 400
          : ((error as { statusCode?: number }).statusCode ?? 500)
      )
      .send({ error: error instanceof Error ? error.message : String(error) });
  });
  registerConversationSourceReplicationRoutes(app, {
    config: { deploymentProfile: "developer" },
    auth: {
      authenticateDeviceCredential: async () => ({
        user: { id: userId },
        credential: {
          id: randomUUID(),
          operationFamilies,
          deviceInstanceId: randomUUID(),
          metadata: { protocolDeploymentId: randomUUID() }
        }
      })
    },
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    encryption: { envelopeEncryptionProvider: root },
    deploymentIdentity: {
      inspect: () => ({ health: "healthy", deploymentId })
    },
    requireRepository: () => repository
  } as unknown as ApiRouteContext);
  await app.ready();
  const request = async (
    options: {
      transportedSource?: unknown;
      tenantId?: string;
    } = {}
  ) => {
    const operationId = randomUUID();
    const requestDigest = calculateConversationSourceReplicationOperationDigest(
      {
        operationId,
        operationKind: "register_generation",
        logicalSourceId,
        sourceGenerationId,
        targetDeploymentId: deploymentId,
        contentDigest: calculateConversationSourceGenerationRegistrationDigest(
          registration,
          source
        )
      }
    );
    const encryptedPackage = await createEncryptedJsonPackage(publicProvider, {
      objectClass: "sync_package",
      payload: {
        protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
        operation: "register_generation",
        registration,
        source: options.transportedSource ?? source
      },
      scope: { deploymentId, tenantId: options.tenantId ?? userId },
      provenance: {
        rowFamily: "conversation_source_replication",
        sourceId: operationId
      },
      ciphertextLocation: "conversation_source_replication.payload",
      aad: {
        operationId,
        operationKind: "register_generation",
        protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
        targetDeploymentId: deploymentId
      },
      metadata: {
        operationKind: "register_generation",
        protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL
      }
    });
    return { operationId, requestDigest, encryptedPackage };
  };
  const post = (payload: Awaited<ReturnType<typeof request>>) =>
    app.inject({
      method: "POST",
      url: "/v1/conversation-source-replication/generations",
      payload
    });
  return {
    app,
    repository,
    source,
    registration,
    nativeThreadId,
    userId,
    sessionId,
    request,
    post,
    denySync: () => {
      operationFamilies = ["memory"];
    }
  };
};

describe("Native source generation HTTP intake", () => {
  it("binds native identity to the authenticated logical Session on registration and replay", async () => {
    const f = await fixture();
    try {
      const payload = await f.request();
      const accepted = await f.post(payload);
      const replayed = await f.post(payload);
      expect(accepted.statusCode).toBe(200);
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json()).toEqual(accepted.json());
      expect(f.repository.createCapturedSession).toHaveBeenCalledTimes(2);
      for (const call of f.repository.createCapturedSession.mock.calls) {
        expect(call).toEqual([
          { userId: f.userId },
          expect.objectContaining({
            externalSessionId: f.registration.logicalSourceId,
            externalThreadId: f.nativeThreadId,
            logicalSessionId: f.source.logicalSessionId,
            idempotencyKey: `hosted-source:${f.registration.logicalSourceId}:${f.registration.sourceGenerationId}`,
            metadata: expect.objectContaining({
              codexHistory: f.source.codexHistory
            })
          })
        ]);
      }
      expect(
        f.repository.registerConversationSourceReplicaGeneration
      ).toHaveBeenCalledWith(
        { userId: f.userId },
        expect.objectContaining({
          sessionId: f.sessionId,
          externalSessionId: f.registration.logicalSourceId,
          sourceAdapterVersion: "codex-transcript-v2"
        })
      );
    } finally {
      await f.app.close();
    }
  });

  it.each(["credential", "tenant", "digest", "schema"] as const)(
    "rejects invalid %s binding before creating a Session",
    async (kind) => {
      const f = await fixture();
      try {
        if (kind === "credential") f.denySync();
        const payload = await f.request({
          ...(kind === "tenant" ? { tenantId: randomUUID() } : {}),
          ...(kind === "digest"
            ? {
                transportedSource: {
                  ...f.source,
                  codexHistory: {
                    ...f.source.codexHistory,
                    externalThreadId: randomUUID()
                  }
                }
              }
            : {}),
          ...(kind === "schema"
            ? {
                transportedSource: {
                  ...f.source,
                  codexHistory: {
                    ...f.source.codexHistory,
                    externalThreadId: ""
                  }
                }
              }
            : {})
        });
        const response = await f.post(payload);
        expect(response.statusCode).toBe(
          kind === "schema" ? 400 : kind === "digest" ? 409 : 403
        );
        expect(f.repository.createCapturedSession).not.toHaveBeenCalled();
        expect(
          f.repository.registerConversationSourceReplicaGeneration
        ).not.toHaveBeenCalled();
      } finally {
        await f.app.close();
      }
    }
  );
});
