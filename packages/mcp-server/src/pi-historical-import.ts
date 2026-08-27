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
import {
  automaticHistoricalAdmission,
  automaticHistoricalPolicyAdmits,
  completeAutomaticHistoricalRun,
  completeAutomaticHistoricalSource,
  createAutomaticHistoricalRun,
  historicalObjectValue,
  selectRecentHistoricalCandidates,
  transitionAutomaticHistoricalSource
} from "./automatic-historical-provider.js";
import type {
  HistoricalCandidateSelection,
  HistoricalProviderAdapter
} from "./historical-ingestion-coordinator.js";

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
  historicalCursorParserState?: Record<string, unknown>;
  historicalCursorCurrentTurnId?: string;
  registrationFrontierOffset: number;
  state: string;
};

export interface PiHistoricalCandidate {
  sourceSessionId: string;
  transcriptPath: string;
  cwd: string;
  latestActivityAt: string;
  frontierOffset: number;
  frontierLine?: number;
}
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
    const expectedOffset = artifact.providerCursorOffset;
    try {
      artifact = artifactFrom(
        await client.appendConversationSourceSegment(artifact.id, {
          expectedProviderOffset: expectedOffset,
          expectedProviderLine: artifact.providerCursorLine,
          sourceEndOffset: expectedOffset + bytes.length,
          sourceEndLine: artifact.providerCursorLine + lines,
          plaintextDigest: createHash("sha256").update(bytes).digest("hex"),
          plaintextSize: bytes.length,
          bytesBase64: bytes.toString("base64"),
          currentSourceLength: file.size,
          sourceModifiedAt: file.mtime.toISOString()
        })
      );
    } catch (error) {
      if (!(error instanceof MemoryApiError) || error.status !== 409) {
        throw error;
      }
      const converged = artifactFrom(
        await client.lookupConversationSourceArtifact({
          sourceKind: "pi",
          externalSessionId: identity.id
        })
      );
      if (converged.providerCursorOffset <= expectedOffset) throw error;
      artifact = converged;
    }
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

