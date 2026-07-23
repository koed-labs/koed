import { createHash } from "node:crypto";
import fs, {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type Dir,
  type FSWatcher,
  type Stats
} from "node:fs";
import { lstat, opendir, stat } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { MemoryApiClient, MemoryApiError, defaultConfig } from "./index.js";
import { logger } from "./logger.js";
import { rawConversationItemBatches } from "./raw-conversation-items.js";
import {
  buildCodexTranscriptConversationItems,
  extractTranscriptSessionMetadata,
  parseTranscriptFileRecords,
  type CodexTranscriptCheckpointState,
  type TranscriptContext
} from "./codex-transcript-parser.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";

export {
  signalCodexTranscriptWatcher,
  watcherWakePath
} from "./codex-transcript-watcher-signal.js";

const WATCHER_VERSION = 3;
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const PREFIX_SENTINEL_BYTES = 64 * 1024;
const BOUNDARY_SCAN_BYTES = 64 * 1024;
const TRANSCRIPT_PATTERN = /^rollout-.*\.jsonl$/;

export interface CodexTranscriptWatcherConfig {
  roots: string[];
  koedHome: string;
  rescanIntervalMs: number;
  debounceMs: number;
  maxEntriesPerScan: number;
  maxFilesPerScan: number;
  maxBytesPerBatch: number;
}

interface HistoricalSource {
  id: string;
  runId: string;
  sourceSessionId: string;
  sourceFingerprint: string;
  registrationFrontierOffset: number;
  registrationPrefixHash: string;
  liveCursorOffset: number;
  liveCursorLine: number;
  liveCursorHash: string | null;
  sourceSizeBytes: number | null;
  sourceModifiedAt: string | null;
  detectedProject: Record<string, unknown>;
}

interface WatcherSnapshot {
  state: "starting" | "running" | "stopped";
  startedAt: string;
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  scans: number;
  filesDiscovered: number;
  sourcesRegistered: number;
  batchesIngested: number;
  recordsIngested: number;
  bytesAdvanced: number;
}

