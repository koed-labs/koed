import { createHash } from "node:crypto";

import {
  type DecryptedPrivacyClassificationResult,
  type PrivacyClassificationResultRecord,
  type PrivacyClassificationRepository,
  type SharedMemoryDecryptedSemanticTarget,
  type SharedMemoryPendingSemanticTarget,
  type SharedMemorySemanticPrivacyBacklogDiagnostics,
  sharedMemorySemanticPrivacyWorkIdentity,
  type SharedMemorySemanticPrivacyClaim,
  type SharedMemoryRepository
} from "@koed/db";
import {
  crossIdentitySyncDigest,
  privacyClassificationExpectedManifestHash,
  privacyClassificationOrderedInputHash,
  privacyClassificationResultManifestHash,
  reconstructSharedMemorySemanticSanitizedItems,
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT,
  PRIVACY_CLASSIFICATION_CACHE_FIELD_LIMIT,
  PRIVACY_CLASSIFICATION_MAX_REQUEST_BODY_BYTES,
  PRIVACY_CLASSIFICATION_MAX_REQUEST_FIELD_BYTES,
  privacyClassificationResponseSchema,
  sanitizeTextWithPrivacySpans,
  SharedMemorySemanticResourceLimitError,
  PrivacyServiceUnavailableError,
  type EnvelopeEncryptionProvider,
  type PrivacyClassifiedField,
  type PrivacyServiceClient
} from "@koed/shared";
import {
  createNotificationDrainController,
  type NotificationDrainPool
} from "./notification-drain-controller.js";

const WAKE_CHANNELS = [
  "koed_collaboration_realtime",
  "koed_team_conversation_source",
  "koed_shared_memory_privacy"
] as const;
const CLAIM_LEASE_MS = 120_000;
const CLAIM_HEARTBEAT_MS = Math.floor(CLAIM_LEASE_MS / 3);
const MAX_INFERENCE_REQUESTS_PER_PASS = 8;
const MAX_CLASSIFIED_BYTES_PER_PASS = 4 * 1024 * 1024;

interface SharedMemoryPrivacyLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

type SharedMemoryPrivacyRepository = Pick<
  SharedMemoryRepository,
  | "listPendingSemanticPrivacyTargets"
  | "readPendingSemanticPrivacyTarget"
  | "claimSemanticPrivacyTarget"
  | "renewSemanticPrivacyClaim"
  | "releaseSemanticPrivacyClaim"
  | "initializeSemanticPrivacyManifest"
  | "attachSemanticPrivacyChunkResult"
  | "listSemanticPrivacyManifest"
  | "storeSanitizedSemanticPreview"
  | "markSemanticPrivacyTargetFailed"
  | "deferSemanticPrivacyTarget"
  | "getNextSemanticPrivacyWorkAt"
  | "tryAcquireSemanticPrivacyFinalizationLease"
  | "invalidateStaleSemanticPreviews"
  | "reconcileReadySemanticRepresentations"
> & {
  getSemanticPrivacyBacklogDiagnostics?: () => Promise<SharedMemorySemanticPrivacyBacklogDiagnostics>;
};

type ClassificationRepository = Pick<
  PrivacyClassificationRepository,
  | "getActiveClassifierGeneration"
  | "getLocalDeploymentIdentityId"
  | "resolveEffectiveContentPolicy"
  | "classificationInputIdentity"
  | "findCachedClassification"
  | "storeClassificationResult"
  | "readClassificationResult"
>;

export interface SharedMemoryPrivacyMaterializationResult {
  processed: number;
  invalidatedStale: number;
  classifierCacheHits: number;
  classifierInferenceCalls: number;
  remaskedTargets: number;
  ready: number;
  materialized: number;
  materializationSkipped: number;
  failed: number;
  yielded: number;
  chunksAttached: number;
  resumedChunks: number;
  classifiedBytes: number;
  totalFields: number;
  cacheChunks: number;
  privacyServiceDurationMs: number;
  classificationDurationMs: number;
  finalizationDurationMs: number;
  maxFinalizationHeapDeltaBytes: number;
  maxQueueAgeMs: number;
  maxClaimDurationMs: number;
}

export interface SharedMemoryPrivacyMaterializationService {
  processOnce(): Promise<SharedMemoryPrivacyMaterializationResult>;
  start(): void;
  stop(): Promise<void>;
}

export interface SharedMemoryPrivacyMaterializationServiceOptions {
  sharedMemoryRepository: SharedMemoryPrivacyRepository;
  privacyRepository: ClassificationRepository;
  privacyService: PrivacyServiceClient;
  classificationEncryptionProvider: EnvelopeEncryptionProvider;
  wakePool: NotificationDrainPool;
  logger: SharedMemoryPrivacyLogger;
  targetLimit?: number;
  reconnectBaseMs?: number;
  claimantId?: string;
}

