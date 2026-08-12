import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  openSync,
  closeSync,
  readSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  type Dirent,
  type FSWatcher
} from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  getSubagentMessages,
  getSessionMessages,
  listSubagents,
  type SessionMessage
} from "@anthropic-ai/claude-agent-sdk";
import { canonicalConversationItemKey } from "@koed/shared";
import { MemoryApiClient, MemoryApiError, defaultConfig } from "./index.js";
import { completeTranscriptBoundary } from "./codex-transcript-journal.js";
import {
  persistRawConversationItems,
  projectRawConversationItems
} from "./raw-conversation-items.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";
import {
  claudeWatcherSignalDirectory,
  claudeWatcherWakePath,
  type ClaudeTranscriptWatcherSignal
} from "./claude-transcript-watcher-signal.js";

export interface ClaudeWatcherState {
  version: 2;
  activatedAt: string;
  cursors: Record<string, { messageCount: number; updatedAt: string }>;
}

export interface ClaudeTranscriptWatcherHandle {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const statePath = (env: NodeJS.ProcessEnv): string =>
  path.join(
    path.resolve(env.KOED_HOME ?? path.join(os.homedir(), ".koed")),
    "state",
    "claude-transcript-watcher.json"
  );

const loadState = (env: NodeJS.ProcessEnv): ClaudeWatcherState => {
  try {
    const value = JSON.parse(readFileSync(statePath(env), "utf8")) as
      | ClaudeWatcherState
      | undefined;
    if (
      value?.version === 2 &&
      Number.isFinite(Date.parse(value.activatedAt))
    ) {
      return value;
    }
  } catch {
    // A missing state file creates a new activation frontier.
  }
  return { version: 2, activatedAt: new Date().toISOString(), cursors: {} };
};

const componentCursorKey = (sessionId: string, componentId: string): string =>
  `${sessionId}\u0000${componentId}`;

const persistState = (env: NodeJS.ProcessEnv, state: ClaudeWatcherState) => {
  const target = statePath(env);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
};

interface ClaudeTranscriptIndex {
  timestamps: Map<string, string>;
  activationOffset: number;
  activationLine: number;
  activationTimestamp: string | null;
  lineCount: number;
}

const transcriptIndex = async (
  transcriptPath: string,
  activatedAt: string
): Promise<ClaudeTranscriptIndex> => {
  const timestamps = new Map<string, string>();
  const activation = Date.parse(activatedAt);
  let activationOffset = -1;
  let activationLine = -1;
  let byteOffset = 0;
  let lineNumber = 0;
  const completeBoundary = completeTranscriptBoundary(transcriptPath);
  if (completeBoundary === 0) {
    return {
      timestamps,
      activationOffset: 0,
      activationLine: 0,
      activationTimestamp: null,
      lineCount: 0
    };
  }
  const input = createReadStream(transcriptPath, {
    encoding: "utf8",
    end: completeBoundary - 1
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) {
      throw new Error("Claude transcript contains an empty complete record");
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof entry.uuid === "string" &&
        typeof entry.timestamp === "string" &&
        Number.isFinite(Date.parse(entry.timestamp))
      ) {
        const timestamp = new Date(entry.timestamp).toISOString();
        timestamps.set(entry.uuid, timestamp);
        if (activationOffset < 0 && Date.parse(timestamp) >= activation) {
          activationOffset = byteOffset;
          activationLine = lineNumber;
        }
      }
    } catch {
      throw new Error("Claude transcript contains a malformed complete record");
    }
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
    lineNumber += 1;
  }
  return {
    timestamps,
    activationOffset: Math.max(0, activationOffset),
    activationLine: Math.max(0, activationLine),
    activationTimestamp:
      activationOffset < 0
        ? null
        : ([...timestamps.values()].find(
            (timestamp) => Date.parse(timestamp) >= activation
          ) ?? null),
    lineCount: lineNumber
  };
};

const claudeHome = (env: NodeJS.ProcessEnv): string =>
  path.resolve(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));

const claudeProjectsHome = (env: NodeJS.ProcessEnv): string =>
  path.join(claudeHome(env), "projects");

