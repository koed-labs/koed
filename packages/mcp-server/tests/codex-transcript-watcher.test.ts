import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryApiError } from "../src/index.js";
import {
  completeTranscriptBoundary,
  discoverCodexTranscripts,
  latestTranscriptActivity,
  resolveCodexTranscriptWatcherConfig,
  startCodexTranscriptWatcher,
  type CodexHistoricalCandidateObserver,
  type CodexTranscriptWatcherClient,
  type CodexTranscriptWatcherConfig
} from "../src/codex-transcript-watcher.js";
import { signalCodexTranscriptWatcher } from "../src/codex-transcript-watcher-signal.js";

const temporaryDirectories: string[] = [];
const watcherHandles: Array<ReturnType<typeof startCodexTranscriptWatcher>> =
  [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "koed-watcher-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(watcherHandles.splice(0).map((watcher) => watcher.stop()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const trackedWatcher = (
  client: CodexTranscriptWatcherClient,
  config: CodexTranscriptWatcherConfig,
  historicalObserver?: CodexHistoricalCandidateObserver
) => {
  const watcher = startCodexTranscriptWatcher(
    client,
    config,
    historicalObserver
  );
  watcherHandles.push(watcher);
  return watcher;
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
};

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
const sessionRecord = (
  sessionId: string,
  cwd = "/tmp/project",
  timestamp = "2099-01-01T00:00:00.000Z"
) => ({
  timestamp,
  type: "session_meta",
  payload: { id: sessionId, cwd, timestamp }
});
const userRecord = (message: string, second = 1) => ({
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
  type: "event_msg",
  payload: { type: "user_message", message }
});
const assistantEventRecord = (message: string, second = 2) => ({
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
  type: "event_msg",
  payload: { type: "agent_message", message }
});
const assistantResponseRecord = (message: string, second = 3) => ({
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
  type: "response_item",
  payload: {
    id: `assistant-${second}`,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: message }]
  }
});
const controlRecord = (second = 4) => ({
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
  type: "event_msg",
  payload: { type: "task_complete" }
});

interface Artifact {
  id: string;
  sessionId: string;
  externalSessionId: string;
  sourceFingerprint: string;
  journalStartOffset: number;
  journalStartLine: number;
  liveStartOffset: number;
  liveStartLine: number;
  providerCursorOffset: number;
  providerCursorLine: number;
  currentSourceLength: number;
  sourceModifiedAt: string | null;
}

interface Segment {
  id: string;
  artifactId: string;
  segmentIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  plaintextDigest: string;
  plaintextSize: number;
  bytesBase64: string;
}

interface Cursor {
  artifactId: string;
  consumerKind: "canonical_live";
  segmentIndex: number;
  sourceOffset: number;
  sourceLine: number;
  lastVerifiedDigest: string | null;
  parserState: Record<string, unknown>;
}

class FakeWatcherClient implements CodexTranscriptWatcherClient {
  readonly artifacts = new Map<string, Artifact>();
  readonly segments = new Map<string, Segment[]>();
  readonly cursors = new Map<string, Cursor>();
  readonly itemBatches: Array<Array<Record<string, unknown>>> = [];
  readonly operationOrder: string[] = [];
  readonly policyRequests: Array<Record<string, unknown>> = [];
  readonly sourceSessions: Array<Record<string, unknown>> = [];
  sessionCalls = 0;
  captureState: "enabled" | "disabled" | "ask" = "enabled";
  policyPaused = false;
  policyVisibility = "personal";
  failProjection = false;
  conflictNextCanonicalCursor = false;
  private nextItem = 0;

  async ensureConversationSourceArtifact(input: Record<string, unknown>) {
    const externalSessionId = String(input.externalSessionId);
    const sourceSession = input.sourceSession as Record<string, unknown>;
    this.sourceSessions.push(sourceSession);
    this.policyRequests.push({
      projectId: sourceSession.cwd,
      threadId: externalSessionId
    });
    if (
      this.captureState !== "enabled" ||
      this.policyPaused ||
      this.policyVisibility !== "personal"
    ) {
      throw new Error("capture_policy_blocked");
    }
    const existing = this.artifacts.get(externalSessionId);
    if (existing) {
      existing.currentSourceLength = Math.max(
        existing.currentSourceLength,
        Number(input.currentSourceLength)
      );
      existing.sourceModifiedAt =
        typeof input.sourceModifiedAt === "string"
          ? input.sourceModifiedAt
          : existing.sourceModifiedAt;
      return { artifact: existing };
    }
    this.sessionCalls += 1;
    const artifact: Artifact = {
      id: `artifact-${this.artifacts.size + 1}`,
      sessionId: `22222222-2222-4222-8222-${externalSessionId.padEnd(12, "0").slice(-12)}`,
      externalSessionId,
      sourceFingerprint: String(input.sourceFingerprint),
      journalStartOffset: Number(input.journalStartOffset),
      journalStartLine: Number(input.journalStartLine),
      liveStartOffset: Number(input.liveStartOffset),
      liveStartLine: Number(input.liveStartLine),
      providerCursorOffset: Number(input.journalStartOffset),
      providerCursorLine: Number(input.journalStartLine),
      currentSourceLength: Number(input.currentSourceLength),
      sourceModifiedAt:
        typeof input.sourceModifiedAt === "string"
          ? input.sourceModifiedAt
          : null
    };
    this.artifacts.set(externalSessionId, artifact);
    this.segments.set(artifact.id, []);
    return { artifact };
  }

