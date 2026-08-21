import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationSourceSegmentRecord,
  PrivacyClassificationRepository
} from "@koed/db";
import {
  allPrivacyLabelsPolicy,
  createLocalTestKeyEnvelopeEncryptionProvider,
  privacyContentPolicyHash,
  type PrivacyClassificationResponse,
  type PrivacyServiceClient
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createPrivacyMaterializationService,
  initializePrivacyMaterialization,
  PINNED_PRIVACY_CLASSIFIER_GENERATION,
  PINNED_PRIVACY_CLASSIFIER_HASH
} from "./privacy-materialization-service.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const teamWorkspaceId = "33333333-3333-4333-8333-333333333333";
const sourceArtifactId = "44444444-4444-4444-8444-444444444444";
const shareGrantId = "55555555-5555-4555-8555-555555555555";
const generationId = "66666666-6666-4666-8666-666666666666";
const deploymentIdentityId = "77777777-7777-4777-8777-777777777777";

const responseFor = (
  fields: readonly { path: string; text: string }[]
): PrivacyClassificationResponse => ({
  schemaVersion: 1,
  inputContractVersion: "koed-privacy-classification-v1",
  classifier: {
    classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH,
    modelKey: PINNED_PRIVACY_CLASSIFIER_GENERATION.modelKey,
    modelRevision: PINNED_PRIVACY_CLASSIFIER_GENERATION.modelRevision
  },
  fields: fields.map((field) => {
    const sensitive = "alice@example.test";
    const startByte = Buffer.byteLength(
      field.text.split(sensitive)[0]!,
      "utf8"
    );
    return {
      path: field.path,
      inputSha256: createHash("sha256").update(field.text).digest("hex"),
      inputByteLength: Buffer.byteLength(field.text),
      maskedText: field.text,
      decodedTextMatchesInput: true,
      spans: field.text.includes(sensitive)
        ? [
            {
              label: "private_email" as const,
              startByte,
              endByte: startByte + Buffer.byteLength(sensitive),
              detectors: ["privacy_filter" as const]
            }
          ]
        : []
    };
  })
});

const targetFor = (segment: ConversationSourceSegmentRecord) => ({
  shareGrantId,
  ownerUserId,
  teamId,
  teamWorkspaceId,
  mode: "continuous" as const,
  sourceArtifactId,
  sourceKind: "codex",
  artifactFormat: "codex_rollout_jsonl",
  artifactFormatVersion: 1,
  sourceFrontierCursor: segment.sourceEndOffset,
  sourceSegmentCount: segment.segmentIndex + 1,
  throughSegmentIndex: segment.segmentIndex,
  headContentDigest: segment.contentDigest,
  sourceClosureHash: null
});

const writeSegment = async (input: {
  koedHome: string;
  bytes: Buffer;
  segmentIndex?: number;
  sourceStartOffset?: number;
  sourceStartLine?: number;
  previousContentDigest?: string | null;
}): Promise<ConversationSourceSegmentRecord> => {
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  const storageKey = `${sourceArtifactId}/${digest}.segment`;
  await mkdir(join(input.koedHome, "source-journal", sourceArtifactId), {
    recursive: true
  });
  await writeFile(
    join(input.koedHome, "source-journal", storageKey),
    input.bytes
  );
  const segmentIndex = input.segmentIndex ?? 0;
  const sourceStartOffset = input.sourceStartOffset ?? 0;
  const sourceStartLine = input.sourceStartLine ?? 0;
  const recordCount = input.bytes.toString("utf8").split("\n").length - 1;
  return {
    id: randomUUID(),
    artifactId: sourceArtifactId,
    segmentIndex,
    sourceStartOffset,
    sourceEndOffset: sourceStartOffset + input.bytes.byteLength,
    sourceStartLine,
    sourceEndLine: sourceStartLine + recordCount,
    plaintextDigest: digest,
    ciphertextDigest: null,
    plaintextSize: input.bytes.byteLength,
    storedSize: input.bytes.byteLength,
    storageKey,
    storageProvider: "filesystem",
    encryptionEnvelope: null,
    signedManifest: {},
    originSignature: "a".repeat(86),
    manifestDigest: "b".repeat(64),
    previousContentDigest: input.previousContentDigest ?? null,
    contentDigest: createHash("sha256")
      .update(`content-${segmentIndex}-${digest}`)
      .digest("hex"),
    createdAt: "2026-08-13T00:00:00.000Z",
    sealedAt: "2026-08-13T00:00:00.000Z"
  };
};

