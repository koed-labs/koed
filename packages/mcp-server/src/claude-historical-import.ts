import type { RawConversationItemRequest } from "./conversation-source-types.js";
import {
  discoverAllClaudeHistoricalTranscriptSignals,
  discoverClaudeHistoricalTranscriptSignals,
  registerClaudeHistoricalTranscriptSources
} from "./claude-transcript-watcher.js";
import {
  completeTranscriptBoundary,
  countTranscriptLines
} from "./codex-transcript-journal.js";
import {
  discoverClaudeHistoricalComponentCandidates,
  lookupClaudeArtifact,
  type ClaudeHistoricalComponentCandidate,
  type ClaudeHistoricalComponentFrontier
} from "./claude-transcript-source.js";
import {
  parseClaudeTranscriptJournalBytes,
  type ClaudeTranscriptParserState
} from "./claude-transcript-parser.js";
import { MemoryApiClient, MemoryApiError } from "./index.js";
import {
  automaticHistoricalAdmission,
  automaticHistoricalPolicyAdmits,
  completeAutomaticHistoricalRun,
  resolveAutomaticHistoricalJournalBatchBytes,
  selectRecentHistoricalCandidates
} from "./automatic-historical-provider.js";
import type {
  HistoricalCandidateSelection,
  HistoricalProviderAdapter
} from "./historical-ingestion-coordinator.js";

export interface ClaudeHistoricalCandidate {
  sourceSessionId: string;
  transcriptPath: string;
  cwd: string;
  latestActivityAt: string;
  frontierOffset: number;
  frontierLine?: number;
  components?: ClaudeHistoricalComponentCandidate[];
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
  historicalCursorCurrentTurnId?: string;
  registrationFrontierOffset: number;
  state: string;
};

type SourceSegment = {
  id: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  plaintextDigest: string;
};

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
  projectionVersion: "claude-code-transcript-v1" as const,
  metadata: item.metadata ?? {}
});

const completeChunks = (input: {
  bytes: Buffer;
  absoluteStart: number;
  absoluteEnd: number;
  maximumBytes?: number;
}): Array<{ bytes: Buffer; start: number; end: number }> => {
  const chunks: Array<{ bytes: Buffer; start: number; end: number }> = [];
  const maximumBytes = input.maximumBytes ?? 512 * 1024;
  let localStart = 0;
  while (input.absoluteStart + localStart < input.absoluteEnd) {
    const remaining = input.absoluteEnd - input.absoluteStart - localStart;
    let localEnd = localStart + Math.min(remaining, maximumBytes);
    if (localEnd < input.bytes.length) {
      const newline = input.bytes.lastIndexOf(0x0a, localEnd - 1);
      if (newline >= localStart) {
        localEnd = newline + 1;
      } else {
        const next = input.bytes.indexOf(0x0a, localEnd);
        if (next < 0 || next + 1 - localStart > 3_500_000) {
          throw new Error("claude_historical_record_exceeds_batch_limit");
        }
        localEnd = next + 1;
      }
    }
    chunks.push({
      bytes: input.bytes.subarray(localStart, localEnd),
      start: input.absoluteStart + localStart,
      end: input.absoluteStart + localEnd
    });
    localStart = localEnd;
  }
  return chunks;
};

