import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { resolve, sep } from "node:path";
import type {
  ClaimedConversationSourceRestoreJob,
  ConversationSourceArtifactRecord,
  ConversationItemInput,
  ConversationSourceSegmentRecord,
  MemorySourceRepository
} from "@koed/db";
import {
  assertConversationSourceReplicationJsonlSegment,
  assertSupportedAiClientSourceAdapter,
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  calculateConversationSourceClosureDigest,
  calculateConversationSourceClosureOperationContentDigest,
  calculateConversationSourceSetClosureDigest,
  calculateConversationSourceGenerationRegistrationDigest,
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  calculateConversationSourceReplicationOperationDigest,
  createEncryptedJsonPackage,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  decryptEncryptedJsonPackage,
  decryptEnvelopeToUtf8,
  fetchBoundedJsonObject,
  inspectDeviceIdentityAtKoedHome,
  parseConversationSourceReplicationSegmentEnvelope,
  parseSignedConversationSourceClosureManifest,
  parseSignedConversationSourceSetClosureManifest,
  parseConversationSourceOriginKeyRegistration,
  parseConversationSourceReplicationSourceDescriptor,
  readLocalEdgeUpstreamRegistry,
  readUpstreamCredentialAuthorization,
  upstreamAdvertisesCapability,
  upstreamApiUrl,
  upstreamBackendById,
  verifyConversationSourceReplicationManifestForAcceptance,
  type ConversationSourceOriginKeyRegistration,
  type ConversationSourceReplicationSourceDescriptor,
  type EncryptedJsonPackage,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type RecipientPublicKeyMaterial
} from "@koed/shared";
import {
  buildCodexTranscriptConversationItems,
  extractTranscriptSessionMetadata,
  parseTranscriptJournalBytes,
  type TranscriptJournalParserState
} from "@koed/mcp-server/codex-transcript-parser";
import { parseClaudeTranscriptJournalBytes } from "@koed/mcp-server/claude-transcript-parser";
import type { Logger } from "pino";

const maxSegmentBytes = 16 * 1024 * 1024;
const maxMaterializationBytes = 64 * 1024 * 1024;
const maxResponseBytes = 1024 * 1024;
const requestTimeoutMs = 30_000;
const outboxLeaseMs = 180_000;
const outboxLeaseHeartbeatMs = 45_000;
const sourceStorageKeyPattern =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{64})\.segment$/i;
const portableProjectIdPattern = /^lp_[0-9a-f]{32}$/;

interface SourceReplicationLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

type ReplicationWakeClient = {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", listener: (error: unknown) => void): void;
  removeAllListeners(event?: "notification" | "error"): void;
  release(): void;
};

type ReplicationWakePool = {
  connect(): Promise<ReplicationWakeClient>;
};

interface TargetContext {
  targetDeploymentId: string;
  targetUserId: string;
  recipientKey: RecipientPublicKeyMaterial;
}

interface SourceRegistrationResult {
  authorization: string;
  backendBaseUrl: string;
  context: TargetContext;
}

export interface ConversationSourceReplicationService {
  start(): void;
  stop(): Promise<void>;
  processOnce(): Promise<{
    uploaded: number;
    restored: number;
    materialized: number;
  }>;
}

class SourceReplicationError extends Error {
  constructor(
    name: string,
    message: string,
    readonly transient: boolean
  ) {
    super(message);
    this.name = name;
  }
}

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const sourceDescriptor = (
  artifact: ConversationSourceArtifactRecord,
  sourceSession: NonNullable<
    Awaited<ReturnType<MemorySourceRepository["getCapturedSession"]>>
  >
): ConversationSourceReplicationSourceDescriptor => {
  const adapter = {
    sourceKind: artifact.sourceKind,
    sourceRuntime: artifact.sourceRuntime,
    artifactFormat: artifact.artifactFormat,
    artifactFormatVersion: artifact.artifactFormatVersion,
    sourceAdapterVersion: artifact.sourceAdapterVersion
  };
  assertSupportedAiClientSourceAdapter(adapter);
  return parseConversationSourceReplicationSourceDescriptor({
    sourceKind: adapter.sourceKind,
    sourceComponentSchemaVersion: 1,
    sourceComponentId: artifact.sourceComponentId,
    sourceComponentRole: artifact.sourceComponentRole,
    parentSourceComponentId: artifact.parentSourceComponentId,
    contentFraming: artifact.contentFraming,
    logicalSessionId: sourceSession.logicalSessionId,
    externalSessionId: artifact.externalSessionId,
    forkedFromExternalThreadId:
      sourceSession.forkedFromExternalThreadId ?? null,
    sourceFingerprint: artifact.sourceFingerprint,
    artifactFormat: adapter.artifactFormat,
    artifactFormatVersion: adapter.artifactFormatVersion,
    sourceAdapterVersion: adapter.sourceAdapterVersion,
    sourceRuntime: adapter.sourceRuntime,
    redactedSourceLabel: artifact.redactedSourceLabel,
    originDeploymentId: artifact.originDeploymentId,
    originDeviceId: artifact.originDeviceId,
    journalStartOffset: artifact.journalStartOffset,
    journalStartLine: artifact.journalStartLine,
    liveStartOffset: artifact.liveStartOffset,
    liveStartLine: artifact.liveStartLine,
    project:
      sourceSession.project &&
      portableProjectIdPattern.test(sourceSession.project.id)
        ? {
            id: sourceSession.project.id,
            name: sourceSession.project.name
          }
        : null
  });
};

const originKeyRegistration = (
  artifact: ConversationSourceArtifactRecord
): ConversationSourceOriginKeyRegistration => ({
  protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  logicalSourceId: artifact.logicalSourceId,
  sourceGenerationId: artifact.sourceGenerationId,
  originKeyId: artifact.originKeyId,
  publicKey: artifact.originPublicKey,
  lifecycle: artifact.originKeyStatus,
  sourceCreatedAt: artifact.sourceCreatedAt,
  priorGenerationClosure:
    artifact.priorGenerationClosure as ConversationSourceOriginKeyRegistration["priorGenerationClosure"]
});

