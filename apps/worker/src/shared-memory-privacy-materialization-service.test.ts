import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  type PrivacyClassificationResultRecord,
  type SharedMemoryDecryptedSemanticTarget,
  type SharedMemoryPendingSemanticTarget,
  type SharedMemoryRepository
} from "@koed/db";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDigest,
  extractSharedMemorySemanticClassificationFields,
  noPrivacyLabelsPolicy,
  privacyContentPolicyHash,
  privacyLabels,
  PrivacyServiceUnavailableError,
  SHARED_MEMORY_SEMANTIC_FIELD_MAX_BYTES,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES,
  type SharedMemoryCanonicalSourceItemDto,
  type PrivacyClassificationResponse,
  type PrivacyLabel,
  type PrivacyLabelPolicy
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";

import { createSharedMemoryPrivacyMaterializationService } from "./shared-memory-privacy-materialization-service.js";

const ids = {
  semantic: "00000000-0000-4000-8000-000000000001",
  preview: "00000000-0000-4000-8000-000000000002",
  artifact: "00000000-0000-4000-8000-000000000003",
  logicalMemory: "00000000-0000-4000-8000-000000000004",
  owner: "00000000-0000-4000-8000-000000000005",
  ownerPrincipal: "00000000-0000-4000-8000-000000000006",
  team: "00000000-0000-4000-8000-000000000007",
  workspace: "00000000-0000-4000-8000-000000000008",
  classifierGeneration: "00000000-0000-4000-8000-000000000009",
  classification: "00000000-0000-4000-8000-000000000010",
  shareGrant: "00000000-0000-4000-8000-000000000011",
  consent: "00000000-0000-4000-8000-000000000012",
  source: "00000000-0000-4000-8000-000000000013",
  deployment: "00000000-0000-4000-8000-000000000014",
  replica: "00000000-0000-4000-8000-000000000015",
  relationship: "00000000-0000-4000-8000-000000000016",
  sourceRevision: "00000000-0000-4000-8000-000000000017"
} as const;

const iso = "2026-08-13T00:00:00.000Z";
const classifierHash = "a".repeat(64);
const sourcePreviewHash = "b".repeat(64);
const sourceArtifactHash = "c".repeat(64);
const sourceManifestHash = "d".repeat(64);
const sourceHash = "e".repeat(64);
const sourceItemIdentityHash = "f".repeat(64);
const privateValues = [
  "GB82WEST12345698765432",
  "42-Example-Street",
  "alice@example.test",
  "Alice-Example",
  "+44-7700-900123",
  "https://private.example.test/account",
  "2026-08-13",
  "sk-test-abcdefghijklmnopqrstuvwxyz"
];
const plaintext = privateValues.join(" | ");

const item: SharedMemoryCanonicalSourceItemDto = {
  itemType: "user_message",
  schemaVersion: 1,
  sourceId: ids.source,
  sourceLogicalMemoryId: ids.logicalMemory,
  sourceRevision: 3,
  occurredAt: iso,
  content: { text: plaintext }
};
const classificationFields = extractSharedMemorySemanticClassificationFields([
  item
]);

const labelPolicy = (...enabled: PrivacyLabel[]): PrivacyLabelPolicy => {
  const labels = noPrivacyLabelsPolicy();
  for (const label of enabled) labels[label] = true;
  return labels;
};

const targetFor = (
  effectivePrivacyPolicyHash: string,
  id: string = ids.semantic
): SharedMemoryPendingSemanticTarget => ({
  id,
  sourcePreviewId: ids.preview,
  sourceArtifactId: ids.artifact,
  sourcePreviewRevision: 2,
  sourcePreviewHash,
  sourceArtifactHash,
  sourceManifestHash,
  sourceRevision: 3,
  sourceHash,
  logicalMemoryId: ids.logicalMemory,
  ownerUserId: ids.owner,
  ownerPrincipalId: ids.ownerPrincipal,
  teamId: ids.team,
  teamWorkspaceId: ids.workspace,
  representation: "memory_events",
  expectedManifestHash: null,
  expectedChunkCount: null,
  completedChunkCount: 0,
  resultManifestHash: null,
  classificationFieldCount: null,
  classificationByteCount: null,
  classifierGenerationId: ids.classifierGeneration,
  classifierVersion: 1,
  classifierHash,
  effectivePrivacyPolicyHash,
  sourceItemIdentityHash: null,
  sourceItemCount: null,
  sanitizedContentHash: null,
  payloadBindingHash: null,
  status: "pending",
  failureCode: null,
  lastErrorClass: null,
  attemptCount: 0,
  nextAttemptAt: null,
  schedulingClass: "foreground",
  workReason: "share_activation",
  eligibleAt: iso,
  enqueuedAt: iso,
  continuationChunkIndex: 0,
  createdAt: iso,
  updatedAt: iso,
  readyAt: null,
  failedAt: null,
  staleAt: null,
  invalidatedAt: null,
  invalidationReasonCode: null,
  shareGrantId: ids.shareGrant,
  consentId: ids.consent,
  grantVersion: 1
});

const loadedFor = (
  target: SharedMemoryPendingSemanticTarget
): SharedMemoryDecryptedSemanticTarget => ({
  target,
  preview: {
    source: {
      kind: "captured_session",
      sessionId: ids.source,
      logicalMemoryId: ids.logicalMemory
    },
    sourceRevisionId: ids.sourceRevision,
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: "memory_events",
    mode: "continuous",
    previewId: ids.preview,
    previewHash: sourcePreviewHash,
    artifactId: ids.artifact,
    artifactHash: sourceArtifactHash,
    logicalMemoryId: ids.logicalMemory,
    remoteReplicaId: ids.replica,
    ownerUserId: ids.owner,
    ownerPrincipalId: ids.ownerPrincipal,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    representation: "memory_events",
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    previewRevision: 2,
    binding: {} as never,
    items: [item],
    sourceContentHash: crossIdentitySyncDigest([item]),
    sourceRevision: 3,
    sourceHash,
    manifest: [],
    manifestHash: crossIdentitySyncDigest([]),
    syncRelationshipId: ids.relationship,
    deviceProvenanceHash: "1".repeat(64),
    createdAt: iso
  },
  sourceManifest: [{} as never],
  sourceItemIdentityHash,
  classificationFields
});

const classificationRecord = (
  id: string = ids.classification
): PrivacyClassificationResultRecord => ({
  id,
  ownerUserId: ids.owner,
  classifierGenerationId: ids.classifierGeneration,
  classifierHash,
  ownerContentFingerprint: "2".repeat(64),
  inputByteLength: Buffer.byteLength(plaintext),
  payloadBindingHash: "3".repeat(64),
  spanCount: privacyLabels.length,
  status: "ready",
  failureCode: null,
  createdAt: iso,
  readyAt: iso,
  invalidatedAt: null,
  invalidationReasonCode: null
});