  async lookupConversationSourceArtifact(input: { externalSessionId: string }) {
    const artifact = this.artifacts.get(input.externalSessionId);
    if (!artifact) throw new MemoryApiError("not found", { status: 404 });
    return { artifact };
  }

  async appendConversationSourceSegment(
    artifactId: string,
    input: Record<string, unknown>
  ) {
    const artifact = [...this.artifacts.values()].find(
      (candidate) => candidate.id === artifactId
    )!;
    const existing = this.segments
      .get(artifactId)!
      .find(
        (segment) =>
          segment.sourceStartOffset === Number(input.expectedProviderOffset) &&
          segment.sourceEndOffset === Number(input.sourceEndOffset)
      );
    if (existing) {
      return { artifact, segment: existing, replayed: true };
    }
    if (
      artifact.providerCursorOffset !== Number(input.expectedProviderOffset) ||
      artifact.providerCursorLine !== Number(input.expectedProviderLine)
    ) {
      throw new MemoryApiError("cursor conflict", { status: 409 });
    }
    const segment: Segment = {
      id: `segment-${artifactId}-${this.segments.get(artifactId)!.length + 1}`,
      artifactId,
      segmentIndex: this.segments.get(artifactId)!.length + 1,
      sourceStartOffset: artifact.providerCursorOffset,
      sourceEndOffset: Number(input.sourceEndOffset),
      sourceStartLine: artifact.providerCursorLine,
      sourceEndLine: Number(input.sourceEndLine),
      plaintextDigest: String(input.plaintextDigest),
      plaintextSize: Number(input.plaintextSize),
      bytesBase64: String(input.bytesBase64)
    };
    this.segments.get(artifactId)!.push(segment);
    artifact.providerCursorOffset = segment.sourceEndOffset;
    artifact.providerCursorLine = segment.sourceEndLine;
    artifact.currentSourceLength = Number(input.currentSourceLength);
    this.operationOrder.push("journal");
    return { artifact, segment, replayed: false };
  }

  async finalizeConversationSourceArtifact(
    artifactId: string,
    input: { expectedProviderOffset: number; expectedProviderLine: number }
  ) {
    const artifact = [...this.artifacts.values()].find(
      (candidate) => candidate.id === artifactId
    );
    if (
      !artifact ||
      artifact.providerCursorOffset !== input.expectedProviderOffset ||
      artifact.providerCursorLine !== input.expectedProviderLine
    ) {
      throw new MemoryApiError("finalization conflict", { status: 409 });
    }
    return { artifact, replayed: false };
  }

  async listConversationSourceSegments(
    artifactId: string,
    input: { afterOffset: number; limit?: number }
  ) {
    return {
      segments: this.segments
        .get(artifactId)!
        .filter((segment) => segment.sourceEndOffset > input.afterOffset)
        .slice(0, input.limit ?? 20)
        .map(({ bytesBase64, ...segment }) => {
          void bytesBase64;
          return segment;
        })
    };
  }

  async getConversationSourceSegmentContent(
    artifactId: string,
    segmentId: string
  ) {
    const segment = this.segments
      .get(artifactId)!
      .find((candidate) => candidate.id === segmentId)!;
    const { bytesBase64, ...safeSegment } = segment;
    return { segment: safeSegment, bytesBase64 };
  }

  async getConversationSourceCursor(artifactId: string, consumerKind: string) {
    void consumerKind;
    return { cursor: this.cursors.get(artifactId) ?? null };
  }

  async advanceConversationSourceCursor(
    artifactId: string,
    input: Record<string, unknown>
  ) {
    const existing = this.cursors.get(artifactId);
    const artifact = [...this.artifacts.values()].find(
      (candidate) => candidate.id === artifactId
    )!;
    const expected = existing?.sourceOffset ?? artifact.liveStartOffset;
    if (expected !== Number(input.expectedSourceOffset)) {
      throw new MemoryApiError("cursor conflict", { status: 409 });
    }
    const cursor: Cursor = {
      artifactId,
      consumerKind: "canonical_live",
      segmentIndex: Number(input.segmentIndex),
      sourceOffset: Number(input.sourceOffset),
      sourceLine: Number(input.sourceLine),
      lastVerifiedDigest: String(input.lastVerifiedDigest),
      parserState: (input.parserState ?? {}) as Record<string, unknown>
    };
    this.cursors.set(artifactId, cursor);
    if (this.conflictNextCanonicalCursor) {
      this.conflictNextCanonicalCursor = false;
      throw new MemoryApiError("Conversation source consumer cursor conflict", {
        status: 409,
        payload: {
          error: "Conversation source consumer cursor conflict",
          code: "conversation_source_consumer_cursor_conflict"
        }
      });
    }
    this.operationOrder.push("canonical_cursor");
    return { cursor };
  }

  async createConversationItems(input: Record<string, unknown>) {
    const items = input.items as Array<Record<string, unknown>>;
    this.itemBatches.push(items);
    this.operationOrder.push("canonical_items");
    return {
      items: items.map((item) => ({ ...item, id: `item-${++this.nextItem}` }))
    };
  }

