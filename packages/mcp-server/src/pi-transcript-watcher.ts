import { createHash } from "node:crypto";
import fs, { type FSWatcher } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemoryApiClient, MemoryApiError, defaultConfig } from "./index.js";
import {
  completeTranscriptBoundary,
  countTranscriptLines
} from "./codex-transcript-journal.js";
import {
  parsePiSessionJournalBytes,
  type PiSessionParserState
} from "./pi-session-parser.js";
import {
  persistRawConversationItems,
  projectRawConversationItems
} from "./raw-conversation-items.js";

export interface PiTranscriptWatcherSignal {
  sourceSessionId: string;
  transcriptPath: string;
  cwd: string;
  eventName?: string;
  observedAt?: string;
}
interface PiWatcherState {
  version: 1;
  activatedAt: string;
  baselines: Record<string, number>;
}
export interface PiTranscriptWatcherHandle {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}
type Artifact = {
  id: string;
  sessionId: string;
  providerCursorOffset: number;
  providerCursorLine: number;
  journalStartOffset: number;
  liveStartOffset: number;
  liveStartLine: number;
  sourceFingerprint?: string;
};
type Segment = {
  id: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  plaintextDigest: string;
  plaintextSize: number;
};

const MAX_PI_DIRECT_READ_BYTES = 16 * 1024 * 1024;

const piJournalPageBytes = (env: NodeJS.ProcessEnv): number => {
  const configured = Number(env.MEMORY_PI_TRANSCRIPT_MAX_BYTES_PER_BATCH);
  return Number.isSafeInteger(configured) && configured >= 1024
    ? Math.min(configured, 16 * 1024 * 1024)
    : 4 * 1024 * 1024;
};

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const koedHome = (env: NodeJS.ProcessEnv): string =>
  path.resolve(env.KOED_HOME ?? path.join(os.homedir(), ".koed"));
const piHome = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")
  );
export const piSessionRoots = (
  env: NodeJS.ProcessEnv = process.env
): string[] => [
  ...new Set(
    [env.PI_CODING_AGENT_SESSION_DIR, path.join(piHome(env), "sessions")]
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(value))
  )
];
const statePath = (env: NodeJS.ProcessEnv): string =>
  path.join(koedHome(env), "state", "pi-transcript-watcher.json");
const signalDirectory = (env: NodeJS.ProcessEnv): string =>
  path.join(koedHome(env), "run", "pi-transcript-signals");
const wakePath = (env: NodeJS.ProcessEnv): string =>
  path.join(koedHome(env), "run", "pi-transcript-watcher.wake");

const loadState = (env: NodeJS.ProcessEnv): PiWatcherState => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(statePath(env), "utf8")
    ) as PiWatcherState;
    if (
      parsed.version === 1 &&
      typeof parsed.activatedAt === "string" &&
      parsed.baselines
    )
      return parsed;
  } catch {
    /* activate below */
  }
  return { version: 1, activatedAt: new Date().toISOString(), baselines: {} };
};
const persistState = (env: NodeJS.ProcessEnv, state: PiWatcherState): void => {
  const target = statePath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
};

export const piSessionIdentity = (
  target: string
): {
  id: string;
  cwd: string;
  parentSession?: string;
} => {
  const boundary = completeTranscriptBoundary(target);
  if (boundary === 0) throw new Error("pi_session_header_incomplete");
  const descriptor = fs.openSync(target, "r");
  try {
    const bytes = Buffer.alloc(Math.min(boundary, 1024 * 1024));
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, count).indexOf(0x0a);
    if (newline < 0) throw new Error("pi_session_header_too_large");
    const header = JSON.parse(
      bytes.subarray(0, newline).toString("utf8")
    ) as Record<string, unknown>;
    if (
      header.type !== "session" ||
      header.version !== 3 ||
      typeof header.id !== "string" ||
      typeof header.cwd !== "string"
    )
      throw new Error("pi_session_header_unsupported");
    return {
      id: header.id,
      cwd: header.cwd,
      ...(typeof header.parentSession === "string"
        ? { parentSession: header.parentSession }
        : {})
    };
  } finally {
    fs.closeSync(descriptor);
  }
};