const targetContext = (payload: Record<string, unknown>): TargetContext => {
  const targetDeploymentId = payload.target_deployment_id;
  const targetUserId = payload.target_user_id;
  const recipientKey = payload.recipient_key;
  if (
    typeof targetDeploymentId !== "string" ||
    typeof targetUserId !== "string" ||
    !recipientKey ||
    typeof recipientKey !== "object" ||
    Array.isArray(recipientKey)
  ) {
    throw new SourceReplicationError(
      "SourceReplicationTargetIdentityError",
      "Source replication target identity is invalid",
      false
    );
  }
  const parsed = recipientKey as unknown as RecipientPublicKeyMaterial;
  createRecipientPublicKeyEnvelopeEncryptionProvider(parsed);
  return { targetDeploymentId, targetUserId, recipientKey: parsed };
};

const checkedRequest = async (
  fetchFn: typeof fetch,
  url: URL,
  authorization: string,
  body: unknown
): Promise<Record<string, unknown>> => {
  const { response, payload } = await fetchBoundedJsonObject(
    fetchFn,
    url,
    {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    },
    {
      timeoutMs: requestTimeoutMs,
      maxBytes: maxResponseBytes,
      readErrorBody: true
    }
  );
  if (!response.ok) {
    throw new SourceReplicationError(
      response.status === 401 || response.status === 403
        ? "SourceReplicationAuthorizationError"
        : response.status === 409
          ? "SourceReplicationConflictError"
          : response.status === 429
            ? "SourceReplicationRateLimitError"
            : "SourceReplicationRemoteError",
      `Source replication target returned HTTP ${response.status}`,
      response.status === 429 || response.status >= 500
    );
  }
  return payload;
};

const checkedDownloadPage = async (
  fetchFn: typeof fetch,
  url: URL,
  authorization: string,
  capability: string
): Promise<Record<string, unknown>> => {
  const { response, payload } = await fetchBoundedJsonObject(
    fetchFn,
    url,
    {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization,
        "x-koed-source-download-capability": capability
      }
    },
    {
      timeoutMs: requestTimeoutMs,
      maxBytes: 24 * 1024 * 1024,
      readErrorBody: true
    }
  );
  if (!response.ok) {
    throw new SourceReplicationError(
      response.status === 401 || response.status === 403
        ? "SourceRestoreAuthorizationError"
        : response.status === 409
          ? "SourceRestoreConflictError"
          : response.status === 429
            ? "SourceRestoreRateLimitError"
            : "SourceRestoreRemoteError",
      `Source restore backend returned HTTP ${response.status}`,
      response.status === 429 || response.status >= 500
    );
  }
  return payload;
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new SourceReplicationError(
      "SourceRestorePayloadShapeError",
      `${label} is invalid`,
      false
    );
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new SourceReplicationError(
      "SourceRestorePayloadShapeError",
      `${label} has unknown or missing fields`,
      false
    );
  }
  return record;
};