class WakeClient extends EventEmitter {
  queries: string[] = [];
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

const fixture = async (input?: {
  classify?: PrivacyServiceClient["classify"];
  wakePool?: { connect(): Promise<WakeClient> };
}) => {
  const koedHome = await mkdtemp(join(tmpdir(), "koed-privacy-worker-"));
  let targets: Array<ReturnType<typeof targetFor>> = [];
  let segments: ConversationSourceSegmentRecord[] = [];
  const cache = new Map<
    string,
    { id: string; fields: PrivacyClassificationResponse["fields"] }
  >();
  const storedArtifacts: unknown[] = [];
  const findReadySanitizedSourceArtifact = vi.fn(async (lookup) =>
    storedArtifacts.some(
      (artifact) =>
        (artifact as { sourceFrontierHash: string }).sourceFrontierHash ===
        lookup.sourceFrontierHash
    )
      ? ({ id: randomUUID() } as never)
      : null
  );
  const repository = {
    getActiveClassifierGeneration: vi.fn(async () => ({
      id: generationId,
      classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH
    })),
    getLocalDeploymentIdentityId: vi.fn(async () => deploymentIdentityId),
    listSourceMaterializationTargets: vi.fn(async () => targets),
    resolveEffectiveContentPolicy: vi.fn(async () => ({
      labels: allPrivacyLabelsPolicy(),
      effectivePolicyHash: privacyContentPolicyHash({
        labels: allPrivacyLabelsPolicy()
      }),
      policies: []
    })),
    findReadySanitizedSourceArtifact,
    findCachedClassification: vi.fn(async ({ fields }) => {
      const found = cache.get(JSON.stringify(fields));
      return found ? ({ id: found.id } as never) : null;
    }),
    getOrCreateStructuralClassificationBinding: vi.fn(async () => ({
      id: "88888888-8888-4888-8888-888888888888"
    })),
    storeClassificationResult: vi.fn(async ({ fields, response }) => {
      const id = randomUUID();
      cache.set(JSON.stringify(fields), { id, fields: response.fields });
      return { id } as never;
    }),
    readClassificationResult: vi.fn(async ({ resultId }) => {
      const found = [...cache.values()].find((item) => item.id === resultId);
      return found
        ? ({
            record: { id: found.id },
            fields: found.fields.map((field) => ({
              path: field.path,
              inputSha256: field.inputSha256,
              inputByteLength: field.inputByteLength,
              spans: field.spans
            }))
          } as never)
        : null;
    }),
    readLatestSanitizedSourceArtifactByGrant: vi.fn(async () => {
      const artifact = storedArtifacts.at(-1) as
        | {
            sourceArtifactId: string;
            classifierHash: string;
            effectivePolicyHash: string;
            sourceFrontierHash: string;
            sourceFrontierCursor: number;
            sourceSegmentCount: number;
            metadata: unknown;
            chunks: Array<{
              classificationResultId: string;
              sourceStartByte: number;
              sourceEndByte: number;
              text: string;
            }>;
          }
        | undefined;
      return artifact
        ? ({
            record: {
              id: randomUUID(),
              sourceArtifactId: artifact.sourceArtifactId,
              classifierHash: artifact.classifierHash,
              effectivePolicyHash: artifact.effectivePolicyHash,
              sourceFrontierHash: artifact.sourceFrontierHash,
              sourceFrontierCursor: artifact.sourceFrontierCursor,
              sourceSegmentCount: artifact.sourceSegmentCount
            },
            metadata: artifact.metadata,
            chunks: artifact.chunks.map((chunk, chunkIndex) => ({
              record: {
                id: randomUUID(),
                classificationResultId: chunk.classificationResultId,
                sourceStartByte: chunk.sourceStartByte,
                sourceEndByte: chunk.sourceEndByte,
                chunkIndex
              },
              text: chunk.text
            }))
          } as never)
        : null;
    }),
    storeSanitizedSourceArtifact: vi.fn(async (artifact) => {
      storedArtifacts.push(artifact);
      return { id: randomUUID() } as never;
    })
  } as unknown as PrivacyClassificationRepository;
  const classify = vi.fn(
    input?.classify ?? (async (fields) => responseFor(fields))
  );
  const wakeClient = new WakeClient();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64")
  );
  const service = createPrivacyMaterializationService({
    privacyRepository: repository,
    sourceRepository: {
      listConversationSourceSegmentsByIndex: vi.fn(async (_actor, request) =>
        segments.filter(
          (segment) =>
            segment.segmentIndex > request.afterSegmentIndex &&
            segment.segmentIndex <= request.throughSegmentIndex
        )
      )
    },
    privacyService: { classify },
    classificationEncryptionProvider: provider,
    teamEncryptionProvider: provider,
    koedHome,
    targetLimit: 25,
    maxFrontierBytes: 1024 * 1024,
    maxRecords: 100,
    wakePool: input?.wakePool ?? { connect: vi.fn(async () => wakeClient) },
    logger
  });
  return {
    classify,
    findReadySanitizedSourceArtifact,
    koedHome,
    logger,
    repository,
    service,
    setSegments(value: ConversationSourceSegmentRecord[]) {
      segments = value;
    },
    setTargets(value: Array<ReturnType<typeof targetFor>>) {
      targets = value;
    },
    storedArtifacts,
    wakeClient
  };
};

