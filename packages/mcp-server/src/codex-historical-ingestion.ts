import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { HistoricalAdmissionDecision } from "@koed/shared";

import {
  countTranscriptLines,
  ingestCodexTranscriptJournal,
  type ConversationSourceArtifact,
  type ConversationSourceSessionRegistration
} from "./codex-transcript-journal.js";
import {
  buildCodexTranscriptConversationItems,
  parseTranscriptJournalBytes,
  type TranscriptContext,
  type TranscriptJournalParserState
} from "./codex-transcript-parser.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";
import {
  type HistoricalCandidateSelection,
  type HistoricalProviderAdapter
} from "./historical-ingestion-coordinator.js";
import { MemoryApiClient, MemoryApiError } from "./index.js";

const AUTOMATIC_WINDOW_DAYS = 30;
const AUTOMATIC_CONVERSATION_CAP = 50;

export interface CodexHistoricalCandidate {
  sourceSessionId: string;
  transcriptPath: string;
  context: TranscriptContext;
  sourceSession: ConversationSourceSessionRegistration;
  frontierOffset: number;
  frontierLine?: number;
  latestActivityAt: string;
  projectId?: string;
  projectName: string;
  projectFingerprint?: string;
}

export interface CodexHistoricalIngestionConfig {
  maxBatchRows: number;
  maxBatchBytes: number;
  maxBatchRuntimeMs: number;
  maxJournalBytesPerBatch: number;
}

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
  registrationFrontierOffset: number;
  state: string;
};

type SourceSegment = {
  id: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  plaintextDigest: string;
  plaintextSize: number;
};

const boundedInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
};

export const resolveCodexHistoricalIngestionConfig = (
  env: NodeJS.ProcessEnv = process.env
): CodexHistoricalIngestionConfig => ({
  maxBatchRows: boundedInteger(
    env,
    "MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_ROWS",
    100,
    1,
    500
  ),
  maxBatchBytes: boundedInteger(
    env,
    "MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_BYTES",
    1_000_000,
    1_024,
    3_800_000
  ),
  maxBatchRuntimeMs: boundedInteger(
    env,
    "MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_RUNTIME_MS",
    15_000,
    100,
    60_000
  ),
  maxJournalBytesPerBatch: boundedInteger(
    env,
    "MEMORY_HISTORICAL_IMPORT_JOURNAL_BATCH_BYTES",
    1_048_576,
    1_024,
    4_194_304
  )
});

