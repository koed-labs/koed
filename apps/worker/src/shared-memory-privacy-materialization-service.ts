import { createHash } from "node:crypto";

import {
  type DecryptedPrivacyClassificationResult,
  type PrivacyClassificationResultRecord,
  type PrivacyClassificationRepository,
  type SharedMemoryDecryptedSemanticTarget,
  type SharedMemoryPendingSemanticTarget,
  type SharedMemoryRepository
} from "@koed/db";
import {
  crossIdentitySyncDigest,
  reconstructSharedMemorySemanticSanitizedItems,
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT,
  privacyClassificationResponseSchema,
  sanitizeTextWithPrivacySpans,
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
const PRIVACY_CLASSIFICATION_CACHE_FIELD_LIMIT = 16;

interface SharedMemoryPrivacyLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

type SharedMemoryPrivacyRepository = Pick<
  SharedMemoryRepository,
  | "listPendingSemanticPrivacyTargets"
  | "readPendingSemanticPrivacyTarget"
  | "storeSanitizedSemanticPreview"
  | "markSemanticPrivacyTargetFailed"
  | "deferSemanticPrivacyTarget"
  | "getNextSemanticPrivacyRetryAt"
  | "invalidateStaleSemanticPreviews"
  | "reconcileReadySemanticRepresentations"
>;

type ClassificationRepository = Pick<
  PrivacyClassificationRepository,
  | "getActiveClassifierGeneration"
  | "getLocalDeploymentIdentityId"
  | "resolveEffectiveContentPolicy"
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
}

class SharedMemoryPrivacyMaterializationError extends Error {
  constructor(readonly code: string) {
    super("Shared Memory privacy materialization failed");
    this.name = code;
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
  if (
    loaded.classificationFields.length === 0 ||
    loaded.classificationFields.length > 2_048
  ) {
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
  deploymentIdentityId: string,
  counters: SharedMemoryPrivacyMaterializationResult
): Promise<void> => {
  const actor = { userId: target.ownerUserId };
  const fields = exactClassificationFields(loaded);
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
    record: Awaited<
      ReturnType<ClassificationRepository["findCachedClassification"]>
    >,
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

  let classificationRecord =
    await options.privacyRepository.findCachedClassification({
      actor,
      classifierHash: target.classifierHash,
      fields
    });
  if (classificationRecord) {
    counters.classifierCacheHits += 1;
    counters.remaskedTargets += 1;
  } else {
    const classifier =
      await options.privacyRepository.getActiveClassifierGeneration();
    if (
      !classifier ||
      classifier.id !== target.classifierGenerationId ||
      classifier.version !== target.classifierVersion ||
      classifier.classifierHash !== target.classifierHash ||
      classifier.inputContractVersion !==
        PRIVACY_CLASSIFICATION_CONTRACT_VERSION
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
    const cacheBatches = batchesOf(
      fields,
      PRIVACY_CLASSIFICATION_CACHE_FIELD_LIMIT
    );
    const batchRecords = new Map<number, PrivacyClassificationResultRecord>();
    const classifiedBatches = new Map<number, PrivacyClassifiedField[]>();
    const missingBatchIndexes: number[] = [];
    for (const [batchIndex, batch] of cacheBatches.entries()) {
      const batchRecord =
        await options.privacyRepository.findCachedClassification({
          actor,
          classifierHash: target.classifierHash,
          fields: batch
        });
      if (batchRecord) {
        counters.classifierCacheHits += 1;
        batchRecords.set(batchIndex, batchRecord);
        const cached = await readExactClassification(batchRecord, batch);
        classifiedBatches.set(
          batchIndex,
          cached.fields.map((field, index) => ({
            path: field.path,
            inputSha256: field.inputSha256,
            inputByteLength: field.inputByteLength,
            maskedText: batch[index]!.text,
            decodedTextMatchesInput: true as const,
            spans: field.spans
          }))
        );
      } else {
        missingBatchIndexes.push(batchIndex);
      }
    }

    const inferredFields = new Map<string, PrivacyClassifiedField>();
    const missingFields = missingBatchIndexes.flatMap(
      (batchIndex) => cacheBatches[batchIndex]!
    );
    for (const inferenceBatch of batchesOf(
      missingFields,
      PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT
    )) {
      counters.classifierInferenceCalls += 1;
      const response = privacyClassificationResponseSchema.safeParse(
        await options.privacyService.classify(inferenceBatch)
      );
      if (
        !response.success ||
        response.data.classifier.classifierHash !== classifier.classifierHash ||
        response.data.classifier.modelKey !== classifier.modelKey ||
        response.data.classifier.modelRevision !== classifier.modelRevision ||
        response.data.fields.length !== inferenceBatch.length ||
        response.data.fields.some((field, index) => {
          const expected = inferenceBatch[index];
          return (
            !expected ||
            field.path !== expected.path ||
            field.inputSha256 !== sha256(expected.text) ||
            field.inputByteLength !== Buffer.byteLength(expected.text, "utf8")
          );
        })
      ) {
        throw new SharedMemoryPrivacyMaterializationError(
          "SharedMemoryPrivacyClassifierContractError"
        );
      }
      for (const field of response.data.fields) {
        inferredFields.set(field.path, field);
      }
    }

    for (const batchIndex of missingBatchIndexes) {
      const batch = cacheBatches[batchIndex]!;
      const responseFields = batch.map((field) =>
        inferredFields.get(field.path)
      );
      if (responseFields.some((field) => field === undefined)) {
        throw new SharedMemoryPrivacyMaterializationError(
          "SharedMemoryPrivacyClassifierContractError"
        );
      }
      const batchRecord =
        await options.privacyRepository.storeClassificationResult({
          actor,
          provider: options.classificationEncryptionProvider,
          fields: batch,
          response: {
            schemaVersion: 1,
            inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
            classifier: classifierIdentity,
            fields: responseFields as PrivacyClassifiedField[]
          }
        });
      batchRecords.set(batchIndex, batchRecord);
      const stored = await readExactClassification(batchRecord, batch);
      classifiedBatches.set(
        batchIndex,
        stored.fields.map((field, index) => ({
          path: field.path,
          inputSha256: field.inputSha256,
          inputByteLength: field.inputByteLength,
          maskedText: batch[index]!.text,
          decodedTextMatchesInput: true as const,
          spans: field.spans
        }))
      );
    }

    const classifiedFields = cacheBatches.flatMap(
      (_batch, batchIndex) => classifiedBatches.get(batchIndex) ?? []
    );
    if (
      classifiedFields.length !== fields.length ||
      batchRecords.size !== cacheBatches.length
    ) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyClassifierContractError"
      );
    }
    if (cacheBatches.length === 1) {
      classificationRecord = batchRecords.get(0) ?? null;
    } else {
      classificationRecord =
        await options.privacyRepository.storeClassificationResult({
          actor,
          provider: options.classificationEncryptionProvider,
          fields,
          response: {
            schemaVersion: 1,
            inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
            classifier: classifierIdentity,
            fields: classifiedFields
          }
        });
    }
  }

  const classification = await readExactClassification(
    classificationRecord,
    fields
  );

  const maskedFields = classification.fields.map((classified, index) => {
    const expected = loaded.classificationFields[index];
    if (
      !expected ||
      classified.path !== expected.path ||
      classified.inputSha256 !== expected.inputSha256 ||
      classified.inputByteLength !== expected.inputByteLength
    ) {
      throw new SharedMemoryPrivacyMaterializationError(
        "SharedMemoryPrivacyClassificationBindingError"
      );
    }
    return {
      path: classified.path,
      inputSha256: classified.inputSha256,
      inputByteLength: classified.inputByteLength,
      sanitizedText: sanitizeTextWithPrivacySpans({
        text: expected.text,
        spans: classified.spans,
        policy: policy.labels
      }).text
    };
  });
  const items = reconstructSharedMemorySemanticSanitizedItems(
    loaded.preview.items,
    maskedFields
  );
  const stored =
    await options.sharedMemoryRepository.storeSanitizedSemanticPreview(actor, {
      semanticPreviewId: target.id,
      expectedSourcePreviewHash: target.sourcePreviewHash,
      expectedSourceArtifactHash: target.sourceArtifactHash,
      expectedSourceManifestHash: target.sourceManifestHash,
      expectedSourceRevision: target.sourceRevision,
      expectedSourceItemIdentityHash: loaded.sourceItemIdentityHash,
      expectedClassifierHash: target.classifierHash,
      expectedEffectivePrivacyPolicyHash: target.effectivePrivacyPolicyHash,
      classificationResultId: classification.record.id,
      items,
      sanitizedContentHash: crossIdentitySyncDigest(items)
    });
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
    stored.classificationResultId !== classification.record.id
  ) {
    throw new SharedMemoryPrivacyMaterializationError(
      "SharedMemoryPrivacyReadyBindingError"
    );
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
  failed: 0
});