class SharedMemoryPrivacyMaterializationError extends Error {
  constructor(
    readonly code: string,
    readonly failedChunkIndex: number | null = null
  ) {
    super("Shared Memory privacy materialization failed");
    this.name = code;
  }
}

class SharedMemoryPrivacyFinalizationBusyError extends Error {
  constructor() {
    super("Shared Memory privacy finalization capacity is busy");
    this.name = "SharedMemoryPrivacyFinalizationBusyError";
  }
}

const lifecycleCode = (value: string, fallback: string): string => {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 120);
  return /^[a-z][a-z0-9_]{0,119}$/.test(normalized) ? normalized : fallback;
};

const failureCode = (error: unknown): string =>
  lifecycleCode(
    error instanceof Error ? error.name : "",
    "shared_memory_privacy_materialization_failure"
  );

const batchesOf = <T>(values: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
};

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const sameTargetBinding = (
  listed: SharedMemoryPendingSemanticTarget,
  loaded: SharedMemoryPendingSemanticTarget
): boolean =>
  listed.id === loaded.id &&
  listed.sourcePreviewId === loaded.sourcePreviewId &&
  listed.sourceArtifactId === loaded.sourceArtifactId &&
  listed.sourcePreviewRevision === loaded.sourcePreviewRevision &&
  listed.sourcePreviewHash === loaded.sourcePreviewHash &&
  listed.sourceArtifactHash === loaded.sourceArtifactHash &&
  listed.sourceManifestHash === loaded.sourceManifestHash &&
  listed.sourceRevision === loaded.sourceRevision &&
  listed.sourceHash === loaded.sourceHash &&
  listed.logicalMemoryId === loaded.logicalMemoryId &&
  listed.ownerUserId === loaded.ownerUserId &&
  listed.ownerPrincipalId === loaded.ownerPrincipalId &&
  listed.teamId === loaded.teamId &&
  listed.teamWorkspaceId === loaded.teamWorkspaceId &&
  listed.representation === loaded.representation &&
  listed.classifierGenerationId === loaded.classifierGenerationId &&
  listed.classifierVersion === loaded.classifierVersion &&
  listed.classifierHash === loaded.classifierHash &&
  listed.effectivePrivacyPolicyHash === loaded.effectivePrivacyPolicyHash &&
  listed.status === "pending" &&
  loaded.status === "pending";

const exactClassificationFields = (
  loaded: SharedMemoryDecryptedSemanticTarget
): Array<{ path: string; text: string }> => {
  if (loaded.classificationFields.length === 0) {
    throw new SharedMemoryPrivacyMaterializationError(
      "SharedMemoryPrivacyFieldCountError"
    );
  }
  const paths = new Set<string>();
  return loaded.classificationFields.map((field) => {
    if (
      !field.path ||
      field.path.length > 512 ||
      paths.has(field.path) ||
      field.inputSha256 !== sha256(field.text) ||
      field.inputByteLength !== Buffer.byteLength(field.text, "utf8")
    ) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyFieldBindingError"
      );
    }
    paths.add(field.path);
    return { path: field.path, text: field.text };
  });
};

const exactLoadedTarget = (
  listed: SharedMemoryPendingSemanticTarget,
  loaded: SharedMemoryDecryptedSemanticTarget | null
): SharedMemoryDecryptedSemanticTarget => {
  if (
    !loaded ||
    !sameTargetBinding(listed, loaded.target) ||
    loaded.preview.previewId !== listed.sourcePreviewId ||
    loaded.preview.artifactId !== listed.sourceArtifactId ||
    loaded.preview.previewRevision !== listed.sourcePreviewRevision ||
    loaded.preview.previewHash !== listed.sourcePreviewHash ||
    loaded.preview.sourceRevision !== listed.sourceRevision ||
    loaded.preview.sourceHash !== listed.sourceHash ||
    loaded.preview.logicalMemoryId !== listed.logicalMemoryId ||
    loaded.preview.ownerUserId !== listed.ownerUserId ||
    loaded.preview.ownerPrincipalId !== listed.ownerPrincipalId ||
    loaded.preview.teamId !== listed.teamId ||
    loaded.preview.teamWorkspaceId !== listed.teamWorkspaceId ||
    loaded.preview.representation !== listed.representation ||
    loaded.sourceManifest.length !== loaded.preview.items.length
  ) {
    throw new SharedMemoryPrivacyMaterializationError(
      "SharedMemoryPrivacyTargetBindingError"
    );
  }
  return loaded;
};

