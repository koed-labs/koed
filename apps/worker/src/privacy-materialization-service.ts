import { createHash } from "node:crypto";
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
  ConversationSourceSegmentRecord,
  MemorySourceRepository,
  PrivacyClassificationRepository
} from "@koed/db";
import { privacySourceFrontierHash } from "@koed/db";
import {
  allPrivacyLabelsPolicy,
  assertConversationSourceReplicationJsonlSegment,
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  decryptEnvelopeToUtf8,
  isPrivacyMaterializationSourceAdapter,
  parseConversationSourceReplicationSegmentEnvelope,
  PINNED_PRIVACY_CLASSIFIER_GENERATION,
  PINNED_PRIVACY_CLASSIFIER_HASH,
  prepareCodexTeamSourceRecord,
  reconstructCodexTeamSourceRecord,
  sanitizeTextWithPrivacySpans,
  serializeCodexTeamSourceRecord,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type PrivacyClassifiedField,
  type PrivacyLabelPolicy,
  type PrivacyServiceClient
} from "@koed/shared";
import {
  createNotificationDrainController,
  type NotificationDrainPool
} from "./notification-drain-controller.js";

const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const SOURCE_STORAGE_KEY_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{64})\.segment$/i;

export { PINNED_PRIVACY_CLASSIFIER_GENERATION, PINNED_PRIVACY_CLASSIFIER_HASH };

interface PrivacyLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface PrivacyMaterializationService {
  processOnce(): Promise<{
    materialized: number;
    ready: number;
    unavailable: number;
  }>;
  start(): void;
  stop(): Promise<void>;
}

export interface PrivacyMaterializationServiceOptions {
  privacyRepository: PrivacyClassificationRepository;
  sourceRepository: Pick<
    MemorySourceRepository,
    "listConversationSourceSegmentsByIndex"
  >;
  privacyService: PrivacyServiceClient;
  sourceEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  classificationEncryptionProvider: EnvelopeEncryptionProvider;
  teamEncryptionProvider: EnvelopeEncryptionProvider;
  koedHome: string;
  targetLimit: number;
  maxFrontierBytes: number;
  maxRecords: number;
  wakePool: NotificationDrainPool;
  logger: PrivacyLogger;
}

type PrivacySourceMaterializationTarget = Awaited<
  ReturnType<
    PrivacyClassificationRepository["listSourceMaterializationTargets"]
  >
>[number];

export interface InitializePrivacyMaterializationOptions {
  privacyRepository: PrivacyClassificationRepository;
}

export const initializePrivacyMaterialization = async (
  options: InitializePrivacyMaterializationOptions
): Promise<void> => {
  const generation =
    await options.privacyRepository.registerClassifierGeneration({
      ...PINNED_PRIVACY_CLASSIFIER_GENERATION,
      classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH
    });
  const active = await options.privacyRepository.activateClassifierGeneration(
    generation.id
  );
  if (active.classifierHash !== PINNED_PRIVACY_CLASSIFIER_HASH) {
    throw new Error("Pinned privacy classifier generation is not active");
  }

  const deploymentIdentityId =
    await options.privacyRepository.getLocalDeploymentIdentityId();
  if (!deploymentIdentityId) {
    throw new Error("Local deployment identity is required for privacy policy");
  }
  const subject = { deploymentIdentityId };
  let policy;
  try {
    policy =
      await options.privacyRepository.resolveEffectiveContentPolicy(subject);
  } catch {
    try {
      await options.privacyRepository.createContentPolicyVersion({
        scope: "deployment",
        subject,
        labels: allPrivacyLabelsPolicy(),
        expectedPreviousVersion: 0
      });
    } catch {
      // A concurrent worker may have created the immutable first version.
    }
    policy =
      await options.privacyRepository.resolveEffectiveContentPolicy(subject);
  }
  if (!policy.labels.secret) {
    throw new Error("The effective privacy policy must classify secrets");
  }
};

class PrivacyMaterializationError extends Error {
  constructor(readonly code: string) {
    super("Team Conversation Source privacy material is unavailable");
    this.name = code;
  }
}

