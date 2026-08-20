import { createHash } from "node:crypto";
import fs from "node:fs";

import {
  completeTranscriptBoundary,
  countTranscriptLines
} from "./codex-transcript-journal.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";
import { MemoryApiClient, MemoryApiError } from "./index.js";
import {
  parsePiSessionJournalBytes,
  type PiSessionParserState
} from "./pi-session-parser.js";
import {
  discoverPiTranscriptSignals,
  piSessionIdentity,
  verifiedPiSessionPath,
  type PiTranscriptWatcherSignal
} from "./pi-transcript-watcher.js";

type Artifact = {
  id: string;
  sessionId: string;
  providerCursorOffset: number;
  providerCursorLine: number;
  sourceFingerprint: string;
};
type HistoricalSource = {
  id: string;
  runId: string;
  artifactId: string;
  sessionId: string;
  sourceSessionId: string;
  sourceFingerprint: string;
  historicalCursorOffset: number;
  historicalCursorLine: number;
  historicalCursorCurrentTurnId?: string;
  registrationFrontierOffset: number;
  state: string;
};
type Segment = {
  id: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  plaintextDigest: string;
};
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const artifactFrom = (response: Record<string, unknown>): Artifact => {
  if (!response.artifact || typeof response.artifact !== "object")
    throw new Error("pi_historical_artifact_missing");
  return response.artifact as Artifact;
};
const objectFrom = <T>(response: Record<string, unknown>, key: string): T => {
  const value = response[key];
  if (!value || typeof value !== "object")
    throw new Error(`pi_historical_${key}_missing`);
  return value as T;
};
const readRange = (target: string, start: number, end: number): Buffer => {
  if (end - start > 16 * 1024 * 1024)
    throw new Error("pi_historical_read_range_unbounded");
  const bytes = Buffer.alloc(end - start);
  const descriptor = fs.openSync(target, "r");
  try {
    if (fs.readSync(descriptor, bytes, 0, bytes.length, start) !== bytes.length)
      throw new Error("pi_historical_short_read");
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
};

export const registerPiHistoricalTranscriptSource = async (
  client: MemoryApiClient,
  signal: PiTranscriptWatcherSignal,
  env: NodeJS.ProcessEnv = process.env
): Promise<Artifact & { registrationFrontierOffset: number }> => {
  const target = await verifiedPiSessionPath(signal.transcriptPath, env);
  const identity = piSessionIdentity(target);
  if (identity.id !== signal.sourceSessionId)
    throw new Error("pi_historical_session_identity_mismatch");
  const file = fs.statSync(target);
  const boundary = completeTranscriptBoundary(target);
  const fingerprint = hash({
    adapter: "pi-session-v1",
    sessionId: identity.id,
    path: target
  });
  let artifact: Artifact;
  try {
    artifact = artifactFrom(
      await client.lookupConversationSourceArtifact({
        sourceKind: "pi",
        externalSessionId: identity.id
      })
    );
  } catch (error) {
    if (!(error instanceof MemoryApiError) || error.status !== 404) throw error;
    artifact = artifactFrom(
      await client.ensureConversationSourceArtifact({
        sourceSession: {
          externalSessionId: identity.id,
          sourceRuntime: "pi",
          captureMethod: "api",
          cwd: identity.cwd,
          idempotencyKey: `pi-session:${identity.id}`,
          sourceHash: hash({ provider: "pi", sessionId: identity.id }),
          metadata: {
            sourceKind: "pi",
            sourceAdapterVersion: "pi-session-v1",
            parentSession: identity.parentSession ?? null
          }
        },
        sourceKind: "pi",
        sourceComponentId: "main",
        sourceComponentRole: "primary",
        parentSourceComponentId: null,
        contentFraming: "jsonl",
        externalSessionId: identity.id,
        sourceFingerprint: fingerprint,
        artifactFormat: "pi_session_jsonl",
        artifactFormatVersion: 1,
        journalStartOffset: 0,
        journalStartLine: 0,
        liveStartOffset: boundary,
        liveStartLine: await countTranscriptLines(target, boundary),
        currentSourceLength: file.size,
        sourceCreatedAt: file.birthtime.toISOString(),
        sourceModifiedAt: file.mtime.toISOString(),
        redactedSourceLabel: `${identity.id}.jsonl`
      })
    );
  }
  while (artifact.providerCursorOffset < boundary) {
    const maximum = Math.min(
      boundary,
      artifact.providerCursorOffset + 16 * 1024 * 1024
    );
    let bytes = readRange(target, artifact.providerCursorOffset, maximum);
    if (maximum < boundary) {
      const newline = bytes.lastIndexOf(0x0a);
      if (newline < 0) throw new Error("pi_historical_record_too_large");
      bytes = bytes.subarray(0, newline + 1);
    }
    const lines = bytes.reduce(
      (count, byte) => count + (byte === 10 ? 1 : 0),
      0
    );
    artifact = artifactFrom(
      await client.appendConversationSourceSegment(artifact.id, {
        expectedProviderOffset: artifact.providerCursorOffset,
        expectedProviderLine: artifact.providerCursorLine,
        sourceEndOffset: artifact.providerCursorOffset + bytes.length,
        sourceEndLine: artifact.providerCursorLine + lines,
        plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
        plaintextSize: bytes.length,
        bytesBase64: bytes.toString("base64"),
        currentSourceLength: file.size,
        sourceModifiedAt: file.mtime.toISOString()
      })
    );
  }
  return {
    ...artifact,
    sourceFingerprint: artifact.sourceFingerprint ?? fingerprint,
    registrationFrontierOffset: boundary
  };
};

const historicalItem = (item: RawConversationItemRequest) => ({
  sessionId: item.sessionId,
  externalThreadId: item.externalThreadId,
  externalTurnId: item.externalTurnId,
  externalItemId: item.externalItemId,
  parentExternalItemId: item.parentExternalItemId,
  sourceRecordType: item.sourceRecordType,
  sourceEventType: item.sourceEventType,
  sourceLineNumber: item.sourceLineNumber,
  sourceSequence: item.sourceSequence,
  eventTime: item.eventTime,
  rawJson: item.rawJson,
  rawText: item.rawText,
  sourceHash: item.sourceHash,
  idempotencyKey: item.idempotencyKey,
  canonicalItemKey: item.canonicalItemKey,
  canonicalStableItemId: item.canonicalStableItemId,
  observationKind: item.observationKind,
  observationComponent: item.observationComponent,
  projectionStatus: item.projectionStatus,
  projectionVersion: "pi-session-v1" as const,
  metadata: item.metadata
});

export const importPiHistoricalSource = async (
  client: MemoryApiClient,
  source: HistoricalSource
): Promise<{ sourceId: string; batchCount: number; itemCount: number }> => {
  let offset = source.historicalCursorOffset;
  let line = source.historicalCursorLine;
  let parserState: PiSessionParserState | undefined;
  let batchCount = 0;
  let itemCount = 0;
  while (offset < source.registrationFrontierOffset) {
    const page = await client.listConversationSourceSegments(
      source.artifactId,
      { afterOffset: offset, limit: 20 }
    );
    const segments = (page.segments as Segment[] | undefined) ?? [];
    if (segments.length === 0)
      throw new Error("pi_historical_journal_segment_missing");
    for (const segment of segments) {
      if (
        offset >= source.registrationFrontierOffset ||
        segment.sourceEndOffset <= offset ||
        segment.sourceStartOffset > offset
      )
        continue;
      const content = await client.getConversationSourceSegmentContent(
        source.artifactId,
        segment.id
      );
      if (typeof content.bytesBase64 !== "string")
        throw new Error("pi_historical_segment_content_missing");
      const sourceBytes = Buffer.from(content.bytesBase64, "base64");
      const end = Math.min(
        segment.sourceEndOffset,
        source.registrationFrontierOffset
      );
      const bytes = sourceBytes.subarray(
        offset - segment.sourceStartOffset,
        end - segment.sourceStartOffset
      );
      const parsed = parsePiSessionJournalBytes({
        bytes,
        absoluteStartOffset: offset,
        lineIndexOffset: line,
        sessionId: source.sessionId,
        externalSessionId: source.sourceSessionId,
        sourceFingerprint: source.sourceFingerprint,
        prior: parserState,
        sourceTransport: "historical_import"
      });
      const items = parsed.items.map(historicalItem);
      await client.ingestHistoricalImportBatch(source.id, {
        expectedSourceOffset: offset,
        sourceOffset: end,
        sourceLine: parsed.checkpoint.lineCount,
        segmentIndex: segment.segmentIndex,
        lastVerifiedDigest: segment.plaintextDigest,
        parserState: parsed.parserState,
        items
      });
      offset = end;
      line = parsed.checkpoint.lineCount;
      parserState = parsed.parserState;
      batchCount += 1;
      itemCount += items.length;
    }
  }
  return { sourceId: source.id, batchCount, itemCount };
};

const transition = (
  client: MemoryApiClient,
  kind: "run" | "source",
  id: string,
  expectedState: string,
  state: string
) =>
  kind === "run"
    ? client.transitionHistoricalImportRun(id, { expectedState, state })
    : client.transitionHistoricalImportSource(id, { expectedState, state });

export const importSelectedPiHistory = async (input: {
  client: MemoryApiClient;
  sourceSessionIds: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> => {
  const requested = new Set(input.sourceSessionIds);
  if (requested.size === 0)
    throw new Error("pi_historical_import_requires_session_selection");
  const signals = (await discoverPiTranscriptSignals(input.env)).filter(
    (signal) => requested.has(signal.sourceSessionId)
  );
  const found = new Set(signals.map((signal) => signal.sourceSessionId));
  const missing = [...requested].filter((id) => !found.has(id));
  if (missing.length)
    throw new Error(`pi_historical_sessions_not_found:${missing.join(",")}`);
  const run = objectFrom<{ id: string }>(
    await input.client.createHistoricalImportRun(),
    "run"
  );
  for (const [from, to] of [
    ["discovered", "eligible"],
    ["eligible", "queued"],
    ["queued", "importing"]
  ] as const)
    await transition(input.client, "run", run.id, from, to);
  const results = [];
  for (const signal of signals) {
    const artifact = await registerPiHistoricalTranscriptSource(
      input.client,
      signal,
      input.env
    );
    let source = objectFrom<HistoricalSource>(
      await input.client.createHistoricalImportSource({
        runId: run.id,
        artifactId: artifact.id,
        aiClient: "pi",
        detectedProject: { path: signal.cwd, cwd: signal.cwd }
      }),
      "source"
    );
    for (const [from, to] of [
      ["discovered", "eligible"],
      ["eligible", "queued"],
      ["queued", "importing"]
    ] as const)
      if (source.state === from)
        source = objectFrom<HistoricalSource>(
          await transition(input.client, "source", source.id, from, to),
          "source"
        );
    const result = await importPiHistoricalSource(input.client, {
      ...source,
      registrationFrontierOffset: artifact.registrationFrontierOffset,
      sourceFingerprint: artifact.sourceFingerprint
    });
    await transition(
      input.client,
      "source",
      source.id,
      "importing",
      "completed"
    );
    results.push(result);
  }
  return { runId: run.id, sources: results };
};