const discoverFiles = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.slice(0, 20_000)) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(target);
      else if (entry.isDirectory() && depth < 4) await walk(target, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
};

export const discoverPiTranscriptSignals = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<PiTranscriptWatcherSignal[]> => {
  const signals: PiTranscriptWatcherSignal[] = [];
  for (const root of piSessionRoots(env)) {
    for (const transcriptPath of await discoverFiles(root)) {
      try {
        const identity = piSessionIdentity(transcriptPath);
        signals.push({
          sourceSessionId: identity.id,
          transcriptPath,
          cwd: identity.cwd,
          eventName: "FilesystemRecovery",
          observedAt: (await stat(transcriptPath)).mtime.toISOString()
        });
      } catch {
        /* visible when explicitly signalled */
      }
    }
  }
  return signals;
};

export const verifiedPiSessionPath = async (
  candidate: string,
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const canonical = await realpath(path.resolve(candidate));
  const roots = await Promise.all(
    piSessionRoots(env).map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    })
  );
  if (!roots.some((root) => canonical.startsWith(`${root}${path.sep}`)))
    throw new Error("pi_session_outside_configured_roots");
  const details = fs.lstatSync(canonical);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("pi_session_not_regular_file");
  return canonical;
};
const artifactFrom = (response: Record<string, unknown>): Artifact => {
  if (!response.artifact || typeof response.artifact !== "object")
    throw new Error("pi_journal_api_response_missing_artifact");
  return response.artifact as Artifact;
};
const readRange = (target: string, start: number, end: number): Buffer => {
  if (end - start > MAX_PI_DIRECT_READ_BYTES)
    throw new Error("pi_session_read_range_unbounded");
  const bytes = Buffer.alloc(end - start);
  const descriptor = fs.openSync(target, "r");
  try {
    if (fs.readSync(descriptor, bytes, 0, bytes.length, start) !== bytes.length)
      throw new Error("pi_session_short_read");
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
};
const journalSegmentBytes = async (
  client: MemoryApiClient,
  artifactId: string,
  segment: Segment
): Promise<Buffer> => {
  const response = await client.getConversationSourceSegmentContent(
    artifactId,
    segment.id
  );
  if (typeof response.bytesBase64 !== "string")
    throw new Error("pi_journal_segment_content_missing");
  const bytes = Buffer.from(response.bytesBase64, "base64");
  if (
    segment.plaintextSize > MAX_PI_DIRECT_READ_BYTES ||
    bytes.length !== segment.plaintextSize ||
    createHash("sha256").update(bytes).digest("hex") !== segment.plaintextDigest
  )
    throw new Error("pi_journal_segment_verification_failed");
  return bytes;
};
const journalLineAtOffset = async (
  client: MemoryApiClient,
  artifactId: string,
  sourceOffset: number
): Promise<number> => {
  if (sourceOffset === 0) return 0;
  const page = await client.listConversationSourceSegments(artifactId, {
    afterOffset: sourceOffset - 1,
    limit: 1
  });
  const segment = (page.segments as Segment[] | undefined)?.[0];
  if (
    !segment ||
    segment.sourceStartOffset > sourceOffset ||
    segment.sourceEndOffset < sourceOffset ||
    !Number.isSafeInteger(segment.sourceStartLine) ||
    !Number.isSafeInteger(segment.sourceEndLine) ||
    segment.sourceStartLine < 0 ||
    segment.sourceEndLine < segment.sourceStartLine
  )
    throw new Error("pi_journal_segment_chain_incomplete");
  if (sourceOffset === segment.sourceStartOffset)
    return segment.sourceStartLine;
  if (sourceOffset === segment.sourceEndOffset) return segment.sourceEndLine;
  const bytes = await journalSegmentBytes(client, artifactId, segment);
  return (
    segment.sourceStartLine +
    bytes
      .subarray(0, sourceOffset - segment.sourceStartOffset)
      .reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0)
  );
};
const policyAllowsCapture = async (
  client: MemoryApiClient,
  signal: PiTranscriptWatcherSignal
): Promise<boolean> => {
  const response = await client.getEffectiveCapturePolicy({
    projectId: signal.cwd,
    threadId: signal.sourceSessionId
  });
  const policy = response.policy as Record<string, unknown> | undefined;
  if (policy?.captureState === "disabled" || policy?.captureState === "ask")
    return false;
  return !(
    typeof policy?.pauseUntil === "string" &&
    Date.parse(policy.pauseUntil) > Date.now()
  );
};