export interface CodexTranscriptWatcherClient {
  accessCheck(): Promise<unknown>;
  createHistoricalImportRun(): Promise<Record<string, unknown>>;
  lookupHistoricalImportSource(input: {
    aiClient: "codex";
    sourceKind: "codex";
    sourceSessionId: string;
  }): Promise<Record<string, unknown>>;
  createHistoricalImportSource(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  observeHistoricalImportSource(
    sourceId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  advanceLiveTranscriptCursor(
    sourceId: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  effectiveCapturePolicy(input: {
    projectId?: string;
    threadId?: string;
    sessionId?: string;
  }): Promise<Record<string, unknown>>;
  createSession(input: Record<string, unknown>): Promise<{
    session?: { id: string };
    skipped?: boolean;
  }>;
  createConversationItems(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  projectConversationItems(
    input?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export interface CodexTranscriptWatcherHandle {
  scanNow(): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  snapshot(): WatcherSnapshot;
}

const positiveInt = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number
): number => {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
};

const uniqueAbsoluteRoots = (values: string[]): string[] => [
  ...new Set(values.map((value) => path.resolve(value)))
];

export const resolveCodexTranscriptWatcherConfig = (
  env: NodeJS.ProcessEnv = process.env
): CodexTranscriptWatcherConfig => {
  const codexHome = path.resolve(
    env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  );
  const configuredRoots = env.MEMORY_CODEX_TRANSCRIPT_ROOTS?.split(
    path.delimiter
  )
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    roots: uniqueAbsoluteRoots(
      configuredRoots?.length
        ? configuredRoots
        : [path.join(codexHome, "sessions")]
    ),
    koedHome: path.resolve(env.KOED_HOME ?? path.join(os.homedir(), ".koed")),
    rescanIntervalMs: positiveInt(
      env,
      "MEMORY_CODEX_TRANSCRIPT_RESCAN_INTERVAL_MS",
      15_000,
      300_000
    ),
    debounceMs: positiveInt(
      env,
      "MEMORY_CODEX_TRANSCRIPT_DEBOUNCE_MS",
      200,
      10_000
    ),
    maxEntriesPerScan: positiveInt(
      env,
      "MEMORY_CODEX_TRANSCRIPT_MAX_ENTRIES_PER_SCAN",
      4_000,
      100_000
    ),
    maxFilesPerScan: positiveInt(
      env,
      "MEMORY_CODEX_TRANSCRIPT_MAX_FILES_PER_SCAN",
      200,
      5_000
    ),
    maxBytesPerBatch: positiveInt(
      env,
      "MEMORY_CODEX_TRANSCRIPT_MAX_BYTES_PER_BATCH",
      1_048_576,
      16_777_216
    )
  };
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const hashFilePrefixSentinels = async (
  transcriptPath: string,
  offset: number
): Promise<string> => {
  if (offset === 0) return EMPTY_SHA256;
  const digest = createHash("sha256");
  const firstLength = Math.min(offset, PREFIX_SENTINEL_BYTES);
  const first = createReadStream(transcriptPath, {
    start: 0,
    end: firstLength - 1,
    highWaterMark: 64 * 1024
  });
  for await (const chunk of first) digest.update(chunk as Buffer);
  if (offset > PREFIX_SENTINEL_BYTES) {
    const last = createReadStream(transcriptPath, {
      start: Math.max(PREFIX_SENTINEL_BYTES, offset - PREFIX_SENTINEL_BYTES),
      end: offset - 1,
      highWaterMark: 64 * 1024
    });
    for await (const chunk of last) digest.update(chunk as Buffer);
  }
  digest.update(`:${offset}`);
  return digest.digest("hex");
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
      if (scanned > maxRecordBytes)
        throw new Error("transcript_record_too_large");
    }
    return 0;
  } finally {
    fs.closeSync(descriptor);
  }
};

const watcherStatePath = (config: CodexTranscriptWatcherConfig): string =>
  path.join(config.koedHome, "state", "codex-transcript-watcher.json");

type ResolverProgress = {
  fileKey: string;
  heldOffset: number;
  heldLine: number;
  scanOffset: number;
  scanLine: number;
  assistantMessagePreference?: "response_item";
};

type WatcherActivationState = {
  activatedAt: number | null;
  baselineFileFrontiers: Map<string, number | null>;
  resolverProgress: Map<string, ResolverProgress>;
};

const readActivationState = (
  config: CodexTranscriptWatcherConfig
): WatcherActivationState => {
  try {
    const parsed = JSON.parse(
      readFileSync(watcherStatePath(config), "utf8")
    ) as {
      version?: number;
      activatedAt?: string;
      activatedAtMs?: number;
      baselineFileKeys?: unknown;
      baselineFileFrontiers?: unknown;
      resolverProgress?: unknown;
    };
    if (
      parsed.version !== 1 &&
      parsed.version !== 2 &&
      parsed.version !== WATCHER_VERSION
    ) {
      return {
        activatedAt: null,
        baselineFileFrontiers: new Map(),
        resolverProgress: new Map()
      };
    }
    const frontiers = new Map<string, number | null>();
    if (
      parsed.baselineFileFrontiers &&
      typeof parsed.baselineFileFrontiers === "object"
    ) {
      for (const [fileKey, frontier] of Object.entries(
        parsed.baselineFileFrontiers
      )) {
        if (frontier === null) {
          frontiers.set(fileKey, null);
        } else if (
          typeof frontier === "number" &&
          Number.isSafeInteger(frontier) &&
          frontier >= 0
        ) {
          frontiers.set(fileKey, frontier);
        }
      }
    } else if (Array.isArray(parsed.baselineFileKeys)) {
      for (const fileKey of parsed.baselineFileKeys) {
        if (typeof fileKey === "string") frontiers.set(fileKey, null);
      }
    }
    const resolverProgress = new Map<string, ResolverProgress>();
    if (
      parsed.resolverProgress &&
      typeof parsed.resolverProgress === "object" &&
      !Array.isArray(parsed.resolverProgress)
    ) {
      for (const [sourceId, rawProgress] of Object.entries(
        parsed.resolverProgress
      )) {
        if (!rawProgress || typeof rawProgress !== "object") continue;
        const progress = rawProgress as Record<string, unknown>;
        const numericValues = [
          progress.heldOffset,
          progress.heldLine,
          progress.scanOffset,
          progress.scanLine
        ];
        if (
          typeof progress.fileKey !== "string" ||
          numericValues.some(
            (value) => !Number.isSafeInteger(value) || Number(value) < 0
          ) ||
          Number(progress.scanOffset) < Number(progress.heldOffset) ||
          Number(progress.scanLine) < Number(progress.heldLine) ||
          (progress.assistantMessagePreference !== undefined &&
            progress.assistantMessagePreference !== "response_item")
        )
          continue;
        resolverProgress.set(sourceId, {
          fileKey: progress.fileKey,
          heldOffset: Number(progress.heldOffset),
          heldLine: Number(progress.heldLine),
          scanOffset: Number(progress.scanOffset),
          scanLine: Number(progress.scanLine),
          ...(progress.assistantMessagePreference === "response_item"
            ? { assistantMessagePreference: "response_item" }
            : {})
        });
      }
    }
    const activatedAt =
      parsed.activatedAtMs ?? Date.parse(parsed.activatedAt ?? "");
    return {
      activatedAt: Number.isFinite(activatedAt) ? activatedAt : null,
      baselineFileFrontiers: frontiers,
      resolverProgress
    };
  } catch {
    return {
      activatedAt: null,
      baselineFileFrontiers: new Map(),
      resolverProgress: new Map()
    };
  }
};

const persistActivationState = (
  config: CodexTranscriptWatcherConfig,
  state: WatcherActivationState
): void => {
  const statePath = watcherStatePath(config);
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({
      version: WATCHER_VERSION,
      ...(state.activatedAt === null
        ? {}
        : {
            activatedAt: new Date(state.activatedAt).toISOString(),
            activatedAtMs: state.activatedAt
          }),
      baselineFileFrontiers: Object.fromEntries(state.baselineFileFrontiers),
      resolverProgress: Object.fromEntries(state.resolverProgress)
    })}\n`,
    { mode: 0o600 }
  );
  renameSync(temporary, statePath);
};

const activate = (
  config: CodexTranscriptWatcherConfig,
  baselineFileFrontiers: Map<string, number | null>
): number => {
  const activatedAt = performance.timeOrigin + performance.now();
  persistActivationState(config, {
    activatedAt,
    baselineFileFrontiers,
    resolverProgress: new Map()
  });
  return activatedAt;
};

class BoundedTranscriptDiscovery {
  private directories: string[] = [];
  private current?: { path: string; handle: Dir };

  constructor(private readonly config: CodexTranscriptWatcherConfig) {}

  async scan(): Promise<{ files: string[]; cycleComplete: boolean }> {
    if (!this.current && this.directories.length === 0) {
      this.directories.push(...this.config.roots);
    }
    const files: string[] = [];
    let entries = 0;
    while (
      entries < this.config.maxEntriesPerScan &&
      files.length < this.config.maxFilesPerScan
    ) {
      if (!this.current && !(await this.openNextDirectory())) break;
      let child;
      try {
        child = await this.current!.handle.read();
      } catch {
        await this.closeCurrent();
        continue;
      }
      if (!child) {
        await this.closeCurrent();
        continue;
      }
      entries += 1;
      if (child.isSymbolicLink()) continue;
      const childPath = path.join(this.current!.path, child.name);
      if (child.isDirectory()) this.directories.push(childPath);
      else if (child.isFile() && TRANSCRIPT_PATTERN.test(child.name)) {
        files.push(childPath);
      }
    }
    return {
      files,
      cycleComplete: !this.current && this.directories.length === 0
    };
  }

  async close(): Promise<void> {
    await this.closeCurrent();
  }

  private async openNextDirectory(): Promise<boolean> {
    while (this.directories.length > 0) {
      const directory = this.directories.shift()!;
      try {
        this.current = { path: directory, handle: await opendir(directory) };
        return true;
      } catch {
        // Missing/inaccessible supported roots are retried next full cycle.
      }
    }
    return false;
  }

  private async closeCurrent(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (current) await current.handle.close().catch(() => undefined);
  }
}

export const discoverCodexTranscripts = async (
  config: CodexTranscriptWatcherConfig
): Promise<string[]> => {
  const discovery = new BoundedTranscriptDiscovery(config);
  try {
    return (await discovery.scan()).files;
  } finally {
    await discovery.close();
  }
};

const responseValue = <T>(
  response: Record<string, unknown>,
  key: string
): T => {
  const value = response[key];
  if (!value || typeof value !== "object") {
    throw new Error(`watcher_api_response_missing_${key}`);
  }
  return value as T;
};

const sourceIdentity = (
  transcriptPath: string,
  boundary: number,
  maxBytes: number
): { sessionId: string; context: TranscriptContext } | null => {
  if (boundary === 0) return null;
  const state: CodexTranscriptCheckpointState = { seen: {}, rawSeen: {} };
  const parsed = parseTranscriptFileRecords({
    transcriptPath,
    state,
    stateScope: "watcher-identity",
    maxBytes,
    readThroughOffset: boundary,
    strictJsonLines: true,
    strictMaxBytes: true
  });
  const context = extractTranscriptSessionMetadata(parsed.records);
  return context.transcriptSessionId
    ? { sessionId: context.transcriptSessionId, context }
    : null;
};

const projectFromContext = (
  context: TranscriptContext
): Record<string, unknown> => {
  const cwd = context.transcriptMetadata.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) return {};
  return {
    name: path.basename(cwd),
    path: cwd,
    cwd,
    fingerprint: sha256(`codex-project:${cwd}`)
  };
};

const sourceProjectId = (
  source: HistoricalSource,
  context: TranscriptContext
): string | undefined => {
  for (const value of [
    source.detectedProject.projectId,
    source.detectedProject.path,
    source.detectedProject.cwd,
    context.transcriptMetadata.cwd
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

const captureAllowed = async (
  client: CodexTranscriptWatcherClient,
  source: HistoricalSource,
  context: TranscriptContext,
  sessionId?: string
): Promise<boolean> => {
  const response = await client.effectiveCapturePolicy({
    projectId: sourceProjectId(source, context),
    threadId: source.sourceSessionId,
    sessionId
  });
  const policy = response.policy as
    | { captureState?: string; visibility?: string; paused?: boolean }
    | undefined;
  return (
    policy?.captureState === "enabled" &&
    policy.visibility === "personal" &&
    policy.paused !== true
  );
};

const lookupSource = async (
  client: CodexTranscriptWatcherClient,
  sourceSessionId: string
): Promise<HistoricalSource | null> => {
  try {
    const response = await client.lookupHistoricalImportSource({
      aiClient: "codex",
      sourceKind: "codex",
      sourceSessionId
    });
    return responseValue<HistoricalSource>(response, "source");
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
};

class CodexTranscriptWatcher implements CodexTranscriptWatcherHandle {
  private readonly config: CodexTranscriptWatcherConfig;
  private readonly client: CodexTranscriptWatcherClient;
  private activatedAt: number | null;
  private readonly baselineFileFrontiers: Map<string, number | null>;
  private readonly resolverProgress: Map<string, ResolverProgress>;
  private readonly discovery: BoundedTranscriptDiscovery;
  private readonly watchers: FSWatcher[] = [];
  private readonly processing = new Set<string>();
  private readonly identities = new Map<
    string,
    { sessionId: string; context: TranscriptContext; fileKey: string }
  >();
  private readonly parserStates = new Map<
    string,
    { transcriptPath: string; state: CodexTranscriptCheckpointState }
  >();
  private readonly sourcePaths = new Map<
    string,
    {
      transcriptPath: string;
      fileKey: string;
      size: number;
      modifiedAt: string;
      liveCursorOffset: number;
    }
  >();
  private readonly metrics: WatcherSnapshot;
  private runId?: string;
  private failureCount = 0;
  private scanPromise: Promise<void> | null = null;
  private scanRequested = false;
  private debounceTimer?: NodeJS.Timeout;
  private rescanTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    client: CodexTranscriptWatcherClient,
    config: CodexTranscriptWatcherConfig
  ) {
    this.client = client;
    this.config = config;
    const activationState = readActivationState(config);
    this.activatedAt = activationState.activatedAt;
    this.baselineFileFrontiers = activationState.baselineFileFrontiers;
    this.resolverProgress = activationState.resolverProgress;
    this.discovery = new BoundedTranscriptDiscovery(config);
    this.metrics = {
      state: "starting",
      startedAt: new Date().toISOString(),
      lastScanAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      scans: 0,
      filesDiscovered: 0,
      sourcesRegistered: 0,
      batchesIngested: 0,
      recordsIngested: 0,
      bytesAdvanced: 0
    };
  }

  start(): void {
    this.installFilesystemHints();
    this.rescanTimer = setInterval(
      () => this.wake(),
      this.config.rescanIntervalMs
    );
    this.rescanTimer.unref();
    if (this.activatedAt !== null) this.metrics.state = "running";
    this.wake();
  }

  snapshot(): WatcherSnapshot {
    return { ...this.metrics };
  }

  wake(): void {
    if (this.stopped) return;
    this.scanRequested = true;
    if (this.scanPromise || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.scanNow();
    }, this.config.debounceMs);
    this.debounceTimer.unref();
  }

  async scanNow(): Promise<void> {
    if (this.stopped) return;
    if (this.scanPromise) return this.scanPromise;
    this.scanRequested = false;
    this.scanPromise = this.runScan().finally(() => {
      this.scanPromise = null;
      if (this.scanRequested) this.wake();
    });
    return this.scanPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    for (const watcher of this.watchers) watcher.close();
    await this.scanPromise;
    await this.discovery.close();
    this.metrics.state = "stopped";
    this.writeStatus();
  }

  private installFilesystemHints(): void {
    const watched = [
      ...this.config.roots,
      path.join(this.config.koedHome, "run")
    ];
    for (const root of watched) {
      if (!existsSync(root)) continue;
      try {
        this.watchers.push(watch(root, { recursive: true }, () => this.wake()));
      } catch {
        try {
          this.watchers.push(watch(root, () => this.wake()));
        } catch {
          // Periodic rescan recovers unsupported or unavailable notifications.
        }
      }
    }
  }

  private async runScan(): Promise<void> {
    this.metrics.scans += 1;
    this.metrics.lastScanAt = new Date().toISOString();
    const failuresBefore = this.failureCount;
    try {
      await this.client.accessCheck();
      const discovery = await this.discovery.scan();
      this.metrics.filesDiscovered += discovery.files.length;
      for (const transcriptPath of discovery.files) {
        if (this.stopped) break;
        await this.processPathOnce(transcriptPath);
      }
      if (this.activatedAt === null && discovery.cycleComplete) {
        this.activatedAt = activate(this.config, this.baselineFileFrontiers);
        this.metrics.state = "running";
      }
      if (this.failureCount === failuresBefore) {
        this.metrics.lastSuccessAt = new Date().toISOString();
        this.metrics.lastErrorCode = null;
      }
    } catch (error) {
      this.recordFailure(error);
    } finally {
      this.writeStatus();
    }
  }

  private async processPathOnce(transcriptPath: string): Promise<void> {
    if (this.processing.has(transcriptPath)) return;
    this.processing.add(transcriptPath);
    try {
      await this.processTranscript(transcriptPath);
    } catch (error) {
      this.recordFailure(error);
    } finally {
      this.processing.delete(transcriptPath);
    }
  }

  private async processTranscript(transcriptPath: string): Promise<void> {
    const linkState = await lstat(transcriptPath);
    if (linkState.isSymbolicLink() || !linkState.isFile()) return;
    const before = await stat(transcriptPath);
    if (!before.isFile()) return;
    const fileKey = `${before.dev}:${before.ino}`;
    this.rememberBaselineFile(fileKey);
    if (this.sourcePathUnchanged(transcriptPath, before)) return;
    const boundary = completeTranscriptBoundary(
      transcriptPath,
      this.config.maxBytesPerBatch
    );
    this.rememberBaselineFile(fileKey, boundary);
    const cachedIdentity = this.identities.get(transcriptPath);
    const parsedIdentity =
      cachedIdentity?.fileKey === fileKey
        ? cachedIdentity
        : sourceIdentity(
            transcriptPath,
            boundary,
            this.config.maxBytesPerBatch
          );
    if (!parsedIdentity) return;
    const identity = {
      sessionId: parsedIdentity.sessionId,
      context: parsedIdentity.context
    };
    this.rememberIdentity(transcriptPath, { ...identity, fileKey });
    let source = await lookupSource(this.client, identity.sessionId);
    if (source) {
      const resolver = this.resolverProgress.get(source.id);
      if (resolver && resolver.fileKey !== fileKey) {
        this.clearResolver(source.id);
      } else if (resolver && resolver.scanOffset > boundary) {
        this.clearResolver(source.id);
        throw new Error("transcript_truncated");
      }
      if (
        source.sourceSizeBytes !== null &&
        before.size < source.sourceSizeBytes
      ) {
        this.clearResolver(source.id);
        throw new Error("transcript_truncated");
      }
      const priorObservation = this.sourcePaths.get(source.id);
      const firstPathObservation =
        priorObservation?.transcriptPath !== transcriptPath;
      const sourceChanged =
        source.sourceSizeBytes !== before.size ||
        priorObservation?.size !== before.size ||
        priorObservation?.modifiedAt !== before.mtime.toISOString();
      if (firstPathObservation || sourceChanged) {
        try {
          await this.verifyCursorSentinels(source, transcriptPath, before.size);
        } catch (error) {
          this.clearResolver(source.id);
          throw error;
        }
      }
      if (firstPathObservation) {
        source = await this.refreshSourcePath(source, transcriptPath, before);
      }
    } else {
      source = await this.registerSource(
        transcriptPath,
        before,
        boundary,
        fileKey,
        identity
      );
    }
    this.rememberSourcePath(source, transcriptPath, before);
    const resolver = this.resolverProgress.get(source.id);
    if (resolver && resolver.fileKey !== fileKey) this.clearResolver(source.id);
    if (boundary <= source.liveCursorOffset) return;
    try {
      await this.ingestPage(source, transcriptPath, identity.context, boundary);
    } catch (error) {
      this.clearResolver(source.id);
      this.parserStates.delete(source.id);
      throw error;
    }
  }

  private sourcePathUnchanged(transcriptPath: string, file: Stats): boolean {
    return [...this.sourcePaths.values()].some(
      (observation) =>
        observation.transcriptPath === transcriptPath &&
        observation.fileKey === `${file.dev}:${file.ino}` &&
        observation.size === file.size &&
        observation.modifiedAt === file.mtime.toISOString() &&
        observation.liveCursorOffset >= file.size
    );
  }

  private rememberBaselineFile(fileKey: string, boundary?: number): void {
    if (this.activatedAt !== null) return;
    const frontier = boundary ?? null;
    if (this.baselineFileFrontiers.get(fileKey) === frontier) return;
    this.baselineFileFrontiers.set(fileKey, frontier);
    this.persistWatcherState();
  }

  private rememberIdentity(
    transcriptPath: string,
    identity: { sessionId: string; context: TranscriptContext; fileKey: string }
  ): void {
    this.identities.delete(transcriptPath);
    this.identities.set(transcriptPath, identity);
    const maximum = Math.max(this.config.maxFilesPerScan * 10, 100);
    while (this.identities.size > maximum) {
      const oldest = this.identities.keys().next().value;
      if (typeof oldest !== "string") break;
      this.identities.delete(oldest);
    }
  }

  private rememberSourcePath(
    source: HistoricalSource,
    transcriptPath: string,
    file: Stats
  ): void {
    this.sourcePaths.delete(source.id);
    this.sourcePaths.set(source.id, {
      transcriptPath,
      fileKey: `${file.dev}:${file.ino}`,
      size: file.size,
      modifiedAt: file.mtime.toISOString(),
      liveCursorOffset: source.liveCursorOffset
    });
    const maximum = Math.max(this.config.maxFilesPerScan * 10, 100);
    while (this.sourcePaths.size > maximum) {
      const oldest = this.sourcePaths.keys().next().value;
      if (typeof oldest !== "string") break;
      this.sourcePaths.delete(oldest);
      this.parserStates.delete(oldest);
    }
  }

  private persistWatcherState(): void {
    persistActivationState(this.config, {
      activatedAt: this.activatedAt,
      baselineFileFrontiers: this.baselineFileFrontiers,
      resolverProgress: this.resolverProgress
    });
  }

  private clearResolver(sourceId: string): void {
    if (!this.resolverProgress.delete(sourceId)) return;
    this.persistWatcherState();
  }

  private async ensureRunId(): Promise<string> {
    if (this.runId) return this.runId;
    const response = await this.client.createHistoricalImportRun();
    this.runId = responseValue<{ id: string }>(response, "run").id;
    return this.runId;
  }

  private async registerSource(
    transcriptPath: string,
    file: Stats,
    boundary: number,
    fileKey: string,
    identity: { sessionId: string; context: TranscriptContext }
  ): Promise<HistoricalSource> {
    const baselineFrontier = this.baselineFileFrontiers.get(fileKey);
    const frontier =
      this.activatedAt === null
        ? boundary
        : baselineFrontier === undefined
          ? 0
          : (baselineFrontier ?? boundary);
    const prefixHash = await hashFilePrefixSentinels(transcriptPath, frontier);
    const response = await this.client.createHistoricalImportSource({
      runId: await this.ensureRunId(),
      aiClient: "codex",
      sourceKind: "codex",
      sourceSessionId: identity.sessionId,
      sourceFingerprint: sha256(`codex-transcript-v1:${identity.sessionId}`),
      registrationFrontierOffset: frontier,
      registrationPrefixHash: prefixHash,
      localSourcePath: transcriptPath,
      sourceSizeBytes: file.size,
      sourceModifiedAt: file.mtime.toISOString(),
      detectedProject: projectFromContext(identity.context)
    });
    this.metrics.sourcesRegistered += 1;
    this.baselineFileFrontiers.delete(fileKey);
    this.persistWatcherState();
    return responseValue<HistoricalSource>(response, "source");
  }

  private async refreshSourcePath(
    source: HistoricalSource,
    transcriptPath: string,
    file: Stats
  ): Promise<HistoricalSource> {
    const response = await this.client.observeHistoricalImportSource(
      source.id,
      {
        localSourcePath: transcriptPath,
        sourceSizeBytes: file.size,
        sourceModifiedAt: file.mtime.toISOString()
      }
    );
    return responseValue<HistoricalSource>(response, "source");
  }

  private async verifyCursorSentinels(
    source: HistoricalSource,
    transcriptPath: string,
    size: number
  ): Promise<void> {
    if (
      size < source.liveCursorOffset ||
      (source.sourceSizeBytes !== null && size < source.sourceSizeBytes)
    ) {
      throw new Error("transcript_truncated");
    }
    if (source.liveCursorOffset === 0) {
      if (source.liveCursorHash !== null)
        throw new Error("cursor_hash_invalid");
      return;
    }
    const prefixHash = await hashFilePrefixSentinels(
      transcriptPath,
      source.liveCursorOffset
    );
    if (prefixHash !== source.liveCursorHash) {
      throw new Error("transcript_prefix_mutated");
    }
  }

  private applyParserCheckpoint(
    state: CodexTranscriptCheckpointState,
    checkpoint: NonNullable<
      ReturnType<typeof parseTranscriptFileRecords>["checkpoint"]
    >
  ): void {
    state.transcriptOffsets = {
      ...(state.transcriptOffsets ?? {}),
      [checkpoint.key]: {
        offset: checkpoint.offset,
        lineCount: checkpoint.lineCount,
        size: checkpoint.size,
        ...(checkpoint.lastEventTime
          ? { lastEventTime: checkpoint.lastEventTime }
          : {}),
        ...(checkpoint.activeTurnId
          ? { activeTurnId: checkpoint.activeTurnId }
          : {}),
        ...(checkpoint.assistantMessagePreference
          ? {
              assistantMessagePreference: checkpoint.assistantMessagePreference
            }
          : {})
      }
    };
  }

  private parserStateAtCursor(
    source: HistoricalSource,
    transcriptPath: string
  ): CodexTranscriptCheckpointState | null {
    let entry = this.parserStates.get(source.id);
    if (!entry || entry.transcriptPath !== transcriptPath) {
      entry = {
        transcriptPath,
        state: { seen: {}, rawSeen: {} }
      };
      this.parserStates.set(source.id, entry);
    }
    const key = `watcher:${transcriptPath}`;
    const offset = entry.state.transcriptOffsets?.[key]?.offset ?? 0;
    if (offset === source.liveCursorOffset) return entry.state;
    if (offset > source.liveCursorOffset) {
      entry.state = { seen: {}, rawSeen: {} };
    }
    const parsed = parseTranscriptFileRecords({
      transcriptPath,
      state: entry.state,
      stateScope: "watcher",
      maxBytes: this.config.maxBytesPerBatch,
      readThroughOffset: source.liveCursorOffset,
      strictJsonLines: false,
      strictMaxBytes: true
    });
    if (!parsed.checkpoint) return null;
    this.applyParserCheckpoint(entry.state, parsed.checkpoint);
    if (parsed.checkpoint.offset < source.liveCursorOffset) {
      this.scanRequested = true;
      return null;
    }
    if (parsed.checkpoint.offset !== source.liveCursorOffset) {
      throw new Error("cursor_rehydration_conflict");
    }
    return entry.state;
  }

  private startResolver(
    source: HistoricalSource,
    fileKey: string,
    checkpoint: NonNullable<
      ReturnType<typeof parseTranscriptFileRecords>["checkpoint"]
    >
  ): void {
    this.resolverProgress.set(source.id, {
      fileKey,
      heldOffset: checkpoint.offset,
      heldLine: checkpoint.lineCount,
      scanOffset: checkpoint.offset,
      scanLine: checkpoint.lineCount
    });
    this.persistWatcherState();
  }

  private advanceResolver(
    source: HistoricalSource,
    transcriptPath: string,
    fileKey: string,
    boundary: number,
    checkpoint: NonNullable<
      ReturnType<typeof parseTranscriptFileRecords>["checkpoint"]
    >
  ): ResolverProgress | null {
    let progress = this.resolverProgress.get(source.id);
    if (
      !progress ||
      progress.fileKey !== fileKey ||
      progress.heldOffset !== checkpoint.offset
    ) {
      progress = {
        fileKey,
        heldOffset: checkpoint.offset,
        heldLine: checkpoint.lineCount,
        scanOffset: checkpoint.offset,
        scanLine: checkpoint.lineCount
      };
    }
    const key = `watcher:${transcriptPath}`;
    const resolverState: CodexTranscriptCheckpointState = {
      seen: {},
      rawSeen: {},
      transcriptOffsets: {
        [key]: {
          offset: progress.scanOffset,
          lineCount: progress.scanLine,
          size: boundary,
          ...(progress.assistantMessagePreference
            ? {
                assistantMessagePreference: progress.assistantMessagePreference
              }
            : {})
        }
      }
    };
    const parsed = parseTranscriptFileRecords({
      transcriptPath,
      state: resolverState,
      stateScope: "watcher",
      maxBytes: this.config.maxBytesPerBatch,
      readThroughOffset: boundary,
      strictJsonLines: true,
      strictMaxBytes: true
    });
    if (!parsed.checkpoint || parsed.checkpoint.offset <= progress.scanOffset) {
      return null;
    }
    const next: ResolverProgress = {
      ...progress,
      scanOffset: parsed.checkpoint.offset,
      scanLine: parsed.checkpoint.lineCount,
      ...(parsed.checkpoint.assistantMessagePreference
        ? {
            assistantMessagePreference:
              parsed.checkpoint.assistantMessagePreference
          }
        : {})
    };
    this.resolverProgress.set(source.id, next);
    this.persistWatcherState();
    return next;
  }

  private async ingestPage(
    source: HistoricalSource,
    transcriptPath: string,
    context: TranscriptContext,
    boundary: number
  ): Promise<void> {
    const state = this.parserStateAtCursor(source, transcriptPath);
    if (!state) return;
    const resolver = this.resolverProgress.get(source.id);
    if (resolver && !resolver.assistantMessagePreference) {
      const file = await stat(transcriptPath);
      this.advanceResolver(
        source,
        transcriptPath,
        `${file.dev}:${file.ino}`,
        boundary,
        {
          key: `watcher:${transcriptPath}`,
          offset: resolver.heldOffset,
          lineCount: resolver.heldLine,
          size: boundary
        }
      );
      this.scanRequested = true;
      return;
    }
    if (resolver?.assistantMessagePreference) {
      const key = `watcher:${transcriptPath}`;
      const checkpoint = state.transcriptOffsets?.[key];
      if (checkpoint) {
        checkpoint.assistantMessagePreference =
          resolver.assistantMessagePreference;
      }
    }
    const parsed = parseTranscriptFileRecords({
      transcriptPath,
      state,
      stateScope: "watcher",
      maxBytes: this.config.maxBytesPerBatch,
      readThroughOffset: boundary,
      deferPageEndingAssistantEvent: true,
      strictJsonLines: true,
      strictMaxBytes: true
    });
    if (
      parsed.checkpoint?.offset === source.liveCursorOffset &&
      boundary > source.liveCursorOffset
    ) {
      const file = await stat(transcriptPath);
      this.startResolver(source, `${file.dev}:${file.ino}`, parsed.checkpoint);
      this.scanRequested = true;
      return;
    }
    const checkpoint = parsed.checkpoint;
    if (!checkpoint || checkpoint.offset <= source.liveCursorOffset) return;
    const cursorHash = await hashFilePrefixSentinels(
      transcriptPath,
      checkpoint.offset
    );
    const session = await this.ensureSession(source, transcriptPath, context);
    const items = buildCodexTranscriptConversationItems({
      records: parsed.records,
      indexOffset: parsed.indexOffset,
      sessionId: session.id,
      sourceSessionId: source.sourceSessionId,
      sourceTransport: "transcript",
      localSourcePath: transcriptPath,
      sourceFingerprint: source.sourceFingerprint,
      threadKind: context.threadKind,
      parentThreadId: context.parentThreadId
    });
    const persisted = await this.persistBatches(
      source,
      context,
      session.id,
      items
    );
    await this.projectItems(persisted);
    await this.verifyCursorSentinels(source, transcriptPath, checkpoint.size);
    const currentCursorHash = await hashFilePrefixSentinels(
      transcriptPath,
      checkpoint.offset
    );
    if (currentCursorHash !== cursorHash) {
      throw new Error("transcript_mutated_during_batch");
    }
    const current = await stat(transcriptPath);
    if (
      current.size < checkpoint.offset ||
      current.size < boundary ||
      (source.sourceSizeBytes !== null && current.size < source.sourceSizeBytes)
    ) {
      throw new Error("transcript_truncated");
    }
    const priorCursorOffset = source.liveCursorOffset;
    await this.client.advanceLiveTranscriptCursor(source.id, {
      expectedCursorOffset: source.liveCursorOffset,
      expectedCursorHash: source.liveCursorHash,
      cursorOffset: checkpoint.offset,
      cursorLine: checkpoint.lineCount,
      cursorHash,
      sourceSizeBytes: current.size
    });
    source.liveCursorOffset = checkpoint.offset;
    source.sourceSizeBytes = current.size;
    const completedResolver = this.resolverProgress.get(source.id);
    if (completedResolver && checkpoint.offset > completedResolver.heldOffset) {
      this.clearResolver(source.id);
    }
    this.rememberSourcePath(source, transcriptPath, current);
    this.applyParserCheckpoint(state, checkpoint);
    this.metrics.batchesIngested += 1;
    this.metrics.recordsIngested += parsed.records.length;
    this.metrics.bytesAdvanced += checkpoint.offset - priorCursorOffset;
    if (checkpoint.offset < boundary) this.scanRequested = true;
  }

  private async ensureSession(
    source: HistoricalSource,
    transcriptPath: string,
    context: TranscriptContext
  ): Promise<{ id: string }> {
    if (!(await captureAllowed(this.client, source, context))) {
      throw new Error("capture_policy_blocked");
    }
    const cwd = sourceProjectId(source, context);
    const response = await this.client.createSession({
      externalSessionId: source.sourceSessionId,
      sourceRuntime: "codex-cli",
      captureMethod: "api",
      cwd,
      codexTranscriptPath: transcriptPath,
      idempotencyKey: sha256(`watcher-session:${source.sourceSessionId}`),
      metadata: {
        ...context.transcriptMetadata,
        sourceTransport: "transcript",
        sourceAdapterVersion: "codex-transcript-v1",
        observedViaTranscript: true
      }
    });
    if (response.skipped || !response.session) {
      throw new Error("capture_policy_blocked");
    }
    return response.session;
  }

  private async persistBatches(
    source: HistoricalSource,
    context: TranscriptContext,
    sessionId: string,
    items: RawConversationItemRequest[]
  ): Promise<Array<{ id?: string }>> {
    const persisted: Array<{ id?: string }> = [];
    for (const batch of rawConversationItemBatches(items)) {
      if (!(await captureAllowed(this.client, source, context, sessionId))) {
        throw new Error("capture_policy_blocked");
      }
      const response = await this.client.createConversationItems({
        items: batch
      });
      const accepted = response.items;
      if (Array.isArray(accepted))
        persisted.push(...(accepted as Array<{ id?: string }>));
    }
    return persisted;
  }

  private async projectItems(items: Array<{ id?: string }>): Promise<void> {
    const ids = items
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    for (let index = 0; index < ids.length; index += 1_000) {
      const conversationItemIds = ids.slice(index, index + 1_000);
      await this.client.projectConversationItems({
        conversationItemIds,
        limit: conversationItemIds.length
      });
    }
  }

  private recordFailure(error: unknown): void {
    this.failureCount += 1;
    const code = watcherErrorCode(error);
    this.metrics.lastFailureAt = new Date().toISOString();
    this.metrics.lastErrorCode = code;
    logger.warn({ code }, "Codex Transcript Watcher pass failed");
  }

  private writeStatus(): void {
    const statusPath = path.join(
      this.config.koedHome,
      "status",
      "codex-transcript-watcher.json"
    );
    try {
      mkdirSync(path.dirname(statusPath), { recursive: true, mode: 0o700 });
      const temporary = `${statusPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.metrics)}\n`, {
        mode: 0o600
      });
      renameSync(temporary, statusPath);
    } catch {
      // Status is diagnostic-only and never controls capture correctness.
    }
  }
}

const watcherErrorCode = (error: unknown): string => {
  if (error instanceof MemoryApiError) {
    if (error.status === 409 && /policy/i.test(error.message)) {
      return "capture_policy_blocked";
    }
    return error.status
      ? `memory_api_${error.status}`
      : "memory_api_unavailable";
  }
  if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  if (
    error instanceof Error &&
    /malformed complete JSONL record/.test(error.message)
  ) {
    return "transcript_malformed_record";
  }
  return "watcher_pass_failed";
};

export const startCodexTranscriptWatcher = (
  client: CodexTranscriptWatcherClient = new MemoryApiClient(defaultConfig()),
  config = resolveCodexTranscriptWatcherConfig()
): CodexTranscriptWatcherHandle => {
  const watcher = new CodexTranscriptWatcher(client, config);
  watcher.start();
  return watcher;
};
