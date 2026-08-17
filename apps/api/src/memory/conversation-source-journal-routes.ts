import { createHash, randomUUID } from "node:crypto";
import type { ConversationSourceSegmentRecord } from "@koed/db";
import {
  calculateConversationSourceRootDigest,
  calculateConversationSourceComponentSetDigest,
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  canonicalizeConversationSourceClosureManifest,
  canonicalizeConversationSourceReplicationManifest,
  canonicalizeConversationSourceSetClosureManifest,
  createDeviceBoundSourceSigner,
  decryptEnvelopeToUtf8,
  exportConversationSourceReplicationPublicKey,
  importConversationSourceReplicationPublicKey,
  parseConversationSourceReplicationSegmentEnvelope,
  type ConversationSourceClosureManifest,
  type ConversationSourceSetClosureManifest,
  type DeviceBoundSourceSigner,
  type EncryptedPayloadEnvelope,
  type ConversationSourceReplicationManifest
} from "@koed/shared";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  conversationSourceArtifactLookupSchema,
  conversationSourceArtifactFinalizeSchema,
  conversationSourceArtifactParamsSchema,
  conversationSourceArtifactSchema,
  conversationSourceCursorLookupSchema,
  conversationSourceCursorSchema,
  conversationSourceGenerationParamsSchema,
  conversationSourceGenerationLookupSchema,
  conversationSourceSegmentAppendSchema,
  conversationSourceSegmentListSchema,
  conversationSourceSegmentParamsSchema,
  conversationSourceSuccessorGenerationSchema
} from "./conversation-source-journal-schemas.js";
import {
  createFilesystemConversationSourceStorage,
  type ConversationSourceStorage
} from "./conversation-source-storage.js";

const localProfiles = new Set(["developer", "local_personal"]);
const MAXIMUM_SEGMENT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SEGMENT_BASE64_BYTES = Math.ceil(MAXIMUM_SEGMENT_BYTES / 3) * 4;

const requireLocalJournalSurface = (context: ApiRouteContext): void => {
  if (!localProfiles.has(context.config.deploymentProfile)) {
    throw Object.assign(
      new Error("Conversation source journal is local-only"),
      {
        statusCode: 404
      }
    );
  }
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const decodeCanonicalBase64 = (encoded: string): Uint8Array => {
  if (
    encoded.length === 0 ||
    encoded.length > MAXIMUM_SEGMENT_BASE64_BYTES ||
    encoded.length % 4 !== 0
  ) {
    throw Object.assign(
      new Error("Conversation source segment encoding is invalid"),
      { statusCode: 400 }
    );
  }
  let padding = 0;
  if (encoded.endsWith("==")) padding = 2;
  else if (encoded.endsWith("=")) padding = 1;
  const contentLength = encoded.length - padding;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    const validContent =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (
      (index < contentLength && !validContent) ||
      (index >= contentLength && code !== 0x3d)
    ) {
      throw Object.assign(
        new Error("Conversation source segment encoding is invalid"),
        { statusCode: 400 }
      );
    }
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength > MAXIMUM_SEGMENT_BYTES ||
    Buffer.from(bytes).toString("base64") !== encoded
  ) {
    throw Object.assign(
      new Error("Conversation source segment encoding is non-canonical"),
      { statusCode: 400 }
    );
  }
  return bytes;
};