const safeErrorName = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(error.name)
    ? error.name
    : "PrivacyMaterializationFailure";

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const readFilesystemSegment = (
  koedHome: string,
  sourceArtifactId: string,
  segment: ConversationSourceSegmentRecord
): Uint8Array => {
  const match = SOURCE_STORAGE_KEY_PATTERN.exec(segment.storageKey);
  if (
    !match ||
    match[1] !== sourceArtifactId ||
    match[2] !== segment.plaintextDigest
  ) {
    throw new PrivacyMaterializationError("PrivacySourceStorageIdentityError");
  }
  const rootPath = resolve(koedHome, "source-journal");
  if (lstatSync(rootPath).isSymbolicLink()) {
    throw new PrivacyMaterializationError("PrivacySourceStorageBoundaryError");
  }
  const root = realpathSync(rootPath);
  const target = resolve(root, segment.storageKey);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new PrivacyMaterializationError("PrivacySourceStorageBoundaryError");
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
      state.size > MAX_SEGMENT_BYTES
    ) {
      throw new PrivacyMaterializationError("PrivacySourceStorageShapeError");
    }
    const bytes = readFileSync(descriptor);
    if (sha256(bytes) !== segment.plaintextDigest) {
      throw new PrivacyMaterializationError("PrivacySourceStorageDigestError");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const readEnvelopeSegment = async (
  provider: EnvelopeEncryptionProvider,
  segment: ConversationSourceSegmentRecord
): Promise<Uint8Array> => {
  if (!segment.encryptionEnvelope) {
    throw new PrivacyMaterializationError("PrivacySourceEnvelopeMissingError");
  }
  const decrypted = await decryptEnvelopeToUtf8(
    provider,
    segment.encryptionEnvelope as unknown as EncryptedPayloadEnvelope
  );
  const envelope = parseConversationSourceReplicationSegmentEnvelope(
    JSON.parse(decrypted) as unknown
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
    throw new PrivacyMaterializationError("PrivacySourceEnvelopeIdentityError");
  }
  const bytes = Buffer.from(envelope.plaintextBytes, "base64url");
  if (
    bytes.toString("base64url") !== envelope.plaintextBytes ||
    bytes.byteLength !== segment.plaintextSize ||
    bytes.byteLength > MAX_SEGMENT_BYTES ||
    sha256(bytes) !== segment.plaintextDigest
  ) {
    throw new PrivacyMaterializationError("PrivacySourceEnvelopeContentError");
  }
  return bytes;
};

const readSourceSegment = async (
  options: PrivacyMaterializationServiceOptions,
  target: PrivacySourceMaterializationTarget,
  segment: ConversationSourceSegmentRecord
): Promise<Uint8Array> => {
  if (segment.storageProvider === "filesystem") {
    return readFilesystemSegment(
      options.koedHome,
      target.sourceArtifactId,
      segment
    );
  }
  if (
    segment.storageProvider !== "envelope_db" ||
    !options.sourceEnvelopeEncryptionProvider
  ) {
    throw new PrivacyMaterializationError("PrivacySourceStorageProviderError");
  }
  return readEnvelopeSegment(options.sourceEnvelopeEncryptionProvider, segment);
};

interface SourceRecord {
  sourceStartByte: number;
  sourceEndByte: number;
  decodedSource: string;
  record: unknown;
}

const parseSegmentRecords = (
  bytes: Uint8Array,
  segment: ConversationSourceSegmentRecord
): SourceRecord[] => {
  const expectedRecords = segment.sourceEndLine - segment.sourceStartLine;
  assertConversationSourceReplicationJsonlSegment(bytes, expectedRecords);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.split("\n").slice(0, -1);
  let localOffset = 0;
  return lines.map((line) => {
    const decodedSource = `${line}\n`;
    const byteLength = Buffer.byteLength(decodedSource, "utf8");
    const sourceStartByte = segment.sourceStartOffset + localOffset;
    localOffset += byteLength;
    return {
      sourceStartByte,
      sourceEndByte: segment.sourceStartOffset + localOffset,
      decodedSource,
      record: JSON.parse(line.replace(/\r$/, "")) as unknown
    };
  });
};

const listPinnedSegments = async (
  options: PrivacyMaterializationServiceOptions,
  target: PrivacySourceMaterializationTarget
): Promise<ConversationSourceSegmentRecord[]> => {
  const segments: ConversationSourceSegmentRecord[] = [];
  let afterSegmentIndex = -1;
  while (afterSegmentIndex < target.throughSegmentIndex) {
    const page =
      await options.sourceRepository.listConversationSourceSegmentsByIndex(
        { userId: target.ownerUserId },
        {
          artifactId: target.sourceArtifactId,
          afterSegmentIndex,
          throughSegmentIndex: target.throughSegmentIndex,
          limit: 100
        }
      );
    if (page.length === 0) break;
    segments.push(...page);
    afterSegmentIndex = page.at(-1)!.segmentIndex;
  }
  if (
    segments.length !== target.sourceSegmentCount ||
    segments.at(-1)?.segmentIndex !== target.throughSegmentIndex ||
    segments.at(-1)?.sourceEndOffset !== target.sourceFrontierCursor ||
    segments.at(-1)?.contentDigest !== target.headContentDigest
  ) {
    throw new PrivacyMaterializationError("PrivacySourceFrontierMismatchError");
  }
  let totalBytes = 0;
  for (const [index, segment] of segments.entries()) {
    const prior = segments[index - 1];
    if (
      segment.artifactId !== target.sourceArtifactId ||
      (prior !== undefined &&
        (segment.segmentIndex !== prior.segmentIndex + 1 ||
          segment.sourceStartOffset !== prior.sourceEndOffset ||
          segment.previousContentDigest !== prior.contentDigest))
    ) {
      throw new PrivacyMaterializationError("PrivacySourceChainMismatchError");
    }
    totalBytes += segment.plaintextSize;
    if (totalBytes > options.maxFrontierBytes) {
      throw new PrivacyMaterializationError("PrivacySourceFrontierBoundsError");
    }
  }
  return segments;
};

const classifiedFields = async (
  options: PrivacyMaterializationServiceOptions,
  target: PrivacySourceMaterializationTarget,
  fields: Array<{ path: string; text: string }>,
  policy: PrivacyLabelPolicy
): Promise<{ resultId: string; fields: PrivacyClassifiedField[] }> => {
  const actor = { userId: target.ownerUserId };
  let cached = await options.privacyRepository.findCachedClassification({
    actor,
    classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH,
    fields
  });
  if (!cached) {
    const response = await options.privacyService.classify(fields);
    cached = await options.privacyRepository.storeClassificationResult({
      actor,
      provider: options.classificationEncryptionProvider,
      fields,
      response
    });
  }
  const classification =
    await options.privacyRepository.readClassificationResult({
      actor,
      provider: options.classificationEncryptionProvider,
      resultId: cached.id,
      expectedFields: fields,
      expectedClassifierHash: PINNED_PRIVACY_CLASSIFIER_HASH
    });
  if (!classification) {
    throw new PrivacyMaterializationError(
      "PrivacyClassificationUnavailableError"
    );
  }
  return {
    resultId: classification.record.id,
    fields: fields.map((field, index) => {
      const classified = classification.fields[index];
      if (!classified || classified.path !== field.path) {
        throw new PrivacyMaterializationError(
          "PrivacyClassificationMismatchError"
        );
      }
      return {
        path: classified.path,
        inputSha256: classified.inputSha256,
        inputByteLength: classified.inputByteLength,
        maskedText: sanitizeTextWithPrivacySpans({
          text: field.text,
          spans: classified.spans,
          policy
        }).text,
        spans: classified.spans,
        decodedTextMatchesInput: true as const
      };
    })
  };
};

const materializeTarget = async (
  options: PrivacyMaterializationServiceOptions,
  target: PrivacySourceMaterializationTarget,
  deploymentIdentityId: string
): Promise<{
  status: "materialized" | "ready";
  sourceBytesProcessed: number;
  sourceRecordsProcessed: number;
  sanitizedChunksStored: number;
}> => {
  if (!isPrivacyMaterializationSourceAdapter(target)) {
    throw new PrivacyMaterializationError(
      "PrivacySourceFormatUnsupportedError"
    );
  }
  const policy = await options.privacyRepository.resolveEffectiveContentPolicy({
    deploymentIdentityId,
    sourceOwnerUserId: target.ownerUserId,
    teamId: target.teamId,
    teamWorkspaceId: target.teamWorkspaceId
  });
  if (!policy.labels.secret) {
    throw new PrivacyMaterializationError("PrivacySecretPolicyRequiredError");
  }
  const sourceFrontierHash = privacySourceFrontierHash({
    sourceArtifactId: target.sourceArtifactId,
    sourceFrontierCursor: target.sourceFrontierCursor,
    sourceSegmentCount: target.sourceSegmentCount,
    headContentDigest: target.headContentDigest
  });
  const existing =
    await options.privacyRepository.findReadySanitizedSourceArtifact({
      actor: { userId: target.ownerUserId },
      shareGrantId: target.shareGrantId,
      sourceArtifactId: target.sourceArtifactId,
      teamId: target.teamId,
      teamWorkspaceId: target.teamWorkspaceId,
      classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH,
      effectivePolicyHash: policy.effectivePolicyHash,
      sourceFrontierHash
    });
  if (existing) {
    return {
      status: "ready",
      sourceBytesProcessed: 0,
      sourceRecordsProcessed: 0,
      sanitizedChunksStored: 0
    };
  }

  const previous =
    target.mode === "continuous"
      ? await options.privacyRepository.readLatestSanitizedSourceArtifactByGrant(
          {
            actor: { userId: target.ownerUserId },
            provider: options.teamEncryptionProvider,
            shareGrantId: target.shareGrantId
          }
        )
      : null;
  const reusablePrevious =
    previous &&
    previous.record.sourceArtifactId === target.sourceArtifactId &&
    previous.record.classifierHash === PINNED_PRIVACY_CLASSIFIER_HASH &&
    previous.record.effectivePolicyHash === policy.effectivePolicyHash &&
    previous.record.sourceFrontierCursor < target.sourceFrontierCursor
      ? previous
      : null;

  const segments = await listPinnedSegments(options, target);
  const chunks: Array<{
    classificationResultId: string;
    sourceStartByte: number;
    sourceEndByte: number;
    text: string;
  }> = reusablePrevious
    ? reusablePrevious.chunks.map((chunk) => ({
        classificationResultId: chunk.record.classificationResultId,
        sourceStartByte: chunk.record.sourceStartByte,
        sourceEndByte: chunk.record.sourceEndByte,
        text: chunk.text
      }))
    : [];
  const pendingStructural: Array<{
    sourceStartByte: number;
    sourceEndByte: number;
    text: string;
  }> = [];
  const priorMetadata =
    reusablePrevious?.metadata &&
    typeof reusablePrevious.metadata === "object" &&
    !Array.isArray(reusablePrevious.metadata)
      ? (reusablePrevious.metadata as Record<string, unknown>)
      : {};
  let recordCount =
    typeof priorMetadata.includedRecordCount === "number" &&
    typeof priorMetadata.droppedRecordCount === "number"
      ? priorMetadata.includedRecordCount + priorMetadata.droppedRecordCount
      : 0;
  let droppedRecordCount =
    typeof priorMetadata.droppedRecordCount === "number"
      ? priorMetadata.droppedRecordCount
      : 0;
  let sourceBytesProcessed = 0;
  let sourceRecordsProcessed = 0;
  for (const segment of segments) {
    if (
      reusablePrevious &&
      segment.sourceEndOffset <= reusablePrevious.record.sourceFrontierCursor
    ) {
      continue;
    }
    if (
      reusablePrevious &&
      segment.sourceStartOffset < reusablePrevious.record.sourceFrontierCursor
    ) {
      throw new PrivacyMaterializationError(
        "PrivacySourceIncrementalBoundaryError"
      );
    }
    const bytes = await readSourceSegment(options, target, segment);
    sourceBytesProcessed += bytes.byteLength;
    for (const sourceRecord of parseSegmentRecords(bytes, segment)) {
      recordCount += 1;
      sourceRecordsProcessed += 1;
      if (recordCount > options.maxRecords) {
        throw new PrivacyMaterializationError("PrivacySourceRecordBoundsError");
      }
      const prepared = prepareCodexTeamSourceRecord({
        record: sourceRecord.record,
        decodedSource: sourceRecord.decodedSource
      });
      if (prepared.disposition === "drop") {
        droppedRecordCount += 1;
        continue;
      }
      if (prepared.fields.length === 0) {
        pendingStructural.push({
          sourceStartByte: sourceRecord.sourceStartByte,
          sourceEndByte: sourceRecord.sourceEndByte,
          text: serializeCodexTeamSourceRecord(prepared.source)
        });
        continue;
      }
      const classified = await classifiedFields(
        options,
        target,
        prepared.fields,
        policy.labels
      );
      const sanitized = serializeCodexTeamSourceRecord(
        reconstructCodexTeamSourceRecord({
          prepared,
          fields: classified.fields
        })
      );
      chunks.push({
        classificationResultId: classified.resultId,
        sourceStartByte:
          pendingStructural[0]?.sourceStartByte ?? sourceRecord.sourceStartByte,
        sourceEndByte: sourceRecord.sourceEndByte,
        text: `${pendingStructural.map((record) => record.text).join("")}${sanitized}`
      });
      pendingStructural.length = 0;
    }
  }
  if (pendingStructural.length > 0 && chunks.length > 0) {
    const trailing = chunks.at(-1)!;
    trailing.sourceEndByte = pendingStructural.at(-1)!.sourceEndByte;
    trailing.text += pendingStructural.map((record) => record.text).join("");
    pendingStructural.length = 0;
  }
  if (pendingStructural.length > 0) {
    const structuralBinding =
      await options.privacyRepository.getOrCreateStructuralClassificationBinding(
        {
          actor: { userId: target.ownerUserId },
          provider: options.classificationEncryptionProvider,
          classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH
        }
      );
    chunks.push({
      classificationResultId: structuralBinding.id,
      sourceStartByte: pendingStructural[0]!.sourceStartByte,
      sourceEndByte: pendingStructural.at(-1)!.sourceEndByte,
      text: pendingStructural.map((record) => record.text).join("")
    });
  }
  if (chunks.length === 0) {
    throw new PrivacyMaterializationError("PrivacySourceNoAllowedRecordsError");
  }
  await options.privacyRepository.storeSanitizedSourceArtifact({
    actor: { userId: target.ownerUserId },
    provider: options.teamEncryptionProvider,
    shareGrantId: target.shareGrantId,
    sourceArtifactId: target.sourceArtifactId,
    teamId: target.teamId,
    teamWorkspaceId: target.teamWorkspaceId,
    classifierHash: PINNED_PRIVACY_CLASSIFIER_HASH,
    effectivePolicyHash: policy.effectivePolicyHash,
    sourceFrontierHash,
    sourceFrontierCursor: target.sourceFrontierCursor,
    sourceSegmentCount: target.sourceSegmentCount,
    sourceClosureHash: target.sourceClosureHash,
    format: "codex_sanitized_ndjson",
    formatVersion: 1,
    metadata: {
      version: 1,
      sourceArtifactId: target.sourceArtifactId,
      sourceFrontierCursor: target.sourceFrontierCursor,
      sourceSegmentCount: target.sourceSegmentCount,
      includedRecordCount: recordCount - droppedRecordCount,
      droppedRecordCount
    },
    chunks
  });
  return {
    status: "materialized",
    sourceBytesProcessed,
    sourceRecordsProcessed,
    sanitizedChunksStored: chunks.length
  };
};

export const createPrivacyMaterializationService = (
  options: PrivacyMaterializationServiceOptions
): PrivacyMaterializationService => {
  const processOnce = async () => {
    const active =
      await options.privacyRepository.getActiveClassifierGeneration();
    const deploymentIdentityId =
      await options.privacyRepository.getLocalDeploymentIdentityId();
    if (
      !active ||
      active.classifierHash !== PINNED_PRIVACY_CLASSIFIER_HASH ||
      !deploymentIdentityId
    ) {
      return { materialized: 0, ready: 0, unavailable: 0 };
    }
    const targets =
      await options.privacyRepository.listSourceMaterializationTargets({
        limit: options.targetLimit
      });
    let materialized = 0;
    let ready = 0;
    let unavailable = 0;
    let sourceBytesProcessed = 0;
    let sourceRecordsProcessed = 0;
    let sanitizedChunksStored = 0;
    for (const target of targets) {
      try {
        const result = await materializeTarget(
          options,
          target,
          deploymentIdentityId
        );
        if (result.status === "materialized") materialized += 1;
        else ready += 1;
        sourceBytesProcessed += result.sourceBytesProcessed;
        sourceRecordsProcessed += result.sourceRecordsProcessed;
        sanitizedChunksStored += result.sanitizedChunksStored;
      } catch (error) {
        unavailable += 1;
        options.logger.warn(
          {
            event: {
              name: "worker.privacy_materialization.unavailable",
              category: "privacy"
            },
            error_name: safeErrorName(error)
          },
          "Team Conversation Source privacy material is unavailable"
        );
      }
    }
    options.logger.info(
      {
        event: {
          name: "worker.privacy_materialization.reconciled",
          category: "privacy"
        },
        privacyMaterialization: {
          targets: targets.length,
          materialized,
          ready,
          unavailable,
          sourceBytesProcessed,
          sourceRecordsProcessed,
          sanitizedChunksStored
        }
      },
      "privacy materialization reconciliation completed"
    );
    return { materialized, ready, unavailable };
  };

  const controller = createNotificationDrainController({
    channels: [
      "koed_team_conversation_source",
      "koed_conversation_source_replication"
    ],
    wakePool: options.wakePool,
    processOnce,
    onProcessError(error) {
      options.logger.warn(
        {
          event: {
            name: "worker.privacy_materialization.reconcile_failed",
            category: "privacy"
          },
          error_name: safeErrorName(error)
        },
        "privacy materialization reconciliation failed"
      );
    }
  });

  return {
    processOnce,
    start: controller.start,
    stop: controller.stop
  };
};
