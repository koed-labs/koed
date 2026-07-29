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
  private readonly watchers: FSWatcher[] = [];
  private readonly hintedTranscriptPaths = new Set<string>();
  private readonly processing = new Set<string>();
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
  private debounceTimer?: NodeJS.Timeout;
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
            this.rememberFilesystemHint(root, filename);
            this.wake();
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
      await this.serviceFilesystemHints();
      await this.serviceKnownSources();
      const discovery = await this.discovery.scan();
      this.metrics.filesDiscovered += discovery.files.length;
      for (const transcriptPath of discovery.files) {
        if (this.stopped) break;
        await this.serviceFilesystemHints();
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

  private rememberFilesystemHint(
    root: string,
    filename: string | Buffer | null
  ): void {
    if (filename === null) return;
    const candidate = path.resolve(root, filename.toString());
    const relative = path.relative(root, candidate);
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !TRANSCRIPT_PATTERN.test(path.basename(candidate))
    ) {
      return;
    }
    this.hintedTranscriptPaths.add(candidate);
  }

  private async serviceFilesystemHints(): Promise<void> {
    const transcriptPaths = [...this.hintedTranscriptPaths];
    this.hintedTranscriptPaths.clear();
    for (const transcriptPath of transcriptPaths) {
      if (this.stopped || !existsSync(transcriptPath)) continue;
      await this.processPathOnce(transcriptPath);
    }
  }

  private async serviceKnownSources(): Promise<void> {
    const observations = [...this.sourcePaths.values()];
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
    const baselineFrontier = this.baselineFileFrontiers.get(fileKey);
    this.rememberBaselineFile(fileKey);
    const sourceUnchanged = this.sourcePathUnchanged(transcriptPath, before);
    const boundary = completeTranscriptBoundary(
      transcriptPath,
      this.config.maxBytesPerBatch
    );
    this.rememberBaselineFile(fileKey, boundary);
    if (
      this.activatedAt !== null &&
      baselineFrontier !== undefined &&
      boundary <= (baselineFrontier ?? 0)
    ) {
      return;
    }
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
    const sourceProjectPath = sourceProjectId(identity.context);
    const sourceProject = sourceProjectPath
      ? readProjectMetadataForRoot(sourceProjectPath, {
          ...process.env,
          KOED_HOME: this.config.koedHome
        })
      : null;
    const result = await ingestCodexTranscriptJournal({
      client: this.client,
      sourceSession: {
        externalSessionId: identity.sessionId,
        sourceRuntime: "codex-cli",
        captureMethod: "api",
        cwd: sourceProjectPath,
        idempotencyKey: sha256(`watcher-session:${identity.sessionId}`),
        metadata: {
          ...identity.context.transcriptMetadata,
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
      },
      sourceSessionId: identity.sessionId,
      transcriptPath,
      context: identity.context,
      maxBytesPerBatch: this.config.maxBytesPerBatch,
      journalStartOffset: liveStartOffset,
      journalStartLine: liveStartLine,
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
  config = resolveCodexTranscriptWatcherConfig()
): CodexTranscriptWatcherHandle => {
  const watcher = new CodexTranscriptWatcher(client, config);
  watcher.start();
  return watcher;
};