const objectValue = <T>(
  response: Record<string, unknown>,
  key: string,
  errorCode: string
): T => {
  const value = response[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value as T;
};

const lookupSource = async (
  client: MemoryApiClient,
  artifactId: string
): Promise<HistoricalSource | null> => {
  try {
    return objectValue<HistoricalSource>(
      await client.lookupHistoricalImportSource(artifactId),
      "source",
      "historical_source_response_missing"
    );
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
};

const policyAdmits = async (
  client: MemoryApiClient,
  selection: HistoricalCandidateSelection
): Promise<boolean> => {
  const response = await client.effectiveCapturePolicy({
    ...(typeof selection.adapterState?.projectId === "string"
      ? { projectId: selection.adapterState.projectId }
      : {}),
    threadId: selection.candidateId
  });
  const policy = objectValue<Record<string, unknown>>(
    response,
    "policy",
    "historical_policy_response_missing"
  );
  return (
    policy.visibility === "personal" &&
    policy.captureState === "enabled" &&
    policy.paused !== true
  );
};

const rawAdmission = async (
  client: MemoryApiClient
): Promise<HistoricalAdmissionDecision> => {
  const response = await client.historicalImportAdmission();
  if (response.admitted === true) return { admitted: true };
  const reasons = new Set([
    "no_historical_backlog",
    "api_degraded",
    "queue_degraded",
    "embedding_service_degraded",
    "capacity_profile_unavailable",
    "live_projection_pressure",
    "concurrency_cap"
  ]);
  if (
    response.admitted === false &&
    typeof response.reason === "string" &&
    reasons.has(response.reason)
  ) {
    return response as HistoricalAdmissionDecision;
  }
  throw new Error("historical_admission_response_invalid");
};

const transitionRunToImporting = async (
  client: MemoryApiClient,
  runId: string
): Promise<void> => {
  for (const [expectedState, state] of [
    ["discovered", "eligible"],
    ["eligible", "queued"],
    ["queued", "importing"]
  ] as const) {
    await client.transitionHistoricalImportRun(runId, { expectedState, state });
  }
};

const transitionSourceOneStep = async (
  client: MemoryApiClient,
  source: HistoricalSource
): Promise<HistoricalSource> => {
  const next =
    source.state === "discovered"
      ? "eligible"
      : source.state === "eligible"
        ? "queued"
        : source.state === "queued"
          ? "importing"
          : null;
  if (!next) return source;
  return objectValue<HistoricalSource>(
    await client.transitionHistoricalImportSource(source.id, {
      expectedState: source.state,
      state: next
    }),
    "source",
    "historical_source_transition_response_missing"
  );
};

const historicalItem = (item: RawConversationItemRequest) => ({
  observationOnly: item.observationOnly,
  sessionId: item.sessionId,
  turnId: item.turnId,
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
  logicalSourceId: item.logicalSourceId,
  transportChunkIndex: item.transportChunkIndex,
  transportChunkCount: item.transportChunkCount,
  transportChunkText: item.transportChunkText,
  transportChunkEncoding: item.transportChunkEncoding,
  sourceHash: item.sourceHash,
  idempotencyKey: item.idempotencyKey,
  canonicalItemKey: item.canonicalItemKey,
  canonicalStableItemId: item.canonicalStableItemId,
  canonicalSourcePriority: item.canonicalSourcePriority,
  observationKind: item.observationKind,
  observationComponent: item.observationComponent,
  projectionStatus: item.projectionStatus,
  projectionVersion: "codex-transcript-v1" as const,
  metadata: {
    ...(item.metadata ?? {}),
    transcriptItemDiscriminator:
      typeof item.metadata?.transcriptItemDiscriminator === "string" &&
      item.metadata.transcriptItemDiscriminator.trim()
        ? item.metadata.transcriptItemDiscriminator
        : (item.canonicalStableItemId ??
          item.externalItemId ??
          `source:${item.sourceLineNumber ?? item.sourceSequence ?? 0}`)
  }
});

const parserState = (
  checkpoint: ReturnType<typeof parseTranscriptJournalBytes>["checkpoint"]
): TranscriptJournalParserState => ({
  ...(checkpoint.lastEventTime
    ? { lastEventTime: checkpoint.lastEventTime }
    : {}),
  ...(checkpoint.activeTurnId ? { activeTurnId: checkpoint.activeTurnId } : {}),
  ...(checkpoint.assistantMessagePreference
    ? { assistantMessagePreference: checkpoint.assistantMessagePreference }
    : {})
});

const verifiedSegmentBytes = async (
  client: MemoryApiClient,
  artifactId: string,
  segment: SourceSegment
): Promise<Buffer> => {
  const response = await client.getConversationSourceSegmentContent(
    artifactId,
    segment.id
  );
  if (typeof response.bytesBase64 !== "string") {
    throw new Error("historical_segment_content_missing");
  }
  const bytes = Buffer.from(response.bytesBase64, "base64");
  if (bytes.byteLength !== segment.plaintextSize) {
    throw new Error("historical_segment_size_mismatch");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== segment.plaintextDigest) {
    throw new Error("historical_segment_digest_mismatch");
  }
  return bytes;
};

const nextLineBoundary = (bytes: Buffer, maximum: number): number => {
  const target = Math.min(bytes.byteLength, maximum);
  if (target === bytes.byteLength) return target;
  const before = bytes.lastIndexOf(0x0a, target - 1);
  if (before >= 0) return before + 1;
  const after = bytes.indexOf(0x0a, target);
  if (after < 0) throw new Error("historical_record_exceeds_batch_limit");
  return after + 1;
};

const historicalItemsFor = (
  input: Parameters<typeof buildCodexHistoricalBatch>[0],
  records: unknown[],
  lineIndexOffset: number
): ReturnType<typeof historicalItem>[] =>
  buildCodexTranscriptConversationItems({
    records,
    indexOffset: lineIndexOffset,
    sessionId: input.source.sessionId,
    sourceSessionId: input.source.sourceSessionId,
    sourceTransport: "historical_import",
    sourceFingerprint: input.source.sourceFingerprint,
    threadKind:
      input.selection.adapterState?.threadKind === "subagent"
        ? "subagent"
        : "conversation",
    ...(typeof input.selection.adapterState?.parentThreadId === "string"
      ? { parentThreadId: input.selection.adapterState.parentThreadId }
      : {})
  }).map(historicalItem);

const isMalformedRecordError = (error: unknown): boolean =>
  error instanceof Error &&
  /malformed complete JSONL record/.test(error.message);

export const buildCodexHistoricalBatch = (input: {
  bytes: Buffer;
  absoluteStartOffset: number;
  lineIndexOffset: number;
  prior: TranscriptJournalParserState;
  source: HistoricalSource;
  selection: HistoricalCandidateSelection;
  config: CodexHistoricalIngestionConfig;
  now?: () => number;
}) => {
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  let localOffset = 0;
  let line = input.lineIndexOffset;
  let state = input.prior;
  let malformedRecordCount = 0;
  let items: ReturnType<typeof historicalItem>[] = [];
  recordLoop: while (localOffset < input.bytes.byteLength) {
    // A trailing event_msg/agent_message with no stable response_item yet
    // must not become its own item: a later page could still supply the
    // response_item that supersedes it, and the two have different source
    // identities, so committing both would duplicate the same assistant
    // turn. Grow this record's page one record at a time -- re-parsing with
    // deferPageEndingAssistantEvent each time -- until the parser actually
    // advances past localOffset (nothing was deferred, or a later record
    // resolved it), we run out of available records (leave the deferred
    // tail for the next batch, exactly like the live watcher), or growth
    // hits the batch caps (force a non-deferred resolve so a source can
    // never stall on this the way an oversized single record used to).
    let pageEnd = localOffset;
    let lastGoodPageEnd = localOffset;
    let recordsInPage = 0;
    for (;;) {
      const newline = input.bytes.indexOf(0x0a, pageEnd);
      if (newline < 0) {
        if (pageEnd === localOffset) {
          throw new Error("historical_segment_record_incomplete");
        }
        break recordLoop;
      }
      pageEnd = newline + 1;
      recordsInPage += 1;
      const pageBytes = input.bytes.subarray(localOffset, pageEnd);
      const atGrowthCap =
        pageBytes.byteLength >= input.config.maxBatchBytes ||
        recordsInPage >= input.config.maxBatchRows;
      let parsed: ReturnType<typeof parseTranscriptJournalBytes>;
      try {
        parsed = parseTranscriptJournalBytes({
          bytes: pageBytes,
          absoluteStartOffset: input.absoluteStartOffset + localOffset,
          lineIndexOffset: line,
          prior: state,
          deferPageEndingAssistantEvent: !atGrowthCap
        });
      } catch (error) {
        if (!isMalformedRecordError(error)) throw error;
        // strictJsonLines throws on the first malformed line it reaches, in
        // file order, so a page that only just started failing must be
        // failing on the record most recently added to it: everything
        // through lastGoodPageEnd already parsed cleanly on an earlier
        // growth attempt (or there was no growth yet). Re-resolve that
        // known-good prefix without deferral risk, commit it, then treat
        // the newly-added record as the isolated malformed one, exactly as
        // a single-record page would have.
        if (lastGoodPageEnd > localOffset) {
          const goodParsed = parseTranscriptJournalBytes({
            bytes: input.bytes.subarray(localOffset, lastGoodPageEnd),
            absoluteStartOffset: input.absoluteStartOffset + localOffset,
            lineIndexOffset: line,
            prior: state
          });
          const goodItems = historicalItemsFor(input, goodParsed.records, line);
          items = [...items, ...goodItems];
          state = parserState(goodParsed.checkpoint);
          line = goodParsed.checkpoint.lineCount;
        }
        malformedRecordCount += 1;
        localOffset = pageEnd;
        line += 1;
        continue recordLoop;
      }
      const resolvedThroughOffset = parsed.checkpoint.offset;
      const pageAbsoluteEnd = input.absoluteStartOffset + pageEnd;
      if (resolvedThroughOffset < pageAbsoluteEnd && !atGrowthCap) {
        // Still deferred: nothing new to commit yet. Keep growing the page.
        lastGoodPageEnd = pageEnd;
        continue;
      }
      const nextItems = historicalItemsFor(input, parsed.records, line);
      const combined = [...items, ...nextItems];
      if (
        combined.length > input.config.maxBatchRows ||
        Buffer.byteLength(JSON.stringify(combined), "utf8") >
          input.config.maxBatchBytes
      ) {
        if (localOffset === 0) {
          throw new Error("historical_record_exceeds_batch_limit");
        }
        break recordLoop;
      }
      items = combined;
      state = parserState(parsed.checkpoint);
      line = parsed.checkpoint.lineCount;
      localOffset = resolvedThroughOffset - input.absoluteStartOffset;
      break;
    }
    if (now() - startedAt >= input.config.maxBatchRuntimeMs) break;
  }
  return {
    bytesConsumed: localOffset,
    sourceLine: line,
    parserState: state,
    malformedRecordCount,
    items
  };
};

const importNextBatch = async (input: {
  client: MemoryApiClient;
  source: HistoricalSource;
  selection: HistoricalCandidateSelection;
  config: CodexHistoricalIngestionConfig;
}): Promise<boolean> => {
  const frontier = input.source.registrationFrontierOffset;
  if (input.source.historicalCursorOffset >= frontier) return false;
  const response = await input.client.listConversationSourceSegments(
    input.source.artifactId,
    { afterOffset: input.source.historicalCursorOffset, limit: 1 }
  );
  const segment = Array.isArray(response.segments)
    ? (response.segments as SourceSegment[])[0]
    : undefined;
  if (
    !segment ||
    segment.sourceStartOffset > input.source.historicalCursorOffset ||
    segment.sourceEndOffset <= input.source.historicalCursorOffset
  ) {
    throw new Error("historical_journal_segment_missing");
  }
  const segmentBytes = await verifiedSegmentBytes(
    input.client,
    input.source.artifactId,
    segment
  );
  const start = input.source.historicalCursorOffset - segment.sourceStartOffset;
  const end = Math.min(
    segmentBytes.byteLength,
    frontier - segment.sourceStartOffset
  );
  const available = segmentBytes.subarray(start, end);
  const bounded = available.subarray(
    0,
    nextLineBoundary(available, input.config.maxBatchBytes)
  );
  const batch = buildCodexHistoricalBatch({
    bytes: bounded,
    absoluteStartOffset: input.source.historicalCursorOffset,
    lineIndexOffset: input.source.historicalCursorLine,
    prior: (input.source.historicalCursorParserState ??
      {}) as TranscriptJournalParserState,
    source: input.source,
    selection: input.selection,
    config: input.config
  });
  if (batch.bytesConsumed === 0) {
    throw new Error("historical_batch_made_no_progress");
  }
  const eventTimes = batch.items
    .map((item) => item.eventTime)
    .filter((value): value is string => typeof value === "string")
    .sort();
  await input.client.ingestHistoricalImportBatch(input.source.id, {
    expectedSourceOffset: input.source.historicalCursorOffset,
    sourceOffset: input.source.historicalCursorOffset + batch.bytesConsumed,
    sourceLine: batch.sourceLine,
    segmentIndex: segment.segmentIndex,
    lastVerifiedDigest: segment.plaintextDigest,
    parserState: batch.parserState,
    malformedRecordCount: batch.malformedRecordCount,
    ...(eventTimes[0]
      ? {
          sourceEventFrom: eventTimes[0],
          sourceEventTo: eventTimes.at(-1)
        }
      : {}),
    items: batch.items
  });
  return true;
};

const createRun = async (client: MemoryApiClient): Promise<string> => {
  const run = objectValue<{ id: string }>(
    await client.createHistoricalImportRun(),
    "run",
    "historical_run_response_missing"
  );
  await transitionRunToImporting(client, run.id);
  return run.id;
};

// A single complete JSONL record that itself exceeds maxBatchRows/
// maxBatchBytes can never fit a batch, no matter how many times it is
// retried: buildCodexHistoricalBatch only throws this on the batch's first
// (localOffset === 0) record, so there is no smaller unit to fall back to.
// Left uncaught, the coordinator retries the same oldest chronological
// selection forever and its "exhaust the oldest range first" ordering blocks
// every newer selection from ever running. Skip the source instead so the
// cohort keeps moving; the historical_import_state machine requires passing
// through "failed" (with a failure reason) before "skipped" is reachable.
const isUnrepresentableRecordError = (error: unknown): boolean =>
  error instanceof Error &&
  error.message === "historical_record_exceeds_batch_limit";

const skipUnrepresentableSource = async (
  client: MemoryApiClient,
  source: HistoricalSource
): Promise<void> => {
  try {
    await client.transitionHistoricalImportSource(source.id, {
      expectedState: "importing",
      state: "failed",
      failureReason: "historical_record_exceeds_batch_limit"
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

const tryComplete = async (
  client: MemoryApiClient,
  source: HistoricalSource
): Promise<boolean> => {
  try {
    await client.transitionHistoricalImportSource(source.id, {
      expectedState: "importing",
      state: "completed"
    });
    return true;
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 409) return false;
    throw error;
  }
};

export const createCodexHistoricalProviderAdapter = (input: {
  client: MemoryApiClient;
  config?: CodexHistoricalIngestionConfig;
}): HistoricalProviderAdapter<CodexHistoricalCandidate> => {
  const config = input.config ?? resolveCodexHistoricalIngestionConfig();
  return {
    aiClient: "codex",
    candidateId: (candidate) => candidate.sourceSessionId,
    selectCandidates(candidates, now) {
      const cutoff =
        now.getTime() - AUTOMATIC_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
      const byConversation = new Map<string, CodexHistoricalCandidate>();
      for (const candidate of candidates) {
        const activity = Date.parse(candidate.latestActivityAt);
        if (
          !Number.isFinite(activity) ||
          activity < cutoff ||
          activity > now.getTime()
        ) {
          continue;
        }
        const existing = byConversation.get(candidate.sourceSessionId);
        if (
          !existing ||
          candidate.latestActivityAt > existing.latestActivityAt ||
          (candidate.latestActivityAt === existing.latestActivityAt &&
            candidate.transcriptPath < existing.transcriptPath)
        ) {
          byConversation.set(candidate.sourceSessionId, candidate);
        }
      }
      return [...byConversation.values()]
        .sort(
          (left, right) =>
            right.latestActivityAt.localeCompare(left.latestActivityAt) ||
            left.sourceSessionId.localeCompare(right.sourceSessionId)
        )
        .slice(0, AUTOMATIC_CONVERSATION_CAP)
        .sort(
          (left, right) =>
            left.latestActivityAt.localeCompare(right.latestActivityAt) ||
            left.sourceSessionId.localeCompare(right.sourceSessionId)
        )
        .map((candidate) => ({
          aiClient: "codex",
          candidateId: candidate.sourceSessionId,
          frontierOffset: candidate.frontierOffset,
          frontierLine: candidate.frontierLine ?? -1,
          latestActivityAt: candidate.latestActivityAt,
          adapterState: {
            threadKind: candidate.context.threadKind,
            ...(candidate.context.parentThreadId
              ? { parentThreadId: candidate.context.parentThreadId }
              : {}),
            ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
            projectName: candidate.projectName,
            ...(candidate.projectFingerprint
              ? { projectFingerprint: candidate.projectFingerprint }
              : {})
          }
        }));
    },
    async processNextBatch({ candidate, selection, runId }) {
      let currentSelection = selection;
      if (currentSelection.frontierLine < 0) {
        if (!candidate) {
          return { state: "waiting", selection, ...(runId ? { runId } : {}) };
        }
        currentSelection = {
          ...currentSelection,
          frontierLine: await countTranscriptLines(
            candidate.transcriptPath,
            currentSelection.frontierOffset
          )
        };
      }
      let artifact: ConversationSourceArtifact | undefined;
      if (!currentSelection.artifactId || candidate) {
        if (!candidate) {
          return { state: "waiting", selection, ...(runId ? { runId } : {}) };
        }
        const registered = await ingestCodexTranscriptJournal({
          client: input.client,
          sourceSession: candidate.sourceSession,
          sourceSessionId: candidate.sourceSessionId,
          transcriptPath: candidate.transcriptPath,
          context: candidate.context,
          maxBytesPerBatch: config.maxJournalBytesPerBatch,
          journalStartOffset: 0,
          journalStartLine: 0,
          liveStartOffset: currentSelection.frontierOffset,
          liveStartLine: currentSelection.frontierLine
        });
        artifact = registered.artifact;
        currentSelection = { ...currentSelection, artifactId: artifact.id };
        if (artifact.providerCursorOffset < currentSelection.frontierOffset) {
          return {
            state: "progress",
            selection: currentSelection,
            ...(runId ? { runId } : {})
          };
        }
      }
      const artifactId = currentSelection.artifactId;
      if (!artifactId) {
        return { state: "waiting", selection: currentSelection };
      }
      const source = await lookupSource(input.client, artifactId);
      let activeRunId = source?.runId ?? runId;
      if (!source) {
        if (!activeRunId) activeRunId = await createRun(input.client);
        objectValue<HistoricalSource>(
          await input.client.createHistoricalImportSource({
            runId: activeRunId,
            artifactId,
            aiClient: "codex",
            detectedProject: {
              ...(typeof currentSelection.adapterState?.projectId === "string"
                ? { projectId: currentSelection.adapterState.projectId }
                : {}),
              name:
                typeof currentSelection.adapterState?.projectName === "string"
                  ? currentSelection.adapterState.projectName
                  : "Unassigned",
              ...(typeof currentSelection.adapterState?.projectFingerprint ===
              "string"
                ? {
                    fingerprint:
                      currentSelection.adapterState.projectFingerprint
                  }
                : {})
            }
          }),
          "source",
          "historical_source_response_missing"
        );
        return {
          state: "progress",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      activeRunId = source.runId;
      if (source.state === "completed") {
        return {
          state: "completed",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      if (source.state === "skipped") {
        return {
          state: "skipped",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      if (["paused", "failed"].includes(source.state)) {
        return {
          state: "waiting",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      if (!(await policyAdmits(input.client, currentSelection))) {
        return {
          state: "waiting",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      const admission = await rawAdmission(input.client);
      if (!admission.admitted) {
        return {
          state: "waiting",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      if (["discovered", "eligible", "queued"].includes(source.state)) {
        await transitionSourceOneStep(input.client, source);
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
      let progressed: boolean;
      try {
        progressed = await importNextBatch({
          client: input.client,
          source,
          selection: currentSelection,
          config
        });
      } catch (error) {
        if (!isUnrepresentableRecordError(error)) throw error;
        await skipUnrepresentableSource(input.client, source);
        return {
          state: "skipped",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      if (progressed) {
        return {
          state: "progress",
          selection: currentSelection,
          runId: activeRunId
        };
      }
      const completed = await tryComplete(input.client, source);
      return {
        state: completed ? "completed" : "source_exhausted",
        selection: currentSelection,
        runId: activeRunId
      };
    },
    async completeRun(runId) {
      try {
        await input.client.transitionHistoricalImportRun(runId, {
          expectedState: "importing",
          state: "completed"
        });
      } catch (error) {
        // Every selected source was just observed as completed or skipped. A
        // conflict therefore means a previous attempt already completed the
        // run, which is safe after a Local AI Runtime restart.
        if (!(error instanceof MemoryApiError) || error.status !== 409) {
          throw error;
        }
      }
    }
  };
};