const markFailed = async (
  options: SharedMemoryPrivacyMaterializationServiceOptions,
  target: SharedMemoryPendingSemanticTarget,
  sourceItemIdentityHash: string,
  code: string
): Promise<void> => {
  await options.sharedMemoryRepository.markSemanticPrivacyTargetFailed(
    { userId: target.ownerUserId },
    {
      semanticPreviewId: target.id,
      expectedSourcePreviewHash: target.sourcePreviewHash,
      expectedSourceArtifactHash: target.sourceArtifactHash,
      expectedSourceManifestHash: target.sourceManifestHash,
      expectedSourceItemIdentityHash: sourceItemIdentityHash,
      expectedClassifierHash: target.classifierHash,
      expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
      failureCode: code
    }
  );
};

const materializeTarget = async (
  options: SharedMemoryPrivacyMaterializationServiceOptions,
  target: SharedMemoryPendingSemanticTarget,
  loaded: SharedMemoryDecryptedSemanticTarget,
  initialClaim: SharedMemorySemanticPrivacyClaim,
  deploymentIdentityId: string,
  counters: SharedMemoryPrivacyMaterializationResult
): Promise<boolean> => {
  const classificationStartedAt = performance.now();
  const actor = { userId: target.ownerUserId };
  const fields = exactClassificationFields(loaded);
  counters.totalFields += fields.length;
  const policy = await options.privacyRepository.resolveEffectiveContentPolicy({
    deploymentIdentityId,
    sourceOwnerUserId: target.ownerUserId,
    teamId: target.teamId,
    teamWorkspaceId: target.teamWorkspaceId
  });
  if (policy.effectivePolicyHash !== target.effectivePrivacyPolicyHash) {
    throw new SharedMemoryPrivacyMaterializationError(
      "SharedMemoryPrivacyPolicyBindingError"
    );
  }

  const readExactClassification = async (
    record: PrivacyClassificationResultRecord | null,
    expectedFields: Array<{ path: string; text: string }>
  ): Promise<DecryptedPrivacyClassificationResult> => {
    if (!record) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyClassificationBindingError"
      );
    }
    const classification =
      await options.privacyRepository.readClassificationResult({
        actor,
        provider: options.classificationEncryptionProvider,
        resultId: record.id,
        expectedFields,
        expectedClassifierHash: target.classifierHash
      });
    if (
      !classification ||
      classification.record.id !== record.id ||
      classification.record.ownerUserId !== target.ownerUserId ||
      classification.record.classifierGenerationId !==
        target.classifierGenerationId ||
      classification.record.classifierHash !== target.classifierHash ||
      classification.record.status !== "ready" ||
      classification.fields.length !== expectedFields.length
    ) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyClassificationBindingError"
      );
    }
    return classification;
  };

  const classifier =
    await options.privacyRepository.getActiveClassifierGeneration();
  if (
    !classifier ||
    classifier.id !== target.classifierGenerationId ||
    classifier.version !== target.classifierVersion ||
    classifier.classifierHash !== target.classifierHash ||
    classifier.inputContractVersion !== PRIVACY_CLASSIFICATION_CONTRACT_VERSION
  ) {
    throw new SharedMemoryPrivacyMaterializationError(
      "SharedMemoryPrivacyClassifierContractError"
    );
  }
  const classifierIdentity = {
    classifierHash: classifier.classifierHash,
    modelKey: classifier.modelKey,
    modelRevision: classifier.modelRevision
  };
  const cacheChunks = batchesOf(
    fields,
    PRIVACY_CLASSIFICATION_CACHE_FIELD_LIMIT
  );
  counters.cacheChunks += cacheChunks.length;
  const chunkBindings = cacheChunks.map((chunk, chunkIndex) => ({
    chunkIndex,
    firstFieldIndex: chunkIndex * PRIVACY_CLASSIFICATION_CACHE_FIELD_LIMIT,
    fieldCount: chunk.length,
    inputIdentityHash: options.privacyRepository.classificationInputIdentity({
      actor,
      fields: chunk
    }),
    orderedInputHash: privacyClassificationOrderedInputHash(chunk)
  }));
  const expectedManifestHash = privacyClassificationExpectedManifestHash({
    semanticPreviewId: target.id,
    sourcePreviewHash: target.sourcePreviewHash,
    sourceArtifactHash: target.sourceArtifactHash,
    sourceManifestHash: target.sourceManifestHash,
    sourceRevision: target.sourceRevision,
    classifierGenerationId: target.classifierGenerationId,
    classifierHash: target.classifierHash,
    effectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
    fieldCount: fields.length,
    chunks: chunkBindings
  });
  let claim = initialClaim;
  const renewClaim = async (failedChunkIndex: number | null): Promise<void> => {
    const renewed =
      await options.sharedMemoryRepository.renewSemanticPrivacyClaim(actor, {
        ...claim,
        leaseMs: CLAIM_LEASE_MS
      });
    if (!renewed) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyClaimExpiredError",
        failedChunkIndex
      );
    }
    claim = renewed;
  };
  const withClaimHeartbeat = async <Result>(
    work: () => Promise<Result>,
    failedChunkIndex: number | null = null
  ): Promise<Result> => {
    await renewClaim(failedChunkIndex);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let heartbeatFailure: unknown = null;
    const schedule = (): void => {
      timer = setTimeout(() => {
        timer = null;
        inFlight = renewClaim(failedChunkIndex)
          .catch((error: unknown) => {
            heartbeatFailure = error;
          })
          .finally(() => {
            inFlight = null;
            if (!stopped && !heartbeatFailure) schedule();
          });
      }, CLAIM_HEARTBEAT_MS);
      timer.unref?.();
    };
    schedule();
    try {
      const result = await work();
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await Promise.resolve(inFlight);
      if (heartbeatFailure) throw heartbeatFailure;
      await renewClaim(failedChunkIndex);
      return result;
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.resolve(inFlight);
    }
  };
  let manifest =
    await options.sharedMemoryRepository.initializeSemanticPrivacyManifest(
      actor,
      {
        claim,
        expectedManifestHash,
        fieldCount: fields.length,
        fieldByteCount: fields.reduce(
          (total, field) => total + Buffer.byteLength(field.text, "utf8"),
          0
        ),
        chunks: chunkBindings
      }
    );
  counters.resumedChunks += manifest.filter(
    (entry) => entry.status === "ready"
  ).length;

  const packTransport = (
    chunk: Array<{ path: string; text: string }>
  ): Array<Array<{ path: string; text: string }>> => {
    const groups: Array<Array<{ path: string; text: string }>> = [];
    let current: Array<{ path: string; text: string }> = [];
    for (const field of chunk) {
      const candidate = [...current, field];
      const fieldBytes = candidate.reduce(
        (total, value) => total + Buffer.byteLength(value.text, "utf8"),
        0
      );
      const bodyBytes = Buffer.byteLength(
        JSON.stringify({
          schemaVersion: 1,
          inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
          fields: candidate
        }),
        "utf8"
      );
      if (
        current.length > 0 &&
        (candidate.length > PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT ||
          fieldBytes > PRIVACY_CLASSIFICATION_MAX_REQUEST_FIELD_BYTES ||
          bodyBytes > PRIVACY_CLASSIFICATION_MAX_REQUEST_BODY_BYTES)
      ) {
        groups.push(current);
        current = [field];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  };

  const attachRecord = async (
    entry: (typeof manifest)[number],
    record: PrivacyClassificationResultRecord
  ): Promise<void> => {
    const chunk = cacheChunks[entry.chunkIndex];
    const binding = chunkBindings[entry.chunkIndex];
    if (!chunk || !binding) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyManifestBindingError",
        entry.chunkIndex
      );
    }
    let classification: DecryptedPrivacyClassificationResult;
    try {
      classification = await readExactClassification(record, chunk);
    } catch (error) {
      if (error instanceof SharedMemoryPrivacyMaterializationError) {
        throw new SharedMemoryPrivacyMaterializationError(
          error.code,
          entry.chunkIndex
        );
      }
      throw error;
    }
    if (!classification.record.payloadBindingHash) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyClassificationBindingError",
        entry.chunkIndex
      );
    }
    await renewClaim(entry.chunkIndex);
    await options.sharedMemoryRepository.attachSemanticPrivacyChunkResult(
      actor,
      {
        claim,
        chunkIndex: entry.chunkIndex,
        inputIdentityHash: binding.inputIdentityHash,
        orderedInputHash: binding.orderedInputHash,
        classificationResultId: classification.record.id,
        classificationPayloadBindingHash:
          classification.record.payloadBindingHash
      }
    );
    counters.chunksAttached += 1;
    await renewClaim(entry.chunkIndex);
  };

  const missing: Array<(typeof manifest)[number]> = [];
  for (const entry of manifest) {
    if (entry.status === "ready") continue;
    const chunk = cacheChunks[entry.chunkIndex]!;
    const cached = await options.privacyRepository.findCachedClassification({
      actor,
      classifierHash: target.classifierHash,
      fields: chunk
    });
    if (cached) {
      counters.classifierCacheHits += 1;
      counters.remaskedTargets += 1;
      await attachRecord(entry, cached);
    } else {
      missing.push(entry);
    }
  }

  const selected: Array<(typeof manifest)[number]> = [];
  let selectedBytes = 0;
  for (const entry of missing) {
    const chunk = cacheChunks[entry.chunkIndex]!;
    const chunkBytes = chunk.reduce(
      (total, field) => total + Buffer.byteLength(field.text, "utf8"),
      0
    );
    const candidate = [...selected, entry];
    const groups = packTransport(
      candidate.flatMap((value) => cacheChunks[value.chunkIndex]!)
    );
    if (
      selected.length > 0 &&
      (groups.length > MAX_INFERENCE_REQUESTS_PER_PASS ||
        selectedBytes + chunkBytes > MAX_CLASSIFIED_BYTES_PER_PASS)
    ) {
      break;
    }
    selected.push(entry);
    selectedBytes += chunkBytes;
  }
  const entryByPath = new Map<string, (typeof manifest)[number]>();
  const inferredByChunk = new Map<
    number,
    Map<string, PrivacyClassifiedField>
  >();
  for (const entry of selected) {
    inferredByChunk.set(entry.chunkIndex, new Map());
    for (const field of cacheChunks[entry.chunkIndex]!) {
      entryByPath.set(field.path, entry);
    }
  }
  const attachedChunkIndexes = new Set<number>();
  for (const group of packTransport(
    selected.flatMap((entry) => cacheChunks[entry.chunkIndex]!)
  )) {
    counters.classifierInferenceCalls += 1;
    const serviceStartedAt = performance.now();
    const response = privacyClassificationResponseSchema.safeParse(
      await withClaimHeartbeat(
        () => options.privacyService.classify(group),
        entryByPath.get(group[0]!.path)?.chunkIndex ?? null
      )
    );
    counters.privacyServiceDurationMs += performance.now() - serviceStartedAt;
    if (
      !response.success ||
      response.data.classifier.classifierHash !== classifier.classifierHash ||
      response.data.classifier.modelKey !== classifier.modelKey ||
      response.data.classifier.modelRevision !== classifier.modelRevision ||
      response.data.fields.length !== group.length ||
      response.data.fields.some((field, index) => {
        const expected = group[index];
        return (
          !expected ||
          field.path !== expected.path ||
          field.inputSha256 !== sha256(expected.text) ||
          field.inputByteLength !== Buffer.byteLength(expected.text, "utf8")
        );
      })
    ) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyClassifierContractError",
        entryByPath.get(group[0]!.path)?.chunkIndex ?? null
      );
    }
    counters.classifiedBytes += group.reduce(
      (total, field) => total + Buffer.byteLength(field.text, "utf8"),
      0
    );
    for (const field of response.data.fields) {
      const entry = entryByPath.get(field.path);
      if (!entry) {
        throw new SharedMemoryPrivacyMaterializationError(
          "SharedMemoryPrivacyClassifierContractError"
        );
      }
      inferredByChunk.get(entry.chunkIndex)!.set(field.path, field);
    }
    for (const entry of selected) {
      if (attachedChunkIndexes.has(entry.chunkIndex)) continue;
      const chunk = cacheChunks[entry.chunkIndex]!;
      const inferred = inferredByChunk.get(entry.chunkIndex)!;
      if (inferred.size !== chunk.length) continue;
      const responseFields = chunk.map((field) => inferred.get(field.path));
      if (responseFields.some((field) => !field)) {
        throw new SharedMemoryPrivacyMaterializationError(
          "SharedMemoryPrivacyClassifierContractError",
          entry.chunkIndex
        );
      }
      const record = await options.privacyRepository.storeClassificationResult({
        actor,
        provider: options.classificationEncryptionProvider,
        fields: chunk,
        response: {
          schemaVersion: 1,
          inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
          classifier: classifierIdentity,
          fields: responseFields as PrivacyClassifiedField[]
        }
      });
      await attachRecord(entry, record);
      attachedChunkIndexes.add(entry.chunkIndex);
    }
  }

  manifest = await options.sharedMemoryRepository.listSemanticPrivacyManifest(
    actor,
    { claim }
  );
  const nextPending = manifest.find((entry) => entry.status === "pending");
  if (nextPending) {
    const released =
      await options.sharedMemoryRepository.releaseSemanticPrivacyClaim(actor, {
        ...claim,
        completed: false,
        nextChunkIndex: nextPending.chunkIndex
      });
    if (!released) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyClaimExpiredError"
      );
    }
    counters.classificationDurationMs +=
      performance.now() - classificationStartedAt;
    return false;
  }

  const finalizationLease =
    await options.sharedMemoryRepository.tryAcquireSemanticPrivacyFinalizationLease();
  if (!finalizationLease) {
    await options.sharedMemoryRepository.releaseSemanticPrivacyClaim(actor, {
      ...claim,
      completed: false,
      nextChunkIndex: manifest.length
    });
    throw new SharedMemoryPrivacyFinalizationBusyError();
  }
  const finalizationStartedAt = performance.now();
  const finalizationHeapBefore = process.memoryUsage().heapUsed;
  const sampleFinalizationHeap = (): void => {
    counters.maxFinalizationHeapDeltaBytes = Math.max(
      counters.maxFinalizationHeapDeltaBytes,
      Math.max(process.memoryUsage().heapUsed - finalizationHeapBefore, 0)
    );
  };
  try {
    const { items, resultManifestHash, sanitizedContentHash } =
      await withClaimHeartbeat(async () => {
        const maskedFields: Array<{
          path: string;
          inputSha256: string;
          inputByteLength: number;
          sanitizedText: string;
        }> = [];
        for (const entry of manifest) {
          const chunk = cacheChunks[entry.chunkIndex]!;
          let classification: DecryptedPrivacyClassificationResult;
          try {
            classification = await readExactClassification(
              entry.classificationResultId
                ? {
                    id: entry.classificationResultId,
                    ownerUserId: target.ownerUserId,
                    classifierGenerationId: target.classifierGenerationId,
                    classifierHash: target.classifierHash,
                    ownerContentFingerprint: entry.inputIdentityHash,
                    inputByteLength: 0,
                    payloadBindingHash: entry.classificationPayloadBindingHash,
                    spanCount: null,
                    status: "ready",
                    failureCode: null,
                    createdAt: entry.createdAt,
                    readyAt: entry.readyAt,
                    invalidatedAt: null,
                    invalidationReasonCode: null
                  }
                : null,
              chunk
            );
          } catch (error) {
            if (error instanceof SharedMemoryPrivacyMaterializationError) {
              throw new SharedMemoryPrivacyMaterializationError(
                error.code,
                entry.chunkIndex
              );
            }
            throw error;
          }
          classification.fields.forEach((classified, index) => {
            const expected =
              loaded.classificationFields[entry.firstFieldIndex + index];
            if (
              !expected ||
              classified.path !== expected.path ||
              classified.inputSha256 !== expected.inputSha256 ||
              classified.inputByteLength !== expected.inputByteLength
            ) {
              throw new SharedMemoryPrivacyMaterializationError(
                "SharedMemoryPrivacyClassificationBindingError",
                entry.chunkIndex
              );
            }
            maskedFields.push({
              path: classified.path,
              inputSha256: classified.inputSha256,
              inputByteLength: classified.inputByteLength,
              sanitizedText: sanitizeTextWithPrivacySpans({
                text: expected.text,
                spans: classified.spans,
                policy: policy.labels
              }).text
            });
          });
        }
        sampleFinalizationHeap();
        const resultManifestHash = privacyClassificationResultManifestHash({
          expectedManifestHash,
          chunks: manifest.map((entry) => ({
            chunkIndex: entry.chunkIndex,
            firstFieldIndex: entry.firstFieldIndex,
            fieldCount: entry.fieldCount,
            inputIdentityHash: entry.inputIdentityHash,
            orderedInputHash: entry.orderedInputHash,
            classificationResultId: entry.classificationResultId!,
            classificationPayloadBindingHash:
              entry.classificationPayloadBindingHash!
          }))
        });
        const items = reconstructSharedMemorySemanticSanitizedItems(
          loaded.preview.items,
          maskedFields
        );
        sampleFinalizationHeap();
        const sanitizedContentHash = crossIdentitySyncDigest(items);
        sampleFinalizationHeap();
        return { items, resultManifestHash, sanitizedContentHash };
      });
    const stored =
      await options.sharedMemoryRepository.storeSanitizedSemanticPreview(
        actor,
        {
          semanticPreviewId: target.id,
          expectedSourcePreviewHash: target.sourcePreviewHash,
          expectedSourceArtifactHash: target.sourceArtifactHash,
          expectedSourceManifestHash: target.sourceManifestHash,
          expectedSourceRevision: target.sourceRevision,
          expectedSourceItemIdentityHash: loaded.sourceItemIdentityHash,
          expectedClassifierHash: target.classifierHash,
          expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
          claim,
          expectedManifestHash,
          expectedResultManifestHash: resultManifestHash,
          items,
          sanitizedContentHash
        }
      );
    sampleFinalizationHeap();
    if (
      stored.id !== target.id ||
      stored.status !== "ready" ||
      stored.sourcePreviewHash !== target.sourcePreviewHash ||
      stored.sourceArtifactHash !== target.sourceArtifactHash ||
      stored.sourceManifestHash !== target.sourceManifestHash ||
      stored.sourceRevision !== target.sourceRevision ||
      stored.sourceItemIdentityHash !== loaded.sourceItemIdentityHash ||
      stored.classifierHash !== target.classifierHash ||
      stored.effectivePrivacyPolicyHash !== target.effectivePrivacyPolicyHash ||
      stored.expectedManifestHash !== expectedManifestHash ||
      stored.resultManifestHash !== resultManifestHash
    ) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyReadyBindingError"
      );
    }
    counters.classificationDurationMs +=
      performance.now() - classificationStartedAt;
    counters.finalizationDurationMs +=
      performance.now() - finalizationStartedAt;
    return true;
  } finally {
    await finalizationLease.release();
  }
};