const responseFor = (): PrivacyClassificationResponse => ({
  schemaVersion: 1,
  inputContractVersion: "koed-privacy-classification-v1",
  classifier: {
    classifierHash,
    modelKey: "privacy-model",
    modelRevision: "1"
  },
  fields: classificationFields.map((field) => {
    let cursor = 0;
    return {
      path: field.path,
      inputSha256: field.inputSha256,
      inputByteLength: field.inputByteLength,
      maskedText: field.text,
      decodedTextMatchesInput: true,
      spans: privacyLabels.map((label, index) => {
        const value = privateValues[index]!;
        const startByte = field.text.indexOf(value, cursor);
        cursor = startByte + value.length;
        return {
          label,
          startByte,
          endByte: cursor,
          detectors: ["privacy_filter" as const]
        };
      })
    };
  })
});

class WakeClient extends EventEmitter {
  readonly queries: string[] = [];
  released = false;

  async query(sql: string): Promise<void> {
    this.queries.push(sql);
  }

  override removeAllListeners(): this {
    return super.removeAllListeners();
  }

  release(): void {
    this.released = true;
  }
}

const flush = async (turns = 12): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const fixture = (input?: {
  cached?: boolean;
  classify?: (
    fields: Array<{ path: string; text: string }>
  ) => Promise<unknown>;
  policy?: PrivacyLabelPolicy;
  target?: SharedMemoryPendingSemanticTarget;
  listTargets?: () => Promise<SharedMemoryPendingSemanticTarget[]>;
  reconcileReady?: () => Promise<{ materialized: number; skipped: number }>;
  targetLimit?: number;
  loaded?: SharedMemoryDecryptedSemanticTarget;
  finalizationAvailable?: boolean;
  capabilities?: () => Promise<unknown>;
}) => {
  let policyLabels = input?.policy ?? labelPolicy("private_email");
  let target =
    input?.target ??
    targetFor(privacyContentPolicyHash({ labels: policyLabels }));
  let loadedOverride = input?.loaded;
  const storedInputs: Array<Record<string, unknown>> = [];
  const response = responseFor();
  const storedClassificationInputs: Array<{
    response: PrivacyClassificationResponse;
  }> = [];
  const classify = vi.fn(input?.classify ?? (async () => response));
  const cacheKey = (
    fields: Array<{ path: string; text: string }>,
    classifierIdentity = classifierHash
  ) => `${classifierIdentity}:${JSON.stringify(fields)}`;
  const classificationInputIdentity = vi.fn(
    (identityInput: { fields: Array<{ path: string; text: string }> }) =>
      createHash("sha256")
        .update(cacheKey(identityInput.fields, "owner-input"), "utf8")
        .digest("hex")
  );
  const cachedByKey = new Map<
    string,
    {
      record: PrivacyClassificationResultRecord;
      response: PrivacyClassificationResponse;
    }
  >();
  const cachedById = new Map<
    string,
    {
      record: PrivacyClassificationResultRecord;
      response: PrivacyClassificationResponse;
    }
  >();
  const cacheClassification = (
    fields: Array<{ path: string; text: string }>,
    classified: PrivacyClassificationResponse,
    record = classificationRecord(
      cachedById.size === 0 ? ids.classification : randomUUID()
    )
  ) => {
    const boundRecord = {
      ...record,
      classifierGenerationId: target.classifierGenerationId,
      classifierHash: classified.classifier.classifierHash,
      ownerContentFingerprint: classificationInputIdentity({ fields })
    };
    const entry = { record: boundRecord, response: classified };
    cachedByKey.set(
      cacheKey(fields, classified.classifier.classifierHash),
      entry
    );
    cachedById.set(boundRecord.id, entry);
    return boundRecord;
  };
  if (input?.cached) {
    cacheClassification(
      classificationFields.map(({ path, text }) => ({ path, text })),
      response
    );
  }
  const findCachedClassification = vi.fn(
    async (findInput: {
      classifierHash: string;
      fields: Array<{ path: string; text: string }>;
    }) =>
      cachedByKey.get(cacheKey(findInput.fields, findInput.classifierHash))
        ?.record ?? null
  );
  const storeClassificationResult = vi.fn(
    async (storeInput: {
      fields: Array<{ path: string; text: string }>;
      response: PrivacyClassificationResponse;
    }) => {
      storedClassificationInputs.push(storeInput);
      const existing = cachedByKey.get(
        cacheKey(
          storeInput.fields,
          storeInput.response.classifier.classifierHash
        )
      );
      return (
        existing?.record ??
        cacheClassification(storeInput.fields, storeInput.response)
      );
    }
  );
  const readClassificationResult = vi.fn(
    async (readInput: { resultId: string }) => {
      const cached = cachedById.get(readInput.resultId);
      return cached
        ? {
            record: cached.record,
            fields: cached.response.fields.map((field) => ({
              path: field.path,
              inputSha256: field.inputSha256,
              inputByteLength: field.inputByteLength,
              spans: field.spans
            }))
          }
        : null;
    }
  );
  const listPendingSemanticPrivacyTargets = vi.fn(
    input?.listTargets ?? (async () => [target])
  );
  const readPendingSemanticPrivacyTarget = vi.fn<
    SharedMemoryRepository["readPendingSemanticPrivacyTarget"]
  >(async () => loadedOverride ?? loadedFor(target));
  const claim = {
    semanticPreviewId: target.id,
    workIdentity: "9".repeat(64),
    claimantId: "test-worker",
    claimGeneration: 1,
    claimToken: "00000000-0000-4000-8000-000000000018",
    expiresAt: "2026-08-13T00:02:00.000Z"
  };
  let manifest: Array<Record<string, unknown>> = [];
  const claimSemanticPrivacyTarget = vi.fn<
    SharedMemoryRepository["claimSemanticPrivacyTarget"]
  >(async () => ({ ...claim }));
  const renewSemanticPrivacyClaim = vi.fn<
    SharedMemoryRepository["renewSemanticPrivacyClaim"]
  >(async () => ({ ...claim }));
  const releaseSemanticPrivacyClaim = vi.fn<
    SharedMemoryRepository["releaseSemanticPrivacyClaim"]
  >(async () => true);
  const initializeSemanticPrivacyManifest = vi.fn<
    SharedMemoryRepository["initializeSemanticPrivacyManifest"]
  >(async (_actor, initializeInput) => {
    if (manifest.length === 0) {
      manifest = initializeInput.chunks.map((chunk) => ({
        id: randomUUID(),
        semanticPreviewId: target.id,
        ...chunk,
        classificationResultId: null,
        classificationPayloadBindingHash: null,
        status: "pending",
        createdAt: iso,
        readyAt: null
      }));
    }
    return manifest as never;
  });
  const attachSemanticPrivacyChunkResult = vi.fn<
    SharedMemoryRepository["attachSemanticPrivacyChunkResult"]
  >(async (_actor, attachInput) => {
    const entry = manifest[attachInput.chunkIndex]!;
    Object.assign(entry, {
      classificationResultId: attachInput.classificationResultId,
      classificationPayloadBindingHash:
        attachInput.classificationPayloadBindingHash,
      status: "ready",
      readyAt: iso
    });
    return entry as never;
  });
  const listSemanticPrivacyManifest = vi.fn<
    SharedMemoryRepository["listSemanticPrivacyManifest"]
  >(async () => manifest as never);
  const storeSanitizedSemanticPreview = vi.fn(async (_actor, storeInput) => {
    storedInputs.push(storeInput as unknown as Record<string, unknown>);
    return {
      ...target,
      sourceItemIdentityHash: storeInput.expectedSourceItemIdentityHash,
      sourceItemCount: (storeInput.items as unknown[]).length,
      sanitizedContentHash: storeInput.sanitizedContentHash,
      expectedManifestHash: storeInput.expectedManifestHash,
      expectedChunkCount: manifest.length,
      completedChunkCount: manifest.length,
      resultManifestHash: storeInput.expectedResultManifestHash,
      status: "ready"
    } as never;
  });
  const markSemanticPrivacyTargetFailed = vi.fn(async () => true);
  const deferSemanticPrivacyTarget = vi.fn(
    async (): Promise<string | null> => null
  );
  const getNextSemanticPrivacyWorkAt = vi.fn(
    async (): Promise<string | null> => null
  );
  const releaseFinalizationLease = vi.fn(async () => undefined);
  const tryAcquireSemanticPrivacyFinalizationLease = vi.fn(async () =>
    input?.finalizationAvailable === false
      ? null
      : { release: releaseFinalizationLease }
  );
  const invalidateStaleSemanticPreviews = vi.fn(async () => ({
    invalidated: 0
  }));
  const reconcileReadySemanticRepresentations = vi.fn(
    input?.reconcileReady ??
      (async () => ({
        materialized: 1,
        skipped: 0
      }))
  );
  const wakeClient = new WakeClient();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const capabilities = vi.fn(input?.capabilities ?? (async () => ({})));
  let activeClassifier = {
    id: ids.classifierGeneration as string,
    version: 1,
    classifierHash,
    modelKey: "privacy-model",
    modelRevision: "1",
    artifactSha256: "1".repeat(64),
    tokenizerSha256: "2".repeat(64),
    decoderSha256: "3".repeat(64),
    calibrationSha256: "4".repeat(64),
    deterministicDetectorVersion: "structured-secrets-v1",
    inputContractVersion: "koed-privacy-classification-v1",
    status: "active" as const,
    createdAt: iso,
    activatedAt: iso,
    retiredAt: null,
    revokedAt: null,
    revocationReasonCode: null
  };
  const getActiveClassifierGeneration = vi.fn(async () => activeClassifier);
  const classificationEncryptionProvider =
    createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );
  const createService = () =>
    createSharedMemoryPrivacyMaterializationService({
      sharedMemoryRepository: {
        listPendingSemanticPrivacyTargets,
        readPendingSemanticPrivacyTarget,
        claimSemanticPrivacyTarget,
        renewSemanticPrivacyClaim,
        releaseSemanticPrivacyClaim,
        initializeSemanticPrivacyManifest,
        attachSemanticPrivacyChunkResult,
        listSemanticPrivacyManifest,
        storeSanitizedSemanticPreview,
        markSemanticPrivacyTargetFailed,
        deferSemanticPrivacyTarget,
        getNextSemanticPrivacyWorkAt,
        tryAcquireSemanticPrivacyFinalizationLease,
        invalidateStaleSemanticPreviews,
        reconcileReadySemanticRepresentations
      },
      privacyRepository: {
        getActiveClassifierGeneration,
        getLocalDeploymentIdentityId: vi.fn(async () => ids.deployment),
        resolveEffectiveContentPolicy: vi.fn(async () => ({
          labels: policyLabels,
          effectivePolicyHash: privacyContentPolicyHash({
            labels: policyLabels
          }),
          policies: []
        })),
        classificationInputIdentity,
        findCachedClassification,
        storeClassificationResult,
        readClassificationResult
      },
      privacyService: {
        capabilities: capabilities as never,
        classify: classify as never
      },
      classificationEncryptionProvider,
      wakePool: { connect: vi.fn(async () => wakeClient) },
      logger,
      targetLimit: input?.targetLimit
    });
  const service = createService();
  return {
    service,
    restartService: createService,
    capabilities,
    classify,
    findCachedClassification,
    storeClassificationResult,
    listPendingSemanticPrivacyTargets,
    readPendingSemanticPrivacyTarget,
    claimSemanticPrivacyTarget,
    renewSemanticPrivacyClaim,
    releaseSemanticPrivacyClaim,
    initializeSemanticPrivacyManifest,
    attachSemanticPrivacyChunkResult,
    listSemanticPrivacyManifest,
    storeSanitizedSemanticPreview,
    markSemanticPrivacyTargetFailed,
    deferSemanticPrivacyTarget,
    getNextSemanticPrivacyWorkAt,
    tryAcquireSemanticPrivacyFinalizationLease,
    releaseFinalizationLease,
    invalidateStaleSemanticPreviews,
    reconcileReadySemanticRepresentations,
    storedInputs,
    wakeClient,
    logger,
    setClassifier(next: {
      id: string;
      classifierHash: string;
      modelKey?: string;
      modelRevision?: string;
    }) {
      activeClassifier = {
        ...activeClassifier,
        id: next.id,
        classifierHash: next.classifierHash,
        modelKey: next.modelKey ?? activeClassifier.modelKey,
        modelRevision: next.modelRevision ?? activeClassifier.modelRevision
      };
    },
    setTarget(
      nextTarget: SharedMemoryPendingSemanticTarget,
      loaded?: SharedMemoryDecryptedSemanticTarget
    ) {
      target = nextTarget;
      loadedOverride = loaded;
      manifest = [];
    },
    setPolicy(labels: PrivacyLabelPolicy) {
      policyLabels = labels;
      target = targetFor(
        privacyContentPolicyHash({ labels }),
        "00000000-0000-4000-8000-000000000017"
      );
      loadedOverride = undefined;
      manifest = [];
    }
  };
};

