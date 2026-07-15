import { createHash } from "node:crypto";

export {
  fetchWithTimeout,
  fetchBoundedJsonObject,
  readBoundedJsonObject,
  RemoteRequestTimeoutError,
  RemoteResponseLimitError,
  upstreamApiUrl
} from "./bounded-http.js";
export {
  API_DATA_ENCRYPTION_KEY_ENV,
  createByokEnvelopeEncryptionProvider,
  createCmekEnvelopeEncryptionProvider,
  createEnvelopeEncryptionProviderFromEnvironment,
  createHttpManagedKmsKeyring,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createManagedKmsEnvelopeEncryptionProvider,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  createUnsupportedEnvelopeEncryptionProvider,
  DATA_ENCRYPTION_KEY_ENV_ALIAS,
  decryptEnvelopeToUtf8,
  ENCRYPTED_PAYLOAD_ALGORITHM,
  ENCRYPTED_PAYLOAD_ENVELOPE_VERSION,
  ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM,
  ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM,
  ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM,
  ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM,
  envelopeEncryptionProviderModes,
  EnvelopeEncryptionError,
  generateRecipientKeyMaterial,
  InvalidEncryptedPayloadEnvelopeError,
  ManagedKmsProviderError,
  RECIPIENT_PUBLIC_KEY_PROVIDER_MODE,
  RECIPIENT_RSA_JWK_ALGORITHM,
  RECIPIENT_RSA_KEY_BITS,
  redactEnvelopeEncryptionProviderStatus,
  requireApiDataEncryptionKey,
  resolveApiDataEncryptionKeyFromEnv,
  RecipientKeyTransportError,
  toRecipientPublicKeyMaterial,
  UnsupportedEnvelopeEncryptionProviderError,
  validateEnvelopeEncryptionProviderEnvironment
} from "./envelope-encryption.js";
export {
  createEncryptedJsonPackage,
  decryptEncryptedJsonPackage,
  ENCRYPTED_PACKAGE_MANIFEST_VERSION,
  encryptedPackageObjectClasses
} from "./encrypted-package.js";
export {
  assertSecureHttpTransport,
  isLoopbackHostname
} from "./http-transport-security.js";
export {
  createPlatformHostProofStore,
  deviceIdentitySchemaVersion,
  deviceIdentityStatePathFor,
  deviceProofFingerprint,
  hostProofReferenceFor,
  inspectDeviceIdentity,
  inspectDeviceIdentityAtKoedHome,
  parseDeviceIdentityState,
  serializeHostProof
} from "./device-identity.js";
export type {
  DeviceIdentityHealth,
  DeviceIdentityInspection,
  DeviceIdentityState,
  HostProofReadResult,
  HostProofStore
} from "./device-identity.js";
export {
  deriveLocalProjectId,
  hmacProjectValue,
  isPortableGitRemote,
  mergeGitRemoteAliases,
  normalizeGitRemoteUrl,
  normalizeProjectDisplayName,
  safeProjectMetadataForRemote
} from "./project-metadata.js";
export {
  deleteLocalEdgeClientCredential,
  deleteUpstreamCredentialSecret,
  localEdgeClientCredentialReferenceFor,
  parseUpstreamCredentialReference,
  readLocalEdgeClientCredentialAuthorization,
  readUpstreamCredentialAuthorization,
  storeLocalEdgeClientCredential,
  storeUpstreamCredentialSecret,
  upstreamCredentialReferenceFor,
  verifyLocalEdgeClientCredentialAuthorization
} from "./upstream-credential-store.js";
export type {
  EncryptedPayloadEnvelope,
  EncryptedPayloadProvenance,
  EncryptedPayloadScope,
  EnvelopeEncryptionProviderStatus,
  EnvelopeEncryptionProvider,
  EnvelopeEncryptionProviderMode,
  EnvelopeEncryptionRootProviderMode,
  EncryptPayloadInput,
  EnvelopeEncryptionProviderEnvironmentOptions,
  EnvelopeEncryptionEnvironmentValidationOptions,
  HttpManagedKmsKeyringConfig,
  GenerateRecipientKeyMaterialInput,
  ManagedKmsKeyring,
  ManagedKmsUnwrapDekInput,
  ManagedKmsWrapDekInput,
  ManagedKmsWrappedDek,
  RecipientKeyMaterial,
  RecipientPublicJwk,
  RecipientPublicKeyMaterial,
  WrappedDataEncryptionKey
} from "./envelope-encryption.js";
export type {
  CreateEncryptedJsonPackageInput,
  EncryptedJsonPackage,
  EncryptedPackageManifest,
  EncryptedPackageObjectClass
} from "./encrypted-package.js";
export {
  PDS_PROTOCOL,
  PDS_CERTIFICATE_CLOCK_SKEW_MS,
  PDS_CERTIFICATE_MAX_LIFETIME_MS,
  assertEpochAdvance,
  certificateIsPdsValid,
  decodePdsBase64url,
  pdsEd25519PrivateKey,
  pdsEd25519PublicKey,
  pdsFinalizedStatementHash,
  pdsPublicKeyCommitment,
  pdsSha256,
  signPdsGroupDraft,
  signPdsGroupFinal,
  signPdsRecord,
  signPdsTwoStageFinal,
  validatePdsGroupStatement,
  validatePdsKeyBundle,
  validatePdsEpochAck,
  validatePdsKeyBundleAck,
  validatePdsKeyBundleMetadata,
  verifyPdsEnrollmentProof
} from "./personal-device-sync.js";
export type {
  PdsGroupStatement,
  PdsSignature
} from "./personal-device-sync.js";
export {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  parsePdsUint64,
  pdsUint64be
} from "./personal-device-sync-jcs.js";
export {
  PDS_SESSION_PACKAGE_VERSION,
  PDS_SESSION_PACKAGE_MAX_BYTES,
  PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES,
  PDS_SESSION_PACKAGE_MAX_CHUNKS,
  PDS_SESSION_PACKAGE_MAX_CONTROL_BYTES,
  PDS_SESSION_PACKAGE_MAX_JSON_BYTES,
  classifyPdsSessionPackageReplay,
  createPdsSessionManifest,
  createPdsSessionPackage,
  parsePdsSessionManifestJson,
  parsePdsSessionPackageJson,
  pdsDeletionFloorToken,
  pdsLogicalMemoryId,
  pdsProjectAliasToken,
  pdsSessionPackageDigest,
  pdsSessionPackageReplayEntry,
  pdsSourceFingerprint,
  retainPdsSessionPackage,
  retryPdsSessionPackage,
  rewrapPdsSessionPackage,
  validatePdsConversationSourceItem,
  validatePdsSessionManifest,
  validatePdsSessionPackage,
  verifyAndDecryptPdsSessionPackage,
  verifyPdsSessionManifest
} from "./personal-device-session-package.js";
export type {
  CreatePdsSessionManifestInput,
  CreatePdsSessionPackageInput,
  PdsClosedSessionMetadata,
  PdsConversationSourceItem,
  PdsProjectAliasManifest,
  PdsRetainedSessionPackage,
  PdsSessionManifest,
  PdsSessionPackage,
  PdsSessionPackageChunk,
  PdsSessionPackageReplayEntry,
  PdsSessionPackageReplayResult,
  PdsSessionPackageHeader,
  PdsSessionRecipient,
  PdsSessionRecipientEnvelope,
  PdsRawSourceRecord,
  VerifyPdsSessionPackageInput
} from "./personal-device-session-package.js";
export {
  CAPTURED_SESSION_SYNC_FORMAT,
  CAPTURED_SESSION_SYNC_FORMAT_VERSION,
  CAPTURED_SESSION_SYNC_MAX_CHANGES,
  CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES,
  CAPTURED_SESSION_SYNC_MAX_CHUNKS,
  CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS,
  CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES,
  CAPTURED_SESSION_SYNC_MAX_CONTRIBUTORS_PER_EVENT,
  CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES,
  CAPTURED_SESSION_SYNC_POLICY_VERSION,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  crossIdentitySyncPackageRequestHash,
  isCapturedSessionSyncChunkV1,
  isCapturedSessionSyncPackageV1
} from "./cross-identity-sync.js";
export type {
  CapturedSessionSyncChangeOperation,
  CapturedSessionSyncChangeV1,
  CapturedSessionSyncChunkV1,
  CapturedSessionSyncContributorV1,
  CapturedSessionSyncEventV1,
  CapturedSessionSyncPackageV1
} from "./cross-identity-sync.js";
export type {
  NormalizedGitRemote,
  ProjectMetadataV1,
  ProjectPackageMetadata
} from "./project-metadata.js";
export type {
  LocalEdgeClientCredentialAuthorization,
  LocalEdgeClientCredentialInput,
  UpstreamCredentialSecretInput,
  UpstreamCredentialSecretStoreDeps
} from "./upstream-credential-store.js";

