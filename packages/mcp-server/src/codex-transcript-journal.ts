import { createHash } from "node:crypto";
import fs, { createReadStream, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { CONVERSATION_SOURCE_REPLICATION_MAX_SEGMENT_BYTES } from "@koed/shared";

import { MemoryApiError } from "./index.js";
import { rawConversationItemBatches } from "./raw-conversation-items.js";
import {
  buildCodexTranscriptConversationItems,
  extractTranscriptSessionMetadata,
  parseTranscriptJournalBytes,
  type TranscriptContext,
  type TranscriptJournalParserState
} from "./codex-transcript-parser.js";
import { codexCanonicalConversationItemKey } from "./codex-conversation-source-adapter.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";

const BOUNDARY_SCAN_BYTES = 64 * 1024;

export interface ConversationSourceArtifact {
  id: string;
  sessionId: string;
  externalSessionId: string;
  sourceFingerprint: string;
  journalStartOffset: number;
  journalStartLine: number;
  liveStartOffset: number;
  liveStartLine: number;
  providerCursorOffset: number;
  providerCursorLine: number;
  currentSourceLength: number;
  sourceModifiedAt: string | null;
}

interface ConversationSourceSegment {
  id: string;
  artifactId: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  plaintextDigest: string;
  plaintextSize: number;
}

interface ConversationSourceCursor {
  artifactId: string;
  consumerKind: "canonical_live";
  segmentIndex: number;
  sourceOffset: number;
  sourceLine: number;
  lastVerifiedDigest: string | null;
  parserState: TranscriptJournalParserState;
}

export interface ConversationSourceSessionRegistration {
  externalSessionId: string;
  sourceRuntime: "codex" | "codex-cli";
  captureMethod: "api";
  model?: string;
  cwd?: string;
  idempotencyKey: string;
  sourceHash?: string;
  metadata: Record<string, unknown>;
  detectedProjects?: Array<{
    id: string;
    name: string;
    path: string | null;
  }>;
}

const sourceCreatedAt = (
  context: TranscriptContext,
  transcriptPath: string,
  boundary: number
): string => {
  let value = context.transcriptMetadata.timestamp;
  if (typeof value !== "string" && boundary > 0) {
    const header = nextCompleteSourceSegment(
      transcriptPath,
      0,
      boundary,
      Math.min(boundary, BOUNDARY_SCAN_BYTES)
    );
    const parsed = parseTranscriptJournalBytes({
      bytes: header,
      absoluteStartOffset: 0,
      lineIndexOffset: 0
    });
    value = extractTranscriptSessionMetadata(parsed.records).transcriptMetadata
      .timestamp;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("transcript_source_created_at_missing");
  }
  return new Date(value).toISOString();
};

export interface CodexTranscriptJournalClient {
  ensureConversationSourceArtifact(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  lookupConversationSourceArtifact(input: {
    sourceKind: "codex";
    externalSessionId: string;
  }): Promise<Record<string, unknown>>;
  appendConversationSourceSegment(
    artifactId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  finalizeConversationSourceArtifact(
    artifactId: string,
    input: { expectedProviderOffset: number; expectedProviderLine: number }
  ): Promise<Record<string, unknown>>;
  listConversationSourceSegments(
    artifactId: string,
    input: { afterOffset: number; limit?: number }
  ): Promise<Record<string, unknown>>;
  getConversationSourceSegmentContent(
    artifactId: string,
    segmentId: string
  ): Promise<Record<string, unknown>>;
  getConversationSourceCursor(
    artifactId: string,
    consumerKind: string
  ): Promise<Record<string, unknown>>;
  advanceConversationSourceCursor(
    artifactId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  createConversationItems(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  projectConversationItems(
    input?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export interface CodexTranscriptJournalResult {
  artifact: ConversationSourceArtifact;
  providerBytesAdvanced: number;
  canonicalCursorOffset: number;
  cursorAdvanced: boolean;
  turnOpen: boolean;
  turnBoundaryHandled: boolean;
  recordsConsumed: number;
  itemsPersisted: number;
  items: RawConversationItemRequest[];
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const sha256Bytes = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const responseValue = <T>(
  response: Record<string, unknown>,
  key: string
): T => {
  const value = response[key];
  if (!value || typeof value !== "object") {
    throw new Error(`journal_api_response_missing_${key}`);
  }
  return value as T;
};

const isConcurrentCanonicalCursorAdvance = (error: unknown): boolean => {
  if (!(error instanceof MemoryApiError) || error.status !== 409) return false;
  const payload =
    error.payload && typeof error.payload === "object"
      ? (error.payload as { code?: unknown })
      : null;
  return (
    payload?.code === "conversation_source_consumer_cursor_conflict" ||
    error.message === "Conversation source consumer cursor conflict"
  );
};

const readSourceRange = (
  transcriptPath: string,
  start: number,
  end: number
): Buffer => {
  if (end <= start) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(end - start);
  const descriptor = fs.openSync(transcriptPath, "r");
  try {
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      0,
      buffer.byteLength,
      start
    );
    if (bytesRead !== buffer.byteLength) {
      throw new Error("transcript_source_short_read");
    }
    return buffer;
  } finally {
    fs.closeSync(descriptor);
  }
};

const nextCompleteSourceSegment = (
  transcriptPath: string,
  start: number,
  boundary: number,
  targetBytes: number,
  maximumRecordBytes = CONVERSATION_SOURCE_REPLICATION_MAX_SEGMENT_BYTES
): Buffer => {
  if (boundary <= start) return Buffer.alloc(0);
  const requestedEnd = Math.min(boundary, start + targetBytes);
  const candidate = readSourceRange(transcriptPath, start, requestedEnd);
  if (requestedEnd === boundary) {
    if (candidate.at(-1) !== 0x0a) {
      throw new Error("journal_segment_incomplete");
    }
    return candidate;
  }
  const lastNewline = candidate.lastIndexOf(0x0a);
  if (lastNewline >= 0) return candidate.subarray(0, lastNewline + 1);

  const expandedEnd = Math.min(boundary, start + maximumRecordBytes);
  const expanded = readSourceRange(transcriptPath, start, expandedEnd);
  const expandedNewline = expanded.indexOf(0x0a);
  if (expandedNewline < 0) throw new Error("transcript_record_too_large");
  return expanded.subarray(0, expandedNewline + 1);
};

export const completeTranscriptBoundary = (
  transcriptPath: string,
  maxRecordBytes = 16 * 1024 * 1024
): number => {
  const size = statSync(transcriptPath).size;
  if (size === 0) return 0;
  const descriptor = fs.openSync(transcriptPath, "r");
  try {
    const finalByte = Buffer.allocUnsafe(1);
    fs.readSync(descriptor, finalByte, 0, 1, size - 1);
    if (finalByte[0] === 0x0a) return size;
    const segments: Buffer[] = [finalByte];
    let scanned = 1;
    for (let end = size - 1; end > 0; ) {
      const length = Math.min(BOUNDARY_SCAN_BYTES, end, maxRecordBytes);
      const start = end - length;
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(descriptor, buffer, 0, length, start);
      const newline = buffer.lastIndexOf(0x0a);
      if (newline >= 0) {
        const trailing = Buffer.concat([
          buffer.subarray(newline + 1),
          ...segments
        ]).toString("utf8");
        if (!trailing.trim()) return size;
        try {
          JSON.parse(trailing);
          return size;
        } catch {
          return start + newline + 1;
        }
      }
      segments.unshift(buffer);
      scanned += length;
      end = start;
      if (scanned > maxRecordBytes) {
        throw new Error("transcript_record_too_large");
      }
    }
    return 0;
  } finally {
    fs.closeSync(descriptor);
  }
};

export const countTranscriptLines = async (
  transcriptPath: string,
  throughOffset: number
): Promise<number> => {
  if (throughOffset === 0) return 0;
  let lines = 0;
  const stream = createReadStream(transcriptPath, {
    start: 0,
    end: throughOffset - 1,
    highWaterMark: 256 * 1024
  });
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] === 0x0a) lines += 1;
    }
  }
  return lines;
};

const lookupArtifact = async (
  client: CodexTranscriptJournalClient,
  sourceSessionId: string
): Promise<ConversationSourceArtifact | null> => {
  try {
    const response = await client.lookupConversationSourceArtifact({
      sourceKind: "codex",
      externalSessionId: sourceSessionId
    });
    return responseValue<ConversationSourceArtifact>(response, "artifact");
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
};

const listSegments = async (
  client: CodexTranscriptJournalClient,
  artifactId: string,
  afterOffset: number,
  limit = 2
): Promise<ConversationSourceSegment[]> => {
  const response = await client.listConversationSourceSegments(artifactId, {
    afterOffset,
    limit
  });
  if (!Array.isArray(response.segments)) {
    throw new Error("journal_api_response_missing_segments");
  }
  return response.segments as ConversationSourceSegment[];
};

const segmentBytes = async (
  client: CodexTranscriptJournalClient,
  artifactId: string,
  segment: ConversationSourceSegment
): Promise<Buffer> => {
  const response = await client.getConversationSourceSegmentContent(
    artifactId,
    segment.id
  );
  if (typeof response.bytesBase64 !== "string") {
    throw new Error("journal_api_response_missing_segment_content");
  }
  const bytes = Buffer.from(response.bytesBase64, "base64");
  if (
    bytes.byteLength !== segment.plaintextSize ||
    sha256Bytes(bytes) !== segment.plaintextDigest
  ) {
    throw new Error("journal_segment_verification_failed");
  }
  return bytes;
};

const verifyJournalledPrefix = async (
  client: CodexTranscriptJournalClient,
  artifact: ConversationSourceArtifact,
  transcriptPath: string,
  sourceSize: number
): Promise<void> => {
  if (sourceSize < artifact.providerCursorOffset) {
    throw new Error("transcript_truncated");
  }
  if (artifact.providerCursorOffset === artifact.journalStartOffset) return;
  const segment = (
    await listSegments(
      client,
      artifact.id,
      artifact.providerCursorOffset - 1,
      1
    )
  )[0];
  if (!segment || segment.sourceEndOffset !== artifact.providerCursorOffset) {
    throw new Error("journal_segment_chain_incomplete");
  }
  const currentBytes = readSourceRange(
    transcriptPath,
    segment.sourceStartOffset,
    segment.sourceEndOffset
  );
  if (sha256Bytes(currentBytes) !== segment.plaintextDigest) {
    throw new Error("transcript_prefix_mutated");
  }
};

const canonicalCursor = async (
  client: CodexTranscriptJournalClient,
  artifact: ConversationSourceArtifact
): Promise<ConversationSourceCursor> => {
  const response = await client.getConversationSourceCursor(
    artifact.id,
    "canonical_live"
  );
  if (response.cursor && typeof response.cursor === "object") {
    return response.cursor as ConversationSourceCursor;
  }
  return {
    artifactId: artifact.id,
    consumerKind: "canonical_live",
    segmentIndex: 0,
    sourceOffset: artifact.liveStartOffset,
    sourceLine: artifact.liveStartLine,
    lastVerifiedDigest: null,
    parserState: {}
  };
};

const persistItems = async (
  client: CodexTranscriptJournalClient,
  items: RawConversationItemRequest[],
  authorize?: () => Promise<void>
): Promise<Array<RawConversationItemRequest & { id?: string }>> => {
  const persisted: Array<RawConversationItemRequest & { id?: string }> = [];
  for (const batch of rawConversationItemBatches(items)) {
    await authorize?.();
    const response = await client.createConversationItems({ items: batch });
    if (Array.isArray(response.items)) {
      persisted.push(
        ...(response.items as Array<
          RawConversationItemRequest & { id?: string }
        >)
      );
    }
  }
  return persisted;
};

const projectItems = async (
  client: CodexTranscriptJournalClient,
  items: Array<{ id?: string }>
): Promise<void> => {
  const ids = items
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  for (let index = 0; index < ids.length; index += 1_000) {
    const conversationItemIds = ids.slice(index, index + 1_000);
    await client.projectConversationItems({
      conversationItemIds,
      limit: conversationItemIds.length
    });
  }
};

const transcriptTurnCompleted = (item: RawConversationItemRequest): boolean =>
  (item.sourceAdapterVersion === "codex-transcript-v1" &&
    ["task_complete", "turn_aborted"].includes(item.sourceEventType ?? "")) ||
  (item.sourceAdapterVersion === "codex-app-server-conversation-v1" &&
    item.sourceEventType === "turn/completed");

const turnBoundaryControl = (input: {
  artifact: ConversationSourceArtifact;
  externalTurnId: string;
  sourceOffset: number;
  sourceLine: number;
  observedAt: number;
}): RawConversationItemRequest => {
  const stableItemId = `turn:${input.externalTurnId}:completed`;
  const identityDigest = sha256(
    JSON.stringify({
      version: 1,
      externalSessionId: input.artifact.externalSessionId,
      externalTurnId: input.externalTurnId,
      sourceOffset: input.sourceOffset,
      sourceLine: input.sourceLine
    })
  );
  const observedAt = new Date(input.observedAt).toISOString();
  return {
    sessionId: input.artifact.sessionId,
    sourceKind: "codex",
    sourceAdapterVersion: "codex-hook-signal-v1",
    sourceTransport: "hook_signal",
    externalSessionId: input.artifact.externalSessionId,
    externalThreadId: input.artifact.externalSessionId,
    externalTurnId: input.externalTurnId,
    externalItemId: stableItemId,
    sourceRecordType: "hook_signal",
    sourceEventType: "turn_completed",
    sourceSequence: input.sourceLine,
    eventTime: observedAt,
    observedAt,
    rawJson: {
      type: "hook_signal",
      payload: {
        type: "turn_completed",
        sourceFrontierOffset: input.sourceOffset,
        sourceFrontierLine: input.sourceLine
      }
    },
    sourceHash: identityDigest,
    idempotencyKey: `codex-hook-turn-boundary:${identityDigest}`,
    canonicalItemKey: codexCanonicalConversationItemKey({
      externalThreadId: input.artifact.externalSessionId,
      externalTurnId: input.externalTurnId,
      stableItemId,
      component: "control"
    }),
    canonicalStableItemId: stableItemId,
    observationKind: "control",
    observationComponent: "control",
    projectionStatus: "pending",
    projectionVersion: "codex-hook-signal-v1",
    metadata: {
      sourceEventTimeAccuracy: "source",
      sourceFrontierOffset: input.sourceOffset,
      sourceFrontierLine: input.sourceLine
    }
  };
};

export const ingestCodexTranscriptJournal = async (input: {
  client: CodexTranscriptJournalClient;
  sourceSession: ConversationSourceSessionRegistration;
  sourceSessionId: string;
  transcriptPath: string;
  context: TranscriptContext;
  maxBytesPerBatch: number;
  journalStartOffset?: number;
  journalStartLine?: number;
  liveStartOffset: number;
  liveStartLine: number;
  existingArtifact?: ConversationSourceArtifact | null;
  preferStableResponseItems?: boolean;
  turnBoundaryObservedAt?: number;
  turnBoundarySourceOffset?: number;
  authorize?: () => Promise<void>;
  projectPersisted?: (
    persisted: Array<RawConversationItemRequest & { id?: string }>,
    source: RawConversationItemRequest[]
  ) => Promise<boolean | void>;
}): Promise<CodexTranscriptJournalResult> => {
  const file = await stat(input.transcriptPath);
  if (!file.isFile()) throw new Error("transcript_source_not_file");
  const boundary = completeTranscriptBoundary(
    input.transcriptPath,
    CONVERSATION_SOURCE_REPLICATION_MAX_SEGMENT_BYTES
  );
  let artifact =
    input.existingArtifact === undefined
      ? await lookupArtifact(input.client, input.sourceSessionId)
      : input.existingArtifact;
  if (artifact) {
    await verifyJournalledPrefix(
      input.client,
      artifact,
      input.transcriptPath,
      file.size
    );
  }
  const response = await input.client.ensureConversationSourceArtifact({
    sourceSession: input.sourceSession,
    sourceKind: "codex",
    externalSessionId: input.sourceSessionId,
    sourceFingerprint: sha256(`codex-transcript-v1:${input.sourceSessionId}`),
    artifactFormat: "codex_rollout_jsonl",
    artifactFormatVersion: 1,
    journalStartOffset:
      artifact?.journalStartOffset ?? input.journalStartOffset ?? 0,
    journalStartLine: artifact?.journalStartLine ?? input.journalStartLine ?? 0,
    liveStartOffset: artifact?.liveStartOffset ?? input.liveStartOffset,
    liveStartLine: artifact?.liveStartLine ?? input.liveStartLine,
    currentSourceLength: file.size,
    sourceCreatedAt: sourceCreatedAt(
      input.context,
      input.transcriptPath,
      boundary
    ),
    sourceModifiedAt: file.mtime.toISOString(),
    redactedSourceLabel: path.basename(input.transcriptPath)
  });
  artifact = responseValue<ConversationSourceArtifact>(response, "artifact");
  const providerOffsetBefore = artifact.providerCursorOffset;
  if (boundary > artifact.providerCursorOffset) {
    const bytes = nextCompleteSourceSegment(
      input.transcriptPath,
      artifact.providerCursorOffset,
      boundary,
      input.maxBytesPerBatch
    );
    if (bytes.byteLength > 0) {
      const lineCount = bytes.reduce(
        (count, byte) => count + (byte === 0x0a ? 1 : 0),
        0
      );
      const appendResponse = await input.client.appendConversationSourceSegment(
        artifact.id,
        {
          expectedProviderOffset: artifact.providerCursorOffset,
          expectedProviderLine: artifact.providerCursorLine,
          sourceEndOffset: artifact.providerCursorOffset + bytes.byteLength,
          sourceEndLine: artifact.providerCursorLine + lineCount,
          plaintextDigest: sha256Bytes(bytes),
          plaintextSize: bytes.byteLength,
          bytesBase64: bytes.toString("base64"),
          currentSourceLength: file.size,
          sourceModifiedAt: file.mtime.toISOString()
        }
      );
      artifact = responseValue<ConversationSourceArtifact>(
        appendResponse,
        "artifact"
      );
    }
  }

  const cursor = await canonicalCursor(input.client, artifact);
  const hasTurnBoundary =
    input.turnBoundaryObservedAt !== undefined &&
    input.turnBoundarySourceOffset !== undefined;
  if (
    (input.turnBoundaryObservedAt === undefined) !==
    (input.turnBoundarySourceOffset === undefined)
  ) {
    throw new Error("turn_boundary_identity_incomplete");
  }
  if (
    hasTurnBoundary &&
    input.turnBoundarySourceOffset! < cursor.sourceOffset
  ) {
    throw new Error("turn_boundary_frontier_already_consumed");
  }
  if (
    hasTurnBoundary &&
    input.turnBoundarySourceOffset! > artifact.providerCursorOffset
  ) {
    throw new Error("turn_boundary_frontier_not_journalled");
  }
  if (
    hasTurnBoundary &&
    input.turnBoundarySourceOffset === cursor.sourceOffset
  ) {
    const activeTurnId = cursor.parserState.activeTurnId;
    const boundaryItems = activeTurnId
      ? [
          turnBoundaryControl({
            artifact,
            externalTurnId: activeTurnId,
            sourceOffset: cursor.sourceOffset,
            sourceLine: cursor.sourceLine,
            observedAt: input.turnBoundaryObservedAt!
          })
        ]
      : [];
    const persisted =
      boundaryItems.length > 0
        ? await persistItems(input.client, boundaryItems, input.authorize)
        : [];
    if (persisted.length > 0) {
      await projectItems(input.client, persisted);
    }
    return {
      artifact,
      providerBytesAdvanced:
        artifact.providerCursorOffset - providerOffsetBefore,
      canonicalCursorOffset: cursor.sourceOffset,
      cursorAdvanced: false,
      turnOpen: false,
      turnBoundaryHandled: true,
      recordsConsumed: 0,
      itemsPersisted: persisted.length,
      items: boundaryItems
    };
  }
  if (cursor.sourceOffset >= artifact.providerCursorOffset) {
    return {
      artifact,
      providerBytesAdvanced:
        artifact.providerCursorOffset - providerOffsetBefore,
      canonicalCursorOffset: cursor.sourceOffset,
      cursorAdvanced: false,
      turnOpen: Boolean(cursor.parserState.activeTurnId),
      turnBoundaryHandled: false,
      recordsConsumed: 0,
      itemsPersisted: 0,
      items: []
    };
  }
  const segments = await listSegments(
    input.client,
    artifact.id,
    cursor.sourceOffset
  );
  if (segments.length === 0) {
    throw new Error("journal_segment_chain_incomplete");
  }
  let expectedOffset = cursor.sourceOffset;
  const parts: Buffer[] = [];
  for (const segment of segments) {
    if (
      segment.sourceStartOffset > expectedOffset ||
      segment.sourceEndOffset <= expectedOffset
    ) {
      throw new Error("journal_segment_chain_conflict");
    }
    const bytes = await segmentBytes(input.client, artifact.id, segment);
    const start = Math.max(0, expectedOffset - segment.sourceStartOffset);
    parts.push(bytes.subarray(start));
    expectedOffset = segment.sourceEndOffset;
  }
  const availableBytes = Buffer.concat(parts);
  const turnBoundaryInPage =
    hasTurnBoundary &&
    input.turnBoundarySourceOffset! > cursor.sourceOffset &&
    input.turnBoundarySourceOffset! <= expectedOffset;
  const parserBytes = turnBoundaryInPage
    ? availableBytes.subarray(
        0,
        input.turnBoundarySourceOffset! - cursor.sourceOffset
      )
    : availableBytes;
  const parsed = parseTranscriptJournalBytes({
    bytes: parserBytes,
    absoluteStartOffset: cursor.sourceOffset,
    lineIndexOffset: cursor.sourceLine,
    prior: cursor.parserState,
    deferPageEndingAssistantEvent: !turnBoundaryInPage
  });
  if (parsed.checkpoint.offset <= cursor.sourceOffset) {
    return {
      artifact,
      providerBytesAdvanced:
        artifact.providerCursorOffset - providerOffsetBefore,
      canonicalCursorOffset: cursor.sourceOffset,
      cursorAdvanced: false,
      turnOpen: Boolean(cursor.parserState.activeTurnId),
      turnBoundaryHandled: false,
      recordsConsumed: 0,
      itemsPersisted: 0,
      items: []
    };
  }
  const checkpointSegment = segments.find(
    (segment) =>
      parsed.checkpoint.offset > segment.sourceStartOffset &&
      parsed.checkpoint.offset <= segment.sourceEndOffset
  );
  if (!checkpointSegment) {
    throw new Error("journal_checkpoint_outside_segment");
  }
  const sourceItems = buildCodexTranscriptConversationItems({
    records: parsed.records,
    indexOffset: parsed.indexOffset,
    sessionId: artifact.sessionId,
    sourceSessionId: artifact.externalSessionId,
    sourceTransport: "transcript",
    sourceFingerprint: artifact.sourceFingerprint,
    threadKind: input.context.threadKind,
    parentThreadId: input.context.parentThreadId,
    preferStableResponseItems: input.preferStableResponseItems
  });
  let activeTurnId = parsed.checkpoint.activeTurnId;
  if (!activeTurnId) {
    for (let index = sourceItems.length - 1; index >= 0; index -= 1) {
      const externalTurnId = sourceItems[index]?.externalTurnId;
      if (externalTurnId) {
        activeTurnId = externalTurnId;
        break;
      }
    }
  }
  const sourceCompletedTurn = sourceItems.some(transcriptTurnCompleted);
  const turnBoundaryAtCheckpoint =
    turnBoundaryInPage &&
    parsed.checkpoint.offset === input.turnBoundarySourceOffset;
  const boundaryControl =
    turnBoundaryAtCheckpoint && activeTurnId && !sourceCompletedTurn
      ? turnBoundaryControl({
          artifact,
          externalTurnId: activeTurnId,
          sourceOffset: parsed.checkpoint.offset,
          sourceLine: parsed.checkpoint.lineCount,
          observedAt: input.turnBoundaryObservedAt!
        })
      : null;
  const items = boundaryControl
    ? [...sourceItems, boundaryControl]
    : sourceItems;
  const persisted = await persistItems(input.client, items, input.authorize);
  let shouldAdvance = true;
  if (input.projectPersisted) {
    shouldAdvance = (await input.projectPersisted(persisted, items)) !== false;
  } else {
    await projectItems(input.client, persisted);
  }
  if (!shouldAdvance) {
    return {
      artifact,
      providerBytesAdvanced:
        artifact.providerCursorOffset - providerOffsetBefore,
      canonicalCursorOffset: cursor.sourceOffset,
      cursorAdvanced: false,
      turnOpen: Boolean(parsed.checkpoint.activeTurnId),
      turnBoundaryHandled: false,
      recordsConsumed: parsed.records.length,
      itemsPersisted: persisted.length,
      items
    };
  }
  const completedTurn = sourceCompletedTurn || boundaryControl !== null;
  let canonicalCursorOffset = parsed.checkpoint.offset;
  let cursorAdvanced = true;
  try {
    await input.client.advanceConversationSourceCursor(artifact.id, {
      consumerKind: "canonical_live",
      expectedSourceOffset: cursor.sourceOffset,
      sourceOffset: parsed.checkpoint.offset,
      sourceLine: parsed.checkpoint.lineCount,
      segmentIndex: checkpointSegment.segmentIndex,
      lastVerifiedDigest: checkpointSegment.plaintextDigest,
      parserState: {
        ...(parsed.checkpoint.lastEventTime
          ? { lastEventTime: parsed.checkpoint.lastEventTime }
          : {}),
        ...(activeTurnId ? { activeTurnId } : {}),
        ...(parsed.checkpoint.assistantMessagePreference
          ? {
              assistantMessagePreference:
                parsed.checkpoint.assistantMessagePreference
            }
          : {})
      }
    });
  } catch (error) {
    if (!isConcurrentCanonicalCursorAdvance(error)) throw error;
    const winningCursor = await canonicalCursor(input.client, artifact);
    if (winningCursor.sourceOffset < parsed.checkpoint.offset) throw error;
    canonicalCursorOffset = winningCursor.sourceOffset;
    cursorAdvanced = false;
  }
  return {
    artifact,
    providerBytesAdvanced: artifact.providerCursorOffset - providerOffsetBefore,
    canonicalCursorOffset,
    cursorAdvanced,
    turnOpen: !completedTurn && Boolean(activeTurnId),
    turnBoundaryHandled:
      turnBoundaryAtCheckpoint &&
      canonicalCursorOffset >= parsed.checkpoint.offset &&
      (completedTurn || !activeTurnId),
    recordsConsumed: parsed.records.length,
    itemsPersisted: persisted.length,
    items
  };
};