const readFilesystemSourceSegment = (
  koedHome: string,
  artifact: ConversationSourceArtifactRecord,
  segment: ConversationSourceSegmentRecord
): Uint8Array => {
  const match = sourceStorageKeyPattern.exec(segment.storageKey);
  if (
    !match ||
    match[1] !== artifact.id ||
    match[2] !== segment.plaintextDigest
  ) {
    throw new SourceReplicationError(
      "SourceReplicationStorageIdentityError",
      "Source journal storage identity is invalid",
      false
    );
  }
  const rootPath = resolve(koedHome, "source-journal");
  if (lstatSync(rootPath).isSymbolicLink()) {
    throw new SourceReplicationError(
      "SourceReplicationStorageBoundaryError",
      "Source journal root cannot be a symbolic link",
      false
    );
  }
  const root = realpathSync(rootPath);
  const target = resolve(root, segment.storageKey);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new SourceReplicationError(
      "SourceReplicationStorageBoundaryError",
      "Source journal segment escapes its storage root",
      false
    );
  }
  const descriptor = openSync(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const state = fstatSync(descriptor);
    if (
      !state.isFile() ||
      state.size !== segment.plaintextSize ||
      state.size > maxSegmentBytes
    ) {
      throw new SourceReplicationError(
        "SourceReplicationStorageShapeError",
        "Source journal segment file shape is invalid",
        false
      );
    }
    const bytes = readFileSync(descriptor);
    if (sha256(bytes) !== segment.plaintextDigest) {
      throw new SourceReplicationError(
        "SourceReplicationStorageDigestError",
        "Source journal segment failed digest verification",
        false
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const readSourceSegment = async (
  options: {
    koedHome: string;
    envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  },
  artifact: ConversationSourceArtifactRecord,
  segment: ConversationSourceSegmentRecord
): Promise<Uint8Array> => {
  if (segment.storageProvider === "filesystem") {
    return readFilesystemSourceSegment(options.koedHome, artifact, segment);
  }
  if (
    segment.storageProvider !== "envelope_db" ||
    !options.envelopeEncryptionProvider
  ) {
    throw new SourceReplicationError(
      "SourceReplicationStorageProviderError",
      "Source journal storage provider is unavailable",
      false
    );
  }
  const envelope = await atRestSegment(
    options.envelopeEncryptionProvider,
    segment
  );
  const manifest = envelope.signedManifest.manifest;
  if (
    manifest.segmentIndex !== segment.segmentIndex ||
    manifest.startByteCursor !== segment.sourceStartOffset ||
    manifest.endByteCursor !== segment.sourceEndOffset ||
    manifest.startItemCursor !== segment.sourceStartLine ||
    manifest.endItemCursor !== segment.sourceEndLine ||
    manifest.plaintextDigest !== segment.plaintextDigest ||
    envelope.signedManifest.signature !== segment.originSignature ||
    calculateConversationSourceReplicationManifestDigest(manifest) !==
      segment.manifestDigest ||
    calculateConversationSourceReplicationContentDigest(
      envelope.signedManifest
    ) !== segment.contentDigest
  ) {
    throw new SourceReplicationError(
      "SourceReplicationEnvelopeIdentityError",
      "Source journal envelope identity is invalid",
      false
    );
  }
  const bytes = Buffer.from(envelope.plaintextBytes, "base64url");
  if (
    bytes.toString("base64url") !== envelope.plaintextBytes ||
    bytes.byteLength !== segment.plaintextSize ||
    bytes.byteLength > maxSegmentBytes ||
    createHash("sha256").update(bytes).digest("hex") !== segment.plaintextDigest
  ) {
    throw new SourceReplicationError(
      "SourceReplicationEnvelopeContentError",
      "Source journal envelope content is invalid",
      false
    );
  }
  return bytes;
};

const replicationPackage = async (input: {
  operationId: string;
  operationKind: "register_generation" | "append_segment" | "close_generation";
  target: TargetContext;
  payload: unknown;
}) => {
  const provider = createRecipientPublicKeyEnvelopeEncryptionProvider(
    input.target.recipientKey
  );
  return createEncryptedJsonPackage(provider, {
    objectClass: "sync_package",
    payload: input.payload,
    scope: {
      deploymentId: input.target.targetDeploymentId,
      tenantId: input.target.targetUserId
    },
    provenance: {
      rowFamily: "conversation_source_replication",
      sourceId: input.operationId
    },
    ciphertextLocation: "conversation_source_replication.payload",
    aad: {
      operationId: input.operationId,
      operationKind: input.operationKind,
      protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
      targetDeploymentId: input.target.targetDeploymentId
    },
    metadata: {
      operationKind: input.operationKind,
      protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL
    }
  });
};

export const publishConversationSourceGenerationRegistration = async (input: {
  repository: MemorySourceRepository;
  koedHome: string;
  actor: { userId: string };
  artifact: ConversationSourceArtifactRecord;
  targetUpstreamId: string;
  fetch?: typeof fetch;
  isSourceIdentityHealthy?: () => boolean;
}): Promise<SourceRegistrationResult> => {
  if (
    !(
      input.isSourceIdentityHealthy?.() ??
      inspectDeviceIdentityAtKoedHome({ koedHome: input.koedHome })
        .remoteOperationsAllowed
    )
  ) {
    throw new SourceReplicationError(
      "SourceReplicationIdentityError",
      "Local deployment identity is not allowed to replicate",
      false
    );
  }
  const registry = readLocalEdgeUpstreamRegistry(
    resolve(input.koedHome, "config", "upstream-backends.json")
  );
  const backend = upstreamBackendById(registry, input.targetUpstreamId);
  const reference = backend?.credential?.reference;
  const authorization = readUpstreamCredentialAuthorization(
    input.koedHome,
    reference
  );
  if (
    !backend ||
    backend.routePolicy.sync !== "enabled" ||
    !upstreamAdvertisesCapability(
      backend,
      "memory.conversationSourceReplication"
    ) ||
    !authorization
  ) {
    throw new SourceReplicationError(
      "SourceReplicationTargetUnavailableError",
      "Source replication target is not enabled and enrolled",
      true
    );
  }
  const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
  const context = targetContext(
    await checkedRequest(
      fetchFn,
      upstreamApiUrl(
        backend.baseUrl,
        "/v1/conversation-source-replication/intake/context"
      ),
      authorization,
      {}
    )
  );
  const registration = originKeyRegistration(input.artifact);
  const sourceSession = await input.repository.getCapturedSession(
    input.actor,
    input.artifact.sessionId
  );
  if (!sourceSession) {
    throw new SourceReplicationError(
      "SourceReplicationSessionIdentityError",
      "Conversation source Captured Session is unavailable",
      false
    );
  }
  const source = sourceDescriptor(input.artifact, sourceSession);
  const operationId = input.artifact.id;
  const registrationDigest =
    calculateConversationSourceGenerationRegistrationDigest(
      registration,
      source
    );
  const requestDigest = calculateConversationSourceReplicationOperationDigest({
    operationId,
    operationKind: "register_generation",
    logicalSourceId: input.artifact.logicalSourceId,
    sourceGenerationId: input.artifact.sourceGenerationId,
    contentDigest: registrationDigest,
    targetDeploymentId: context.targetDeploymentId
  });
  await checkedRequest(
    fetchFn,
    upstreamApiUrl(
      backend.baseUrl,
      "/v1/conversation-source-replication/generations"
    ),
    authorization,
    {
      operationId,
      requestDigest,
      encryptedPackage: await replicationPackage({
        operationId,
        operationKind: "register_generation",
        target: context,
        payload: {
          protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
          operation: "register_generation",
          registration,
          source
        }
      })
    }
  );
  return {
    authorization,
    backendBaseUrl: backend.baseUrl,
    context
  };
};

const parserState = (
  value: Record<string, unknown> | undefined
): TranscriptJournalParserState => ({
  ...(typeof value?.lastEventTime === "string"
    ? { lastEventTime: value.lastEventTime }
    : {}),
  ...(typeof value?.activeTurnId === "string"
    ? { activeTurnId: value.activeTurnId }
    : {}),
  ...(value?.assistantMessagePreference === "response_item"
    ? { assistantMessagePreference: "response_item" as const }
    : {})
});

const atRestSegment = async (
  provider: EnvelopeEncryptionProvider,
  segment: ConversationSourceSegmentRecord
) => {
  if (!segment.encryptionEnvelope) {
    throw new SourceReplicationError(
      "SourceReplicationEnvelopeMissingError",
      "Hosted source segment has no encryption envelope",
      false
    );
  }
  const decrypted = await decryptEnvelopeToUtf8(
    provider,
    segment.encryptionEnvelope as unknown as EncryptedPayloadEnvelope
  );
  return parseConversationSourceReplicationSegmentEnvelope(
    JSON.parse(decrypted) as unknown
  );
};

const errorCode = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(error.name)
    ? error.name
    : "SourceReplicationFailure";

const retryAt = (attempt: number): string =>
  new Date(
    Date.now() + Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempt, 8))
  ).toISOString();

const withOutboxLeaseHeartbeat = async <T>(input: {
  repository: MemorySourceRepository;
  actor: { userId: string };
  outboxId: string;
  leaseToken: string;
  operation: () => Promise<T>;
}): Promise<T> => {
  let stopped = false;
  let heartbeatFailure: unknown;
  const heartbeat = async (): Promise<void> => {
    if (stopped) return;
    try {
      await input.repository.renewConversationSourceReplicationOutboxLease(
        input.actor,
        {
          outboxId: input.outboxId,
          leaseToken: input.leaseToken,
          leaseMs: outboxLeaseMs
        }
      );
    } catch (error) {
      heartbeatFailure = error;
    }
  };
  const timer = setInterval(() => void heartbeat(), outboxLeaseHeartbeatMs);
  timer.unref?.();
  try {
    const result = await input.operation();
    if (heartbeatFailure) throw heartbeatFailure;
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
  }
};

const withRestoreLeaseHeartbeat = async <T>(input: {
  repository: MemorySourceRepository;
  workerId: string;
  restoreJobId: string;
  leaseToken: string;
  operation: () => Promise<T>;
}): Promise<T> => {
  let stopped = false;
  let heartbeatFailure: unknown;
  const heartbeat = async (): Promise<void> => {
    if (stopped) return;
    try {
      const renewed =
        await input.repository.renewConversationSourceRestoreJobLease({
          restoreJobId: input.restoreJobId,
          leaseToken: input.leaseToken,
          workerId: input.workerId,
          leaseMs: outboxLeaseMs
        });
      if (!renewed) {
        heartbeatFailure = new SourceReplicationError(
          "SourceRestoreLeaseLostError",
          "Source restore lease was lost",
          true
        );
      }
    } catch (error) {
      heartbeatFailure = error;
    }
  };
  const timer = setInterval(() => void heartbeat(), outboxLeaseHeartbeatMs);
  timer.unref?.();
  try {
    const result = await input.operation();
    if (heartbeatFailure) throw heartbeatFailure;
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
  }
};

export const createConversationSourceReplicationService = (options: {
  repository: MemorySourceRepository;
  koedHome: string;
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  fetch?: typeof fetch;
  wakePool: ReplicationWakePool;
  isSourceIdentityHealthy?: () => boolean;
  logger: Logger | SourceReplicationLogger;
}): ConversationSourceReplicationService => {
  const workerId = randomUUID();
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const registryPath = resolve(
    options.koedHome,
    "config",
    "upstream-backends.json"
  );
  let running = false;
  let runAgain = false;
  let stopped = false;
  let dueTimer: ReturnType<typeof setTimeout> | null = null;
  let processingFailureAttempt = 0;
  let wakeClient: ReplicationWakeClient | null = null;
  let wakeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeReconnectAttempt = 0;

  const uploadClaim = async (
    actor: { userId: string },
    claim: Awaited<
      ReturnType<
        MemorySourceRepository["claimConversationSourceReplicationOutbox"]
      >
    >[number]
  ): Promise<void> => {
    const registration = await publishConversationSourceGenerationRegistration({
      repository: options.repository,
      koedHome: options.koedHome,
      actor,
      artifact: claim.artifact,
      targetUpstreamId: claim.targetUpstreamId,
      fetch: fetchFn,
      ...(options.isSourceIdentityHealthy
        ? { isSourceIdentityHealthy: options.isSourceIdentityHealthy }
        : {})
    });
    const authorization = registration.authorization;
    const context = registration.context;

    if (claim.operationKind === "registration") return;

    if (claim.operationKind === "closure") {
      const signedClosure = parseSignedConversationSourceClosureManifest({
        manifest: claim.artifact.closureManifest,
        signature: claim.artifact.closureSignature
      });
      const artifactClosureDigest =
        calculateConversationSourceClosureDigest(signedClosure);
      const signedSourceSetClosure =
        claim.artifact.sourceComponentId === "main"
          ? claim.artifact.sourceSetClosureManifest &&
            claim.artifact.sourceSetClosureSignature
            ? parseSignedConversationSourceSetClosureManifest({
                manifest: claim.artifact.sourceSetClosureManifest,
                signature: claim.artifact.sourceSetClosureSignature
              })
            : null
          : null;
      if (
        claim.artifact.sourceComponentId === "main" &&
        !signedSourceSetClosure
      ) {
        throw new SourceReplicationError(
          "SourceReplicationSourceSetPendingError",
          "Conversation source-set closure is not ready",
          true
        );
      }
      const sourceSetClosureDigest = signedSourceSetClosure
        ? calculateConversationSourceSetClosureDigest(signedSourceSetClosure)
        : null;
      const contentDigest =
        calculateConversationSourceClosureOperationContentDigest(
          artifactClosureDigest,
          sourceSetClosureDigest
        );
      if (
        claim.artifact.lifecycle !== "finalized" ||
        artifactClosureDigest !== claim.artifact.closureHash ||
        (signedSourceSetClosure &&
          sourceSetClosureDigest !== claim.artifact.sourceSetClosureHash)
      ) {
        throw new SourceReplicationError(
          "SourceReplicationClosureDigestError",
          "Persisted source closure identity is invalid",
          false
        );
      }
      const requestDigest =
        calculateConversationSourceReplicationOperationDigest({
          operationId: claim.id,
          operationKind: "close_generation",
          logicalSourceId: claim.artifact.logicalSourceId,
          sourceGenerationId: claim.artifact.sourceGenerationId,
          contentDigest,
          targetDeploymentId: context.targetDeploymentId
        });
      await checkedRequest(
        fetchFn,
        upstreamApiUrl(
          registration.backendBaseUrl,
          `/v1/conversation-source-replication/generations/${claim.artifact.sourceGenerationId}/closure`
        ),
        authorization,
        {
          operationId: claim.id,
          requestDigest,
          encryptedPackage: await replicationPackage({
            operationId: claim.id,
            operationKind: "close_generation",
            target: context,
            payload: {
              protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
              operation: "close_generation",
              closure: signedClosure,
              sourceSetClosure: signedSourceSetClosure
            }
          })
        }
      );
      return;
    }
    if (!claim.segment) {
      throw new SourceReplicationError(
        "SourceReplicationSegmentMissingError",
        "Source replication segment is unavailable",
        false
      );
    }
    const signedManifest = {
      manifest: claim.segment.signedManifest,
      signature: claim.segment.originSignature
    };
    const bytes = await readSourceSegment(
      options,
      claim.artifact,
      claim.segment
    );
    const contentDigest = calculateConversationSourceReplicationContentDigest(
      signedManifest as never
    );
    if (contentDigest !== claim.segment.contentDigest) {
      throw new SourceReplicationError(
        "SourceReplicationManifestDigestError",
        "Persisted signed manifest identity is invalid",
        false
      );
    }
    const requestDigest = calculateConversationSourceReplicationOperationDigest(
      {
        operationId: claim.id,
        operationKind: "append_segment",
        logicalSourceId: claim.artifact.logicalSourceId,
        sourceGenerationId: claim.artifact.sourceGenerationId,
        contentDigest,
        targetDeploymentId: context.targetDeploymentId
      }
    );
    const response = await checkedRequest(
      fetchFn,
      upstreamApiUrl(
        registration.backendBaseUrl,
        `/v1/conversation-source-replication/generations/${claim.artifact.sourceGenerationId}/segments`
      ),
      authorization,
      {
        operationId: claim.id,
        requestDigest,
        encryptedPackage: await replicationPackage({
          operationId: claim.id,
          operationKind: "append_segment",
          target: context,
          payload: {
            protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
            operation: "append_segment",
            segment: {
              signedManifest,
              plaintextBytes: Buffer.from(bytes).toString("base64url")
            }
          }
        })
      }
    );
    if (response.status !== "accepted" && response.status !== "replayed") {
      throw new SourceReplicationError(
        response.status === "gap"
          ? "SourceReplicationGapError"
          : "SourceReplicationQuarantineError",
        "Target did not accept the source segment",
        response.status === "gap"
      );
    }
  };

  const materializeArtifact = async (
    actor: { userId: string },
    artifact: ConversationSourceArtifactRecord
  ): Promise<boolean> => {
    const provider = options.envelopeEncryptionProvider;
    if (!provider) return false;
    const cursor = await options.repository.getConversationSourceConsumerCursor(
      actor,
      {
        artifactId: artifact.id,
        consumerKind: "remote_processing"
      }
    );
    const startOffset = cursor?.sourceOffset ?? artifact.journalStartOffset;
    const startLine = cursor?.sourceLine ?? artifact.journalStartLine;
    const segments = await options.repository.listConversationSourceSegments(
      actor,
      {
        artifactId: artifact.id,
        afterOffset: startOffset,
        limit: 16
      }
    );
    if (segments.length === 0) return false;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const segment of segments) {
      const envelope = await atRestSegment(provider, segment);
      const full = Buffer.from(envelope.plaintextBytes, "base64url");
      const sliceStart = Math.max(0, startOffset - segment.sourceStartOffset);
      const chunk = full.subarray(sliceStart);
      total += chunk.byteLength;
      if (total > maxMaterializationBytes) break;
      chunks.push(chunk);
    }
    if (chunks.length === 0) return false;
    const sourceSession = await options.repository.getCapturedSession(
      actor,
      artifact.sessionId
    );
    if (!sourceSession) {
      throw new SourceReplicationError(
        "SourceReplicationSessionIdentityError",
        "Materialized source Captured Session is unavailable",
        false
      );
    }
    const materializedBytes = Buffer.concat(chunks);
    const claudeSource =
      artifact.sourceAdapterVersion === "claude-code-transcript-v1";
    const claudeParsed = claudeSource
      ? parseClaudeTranscriptJournalBytes({
          bytes: materializedBytes,
          absoluteStartOffset: startOffset,
          lineIndexOffset: startLine,
          sessionId: artifact.sessionId,
          externalSessionId: artifact.externalSessionId,
          sourceFingerprint: artifact.sourceFingerprint,
          sourceComponentId: artifact.sourceComponentId,
          prior: cursor?.parserState as { currentTurnId?: string } | undefined
        })
      : null;
    const codexParsed = claudeSource
      ? null
      : parseTranscriptJournalBytes({
          bytes: materializedBytes,
          absoluteStartOffset: startOffset,
          lineIndexOffset: startLine,
          prior: parserState(cursor?.parserState)
        });
    const checkpoint = (claudeParsed ?? codexParsed)!.checkpoint;
    if (checkpoint.offset <= startOffset) return false;
    const transcriptContext = codexParsed
      ? extractTranscriptSessionMetadata(codexParsed.records)
      : null;
    const transcriptCwd =
      typeof transcriptContext?.transcriptMetadata.cwd === "string"
        ? transcriptContext.transcriptMetadata.cwd
        : undefined;
    const transcriptModel =
      typeof transcriptContext?.transcriptMetadata.model === "string"
        ? transcriptContext.transcriptMetadata.model
        : undefined;
    await options.repository.createCapturedSession(actor, {
      logicalSessionId: sourceSession.logicalSessionId,
      externalSessionId: artifact.externalSessionId,
      sourceRuntime: artifact.sourceRuntime,
      captureMethod: "transcript",
      model: transcriptModel,
      sourceKind: artifact.sourceKind,
      sourceAdapterVersion: artifact.sourceAdapterVersion,
      sourceFingerprint: artifact.sourceFingerprint,
      metadata: {
        sourceTransport: "replicated_transcript",
        sourceReplication: {
          logicalSourceId: artifact.logicalSourceId,
          sourceGenerationId: artifact.sourceGenerationId,
          originDeploymentId: artifact.originDeploymentId,
          originDeviceId: artifact.originDeviceId
        },
        ...(transcriptCwd ? { sourceDeviceCwdObserved: true } : {})
      }
    });
    const containing = segments.find(
      (segment) =>
        segment.sourceStartOffset < checkpoint.offset &&
        segment.sourceEndOffset >= checkpoint.offset
    );
    if (!containing) {
      throw new SourceReplicationError(
        "SourceReplicationCursorBoundaryError",
        "Materialized cursor does not bind to an accepted segment",
        false
      );
    }
    const items =
      claudeParsed?.items ??
      buildCodexTranscriptConversationItems({
        records: codexParsed!.records,
        indexOffset: codexParsed!.indexOffset,
        sessionId: artifact.sessionId,
        sourceSessionId: artifact.externalSessionId,
        sourceTransport: "transcript",
        sourceFingerprint: artifact.sourceFingerprint,
        threadKind: "conversation"
      });
    if (items.length > 0) {
      await options.repository.createConversationItems(actor, {
        items: items as ConversationItemInput[]
      });
    }
    await options.repository.advanceConversationSourceConsumerCursor(actor, {
      artifactId: artifact.id,
      consumerKind: "remote_processing",
      expectedSourceOffset: startOffset,
      sourceOffset: checkpoint.offset,
      sourceLine: checkpoint.lineCount,
      segmentIndex: containing.segmentIndex,
      lastVerifiedDigest: containing.plaintextDigest,
      parserState: claudeParsed?.parserState ?? {
        ...(codexParsed!.checkpoint.lastEventTime
          ? { lastEventTime: codexParsed!.checkpoint.lastEventTime }
          : {}),
        ...(codexParsed!.checkpoint.activeTurnId
          ? { activeTurnId: codexParsed!.checkpoint.activeTurnId }
          : {}),
        ...(codexParsed!.checkpoint.assistantMessagePreference
          ? {
              assistantMessagePreference:
                codexParsed!.checkpoint.assistantMessagePreference
            }
          : {})
      }
    });
    return true;
  };

  const restoreClaim = async (
    actor: { userId: string },
    claim: ClaimedConversationSourceRestoreJob
  ): Promise<void> => {
    const root = options.envelopeEncryptionProvider;
    if (
      !root ||
      !claim.leaseToken ||
      !claim.remoteAuthorizationId ||
      !claim.registration ||
      !claim.sourceDescriptor ||
      claim.lastSegmentIndex === null
    ) {
      throw new SourceReplicationError(
        "SourceRestoreStateError",
        "Source restore state is incomplete",
        false
      );
    }
    const registration = parseConversationSourceOriginKeyRegistration(
      claim.registration
    );
    const source = parseConversationSourceReplicationSourceDescriptor(
      claim.sourceDescriptor
    );
    const sourceClosure = claim.sourceClosure
      ? parseSignedConversationSourceClosureManifest(claim.sourceClosure)
      : null;
    if (
      registration.sourceGenerationId !== claim.sourceGenerationId ||
      (sourceClosure !== null &&
        sourceClosure.manifest.sourceGenerationId !==
          claim.sourceGenerationId) ||
      registration.lifecycle !== "active"
    ) {
      throw new SourceReplicationError(
        "SourceRestoreIdentityError",
        "Source restore identity is invalid",
        false
      );
    }
    const registry = readLocalEdgeUpstreamRegistry(registryPath);
    const backend = upstreamBackendById(registry, claim.upstreamBackendId);
    const reference = backend?.credential?.reference;
    const authorization = readUpstreamCredentialAuthorization(
      options.koedHome,
      reference
    );
    if (
      !backend ||
      backend.routePolicy.sync !== "enabled" ||
      !upstreamAdvertisesCapability(
        backend,
        "memory.conversationSourceReplication"
      ) ||
      !authorization
    ) {
      throw new SourceReplicationError(
        "SourceRestoreBackendUnavailableError",
        "Source restore backend is not enabled and enrolled",
        true
      );
    }
    const localDeployment = await options.repository.getLocalSyncDeployment();
    if (
      !localDeployment ||
      localDeployment.protocolDeploymentId !== claim.targetDeploymentId
    ) {
      throw new SourceReplicationError(
        "SourceRestoreRecipientIdentityError",
        "Source restore deployment identity changed",
        false
      );
    }
    const recipientMaterial = await options.repository.getSyncRecipientKey(
      localDeployment.id,
      claim.recipientKeyId,
      claim.recipientKeyVersion
    );
    if (!recipientMaterial) {
      throw new SourceReplicationError(
        "SourceRestoreRecipientKeyError",
        "Source restore recipient key is unavailable",
        false
      );
    }
    const recipientProvider =
      await createRecipientPrivateKeyEnvelopeEncryptionProvider(
        root,
        recipientMaterial
      );
    const { artifact } =
      await options.repository.ensureConversationSourceArtifactForCapturedSession(
        actor,
        {
          session: {
            logicalSessionId: source.logicalSessionId,
            externalSessionId: source.externalSessionId,
            forkedFromExternalThreadId:
              source.forkedFromExternalThreadId ?? undefined,
            sourceRuntime: source.sourceRuntime,
            captureMethod: "transcript",
            sourceKind: source.sourceKind,
            sourceAdapterVersion: source.sourceAdapterVersion,
            sourceFingerprint: source.sourceFingerprint,
            idempotencyKey: `peer-source:${registration.logicalSourceId}:${registration.sourceGenerationId}`,
            sourceHash: `peer-source:${registration.sourceGenerationId}`,
            ...(source.project ? { projectId: source.project.id } : {}),
            metadata: {
              sourceReplication: {
                protocol: registration.protocol,
                logicalSourceId: registration.logicalSourceId,
                sourceGenerationId: registration.sourceGenerationId
              }
            },
            ...(source.project
              ? {
                  detectedProjects: [
                    {
                      id: source.project.id,
                      name: source.project.name,
                      path: null
                    }
                  ]
                }
              : {})
          },
          artifact: {
            logicalSourceId: registration.logicalSourceId,
            sourceGenerationId: registration.sourceGenerationId,
            replicaRole: "peer_personal",
            sourceKind: source.sourceKind,
            sourceRuntime: source.sourceRuntime,
            externalSessionId: source.externalSessionId,
            sourceFingerprint: source.sourceFingerprint,
            artifactFormat: source.artifactFormat,
            artifactFormatVersion: source.artifactFormatVersion,
            sourceAdapterVersion: source.sourceAdapterVersion,
            journalStartOffset: source.journalStartOffset,
            journalStartLine: source.journalStartLine,
            liveStartOffset: source.liveStartOffset,
            liveStartLine: source.liveStartLine,
            currentSourceLength: Math.max(
              source.journalStartOffset,
              source.liveStartOffset
            ),
            sourceCreatedAt: registration.sourceCreatedAt,
            storageProvider: "envelope_db",
            storagePrefix: `${registration.logicalSourceId}/${registration.sourceGenerationId}`,
            originDeploymentId: source.originDeploymentId,
            originDeviceId: source.originDeviceId,
            originKeyId: registration.originKeyId,
            originPublicKey: registration.publicKey,
            ...(registration.priorGenerationClosure
              ? {
                  priorGenerationClosure:
                    registration.priorGenerationClosure as unknown as Record<
                      string,
                      unknown
                    >
                }
              : {}),
            redactedSourceLabel: source.redactedSourceLabel
          }
        }
      );

    let nextSegmentIndex = claim.nextSegmentIndex;
    while (nextSegmentIndex <= claim.lastSegmentIndex) {
      const pageUrl = upstreamApiUrl(
        backend.baseUrl,
        `/v1/conversation-source-replication/download-authorizations/${claim.remoteAuthorizationId}/segments`
      );
      pageUrl.searchParams.set(
        "afterSegmentIndex",
        String(nextSegmentIndex - 1)
      );
      pageUrl.searchParams.set("limit", "1");
      const page = exactRecord(
        await checkedDownloadPage(
          fetchFn,
          pageUrl,
          authorization,
          claim.capability
        ),
        ["authorizationId", "packages", "nextSegmentIndex", "complete"],
        "Source restore page"
      );
      if (
        page.authorizationId !== claim.remoteAuthorizationId ||
        !Array.isArray(page.packages) ||
        page.packages.length !== 1
      ) {
        throw new SourceReplicationError(
          "SourceRestorePageIdentityError",
          "Source restore page identity is invalid",
          false
        );
      }
      const entry = exactRecord(
        page.packages[0],
        ["segmentIndex", "encryptedPackage"],
        "Source restore package"
      );
      if (
        typeof entry.segmentIndex !== "number" ||
        !Number.isSafeInteger(entry.segmentIndex) ||
        entry.segmentIndex !== nextSegmentIndex
      ) {
        throw new SourceReplicationError(
          "SourceRestoreSequenceError",
          "Source restore segment sequence is invalid",
          false
        );
      }
      const encryptedPackage = entry.encryptedPackage as EncryptedJsonPackage;
      if (
        !encryptedPackage?.manifest ||
        !encryptedPackage.envelope ||
        encryptedPackage.manifest.objectClass !== "sync_package" ||
        encryptedPackage.envelope.scope.deploymentId !==
          claim.targetDeploymentId ||
        encryptedPackage.envelope.aad.authorizationId !==
          claim.remoteAuthorizationId ||
        encryptedPackage.envelope.aad.segmentIndex !==
          String(nextSegmentIndex) ||
        encryptedPackage.envelope.aad.targetDeploymentId !==
          claim.targetDeploymentId
      ) {
        throw new SourceReplicationError(
          "SourceRestoreEnvelopeBindingError",
          "Source restore envelope binding is invalid",
          false
        );
      }
      const payload = exactRecord(
        await decryptEncryptedJsonPackage(recipientProvider, encryptedPackage),
        ["protocol", "operation", "segment"],
        "Source restore payload"
      );
      if (
        payload.protocol !== CONVERSATION_SOURCE_REPLICATION_PROTOCOL ||
        payload.operation !== "download_segment"
      ) {
        throw new SourceReplicationError(
          "SourceRestoreProtocolError",
          "Source restore protocol operation is invalid",
          false
        );
      }
      const segment = parseConversationSourceReplicationSegmentEnvelope(
        payload.segment
      );
      const { manifest } = segment.signedManifest;
      if (
        manifest.segmentIndex !== nextSegmentIndex ||
        manifest.logicalSourceId !== registration.logicalSourceId ||
        manifest.sourceGenerationId !== registration.sourceGenerationId ||
        !verifyConversationSourceReplicationManifestForAcceptance(
          segment.signedManifest,
          registration
        )
      ) {
        throw new SourceReplicationError(
          "SourceRestoreSignatureError",
          "Source restore origin signature is invalid",
          false
        );
      }
      const bytes = Buffer.from(segment.plaintextBytes, "base64url");
      assertConversationSourceReplicationJsonlSegment(
        bytes,
        manifest.endItemCursor - manifest.startItemCursor
      );
      const contentDigest = calculateConversationSourceReplicationContentDigest(
        segment.signedManifest
      );
      const atRestEnvelope = await root.encrypt({
        plaintext: JSON.stringify(segment),
        scope: {
          tenantId: actor.userId,
          objectClass: "conversation_source_segment"
        },
        provenance: {
          rowFamily: "conversation_source_segments",
          sourceId: `${artifact.id}:${manifest.segmentIndex}`
        },
        ciphertextLocation: "conversation_source_segments.encryption_envelope",
        aad: {
          ownerUserId: actor.userId,
          logicalSourceId: manifest.logicalSourceId,
          sourceGenerationId: manifest.sourceGenerationId,
          segmentIndex: manifest.segmentIndex,
          contentDigest
        }
      });
      const acceptance =
        await options.repository.acceptConversationSourceReplicaSegment(actor, {
          artifactId: artifact.id,
          segmentIndex: manifest.segmentIndex,
          sourceStartOffset: manifest.startByteCursor,
          sourceEndOffset: manifest.endByteCursor,
          sourceStartLine: manifest.startItemCursor,
          sourceEndLine: manifest.endItemCursor,
          plaintextDigest: manifest.plaintextDigest,
          ciphertextDigest: sha256(
            Buffer.from(atRestEnvelope.ciphertext, "base64")
          ),
          plaintextSize: bytes.byteLength,
          storedSize: Buffer.byteLength(JSON.stringify(atRestEnvelope), "utf8"),
          storageKey: `${manifest.logicalSourceId}/${manifest.sourceGenerationId}/${manifest.segmentIndex}`,
          storageProvider: "envelope_db",
          encryptionEnvelope: atRestEnvelope as unknown as Record<
            string,
            unknown
          >,
          signedManifest: { ...manifest },
          originSignature: segment.signedManifest.signature,
          manifestDigest:
            calculateConversationSourceReplicationManifestDigest(manifest),
          previousContentDigest: manifest.previousContentDigest,
          contentDigest,
          currentSourceLength: manifest.endByteCursor
        });
      if (
        acceptance.status !== "accepted" &&
        acceptance.status !== "replayed"
      ) {
        throw new SourceReplicationError(
          acceptance.status === "gap"
            ? "SourceRestoreGapError"
            : "SourceRestoreQuarantineError",
          "Source restore segment was not accepted",
          acceptance.status === "gap"
        );
      }
      nextSegmentIndex += 1;
      await options.repository.advanceConversationSourceRestoreJob(actor, {
        restoreJobId: claim.id,
        leaseToken: claim.leaseToken,
        nextSegmentIndex,
        state: "downloading"
      });
      if (
        typeof page.complete !== "boolean" ||
        !Number.isSafeInteger(page.nextSegmentIndex) ||
        page.nextSegmentIndex !== manifest.segmentIndex ||
        (page.complete && nextSegmentIndex <= claim.lastSegmentIndex)
      ) {
        throw new SourceReplicationError(
          "SourceRestorePageCursorError",
          "Source restore page cursor is invalid",
          false
        );
      }
    }
    if (sourceClosure) {
      await options.repository.finalizeConversationSourceArtifact(actor, {
        artifactId: artifact.id,
        signedClosure: sourceClosure
      });
    }
    await options.repository.advanceConversationSourceRestoreJob(actor, {
      restoreJobId: claim.id,
      leaseToken: claim.leaseToken,
      nextSegmentIndex,
      state: "materializing"
    });
    while (await materializeArtifact(actor, artifact)) {
      // Materialization is bounded per pass and advances a verified cursor.
    }
    await options.repository.completeConversationSourceRestoreJob(actor, {
      restoreJobId: claim.id,
      leaseToken: claim.leaseToken
    });
  };

  const processOnce = async () => {
    let uploaded = 0;
    let restored = 0;
    let materialized = 0;
    const restoreClaims =
      await options.repository.claimConversationSourceRestoreJobs({
        workerId,
        leaseMs: outboxLeaseMs,
        limit: 4
      });
    for (const claim of restoreClaims) {
      const actor = { userId: claim.ownerUserId };
      try {
        await withRestoreLeaseHeartbeat({
          repository: options.repository,
          workerId,
          restoreJobId: claim.id,
          leaseToken: claim.leaseToken!,
          operation: () => restoreClaim(actor, claim)
        });
        restored += 1;
      } catch (error) {
        const transient =
          error instanceof SourceReplicationError && error.transient;
        await options.repository.failConversationSourceRestoreJob(actor, {
          restoreJobId: claim.id,
          leaseToken: claim.leaseToken!,
          errorCode: errorCode(error),
          retry: transient,
          retryAt: retryAt(claim.attempts)
        });
        options.logger.warn(
          {
            event: {
              name: "worker.source_replication.restore_failed",
              category: "source_replication"
            },
            error_name: errorCode(error)
          },
          "conversation source restore failed"
        );
      }
    }
    for (const actor of await options.repository.listConversationSourceReplicationActors(
      { direction: "upload", limit: 25 }
    )) {
      const claims =
        await options.repository.claimConversationSourceReplicationOutbox(
          actor,
          { workerId, leaseMs: outboxLeaseMs, limit: 8 }
        );
      for (const claim of claims) {
        try {
          await withOutboxLeaseHeartbeat({
            repository: options.repository,
            actor,
            outboxId: claim.id,
            leaseToken: claim.leaseToken!,
            operation: () => uploadClaim(actor, claim)
          });
          await options.repository.completeConversationSourceReplicationOutbox(
            actor,
            {
              outboxId: claim.id,
              leaseToken: claim.leaseToken!
            }
          );
          uploaded += 1;
        } catch (error) {
          await options.repository.failConversationSourceReplicationOutbox(
            actor,
            {
              outboxId: claim.id,
              leaseToken: claim.leaseToken!,
              errorCode: errorCode(error),
              retryAt: retryAt(claim.attempts),
              quarantine:
                error instanceof SourceReplicationError && !error.transient
            }
          );
          options.logger.warn(
            {
              event: {
                name: "worker.source_replication.upload_failed",
                category: "source_replication"
              },
              error_name: errorCode(error)
            },
            "conversation source replication upload failed"
          );
        }
      }
    }
    for (const actor of await options.repository.listConversationSourceReplicationActors(
      { direction: "materialize", limit: 25 }
    )) {
      const artifacts =
        await options.repository.listConversationSourceArtifactsForDownload(
          actor,
          { limit: 25 }
        );
      for (const artifact of artifacts) {
        try {
          if (await materializeArtifact(actor, artifact)) materialized += 1;
        } catch (error) {
          const transient =
            !(error instanceof SourceReplicationError) || error.transient;
          const cursor =
            await options.repository.getConversationSourceConsumerCursor(
              actor,
              {
                artifactId: artifact.id,
                consumerKind: "remote_processing"
              }
            );
          await options.repository.recordConversationSourceConsumerFailure(
            actor,
            {
              artifactId: artifact.id,
              consumerKind: "remote_processing",
              errorCode: errorCode(error),
              retryAt: transient ? retryAt((cursor?.retryCount ?? 0) + 1) : null
            }
          );
          options.logger.warn(
            {
              event: {
                name: "worker.source_replication.materialization_failed",
                category: "source_replication"
              },
              error_name: errorCode(error)
            },
            "conversation source replica materialization failed"
          );
        }
      }
    }
    return { uploaded, restored, materialized };
  };

  const scheduleDueWake = async (): Promise<void> => {
    if (stopped) return;
    const wakeAt =
      await options.repository.getConversationSourceReplicationWakeAt();
    if (dueTimer) clearTimeout(dueTimer);
    dueTimer = null;
    if (!wakeAt) return;
    const delayMs = Math.max(0, Date.parse(wakeAt) - Date.now());
    dueTimer = setTimeout(
      () => {
        dueTimer = null;
        requestProcessing();
      },
      Math.min(delayMs, 2_147_000_000)
    );
    dueTimer.unref?.();
  };

  const requestProcessing = () => {
    if (stopped) return;
    if (running) {
      runAgain = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        runAgain = false;
        const processed = await processOnce();
        if (
          processed.uploaded + processed.restored + processed.materialized >
          0
        ) {
          runAgain = true;
        }
      } while (!stopped && runAgain);
      await scheduleDueWake();
      processingFailureAttempt = 0;
    })()
      .catch((error) => {
        options.logger.warn(
          {
            event: {
              name: "worker.source_replication.drain_failed",
              category: "source_replication"
            },
            error_name: errorCode(error)
          },
          "conversation source replication drain failed"
        );
        if (!stopped && !dueTimer) {
          const delayMs = Math.min(250 * 2 ** processingFailureAttempt, 10_000);
          processingFailureAttempt += 1;
          dueTimer = setTimeout(() => {
            dueTimer = null;
            requestProcessing();
          }, delayMs);
          dueTimer.unref?.();
        }
      })
      .finally(() => {
        running = false;
        if (!stopped && runAgain) requestProcessing();
      });
  };

  const scheduleWakeReconnect = () => {
    if (stopped || wakeReconnectTimer) return;
    const delayMs = Math.min(250 * 2 ** wakeReconnectAttempt, 10_000);
    wakeReconnectAttempt += 1;
    wakeReconnectTimer = setTimeout(() => {
      wakeReconnectTimer = null;
      void connectWakeClient();
    }, delayMs);
    wakeReconnectTimer.unref?.();
  };

  const connectWakeClient = async (): Promise<void> => {
    if (stopped || wakeClient) return;
    try {
      const client = await options.wakePool.connect();
      if (stopped) {
        client.release();
        return;
      }
      wakeClient = client;
      await client.query("listen koed_conversation_source_replication");
      wakeReconnectAttempt = 0;
      client.on("notification", (message) => {
        if (message.channel === "koed_conversation_source_replication") {
          requestProcessing();
        }
      });
      client.on("error", () => {
        if (wakeClient === client) wakeClient = null;
        client.removeAllListeners();
        client.release();
        scheduleWakeReconnect();
      });
      requestProcessing();
    } catch {
      scheduleWakeReconnect();
    }
  };

  return {
    processOnce,
    start() {
      if (stopped || wakeClient || wakeReconnectTimer) return;
      void connectWakeClient();
      requestProcessing();
    },
    async stop() {
      stopped = true;
      if (dueTimer) clearTimeout(dueTimer);
      dueTimer = null;
      if (wakeReconnectTimer) clearTimeout(wakeReconnectTimer);
      wakeReconnectTimer = null;
      if (wakeClient) {
        const client = wakeClient;
        wakeClient = null;
        client.removeAllListeners();
        await client
          .query("unlisten koed_conversation_source_replication")
          .catch(() => undefined);
        client.release();
      }
    }
  };
};