export const importClaudeHistoricalSource = async (input: {
  client: MemoryApiClient;
  source: HistoricalSource;
  sourceComponentId?: string;
  maxBatches?: number;
}): Promise<{
  sourceId: string;
  batchCount: number;
  itemCount: number;
  exhausted: boolean;
}> => {
  let offset = input.source.historicalCursorOffset;
  let line = input.source.historicalCursorLine;
  // Preserve PR #342's current-turn recovery while accepting the shared,
  // bounded parser-state contract used by automatic provider adapters.
  let parserState: ClaudeTranscriptParserState | undefined = input.source
    .historicalCursorParserState
    ? (input.source.historicalCursorParserState as ClaudeTranscriptParserState)
    : input.source.historicalCursorCurrentTurnId
      ? { currentTurnId: input.source.historicalCursorCurrentTurnId }
      : undefined;
  let batchCount = 0;
  let itemCount = 0;
  const maxBatches = input.maxBatches ?? Number.POSITIVE_INFINITY;
  segmentLoop: while (offset < input.source.registrationFrontierOffset) {
    const page = await input.client.listConversationSourceSegments(
      input.source.artifactId,
      { afterOffset: offset, limit: 20 }
    );
    const segments = Array.isArray(page.segments)
      ? (page.segments as SourceSegment[])
      : [];
    if (segments.length === 0) {
      throw new Error("claude_historical_journal_segment_missing");
    }
    for (const segment of segments) {
      if (offset >= input.source.registrationFrontierOffset) break;
      if (
        segment.sourceEndOffset <= offset ||
        segment.sourceStartOffset > offset
      ) {
        continue;
      }
      const content = await input.client.getConversationSourceSegmentContent(
        input.source.artifactId,
        segment.id
      );
      if (typeof content.bytesBase64 !== "string") {
        throw new Error("claude_historical_segment_content_missing");
      }
      const segmentBytes = Buffer.from(content.bytesBase64, "base64");
      const absoluteEnd = Math.min(
        segment.sourceEndOffset,
        input.source.registrationFrontierOffset
      );
      const usable = segmentBytes.subarray(
        offset - segment.sourceStartOffset,
        absoluteEnd - segment.sourceStartOffset
      );
      for (const chunk of completeChunks({
        bytes: usable,
        absoluteStart: offset,
        absoluteEnd
      })) {
        const parsed = parseClaudeTranscriptJournalBytes({
          bytes: chunk.bytes,
          absoluteStartOffset: chunk.start,
          lineIndexOffset: line,
          sessionId: input.source.sessionId,
          externalSessionId: input.source.sourceSessionId,
          sourceFingerprint: input.source.sourceFingerprint,
          sourceComponentId: input.sourceComponentId,
          prior: parserState,
          sourceTransport: "historical_import"
        });
        const items = parsed.items.map(historicalItem);
        if (Buffer.byteLength(JSON.stringify(items), "utf8") > 3_800_000) {
          throw new Error("claude_historical_batch_payload_too_large");
        }
        await input.client.ingestHistoricalImportBatch(input.source.id, {
          expectedSourceOffset: chunk.start,
          sourceOffset: chunk.end,
          sourceLine: parsed.checkpoint.lineCount,
          segmentIndex: segment.segmentIndex,
          lastVerifiedDigest: segment.plaintextDigest,
          parserState: parsed.parserState,
          items
        });
        offset = chunk.end;
        line = parsed.checkpoint.lineCount;
        parserState = parsed.parserState;
        batchCount += 1;
        itemCount += items.length;
        if (batchCount >= maxBatches) break segmentLoop;
      }
    }
  }
  return {
    sourceId: input.source.id,
    batchCount,
    itemCount,
    exhausted: offset >= input.source.registrationFrontierOffset
  };
};

const transition = async (
  client: MemoryApiClient,
  kind: "run" | "source",
  id: string,
  expectedState: string,
  state: string
) =>
  kind === "run"
    ? client.transitionHistoricalImportRun(id, { expectedState, state })
    : client.transitionHistoricalImportSource(id, { expectedState, state });