const transcriptIdentity = async (
  transcriptPath: string
): Promise<{ sessionId: string; cwd: string } | null> => {
  const sessionId = path.basename(transcriptPath, ".jsonl");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sessionId
    )
  ) {
    return null;
  }
  const completeBoundary = completeTranscriptBoundary(transcriptPath);
  if (completeBoundary === 0) return null;
  const input = createReadStream(transcriptPath, {
    encoding: "utf8",
    end: Math.min(completeBoundary, 1024 * 1024) - 1
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let inspected = 0;
  for await (const line of lines) {
    inspected += 1;
    if (inspected > 2_000) break;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        entry.sessionId === sessionId &&
        typeof entry.cwd === "string" &&
        entry.cwd.trim()
      ) {
        lines.close();
        input.destroy();
        return { sessionId, cwd: entry.cwd };
      }
    } catch {
      return null;
    }
  }
  return null;
};

export const discoverClaudeTranscriptSignals = async (
  state: ClaudeWatcherState,
  env: NodeJS.ProcessEnv = process.env
): Promise<ClaudeTranscriptWatcherSignal[]> => {
  const projectsHome = claudeProjectsHome(env);
  mkdirSync(projectsHome, { recursive: true, mode: 0o700 });
  const activation = Date.parse(state.activatedAt);
  const signals: ClaudeTranscriptWatcherSignal[] = [];
  const projects = (await readdir(projectsHome, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .slice(0, 1_000);
  for (const project of projects) {
    const projectPath = path.join(projectsHome, project.name);
    const files = (await readdir(projectPath, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.name.endsWith(".jsonl")
      )
      .slice(0, 10_000);
    for (const file of files) {
      const transcriptPath = path.join(projectPath, file.name);
      const details = await stat(transcriptPath);
      const sourceSessionId = path.basename(file.name, ".jsonl");
      const cursor = state.cursors[componentCursorKey(sourceSessionId, "main")];
      if (cursor && details.mtimeMs <= Date.parse(cursor.updatedAt)) {
        continue;
      }
      if (details.mtimeMs < activation && !cursor) {
        continue;
      }
      const identity = await transcriptIdentity(transcriptPath);
      if (!identity) continue;
      signals.push({
        sourceSessionId: identity.sessionId,
        transcriptPath,
        cwd: identity.cwd,
        hookEventName: "FilesystemRecovery",
        observedAt: new Date(details.mtimeMs).toISOString()
      });
    }
  }
  return signals;
};

const verifiedTranscriptPath = async (
  transcriptPath: string,
  sourceSessionId: string,
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const [home, candidate] = await Promise.all([
    realpath(claudeHome(env)),
    realpath(path.resolve(transcriptPath))
  ]);
  if (candidate !== home && !candidate.startsWith(`${home}${path.sep}`)) {
    throw new Error("claude_transcript_outside_config_home");
  }
  if (path.basename(candidate) !== `${sourceSessionId}.jsonl`) {
    throw new Error("claude_transcript_session_identity_mismatch");
  }
  const file = await lstat(candidate);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error("claude_transcript_not_regular_file");
  }
  return candidate;
};

export const discoverClaudeHistoricalTranscriptSignals = async (
  sourceSessionIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<ClaudeTranscriptWatcherSignal[]> => {
  const requested = new Set(sourceSessionIds);
  if (requested.size === 0) {
    throw new Error("claude_historical_import_requires_session_selection");
  }
  const projectsHome = claudeProjectsHome(env);
  const signals: ClaudeTranscriptWatcherSignal[] = [];
  const projects = (await readdir(projectsHome, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .slice(0, 1_000);
  for (const project of projects) {
    const projectPath = path.join(projectsHome, project.name);
    const files = (await readdir(projectPath, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.name.endsWith(".jsonl") &&
          requested.has(path.basename(entry.name, ".jsonl"))
      )
      .slice(0, 10_000);
    for (const file of files) {
      const transcriptPath = path.join(projectPath, file.name);
      const identity = await transcriptIdentity(transcriptPath);
      if (!identity || !requested.has(identity.sessionId)) continue;
      const details = await stat(transcriptPath);
      signals.push({
        sourceSessionId: identity.sessionId,
        transcriptPath,
        cwd: identity.cwd,
        hookEventName: "HistoricalImport",
        observedAt: details.mtime.toISOString()
      });
    }
  }
  const found = new Set(signals.map((signal) => signal.sourceSessionId));
  const missing = [...requested].filter((sessionId) => !found.has(sessionId));
  if (missing.length > 0) {
    throw new Error(
      `claude_historical_sessions_not_found:${missing.join(",")}`
    );
  }
  return signals;
};

type SourceArtifact = {
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
};

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

const lookupClaudeArtifact = async (
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
  end: number
): Buffer => {
  const maximum = Math.min(end, start + 16 * 1024 * 1024);
  const bytes = readRange(sourcePath, start, maximum);
  if (maximum === end) return bytes;
  const newline = bytes.lastIndexOf(0x0a);
  if (newline < 0) throw new Error("claude_transcript_record_too_large");
  return bytes.subarray(0, newline + 1);
};

const journalClaudeTranscript = async (input: {
  client: MemoryApiClient;
  signal: ClaudeTranscriptWatcherSignal;
  transcriptPath: string;
  index: ClaudeTranscriptIndex;
  componentId: string;
  componentRole: "primary" | "auxiliary";
  parentComponentId: string | null;
  artifact?: SourceArtifact | null;
}): Promise<SourceArtifact> => {
  const file = await stat(input.transcriptPath);
  const completeBoundary = completeTranscriptBoundary(input.transcriptPath);
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
  while (artifact.providerCursorOffset < completeBoundary) {
    const bytes = completeSegment(
      input.transcriptPath,
      artifact.providerCursorOffset,
      completeBoundary
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
  }
  return artifact;
};

export const registerClaudeHistoricalTranscriptSources = async (
  client: MemoryApiClient,
  signal: ClaudeTranscriptWatcherSignal,
  env: NodeJS.ProcessEnv = process.env
): Promise<
  Array<
    SourceArtifact & {
      sourceComponentId: string;
      registrationFrontierOffset: number;
    }
  >
> => {
  const transcriptPath = await verifiedTranscriptPath(
    signal.transcriptPath,
    signal.sourceSessionId,
    env
  );
  const components = await claudeSourceComponents({
    signal,
    mainTranscriptPath: transcriptPath
  });
  const register = async (component: ClaudeSourceComponent) => {
    const boundary = completeTranscriptBoundary(component.transcriptPath);
    const index = await transcriptIndex(
      component.transcriptPath,
      "9999-12-31T23:59:59.999Z"
    );
    const artifact = await journalClaudeTranscript({
      client,
      signal,
      transcriptPath: component.transcriptPath,
      index: {
        ...index,
        activationOffset: boundary,
        activationLine: index.lineCount,
        activationTimestamp: null
      },
      componentId: component.componentId,
      componentRole: component.role,
      parentComponentId: component.parentComponentId
    });
    return {
      ...artifact,
      sourceComponentId: component.componentId,
      registrationFrontierOffset: boundary
    };
  };
  const main = components.find((component) => component.componentId === "main");
  if (!main) throw new Error("claude_source_main_component_missing");
  const registeredMain = await register(main);
  const registeredAuxiliaries = await Promise.all(
    components
      .filter((component) => component.componentId !== "main")
      .map(register)
  );
  return [registeredMain, ...registeredAuxiliaries];
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const blockText = (block: Record<string, unknown>): string => {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof record(entry).text === "string"
            ? String(record(entry).text)
            : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

type AdaptedBlock = {
  actor: "user" | "assistant" | "subagent" | "tool" | "system";
  transcriptType: string;
  component: string;
  text: string;
  raw: unknown;
};

const messageActor = (
  message: SessionMessage
): "user" | "assistant" | "subagent" | "system" =>
  message.type === "assistant" &&
  (message.parent_agent_id || message.parent_tool_use_id)
    ? "subagent"
    : message.type;

const messageTranscriptType = (message: SessionMessage): string => {
  const actor = messageActor(message);
  return actor === "assistant"
    ? "agent_message"
    : actor === "subagent"
      ? "subagent_message"
      : actor === "user"
        ? "user_message"
        : "system_message";
};

const adaptedBlocks = (message: SessionMessage): AdaptedBlock[] => {
  const envelope = record(message.message);
  const content = envelope.content;
  const blocks = Array.isArray(content) ? content : [content ?? envelope];
  return blocks.flatMap((rawBlock): AdaptedBlock[] => {
    if (typeof rawBlock === "string") {
      return [
        {
          actor: messageActor(message),
          transcriptType: messageTranscriptType(message),
          component: "message",
          text: rawBlock,
          raw: rawBlock
        }
      ];
    }
    const block = record(rawBlock);
    const type = typeof block.type === "string" ? block.type : "text";
    if (type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      return [
        {
          actor: "tool",
          transcriptType: "tool_call",
          component: "tool_call",
          text: `Tool call: ${name}\n\nInput: ${JSON.stringify(block.input ?? {})}`,
          raw: block
        }
      ];
    }
    if (type === "tool_result") {
      return [
        {
          actor: "tool",
          transcriptType: "tool_result",
          component: "tool_result",
          text: blockText(block) || "Tool completed without text output.",
          raw: block
        }
      ];
    }
    if (type === "thinking" || type === "redacted_thinking") {
      return [
        {
          actor: messageActor(message),
          transcriptType: "agent_reasoning",
          component: "reasoning",
          text: blockText(block),
          raw: block
        }
      ];
    }
    const text = blockText(block);
    if (!text.trim()) return [];
    return [
      {
        actor: messageActor(message),
        transcriptType: messageTranscriptType(message),
        component: "message",
        text,
        raw: block
      }
    ];
  });
};

const isHumanUserMessage = (message: SessionMessage): boolean =>
  message.type === "user" &&
  adaptedBlocks(message).some((block) => block.actor === "user");

const canonicalKey = (input: {
  sessionId: string;
  turnId: string;
  stableItemId: string;
  component: string;
}) =>
  canonicalConversationItemKey({
    provider: "claude-code",
    externalThreadId: input.sessionId,
    externalTurnId: input.turnId,
    stableItemId: input.stableItemId,
    component: input.component
  });

const turnBoundaryControl = (input: {
  signal: ClaudeTranscriptWatcherSignal;
  capturedSessionId: string;
  externalTurnId: string;
  frontierOffset: number;
  frontierLine: number;
  sourceSequence: number;
}): RawConversationItemRequest => {
  const stableItemId = `turn:${input.externalTurnId}:completed`;
  const eventTime = input.signal.observedAt ?? new Date().toISOString();
  const rawJson = {
    type: "hook_signal",
    payload: {
      type: "turn_completed",
      sourceFrontierOffset: input.frontierOffset,
      sourceFrontierLine: input.frontierLine
    }
  };
  return {
    sourceKind: "claude-code",
    sourceAdapterVersion: "claude-code-hook-signal-v1",
    sourceTransport: "hook_signal",
    sessionId: input.capturedSessionId,
    externalSessionId: input.signal.sourceSessionId,
    externalThreadId: input.signal.sourceSessionId,
    externalTurnId: input.externalTurnId,
    externalItemId: stableItemId,
    canonicalStableItemId: stableItemId,
    sourceRecordType: "hook_signal",
    sourceEventType: "turn_completed",
    sourceSequence: input.sourceSequence,
    eventTime,
    observedAt: eventTime,
    rawJson,
    sourceHash: hash({
      provider: "claude-code",
      sessionId: input.signal.sourceSessionId,
      externalTurnId: input.externalTurnId,
      frontierOffset: input.frontierOffset,
      frontierLine: input.frontierLine
    }),
    idempotencyKey: `claude-code-hook-turn-boundary:${input.signal.sourceSessionId}:${input.externalTurnId}`,
    canonicalItemKey: canonicalKey({
      sessionId: input.signal.sourceSessionId,
      turnId: input.externalTurnId,
      stableItemId,
      component: "control"
    }),
    observationKind: "control",
    observationComponent: "control",
    projectionStatus: "pending",
    projectionVersion: "claude-code-hook-signal-v1",
    metadata: {
      sourceEventTimeAccuracy: "source",
      semanticControl: "turn_completed",
      sourceRuntime: "claude-code"
    }
  };
};

const adaptMessages = (input: {
  messages: SessionMessage[];
  sessionId: string;
  capturedSessionId: string;
  cwd: string;
  timestamps: Map<string, string>;
  observedAt: string;
  minimumMessageIndex: number;
  activationTime?: number;
  componentId: string;
}): RawConversationItemRequest[] => {
  let currentTurnId = `session:${input.sessionId}:preamble`;
  const items: RawConversationItemRequest[] = [];
  input.messages.forEach((message, messageIndex) => {
    if (isHumanUserMessage(message)) currentTurnId = message.uuid;
    const sourceTimestamp = input.timestamps.get(message.uuid);
    if (messageIndex < input.minimumMessageIndex) return;
    if (!sourceTimestamp) {
      throw new Error(`claude_source_timestamp_missing:${message.uuid}`);
    }
    if (
      input.activationTime !== undefined &&
      Date.parse(sourceTimestamp) < input.activationTime
    ) {
      return;
    }
    const eventTime = sourceTimestamp;
    adaptedBlocks(message).forEach((block, blockIndex) => {
      const stableItemId = `${input.componentId}:${message.uuid}:${blockIndex}`;
      const key = canonicalKey({
        sessionId: input.sessionId,
        turnId: currentTurnId,
        stableItemId,
        component: block.component
      });
      const rawJson = {
        type: "claude_session_message",
        messageType: message.type,
        messageUuid: message.uuid,
        parentToolUseId: message.parent_tool_use_id,
        parentAgentId: message.parent_agent_id,
        contentBlock: block.raw,
        timestamp: eventTime
      };
      items.push({
        sourceKind: "claude-code",
        sourceAdapterVersion: "claude-code-transcript-v1",
        sourceTransport: "transcript",
        sessionId: input.capturedSessionId,
        externalSessionId: input.sessionId,
        externalThreadId: input.sessionId,
        externalTurnId: currentTurnId,
        externalItemId: stableItemId,
        canonicalStableItemId: stableItemId,
        sourceRecordType: "session_message",
        sourceEventType: block.transcriptType,
        sourceSequence: messageIndex * 1_000 + blockIndex,
        eventTime,
        observedAt: input.observedAt,
        rawJson,
        rawText: block.text,
        sourceHash: hash(rawJson),
        idempotencyKey: `claude-code-transcript:${input.sessionId}:${input.componentId}:${stableItemId}`,
        canonicalItemKey: key,
        observationKind: "reconciliation",
        observationComponent: block.component,
        projectionStatus: "pending",
        projectionVersion: "claude-code-transcript-v1",
        metadata: {
          actor: block.actor,
          transcriptType: block.transcriptType,
          sourceRuntime: "claude-code",
          sourceComponentId: input.componentId,
          cwd: input.cwd
        }
      });
    });
  });
  return items;
};

interface ClaudeSourceComponent {
  componentId: string;
  role: "primary" | "auxiliary";
  parentComponentId: string | null;
  transcriptPath: string;
  messages: SessionMessage[];
}

const subagentIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const claudeSourceComponents = async (input: {
  signal: ClaudeTranscriptWatcherSignal;
  mainTranscriptPath: string;
}): Promise<ClaudeSourceComponent[]> => {
  const components: ClaudeSourceComponent[] = [
    {
      componentId: "main",
      role: "primary",
      parentComponentId: null,
      transcriptPath: input.mainTranscriptPath,
      messages: await getSessionMessages(input.signal.sourceSessionId, {
        dir: input.signal.cwd,
        includeSystemMessages: true
      })
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
      messages: await getSubagentMessages(
        input.signal.sourceSessionId,
        agentId,
        { dir: input.signal.cwd }
      )
    });
  }
  return components;
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

const isTransientWatcherFilesystemError = (error: unknown): boolean => {
  const code = record(error).code;
  return ["ENOENT", "ENOTDIR", "ESTALE", "EPERM", "EACCES"].includes(
    typeof code === "string" ? code : ""
  );
};

const stableClaudeSourceComponents = async (input: {
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

const coordinateClaudeSuccessorGeneration = async (input: {
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

export const processClaudeTranscriptSignal = async (
  client: MemoryApiClient,
  state: ClaudeWatcherState,
  signal: ClaudeTranscriptWatcherSignal,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const transcriptPath = await verifiedTranscriptPath(
    signal.transcriptPath,
    signal.sourceSessionId,
    env
  );
  const mainCursor =
    state.cursors[componentCursorKey(signal.sourceSessionId, "main")]
      ?.messageCount ?? 0;
  const components = await stableClaudeSourceComponents({
    signal,
    mainTranscriptPath: transcriptPath,
    env
  });
  const mainIndex = await transcriptIndex(transcriptPath, state.activatedAt);
  if (mainCursor === 0 && mainIndex.activationTimestamp === null) return;
  const activation = Date.parse(state.activatedAt);
  const initialArtifacts = new Map<string, SourceArtifact | null>();
  for (const component of components) {
    initialArtifacts.set(
      component.componentId,
      await lookupClaudeArtifact(
        client,
        signal.sourceSessionId,
        component.componentId
      )
    );
  }
  const artifactsByComponent = await coordinateClaudeSuccessorGeneration({
    client,
    sourceSessionId: signal.sourceSessionId,
    components,
    artifacts: initialArtifacts
  });
  const allItems: RawConversationItemRequest[] = [];
  const cursorUpdates: Array<{
    key: string;
    value: { messageCount: number; updatedAt: string };
  }> = [];
  let capturedSessionId: string | null = null;
  let mainMessages: SessionMessage[] = [];
  for (const component of components) {
    const cursorKey = componentCursorKey(
      signal.sourceSessionId,
      component.componentId
    );
    const cursor = state.cursors[cursorKey]?.messageCount ?? 0;
    const index =
      component.componentId === "main"
        ? mainIndex
        : await transcriptIndex(component.transcriptPath, state.activatedAt);
    if (cursor === 0 && index.activationTimestamp === null) continue;
    const artifact = await journalClaudeTranscript({
      client,
      signal,
      transcriptPath: component.transcriptPath,
      index,
      componentId: component.componentId,
      componentRole: component.role,
      parentComponentId: component.parentComponentId,
      artifact: artifactsByComponent.get(component.componentId) ?? null
    });
    if (!artifact.sessionId) {
      throw new Error("Claude journal did not resolve its Captured Session");
    }
    if (capturedSessionId && capturedSessionId !== artifact.sessionId) {
      throw new Error("Claude source components resolved different sessions");
    }
    capturedSessionId = artifact.sessionId;
    artifactsByComponent.set(component.componentId, artifact);
    if (component.messages.length > cursor) {
      allItems.push(
        ...adaptMessages({
          messages: component.messages,
          sessionId: signal.sourceSessionId,
          capturedSessionId,
          cwd: signal.cwd,
          timestamps: index.timestamps,
          observedAt: signal.observedAt ?? new Date().toISOString(),
          minimumMessageIndex: cursor,
          ...(cursor === 0 ? { activationTime: activation } : {}),
          componentId: component.componentId
        })
      );
    }
    cursorUpdates.push({
      key: cursorKey,
      value: {
        messageCount: component.messages.length,
        updatedAt: new Date().toISOString()
      }
    });
    if (component.componentId === "main") mainMessages = component.messages;
  }
  const artifacts = [...artifactsByComponent.values()].filter(
    (artifact): artifact is SourceArtifact => artifact !== null
  );
  const mainArtifact =
    artifacts.find((artifact) => artifact.sourceComponentId === "main") ??
    artifacts[0];
  const currentTurn = [...mainMessages]
    .reverse()
    .find(isHumanUserMessage)?.uuid;
  if (
    capturedSessionId &&
    currentTurn &&
    mainArtifact &&
    (signal.turnBoundary === true ||
      ["Stop", "StopFailure", "SessionEnd"].includes(
        signal.hookEventName ?? ""
      ))
  ) {
    allItems.push(
      turnBoundaryControl({
        signal,
        capturedSessionId,
        externalTurnId: currentTurn,
        frontierOffset: mainArtifact.providerCursorOffset,
        frontierLine: mainArtifact.providerCursorLine,
        sourceSequence: mainMessages.length * 1_000 + 999
      })
    );
  }
  if (allItems.length > 0) {
    if (!capturedSessionId) {
      throw new Error("Claude capture did not resolve its Captured Session");
    }
    const persisted = await persistRawConversationItems(
      client,
      allItems,
      `Claude session ${signal.sourceSessionId}`
    );
    await projectRawConversationItems(
      client,
      persisted,
      `Claude session ${signal.sourceSessionId}`
    );
  }
  if (signal.hookEventName === "SessionEnd" && artifacts.length > 0) {
    for (const artifact of artifacts) {
      await client.finalizeConversationSourceArtifact(artifact.id, {
        expectedProviderOffset: artifact.providerCursorOffset,
        expectedProviderLine: artifact.providerCursorLine
      });
    }
    const sourceGenerationId = artifacts[0]?.sourceGenerationId;
    if (!sourceGenerationId) {
      throw new Error("claude_source_generation_identity_missing");
    }
    await client.finalizeConversationSourceSet(sourceGenerationId);
  }
  for (const update of cursorUpdates) {
    state.cursors[update.key] = update.value;
  }
};

export const startClaudeTranscriptWatcher = (
  client: MemoryApiClient = new MemoryApiClient(defaultConfig()),
  env: NodeJS.ProcessEnv = process.env
): ClaudeTranscriptWatcherHandle => {
  const state = loadState(env);
  persistState(env, state);
  const directory = claudeWatcherSignalDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let running: Promise<void> | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  let retryNeedsDiscovery = false;
  let stopped = false;
  const debounceMs = boundedInteger(
    env.MEMORY_CLAUDE_TRANSCRIPT_DEBOUNCE_MS,
    200,
    25,
    5_000
  );
  const retryBaseMs = boundedInteger(
    env.MEMORY_CLAUDE_TRANSCRIPT_RETRY_BASE_MS,
    1_000,
    100,
    30_000
  );
  const retryMaxMs = boundedInteger(
    env.MEMORY_CLAUDE_TRANSCRIPT_RETRY_MAX_MS,
    30_000,
    retryBaseMs,
    5 * 60_000
  );
  let discoverPending = false;
  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return;
    const delayMs = Math.min(
      retryMaxMs,
      retryBaseMs * 2 ** Math.min(retryAttempt, 8)
    );
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const discover = retryNeedsDiscovery;
      retryNeedsDiscovery = false;
      discoverPending ||= discover;
      scanInBackground(discover);
    }, delayMs);
    retryTimer.unref();
  };
  const scan = (discover: boolean): Promise<void> => {
    discoverPending ||= discover;
    if (running) return running;
    let failed = false;
    running = (async () => {
      do {
        const includeDiscovery = discoverPending;
        discoverPending = false;
        const signalled: Array<{
          signal: ClaudeTranscriptWatcherSignal;
          target?: string;
        }> = [];
        for (const name of await readdir(directory)) {
          if (!name.endsWith(".json")) continue;
          const target = path.join(directory, name);
          try {
            signalled.push({
              signal: JSON.parse(
                readFileSync(target, "utf8")
              ) as ClaudeTranscriptWatcherSignal,
              target
            });
          } catch (error) {
            try {
              renameSync(target, `${target}.invalid`);
            } catch {
              // A concurrent valid rewrite will be handled by the next wake.
            }
            console.error(
              `Claude transcript signal could not be read: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        if (includeDiscovery) {
          for (const signal of await discoverClaudeTranscriptSignals(
            state,
            env
          )) {
            signalled.push({ signal });
          }
        }
        for (const pending of signalled) {
          try {
            await processClaudeTranscriptSignal(
              client,
              state,
              pending.signal,
              env
            );
            persistState(env, state);
            if (pending.target) unlinkSync(pending.target);
          } catch (error) {
            failed = true;
            retryNeedsDiscovery ||= pending.target === undefined;
            console.error(
              `Claude transcript capture failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      } while (discoverPending);
    })().finally(() => {
      running = null;
      if (failed) {
        scheduleRetry();
      } else {
        retryAttempt = 0;
        retryNeedsDiscovery = false;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      }
    });
    return running;
  };
  const scanInBackground = (discover: boolean): void => {
    void scan(discover).catch((error) => {
      retryNeedsDiscovery ||= discover;
      console.error(
        `Claude transcript scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      scheduleRetry();
    });
  };
  const scanNow = (): Promise<void> => scan(false);
  const scheduleScan = (discover: boolean): void => {
    if (stopped) return;
    discoverPending ||= discover;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scanInBackground(discover);
    }, debounceMs);
    debounceTimer.unref();
  };
  const watchers: FSWatcher[] = [];
  watchers.push(watch(directory, () => scheduleScan(false)));
  const wake = claudeWatcherWakePath(env);
  mkdirSync(path.dirname(wake), { recursive: true, mode: 0o700 });
  if (!existsSync(wake)) writeFileSync(wake, "0\n", { mode: 0o600 });
  watchers.push(watch(wake, () => scheduleScan(false)));
  const projectsHome = claudeProjectsHome(env);
  mkdirSync(projectsHome, { recursive: true, mode: 0o700 });
  const projectWatchers = new Map<string, FSWatcher>();
  const nestedWatchers = new Map<string, FSWatcher>();
  let refreshRunning: Promise<void> | null = null;
  let refreshPending = false;
  const refreshProjectWatchersPass = async (): Promise<void> => {
    const projects = (await readdir(projectsHome, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, 1_000);
    const current = new Set(projects.map((entry) => entry.name));
    for (const [name, watcher] of projectWatchers) {
      if (current.has(name)) continue;
      watcher.close();
      projectWatchers.delete(name);
    }
    for (const project of projects) {
      if (stopped || projectWatchers.has(project.name)) continue;
      try {
        projectWatchers.set(
          project.name,
          watch(path.join(projectsHome, project.name), requestWatcherRefresh)
        );
      } catch (error) {
        if (!isTransientWatcherFilesystemError(error)) throw error;
      }
    }
    const nested = new Set<string>();
    for (const project of projects) {
      const projectPath = path.join(projectsHome, project.name);
      let sessionDirectories: Dirent[];
      try {
        sessionDirectories = (
          await readdir(projectPath, { withFileTypes: true })
        )
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .slice(0, 10_000);
      } catch (error) {
        if (isTransientWatcherFilesystemError(error)) continue;
        throw error;
      }
      for (const sessionDirectory of sessionDirectories) {
        const sessionPath = path.join(projectPath, sessionDirectory.name);
        nested.add(sessionPath);
        const subagentPath = path.join(sessionPath, "subagents");
        try {
          const details = await lstat(subagentPath);
          if (details.isDirectory() && !details.isSymbolicLink()) {
            nested.add(subagentPath);
          }
        } catch {
          // The subagent directory is created lazily.
        }
      }
    }
    for (const [target, watcher] of nestedWatchers) {
      if (nested.has(target)) continue;
      watcher.close();
      nestedWatchers.delete(target);
    }
    for (const target of nested) {
      if (stopped || nestedWatchers.has(target)) continue;
      try {
        nestedWatchers.set(target, watch(target, requestWatcherRefresh));
      } catch (error) {
        if (!isTransientWatcherFilesystemError(error)) throw error;
      }
    }
  };
  const refreshProjectWatchers = (): Promise<void> => {
    refreshPending = true;
    if (refreshRunning) return refreshRunning;
    refreshRunning = (async () => {
      while (!stopped && refreshPending) {
        refreshPending = false;
        try {
          await refreshProjectWatchersPass();
        } catch (error) {
          console.error(
            `Claude project watcher refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    })().finally(() => {
      refreshRunning = null;
    });
    return refreshRunning;
  };
  function requestWatcherRefresh(): void {
    if (stopped) return;
    void refreshProjectWatchers().then(
      () => scheduleScan(true),
      (error) => {
        console.error(
          `Claude project watcher refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        scheduleScan(true);
      }
    );
  }
  watchers.push(watch(projectsHome, requestWatcherRefresh));
  requestWatcherRefresh();
  return {
    scanNow,
    async stop() {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      watchers.forEach((watcher) => watcher.close());
      projectWatchers.forEach((watcher) => watcher.close());
      nestedWatchers.forEach((watcher) => watcher.close());
      await running;
      await refreshRunning;
    }
  };
};