export type HealthStatus = "ok" | "degraded" | "error";

export const memoryEmbedQueueName = "memory-embed";
export const lcmCompactQueueName = "lcm-compact";
export const lcmEmbedQueueName = "lcm-embed";

export const RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES = 256 * 1024;
export const RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT = 64;
export const RAW_CONVERSATION_LOGICAL_ITEM_MAX_BYTES =
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES *
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT;

export const CURATED_MEMORY_REVIEW_MAX_EVIDENCE = 12;

export const rawConversationTransportChunkGroupId = (input: {
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  logicalSourceId: string;
  sourceItemHash: string;
  transportChunkCount: number;
  transportChunkEncoding: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        ...input
      })
    )
    .digest("hex");

export const codexCanonicalConversationItemKey = (input: {
  externalThreadId: string;
  externalTurnId?: string;
  stableItemId: string;
  component: string;
}): string =>
  `conversation-item:${createHash("sha256")
    .update(
      JSON.stringify({
        version: 3,
        provider: "codex",
        externalThreadId: input.externalThreadId,
        externalTurnId: input.externalTurnId ?? null,
        stableItemId: input.stableItemId,
        component: input.component
      })
    )
    .digest("hex")}`;

export const workerQueueNames = [
  memoryEmbedQueueName,
  lcmCompactQueueName,
  lcmEmbedQueueName
] as const;

