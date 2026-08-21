import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
  type Dirent,
  type FSWatcher,
  type Stats
} from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { MemoryApiClient, MemoryApiError, defaultConfig } from "./index.js";
import {
  completeTranscriptBoundary,
  countTranscriptLines,
  ingestCodexTranscriptJournal,
  type CodexTranscriptJournalClient,
  type ConversationSourceArtifact
} from "./codex-transcript-journal.js";
import { logger } from "./logger.js";
import {
  extractTranscriptSessionMetadata,
  parseTranscriptJournalBytes,
  type TranscriptContext
} from "./codex-transcript-parser.js";
import {
  acknowledgeCodexTranscriptTurnBoundary,
  readCodexTranscriptTurnBoundary,
  watcherWakePath
} from "./codex-transcript-watcher-signal.js";
import { readProjectMetadataForRoot } from "./project-team-workspace-links.js";
import type { CodexHistoricalCandidate } from "./codex-historical-ingestion.js";

export {
  signalCodexTranscriptWatcher,
  watcherWakePath
} from "./codex-transcript-watcher-signal.js";
export { completeTranscriptBoundary } from "./codex-transcript-journal.js";

const WATCHER_VERSION = 5;
const TRANSCRIPT_PATTERN = /^rollout-.*\.jsonl$/;

export interface CodexTranscriptWatcherConfig {
  roots: string[];
  koedHome: string;
  debounceMs: number;
  pollMs: number;
  turnBoundarySettleMs: number;
  maxEntriesPerScan: number;
  maxFilesPerScan: number;
  maxBytesPerBatch: number;
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

export type CodexTranscriptWatcherClient = CodexTranscriptJournalClient;

export interface CodexTranscriptWatcherHandle {
  scanNow(): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  snapshot(): WatcherSnapshot;
}

export interface CodexHistoricalCandidateObserver {
  offerCandidates(candidates: readonly CodexHistoricalCandidate[]): void;
  selectionFor(
    sourceSessionId: string
  ): { frontierOffset: number; frontierLine: number } | undefined;
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

const containsPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

const environmentHome = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    (process.platform === "win32" ? (env.USERPROFILE ?? env.HOME) : env.HOME) ??
      os.homedir()
  );

const configuredTranscriptRoot = (
  value: string,
  home: string,
  setting = "MEMORY_CODEX_TRANSCRIPT_ROOTS"
): string => {
  if (!path.isAbsolute(value)) {
    throw new Error(`${setting} entries must be absolute`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || containsPath(resolved, home)) {
    throw new Error(`${setting} entry is too broad`);
  }
  return resolved;
};

export const resolveCodexTranscriptWatcherConfig = (
  env: NodeJS.ProcessEnv = process.env
): CodexTranscriptWatcherConfig => {
  const home = environmentHome(env);
  const configuredCodexHome = env.CODEX_HOME?.trim();
  const codexHome = configuredCodexHome
    ? configuredTranscriptRoot(configuredCodexHome, home, "CODEX_HOME")
    : path.join(home, ".codex");
  const configuredRoots = env.MEMORY_CODEX_TRANSCRIPT_ROOTS?.split(
    path.delimiter
  )
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => configuredTranscriptRoot(value, home));
  return {
    roots: uniqueAbsoluteRoots(
      configuredRoots?.length
        ? configuredRoots
        : [
            path.join(codexHome, "sessions"),
            path.join(codexHome, "archived_sessions")
          ]
    ),
    koedHome: path.resolve(env.KOED_HOME ?? path.join(home, ".koed")),
    debounceMs: positiveInt(
      env,
      "MEMORY_CODEX_TRANSCRIPT_DEBOUNCE_MS",
      200,
      10_000
    ),
    pollMs: positiveInt(env, "MEMORY_CODEX_TRANSCRIPT_POLL_MS", 1_000, 60_000),
    turnBoundarySettleMs: positiveInt(
      env,
      "MEMORY_CODEX_TRANSCRIPT_TURN_SETTLE_MS",
      500,
      5_000
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

const watcherStatePath = (config: CodexTranscriptWatcherConfig): string =>
  path.join(config.koedHome, "state", "codex-transcript-watcher.json");

type WatcherActivationState = {
  activatedAt: number | null;
  baselineFileFrontiers: Map<string, number | null>;
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
      baselineFileFrontiers?: unknown;
    };
    if (parsed.version !== WATCHER_VERSION) {
      return {
        activatedAt: null,
        baselineFileFrontiers: new Map()
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
    }
    const activatedAt =
      parsed.activatedAtMs ?? Date.parse(parsed.activatedAt ?? "");
    return {
      activatedAt: Number.isFinite(activatedAt) ? activatedAt : null,
      baselineFileFrontiers: frontiers
    };
  } catch {
    return {
      activatedAt: null,
      baselineFileFrontiers: new Map()
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
      baselineFileFrontiers: Object.fromEntries(state.baselineFileFrontiers)
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
    baselineFileFrontiers
  });
  return activatedAt;
};

class BoundedTranscriptDiscovery {
  private directories: string[] = [];
  private current?: { path: string; entries: Dirent[]; index: number };

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
      const child = this.current!.entries[this.current!.index++];
      if (!child) {
        this.current = undefined;
        continue;
      }
      entries += 1;
      if (child.isSymbolicLink()) continue;
      const childPath = path.join(this.current!.path, child.name);
      if (child.isDirectory()) {
        this.directories.push(childPath);
        this.directories.sort((left, right) => right.localeCompare(left));
      } else if (child.isFile() && TRANSCRIPT_PATTERN.test(child.name)) {
        files.push(childPath);
      }
    }
    return {
      files,
      cycleComplete: !this.current && this.directories.length === 0
    };
  }

  close(): void {
    this.current = undefined;
  }

  private async openNextDirectory(): Promise<boolean> {
    while (this.directories.length > 0) {
      const directory = this.directories.shift()!;
      try {
        const details = await lstat(directory);
        if (details.isSymbolicLink() || !details.isDirectory()) continue;
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => right.name.localeCompare(left.name));
        this.current = { path: directory, entries, index: 0 };
        return true;
      } catch {
        // Missing/inaccessible supported roots are retried next full cycle.
      }
    }
    return false;
  }
}