const lookupHistoricalSource = async (
  client: MemoryApiClient,
  artifactId: string
): Promise<HistoricalSource | null> => {
  try {
    return objectValue<HistoricalSource>(
      await client.lookupHistoricalImportSource(artifactId),
      "source",
      "claude_historical_source_missing"
    );
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
};

const moveNewSourceToImporting = async (
  client: MemoryApiClient,
  source: HistoricalSource
): Promise<HistoricalSource> => {
  let current = source;
  for (const [expectedState, state] of [
    ["discovered", "eligible"],
    ["eligible", "queued"],
    ["queued", "importing"]
  ] as const) {
    if (current.state !== expectedState) continue;
    current = objectValue<HistoricalSource>(
      await transition(client, "source", current.id, expectedState, state),
      "source",
      "claude_historical_source_transition_missing"
    );
  }
  return current;
};

export const importSelectedClaudeHistory = async (input: {
  client: MemoryApiClient;
  sourceSessionIds: readonly string[];
  runId?: string;
  env?: NodeJS.ProcessEnv;
  maxBatches?: number;
  componentFrontiersBySession?: Readonly<
    Record<string, readonly ClaudeHistoricalComponentFrontier[]>
  >;
  maxJournalBytesPerPass?: number;
}): Promise<Record<string, unknown>> => {
  const env = input.env ?? process.env;
  const signals = await discoverClaudeHistoricalTranscriptSignals(
    input.sourceSessionIds,
    env
  );
  let newRun: { id: string } | undefined = input.runId
    ? { id: input.runId }
    : undefined;
  const runIds = new Set<string>();
  const ensureNewRun = async (): Promise<{ id: string }> => {
    if (newRun) return newRun;
    newRun = objectValue<{ id: string }>(
      await input.client.createHistoricalImportRun(),
      "run",
      "claude_historical_run_missing"
    );
    await transition(input.client, "run", newRun.id, "discovered", "eligible");
    await transition(input.client, "run", newRun.id, "eligible", "queued");
    await transition(input.client, "run", newRun.id, "queued", "importing");
    runIds.add(newRun.id);
    return newRun;
  };
  const results: Array<Record<string, unknown>> = [];
  let remainingBatches = input.maxBatches ?? Number.POSITIVE_INFINITY;
  let completed = true;
  signalLoop: for (const [signalIndex, signal] of signals.entries()) {
    const artifacts = await registerClaudeHistoricalTranscriptSources(
      input.client,
      signal,
      env,
      {
        ...(input.componentFrontiersBySession?.[signal.sourceSessionId]
          ? {
              components:
                input.componentFrontiersBySession[signal.sourceSessionId]
            }
          : {}),
        ...(input.maxJournalBytesPerPass !== undefined
          ? { maxBytesPerPass: input.maxJournalBytesPerPass }
          : {})
      }
    );
    if (
      artifacts.some(
        (artifact) =>
          typeof artifact.providerCursorOffset === "number" &&
          typeof artifact.registrationFrontierOffset === "number" &&
          artifact.providerCursorOffset < artifact.registrationFrontierOffset
      )
    ) {
      completed = false;
      break signalLoop;
    }
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      let source = await lookupHistoricalSource(input.client, artifact.id);
      const resumed = source !== null;
      if (!source) {
        const run = await ensureNewRun();
        source = objectValue<HistoricalSource>(
          await input.client.createHistoricalImportSource({
            runId: run.id,
            artifactId: artifact.id,
            aiClient: "claude",
            detectedProject: {
              path: signal.cwd,
              cwd: signal.cwd
            }
          }),
          "source",
          "claude_historical_source_missing"
        );
        source = await moveNewSourceToImporting(input.client, source);
      }
      runIds.add(source.runId);
      if (source.state === "completed") {
        results.push({
          sourceComponentId: artifact.sourceComponentId,
          sourceId: source.id,
          resumed: true,
          completed: true,
          batchCount: 0,
          itemCount: 0
        });
        continue;
      }
      if (source.state !== "importing") {
        throw new Error(
          `claude_historical_source_requires_explicit_resume:${source.state}`
        );
      }
      const imported = await importClaudeHistoricalSource({
        client: input.client,
        source,
        sourceComponentId: artifact.sourceComponentId,
        maxBatches: remainingBatches
      });
      remainingBatches -= imported.batchCount;
      results.push({
        sourceComponentId: artifact.sourceComponentId,
        resumed,
        ...imported
      });
      if (!imported.exhausted) {
        completed = false;
        break signalLoop;
      }
      try {
        await transition(
          input.client,
          "source",
          source.id,
          "importing",
          "completed"
        );
      } catch (error) {
        if (!(error instanceof MemoryApiError) || error.status !== 409) {
          throw error;
        }
      }
      if (remainingBatches <= 0) {
        const hasMoreSources =
          artifactIndex < artifacts.length - 1 ||
          signalIndex < signals.length - 1;
        if (hasMoreSources) {
          completed = false;
          break signalLoop;
        }
      }
    }
  }
  return {
    runId: newRun?.id ?? [...runIds][0] ?? null,
    runIds: [...runIds],
    sources: results,
    completed
  };
};