export type WorkerQueueName = (typeof workerQueueNames)[number];

export type KoedQueueBackend = "bullmq" | "local";

export const historicalImportSourceTransport = "historical_import";

export const koedWorkClasses = [
  "interactive_recall_question",
  "live_capture_projection",
  "normal_embedding_lcm",
  "historical_import_backfill"
] as const;

export type KoedWorkClass = (typeof koedWorkClasses)[number];

const workClassPriorities: Record<KoedWorkClass, number> = {
  interactive_recall_question: 1,
  live_capture_projection: 5,
  normal_embedding_lcm: 10,
  historical_import_backfill: 20
};

export const workClassPriority = (workClass: KoedWorkClass): number =>
  workClassPriorities[workClass];

export const defaultKoedQueuePriority =
  workClassPriorities.normal_embedding_lcm;

export const resolveKoedWorkClass = (
  value: unknown,
  fallback: KoedWorkClass = "normal_embedding_lcm"
): KoedWorkClass =>
  typeof value === "string" && koedWorkClasses.includes(value as KoedWorkClass)
    ? (value as KoedWorkClass)
    : fallback;

export const projectionWorkClassForSourceTransport = (
  sourceTransport: string
): KoedWorkClass =>
  sourceTransport === historicalImportSourceTransport
    ? "historical_import_backfill"
    : "live_capture_projection";

const koedQueueBackends = new Set<KoedQueueBackend>(["bullmq", "local"]);

export const resolveKoedQueueBackend = (
  value: string | undefined,
  fallback: KoedQueueBackend = "bullmq"
): KoedQueueBackend => {
  const normalized = value?.trim();
  return normalized && koedQueueBackends.has(normalized as KoedQueueBackend)
    ? (normalized as KoedQueueBackend)
    : fallback;
};

export interface KoedJobHandle {
  id: string | number | undefined;
}

export interface KoedJobEnqueueOptions {
  /** Lower values run first in both BullMQ and local queue backends. */
  priority?: number;
  jobId?: string;
  attempts?: number;
  backoff?: {
    type: string;
    delay: number;
  };
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
}

export interface KoedJobQueue<TJobData = unknown> {
  add(
    name: string,
    data: TJobData,
    options?: KoedJobEnqueueOptions
  ): Promise<KoedJobHandle>;
  getJobCounts(...statuses: string[]): Promise<Record<string, number>>;
  close(): Promise<void>;
}

const queueJobIdPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 180);

export const embeddingDispatchKey = (
  modelKey: string,
  dimensions: number
): string => `${modelKey}-${dimensions}`;

export const embeddingQueueJobId = (
  dispatchKey: string,
  sourceType: string,
  sourceId: string
): string =>
  `embed-${queueJobIdPart(dispatchKey)}-${queueJobIdPart(sourceType)}-${queueJobIdPart(sourceId)}`;

export const lcmCompactionQueueJobId = (
  userId: string,
  visibility: string,
  dispatchKey: string
): string =>
  `compact-${queueJobIdPart(userId)}-${queueJobIdPart(visibility)}-${queueJobIdPart(dispatchKey)}`;

export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export const createHealth = (
  service: string,
  status: HealthStatus = "ok",
  details?: Record<string, unknown>
): ServiceHealth => ({
  service,
  status,
  checkedAt: new Date().toISOString(),
  ...(details ? { details } : {})
});

export const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const requireEnv = (
  names: string[],
  environment: NodeJS.ProcessEnv = process.env
): void => {
  const missing = names.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${
        missing.length === 1 ? "" : "s"
      }: ${missing.join(", ")}`
    );
  }
};

const truthyConfigValues = new Set(["1", "true", "yes", "on"]);

export const configFlagEnabled = (value: string | undefined): boolean =>
  value ? truthyConfigValues.has(value.trim().toLowerCase()) : false;

const NUL_CHARACTER = "\u0000";
export const NUL_DISPLAY_REPLACEMENT = "\uFFFD";

export interface StorageSanitizationCounts {
  nulCharacters: number;
  malformedUtf16: number;
}

export interface StorageSanitizationResult {
  value: unknown;
  replacementCount: number;
  counts: StorageSanitizationCounts;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value as object);
  return prototype === Object.prototype || prototype === null;
};

const emptyStorageSanitizationCounts = (): StorageSanitizationCounts => ({
  nulCharacters: 0,
  malformedUtf16: 0
});

const addStorageSanitizationCounts = (
  target: StorageSanitizationCounts,
  source: StorageSanitizationCounts
): void => {
  target.nulCharacters += source.nulCharacters;
  target.malformedUtf16 += source.malformedUtf16;
};

const totalStorageSanitizationCount = (
  counts: StorageSanitizationCounts
): number => counts.nulCharacters + counts.malformedUtf16;

export const combineStorageSanitizationCounts = (
  ...results: Array<{ counts: StorageSanitizationCounts }>
): StorageSanitizationCounts => {
  const counts = emptyStorageSanitizationCounts();
  for (const result of results) {
    addStorageSanitizationCounts(counts, result.counts);
  }
  return counts;
};

const countMalformedUtf16CodeUnits = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
      } else {
        count += 1;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      count += 1;
    }
  }
  return count;
};

const fallbackToWellFormed = (value: string): string => {
  let wellFormed = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        wellFormed += value[index] ?? "";
        wellFormed += value[index + 1] ?? "";
        index += 1;
      } else {
        wellFormed += NUL_DISPLAY_REPLACEMENT;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      wellFormed += NUL_DISPLAY_REPLACEMENT;
    } else {
      wellFormed += value[index] ?? "";
    }
  }
  return wellFormed;
};

const toWellFormedStorageString = (value: string): string => {
  const nativeToWellFormed = (value as string & { toWellFormed?: () => string })
    .toWellFormed;
  return typeof nativeToWellFormed === "function"
    ? nativeToWellFormed.call(value)
    : fallbackToWellFormed(value);
};

export const sanitizeForPostgresStorage = (
  value: unknown
): StorageSanitizationResult => {
  if (typeof value === "string") {
    const nulCharacters = value.split(NUL_CHARACTER).length - 1;
    const withoutNul =
      nulCharacters > 0
        ? value.replaceAll(NUL_CHARACTER, NUL_DISPLAY_REPLACEMENT)
        : value;
    const malformedUtf16 = countMalformedUtf16CodeUnits(withoutNul);
    const sanitized =
      malformedUtf16 > 0 ? toWellFormedStorageString(withoutNul) : withoutNul;
    const counts = { nulCharacters, malformedUtf16 };
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  if (Array.isArray(value)) {
    const counts = emptyStorageSanitizationCounts();
    const sanitized = value.map((item) => {
      const result = sanitizeForPostgresStorage(item);
      addStorageSanitizationCounts(counts, result.counts);
      return result.value;
    });
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  if (isPlainRecord(value)) {
    const counts = emptyStorageSanitizationCounts();
    const sanitized: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const sanitizedKey = sanitizeForPostgresStorage(key);
      const sanitizedField = sanitizeForPostgresStorage(field);
      addStorageSanitizationCounts(counts, sanitizedKey.counts);
      addStorageSanitizationCounts(counts, sanitizedField.counts);
      sanitized[String(sanitizedKey.value)] = sanitizedField.value;
    }
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  const counts = emptyStorageSanitizationCounts();
  return { value, replacementCount: 0, counts };
};

export const metadataWithStorageSanitization = (
  metadata: Record<string, unknown>,
  counts: StorageSanitizationCounts
): Record<string, unknown> => {
  if (totalStorageSanitizationCount(counts) === 0) {
    return metadata;
  }
  const existingKoed = isPlainRecord(metadata.koedSanitization)
    ? metadata.koedSanitization
    : {};
  const sanitization: Record<string, unknown> = { ...existingKoed };
  if (counts.nulCharacters > 0) {
    sanitization.nulCharacters = {
      replacement: "U+FFFD",
      replacementCount: counts.nulCharacters
    };
  }
  if (counts.malformedUtf16 > 0) {
    sanitization.malformedUtf16 = {
      replacement: "U+FFFD",
      replacementCount: counts.malformedUtf16
    };
  }
  return {
    ...metadata,
    koedSanitization: sanitization
  };
};

export interface SupportedEmbeddingModelConfig {
  key: string;
  dimensions: number;
}

export interface SupportedRerankerModelConfig {
  key: string;
  model: string;
}

export const DEFAULT_EMBEDDING_MODEL_KEY = "qwen3-0.6b";
export const DEFAULT_RERANKER_MODEL_KEY = "qwen3-reranker-0.6b";

export const SUPPORTED_EMBEDDING_MODELS: Record<
  string,
  SupportedEmbeddingModelConfig
> = {
  "qwen3-0.6b": {
    key: "qwen3-0.6b",
    dimensions: 1024
  }
};

export const SUPPORTED_RERANKER_MODELS: Record<
  string,
  SupportedRerankerModelConfig
> = {
  "qwen3-reranker-0.6b": {
    key: "qwen3-reranker-0.6b",
    model:
      "Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp:Qwen3-Reranker-0.6B-Q4_K_M.gguf"
  }
};

export const resolveSupportedEmbeddingModelConfig = (
  key: string | undefined = DEFAULT_EMBEDDING_MODEL_KEY
): SupportedEmbeddingModelConfig => {
  const normalized = key.trim() || DEFAULT_EMBEDDING_MODEL_KEY;
  const config = SUPPORTED_EMBEDDING_MODELS[normalized];
  if (!config) {
    throw new Error(
      `Unsupported embedding model key: ${normalized}. Supported model keys: ${Object.keys(
        SUPPORTED_EMBEDDING_MODELS
      )
        .sort()
        .join(", ")}`
    );
  }
  return config;
};

export const resolveSupportedRerankerModelConfig = (
  key: string | undefined
): SupportedRerankerModelConfig | null => {
  const normalized = key?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  const config = SUPPORTED_RERANKER_MODELS[normalized];
  if (!config) {
    throw new Error(
      `Unsupported reranker model key: ${normalized}. Supported model keys: ${Object.keys(
        SUPPORTED_RERANKER_MODELS
      )
        .sort()
        .join(", ")}`
    );
  }
  return config;
};

export const resolveRerankerKeyFromEnv = (environment: {
  EMBEDDING_RERANKER_KEY?: string;
  RERANKER_KEY?: string;
}): string | undefined =>
  Object.prototype.hasOwnProperty.call(environment, "RERANKER_KEY")
    ? environment.RERANKER_KEY
    : environment.EMBEDDING_RERANKER_KEY;