describe("privacy materialization service", () => {
  it("deliberately activates the pinned generation and all-eight secret policy", async () => {
    const labels = allPrivacyLabelsPolicy();
    const createContentPolicyVersion = vi.fn(async () => ({}));
    const resolveEffectiveContentPolicy = vi
      .fn()
      .mockRejectedValueOnce(new Error("not initialized"))
      .mockResolvedValueOnce({ labels, effectivePolicyHash: "e".repeat(64) });
    const repository = {
      registerClassifierGeneration: vi.fn(async () => ({ id: generationId })),
      activateClassifierGeneration: vi.fn(async () => ({
        id: generationId,
        classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH
      })),
      getLocalDeploymentIdentityId: vi.fn(async () => deploymentIdentityId),
      resolveEffectiveContentPolicy,
      createContentPolicyVersion
    } as unknown as PrivacyClassificationRepository;

    await initializePrivacyMaterialization({ privacyRepository: repository });

    expect(repository.registerClassifierGeneration).toHaveBeenCalledWith({
      ...PINNED_PRIVACY_CLASSIFIER_GENERATION,
      classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH
    });
    expect(repository.activateClassifierGeneration).toHaveBeenCalledWith(
      generationId
    );
    expect(createContentPolicyVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "deployment",
        expectedPreviousVersion: 0,
        labels: expect.objectContaining({ secret: true })
      })
    );
    expect(Object.values(labels)).toEqual(Array(8).fill(true));
  });

  it("classifies identical owner content once and reuses the encrypted cache", async () => {
    const state = await fixture();
    const record = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: "Email alice@example.test"
      }
    });
    const segment = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from(`${record}\n${record}\n`)
    });
    state.setSegments([segment]);
    state.setTargets([targetFor(segment)]);

    await expect(state.service.processOnce()).resolves.toEqual({
      materialized: 1,
      ready: 0,
      unavailable: 0
    });
    expect(state.classify).toHaveBeenCalledTimes(1);
    const stored = state.storedArtifacts[0] as {
      chunks: Array<{ text: string }>;
    };
    expect(stored.chunks).toHaveLength(2);
    expect(stored.chunks[0]?.text).toContain("[PRIVATE_EMAIL]");
    expect(state.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        privacyMaterialization: expect.objectContaining({
          targets: 1,
          materialized: 1,
          ready: 0,
          unavailable: 0,
          sourceBytesProcessed: Buffer.byteLength(`${record}\n${record}\n`),
          sourceRecordsProcessed: 2,
          sanitizedChunksStored: 2
        })
      }),
      "privacy materialization reconciliation completed"
    );
    expect(JSON.stringify(state.logger.warn.mock.calls)).not.toContain(
      "alice@example.test"
    );
  });

  it("keeps the prior continuous frontier ready until the next complete frontier stores", async () => {
    const state = await fixture();
    const firstRecord = `${JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "First alice@example.test" }
    })}\n`;
    const first = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from(firstRecord)
    });
    state.setSegments([first]);
    state.setTargets([targetFor(first)]);
    await state.service.processOnce();
    state.classify.mockClear();

    const second = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from(
        `${JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "Second bob@example.test" }
        })}\n`
      ),
      segmentIndex: 1,
      sourceStartOffset: first.sourceEndOffset,
      sourceStartLine: first.sourceEndLine,
      previousContentDigest: first.contentDigest
    });
    state.setSegments([first, second]);
    state.setTargets([targetFor(second)]);
    await state.service.processOnce();

    expect(state.storedArtifacts).toHaveLength(2);
    expect(state.classify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.classify.mock.calls)).toContain("Second");
    expect(JSON.stringify(state.classify.mock.calls)).not.toContain("First");
    expect(state.findReadySanitizedSourceArtifact).toHaveBeenCalledTimes(2);
    expect(
      (state.storedArtifacts[0] as { sourceFrontierCursor: number })
        .sourceFrontierCursor
    ).toBe(first.sourceEndOffset);
    expect(
      (state.storedArtifacts[1] as { sourceFrontierCursor: number })
        .sourceFrontierCursor
    ).toBe(second.sourceEndOffset);
  });

  it("keeps the prior continuous frontier readable when append classification fails", async () => {
    let fail = false;
    const state = await fixture({
      classify: async (fields) => {
        if (fail) throw new Error("privacy unavailable");
        return responseFor(fields);
      }
    });
    const first = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from(
        `${JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "First alice@example.test" }
        })}\n`
      )
    });
    state.setSegments([first]);
    state.setTargets([targetFor(first)]);
    await state.service.processOnce();
    fail = true;
    const second = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from(
        `${JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "New field" }
        })}\n`
      ),
      segmentIndex: 1,
      sourceStartOffset: first.sourceEndOffset,
      sourceStartLine: first.sourceEndLine,
      previousContentDigest: first.contentDigest
    });
    state.setSegments([first, second]);
    state.setTargets([targetFor(second)]);

    await expect(state.service.processOnce()).resolves.toMatchObject({
      unavailable: 1
    });
    expect(state.storedArtifacts).toHaveLength(1);
    await expect(
      state.repository.readLatestSanitizedSourceArtifactByGrant({
        actor: { userId: ownerUserId },
        provider: {} as never,
        shareGrantId
      })
    ).resolves.toMatchObject({
      record: { sourceFrontierCursor: first.sourceEndOffset }
    });
  });

  it("materializes valid structural-only records without classifier inference", async () => {
    const state = await fixture();
    const segment = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from(
        `${JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", status: "completed" }
        })}\n`
      )
    });
    state.setSegments([segment]);
    state.setTargets([targetFor(segment)]);

    await expect(state.service.processOnce()).resolves.toMatchObject({
      materialized: 1,
      unavailable: 0
    });
    expect(state.classify).not.toHaveBeenCalled();
    expect(
      state.repository.getOrCreateStructuralClassificationBinding
    ).toHaveBeenCalledTimes(1);
    expect(
      (state.storedArtifacts[0] as { chunks: unknown[] }).chunks
    ).toHaveLength(1);
  });

  it("leaves material unavailable on outage and retries only on a later notification", async () => {
    let attempt = 0;
    const state = await fixture({
      classify: async (fields) => {
        attempt += 1;
        if (attempt === 1) throw new Error("service outage");
        return responseFor(fields);
      }
    });
    const segment = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from(
        `${JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "alice@example.test" }
        })}\n`
      )
    });
    state.setSegments([segment]);
    state.setTargets([targetFor(segment)]);
    state.service.start();
    await vi.waitFor(() => expect(state.classify).toHaveBeenCalledTimes(1));
    expect(state.storedArtifacts).toHaveLength(0);

    state.wakeClient.emit("notification", {
      channel: "koed_team_conversation_source"
    });
    await vi.waitFor(() => expect(state.storedArtifacts).toHaveLength(1));
    expect(state.classify).toHaveBeenCalledTimes(2);
    await state.service.stop();
  });

  it("fails closed for unsupported and malformed source without storing material", async () => {
    const state = await fixture();
    const unsupported = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from(`${JSON.stringify({ type: "future_record" })}\n`)
    });
    state.setSegments([unsupported]);
    state.setTargets([targetFor(unsupported)]);
    await expect(state.service.processOnce()).resolves.toMatchObject({
      unavailable: 1
    });

    const malformed = await writeSegment({
      koedHome: state.koedHome,
      bytes: Buffer.from("{bad json}\n")
    });
    state.setSegments([malformed]);
    state.setTargets([targetFor(malformed)]);
    await expect(state.service.processOnce()).resolves.toMatchObject({
      unavailable: 1
    });
    expect(state.storedArtifacts).toHaveLength(0);
    const warningLog = JSON.stringify(state.logger.warn.mock.calls);
    expect(warningLog).not.toContain(shareGrantId);
    expect(warningLog).not.toContain(sourceArtifactId);
  });

  it("does not create idle polling timers", async () => {
    const state = await fixture();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    state.service.start();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(
      state.repository.listSourceMaterializationTargets
    ).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled();
    await state.service.stop();
    timeout.mockRestore();
  });

  it("reconciles after a notification connection is re-established", async () => {
    vi.useFakeTimers();
    try {
      const firstClient = new WakeClient();
      const secondClient = new WakeClient();
      const connect = vi
        .fn<() => Promise<WakeClient>>()
        .mockResolvedValueOnce(firstClient)
        .mockResolvedValueOnce(secondClient);
      const state = await fixture({ wakePool: { connect } });

      state.service.start();
      await vi.waitFor(() =>
        expect(
          state.repository.listSourceMaterializationTargets
        ).toHaveBeenCalledTimes(1)
      );

      firstClient.emit("error", new Error("connection interrupted"));
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          state.repository.listSourceMaterializationTargets
        ).toHaveBeenCalledTimes(2)
      );

      expect(firstClient.released).toBe(true);
      expect(secondClient.queries).toContain(
        "listen koed_team_conversation_source"
      );
      expect(secondClient.queries).toContain(
        "listen koed_conversation_source_replication"
      );
      await state.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
