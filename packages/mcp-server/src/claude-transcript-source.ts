import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  type SessionMessage
} from "@anthropic-ai/claude-agent-sdk";

import { MemoryApiClient, MemoryApiError } from "./index.js";
import {
  completeTranscriptBoundary,
  countTranscriptLines
} from "./codex-transcript-journal.js";
import {
  verifiedTranscriptPath,
  type ClaudeTranscriptIndex
} from "./claude-transcript-discovery.js";
import type { ClaudeTranscriptWatcherSignal } from "./claude-transcript-watcher-signal.js";

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
};

export type SourceArtifact = {
  id: string;
  sessionId: string;
  sourceGenerationId?: string;
  sourceComponentId?: string;
  sourceComponentRole?: "primary" | "auxiliary";
  parentSourceComponentId?: string | null;
  lifecycle?: "active" | "finalized" | "deleted";
  closureHash?: string | null;
  sourceSetFinalizedAt?: string | null;
  priorGenerationClosure?: Record<string, unknown> | null;
  providerCursorOffset: number;
  providerCursorLine: number;
  journalStartOffset: number;
  liveStartOffset?: number;
  liveStartLine?: number;
};

export interface ClaudeHistoricalComponentFrontier {
  componentId: string;
  componentRole: "primary" | "auxiliary";
  parentComponentId: string | null;
  frontierOffset: number;
  frontierLine: number;
}

export interface ClaudeHistoricalComponentCandidate extends ClaudeHistoricalComponentFrontier {
  transcriptPath: string;
}

type SourceSegment = {
  id: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
  plaintextDigest: string;
  plaintextSize: number;
};

const artifactValue = (response: Record<string, unknown>): SourceArtifact => {
  if (!response.artifact || typeof response.artifact !== "object") {
    throw new Error("claude_journal_api_response_missing_artifact");
  }
  return response.artifact as SourceArtifact;
};

const optionalArtifactValue = (
  response: Record<string, unknown>
): SourceArtifact | null => {
  if (!response.artifact || typeof response.artifact !== "object") return null;
  return response.artifact as SourceArtifact;
};