export const discoverCodexTranscripts = async (
  config: CodexTranscriptWatcherConfig
): Promise<string[]> => {
  const discovery = new BoundedTranscriptDiscovery(config);
  try {
    return (await discovery.scan()).files;
  } finally {
    discovery.close();
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
  const requestedBytes = Math.min(boundary, maxBytes);
  const buffer = Buffer.allocUnsafe(requestedBytes);
  const descriptor = openSync(transcriptPath, "r");
  try {
    const bytesRead = readSync(descriptor, buffer, 0, requestedBytes, 0);
    if (bytesRead !== requestedBytes) {
      throw new Error("transcript_source_short_read");
    }
  } finally {
    closeSync(descriptor);
  }
  const completeBytes =
    requestedBytes === boundary
      ? buffer
      : buffer.subarray(0, buffer.lastIndexOf(0x0a) + 1);
  if (completeBytes.byteLength === 0) {
    throw new Error("transcript_identity_record_exceeds_max_bytes");
  }
  const parsed = parseTranscriptJournalBytes({
    bytes: completeBytes,
    absoluteStartOffset: 0,
    lineIndexOffset: 0
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

const sourceProjectId = (context: TranscriptContext): string | undefined => {
  const project = projectFromContext(context);
  for (const value of [
    project.projectId,
    project.path,
    project.cwd,
    context.transcriptMetadata.cwd
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

const sourceStartedAfterActivation = (
  context: TranscriptContext,
  activatedAt: number
): boolean => {
  const timestamp = context.transcriptMetadata.timestamp;
  if (typeof timestamp !== "string") {
    throw new Error("transcript_source_created_at_missing");
  }
  const sourceStartedAt = Date.parse(timestamp);
  if (!Number.isFinite(sourceStartedAt)) {
    throw new Error("transcript_source_created_at_missing");
  }
  return sourceStartedAt > activatedAt;
};

const recordTimestamp = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const container of [record, record.payload, record.item]) {
    if (
      !container ||
      typeof container !== "object" ||
      Array.isArray(container)
    ) {
      continue;
    }
    for (const key of ["timestamp", "time", "created_at", "createdAt"]) {
      const raw = (container as Record<string, unknown>)[key];
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      const parsed = new Date(
        typeof raw === "number" && raw < 10_000_000_000 ? raw * 1_000 : raw
      );
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
  }
  return null;
};

// Matches the max single-record size already used elsewhere for this same
// concern (see codex-transcript-journal.ts's completeTranscriptBoundary).
const MAX_TRANSCRIPT_ACTIVITY_SCAN_BYTES = 16 * 1024 * 1024;

const timestampsFromAligned = (aligned: Buffer): string[] =>
  aligned
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return recordTimestamp(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((value): value is string => value !== null);

export const latestTranscriptActivity = (
  transcriptPath: string,
  boundary: number,
  maximumBytes: number,
  context: TranscriptContext
): string | null => {
  const initial = recordTimestamp(context.transcriptMetadata);
  if (boundary === 0) return initial;
  const descriptor = openSync(transcriptPath, "r");
  try {
    let windowBytes = maximumBytes;
    for (;;) {
      const start = Math.max(0, boundary - windowBytes);
      const bytes = Buffer.allocUnsafe(boundary - start);
      const bytesRead = readSync(descriptor, bytes, 0, bytes.byteLength, start);
      if (bytesRead !== bytes.byteLength) return initial;
      if (start === 0) {
        const timestamps = timestampsFromAligned(bytes);
        if (initial) timestamps.push(initial);
        return timestamps.sort().at(-1) ?? null;
      }
      const newline = bytes.indexOf(0x0a);
      // A newline anywhere before the buffer's final byte marks a genuine
      // earlier record boundary: everything after it, through boundary, is
      // one or more complete records safe to parse. A newline only at the
      // final byte (boundary's own terminator, guaranteed present by
      // completeTranscriptBoundary) means the whole window sits inside one
      // record larger than windowBytes -- grow the window so that record's
      // own start, and its timestamp, come into view instead of silently
      // falling back to the transcript's creation timestamp.
      if (newline >= 0 && newline < bytes.byteLength - 1) {
        const timestamps = timestampsFromAligned(bytes.subarray(newline + 1));
        if (initial) timestamps.push(initial);
        return timestamps.sort().at(-1) ?? null;
      }
      if (windowBytes >= MAX_TRANSCRIPT_ACTIVITY_SCAN_BYTES) return initial;
      windowBytes = Math.min(
        windowBytes * 2,
        MAX_TRANSCRIPT_ACTIVITY_SCAN_BYTES
      );
    }
  } finally {
    closeSync(descriptor);
  }
};

const lookupArtifact = async (
  client: CodexTranscriptWatcherClient,
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

class CodexTranscriptWatcher implements CodexTranscriptWatcherHandle {
  private readonly config: CodexTranscriptWatcherConfig;
  private readonly client: CodexTranscriptWatcherClient;
  private activatedAt: number | null;
  private readonly baselineFileFrontiers: Map<string, number | null>;
  private readonly discovery: BoundedTranscriptDiscovery;
  private readonly historicalObserver?: CodexHistoricalCandidateObserver;
  private readonly historicalCandidates = new Map<
    string,
    CodexHistoricalCandidate
  >();
  private readonly watchers: FSWatcher[] = [];
  private readonly hintedTranscriptPaths = new Set<string>();
  private readonly processing = new Set<string>();
  private readonly openTurnPolls = new Map<
    string,
    {
      timer?: NodeJS.Timeout;
      delayMs: number;
      size: number;
      modifiedAt: string;
    }
  >();
  private readonly identities = new Map<
    string,
    { sessionId: string; context: TranscriptContext; fileKey: string }
  >();
  private readonly sourcePaths = new Map<
    string,
    {
      transcriptPath: string;
      fileKey: string;
      size: number;
      modifiedAt: string;
      providerCursorOffset: number;
      canonicalCursorOffset: number;
    }
  >();
  private readonly metrics: WatcherSnapshot;
  private failureCount = 0;
  private scanPromise: Promise<void> | null = null;
  private scanRequested = false;
  private periodicPollRequested = false;
  private knownSourcePollCursor = 0;
  private discoverySweepActive = false;
  private discoverySweepPending = false;
  private debounceTimer?: NodeJS.Timeout;
  private periodicTimer?: NodeJS.Timeout;
  private turnBoundarySettleTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    client: CodexTranscriptWatcherClient,
    config: CodexTranscriptWatcherConfig,
    historicalObserver?: CodexHistoricalCandidateObserver
  ) {
    this.client = client;
    this.config = config;
    this.historicalObserver = historicalObserver;
    const activationState = readActivationState(config);
    this.activatedAt = activationState.activatedAt;
    this.baselineFileFrontiers = activationState.baselineFileFrontiers;
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
    if (this.activatedAt !== null) this.metrics.state = "running";
    this.wake();
    this.periodicTimer = setInterval(() => {
      this.periodicPollRequested = true;
      this.requestScan();
    }, this.config.pollMs);
    this.periodicTimer.unref();
  }

  snapshot(): WatcherSnapshot {
    return { ...this.metrics };
  }

  wake(): void {
    if (this.stopped) return;
    this.discoverySweepPending = true;
    this.requestScan();
  }

  private requestScan(): void {
    if (this.stopped) return;
    this.scanRequested = true;
    if (this.scanPromise || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runRequestedScan();
    }, this.config.debounceMs);
    this.debounceTimer.unref();
  }

  async scanNow(): Promise<void> {
    if (this.stopped) return;
    this.discoverySweepPending = true;
    this.scanRequested = true;
    return this.runRequestedScan();
  }

  private async runRequestedScan(): Promise<void> {
    if (this.stopped) return;
    if (this.scanPromise) return this.scanPromise;
    this.scanRequested = false;
    this.scanPromise = this.runScan().finally(() => {
      this.scanPromise = null;
      if (this.scanRequested) this.requestScan();
    });
    return this.scanPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    if (this.turnBoundarySettleTimer) {
      clearTimeout(this.turnBoundarySettleTimer);
    }
    for (const poll of this.openTurnPolls.values()) {
      if (poll.timer) clearTimeout(poll.timer);
    }
    this.openTurnPolls.clear();
    for (const watcher of this.watchers) watcher.close();
    await this.scanPromise;
    this.discovery.close();
    this.metrics.state = "stopped";
    this.writeStatus();
  }

  private installFilesystemHints(): void {
    for (const root of this.config.roots) {
      if (!existsSync(root)) continue;
      try {
        this.watchers.push(
          watch(root, { recursive: true }, (_eventType, filename) => {
            if (this.rememberFilesystemHint(root, filename)) {
              this.requestScan();
            } else {
              this.wake();
            }
          })
        );
      } catch {
        try {
          this.watchers.push(watch(root, () => this.wake()));
        } catch {
          // Capture Hook wake signals remain the authoritative live-ingestion trigger.
        }
      }
    }
    const runDirectory = path.join(this.config.koedHome, "run");
    if (!existsSync(runDirectory)) return;
    const wakeFilename = path.basename(
      watcherWakePath({ KOED_HOME: this.config.koedHome })
    );
    try {
      this.watchers.push(
        watch(runDirectory, (_eventType, filename) => {
          if (filename === wakeFilename) this.wake();
        })
      );
    } catch {
      // A later supported Hook signal or process restart performs bounded catch-up.
    }
  }

  private async runScan(): Promise<void> {
    this.metrics.scans += 1;
    this.metrics.lastScanAt = new Date().toISOString();
    const failuresBefore = this.failureCount;
    try {
      const periodicPoll = this.periodicPollRequested;
      this.periodicPollRequested = false;
      await this.serviceFilesystemHints();
      await this.serviceKnownSources(
        periodicPoll ? this.config.maxFilesPerScan : undefined
      );
      if (!this.discoverySweepActive && this.discoverySweepPending) {
        this.discoverySweepPending = false;
        this.discoverySweepActive = true;
        this.historicalCandidates.clear();
      }
      let discovery = { files: [] as string[], cycleComplete: true };
      if (this.discoverySweepActive) {
        discovery = await this.discovery.scan();
      } else if (periodicPoll) {
        const newest = new BoundedTranscriptDiscovery(this.config);
        try {
          discovery = await newest.scan();
        } finally {
          newest.close();
        }
      }
      this.metrics.filesDiscovered += discovery.files.length;
      for (const transcriptPath of discovery.files) {
        if (this.stopped) break;
        await this.serviceFilesystemHints();
        await this.processPathOnce(transcriptPath, this.discoverySweepActive);
      }
      if (this.activatedAt === null) {
        if (discovery.cycleComplete) {
          this.activatedAt = activate(this.config, this.baselineFileFrontiers);
          this.metrics.state = "running";
        }
      }
      if (this.discoverySweepActive) {
        if (discovery.cycleComplete) {
          this.discoverySweepActive = false;
          this.historicalObserver?.offerCandidates([
            ...this.historicalCandidates.values()
          ]);
          if (this.discoverySweepPending) this.scanRequested = true;
        } else {
          this.scanRequested = true;
        }
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

  private rememberFilesystemHint(
    root: string,
    filename: string | Buffer | null
  ): boolean {
    if (filename === null) return false;
    const candidate = path.resolve(root, filename.toString());
    const relative = path.relative(root, candidate);
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !TRANSCRIPT_PATTERN.test(path.basename(candidate))
    ) {
      return false;
    }
    this.hintedTranscriptPaths.add(candidate);
    return true;
  }

  private async serviceFilesystemHints(): Promise<void> {
    const transcriptPaths = [...this.hintedTranscriptPaths];
    this.hintedTranscriptPaths.clear();
    for (const transcriptPath of transcriptPaths) {
      if (this.stopped || !existsSync(transcriptPath)) continue;
      await this.processPathOnce(transcriptPath);
    }
  }

  private async serviceKnownSources(limit?: number): Promise<void> {
    const available = [...this.sourcePaths.values()];
    const observations =
      limit === undefined || available.length <= limit
        ? available
        : Array.from({ length: limit }, (_, index) => {
            const position =
              (this.knownSourcePollCursor + index) % available.length;
            return available[position]!;
          });
    if (limit !== undefined && available.length > 0) {
      this.knownSourcePollCursor =
        (this.knownSourcePollCursor + observations.length) % available.length;
    }
    for (const observation of observations) {
      if (this.stopped || !existsSync(observation.transcriptPath)) continue;
      await this.serviceFilesystemHints();
      if (
        observation.canonicalCursorOffset >= observation.providerCursorOffset
      ) {
        const file = await stat(observation.transcriptPath);
        if (
          !file.isFile() ||
          (file.size === observation.size &&
            file.mtime.toISOString() === observation.modifiedAt)
        ) {
          continue;
        }
      }
      await this.processPathOnce(observation.transcriptPath);
    }
  }

  private async processPathOnce(
    transcriptPath: string,
    observeHistorical = false
  ): Promise<void> {
    if (this.processing.has(transcriptPath)) return;
    this.processing.add(transcriptPath);
    try {
      await this.processTranscript(transcriptPath, observeHistorical);
    } catch (error) {
      this.recordFailure(error);
    } finally {
      this.processing.delete(transcriptPath);
    }
  }

  private async processTranscript(
    transcriptPath: string,
    observeHistorical: boolean
  ): Promise<void> {
    const linkState = await lstat(transcriptPath);
    if (linkState.isSymbolicLink() || !linkState.isFile()) return;
    const before = await stat(transcriptPath);
    if (!before.isFile()) return;
    const fileKey = `${before.dev}:${before.ino}`;
    const baselineFrontier = this.baselineFileFrontiers.get(fileKey);
    this.rememberBaselineFile(fileKey);
    const sourceUnchanged = this.sourcePathUnchanged(transcriptPath, before);
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
    const sourceProjectPath = sourceProjectId(identity.context);
    const sourceProject = sourceProjectPath
      ? readProjectMetadataForRoot(sourceProjectPath, {
          ...process.env,
          KOED_HOME: this.config.koedHome
        })
      : null;
    if (observeHistorical) {
      const sourceStartedAt = identity.context.transcriptMetadata.timestamp;
      const sourceStartedBeforeActivation =
        this.activatedAt === null ||
        (typeof sourceStartedAt === "string" &&
          Number.isFinite(Date.parse(sourceStartedAt)) &&
          Date.parse(sourceStartedAt) <= this.activatedAt);
      const latestActivityAt = latestTranscriptActivity(
        transcriptPath,
        boundary,
        Math.max(this.config.maxBytesPerBatch, 64 * 1024),
        identity.context
      );
      if (sourceStartedBeforeActivation && latestActivityAt) {
        const frontierOffset = baselineFrontier ?? boundary;
        this.historicalCandidates.set(identity.sessionId, {
          sourceSessionId: identity.sessionId,
          transcriptPath,
          context: identity.context,
          sourceSession: this.sourceSessionRegistration(
            identity,
            sourceProjectPath,
            sourceProject
          ),
          frontierOffset,
          latestActivityAt,
          ...(sourceProject
            ? {
                projectId: sourceProject.localProjectId,
                projectName: sourceProject.displayName,
                projectFingerprint: sha256(
                  `codex-project:${sourceProject.localProjectId}`
                )
              }
            : { projectName: "Unassigned" })
        });
      }
    }
    if (
      this.activatedAt !== null &&
      baselineFrontier !== undefined &&
      boundary <= (baselineFrontier ?? 0)
    ) {
      return;
    }
    const turnBoundary = readCodexTranscriptTurnBoundary(
      { KOED_HOME: this.config.koedHome },
      {
        sourceSessionId: identity.sessionId,
        transcriptPath
      }
    );
    const confirmedTurnBoundary =
      turnBoundary !== null && turnBoundary.sourceOffset <= boundary
        ? turnBoundary
        : undefined;
    if (confirmedTurnBoundary !== undefined) {
      this.scheduleTurnBoundarySettle();
    }
    if (sourceUnchanged && confirmedTurnBoundary === undefined) {
      return;
    }
    if (this.activatedAt === null) {
      return;
    }
    const existingArtifact = await lookupArtifact(
      this.client,
      identity.sessionId
    );
    const startedAfterActivation =
      baselineFrontier === undefined &&
      this.activatedAt !== null &&
      sourceStartedAfterActivation(identity.context, this.activatedAt);
    if (
      !existingArtifact &&
      !startedAfterActivation &&
      baselineFrontier === undefined
    ) {
      this.rememberDeferredFile(fileKey, boundary);
      return;
    }
    const liveStartOffset = existingArtifact
      ? existingArtifact.liveStartOffset
      : startedAfterActivation
        ? 0
        : (baselineFrontier ?? boundary);
    const liveStartLine = existingArtifact
      ? existingArtifact.liveStartLine
      : await countTranscriptLines(transcriptPath, liveStartOffset);
    const historicalSelection = this.historicalObserver?.selectionFor(
      identity.sessionId
    );
    const historicalJournal =
      !existingArtifact &&
      historicalSelection?.frontierOffset === liveStartOffset;
    const result = await ingestCodexTranscriptJournal({
      client: this.client,
      sourceSession: this.sourceSessionRegistration(
        identity,
        sourceProjectPath,
        sourceProject
      ),
      sourceSessionId: identity.sessionId,
      transcriptPath,
      context: identity.context,
      maxBytesPerBatch: this.config.maxBytesPerBatch,
      journalStartOffset: historicalJournal ? 0 : liveStartOffset,
      journalStartLine: historicalJournal ? 0 : liveStartLine,
      liveStartOffset,
      liveStartLine,
      existingArtifact,
      ...(confirmedTurnBoundary !== undefined
        ? {
            turnBoundaryObservedAt: confirmedTurnBoundary.observedAt,
            turnBoundarySourceOffset: confirmedTurnBoundary.sourceOffset
          }
        : {})
    });
    if (confirmedTurnBoundary !== undefined && result.turnBoundaryHandled) {
      acknowledgeCodexTranscriptTurnBoundary(
        { KOED_HOME: this.config.koedHome },
        {
          sourceSessionId: identity.sessionId,
          transcriptPath
        },
        confirmedTurnBoundary.observedAt
      );
    }
    if (!existingArtifact) {
      this.metrics.sourcesRegistered += 1;
      this.baselineFileFrontiers.delete(fileKey);
      this.persistWatcherState();
    }
    this.metrics.bytesAdvanced += result.providerBytesAdvanced;
    if (result.recordsConsumed > 0) {
      this.metrics.batchesIngested += 1;
      this.metrics.recordsIngested += result.recordsConsumed;
    }
    this.updateOpenTurnPoll(transcriptPath, before, result.turnOpen);
    if (
      result.artifact.providerCursorOffset < boundary ||
      result.canonicalCursorOffset < result.artifact.providerCursorOffset
    ) {
      this.scanRequested = true;
    }
    this.rememberSourcePath(
      result.artifact,
      transcriptPath,
      before,
      result.canonicalCursorOffset
    );
  }

  private sourceSessionRegistration(
    identity: { sessionId: string; context: TranscriptContext },
    sourceProjectPath: string | undefined,
    sourceProject: ReturnType<typeof readProjectMetadataForRoot> | null
  ) {
    return {
      externalSessionId: identity.sessionId,
      sourceRuntime: "codex-cli" as const,
      captureMethod: "api" as const,
      cwd: sourceProjectPath,
      idempotencyKey: sha256(`watcher-session:${identity.sessionId}`),
      metadata: {
        ...identity.context.transcriptMetadata,
        threadKind: identity.context.threadKind,
        ...(identity.context.parentThreadId
          ? { parentThreadId: identity.context.parentThreadId }
          : {}),
        ...(identity.context.parentSessionId
          ? { parentSessionId: identity.context.parentSessionId }
          : {}),
        ...(identity.context.parentExternalSessionId
          ? {
              parentExternalSessionId: identity.context.parentExternalSessionId
            }
          : {}),
        ...(sourceProject
          ? {
              localProjectId: sourceProject.localProjectId,
              projectName: sourceProject.displayName,
              projectPath:
                sourceProject.path.projectRoot ?? sourceProject.path.cwd
            }
          : {}),
        sourceTransport: "transcript",
        sourceAdapterVersion: "codex-transcript-v1",
        observedViaTranscript: true
      },
      ...(sourceProject
        ? {
            detectedProjects: [
              {
                id: sourceProject.localProjectId,
                name: sourceProject.displayName,
                path: sourceProject.path.projectRoot ?? sourceProject.path.cwd
              }
            ]
          }
        : {})
    };
  }

  private scheduleTurnBoundarySettle(): void {
    if (this.stopped) return;
    if (this.turnBoundarySettleTimer) {
      clearTimeout(this.turnBoundarySettleTimer);
    }
    this.turnBoundarySettleTimer = setTimeout(() => {
      this.turnBoundarySettleTimer = undefined;
      this.wake();
    }, this.config.turnBoundarySettleMs);
    this.turnBoundarySettleTimer.unref();
  }

  private updateOpenTurnPoll(
    transcriptPath: string,
    file: Stats,
    turnOpen: boolean
  ): void {
    const existing = this.openTurnPolls.get(transcriptPath);
    if (!turnOpen) {
      if (existing?.timer) clearTimeout(existing.timer);
      this.openTurnPolls.delete(transcriptPath);
      return;
    }
    if (existing?.timer) clearTimeout(existing.timer);
    const modifiedAt = file.mtime.toISOString();
    const sourceChanged =
      !existing ||
      existing.size !== file.size ||
      existing.modifiedAt !== modifiedAt;
    const delayMs = sourceChanged
      ? this.config.turnBoundarySettleMs
      : Math.min(existing.delayMs * 2, 5_000);
    const poll: {
      timer?: NodeJS.Timeout;
      delayMs: number;
      size: number;
      modifiedAt: string;
    } = {
      delayMs,
      size: file.size,
      modifiedAt
    };
    const timer = setTimeout(() => {
      const current = this.openTurnPolls.get(transcriptPath);
      if (current?.timer !== timer || this.stopped) return;
      current.timer = undefined;
      this.hintedTranscriptPaths.add(transcriptPath);
      this.requestScan();
    }, delayMs);
    timer.unref();
    poll.timer = timer;
    this.openTurnPolls.set(transcriptPath, poll);
  }

  private sourcePathUnchanged(transcriptPath: string, file: Stats): boolean {
    return [...this.sourcePaths.values()].some(
      (observation) =>
        observation.transcriptPath === transcriptPath &&
        observation.fileKey === `${file.dev}:${file.ino}` &&
        observation.size === file.size &&
        observation.modifiedAt === file.mtime.toISOString() &&
        observation.providerCursorOffset >= file.size &&
        observation.canonicalCursorOffset >= observation.providerCursorOffset
    );
  }

  private rememberBaselineFile(fileKey: string, boundary?: number): void {
    if (this.activatedAt !== null) return;
    const frontier = boundary ?? null;
    if (this.baselineFileFrontiers.get(fileKey) === frontier) return;
    this.baselineFileFrontiers.set(fileKey, frontier);
    this.persistWatcherState();
  }

  private rememberDeferredFile(fileKey: string, boundary: number): void {
    if (this.baselineFileFrontiers.has(fileKey)) return;
    this.baselineFileFrontiers.set(fileKey, boundary);
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
    artifact: ConversationSourceArtifact,
    transcriptPath: string,
    file: Stats,
    canonicalCursorOffset?: number
  ): void {
    const prior = this.sourcePaths.get(artifact.id);
    this.sourcePaths.delete(artifact.id);
    this.sourcePaths.set(artifact.id, {
      transcriptPath,
      fileKey: `${file.dev}:${file.ino}`,
      size: file.size,
      modifiedAt: file.mtime.toISOString(),
      providerCursorOffset: artifact.providerCursorOffset,
      canonicalCursorOffset:
        canonicalCursorOffset ??
        prior?.canonicalCursorOffset ??
        artifact.journalStartOffset
    });
    const maximum = Math.max(this.config.maxFilesPerScan * 10, 100);
    while (this.sourcePaths.size > maximum) {
      const oldest = this.sourcePaths.keys().next().value;
      if (typeof oldest !== "string") break;
      this.sourcePaths.delete(oldest);
    }
  }

  private persistWatcherState(): void {
    persistActivationState(this.config, {
      activatedAt: this.activatedAt,
      baselineFileFrontiers: this.baselineFileFrontiers
    });
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
  config = resolveCodexTranscriptWatcherConfig(),
  historicalObserver?: CodexHistoricalCandidateObserver
): CodexTranscriptWatcherHandle => {
  const watcher = new CodexTranscriptWatcher(
    client,
    config,
    historicalObserver
  );
  watcher.start();
  return watcher;
};