  async projectConversationItems() {
    if (this.failProjection) throw new Error("projection unavailable");
    this.operationOrder.push("projection");
    return {};
  }
}

const watcherConfig = (
  root: string,
  overrides: Partial<CodexTranscriptWatcherConfig> = {}
): CodexTranscriptWatcherConfig => ({
  roots: [path.join(root, "codex", "sessions")],
  koedHome: path.join(root, "koed"),
  debounceMs: 60_000,
  pollMs: 60_000,
  turnBoundarySettleMs: 25,
  maxEntriesPerScan: 1_000,
  maxFilesPerScan: 100,
  maxBytesPerBatch: 64 * 1024,
  ...overrides
});

const transcriptPath = (root: string, name = "rollout-test.jsonl"): string => {
  const directory = path.join(root, "codex", "sessions", "2026", "01", "01");
  mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
};

describe("Codex Transcript Watcher source journal", () => {
  it("uses platform-delimited supported roots and rejects unsafe root scope", () => {
    const home = temporaryDirectory();
    const first = path.join(home, ".codex-a");
    const second = path.join(home, ".codex-b");

    expect(
      resolveCodexTranscriptWatcherConfig({
        HOME: home,
        MEMORY_CODEX_TRANSCRIPT_ROOTS: [first, second].join(path.delimiter)
      }).roots
    ).toEqual([first, second]);
    expect(() =>
      resolveCodexTranscriptWatcherConfig({
        HOME: home,
        MEMORY_CODEX_TRANSCRIPT_ROOTS: "relative/sessions"
      })
    ).toThrow("must be absolute");
    expect(() =>
      resolveCodexTranscriptWatcherConfig({ HOME: home, CODEX_HOME: home })
    ).toThrow("too broad");
  });

  it("discovers the newest timestamped transcript first", async () => {
    const root = temporaryDirectory();
    const oldTranscript = transcriptPath(root, "rollout-2026-01-01.jsonl");
    const newTranscript = transcriptPath(root, "rollout-2026-01-02.jsonl");
    writeFileSync(oldTranscript, line(sessionRecord("old")));
    writeFileSync(newTranscript, line(sessionRecord("new")));

    const discovered = await discoverCodexTranscripts(
      watcherConfig(root, { maxFilesPerScan: 1 })
    );

    expect(discovered).toEqual([newTranscript]);
  });

  it("automatically completes a bounded activation cycle before ingesting live growth", async () => {
    const root = temporaryDirectory();
    const transcripts = Array.from({ length: 3 }, (_, index) => {
      const transcript = transcriptPath(
        root,
        `rollout-2026-01-0${index + 1}.jsonl`
      );
      writeFileSync(transcript, line(sessionRecord(`baseline-${index}`)));
      return transcript;
    });
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(
      client,
      watcherConfig(root, {
        debounceMs: 5,
        maxFilesPerScan: 1
      })
    );

    await waitFor(() => watcher.snapshot().state === "running");

    expect(watcher.snapshot().scans).toBeGreaterThan(1);
    expect(client.artifacts.size).toBe(0);

    appendFileSync(
      transcripts.at(-1)!,
      line(userRecord("live after activation"))
    );
    watcher.wake();

    await waitFor(() =>
      client.itemBatches
        .flat()
        .some((item) => item.rawText === "live after activation")
    );
  });

  it("refreshes a stale directory snapshot after a Hook wake during a bounded live sweep", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(
      client,
      watcherConfig(root, {
        debounceMs: 25,
        maxFilesPerScan: 1
      })
    );

    // Activate while the transcript root is absent so no filesystem watcher can
    // provide an exact-path hint for the file created later in this test.
    await watcher.scanNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const scansBeforeSweep = watcher.snapshot().scans;

    for (let index = 0; index < 12; index += 1) {
      writeFileSync(
        transcriptPath(root, `rollout-baseline-${index}.jsonl`),
        line(
          sessionRecord(
            `stale-baseline-${index}`,
            "/tmp/project",
            "2025-01-01T00:00:00.000Z"
          )
        )
      );
    }

    watcher.wake();
    await waitFor(() => watcher.snapshot().scans > scansBeforeSweep);

    const liveTranscript = transcriptPath(root, "rollout-zzzz-live.jsonl");
    writeFileSync(
      liveTranscript,
      line(sessionRecord("stale-snapshot-live")) +
        line(userRecord("discover me after refreshing the snapshot"))
    );
    watcher.wake();

    await waitFor(() => client.artifacts.has("stale-snapshot-live"), 3_000);
    expect(
      client.itemBatches
        .flat()
        .some(
          (item) => item.rawText === "discover me after refreshing the snapshot"
        )
    ).toBe(true);
  });

  it("reads one final byte for a complete large transcript boundary", () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    const content = Buffer.alloc(20 * 1024 * 1024, "x");
    content[content.length - 1] = 0x0a;
    writeFileSync(transcript, content);
    const readSync = vi.spyOn(fs, "readSync");

    expect(completeTranscriptBoundary(transcript)).toBe(content.length);
    expect(
      readSync.mock.calls.reduce((total, call) => total + call[1].byteLength, 0)
    ).toBe(1);
    readSync.mockRestore();
  });

  it("reads an oversized final record's own timestamp instead of falling back to the transcript's creation time", () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    const smallRecord = JSON.stringify({
      timestamp: "2026-06-01T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "small opening message" }
    });
    const hugeRecord = JSON.stringify({
      timestamp: "2026-08-17T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "x".repeat(1_100_000) }
    });
    const content = `${smallRecord}\n${hugeRecord}\n`;
    writeFileSync(transcript, content);
    const boundary = completeTranscriptBoundary(transcript);
    const context = {
      threadKind: "conversation" as const,
      transcriptMetadata: { timestamp: "2026-01-01T00:00:00.000Z" }
    };

    // A 1MB window landing entirely inside the >1MB trailing record used to
    // find no earlier newline to align on and silently fall back to the
    // transcript's creation timestamp, making a recently active
    // Conversation with one large record look 30+ days stale.
    const latestActivityAt = latestTranscriptActivity(
      transcript,
      boundary,
      1_048_576,
      context
    );

    expect(latestActivityAt).toBe("2026-08-17T00:00:00.000Z");
  });

  it("registers an opaque catalogued Project identity with the source session", async () => {
    const root = temporaryDirectory();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("catalogued", projectRoot)));
    const koedHome = path.join(root, "koed");
    mkdirSync(path.join(koedHome, "config"), { recursive: true });
    writeFileSync(
      path.join(koedHome, "config", "projects.json"),
      JSON.stringify({
        projects: [
          {
            localProjectId: "lp_0123456789abcdef0123456789abcdef",
            displayName: "Catalogued Project",
            path: { cwd: projectRoot, projectRoot }
          }
        ]
      })
    );
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));

    await watcher.scanNow();
    appendFileSync(transcript, line(userRecord("catalogued project prompt")));
    await watcher.scanNow();

    expect(client.sourceSessions.at(-1)).toMatchObject({
      cwd: projectRoot,
      metadata: {
        localProjectId: "lp_0123456789abcdef0123456789abcdef",
        projectName: "Catalogued Project",
        projectPath: projectRoot
      },
      detectedProjects: [
        {
          id: "lp_0123456789abcdef0123456789abcdef",
          name: "Catalogued Project",
          path: projectRoot
        }
      ]
    });
  });

  it("stores normalized lineage for native Codex guardian sessions", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    const parentThreadId = "019fd15a-eaf3-7ea3-94e3-451dac881974";
    writeFileSync(
      transcript,
      line({
        timestamp: "2099-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019fd173-d3cd-7753-84a4-421d8010f356",
          cwd: "/tmp/project",
          timestamp: "2099-01-01T00:00:00.000Z",
          thread_source: "subagent",
          parent_thread_id: parentThreadId,
          source: { subagent: { other: "guardian" } }
        }
      })
    );
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));

    await watcher.scanNow();
    appendFileSync(transcript, line(userRecord("approval history")));
    await watcher.scanNow();

    expect(client.sourceSessions.at(-1)).toMatchObject({
      metadata: {
        threadKind: "subagent",
        parentThreadId
      }
    });
  });

  it("starts an existing transcript at the activation frontier", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    const initial = line(sessionRecord("existing"));
    writeFileSync(transcript, initial);
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));

    await watcher.scanNow();
    expect(client.artifacts.has("existing")).toBe(false);
    expect(client.itemBatches).toHaveLength(0);
    expect(client.sessionCalls).toBe(0);
    expect(client.policyRequests).toHaveLength(0);

    const appended = line(userRecord("captured after activation"));
    appendFileSync(transcript, appended);
    await watcher.scanNow();

    const artifact = client.artifacts.get("existing")!;
    expect(artifact.journalStartOffset).toBe(Buffer.byteLength(initial));
    expect(artifact.journalStartLine).toBe(1);
    expect(artifact.liveStartOffset).toBe(Buffer.byteLength(initial));
    expect(client.segments.get(artifact.id)).toHaveLength(1);
    expect(client.segments.get(artifact.id)?.[0]?.sourceStartOffset).toBe(
      Buffer.byteLength(initial)
    );
    expect(client.segments.get(artifact.id)).toHaveLength(1);
    expect(
      Buffer.from(client.segments.get(artifact.id)![0]!.bytesBase64, "base64")
    ).toEqual(Buffer.from(appended));
    expect(client.itemBatches.flat()).toHaveLength(1);
    expect(client.sessionCalls).toBe(1);
    expect(client.policyRequests).toHaveLength(1);
  });

  it("shares one durable frontier when a selected old source grows", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root, "rollout-history-race.jsonl");
    const startedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000);
    const activityAt = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const initial =
      line(
        sessionRecord(
          "history-race",
          "/missing/project",
          startedAt.toISOString()
        )
      ) +
      line({
        ...userRecord("long-running historical prompt"),
        timestamp: activityAt.toISOString()
      });
    writeFileSync(transcript, initial);
    const selections = new Map<
      string,
      { frontierOffset: number; frontierLine: number }
    >();
    let offeredProjectName: string | undefined;
    const observer: CodexHistoricalCandidateObserver = {
      offerCandidates(candidates) {
        for (const candidate of candidates) {
          selections.set(candidate.sourceSessionId, {
            frontierOffset: candidate.frontierOffset,
            frontierLine: 2
          });
          offeredProjectName = candidate.projectName;
        }
      },
      selectionFor(sourceSessionId) {
        return selections.get(sourceSessionId);
      }
    };
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root), observer);

    await watcher.scanNow();
    expect(selections.get("history-race")?.frontierOffset).toBe(
      Buffer.byteLength(initial)
    );
    expect(offeredProjectName).toBe("Unassigned");

    const appended = line(userRecord("live while history is pending"));
    appendFileSync(transcript, appended);
    await watcher.scanNow();

    const artifact = client.artifacts.get("history-race")!;
    expect(artifact.journalStartOffset).toBe(0);
    expect(artifact.liveStartOffset).toBe(Buffer.byteLength(initial));
    expect(artifact.liveStartLine).toBe(2);
    expect(
      Buffer.from(client.segments.get(artifact.id)![0]!.bytesBase64, "base64")
    ).toEqual(Buffer.from(initial + appended));
    expect(client.itemBatches.flat().map((item) => item.rawText)).toEqual([
      "live while history is pending"
    ]);
  });

  it("journals a post-activation source from byte zero", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();

    const transcript = transcriptPath(root, "rollout-new.jsonl");
    const content =
      line(
        sessionRecord("new-source", "/tmp/project", "2099-01-01T00:00:00Z")
      ) + line(userRecord("first prompt"));
    writeFileSync(transcript, content);
    await watcher.scanNow();

    const artifact = client.artifacts.get("new-source")!;
    expect(artifact.journalStartOffset).toBe(0);
    expect(
      Buffer.from(client.segments.get(artifact.id)![0]!.bytesBase64, "base64")
    ).toEqual(Buffer.from(content));
    expect(client.itemBatches.flat().length).toBeGreaterThan(0);
  });

  it("rediscovers a selected source moved within a supported root", async () => {
    const root = temporaryDirectory();
    const original = transcriptPath(root, "rollout-before-move.jsonl");
    const initial =
      line(
        sessionRecord(
          "moved-history",
          "/missing/project",
          new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
        )
      ) + line(userRecord("before move"));
    writeFileSync(original, initial);
    const selections = new Map<string, { frontierOffset: number }>();
    const observer: CodexHistoricalCandidateObserver = {
      offerCandidates(candidates) {
        for (const entry of candidates) {
          if (!selections.has(entry.sourceSessionId)) {
            selections.set(entry.sourceSessionId, {
              frontierOffset: entry.frontierOffset
            });
          }
        }
      },
      selectionFor(sourceSessionId) {
        const selected = selections.get(sourceSessionId);
        return selected ? { ...selected, frontierLine: 2 } : undefined;
      }
    };
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root), observer);
    await watcher.scanNow();

    const moved = path.join(path.dirname(original), "rollout-after-move.jsonl");
    renameSync(original, moved);
    appendFileSync(moved, line(userRecord("after move")));
    await watcher.scanNow();

    const artifact = client.artifacts.get("moved-history")!;
    expect(artifact.journalStartOffset).toBe(0);
    expect(artifact.liveStartOffset).toBe(Buffer.byteLength(initial));
    expect(client.itemBatches.flat().map((item) => item.rawText)).toEqual([
      "after move"
    ]);
  });

  it("keeps a deleted selected source path-free and retryable", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root, "rollout-deleted-history.jsonl");
    writeFileSync(
      transcript,
      line(
        sessionRecord(
          "deleted-history",
          "/missing/project",
          new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
        )
      )
    );
    let selection: { frontierOffset: number; frontierLine: number } | undefined;
    const observer: CodexHistoricalCandidateObserver = {
      offerCandidates(candidates) {
        const offered = candidates.find(
          (entry) => entry.sourceSessionId === "deleted-history"
        );
        if (offered && !selection) {
          selection = {
            frontierOffset: offered.frontierOffset,
            frontierLine: 1
          };
        }
      },
      selectionFor: () => selection
    };
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root), observer);
    await watcher.scanNow();
    unlinkSync(transcript);

    await expect(watcher.scanNow()).resolves.toBeUndefined();
    expect(selection).toBeDefined();
    expect(client.artifacts.has("deleted-history")).toBe(false);
    expect(JSON.stringify(watcher.snapshot())).not.toContain(root);
  });

  it("does not rewind either cursor after a selected source is truncated", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root, "rollout-truncated-history.jsonl");
    const initial =
      line(
        sessionRecord(
          "truncated-history",
          "/missing/project",
          new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
        )
      ) + line(userRecord("historical"));
    writeFileSync(transcript, initial);
    let frontierOffset: number | undefined;
    const observer: CodexHistoricalCandidateObserver = {
      offerCandidates(candidates) {
        frontierOffset ??= candidates.find(
          (entry) => entry.sourceSessionId === "truncated-history"
        )?.frontierOffset;
      },
      selectionFor: () =>
        frontierOffset === undefined
          ? undefined
          : { frontierOffset, frontierLine: 2 }
    };
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root), observer);
    await watcher.scanNow();
    appendFileSync(transcript, line(userRecord("live")));
    await watcher.scanNow();
    const before = { ...client.artifacts.get("truncated-history")! };
    const cursorBefore = { ...client.cursors.get(before.id)! };

    writeFileSync(transcript, initial.slice(0, 1));
    await watcher.scanNow();

    expect(client.artifacts.get("truncated-history")).toMatchObject({
      providerCursorOffset: before.providerCursorOffset,
      liveStartOffset: before.liveStartOffset
    });
    expect(client.cursors.get(before.id)).toMatchObject({
      sourceOffset: cursorBefore.sourceOffset
    });
    expect(watcher.snapshot().lastErrorCode).toBe("transcript_truncated");
  });

  it("baselines an old source first discovered after empty-root activation", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();

    const transcript = transcriptPath(root, "rollout-late-old.jsonl");
    const initial =
      line(
        sessionRecord(
          "late-old-source",
          "/tmp/project",
          "2026-01-01T00:00:00.000Z"
        )
      ) + line(userRecord("historical prompt"));
    writeFileSync(transcript, initial);
    await watcher.scanNow();

    expect(client.artifacts.has("late-old-source")).toBe(false);
    expect(client.itemBatches).toHaveLength(0);

    const appended = line(userRecord("captured after discovery"));
    appendFileSync(transcript, appended);
    await watcher.scanNow();

    const artifact = client.artifacts.get("late-old-source")!;
    expect(artifact.liveStartOffset).toBe(Buffer.byteLength(initial));
    expect(client.itemBatches.flat()).toHaveLength(1);
    expect(client.itemBatches.flat()[0]).toMatchObject({
      rawText: "captured after discovery"
    });
  });

  it("commits exact source bytes before canonical rows and cursor", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    const content =
      line(sessionRecord("ordered")) + line(userRecord("exact bytes"));
    writeFileSync(transcript, content);

    await watcher.scanNow();

    expect(client.operationOrder).toEqual([
      "journal",
      "canonical_items",
      "projection",
      "canonical_cursor"
    ]);
  });

  it("never journals a partial final JSONL record", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    const complete = line(sessionRecord("partial"));
    writeFileSync(transcript, `${complete}{"type":"event_msg"`);

    await watcher.scanNow();
    const artifact = client.artifacts.get("partial")!;
    expect(artifact.providerCursorOffset).toBe(Buffer.byteLength(complete));

    const remainder = line({
      type: "event_msg",
      timestamp: "2026-01-01T00:00:01.000Z",
      payload: { type: "user_message", message: "complete" }
    }).replace('{"type":"event_msg"', "");
    appendFileSync(transcript, remainder);
    await watcher.scanNow();
    expect(artifact.providerCursorOffset).toBe(statSync(transcript).size);
  });

  it("keeps one oversized JSONL record intact within the source segment limit", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(
      client,
      watcherConfig(root, { maxBytesPerBatch: 512 })
    );
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    const oversizedRecord = line(
      userRecord(`whole-record-${"x".repeat(2 * 1024)}`)
    );
    const content =
      line(sessionRecord("oversized-record")) +
      oversizedRecord +
      line(userRecord("following record"));
    writeFileSync(transcript, content);

    await watcher.scanNow();
    await watcher.scanNow();

    const artifact = client.artifacts.get("oversized-record")!;
    const segments = client.segments.get(artifact.id)!;
    expect(segments).toHaveLength(2);
    expect(
      Buffer.from(segments[1]!.bytesBase64, "base64").toString("utf8")
    ).toBe(oversizedRecord);
    expect(artifact.providerCursorOffset).toBe(
      Buffer.byteLength(line(sessionRecord("oversized-record"))) +
        Buffer.byteLength(oversizedRecord)
    );

    await watcher.scanNow();
    expect(artifact.providerCursorOffset).toBe(Buffer.byteLength(content));
  });

  it("replays durable journal bytes after Projection failure without appending twice", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("replay")) + line(userRecord("durable"))
    );
    client.failProjection = true;

    await watcher.scanNow();
    const artifact = client.artifacts.get("replay")!;
    expect(client.segments.get(artifact.id)).toHaveLength(1);
    expect(client.cursors.has(artifact.id)).toBe(false);

    client.failProjection = false;
    await watcher.scanNow();
    expect(client.segments.get(artifact.id)).toHaveLength(1);
    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
  });

  it("reconciles a canonical cursor advanced by another watcher", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("concurrent-cursor")) +
        line(userRecord("captured once"))
    );
    client.conflictNextCanonicalCursor = true;

    await watcher.scanNow();

    const artifact = client.artifacts.get("concurrent-cursor")!;
    expect(watcher.snapshot().lastErrorCode).toBeNull();
    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
    expect(
      client.itemBatches.flat().some((item) => item.rawText === "captured once")
    ).toBe(true);
  });

  it("holds an assistant event until the stable response arrives in a later segment", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(
      client,
      watcherConfig(root, { maxBytesPerBatch: 512 })
    );
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("held")) +
        line(userRecord("question")) +
        line(assistantEventRecord("temporary answer"))
    );

    await watcher.scanNow();
    const artifact = client.artifacts.get("held")!;
    const heldCursor =
      client.cursors.get(artifact.id)?.sourceOffset ?? artifact.liveStartOffset;
    expect(heldCursor).toBeLessThan(artifact.providerCursorOffset);

    appendFileSync(
      transcript,
      line(assistantResponseRecord("stable answer")) + line(controlRecord())
    );
    await watcher.scanNow();
    await watcher.scanNow();

    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
    const canonical = client.itemBatches.flat();
    expect(
      canonical.filter((item) =>
        (item.rawText as string | undefined)?.includes("stable answer")
      )
    ).toHaveLength(1);
  });

  it("accepts a transcript assistant fallback only after its matching turn-boundary signal", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const config = watcherConfig(root);
    const watcher = trackedWatcher(client, config);
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("signalled")) +
        line(userRecord("question")) +
        line(assistantEventRecord("final fallback"))
    );

    await watcher.scanNow();
    const artifact = client.artifacts.get("signalled")!;
    expect(client.cursors.get(artifact.id)?.sourceOffset).toBeLessThan(
      artifact.providerCursorOffset
    );
    expect(
      client.itemBatches
        .flat()
        .some((item) => item.rawText === "final fallback")
    ).toBe(false);

    signalCodexTranscriptWatcher(
      { KOED_HOME: config.koedHome },
      {
        sourceSessionId: "signalled",
        transcriptPath: transcript,
        turnBoundary: true
      }
    );
    await watcher.scanNow();

    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
    const finalItems = client.itemBatches
      .flat()
      .filter((item) => item.rawText === "final fallback");
    expect(finalItems).toHaveLength(1);
    expect(finalItems[0]?.externalTurnId).toMatch(/^transcript-user-turn:/);
    const boundary = client.itemBatches
      .flat()
      .find(
        (item) =>
          item.sourceAdapterVersion === "codex-hook-signal-v1" &&
          item.sourceTransport === "hook_signal" &&
          item.sourceEventType === "turn_completed"
      );
    expect(boundary?.externalTurnId).toMatch(/^transcript-user-turn:/);
  });

  it("persists a late Stop boundary after the transcript cursor already reached EOF", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const config = watcherConfig(root);
    const watcher = trackedWatcher(client, config);
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("late-stop")) +
        line(userRecord("question")) +
        line(assistantResponseRecord("stable final answer"))
    );

    await watcher.scanNow();
    const artifact = client.artifacts.get("late-stop")!;
    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
    expect(
      client.itemBatches
        .flat()
        .some((item) => item.sourceAdapterVersion === "codex-hook-signal-v1")
    ).toBe(false);
    const stoppedTurnId = client.itemBatches
      .flat()
      .find((item) => item.rawText === "stable final answer")?.externalTurnId;
    expect(stoppedTurnId).toMatch(/^transcript-user-turn:/);

    signalCodexTranscriptWatcher(
      { KOED_HOME: config.koedHome },
      {
        sourceSessionId: "late-stop",
        transcriptPath: transcript,
        turnBoundary: true
      }
    );
    appendFileSync(transcript, line(userRecord("next question", 5)));
    await watcher.scanNow();

    expect(client.itemBatches.flat()).toContainEqual(
      expect.objectContaining({
        sourceAdapterVersion: "codex-hook-signal-v1",
        sourceEventType: "turn_completed",
        externalTurnId: stoppedTurnId
      })
    );
    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
  });

  it("catches assistant records flushed after the Stop wake without another Hook signal", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const config = watcherConfig(root, { debounceMs: 5 });
    const watcher = trackedWatcher(client, config);

    // Activate before the transcript root exists so the later append cannot be
    // recovered by an exact filesystem notification in this regression.
    await watcher.scanNow();
    const transcript = transcriptPath(root, "rollout-post-stop-flush.jsonl");
    writeFileSync(
      transcript,
      line(sessionRecord("post-stop-flush")) + line(userRecord("question"))
    );
    await watcher.scanNow();

    signalCodexTranscriptWatcher(
      { KOED_HOME: config.koedHome },
      {
        sourceSessionId: "post-stop-flush",
        transcriptPath: transcript,
        turnBoundary: true
      }
    );
    await watcher.scanNow();

    appendFileSync(
      transcript,
      line(assistantResponseRecord("flushed after the Stop hook"))
    );

    await waitFor(() =>
      client.itemBatches
        .flat()
        .some((item) => item.rawText === "flushed after the Stop hook")
    );
  });

  it("polls an open turn until its terminal assistant records are flushed", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const config = watcherConfig(root, {
      debounceMs: 5,
      turnBoundarySettleMs: 10
    });
    const watcher = trackedWatcher(client, config);

    // Activate before the root exists so neither Hook nor filesystem delivery
    // can complete this turn after its initial user record is processed.
    await watcher.scanNow();
    const transcript = transcriptPath(root, "rollout-open-turn.jsonl");
    writeFileSync(
      transcript,
      line(sessionRecord("open-turn")) + line(userRecord("question"))
    );
    await watcher.scanNow();

    appendFileSync(
      transcript,
      line(assistantResponseRecord("terminal records without another wake")) +
        line(controlRecord())
    );

    await waitFor(() =>
      client.itemBatches
        .flat()
        .some(
          (item) => item.rawText === "terminal records without another wake"
        )
    );
    const artifact = client.artifacts.get("open-turn")!;
    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
  });

  it("discovers and completes a turn when Hook and filesystem signals are both missed", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const config = watcherConfig(root, {
      debounceMs: 5,
      pollMs: 10,
      turnBoundarySettleMs: 10
    });
    const watcher = trackedWatcher(client, config);

    // No root exists when filesystem hints are installed, and this test sends
    // no explicit watcher wake after activation.
    await watcher.scanNow();
    const transcript = transcriptPath(root, "rollout-missed-signals.jsonl");
    writeFileSync(
      transcript,
      line(sessionRecord("missed-signals")) + line(userRecord("question"))
    );
    await waitFor(() => client.artifacts.has("missed-signals"));

    appendFileSync(
      transcript,
      line(assistantResponseRecord("captured without signals")) +
        line(controlRecord())
    );

    await waitFor(() =>
      client.itemBatches
        .flat()
        .some((item) => item.rawText === "captured without signals")
    );
    const artifact = client.artifacts.get("missed-signals")!;
    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
  });

  it("detects mutation of an already journalled source range", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    const content =
      line(sessionRecord("mutated")) + line(userRecord("original"));
    writeFileSync(transcript, content);
    await watcher.scanNow();

    const mutated = content.replace("original", "tampered");
    writeFileSync(transcript, mutated);
    const changedAt = new Date(Date.now() + 2_000);
    utimesSync(transcript, changedAt, changedAt);
    await watcher.scanNow();

    expect(watcher.snapshot().lastErrorCode).toBe("transcript_prefix_mutated");
  });

  it("keeps provider durability ahead of canonical work after a crash boundary", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    let watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("restart")) + line(userRecord("resume me"))
    );
    client.failProjection = true;
    await watcher.scanNow();
    const artifact = client.artifacts.get("restart")!;
    await watcher.stop();
    watcherHandles.splice(watcherHandles.indexOf(watcher), 1);

    client.failProjection = false;
    watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();

    expect(client.segments.get(artifact.id)).toHaveLength(1);
    expect(client.cursors.get(artifact.id)?.sourceOffset).toBe(
      artifact.providerCursorOffset
    );
  });

  it("blocks source journalling before atomic source registration when Capture Policy disallows it", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    client.captureState = "ask";
    const watcher = trackedWatcher(client, watcherConfig(root));

    await watcher.scanNow();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("blocked")));
    await watcher.scanNow();

    expect(client.sessionCalls).toBe(0);
    expect(client.artifacts.size).toBe(0);
    expect(watcher.snapshot().lastErrorCode).toBe("capture_policy_blocked");
  });

  it("recovers source growth from a coalesced Hook wake without polling", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("periodic")));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(
      client,
      watcherConfig(root, {
        debounceMs: 5
      })
    );
    await watcher.scanNow();
    appendFileSync(transcript, line(userRecord("filesystem rescan")));
    watcher.wake();

    await waitFor(() => client.itemBatches.flat().length === 1);
  });

  it("prioritizes a newly created transcript from its filesystem event", async () => {
    const root = temporaryDirectory();
    mkdirSync(path.join(root, "codex", "sessions"), { recursive: true });
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(
      client,
      watcherConfig(root, {
        debounceMs: 5,
        maxEntriesPerScan: 1,
        maxFilesPerScan: 1
      })
    );
    await watcher.scanNow();

    for (let index = 0; index < 20; index += 1) {
      writeFileSync(
        transcriptPath(root, `rollout-baseline-${index}.jsonl`),
        line(
          sessionRecord(
            `baseline-${index}`,
            "/tmp/project",
            "2025-01-01T00:00:00.000Z"
          )
        )
      );
    }
    const transcript = transcriptPath(root, "rollout-live.jsonl");
    writeFileSync(
      transcript,
      line(sessionRecord("filesystem-live")) +
        line(userRecord("prioritize this live session"))
    );

    await waitFor(() => client.artifacts.has("filesystem-live"), 2_000);
    expect(
      client.itemBatches
        .flat()
        .some((item) => item.rawText === "prioritize this live session")
    ).toBe(true);
  });

  it("does not follow transcript symlinks outside configured roots", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const outsideTranscript = path.join(outside, "rollout-outside.jsonl");
    writeFileSync(outsideTranscript, line(sessionRecord("outside")));
    const link = transcriptPath(root, "rollout-link.jsonl");
    symlinkSync(outsideTranscript, link);
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));

    await watcher.scanNow();

    expect(client.artifacts.size).toBe(0);
  });

  it("writes bounded redacted diagnostic status with private permissions", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("status")));
    const client = new FakeWatcherClient();
    const config = watcherConfig(root);
    const watcher = trackedWatcher(client, config);
    await watcher.scanNow();
    await watcher.stop();
    watcherHandles.splice(watcherHandles.indexOf(watcher), 1);

    const statusPath = path.join(
      config.koedHome,
      "status",
      "codex-transcript-watcher.json"
    );
    const status = readFileSync(statusPath, "utf8");
    expect(status).not.toContain(transcript);
    expect(JSON.parse(status)).toMatchObject({
      state: "stopped",
      lastErrorCode: null
    });
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);
  });
});