export const discoverClaudeHistoricalCandidates = async (
  env: NodeJS.ProcessEnv = process.env,
  candidateIds?: readonly string[]
): Promise<ClaudeHistoricalCandidate[]> => {
  const signals = candidateIds
    ? await discoverClaudeHistoricalTranscriptSignals(candidateIds, env)
    : await discoverAllClaudeHistoricalTranscriptSignals(env);
  const preliminary = signals.map((signal) => ({
    sourceSessionId: signal.sourceSessionId,
    transcriptPath: signal.transcriptPath,
    cwd: signal.cwd,
    latestActivityAt: signal.observedAt ?? new Date(0).toISOString(),
    frontierOffset: completeTranscriptBoundary(signal.transcriptPath)
  }));
  const selectedIds = candidateIds
    ? new Set(candidateIds)
    : new Set(
        selectRecentHistoricalCandidates({
          aiClient: "claude",
          candidates: preliminary,
          now: new Date(),
          adapterState: () => ({})
        }).map((selection) => selection.candidateId)
      );
  return Promise.all(
    preliminary
      .filter((candidate) => selectedIds.has(candidate.sourceSessionId))
      .map(async (candidate) => {
        const components = await discoverClaudeHistoricalComponentCandidates(
          candidate,
          env
        );
        const main = components.find(
          (component) => component.componentId === "main"
        );
        if (!main) throw new Error("claude_source_main_component_missing");
        return {
          ...candidate,
          frontierOffset: main.frontierOffset,
          frontierLine: main.frontierLine,
          components
        };
      })
  );
};

const componentFrontiersFromSelection = async (
  client: MemoryApiClient,
  selection: HistoricalCandidateSelection,
  candidate: ClaudeHistoricalCandidate
): Promise<ClaudeHistoricalComponentFrontier[]> => {
  const value = selection.adapterState?.componentFrontiers;
  let components: ClaudeHistoricalComponentFrontier[] | undefined;
  if (Array.isArray(value)) {
    const storedComponents = value.filter(
      (entry): entry is ClaudeHistoricalComponentFrontier => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return false;
        }
        const component = entry as Record<string, unknown>;
        return (
          typeof component.componentId === "string" &&
          (component.componentRole === "primary" ||
            component.componentRole === "auxiliary") &&
          (component.parentComponentId === null ||
            typeof component.parentComponentId === "string") &&
          Number.isSafeInteger(component.frontierOffset) &&
          Number(component.frontierOffset) >= 0 &&
          Number.isSafeInteger(component.frontierLine) &&
          Number(component.frontierLine) >= -1
        );
      }
    );
    if (
      storedComponents.length === value.length &&
      storedComponents.length > 0
    ) {
      components = storedComponents;
    }
  }
  const artifacts = new Map<
    string,
    Awaited<ReturnType<typeof lookupClaudeArtifact>>
  >();
  const artifactFor = async (componentId: string) => {
    if (!artifacts.has(componentId)) {
      artifacts.set(
        componentId,
        await lookupClaudeArtifact(
          client,
          candidate.sourceSessionId,
          componentId
        )
      );
    }
    return artifacts.get(componentId) ?? null;
  };
  if (!components) {
    components = [
      {
        componentId: "main",
        componentRole: "primary",
        parentComponentId: null,
        frontierOffset: selection.frontierOffset,
        frontierLine:
          selection.frontierLine >= 0
            ? selection.frontierLine
            : await countTranscriptLines(
                candidate.transcriptPath,
                selection.frontierOffset
              )
      }
    ];
    for (const component of candidate.components ?? []) {
      if (component.componentId === "main") continue;
      const artifact = await artifactFor(component.componentId);
      if (
        !artifact ||
        typeof artifact.liveStartOffset !== "number" ||
        typeof artifact.liveStartLine !== "number"
      ) {
        continue;
      }
      components.push({
        componentId: component.componentId,
        componentRole: component.componentRole,
        parentComponentId: component.parentComponentId,
        frontierOffset: artifact.liveStartOffset,
        frontierLine: artifact.liveStartLine
      });
    }
  }
  return Promise.all(
    components.map(async (component) => {
      const artifact = await artifactFor(component.componentId);
      if (!artifact || typeof artifact.liveStartOffset !== "number") {
        return component;
      }
      if (
        !Number.isSafeInteger(artifact.liveStartOffset) ||
        artifact.liveStartOffset < 0 ||
        artifact.liveStartOffset > component.frontierOffset
      ) {
        throw new Error("claude_historical_frontier_conflict");
      }
      const transcriptPath =
        component.componentId === "main"
          ? candidate.transcriptPath
          : candidate.components?.find(
              (candidateComponent) =>
                candidateComponent.componentId === component.componentId
            )?.transcriptPath;
      const frontierLine =
        typeof artifact.liveStartLine === "number" &&
        Number.isSafeInteger(artifact.liveStartLine) &&
        artifact.liveStartLine >= 0
          ? artifact.liveStartLine
          : artifact.liveStartOffset === component.frontierOffset &&
              component.frontierLine >= 0
            ? component.frontierLine
            : transcriptPath
              ? await countTranscriptLines(
                  transcriptPath,
                  artifact.liveStartOffset
                )
              : (() => {
                  throw new Error("claude_historical_component_unavailable");
                })();
      return {
        ...component,
        frontierOffset: artifact.liveStartOffset,
        frontierLine
      };
    })
  );
};

