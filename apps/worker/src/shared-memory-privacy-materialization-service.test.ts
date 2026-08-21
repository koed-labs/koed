import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  type PrivacyClassificationResultRecord,
  type SharedMemoryDecryptedSemanticTarget,
  type SharedMemoryPendingSemanticTarget
} from "@koed/db";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  crossIdentitySyncDigest,
  extractSharedMemorySemanticClassificationFields,
  noPrivacyLabelsPolicy,
  privacyContentPolicyHash,
  privacyLabels,
  PrivacyServiceUnavailableError,
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
  relationship: "00000000-0000-4000-8000-000000000016"
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
  classificationResultId: null,
  classificationPayloadBindingHash: null,
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
  const cacheKey = (fields: Array<{ path: string; text: string }>) =>
    JSON.stringify(fields);
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
    const entry = { record, response: classified };
    cachedByKey.set(cacheKey(fields), entry);
    cachedById.set(record.id, entry);
    return record;
  };
  if (input?.cached) {
    cacheClassification(
      classificationFields.map(({ path, text }) => ({ path, text })),
      response
    );
  }
  const findCachedClassification = vi.fn(
    async (findInput: { fields: Array<{ path: string; text: string }> }) =>
      cachedByKey.get(cacheKey(findInput.fields))?.record ?? null
  );
  const storeClassificationResult = vi.fn(
    async (storeInput: {
      fields: Array<{ path: string; text: string }>;
      response: PrivacyClassificationResponse;
    }) => {
      storedClassificationInputs.push(storeInput);
      const existing = cachedByKey.get(cacheKey(storeInput.fields));
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
  const readPendingSemanticPrivacyTarget = vi.fn(
    async () => loadedOverride ?? loadedFor(target)
  );
  const storeSanitizedSemanticPreview = vi.fn(async (_actor, storeInput) => {
    storedInputs.push(storeInput as unknown as Record<string, unknown>);
    return {
      ...target,
      sourceItemIdentityHash: storeInput.expectedSourceItemIdentityHash,
      sourceItemCount: (storeInput.items as unknown[]).length,
      sanitizedContentHash: storeInput.sanitizedContentHash,
      classificationResultId: storeInput.classificationResultId,
      status: "ready"
    } as never;
  });
  const markSemanticPrivacyTargetFailed = vi.fn(async () => true);
  const deferSemanticPrivacyTarget = vi.fn(
    async (): Promise<string | null> => null
  );
  const getNextSemanticPrivacyRetryAt = vi.fn(
    async (): Promise<string | null> => null
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
  const service = createSharedMemoryPrivacyMaterializationService({
    sharedMemoryRepository: {
      listPendingSemanticPrivacyTargets,
      readPendingSemanticPrivacyTarget,
      storeSanitizedSemanticPreview,
      markSemanticPrivacyTargetFailed,
      deferSemanticPrivacyTarget,
      getNextSemanticPrivacyRetryAt,
      invalidateStaleSemanticPreviews,
      reconcileReadySemanticRepresentations
    },
    privacyRepository: {
      getActiveClassifierGeneration: vi.fn(async () => ({
        id: ids.classifierGeneration,
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
      })),
      getLocalDeploymentIdentityId: vi.fn(async () => ids.deployment),
      resolveEffectiveContentPolicy: vi.fn(async () => ({
        labels: policyLabels,
        effectivePolicyHash: privacyContentPolicyHash({ labels: policyLabels }),
        policies: []
      })),
      findCachedClassification,
      storeClassificationResult,
      readClassificationResult
    },
    privacyService: { classify: classify as never },
    classificationEncryptionProvider:
      createLocalTestKeyEnvelopeEncryptionProvider(
        randomBytes(32).toString("base64")
      ),
    wakePool: { connect: vi.fn(async () => wakeClient) },
    logger,
    targetLimit: input?.targetLimit
  });
  return {
    service,
    classify,
    findCachedClassification,
    storeClassificationResult,
    listPendingSemanticPrivacyTargets,
    readPendingSemanticPrivacyTarget,
    storeSanitizedSemanticPreview,
    markSemanticPrivacyTargetFailed,
    deferSemanticPrivacyTarget,
    getNextSemanticPrivacyRetryAt,
    invalidateStaleSemanticPreviews,
    reconcileReadySemanticRepresentations,
    storedInputs,
    wakeClient,
    logger,
    setTarget(
      nextTarget: SharedMemoryPendingSemanticTarget,
      loaded?: SharedMemoryDecryptedSemanticTarget
    ) {
      target = nextTarget;
      loadedOverride = loaded;
    },
    setPolicy(labels: PrivacyLabelPolicy) {
      policyLabels = labels;
      target = targetFor(
        privacyContentPolicyHash({ labels }),
        "00000000-0000-4000-8000-000000000017"
      );
    }
  };
};

describe("Shared Memory privacy materialization service", () => {
  it("uses an exact cached classification and applies policy after classification", async () => {
    const state = fixture({ cached: true });

    await expect(state.service.processOnce()).resolves.toEqual({
      processed: 1,
      invalidatedStale: 0,
      classifierCacheHits: 1,
      classifierInferenceCalls: 0,
      remaskedTargets: 1,
      ready: 1,
      materialized: 1,
      materializationSkipped: 0,
      failed: 0
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
    expect(
      state.storeClassificationResult.mock.calls.at(-1)?.[0].response.fields
    ).toHaveLength(129);
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
    state.getNextSemanticPrivacyRetryAt
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