const lookupArtifact = async (
  client: MemoryApiClient,
  externalSessionId: string
): Promise<Artifact | null> => {
  try {
    return artifactFrom(
      await client.lookupConversationSourceArtifact({
        sourceKind: "pi",
        externalSessionId
      })
    );
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
};

export const processPiTranscriptSignal = async (
  client: MemoryApiClient,
  state: PiWatcherState,
  signal: PiTranscriptWatcherSignal,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const target = await verifiedPiSessionPath(signal.transcriptPath, env);
  const identity = piSessionIdentity(target);
  if (identity.id !== signal.sourceSessionId || identity.cwd !== signal.cwd)
    throw new Error("pi_session_signal_identity_mismatch");
  const file = await stat(target);
  const boundary = completeTranscriptBoundary(target);
  let artifact = await lookupArtifact(client, identity.id);
  const baseline =
    state.baselines[target] ??
    (file.birthtimeMs < Date.parse(state.activatedAt) ? boundary : 0);
  state.baselines[target] = baseline;
  if (!artifact && boundary === baseline) return;
  if (!(await policyAllowsCapture(client, signal))) {
    state.baselines[target] = boundary;
    return;
  }
  if (!artifact)
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
        sourceFingerprint: hash({
          adapter: "pi-session-v1",
          sessionId: identity.id,
          path: target
        }),
        artifactFormat: "pi_session_jsonl",
        artifactFormatVersion: 1,
        journalStartOffset: 0,
        journalStartLine: 0,
        liveStartOffset: baseline,
        liveStartLine: await countTranscriptLines(target, baseline),
        currentSourceLength: file.size,
        sourceCreatedAt: file.birthtime.toISOString(),
        sourceModifiedAt: file.mtime.toISOString(),
        redactedSourceLabel: `${identity.id}.jsonl`
      })
    );
  if (file.size < artifact.providerCursorOffset)
    throw new Error("pi_session_truncated");
  if (artifact.providerCursorOffset > 0) {
    const page = await client.listConversationSourceSegments(artifact.id, {
      afterOffset: artifact.providerCursorOffset - 1,
      limit: 1
    });
    const segment = (page.segments as Segment[] | undefined)?.[0];
    if (!segment || segment.sourceEndOffset !== artifact.providerCursorOffset)
      throw new Error("pi_journal_segment_chain_incomplete");
    const covered = readRange(
      target,
      segment.sourceStartOffset,
      segment.sourceEndOffset
    );
    if (
      covered.length !== segment.plaintextSize ||
      createHash("sha256").update(covered).digest("hex") !==
        segment.plaintextDigest
    )
      throw new Error("pi_session_covered_prefix_mutation");
  }
  while (artifact.providerCursorOffset < boundary) {
    if (!(await policyAllowsCapture(client, signal))) {
      state.baselines[target] = boundary;
      return;
    }
    const end = Math.min(
      boundary,
      artifact.providerCursorOffset + piJournalPageBytes(env)
    );
    let bytes = readRange(target, artifact.providerCursorOffset, end);
    if (end < boundary) {
      const newline = bytes.lastIndexOf(0x0a);
      if (newline < 0) throw new Error("pi_session_record_too_large");
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
  let cursorOffset = artifact.liveStartOffset;
  let cursorLine = artifact.liveStartLine;
  let parserState: PiSessionParserState | undefined;
  try {
    const response = await client.getConversationSourceCursor(
      artifact.id,
      "canonical_live"
    );
    if (response.cursor && typeof response.cursor === "object") {
      const cursor = response.cursor as Record<string, unknown>;
      cursorOffset = Number(cursor.sourceOffset);
      cursorLine = Number(cursor.sourceLine);
      parserState = cursor.parserState as PiSessionParserState | undefined;
    }
  } catch (error) {
    if (!(error instanceof MemoryApiError) || error.status !== 404) throw error;
  }
  if (cursorOffset >= boundary) return;
  if (!(await policyAllowsCapture(client, signal))) {
    state.baselines[target] = boundary;
    return;
  }
  const captureStart = Math.max(
    cursorOffset,
    state.baselines[target] ?? cursorOffset
  );
  const captureStartLine =
    captureStart === cursorOffset
      ? cursorLine
      : await journalLineAtOffset(client, artifact.id, captureStart);
  const page = await client.listConversationSourceSegments(artifact.id, {
    afterOffset: captureStart,
    limit: 1
  });
  const segment = (page.segments as Segment[] | undefined)?.[0];
  if (
    !segment ||
    segment.sourceStartOffset > captureStart ||
    segment.sourceEndOffset <= captureStart
  )
    throw new Error("pi_journal_segment_chain_incomplete");
  const segmentContent = await journalSegmentBytes(
    client,
    artifact.id,
    segment
  );
  const bytes = segmentContent.subarray(
    captureStart - segment.sourceStartOffset
  );
  const parsed = parsePiSessionJournalBytes({
    bytes,
    absoluteStartOffset: captureStart,
    lineIndexOffset: captureStartLine,
    sessionId: artifact.sessionId,
    externalSessionId: identity.id,
    sourceFingerprint: artifact.sourceFingerprint ?? hash(identity.id),
    prior: parserState
  });
  const persisted = await persistRawConversationItems(
    client,
    parsed.items,
    `Pi session ${identity.id}`
  );
  if (persisted.length > 0)
    await projectRawConversationItems(
      client,
      persisted,
      `Pi session ${identity.id}`
    );
  await client.advanceConversationSourceCursor(artifact.id, {
    consumerKind: "canonical_live",
    expectedSourceOffset: cursorOffset,
    sourceOffset: parsed.checkpoint.offset,
    sourceLine: parsed.checkpoint.lineCount,
    segmentIndex: segment.segmentIndex,
    lastVerifiedDigest: segment.plaintextDigest,
    parserState: parsed.parserState
  });
};

export const startPiTranscriptWatcher = (
  client: MemoryApiClient = new MemoryApiClient(defaultConfig()),
  env: NodeJS.ProcessEnv = process.env
): PiTranscriptWatcherHandle => {
  const state = loadState(env);
  const directory = signalDirectory(env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const wake = wakePath(env);
  if (!fs.existsSync(wake)) fs.writeFileSync(wake, "0\n", { mode: 0o600 });
  let running: Promise<void> | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const scan = (): Promise<void> =>
    (running ??= (async () => {
      const pending = new Map<
        string,
        { signal: PiTranscriptWatcherSignal; target?: string }
      >();
      for (const name of await readdir(directory))
        if (name.endsWith(".json")) {
          const target = path.join(directory, name);
          try {
            const signal = JSON.parse(
              fs.readFileSync(target, "utf8")
            ) as PiTranscriptWatcherSignal;
            pending.set(`${signal.sourceSessionId}\0${signal.transcriptPath}`, {
              signal,
              target
            });
          } catch {
            fs.renameSync(target, `${target}.invalid`);
          }
        }
      for (const signal of await discoverPiTranscriptSignals(env))
        pending.set(`${signal.sourceSessionId}\0${signal.transcriptPath}`, {
          signal
        });
      for (const value of pending.values()) {
        try {
          await processPiTranscriptSignal(client, state, value.signal, env);
          persistState(env, state);
          if (value.target) fs.rmSync(value.target, { force: true });
        } catch (error) {
          console.error(
            `Pi transcript capture failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    })().finally(() => {
      running = null;
    }));
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void scan();
    }, 200);
    timer.unref();
  };
  const watchers: FSWatcher[] = [
    fs.watch(directory, schedule),
    fs.watch(wake, schedule)
  ];
  for (const root of piSessionRoots(env)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    watchers.push(
      fs.watch(
        root,
        {
          recursive:
            process.platform === "darwin" || process.platform === "win32"
        },
        schedule
      )
    );
  }
  const recoveryInterval = setInterval(schedule, 2_000);
  recoveryInterval.unref();
  void scan();
  return {
    scanNow: scan,
    async stop() {
      stopped = true;
      clearInterval(recoveryInterval);
      if (timer) clearTimeout(timer);
      watchers.forEach((watcher) => watcher.close());
      await running;
    }
  };
};