const emptyResult = (): SharedMemoryPrivacyMaterializationResult => ({
  processed: 0,
  invalidatedStale: 0,
  classifierCacheHits: 0,
  classifierInferenceCalls: 0,
  remaskedTargets: 0,
  ready: 0,
  materialized: 0,
  materializationSkipped: 0,
  failed: 0,
  yielded: 0,
  chunksAttached: 0,
  resumedChunks: 0,
  classifiedBytes: 0,
  totalFields: 0,
  cacheChunks: 0,
  privacyServiceDurationMs: 0,
  classificationDurationMs: 0,
  finalizationDurationMs: 0,
  maxFinalizationHeapDeltaBytes: 0,
  maxQueueAgeMs: 0,
  maxClaimDurationMs: 0
});

export const createSharedMemoryPrivacyMaterializationService = (
  options: SharedMemoryPrivacyMaterializationServiceOptions
): SharedMemoryPrivacyMaterializationService => {
  const targetLimit = Math.min(Math.max(options.targetLimit ?? 32, 1), 100);
  let capabilitiesPromise: ReturnType<
    PrivacyServiceClient["capabilities"]
  > | null = null;
  const validateCapabilities = async (): Promise<void> => {
    capabilitiesPromise ??= options.privacyService.capabilities();
    try {
      await capabilitiesPromise;
    } catch (error) {
      capabilitiesPromise = null;
      throw error;
    }
  };

  const processOnce =
    async (): Promise<SharedMemoryPrivacyMaterializationResult> => {
      const result = emptyResult();
      const stale =
        await options.sharedMemoryRepository.invalidateStaleSemanticPreviews({
          limit: targetLimit
        });
      result.invalidatedStale = stale.invalidated;
      const deploymentIdentityId =
        await options.privacyRepository.getLocalDeploymentIdentityId();
      if (!deploymentIdentityId) {
        throw new SharedMemoryPrivacyMaterializationError(
          "SharedMemoryPrivacyDeploymentIdentityError"
        );
      }
      await validateCapabilities();
      const targets =
        await options.sharedMemoryRepository.listPendingSemanticPrivacyTargets({
          limit: targetLimit
        });
      for (const target of targets) {
        result.maxQueueAgeMs = Math.max(
          result.maxQueueAgeMs,
          Math.max(Date.now() - Date.parse(target.enqueuedAt), 0)
        );
        const claimStartedAt = performance.now();
        const claim =
          await options.sharedMemoryRepository.claimSemanticPrivacyTarget(
            { userId: target.ownerUserId },
            {
              semanticPreviewId: target.id,
              claimantId:
                options.claimantId ?? `shared-memory-privacy:${process.pid}`,
              leaseMs: CLAIM_LEASE_MS,
              expectedWorkIdentity:
                sharedMemorySemanticPrivacyWorkIdentity(target)
            }
          );
        result.maxClaimDurationMs = Math.max(
          result.maxClaimDurationMs,
          performance.now() - claimStartedAt
        );
        if (!claim) continue;
        result.processed += 1;
        let loaded: SharedMemoryDecryptedSemanticTarget | null = null;
        try {
          loaded = exactLoadedTarget(
            target,
            await options.sharedMemoryRepository.readPendingSemanticPrivacyTarget(
              { userId: target.ownerUserId },
              {
                semanticPreviewId: target.id,
                expectedSourcePreviewHash: target.sourcePreviewHash,
                expectedSourceArtifactHash: target.sourceArtifactHash,
                expectedSourceManifestHash: target.sourceManifestHash,
                expectedClassifierHash: target.classifierHash,
                expectedEffectivePrivacyPolicyHash:
                  target.effectivePrivacyPolicyHash
              }
            )
          );
          const ready = await materializeTarget(
            options,
            target,
            loaded,
            claim,
            deploymentIdentityId,
            result
          );
          if (ready) result.ready += 1;
          else result.yielded += 1;
        } catch (error) {
          await options.sharedMemoryRepository
            .releaseSemanticPrivacyClaim(
              { userId: target.ownerUserId },
              {
                ...claim,
                completed: false,
                nextChunkIndex: target.continuationChunkIndex
              }
            )
            .catch(() => false);
          if (
            error instanceof SharedMemoryPrivacyMaterializationError &&
            error.code === "SharedMemoryPrivacyClaimExpiredError"
          ) {
            result.yielded += 1;
            continue;
          }
          if (error instanceof SharedMemoryPrivacyFinalizationBusyError) {
            controller.scheduleRetry(new Date(Date.now() + 250).toISOString());
            continue;
          }
          if (error instanceof PrivacyServiceUnavailableError && loaded) {
            const retryAt =
              await options.sharedMemoryRepository.deferSemanticPrivacyTarget(
                { userId: target.ownerUserId },
                {
                  semanticPreviewId: target.id,
                  expectedSourcePreviewHash: target.sourcePreviewHash,
                  expectedSourceArtifactHash: target.sourceArtifactHash,
                  expectedSourceManifestHash: target.sourceManifestHash,
                  expectedClassifierHash: target.classifierHash,
                  expectedEffectivePrivacyPolicyHash:
                    target.effectivePrivacyPolicyHash,
                  errorClass: lifecycleCode(
                    error.name,
                    "privacy_service_unavailable"
                  )
                }
              );
            controller.scheduleRetry(retryAt);
            options.logger.warn(
              {
                event: {
                  name: "worker.shared_memory_privacy_materialization.deferred",
                  category: "privacy"
                },
                errorClass: lifecycleCode(
                  error.name,
                  "privacy_service_unavailable"
                ),
                retryAt
              },
              "Shared Memory privacy materialization deferred after a transient outage"
            );
            continue;
          }
          result.failed += 1;
          const code = failureCode(error);
          if (loaded) {
            try {
              await markFailed(
                options,
                target,
                loaded.sourceItemIdentityHash,
                code
              );
            } catch (transitionError) {
              options.logger.warn(
                {
                  event: {
                    name: "worker.shared_memory_privacy_materialization.failure_transition_failed",
                    category: "privacy"
                  },
                  errorClass: failureCode(transitionError),
                  materializationErrorClass: code
                },
                "Shared Memory privacy materialization failure transition did not persist"
              );
            }
          }
          options.logger.warn(
            {
              event: {
                name: "worker.shared_memory_privacy_materialization.failed",
                category: "privacy"
              },
              errorClass: code,
              failedChunkIndex:
                error instanceof SharedMemoryPrivacyMaterializationError
                  ? error.failedChunkIndex
                  : null,
              resourceLimit:
                error instanceof SharedMemorySemanticResourceLimitError
                  ? {
                      kind: error.limitKind,
                      observed: error.observed,
                      maximum: error.maximum
                    }
                  : null
            },
            "Shared Memory privacy materialization failed closed"
          );
        }
      }
      const publication =
        await options.sharedMemoryRepository.reconcileReadySemanticRepresentations(
          { limit: targetLimit }
        );
      result.materialized = publication.materialized;
      result.materializationSkipped = publication.skipped;
      const backlog = options.sharedMemoryRepository
        .getSemanticPrivacyBacklogDiagnostics
        ? await options.sharedMemoryRepository.getSemanticPrivacyBacklogDiagnostics()
        : null;
      options.logger.info(
        {
          event: {
            name: "worker.shared_memory_privacy_materialization.reconciled",
            category: "privacy"
          },
          sharedMemoryPrivacyMaterialization: result,
          sharedMemoryPrivacyBacklog: backlog
        },
        "Shared Memory privacy materialization reconciliation completed"
      );
      controller.scheduleRetry(
        await options.sharedMemoryRepository.getNextSemanticPrivacyWorkAt()
      );
      return result;
    };

  const controller = createNotificationDrainController({
    channels: WAKE_CHANNELS,
    wakePool: options.wakePool,
    processOnce,
    reconnectBaseMs: options.reconnectBaseMs,
    shouldContinue: (result) =>
      result.processed === targetLimit ||
      result.invalidatedStale === targetLimit ||
      result.materialized === targetLimit ||
      result.yielded > 0,
    onProcessError(error) {
      options.logger.warn(
        {
          event: {
            name: "worker.shared_memory_privacy_materialization.reconcile_failed",
            category: "privacy"
          },
          errorClass: failureCode(error)
        },
        "Shared Memory privacy materialization reconciliation failed"
      );
    }
  });

  return {
    processOnce,
    start: controller.start,
    stop: controller.stop
  };
};