describe("Shared Memory privacy materialization service", () => {
  it("invalidates stale Team previews before Privacy Service preflight", async () => {
    const unavailable = new PrivacyServiceUnavailableError(
      "Privacy Service unavailable"
    );
    const state = fixture({
      capabilities: async () => {
        throw unavailable;
      }
    });
    state.invalidateStaleSemanticPreviews.mockResolvedValueOnce({
      invalidated: 1
    });

    await expect(state.service.processOnce()).rejects.toBe(unavailable);

    expect(state.invalidateStaleSemanticPreviews).toHaveBeenCalledOnce();
    expect(state.capabilities).toHaveBeenCalledOnce();
    expect(
      state.invalidateStaleSemanticPreviews.mock.invocationCallOrder[0]
    ).toBeLessThan(state.capabilities.mock.invocationCallOrder[0]!);
    expect(state.listPendingSemanticPrivacyTargets).not.toHaveBeenCalled();
  });

  it("uses an exact cached classification and applies policy after classification", async () => {
    const state = fixture({ cached: true });

    await expect(state.service.processOnce()).resolves.toMatchObject({
      processed: 1,
      invalidatedStale: 0,
      classifierCacheHits: 1,
      classifierInferenceCalls: 0,
      remaskedTargets: 1,
      ready: 1,
      materialized: 1,
      materializationSkipped: 0,
      failed: 0,
      yielded: 0,
      chunksAttached: 1,
      resumedChunks: 0,
      classifiedBytes: 0
    });

    expect(state.classify).not.toHaveBeenCalled();
    expect(state.findCachedClassification).toHaveBeenCalledWith({
      actor: { userId: ids.owner },
      classifierHash,
      fields: classificationFields.map(({ path, text }) => ({ path, text }))
    });
    expect(state.storedInputs[0]?.items).toMatchObject([
      {
        content: {
          text: privateValues
            .map((value, index) => (index === 2 ? "[PRIVATE_EMAIL]" : value))
            .join(" | ")
        }
      }
    ]);
  });

  it("defers final publication when the deployment-wide finalization slot is occupied", async () => {
    const state = fixture({ cached: true, finalizationAvailable: false });

    await expect(state.service.processOnce()).resolves.toMatchObject({
      processed: 1,
      ready: 0,
      failed: 0
    });
    expect(state.storeSanitizedSemanticPreview).not.toHaveBeenCalled();
    expect(state.markSemanticPrivacyTargetFailed).not.toHaveBeenCalled();
    expect(state.releaseSemanticPrivacyClaim).toHaveBeenCalledWith(
      { userId: ids.owner },
      expect.objectContaining({ completed: false })
    );
  });

  it("preserves the finalization contention wake when no durable retry exists", async () => {
    vi.useFakeTimers();
    try {
      const state = fixture({ cached: true });
      state.tryAcquireSemanticPrivacyFinalizationLease
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ release: state.releaseFinalizationLease });

      state.service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        state.tryAcquireSemanticPrivacyFinalizationLease
      ).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(
        state.tryAcquireSemanticPrivacyFinalizationLease
      ).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        state.tryAcquireSemanticPrivacyFinalizationLease
      ).toHaveBeenCalledTimes(2);

      await state.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies every field once, caches all eight labels, then stores the sanitized preview", async () => {
    const state = fixture();

    await expect(state.service.processOnce()).resolves.toMatchObject({
      classifierCacheHits: 0,
      classifierInferenceCalls: 1,
      remaskedTargets: 0,
      ready: 1,
      failed: 0
    });

    expect(state.classify).toHaveBeenCalledOnce();
    expect(state.classify).toHaveBeenCalledWith(
      classificationFields.map(({ path, text }) => ({ path, text }))
    );
    const storedResponse = state.storeClassificationResult.mock.calls[0]?.[0]
      .response as PrivacyClassificationResponse;
    expect(
      new Set(
        storedResponse.fields.flatMap((field) =>
          field.spans.map((span) => span.label)
        )
      )
    ).toEqual(new Set(privacyLabels));
  });

  it("heartbeats the claim while classifier inference is in flight", async () => {
    vi.useFakeTimers();
    try {
      let resolveClassification!: (value: unknown) => void;
      const classification = new Promise<unknown>((resolve) => {
        resolveClassification = resolve;
      });
      const state = fixture({ classify: async () => classification });
      const processing = state.service.processOnce();
      await flush();
      expect(state.classify).toHaveBeenCalledOnce();
      const renewalsBeforeHeartbeat =
        state.renewSemanticPrivacyClaim.mock.calls.length;

      await vi.advanceTimersByTimeAsync(40_000);
      expect(state.renewSemanticPrivacyClaim.mock.calls.length).toBeGreaterThan(
        renewalsBeforeHeartbeat
      );

      resolveClassification(responseFor());
      await expect(processing).resolves.toMatchObject({ ready: 1, failed: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("yields without terminal failure when claim renewal loses its fence", async () => {
    const state = fixture();
    state.renewSemanticPrivacyClaim.mockResolvedValueOnce(null);

    await expect(state.service.processOnce()).resolves.toMatchObject({
      processed: 1,
      ready: 0,
      failed: 0,
      yielded: 1
    });
    expect(state.classify).not.toHaveBeenCalled();
    expect(state.markSemanticPrivacyTargetFailed).not.toHaveBeenCalled();
  });

  it("classifies a 129-field preview in contract-sized batches", async () => {
    const largeItems: SharedMemoryCanonicalSourceItemDto[] = Array.from(
      { length: 129 },
      (_, index) => ({
        ...item,
        sourceId: randomUUID(),
        content: { text: `ordinary value ${index}` }
      })
    );
    const largeFields = extractSharedMemorySemanticClassificationFields([
      ...largeItems
    ]);
    expect(largeFields).toHaveLength(129);
    const target = targetFor(
      privacyContentPolicyHash({ labels: labelPolicy("private_email") })
    );
    const loaded: SharedMemoryDecryptedSemanticTarget = {
      ...loadedFor(target),
      preview: {
        ...loadedFor(target).preview,
        items: largeItems,
        sourceContentHash: crossIdentitySyncDigest(largeItems)
      },
      sourceManifest: Array.from(
        { length: largeItems.length },
        () => ({}) as never
      ),
      classificationFields: largeFields
    };
    const state = fixture({
      target,
      loaded,
      classify: async () => {
        throw new Error("test classifier must receive its batch");
      }
    });
    state.classify.mockImplementation(
      async (batch: Array<{ path: string; text: string }>) => ({
        schemaVersion: 1,
        inputContractVersion: "koed-privacy-classification-v1",
        classifier: {
          classifierHash,
          modelKey: "privacy-model",
          modelRevision: "1"
        },
        fields: batch.map((field) => ({
          path: field.path,
          inputSha256: createHash("sha256").update(field.text).digest("hex"),
          inputByteLength: Buffer.byteLength(field.text),
          maskedText: field.text,
          spans: [],
          decodedTextMatchesInput: true as const
        }))
      })
    );
    state.findCachedClassification.mockResolvedValue(null);

    const result = await state.service.processOnce();
    expect(state.logger.warn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      classifierInferenceCalls: 2,
      ready: 1,
      failed: 0
    });
    expect(state.classify.mock.calls.map(([batch]) => batch.length)).toEqual([
      128, 1
    ]);
    const storedChunkSizes = state.storeClassificationResult.mock.calls.map(
      ([storeInput]) => storeInput.response.fields.length
    );
    expect(storedChunkSizes).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 1]);
    expect(storedChunkSizes.reduce((total, size) => total + size, 0)).toBe(129);
  });

  it("assembles one cache chunk split across transport byte limits before attaching it", async () => {
    const largeItems: SharedMemoryCanonicalSourceItemDto[] = Array.from(
      { length: 16 },
      (_, index) => ({
        ...item,
        sourceId: randomUUID(),
        content: { text: String(index).padEnd(256 * 1_024, "x") }
      })
    );
    const target = targetFor(
      privacyContentPolicyHash({ labels: labelPolicy("private_email") })
    );
    const loaded: SharedMemoryDecryptedSemanticTarget = {
      ...loadedFor(target),
      preview: {
        ...loadedFor(target).preview,
        items: largeItems,
        sourceContentHash: crossIdentitySyncDigest(largeItems)
      },
      sourceManifest: largeItems.map(() => ({}) as never),
      classificationFields:
        extractSharedMemorySemanticClassificationFields(largeItems)
    };
    const state = fixture({
      target,
      loaded,
      classify: async (batch) => ({
        schemaVersion: 1,
        inputContractVersion: "koed-privacy-classification-v1",
        classifier: {
          classifierHash,
          modelKey: "privacy-model",
          modelRevision: "1"
        },
        fields: batch.map((field) => ({
          path: field.path,
          inputSha256: createHash("sha256").update(field.text).digest("hex"),
          inputByteLength: Buffer.byteLength(field.text),
          maskedText: field.text,
          spans: [],
          decodedTextMatchesInput: true as const
        }))
      })
    });
    state.findCachedClassification.mockResolvedValue(null);

    await expect(state.service.processOnce()).resolves.toMatchObject({
      classifierInferenceCalls: 4,
      cacheChunks: 1,
      chunksAttached: 1,
      ready: 1,
      failed: 0
    });
    expect(state.classify.mock.calls.map(([batch]) => batch.length)).toEqual([
      4, 4, 4, 4
    ]);
    expect(state.storeClassificationResult).toHaveBeenCalledOnce();
  });

  it("persists and resumes a preview above the former aggregate field limit", async () => {
    const largeItems: SharedMemoryCanonicalSourceItemDto[] = Array.from(
      { length: 1_025 },
      (_, index) => ({
        ...item,
        itemType: "tool_call" as const,
        sourceId: randomUUID(),
        content: {
          toolName: `tool_${index}`,
          toolCallId: null,
          payload: { value: `bounded field ${index}` }
        }
      })
    );
    const target = targetFor(
      privacyContentPolicyHash({ labels: labelPolicy("private_email") })
    );
    const loaded: SharedMemoryDecryptedSemanticTarget = {
      ...loadedFor(target),
      preview: {
        ...loadedFor(target).preview,
        items: largeItems,
        sourceContentHash: crossIdentitySyncDigest(largeItems)
      },
      sourceManifest: largeItems.map(() => ({}) as never),
      classificationFields:
        extractSharedMemorySemanticClassificationFields(largeItems)
    };
    const state = fixture({ target, loaded });
    state.findCachedClassification.mockResolvedValue(null);
    state.classify.mockImplementation(
      async (batch: Array<{ path: string; text: string }>) => ({
        schemaVersion: 1,
        inputContractVersion: "koed-privacy-classification-v1",
        classifier: {
          classifierHash,
          modelKey: "privacy-model",
          modelRevision: "1"
        },
        fields: batch.map((field) => ({
          path: field.path,
          inputSha256: createHash("sha256").update(field.text).digest("hex"),
          inputByteLength: Buffer.byteLength(field.text),
          maskedText: field.text,
          spans: [],
          decodedTextMatchesInput: true as const
        }))
      })
    );

    const passes = [];
    let service = state.service;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await service.processOnce();
      passes.push(result);
      if (result.ready === 1) break;
      service = state.restartService();
    }

    expect(passes.length).toBeGreaterThan(1);
    expect(passes.at(-1)).toMatchObject({ ready: 1, yielded: 0, failed: 0 });
    expect(passes.slice(0, -1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ready: 0, yielded: 1, failed: 0 })
      ])
    );
    const requestSizes = state.classify.mock.calls.map(
      ([batch]) => batch.length
    );
    expect(Math.max(...requestSizes)).toBe(128);
    expect(requestSizes.reduce((total, size) => total + size, 0)).toBe(
      loaded.classificationFields.length
    );
    expect(state.storeSanitizedSemanticPreview).toHaveBeenCalledOnce();
  });

  it.runIf(process.env.KOED_RUN_PRIVACY_CAPACITY_TESTS === "1")(
    "measures bounded finalization for a maximum-size semantic preview",
    async () => {
      const fieldCount =
        SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES /
        SHARED_MEMORY_SEMANTIC_FIELD_MAX_BYTES;
      const largeItems: SharedMemoryCanonicalSourceItemDto[] = Array.from(
        { length: fieldCount },
        (_, index) => {
          const suffix = index.toString().padStart(8, "0");
          return {
            ...item,
            sourceId: randomUUID(),
            content: {
              text: `${"x".repeat(
                SHARED_MEMORY_SEMANTIC_FIELD_MAX_BYTES - suffix.length
              )}${suffix}`
            }
          };
        }
      );
      const target = targetFor(
        privacyContentPolicyHash({ labels: noPrivacyLabelsPolicy() })
      );
      const base = loadedFor(target);
      const loaded: SharedMemoryDecryptedSemanticTarget = {
        ...base,
        preview: {
          ...base.preview,
          items: largeItems,
          sourceContentHash: crossIdentitySyncDigest(largeItems)
        },
        sourceManifest: largeItems.map(() => ({}) as never),
        classificationFields:
          extractSharedMemorySemanticClassificationFields(largeItems)
      };
      const state = fixture({
        policy: noPrivacyLabelsPolicy(),
        target,
        loaded,
        classify: async (batch) => ({
          schemaVersion: 1,
          inputContractVersion: "koed-privacy-classification-v1",
          classifier: {
            classifierHash,
            modelKey: "privacy-model",
            modelRevision: "1"
          },
          fields: batch.map((field) => ({
            path: field.path,
            inputSha256: createHash("sha256").update(field.text).digest("hex"),
            inputByteLength: Buffer.byteLength(field.text),
            maskedText: field.text,
            decodedTextMatchesInput: true,
            spans: []
          }))
        })
      });

      let result = await state.service.processOnce();
      for (let pass = 1; result.ready === 0 && pass < 100; pass += 1) {
        result = await state.restartService().processOnce();
      }

      expect(result).toMatchObject({ ready: 1, failed: 0 });
      expect(result.maxFinalizationHeapDeltaBytes).toBeGreaterThan(0);
      process.stdout.write(
        `[privacy-capacity] finalizationHeapDeltaBytes=${result.maxFinalizationHeapDeltaBytes}\n`
      );
    },
    120_000
  );

  it("lets a small target finish while an earlier large target yields", async () => {
    const buildLoaded = (
      target: SharedMemoryPendingSemanticTarget,
      count: number,
      prefix: string
    ): SharedMemoryDecryptedSemanticTarget => {
      const items: SharedMemoryCanonicalSourceItemDto[] = Array.from(
        { length: count },
        (_, index) => ({
          ...item,
          itemType: "tool_call" as const,
          sourceId: randomUUID(),
          content: {
            toolName: `${prefix}_tool_${index}`,
            toolCallId: null,
            payload: { value: `${prefix} value ${index}` }
          }
        })
      );
      const base = loadedFor(target);
      return {
        ...base,
        preview: {
          ...base.preview,
          items,
          sourceContentHash: crossIdentitySyncDigest(items)
        },
        sourceManifest: items.map(() => ({}) as never),
        classificationFields:
          extractSharedMemorySemanticClassificationFields(items)
      };
    };
    const largeTarget = targetFor(
      privacyContentPolicyHash({ labels: labelPolicy("private_email") }),
      randomUUID()
    );
    const smallTarget = {
      ...targetFor(
        privacyContentPolicyHash({ labels: labelPolicy("private_email") }),
        randomUUID()
      ),
      id: randomUUID()
    };
    const loadedById = new Map([
      [largeTarget.id, buildLoaded(largeTarget, 1_025, "large")],
      [smallTarget.id, buildLoaded(smallTarget, 1, "small")]
    ]);
    const state = fixture({
      target: largeTarget,
      loaded: loadedById.get(largeTarget.id),
      listTargets: async () => [largeTarget, smallTarget],
      targetLimit: 2
    });
    const manifests = new Map<string, Array<Record<string, unknown>>>();
    state.readPendingSemanticPrivacyTarget.mockImplementation(
      async (_actor, input) => loadedById.get(input.semanticPreviewId) ?? null
    );
    state.claimSemanticPrivacyTarget.mockImplementation(
      async (_actor, input) => ({
        semanticPreviewId: input.semanticPreviewId,
        workIdentity: input.expectedWorkIdentity,
        claimantId: input.claimantId,
        claimGeneration: 1,
        claimToken: randomUUID(),
        expiresAt: iso
      })
    );
    state.renewSemanticPrivacyClaim.mockImplementation(
      async (_actor, input) => ({ ...input, expiresAt: iso })
    );
    state.initializeSemanticPrivacyManifest.mockImplementation(
      async (_actor, input) => {
        let entries = manifests.get(input.claim.semanticPreviewId);
        if (!entries) {
          const initialized = input.chunks.map((chunk) => ({
            id: randomUUID(),
            semanticPreviewId: input.claim.semanticPreviewId,
            ...chunk,
            classificationResultId: null,
            classificationPayloadBindingHash: null,
            status: "pending",
            createdAt: iso,
            readyAt: null
          }));
          manifests.set(input.claim.semanticPreviewId, initialized);
          entries = initialized;
        }
        return entries! as never;
      }
    );
    state.attachSemanticPrivacyChunkResult.mockImplementation(
      async (_actor, input) => {
        const entry = manifests.get(input.claim.semanticPreviewId)![
          input.chunkIndex
        ]!;
        Object.assign(entry, {
          classificationResultId: input.classificationResultId,
          classificationPayloadBindingHash:
            input.classificationPayloadBindingHash,
          status: "ready",
          readyAt: iso
        });
        return entry as never;
      }
    );
    state.listSemanticPrivacyManifest.mockImplementation(
      async (_actor, input) =>
        (manifests.get(input.claim.semanticPreviewId) ?? []) as never
    );
    state.storeSanitizedSemanticPreview.mockImplementation(
      async (_actor, input) => {
        const target = [largeTarget, smallTarget].find(
          (candidate) => candidate.id === input.semanticPreviewId
        )!;
        const manifest = manifests.get(target.id)!;
        return {
          ...target,
          sourceItemIdentityHash: input.expectedSourceItemIdentityHash,
          sourceItemCount: input.items.length,
          sanitizedContentHash: input.sanitizedContentHash,
          expectedManifestHash: input.expectedManifestHash,
          expectedChunkCount: manifest.length,
          completedChunkCount: manifest.length,
          resultManifestHash: input.expectedResultManifestHash,
          status: "ready"
        } as never;
      }
    );
    state.findCachedClassification.mockResolvedValue(null);
    state.classify.mockImplementation(async (batch) => ({
      schemaVersion: 1,
      inputContractVersion: "koed-privacy-classification-v1",
      classifier: {
        classifierHash,
        modelKey: "privacy-model",
        modelRevision: "1"
      },
      fields: batch.map((field) => ({
        path: field.path,
        inputSha256: createHash("sha256").update(field.text).digest("hex"),
        inputByteLength: Buffer.byteLength(field.text),
        maskedText: field.text,
        spans: [],
        decodedTextMatchesInput: true as const
      }))
    }));

    await expect(state.service.processOnce()).resolves.toMatchObject({
      processed: 2,
      yielded: 1,
      ready: 1,
      failed: 0
    });
    expect(state.storeSanitizedSemanticPreview).toHaveBeenCalledOnce();
    expect(state.storeSanitizedSemanticPreview).toHaveBeenCalledWith(
      { userId: ids.owner },
      expect.objectContaining({ semanticPreviewId: smallTarget.id })
    );
  });

  it.each([
    ["memory_events", "user_message", "text"],
    ["lcm_leaves", "lcm_leaf", "summaryText"],
    ["lcm_rollups", "lcm_rollup", "summaryText"]
  ] as const)(
    "reuses unchanged classification batches when %s advances",
    async (representation, itemType, textField) => {
      const buildLoaded = (
        target: SharedMemoryPendingSemanticTarget,
        count: number
      ): SharedMemoryDecryptedSemanticTarget => {
        const items: SharedMemoryCanonicalSourceItemDto[] = Array.from(
          { length: count },
          (_, index) => ({
            ...item,
            itemType,
            sourceId: randomUUID(),
            content:
              representation === "memory_events"
                ? { [textField]: `stable semantic value ${index}` }
                : {
                    [textField]: `stable semantic value ${index}`,
                    lexicalAnchors: [],
                    sourceIds: [ids.source]
                  }
          })
        );
        const base = loadedFor(target);
        return {
          ...base,
          preview: {
            ...base.preview,
            representation,
            items,
            sourceContentHash: crossIdentitySyncDigest(items)
          },
          sourceManifest: Array.from(
            { length: items.length },
            () => ({}) as never
          ),
          classificationFields:
            extractSharedMemorySemanticClassificationFields(items)
        };
      };
      const firstTarget = {
        ...targetFor(
          privacyContentPolicyHash({ labels: labelPolicy("private_email") }),
          randomUUID()
        ),
        representation
      };
      const state = fixture({
        target: firstTarget,
        loaded: buildLoaded(firstTarget, 129)
      });
      state.classify.mockImplementation(
        async (batch: Array<{ path: string; text: string }>) => ({
          schemaVersion: 1,
          inputContractVersion: "koed-privacy-classification-v1",
          classifier: {
            classifierHash,
            modelKey: "privacy-model",
            modelRevision: "1"
          },
          fields: batch.map((field) => ({
            path: field.path,
            inputSha256: createHash("sha256").update(field.text).digest("hex"),
            inputByteLength: Buffer.byteLength(field.text),
            maskedText: field.text,
            spans: [],
            decodedTextMatchesInput: true as const
          }))
        })
      );

      await expect(state.service.processOnce()).resolves.toMatchObject({
        classifierInferenceCalls: 2,
        ready: 1,
        failed: 0
      });
      state.classify.mockClear();

      const nextTarget = {
        ...firstTarget,
        id: randomUUID()
      };
      state.setTarget(nextTarget, buildLoaded(nextTarget, 130));
      await expect(state.service.processOnce()).resolves.toMatchObject({
        classifierCacheHits: 8,
        classifierInferenceCalls: 1,
        ready: 1,
        failed: 0
      });
      expect(state.classify).toHaveBeenCalledOnce();
      expect(state.classify.mock.calls[0]?.[0]).toHaveLength(2);
    }
  );

  it("preserves the complete Personal source while sanitizing all eight labels for Team materialization", async () => {
    const originalPersonalItem = structuredClone(item);
    const state = fixture({ policy: labelPolicy(...privacyLabels) });

    await expect(state.service.processOnce()).resolves.toMatchObject({
      classifierInferenceCalls: 1,
      ready: 1,
      materialized: 1,
      failed: 0
    });

    expect(item).toEqual(originalPersonalItem);
    expect(item.content).toEqual({ text: plaintext });

    const storedTeamItems = state.storedInputs[0]?.items as
      | Array<{ content: { text: string } }>
      | undefined;
    const teamText = storedTeamItems?.[0]?.content.text;
    expect(teamText).toBe(
      privacyLabels.map((label) => `[${label.toUpperCase()}]`).join(" | ")
    );
    for (const privateValue of privateValues) {
      expect(teamText).not.toContain(privateValue);
    }
  });

  it("remasks a policy-only change from cached spans without another inference", async () => {
    const state = fixture();
    await state.service.processOnce();

    state.setPolicy(labelPolicy("secret"));
    await expect(state.service.processOnce()).resolves.toMatchObject({
      classifierCacheHits: 1,
      classifierInferenceCalls: 0,
      remaskedTargets: 1,
      ready: 1,
      failed: 0
    });

    expect(state.classify).toHaveBeenCalledOnce();
    expect(state.storedInputs.at(-1)?.items).toMatchObject([
      {
        content: {
          text: privateValues
            .map((value, index) => (index === 7 ? "[SECRET]" : value))
            .join(" | ")
        }
      }
    ]);
  });

  it("reclassifies unchanged source fields after the classifier contract changes", async () => {
    const state = fixture();
    await expect(state.service.processOnce()).resolves.toMatchObject({
      classifierInferenceCalls: 1,
      ready: 1
    });

    const nextClassifierHash = "e".repeat(64);
    const nextTarget = {
      ...targetFor(
        privacyContentPolicyHash({ labels: labelPolicy("private_email") }),
        randomUUID()
      ),
      classifierGenerationId: randomUUID(),
      classifierHash: nextClassifierHash
    };
    state.setTarget(nextTarget, loadedFor(nextTarget));
    state.setClassifier({
      id: nextTarget.classifierGenerationId,
      classifierHash: nextClassifierHash
    });
    state.classify.mockImplementation(async (batch) => ({
      schemaVersion: 1,
      inputContractVersion: "koed-privacy-classification-v1",
      classifier: {
        classifierHash: nextClassifierHash,
        modelKey: "privacy-model",
        modelRevision: "1"
      },
      fields: batch.map((field) => ({
        path: field.path,
        inputSha256: createHash("sha256").update(field.text).digest("hex"),
        inputByteLength: Buffer.byteLength(field.text),
        maskedText: field.text,
        spans: [],
        decodedTextMatchesInput: true as const
      }))
    }));

    await expect(state.service.processOnce()).resolves.toMatchObject({
      classifierCacheHits: 0,
      classifierInferenceCalls: 1,
      ready: 1,
      failed: 0
    });
    expect(state.classify).toHaveBeenCalledTimes(2);
  });

  it("marks malformed classifier output failed and emits no plaintext telemetry", async () => {
    const secretText = plaintext;
    const state = fixture({
      classify: async () => ({ fields: [{ path: secretText }] })
    });

    await expect(state.service.processOnce()).resolves.toMatchObject({
      processed: 1,
      ready: 0,
      failed: 1
    });

    expect(state.storeSanitizedSemanticPreview).not.toHaveBeenCalled();
    expect(state.markSemanticPrivacyTargetFailed).toHaveBeenCalledWith(
      { userId: ids.owner },
      expect.objectContaining({
        semanticPreviewId: ids.semantic,
        expectedSourceItemIdentityHash: sourceItemIdentityHash,
        failureCode: "shared_memory_privacy_classifier_contract_error"
      })
    );
    expect(JSON.stringify(state.logger.warn.mock.calls)).not.toContain(
      secretText
    );
    expect(state.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorClass: "shared_memory_privacy_classifier_contract_error",
        failedChunkIndex: 0,
        resourceLimit: null
      }),
      "Shared Memory privacy materialization failed closed"
    );
    expect(JSON.stringify(state.logger.info.mock.calls)).not.toContain(
      secretText
    );
  });

  it("logs a lifecycle transition failure without leaking source text", async () => {
    const state = fixture({
      classify: async () => ({ fields: [{ path: plaintext }] })
    });
    state.markSemanticPrivacyTargetFailed.mockRejectedValue(
      new Error("repository transition failed")
    );

    await expect(state.service.processOnce()).resolves.toMatchObject({
      processed: 1,
      ready: 0,
      failed: 1
    });
    expect(state.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          name: "worker.shared_memory_privacy_materialization.failure_transition_failed"
        }),
        materializationErrorClass:
          "shared_memory_privacy_classifier_contract_error"
      }),
      expect.any(String)
    );
    expect(JSON.stringify(state.logger.warn.mock.calls)).not.toContain(
      plaintext
    );
  });

  it("defers a transient classifier outage without terminally failing the preview", async () => {
    const state = fixture({
      classify: async () => {
        throw new PrivacyServiceUnavailableError();
      }
    });
    state.deferSemanticPrivacyTarget.mockResolvedValue(
      "2026-08-13T00:00:05.000Z"
    );

    await expect(state.service.processOnce()).resolves.toMatchObject({
      processed: 1,
      ready: 0,
      failed: 0
    });

    expect(state.deferSemanticPrivacyTarget).toHaveBeenCalledWith(
      { userId: ids.owner },
      expect.objectContaining({
        semanticPreviewId: ids.semantic,
        errorClass: "privacy_service_unavailable_error"
      })
    );
    expect(state.markSemanticPrivacyTargetFailed).not.toHaveBeenCalled();
  });

  it("persists completed cache chunks before retrying a later transient transport failure", async () => {
    const largeItems: SharedMemoryCanonicalSourceItemDto[] = Array.from(
      { length: 129 },
      (_, index) => ({
        ...item,
        sourceId: randomUUID(),
        content: { text: `retry-safe value ${index}` }
      })
    );
    const target = targetFor(
      privacyContentPolicyHash({ labels: labelPolicy("private_email") })
    );
    const loaded: SharedMemoryDecryptedSemanticTarget = {
      ...loadedFor(target),
      preview: {
        ...loadedFor(target).preview,
        items: largeItems,
        sourceContentHash: crossIdentitySyncDigest(largeItems)
      },
      sourceManifest: largeItems.map(() => ({}) as never),
      classificationFields:
        extractSharedMemorySemanticClassificationFields(largeItems)
    };
    let call = 0;
    const state = fixture({
      target,
      loaded,
      classify: async (batch) => {
        call += 1;
        if (call === 2) throw new PrivacyServiceUnavailableError();
        return {
          schemaVersion: 1,
          inputContractVersion: "koed-privacy-classification-v1",
          classifier: {
            classifierHash,
            modelKey: "privacy-model",
            modelRevision: "1"
          },
          fields: batch.map((field) => ({
            path: field.path,
            inputSha256: createHash("sha256").update(field.text).digest("hex"),
            inputByteLength: Buffer.byteLength(field.text),
            maskedText: field.text,
            spans: [],
            decodedTextMatchesInput: true as const
          }))
        };
      }
    });
    state.findCachedClassification.mockResolvedValue(null);

    await expect(state.service.processOnce()).resolves.toMatchObject({
      failed: 0,
      ready: 0,
      chunksAttached: 8
    });
    await expect(state.service.processOnce()).resolves.toMatchObject({
      failed: 0,
      ready: 1,
      resumedChunks: 8,
      chunksAttached: 1
    });
    expect(state.classify.mock.calls.map(([batch]) => batch.length)).toEqual([
      128, 1, 1
    ]);
    expect(state.storeClassificationResult).toHaveBeenCalledTimes(9);
    expect(state.markSemanticPrivacyTargetFailed).not.toHaveBeenCalled();
  });

  it("wakes once at the earliest durable privacy retry time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const retryAt = "2026-08-13T00:00:05.000Z";
    const retryTarget = targetFor(
      privacyContentPolicyHash({ labels: labelPolicy("private_email") })
    );
    const state = fixture({
      classify: async () => {
        throw new PrivacyServiceUnavailableError();
      }
    });
    state.listPendingSemanticPrivacyTargets
      .mockResolvedValueOnce([retryTarget])
      .mockResolvedValue([]);
    state.deferSemanticPrivacyTarget.mockResolvedValue(retryAt);
    state.getNextSemanticPrivacyWorkAt
      .mockResolvedValueOnce(retryAt)
      .mockResolvedValue(null);

    state.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.listPendingSemanticPrivacyTargets).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(state.listPendingSemanticPrivacyTargets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.listPendingSemanticPrivacyTargets).toHaveBeenCalledTimes(2);

    await state.service.stop();
    vi.useRealTimers();
  });

  it("coalesces wake notifications and creates no idle polling timer", async () => {
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const state = fixture({
      listTargets: async () => {
        calls += 1;
        if (calls === 1) await firstRun;
        return [];
      }
    });
    const timer = vi.spyOn(globalThis, "setTimeout");

    state.service.start();
    await flush();
    expect(state.wakeClient.queries).toEqual([
      "listen koed_collaboration_realtime",
      "listen koed_team_conversation_source",
      "listen koed_shared_memory_privacy"
    ]);
    expect(calls).toBe(1);
    state.wakeClient.emit("notification", {
      channel: "koed_shared_memory_privacy"
    });
    state.wakeClient.emit("notification", {
      channel: "koed_team_conversation_source"
    });
    state.wakeClient.emit("notification", {
      channel: "koed_collaboration_realtime"
    });
    releaseFirst();
    await flush(24);

    expect(calls).toBe(2);
    expect(timer).not.toHaveBeenCalled();
    await state.service.stop();
    expect(state.wakeClient.queries).toContain(
      "unlisten koed_collaboration_realtime"
    );
    expect(state.wakeClient.queries).toContain(
      "unlisten koed_team_conversation_source"
    );
    expect(state.wakeClient.queries).toContain(
      "unlisten koed_shared_memory_privacy"
    );
    expect(state.wakeClient.released).toBe(true);
    timer.mockRestore();
  });

  it("drains full privacy and publication batches without another notification", async () => {
    let targetCalls = 0;
    let publicationCalls = 0;
    const state = fixture({
      targetLimit: 1,
      listTargets: async () => {
        targetCalls += 1;
        return targetCalls === 1
          ? [
              targetFor(
                privacyContentPolicyHash({ labels: labelPolicy("secret") })
              )
            ]
          : [];
      },
      reconcileReady: async () => {
        publicationCalls += 1;
        return {
          materialized: publicationCalls === 1 ? 1 : 0,
          skipped: 0
        };
      }
    });

    state.service.start();
    await flush(32);

    expect(targetCalls).toBe(2);
    expect(publicationCalls).toBe(2);
    await state.service.stop();
  });
});