const deterministicUuid = (value: string): string => {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const lookupClaudeArtifact = async (
  client: MemoryApiClient,
  sourceSessionId: string,
  componentId: string
): Promise<SourceArtifact | null> => {
  try {
    return artifactValue(
      await client.lookupConversationSourceArtifact({
        sourceKind: "claude-code",
        externalSessionId: sourceSessionId,
        sourceComponentId: componentId
      })
    );
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
};

const readRange = (sourcePath: string, start: number, end: number): Buffer => {
  const bytes = Buffer.allocUnsafe(end - start);
  const descriptor = openSync(sourcePath, "r");
  try {
    const read = readSync(descriptor, bytes, 0, bytes.length, start);
    if (read !== bytes.length) throw new Error("claude_transcript_short_read");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const completeSegment = (
  sourcePath: string,
  start: number,
  end: number,
  targetBytes = 16 * 1024 * 1024
): Buffer => {
  const maximum = Math.min(end, start + targetBytes);
  const bytes = readRange(sourcePath, start, maximum);
  if (maximum === end) return bytes;
  const newline = bytes.lastIndexOf(0x0a);
  if (newline >= 0) return bytes.subarray(0, newline + 1);
  const expandedEnd = Math.min(end, start + 16 * 1024 * 1024);
  const expanded = readRange(sourcePath, start, expandedEnd);
  const expandedNewline = expanded.indexOf(0x0a);
  if (expandedNewline < 0) {
    throw new Error("claude_transcript_record_too_large");
  }
  return expanded.subarray(0, expandedNewline + 1);
};

export const journalClaudeTranscript = async (input: {
  client: MemoryApiClient;
  signal: ClaudeTranscriptWatcherSignal;
  transcriptPath: string;
  index: ClaudeTranscriptIndex;
  componentId: string;
  componentRole: "primary" | "auxiliary";
  parentComponentId: string | null;
  artifact?: SourceArtifact | null;
  historicalFrontierOffset?: number;
  maxAppendBytes?: number;
}): Promise<SourceArtifact> => {
  const file = await stat(input.transcriptPath);
  const currentBoundary = completeTranscriptBoundary(input.transcriptPath);
  let completeBoundary = input.historicalFrontierOffset ?? currentBoundary;
  if (
    !Number.isSafeInteger(completeBoundary) ||
    completeBoundary < 0 ||
    completeBoundary > currentBoundary
  ) {
    throw new Error("claude_historical_frontier_unavailable");
  }
  let artifact =
    input.artifact === undefined
      ? await lookupClaudeArtifact(
          input.client,
          input.signal.sourceSessionId,
          input.componentId
        )
      : input.artifact;
  if (!artifact) {
    const response = await input.client.ensureConversationSourceArtifact({
      sourceSession: {
        externalSessionId: input.signal.sourceSessionId,
        sourceRuntime: "claude-code",
        captureMethod: "api",
        cwd: input.signal.cwd,
        idempotencyKey: `claude-code-session:${input.signal.sourceSessionId}`,
        sourceHash: hash({
          provider: "claude-code",
          sessionId: input.signal.sourceSessionId
        }),
        metadata: {
          sourceKind: "claude-code",
          sourceAdapterVersion: "claude-code-transcript-v1"
        }
      },
      sourceKind: "claude-code",
      sourceComponentId: input.componentId,
      sourceComponentRole: input.componentRole,
      parentSourceComponentId: input.parentComponentId,
      contentFraming: "jsonl",
      externalSessionId: input.signal.sourceSessionId,
      sourceFingerprint: hash({
        adapter: "claude-code-transcript-v1",
        sessionId: input.signal.sourceSessionId,
        component: input.componentId
      }),
      artifactFormat: "claude_session_jsonl",
      artifactFormatVersion: 1,
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: input.index.activationOffset,
      liveStartLine: input.index.activationLine,
      currentSourceLength: file.size,
      sourceCreatedAt:
        input.index.activationTimestamp ??
        input.signal.observedAt ??
        file.mtime.toISOString(),
      sourceModifiedAt: file.mtime.toISOString(),
      redactedSourceLabel:
        input.componentId === "main"
          ? `${input.signal.sourceSessionId}.jsonl`
          : `${input.signal.sourceSessionId}/${input.componentId}.jsonl`
    });
    artifact = artifactValue(response);
  } else if (artifact.providerCursorOffset > artifact.journalStartOffset) {
    if (file.size < artifact.providerCursorOffset) {
      throw new Error("claude_transcript_truncated");
    }
    const response = await input.client.listConversationSourceSegments(
      artifact.id,
      { afterOffset: artifact.providerCursorOffset - 1, limit: 1 }
    );
    const segment = Array.isArray(response.segments)
      ? (response.segments[0] as SourceSegment | undefined)
      : undefined;
    if (!segment || segment.sourceEndOffset !== artifact.providerCursorOffset) {
      throw new Error("claude_journal_segment_chain_incomplete");
    }
    const currentBytes = readRange(
      input.transcriptPath,
      segment.sourceStartOffset,
      segment.sourceEndOffset
    );
    if (
      currentBytes.length !== segment.plaintextSize ||
      createHash("sha256").update(currentBytes).digest("hex") !==
        segment.plaintextDigest
    ) {
      throw new Error("claude_transcript_append_only_identity_violation");
    }
  }
  if (
    input.historicalFrontierOffset !== undefined &&
    typeof artifact.liveStartOffset === "number" &&
    (!Number.isSafeInteger(artifact.liveStartOffset) ||
      artifact.liveStartOffset < 0 ||
      artifact.liveStartOffset > completeBoundary)
  ) {
    throw new Error("claude_historical_frontier_conflict");
  }
  if (
    input.historicalFrontierOffset !== undefined &&
    typeof artifact.liveStartOffset === "number"
  ) {
    completeBoundary = artifact.liveStartOffset;
  }
  while (artifact.providerCursorOffset < completeBoundary) {
    if (input.maxAppendBytes === 0) break;
    const bytes = completeSegment(
      input.transcriptPath,
      artifact.providerCursorOffset,
      completeBoundary,
      input.maxAppendBytes
    );
    if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
      throw new Error("claude_journal_segment_incomplete");
    }
    const lines = bytes.reduce(
      (count, byte) => count + (byte === 0x0a ? 1 : 0),
      0
    );
    artifact = artifactValue(
      await input.client.appendConversationSourceSegment(artifact.id, {
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
    if (input.maxAppendBytes !== undefined) break;
  }
  return artifact;
};

export const registerClaudeHistoricalTranscriptSources = async (
  client: MemoryApiClient,
  signal: ClaudeTranscriptWatcherSignal,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    components?: readonly ClaudeHistoricalComponentFrontier[];
    maxBytesPerPass?: number;
  } = {}
): Promise<
  Array<
    SourceArtifact & {
      sourceComponentId: string;
      registrationFrontierOffset: number;
    }
  >
> => {
  const discovered = await discoverClaudeHistoricalComponentCandidates(
    signal,
    env,
    options.components
  );
  const components = options.components
    ? options.components.map((frontier) => {
        const component = discovered.find(
          (candidate) => candidate.componentId === frontier.componentId
        );
        if (!component) {
          throw new Error("claude_historical_component_unavailable");
        }
        return { ...component, ...frontier };
      })
    : discovered;
  let appendConsumed = false;
  const registered: Array<
    SourceArtifact & {
      sourceComponentId: string;
      registrationFrontierOffset: number;
    }
  > = [];
  for (const component of components) {
    const frontierLine =
      component.frontierLine >= 0
        ? component.frontierLine
        : await countTranscriptLines(
            component.transcriptPath,
            component.frontierOffset
          );
    const artifactBefore = await lookupClaudeArtifact(
      client,
      signal.sourceSessionId,
      component.componentId
    );
    const artifact = await journalClaudeTranscript({
      client,
      signal,
      transcriptPath: component.transcriptPath,
      index: {
        timestamps: new Map(),
        activationOffset: component.frontierOffset,
        activationLine: frontierLine,
        activationTimestamp: null,
        lineCount: frontierLine
      },
      componentId: component.componentId,
      componentRole: component.componentRole,
      parentComponentId: component.parentComponentId,
      artifact: artifactBefore,
      historicalFrontierOffset: component.frontierOffset,
      ...(options.maxBytesPerPass !== undefined
        ? {
            maxAppendBytes: appendConsumed ? 0 : options.maxBytesPerPass
          }
        : {})
    });
    if (
      artifact.providerCursorOffset >
      (artifactBefore?.providerCursorOffset ?? 0)
    ) {
      appendConsumed = true;
    }
    registered.push({
      ...artifact,
      sourceComponentId: component.componentId,
      registrationFrontierOffset:
        artifact.liveStartOffset ?? component.frontierOffset
    });
  }
  return registered;
};

export interface ClaudeSourceComponent {
  componentId: string;
  role: "primary" | "auxiliary";
  parentComponentId: string | null;
  transcriptPath: string;
  messages: SessionMessage[];
}

interface ClaudeSourceDescriptor {
  componentId: string;
  role: "primary" | "auxiliary";
  parentComponentId: string | null;
  transcriptPath: string;
  agentId?: string;
}

const subagentIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const claudeSourceDescriptors = async (input: {
  signal: ClaudeTranscriptWatcherSignal;
  mainTranscriptPath: string;
}): Promise<ClaudeSourceDescriptor[]> => {
  const components: ClaudeSourceDescriptor[] = [
    {
      componentId: "main",
      role: "primary",
      parentComponentId: null,
      transcriptPath: input.mainTranscriptPath
    }
  ];
  const parentDirectory = path.dirname(input.mainTranscriptPath);
  const subagentRoot = path.join(
    parentDirectory,
    input.signal.sourceSessionId,
    "subagents"
  );
  const agentIds = await listSubagents(input.signal.sourceSessionId, {
    dir: input.signal.cwd
  });
  for (const agentId of [...agentIds].sort()) {
    if (!subagentIdPattern.test(agentId)) {
      throw new Error("claude_subagent_identity_invalid");
    }
    const candidate = path.join(subagentRoot, `agent-${agentId}.jsonl`);
    const canonical = await realpath(candidate);
    const canonicalRoot = await realpath(subagentRoot);
    if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error("claude_subagent_transcript_outside_session");
    }
    const file = await lstat(canonical);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error("claude_subagent_transcript_not_regular_file");
    }
    components.push({
      componentId: `subagent.${agentId}`,
      role: "auxiliary",
      parentComponentId: "main",
      transcriptPath: canonical,
      agentId
    });
  }
  return components;
};

const claudeSourceComponents = async (input: {
  signal: ClaudeTranscriptWatcherSignal;
  mainTranscriptPath: string;
}): Promise<ClaudeSourceComponent[]> =>
  Promise.all(
    (await claudeSourceDescriptors(input)).map(async (component) => ({
      ...component,
      messages:
        component.componentId === "main"
          ? await getSessionMessages(input.signal.sourceSessionId, {
              dir: input.signal.cwd,
              includeSystemMessages: true
            })
          : await getSubagentMessages(
              input.signal.sourceSessionId,
              component.agentId!,
              { dir: input.signal.cwd }
            )
    }))
  );

export const discoverClaudeHistoricalComponentCandidates = async (
  signal: ClaudeTranscriptWatcherSignal,
  env: NodeJS.ProcessEnv = process.env,
  frontiers?: readonly ClaudeHistoricalComponentFrontier[]
): Promise<ClaudeHistoricalComponentCandidate[]> => {
  const mainTranscriptPath = await verifiedTranscriptPath(
    signal.transcriptPath,
    signal.sourceSessionId,
    env
  );
  const descriptors = await claudeSourceDescriptors({
    signal,
    mainTranscriptPath
  });
  const selected = frontiers
    ? descriptors.filter((component) =>
        frontiers.some(
          (frontier) => frontier.componentId === component.componentId
        )
      )
    : descriptors;
  return Promise.all(
    selected.map(async (component) => {
      const frozen = frontiers?.find(
        (frontier) => frontier.componentId === component.componentId
      );
      const frontierOffset =
        frozen?.frontierOffset ??
        completeTranscriptBoundary(component.transcriptPath);
      return {
        componentId: component.componentId,
        componentRole: component.role,
        parentComponentId: component.parentComponentId,
        transcriptPath: component.transcriptPath,
        frontierOffset,
        frontierLine:
          frozen && frozen.frontierLine >= 0
            ? frozen.frontierLine
            : await countTranscriptLines(
                component.transcriptPath,
                frontierOffset
              )
      };
    })
  );
};

const sourceSetFingerprint = async (
  components: ClaudeSourceComponent[]
): Promise<string> =>
  hash(
    await Promise.all(
      components.map(async (component) => {
        const file = await stat(component.transcriptPath);
        return {
          componentId: component.componentId,
          role: component.role,
          parentComponentId: component.parentComponentId,
          transcriptPath: component.transcriptPath,
          size: file.size,
          mtimeMs: file.mtimeMs,
          completeBoundary: completeTranscriptBoundary(
            component.transcriptPath
          ),
          messageIds: component.messages.map((message) => message.uuid)
        };
      })
    )
  );

export const isTransientWatcherFilesystemError = (error: unknown): boolean => {
  const code = record(error).code;
  return ["ENOENT", "ENOTDIR", "ESTALE", "EPERM", "EACCES"].includes(
    typeof code === "string" ? code : ""
  );
};

export const stableClaudeSourceComponents = async (input: {
  signal: ClaudeTranscriptWatcherSignal;
  mainTranscriptPath: string;
  env: NodeJS.ProcessEnv;
}): Promise<ClaudeSourceComponent[]> => {
  if (input.signal.hookEventName !== "SessionEnd") {
    return claudeSourceComponents(input);
  }
  const quietMs = boundedInteger(
    input.env.MEMORY_CLAUDE_SOURCE_SET_QUIET_MS,
    500,
    25,
    5_000
  );
  const timeoutMs = boundedInteger(
    input.env.MEMORY_CLAUDE_SOURCE_SET_STABILIZATION_TIMEOUT_MS,
    5_000,
    quietMs,
    30_000
  );
  const deadline = Date.now() + timeoutMs;
  const initial = await claudeSourceComponents(input);
  let previousFingerprint = await sourceSetFingerprint(initial);
  do {
    await new Promise<void>((resolve) => setTimeout(resolve, quietMs));
    const current = await claudeSourceComponents(input);
    const currentFingerprint = await sourceSetFingerprint(current);
    if (currentFingerprint === previousFingerprint) return current;
    previousFingerprint = currentFingerprint;
  } while (Date.now() + quietMs <= deadline);
  throw new Error("claude_source_set_not_stable");
};

const priorSourceGenerationId = (artifact: SourceArtifact): string | null => {
  const value = artifact.priorGenerationClosure?.sourceGenerationId;
  return typeof value === "string" ? value : null;
};

const sourceGenerationComponents = (
  response: Record<string, unknown>
): SourceArtifact[] => {
  if (!Array.isArray(response.components)) {
    throw new Error("claude_source_generation_components_missing");
  }
  return response.components.map((component) => {
    const value = record(component).artifact;
    if (!value || typeof value !== "object") {
      throw new Error("claude_source_generation_component_invalid");
    }
    return value as SourceArtifact;
  });
};

const lookupGenerationArtifact = async (
  client: MemoryApiClient,
  sourceGenerationId: string,
  sourceComponentId: string
): Promise<SourceArtifact | null> => {
  try {
    return optionalArtifactValue(
      await client.getConversationSourceArtifactByGeneration(
        sourceGenerationId,
        sourceComponentId
      )
    );
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
};

export const coordinateClaudeSuccessorGeneration = async (input: {
  client: MemoryApiClient;
  sourceSessionId: string;
  components: ClaudeSourceComponent[];
  artifacts: Map<string, SourceArtifact | null>;
}): Promise<Map<string, SourceArtifact | null>> => {
  const currentArtifacts = [...input.artifacts.values()].filter(
    (artifact): artifact is SourceArtifact => artifact !== null
  );
  const activeSuccessors = currentArtifacts.filter(
    (artifact) =>
      artifact.lifecycle === "active" && priorSourceGenerationId(artifact)
  );
  const priorGenerationIds = new Set(
    activeSuccessors
      .map(priorSourceGenerationId)
      .filter((value): value is string => value !== null)
  );
  const activeGenerationIds = new Set(
    activeSuccessors
      .map((artifact) => artifact.sourceGenerationId)
      .filter((value): value is string => typeof value === "string")
  );
  if (priorGenerationIds.size > 1 || activeGenerationIds.size > 1) {
    throw new Error("claude_source_successor_generation_conflict");
  }

  let parentGenerationId = [...priorGenerationIds][0] ?? null;
  let successorGenerationId = [...activeGenerationIds][0] ?? null;
  if (!parentGenerationId) {
    const main = input.artifacts.get("main");
    const sourceSetGrew = input.components.some((component) => {
      const artifact = input.artifacts.get(component.componentId);
      return (
        !artifact ||
        completeTranscriptBoundary(component.transcriptPath) >
          artifact.providerCursorOffset
      );
    });
    if (
      !main ||
      main.lifecycle !== "finalized" ||
      !main.sourceSetFinalizedAt ||
      !main.sourceGenerationId ||
      !sourceSetGrew
    ) {
      return input.artifacts;
    }
    parentGenerationId = main.sourceGenerationId;
  }
  successorGenerationId ??= deterministicUuid(
    `claude-code-successor-generation:${input.sourceSessionId}:${parentGenerationId}`
  );

  const parentArtifacts = sourceGenerationComponents(
    await input.client.listConversationSourceGenerationComponents(
      parentGenerationId
    )
  );
  const parentMain = parentArtifacts.find(
    (artifact) => artifact.sourceComponentId === "main"
  );
  if (!parentMain?.sourceSetFinalizedAt) {
    throw new Error("claude_source_parent_set_not_finalized");
  }
  if (
    parentArtifacts.some(
      (artifact) => artifact.lifecycle !== "finalized" || !artifact.closureHash
    )
  ) {
    throw new Error("claude_source_parent_component_not_finalized");
  }

  const coordinated = new Map(input.artifacts);
  const orderedParents = [...parentArtifacts].sort((left, right) => {
    if (left.sourceComponentId === "main") return -1;
    if (right.sourceComponentId === "main") return 1;
    return String(left.sourceComponentId).localeCompare(
      String(right.sourceComponentId)
    );
  });
  for (const parent of orderedParents) {
    const componentId = parent.sourceComponentId;
    if (!componentId || !parent.closureHash) {
      throw new Error("claude_source_parent_component_identity_missing");
    }
    const latest = coordinated.get(componentId);
    if (
      latest?.sourceGenerationId === successorGenerationId &&
      latest.lifecycle !== "finalized"
    ) {
      continue;
    }
    const originKeyId = deterministicUuid(
      `claude-code-successor-origin:${input.sourceSessionId}:${parentGenerationId}:${componentId}`
    );
    let successor: SourceArtifact;
    try {
      successor = artifactValue(
        await input.client.createConversationSourceSuccessorGeneration(
          parent.id,
          {
            expectedParentClosureHash: parent.closureHash,
            sourceGenerationId: successorGenerationId,
            originKeyId
          }
        )
      );
    } catch (error) {
      if (!(error instanceof MemoryApiError) || error.status !== 409) {
        throw error;
      }
      const replayedSuccessor = await lookupGenerationArtifact(
        input.client,
        successorGenerationId,
        componentId
      );
      const prior = replayedSuccessor?.priorGenerationClosure;
      if (
        !replayedSuccessor ||
        prior?.sourceGenerationId !== parentGenerationId ||
        prior.contentDigest !== parent.closureHash
      ) {
        throw error;
      }
      successor = replayedSuccessor;
    }
    coordinated.set(componentId, successor);
  }
  return coordinated;
};