export const createClaudeHistoricalProviderAdapter = (input: {
  client: MemoryApiClient;
  env?: NodeJS.ProcessEnv;
}): HistoricalProviderAdapter<ClaudeHistoricalCandidate> => {
  const env = input.env ?? process.env;
  const maxJournalBytesPerPass =
    resolveAutomaticHistoricalJournalBatchBytes(env);
  return {
    aiClient: "claude",
    discoverCandidates: (candidateIds) =>
      discoverClaudeHistoricalCandidates(env, candidateIds),
    candidateId: (candidate) => candidate.sourceSessionId,
    selectCandidates: (candidates, now) =>
      selectRecentHistoricalCandidates({
        aiClient: "claude",
        candidates,
        now,
        adapterState: (candidate) => ({
          projectId: candidate.cwd,
          componentFrontiers: (
            candidate.components ?? [
              {
                componentId: "main",
                componentRole: "primary" as const,
                parentComponentId: null,
                transcriptPath: candidate.transcriptPath,
                frontierOffset: candidate.frontierOffset,
                frontierLine: candidate.frontierLine ?? -1
              }
            ]
          ).map((component) => ({
            componentId: component.componentId,
            componentRole: component.componentRole,
            parentComponentId: component.parentComponentId,
            frontierOffset: component.frontierOffset,
            frontierLine: component.frontierLine
          }))
        })
      }),
    async processNextBatch({ candidate, selection, runId }) {
      if (!candidate) {
        return { state: "waiting", selection, ...(runId ? { runId } : {}) };
      }
      if (
        !(await automaticHistoricalPolicyAdmits(input.client, selection)) ||
        !(await automaticHistoricalAdmission(input.client)).admitted
      ) {
        return { state: "waiting", selection, ...(runId ? { runId } : {}) };
      }
      const componentFrontiers = await componentFrontiersFromSelection(
        input.client,
        selection,
        candidate
      );
      const mainFrontier = componentFrontiers.find(
        (component) => component.componentId === "main"
      );
      const currentSelection = {
        ...selection,
        ...(mainFrontier
          ? {
              frontierOffset: mainFrontier.frontierOffset,
              frontierLine: mainFrontier.frontierLine
            }
          : {}),
        adapterState: {
          ...selection.adapterState,
          componentFrontiers
        }
      };
      const result = await importSelectedClaudeHistory({
        client: input.client,
        sourceSessionIds: [candidate.sourceSessionId],
        ...(runId ? { runId } : {}),
        env,
        maxBatches: 1,
        componentFrontiersBySession: {
          [candidate.sourceSessionId]: componentFrontiers
        },
        maxJournalBytesPerPass
      });
      const activeRunId =
        typeof result.runId === "string" ? result.runId : runId;
      return {
        state: result.completed === true ? "completed" : "progress",
        selection: currentSelection,
        ...(activeRunId ? { runId: activeRunId } : {})
      };
    },
    completeRun: (runId) => completeAutomaticHistoricalRun(input.client, runId)
  };
};