export const createSharedMemoryPrivacyMaterializationService = (
  options: SharedMemoryPrivacyMaterializationServiceOptions
): SharedMemoryPrivacyMaterializationService => {
  const targetLimit = Math.min(Math.max(options.targetLimit ?? 32, 1), 100);

  const processOnce =
    async (): Promise<SharedMemoryPrivacyMaterializationResult> => {
      const result = emptyResult();
      const deploymentIdentityId =
        await options.privacyRepository.getLocalDeploymentIdentityId();
      if (!deploymentIdentityId) {
        throw new SharedMemoryPrivacyMaterializationError(
          "SharedMemoryPrivacyDeploymentIdentityError"
        );
      }
      const stale =
        await options.sharedMemoryRepository.invalidateStaleSemanticPreviews({
          limit: targetLimit
        });
      result.invalidatedStale = stale.invalidated;
      const targets =
        await options.sharedMemoryRepository.listPendingSemanticPrivacyTargets({
          limit: targetLimit
        });
      for (const target of targets) {
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
          await materializeTarget(
            options,
            target,
            loaded,
            deploymentIdentityId,
            result
          );
          result.ready += 1;
        } catch (error) {
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
              errorClass: code
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
      options.logger.info(
        {
          event: {
            name: "worker.shared_memory_privacy_materialization.reconciled",
            category: "privacy"
          },
          sharedMemoryPrivacyMaterialization: result
        },
        "Shared Memory privacy materialization reconciliation completed"
      );
      controller.scheduleRetry(
        await options.sharedMemoryRepository.getNextSemanticPrivacyRetryAt()
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
      result.materialized === targetLimit,
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