const decodeCompleteJsonlSegment = (
  bytesBase64: string,
  expectedSize: number,
  expectedDigest: string,
  expectedLineCount: number
): Uint8Array => {
  const bytes = decodeCanonicalBase64(bytesBase64);
  if (
    bytes.byteLength !== expectedSize ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAXIMUM_SEGMENT_BYTES ||
    bytes.at(-1) !== 0x0a ||
    sha256(bytes) !== expectedDigest
  ) {
    throw Object.assign(new Error("Conversation source segment is invalid"), {
      statusCode: 400
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(
      new Error("Conversation source segment is not valid UTF-8"),
      { statusCode: 400 }
    );
  }
  const lines = text.split(/\n/).slice(0, -1);
  if (
    lines.length !== expectedLineCount ||
    lines.some((line) => !line.trim())
  ) {
    throw Object.assign(
      new Error("Conversation source segment line range is invalid"),
      { statusCode: 400 }
    );
  }
  try {
    for (const line of lines) JSON.parse(line.replace(/\r$/, ""));
  } catch {
    throw Object.assign(
      new Error("Conversation source segment contains malformed JSONL"),
      { statusCode: 400 }
    );
  }
  return bytes;
};

const decodeImmutableBlobSegment = (
  bytesBase64: string,
  expectedSize: number,
  expectedDigest: string
): Uint8Array => {
  const bytes = decodeCanonicalBase64(bytesBase64);
  if (
    bytes.byteLength !== expectedSize ||
    bytes.byteLength === 0 ||
    sha256(bytes) !== expectedDigest
  ) {
    throw Object.assign(
      new Error("Conversation source immutable blob is invalid"),
      { statusCode: 400 }
    );
  }
  return bytes;
};

const safeSegment = (segment: ConversationSourceSegmentRecord) => {
  const { storageKey, encryptionEnvelope, ...safe } = segment;
  void storageKey;
  void encryptionEnvelope;
  return safe;
};

export const readConversationSourceSegmentBytes = async (
  context: ApiRouteContext,
  storage: ConversationSourceStorage,
  segment: ConversationSourceSegmentRecord
): Promise<Uint8Array> => {
  if (segment.storageProvider === storage.provider) {
    return storage.read({
      storageKey: segment.storageKey,
      expectedDigest: segment.plaintextDigest,
      maximumBytes: MAXIMUM_SEGMENT_BYTES
    });
  }
  if (segment.storageProvider !== "envelope_db") {
    throw Object.assign(
      new Error("Conversation source storage provider is unsupported"),
      { statusCode: 409 }
    );
  }
  const provider = context.encryption.envelopeEncryptionProvider;
  if (!provider || !segment.encryptionEnvelope) {
    throw Object.assign(
      new Error("Conversation source envelope is unavailable"),
      { statusCode: 503 }
    );
  }
  const restored = parseConversationSourceReplicationSegmentEnvelope(
    JSON.parse(
      await decryptEnvelopeToUtf8(
        provider,
        segment.encryptionEnvelope as unknown as EncryptedPayloadEnvelope
      )
    ) as unknown
  );
  const manifest = restored.signedManifest.manifest;
  if (
    manifest.segmentIndex !== segment.segmentIndex ||
    manifest.startByteCursor !== segment.sourceStartOffset ||
    manifest.endByteCursor !== segment.sourceEndOffset ||
    manifest.startItemCursor !== segment.sourceStartLine ||
    manifest.endItemCursor !== segment.sourceEndLine ||
    manifest.plaintextDigest !== segment.plaintextDigest ||
    restored.signedManifest.signature !== segment.originSignature ||
    calculateConversationSourceReplicationManifestDigest(manifest) !==
      segment.manifestDigest ||
    calculateConversationSourceReplicationContentDigest(
      restored.signedManifest
    ) !== segment.contentDigest
  ) {
    throw Object.assign(
      new Error("Conversation source envelope identity is invalid"),
      { statusCode: 409 }
    );
  }
  const bytes = Buffer.from(restored.plaintextBytes, "base64url");
  if (
    bytes.toString("base64url") !== restored.plaintextBytes ||
    bytes.byteLength !== segment.plaintextSize ||
    bytes.byteLength > MAXIMUM_SEGMENT_BYTES ||
    sha256(bytes) !== segment.plaintextDigest
  ) {
    throw Object.assign(
      new Error("Conversation source envelope content is invalid"),
      { statusCode: 409 }
    );
  }
  return bytes;
};

export type ConversationSourceSignerFactory = (input: {
  koedHome: string;
  sourceGenerationId: string;
  originKeyId: string;
}) => DeviceBoundSourceSigner;

export const registerConversationSourceJournalRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  storage: ConversationSourceStorage = createFilesystemConversationSourceStorage(
    context.config.koedHome
  ),
  sourceSignerFactory: ConversationSourceSignerFactory = createDeviceBoundSourceSigner
): void => {
  app.post(
    "/v1/conversation-source-artifacts",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const input = conversationSourceArtifactSchema.parse(request.body);
      const repo = context.requireRepository();
      const existing =
        await repo.getConversationSourceArtifactByProviderIdentity(
          { userId: user.id },
          {
            sourceKind: input.sourceKind,
            externalSessionId: input.externalSessionId,
            sourceComponentId: input.sourceComponentId
          }
        );
      if (existing) {
        return {
          session: await repo.getCapturedSession(
            { userId: user.id },
            existing.sessionId
          ),
          artifact: existing
        };
      }
      const policy = await context.capture.resolveCapturePolicyForRequest(
        repo,
        { userId: user.id },
        {
          projectId: input.sourceSession.cwd,
          threadId: input.externalSessionId
        }
      );
      context.capture.rejectUnsupportedCapturePolicy(policy);
      if (policy.captureState !== "enabled") {
        throw Object.assign(
          new Error("Capture Policy blocks conversation source journaling"),
          { statusCode: 409 }
        );
      }
      const artifactIdPrefix = createHash("sha256")
        .update(
          `${user.id}:${input.sourceKind}:${input.externalSessionId}:${input.sourceComponentId}`
        )
        .digest("hex")
        .slice(0, 24);
      const { sourceSession, ...artifactInput } = input;
      const primaryArtifact =
        input.sourceComponentRole === "auxiliary"
          ? await repo.getConversationSourceArtifactByProviderIdentity(
              { userId: user.id },
              {
                sourceKind: input.sourceKind,
                externalSessionId: input.externalSessionId,
                sourceComponentId: input.parentSourceComponentId ?? "main"
              }
            )
          : null;
      if (input.sourceComponentRole === "auxiliary" && !primaryArtifact) {
        throw Object.assign(
          new Error("Conversation source parent component not found"),
          { statusCode: 409 }
        );
      }
      const logicalSourceId = primaryArtifact?.logicalSourceId ?? randomUUID();
      const sourceGenerationId =
        primaryArtifact?.sourceGenerationId ?? randomUUID();
      const originKeyId = randomUUID();
      const signer = sourceSignerFactory({
        koedHome: context.config.koedHome,
        sourceGenerationId,
        originKeyId
      });
      const artifact = {
        ...artifactInput,
        logicalSourceId,
        sourceGenerationId,
        replicaRole: "origin_local" as const,
        sourceRuntime: sourceSession.sourceRuntime,
        sourceAdapterVersion:
          input.sourceKind === "claude-code"
            ? "claude-code-transcript-v1"
            : input.sourceKind === "pi"
              ? "pi-session-v1"
              : "codex-transcript-v1",
        storageProvider: storage.provider,
        storagePrefix: artifactIdPrefix,
        originDeploymentId: signer.deploymentId,
        originDeviceId: signer.deviceInstanceId,
        originKeyId,
        originPublicKey: signer.publicKey
      };
      const result = primaryArtifact
        ? {
            session: await repo.getCapturedSession(
              { userId: user.id },
              primaryArtifact.sessionId
            ),
            artifact: await repo.ensureConversationSourceArtifact(
              { userId: user.id },
              { ...artifact, sessionId: primaryArtifact.sessionId }
            )
          }
        : await repo.ensureConversationSourceArtifactForCapturedSession(
            { userId: user.id },
            {
              session: {
                ...sourceSession,
                sourceKind: artifact.sourceKind,
                sourceAdapterVersion: artifact.sourceAdapterVersion
              },
              artifact
            }
          );
      return result;
    }
  );

  app.get(
    "/v1/conversation-source-artifacts/generations/:sourceGenerationId",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { sourceGenerationId } =
        conversationSourceGenerationParamsSchema.parse(request.params);
      const { source_component_id: sourceComponentId } =
        conversationSourceGenerationLookupSchema.parse(request.query);
      const artifact = await context
        .requireRepository()
        .getConversationSourceArtifactByGeneration(
          { userId: user.id },
          sourceGenerationId,
          sourceComponentId
        );
      if (!artifact) {
        throw Object.assign(
          new Error("Conversation source generation not found"),
          { statusCode: 404 }
        );
      }
      return { artifact };
    }
  );

  app.get(
    "/v1/conversation-source-artifacts/generations/:sourceGenerationId/components",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { sourceGenerationId } =
        conversationSourceGenerationParamsSchema.parse(request.params);
      const artifacts = await context
        .requireRepository()
        .listConversationSourceArtifactsByGeneration(
          { userId: user.id },
          sourceGenerationId
        );
      if (artifacts.length === 0) {
        throw Object.assign(
          new Error("Conversation source generation not found"),
          {
            statusCode: 404
          }
        );
      }
      return {
        sourceGenerationId,
        components: artifacts.map((artifact) => ({
          sourceComponentId: artifact.sourceComponentId,
          sourceComponentRole: artifact.sourceComponentRole,
          parentSourceComponentId: artifact.parentSourceComponentId,
          contentFraming: artifact.contentFraming,
          artifact
        })),
        sourceSetClosure:
          artifacts.find((artifact) => artifact.sourceComponentId === "main")
            ?.sourceSetClosureManifest ?? null
      };
    }
  );

  app.post(
    "/v1/conversation-source-artifacts/generations/:sourceGenerationId/finalize-source-set",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { sourceGenerationId } =
        conversationSourceGenerationParamsSchema.parse(request.params);
      const repository = context.requireRepository();
      const artifacts =
        await repository.listConversationSourceArtifactsByGeneration(
          { userId: user.id },
          sourceGenerationId
        );
      const main = artifacts.find(
        (artifact) =>
          artifact.sourceComponentId === "main" &&
          artifact.sourceComponentRole === "primary"
      );
      if (
        !main ||
        artifacts.some(
          (artifact) =>
            artifact.lifecycle !== "finalized" || !artifact.closureHash
        )
      ) {
        throw Object.assign(
          new Error("Conversation source-set components are not finalized"),
          { statusCode: 409 }
        );
      }
      if (
        main.sourceSetClosureHash &&
        main.sourceSetClosureManifest &&
        main.sourceSetClosureSignature &&
        main.sourceSetFinalizedAt
      ) {
        return { artifacts, replayed: true };
      }
      const components = artifacts
        .map((artifact) => ({
          sourceComponentId: artifact.sourceComponentId,
          sourceComponentRole: artifact.sourceComponentRole,
          parentSourceComponentId: artifact.parentSourceComponentId,
          contentFraming: artifact.contentFraming,
          artifactClosureDigest: artifact.closureHash!
        }))
        .sort((left, right) =>
          left.sourceComponentId.localeCompare(right.sourceComponentId)
        );
      const signer = sourceSignerFactory({
        koedHome: context.config.koedHome,
        sourceGenerationId,
        originKeyId: main.originKeyId
      });
      if (signer.publicKey !== main.originPublicKey) {
        throw Object.assign(
          new Error("Conversation source-set signing authority is unavailable"),
          { statusCode: 409 }
        );
      }
      const manifest: ConversationSourceSetClosureManifest = {
        protocol: "koed.conversation-source-replication/v1",
        sourceSetClosureVersion: 1,
        sourceComponentSchemaVersion: 1,
        logicalSourceId: main.logicalSourceId,
        sourceGenerationId,
        signingComponentId: "main",
        originKeyId: main.originKeyId,
        components,
        componentSetDigest:
          calculateConversationSourceComponentSetDigest(components),
        closedAt: new Date().toISOString()
      };
      return repository.finalizeConversationSourceSet(
        { userId: user.id },
        {
          sourceGenerationId,
          signedClosure: {
            manifest,
            signature: signer.sign(
              Buffer.from(
                canonicalizeConversationSourceSetClosureManifest(manifest),
                "utf8"
              )
            )
          }
        }
      );
    }
  );

  app.get(
    "/v1/conversation-source-artifacts/lookup",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const input = conversationSourceArtifactLookupSchema.parse(request.query);
      const artifact = await context
        .requireRepository()
        .getConversationSourceArtifactByProviderIdentity(
          { userId: user.id },
          {
            sourceKind: input.source_kind,
            externalSessionId: input.external_session_id,
            sourceComponentId: input.source_component_id
          }
        );
      if (!artifact) {
        throw Object.assign(
          new Error("Conversation source artifact not found"),
          { statusCode: 404 }
        );
      }
      return { artifact };
    }
  );

  app.post(
    "/v1/conversation-source-artifacts/:artifactId/segments",
    {
      preHandler: context.rateLimit.sourceJournal,
      bodyLimit: 24 * 1024 * 1024
    },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { artifactId } = conversationSourceArtifactParamsSchema.parse(
        request.params
      );
      const input = conversationSourceSegmentAppendSchema.parse(request.body);
      const artifact = await context
        .requireRepository()
        .getConversationSourceArtifact({ userId: user.id }, artifactId);
      if (!artifact) {
        throw Object.assign(
          new Error("Conversation source artifact not found"),
          { statusCode: 404 }
        );
      }
      if (
        artifact.contentFraming === "immutable_blob" &&
        (input.expectedProviderOffset !== artifact.journalStartOffset ||
          input.expectedProviderLine !== artifact.journalStartLine ||
          input.sourceEndOffset !== input.currentSourceLength ||
          input.sourceEndLine !== input.expectedProviderLine + 1)
      ) {
        throw Object.assign(
          new Error("Conversation source immutable blob range is invalid"),
          { statusCode: 409 }
        );
      }
      const bytes =
        artifact.contentFraming === "immutable_blob"
          ? decodeImmutableBlobSegment(
              input.bytesBase64,
              input.plaintextSize,
              input.plaintextDigest
            )
          : decodeCompleteJsonlSegment(
              input.bytesBase64,
              input.plaintextSize,
              input.plaintextDigest,
              input.sourceEndLine - input.expectedProviderLine
            );
      if (
        input.expectedProviderOffset < artifact.providerCursorOffset ||
        input.expectedProviderLine < artifact.providerCursorLine
      ) {
        const [existing] = await context
          .requireRepository()
          .listConversationSourceSegments(
            { userId: user.id },
            {
              artifactId,
              afterOffset: input.expectedProviderOffset,
              limit: 1
            }
          );
        if (
          existing?.sourceStartOffset === input.expectedProviderOffset &&
          existing.sourceEndOffset === input.sourceEndOffset &&
          existing.sourceStartLine === input.expectedProviderLine &&
          existing.sourceEndLine === input.sourceEndLine &&
          existing.plaintextDigest === input.plaintextDigest &&
          existing.plaintextSize === input.plaintextSize
        ) {
          return {
            artifact,
            segment: safeSegment(existing),
            replayed: true
          };
        }
        throw Object.assign(
          new Error("Conversation source segment replay conflict"),
          { statusCode: 409 }
        );
      }
      if (
        artifact.lifecycle !== "active" ||
        input.expectedProviderOffset !== artifact.providerCursorOffset ||
        input.expectedProviderLine !== artifact.providerCursorLine
      ) {
        throw Object.assign(new Error("Conversation source cursor conflict"), {
          statusCode: 409
        });
      }
      const signer = sourceSignerFactory({
        koedHome: context.config.koedHome,
        sourceGenerationId: artifact.sourceGenerationId,
        originKeyId: artifact.originKeyId
      });
      if (
        signer.publicKey !== artifact.originPublicKey ||
        exportConversationSourceReplicationPublicKey(
          importConversationSourceReplicationPublicKey(signer.publicKey)
        ) !== artifact.originPublicKey
      ) {
        throw Object.assign(
          new Error("Conversation source signing authority is unavailable"),
          { statusCode: 409 }
        );
      }
      const segmentIndex = artifact.currentJournalSequence + 1;
      const [previous] =
        segmentIndex === 0
          ? []
          : await context.requireRepository().listConversationSourceSegments(
              { userId: user.id },
              {
                artifactId,
                afterOffset: Math.max(
                  artifact.journalStartOffset,
                  input.expectedProviderOffset - 1
                ),
                limit: 1
              }
            );
      if (
        segmentIndex > 0 &&
        (!previous ||
          previous.segmentIndex !== segmentIndex - 1 ||
          previous.sourceEndOffset !== input.expectedProviderOffset ||
          previous.sourceEndLine !== input.expectedProviderLine)
      ) {
        throw Object.assign(
          new Error("Conversation source segment predecessor is unavailable"),
          { statusCode: 409 }
        );
      }
      const manifest: ConversationSourceReplicationManifest = {
        protocol: "koed.conversation-source-replication/v1",
        sourceComponentSchemaVersion: 1,
        sourceComponentId: artifact.sourceComponentId,
        sourceComponentRole: artifact.sourceComponentRole,
        parentSourceComponentId: artifact.parentSourceComponentId,
        contentFraming: artifact.contentFraming,
        logicalSourceId: artifact.logicalSourceId,
        sourceGenerationId: artifact.sourceGenerationId,
        originKeyId: artifact.originKeyId,
        segmentIndex,
        startByteCursor: input.expectedProviderOffset,
        endByteCursor: input.sourceEndOffset,
        startItemCursor: input.expectedProviderLine,
        endItemCursor: input.sourceEndLine,
        previousContentDigest: previous?.contentDigest ?? null,
        plaintextDigest: input.plaintextDigest,
        sourceFormat: artifact.artifactFormat,
        adapterVersion: artifact.sourceAdapterVersion,
        sourceCreatedAt: artifact.sourceCreatedAt,
        priorGenerationClosure:
          artifact.priorGenerationClosure as ConversationSourceReplicationManifest["priorGenerationClosure"]
      };
      const signedManifest = {
        manifest,
        signature: signer.sign(
          Buffer.from(
            canonicalizeConversationSourceReplicationManifest(manifest),
            "utf8"
          )
        )
      };
      const stored = storage.put({
        artifactId,
        plaintextDigest: input.plaintextDigest,
        bytes
      });
      const result = await context
        .requireRepository()
        .appendConversationSourceSegment(
          { userId: user.id },
          {
            artifactId,
            expectedProviderOffset: input.expectedProviderOffset,
            expectedProviderLine: input.expectedProviderLine,
            sourceEndOffset: input.sourceEndOffset,
            sourceEndLine: input.sourceEndLine,
            plaintextDigest: input.plaintextDigest,
            plaintextSize: input.plaintextSize,
            storedSize: stored.storedSize,
            storageKey: stored.storageKey,
            storageProvider: storage.provider,
            signedManifest: { ...manifest },
            originSignature: signedManifest.signature,
            manifestDigest:
              calculateConversationSourceReplicationManifestDigest(manifest),
            previousContentDigest: manifest.previousContentDigest,
            contentDigest:
              calculateConversationSourceReplicationContentDigest(
                signedManifest
              ),
            currentSourceLength: input.currentSourceLength,
            sourceModifiedAt: input.sourceModifiedAt
          }
        );
      return {
        artifact: result.artifact,
        segment: safeSegment(result.segment),
        replayed: result.replayed
      };
    }
  );

  app.get(
    "/v1/conversation-source-artifacts/:artifactId/segments",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { artifactId } = conversationSourceArtifactParamsSchema.parse(
        request.params
      );
      const query = conversationSourceSegmentListSchema.parse(request.query);
      const segments = await context
        .requireRepository()
        .listConversationSourceSegments(
          { userId: user.id },
          {
            artifactId,
            afterOffset: query.after_offset,
            limit: query.limit
          }
        );
      return { segments: segments.map(safeSegment) };
    }
  );

  app.post(
    "/v1/conversation-source-artifacts/:artifactId/successor",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { artifactId } = conversationSourceArtifactParamsSchema.parse(
        request.params
      );
      const input = conversationSourceSuccessorGenerationSchema.parse(
        request.body
      );
      const signer = sourceSignerFactory({
        koedHome: context.config.koedHome,
        sourceGenerationId: input.sourceGenerationId,
        originKeyId: input.originKeyId
      });
      const storagePrefix = createHash("sha256")
        .update(
          `${user.id}:${artifactId}:${input.sourceGenerationId}:${input.originKeyId}`
        )
        .digest("hex")
        .slice(0, 24);
      return context
        .requireRepository()
        .createConversationSourceSuccessorGeneration(
          { userId: user.id },
          {
            parentArtifactId: artifactId,
            expectedParentClosureHash: input.expectedParentClosureHash,
            sourceGenerationId: input.sourceGenerationId,
            originDeploymentId: signer.deploymentId,
            originDeviceId: signer.deviceInstanceId,
            originKeyId: input.originKeyId,
            originPublicKey: signer.publicKey,
            sourceCreatedAt: new Date().toISOString(),
            storageProvider: storage.provider,
            storagePrefix
          }
        );
    }
  );

  app.post(
    "/v1/conversation-source-artifacts/:artifactId/finalize",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { artifactId } = conversationSourceArtifactParamsSchema.parse(
        request.params
      );
      const input = conversationSourceArtifactFinalizeSchema.parse(
        request.body
      );
      const repository = context.requireRepository();
      const artifact = await repository.getConversationSourceArtifact(
        { userId: user.id },
        artifactId
      );
      if (!artifact) {
        throw Object.assign(
          new Error("Conversation source artifact not found"),
          { statusCode: 404 }
        );
      }
      if (
        input.expectedProviderOffset !== artifact.providerCursorOffset ||
        input.expectedProviderLine !== artifact.providerCursorLine
      ) {
        throw Object.assign(
          new Error("Conversation source finalization cursor conflict"),
          { statusCode: 409 }
        );
      }
      const signer = sourceSignerFactory({
        koedHome: context.config.koedHome,
        sourceGenerationId: artifact.sourceGenerationId,
        originKeyId: artifact.originKeyId
      });
      if (signer.publicKey !== artifact.originPublicKey) {
        throw Object.assign(
          new Error("Conversation source signing authority is unavailable"),
          { statusCode: 409 }
        );
      }
      const segments: ConversationSourceSegmentRecord[] = [];
      let afterSegmentIndex = -1;
      while (true) {
        const page = await repository.listConversationSourceSegmentsByIndex(
          { userId: user.id },
          {
            artifactId,
            afterSegmentIndex,
            throughSegmentIndex: artifact.currentJournalSequence,
            limit: 100
          }
        );
        segments.push(...page);
        if (
          page.length === 0 ||
          page.at(-1)!.segmentIndex >= artifact.currentJournalSequence
        ) {
          break;
        }
        afterSegmentIndex = page.at(-1)!.segmentIndex;
      }
      const manifest: ConversationSourceClosureManifest = {
        protocol: "koed.conversation-source-replication/v1",
        sourceComponentSchemaVersion: 1,
        sourceComponentId: artifact.sourceComponentId,
        sourceComponentRole: artifact.sourceComponentRole,
        parentSourceComponentId: artifact.parentSourceComponentId,
        contentFraming: artifact.contentFraming,
        logicalSourceId: artifact.logicalSourceId,
        sourceGenerationId: artifact.sourceGenerationId,
        originKeyId: artifact.originKeyId,
        segmentCount: segments.length,
        endByteCursor: artifact.providerCursorOffset,
        endItemCursor: artifact.providerCursorLine,
        chainHeadDigest: segments.at(-1)?.contentDigest ?? null,
        sourceRootDigest: calculateConversationSourceRootDigest(
          segments.map((segment) => segment.contentDigest)
        ),
        sourceCreatedAt: artifact.sourceCreatedAt,
        closedAt: new Date().toISOString(),
        priorGenerationClosure:
          artifact.priorGenerationClosure as ConversationSourceClosureManifest["priorGenerationClosure"]
      };
      const result = await repository.finalizeConversationSourceArtifact(
        { userId: user.id },
        {
          artifactId,
          signedClosure: {
            manifest,
            signature: signer.sign(
              Buffer.from(
                canonicalizeConversationSourceClosureManifest(manifest),
                "utf8"
              )
            )
          }
        }
      );
      return {
        artifact: result.artifact,
        replayed: result.replayed
      };
    }
  );

  app.get(
    "/v1/conversation-source-artifacts/:artifactId/segments/:segmentId/content",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { artifactId, segmentId } =
        conversationSourceSegmentParamsSchema.parse(request.params);
      const segment = await context
        .requireRepository()
        .getConversationSourceSegment(
          { userId: user.id },
          { artifactId, segmentId }
        );
      if (!segment) {
        throw Object.assign(
          new Error("Conversation source segment not found"),
          { statusCode: 404 }
        );
      }
      const bytes = await readConversationSourceSegmentBytes(
        context,
        storage,
        segment
      );
      return {
        segment: safeSegment(segment),
        bytesBase64: Buffer.from(bytes).toString("base64")
      };
    }
  );

  app.get(
    "/v1/conversation-source-artifacts/:artifactId/cursor",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { artifactId } = conversationSourceArtifactParamsSchema.parse(
        request.params
      );
      const query = conversationSourceCursorLookupSchema.parse(request.query);
      const cursor = await context
        .requireRepository()
        .getConversationSourceConsumerCursor(
          { userId: user.id },
          { artifactId, consumerKind: query.consumer_kind }
        );
      return { cursor };
    }
  );

  app.post(
    "/v1/conversation-source-artifacts/:artifactId/cursor",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      requireLocalJournalSurface(context);
      const user = await context.auth.authenticateApiToken(request);
      const { artifactId } = conversationSourceArtifactParamsSchema.parse(
        request.params
      );
      const input = conversationSourceCursorSchema.parse(request.body);
      const cursor = await context
        .requireRepository()
        .advanceConversationSourceConsumerCursor(
          { userId: user.id },
          { artifactId, ...input }
        );
      return { cursor };
    }
  );
};