const lookupHistoricalSource = async (
  client: MemoryApiClient,
  artifactId: string
): Promise<HistoricalSource | null> => {
  try {
    return historicalObjectValue<HistoricalSource>(
      await client.lookupHistoricalImportSource(artifactId),
      "source",
      "pi_historical_source_missing"
    );
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
};

const importNextPiHistoricalBatch = async (
  client: MemoryApiClient,
  source: HistoricalSource,
  config: { maxRows: number; maxBytes: number }
): Promise<boolean> => {
  if (source.historicalCursorOffset >= source.registrationFrontierOffset) {
    return false;
  }
  const page = await client.listConversationSourceSegments(source.artifactId, {
    afterOffset: source.historicalCursorOffset,
    limit: 1
  });
  const segment = (page.segments as Segment[] | undefined)?.[0];
  if (
    !segment ||
    segment.sourceStartOffset > source.historicalCursorOffset ||
    segment.sourceEndOffset <= source.historicalCursorOffset
  ) {
    throw new Error("pi_historical_journal_segment_missing");
  }
  const content = await client.getConversationSourceSegmentContent(
    source.artifactId,
    segment.id
  );
  if (typeof content.bytesBase64 !== "string") {
    throw new Error("pi_historical_segment_content_missing");
  }
  const sourceBytes = Buffer.from(content.bytesBase64, "base64");
  const availableEnd = Math.min(
    segment.sourceEndOffset,
    source.registrationFrontierOffset
  );
  const available = sourceBytes.subarray(
    source.historicalCursorOffset - segment.sourceStartOffset,
    availableEnd - segment.sourceStartOffset
  );
  const sourceByteLimit = Math.max(1_024, Math.floor(config.maxBytes / 3));
  let localEnd = Math.min(available.length, sourceByteLimit);
  if (localEnd < available.length) {
    const newline = available.lastIndexOf(0x0a, localEnd - 1);
    if (newline < 0) {
      const next = available.indexOf(0x0a, localEnd);
      if (next < 0 || next + 1 > 3_500_000) {
        throw new Error("pi_historical_record_exceeds_batch_limit");
      }
      localEnd = next + 1;
    } else {
      localEnd = newline + 1;
    }
  }
  let rows = 0;
  for (let index = 0; index < localEnd; index += 1) {
    if (available[index] !== 0x0a) continue;
    rows += 1;
    if (rows === config.maxRows) {
      localEnd = index + 1;
      break;
    }
  }
  const parserState = source.historicalCursorParserState as
    | PiSessionParserState
    | undefined;
  let parsed: ReturnType<typeof parsePiSessionJournalBytes>;
  let items: ReturnType<typeof historicalItem>[];
  for (;;) {
    parsed = parsePiSessionJournalBytes({
      bytes: available.subarray(0, localEnd),
      absoluteStartOffset: source.historicalCursorOffset,
      lineIndexOffset: source.historicalCursorLine,
      sessionId: source.sessionId,
      externalSessionId: source.sourceSessionId,
      sourceFingerprint: source.sourceFingerprint,
      prior: parserState,
      sourceTransport: "historical_import"
    });
    items = parsed.items.map(historicalItem);
    if (Buffer.byteLength(JSON.stringify(items), "utf8") <= config.maxBytes) {
      break;
    }
    const previous = available.lastIndexOf(0x0a, localEnd - 2);
    if (previous < 0) {
      throw new Error("pi_historical_record_exceeds_batch_limit");
    }
    localEnd = previous + 1;
  }
  const end = source.historicalCursorOffset + localEnd;
  await client.ingestHistoricalImportBatch(source.id, {
    expectedSourceOffset: source.historicalCursorOffset,
    sourceOffset: end,
    sourceLine: parsed.checkpoint.lineCount,
    segmentIndex: segment.segmentIndex,
    lastVerifiedDigest: segment.plaintextDigest,
    parserState: parsed.parserState,
    items
  });
  return true;
};

const skipUnrepresentablePiSource = async (
  client: MemoryApiClient,
  source: HistoricalSource
): Promise<void> => {
  try {
    await client.transitionHistoricalImportSource(source.id, {
      expectedState: "importing",
      state: "failed",
      failureReason: "pi_historical_record_exceeds_batch_limit"
    });
  } catch (error) {
    if (!(error instanceof MemoryApiError) || error.status !== 409) throw error;
  }
  try {
    await client.transitionHistoricalImportSource(source.id, {
      expectedState: "failed",
      state: "skipped"
    });
  } catch (error) {
    if (!(error instanceof MemoryApiError) || error.status !== 409) throw error;
  }
};

const selectionSignal = (
  candidate: PiHistoricalCandidate
): PiTranscriptWatcherSignal => ({
  sourceSessionId: candidate.sourceSessionId,
  transcriptPath: candidate.transcriptPath,
  cwd: candidate.cwd,
  eventName: "HistoricalImport",
  observedAt: candidate.latestActivityAt
});

export const discoverPiHistoricalCandidates = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<PiHistoricalCandidate[]> =>
  Promise.all(
    (await discoverPiTranscriptSignals(env)).map(async (signal) => {
      const target = await verifiedPiSessionPath(signal.transcriptPath, env);
      const details = fs.statSync(target);
      const frontierOffset = completeTranscriptBoundary(target);
      return {
        sourceSessionId: signal.sourceSessionId,
        transcriptPath: target,
        cwd: signal.cwd,
        latestActivityAt: signal.observedAt ?? details.mtime.toISOString(),
        frontierOffset
      };
    })
  );

export const createPiHistoricalProviderAdapter = (input: {
  client: MemoryApiClient;
  env?: NodeJS.ProcessEnv;
}): HistoricalProviderAdapter<PiHistoricalCandidate> => {
  const env = input.env ?? process.env;
  const configuredRows = Number(env.MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_ROWS);
  const configuredBytes = Number(
    env.MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_BYTES
  );
  const batchConfig = {
    maxRows:
      Number.isSafeInteger(configuredRows) && configuredRows >= 1
        ? Math.min(configuredRows, 500)
        : 100,
    maxBytes:
      Number.isSafeInteger(configuredBytes) && configuredBytes >= 1_024
        ? Math.min(configuredBytes, 3_800_000)
        : 1_000_000
  };
  return {
    aiClient: "pi",
    discoverCandidates: () => discoverPiHistoricalCandidates(env),
    candidateId: (candidate) => candidate.sourceSessionId,
    selectCandidates: (candidates, now) =>
      selectRecentHistoricalCandidates({
        aiClient: "pi",
        candidates,
        now,
        adapterState: (candidate) => ({ projectId: candidate.cwd })
      }),
    async processNextBatch({ candidate, selection, runId }) {
      if (!candidate) {
        return { state: "waiting", selection, ...(runId ? { runId } : {}) };
      }
      let currentSelection: HistoricalCandidateSelection = selection;
      if (currentSelection.frontierLine < 0) {
        currentSelection = {
          ...currentSelection,
          frontierLine: await countTranscriptLines(
            candidate.transcriptPath,
            currentSelection.frontierOffset
          )
        };
      }
      if (!currentSelection.artifactId) {
        const artifact = await registerPiHistoricalTranscriptSource(
          input.client,
          selectionSignal(candidate),
          env
        );
        currentSelection = {
          ...currentSelection,
          artifactId: artifact.id
        };
      }
      const artifactId = currentSelection.artifactId!;
      const source = await lookupHistoricalSource(input.client, artifactId);
      let activeRunId = source?.runId ?? runId;
      if (!source) {
        activeRunId ??= await createAutomaticHistoricalRun(input.client);
        await input.client.createHistoricalImportSource({
          runId: activeRunId,
          artifactId,
          aiClient: "pi",
          detectedProject: {
            path: candidate.cwd,
            cwd: candidate.cwd
          }
        });
        return {
          state: "progress",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      activeRunId = source.runId;
      if (source.state === "completed" || source.state === "skipped") {
        return {
          state: source.state,
          selection: currentSelection,
          runId: activeRunId
        };
      }
      if (
        ["paused", "failed"].includes(source.state) ||
        !(await automaticHistoricalPolicyAdmits(
          input.client,
          currentSelection
        )) ||
        !(await automaticHistoricalAdmission(input.client)).admitted
      ) {
        return {
          state: "waiting",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      if (["discovered", "eligible", "queued"].includes(source.state)) {
        await transitionAutomaticHistoricalSource(input.client, source);
        return {
          state: "progress",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      if (source.state !== "importing") {
        return {
          state: "waiting",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      try {
        if (
          await importNextPiHistoricalBatch(input.client, source, batchConfig)
        ) {
          return {
            state: "progress",
            selection: currentSelection,
            runId: activeRunId
          };
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "pi_historical_record_exceeds_batch_limit"
        ) {
          throw error;
        }
        await skipUnrepresentablePiSource(input.client, source);
        return {
          state: "skipped",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      const completed = await completeAutomaticHistoricalSource(
        input.client,
        source.id
      );
      return {
        state: completed ? "completed" : "source_exhausted",
        selection: currentSelection,
        runId: activeRunId
      };
    },
    completeRun: (runId) => completeAutomaticHistoricalRun(input.client, runId)
  };
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
