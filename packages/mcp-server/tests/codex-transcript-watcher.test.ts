import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryApiError } from "../src/index.js";
import {
  completeTranscriptBoundary,
  hashFilePrefixSentinels,
  signalCodexTranscriptWatcher,
  startCodexTranscriptWatcher,
  type CodexTranscriptWatcherClient,
  type CodexTranscriptWatcherConfig
} from "../src/codex-transcript-watcher.js";

const temporaryDirectories: string[] = [];
const watcherHandles: Array<ReturnType<typeof startCodexTranscriptWatcher>> =
  [];
const trackedWatcher = (
  client: CodexTranscriptWatcherClient,
  config: CodexTranscriptWatcherConfig
) => {
  const watcher = startCodexTranscriptWatcher(client, config);
  watcherHandles.push(watcher);
  return watcher;
};
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
const sessionRecord = (sessionId: string, cwd = "/tmp/project") => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "session_meta",
  payload: { id: sessionId, cwd, timestamp: "2026-01-01T00:00:00.000Z" }
});
const userRecord = (message: string, second = 1) => ({
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
  type: "event_msg",
  payload: { type: "user_message", message }
});
const controlRecord = (second = 2) => ({
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
  type: "turn_context",
  payload: { turn_id: `turn-${second}` }
});

interface Source {
  id: string;
  runId: string;
  sourceSessionId: string;
  sourceFingerprint: string;
  registrationFrontierOffset: number;
  registrationPrefixHash: string;
  liveCursorOffset: number;
  liveCursorLine: number;
  liveCursorHash: string | null;
  sourceSizeBytes: number;
  sourceModifiedAt: string | null;
  localSourcePath: string;
  detectedProject: Record<string, unknown>;
}

class FakeWatcherClient implements CodexTranscriptWatcherClient {
  readonly sources = new Map<string, Source>();
  readonly itemBatches: Array<Array<Record<string, unknown>>> = [];
  readonly cursorWrites: Array<Record<string, unknown>> = [];
  policyEnabled = true;
  captureState: "enabled" | "disabled" | "ask" = "enabled";
  policyPaused = false;
  policyVisibility = "personal";
  readonly policyRequests: Array<Record<string, unknown>> = [];
  sessionCalls = 0;
  failProjection = false;
  afterCreateItems?: () => void;
  private nextItem = 0;

  async accessCheck() {
    return { user: { id: "user-1" } };
  }

  async createHistoricalImportRun() {
    return { run: { id: "11111111-1111-4111-8111-111111111111" } };
  }

  async lookupHistoricalImportSource(input: { sourceSessionId: string }) {
    const source = this.sources.get(input.sourceSessionId);
    if (!source) {
      throw new MemoryApiError("not found", { status: 404 });
    }
    return { source };
  }

  async createHistoricalImportSource(input: Record<string, unknown>) {
    const sourceSessionId = String(input.sourceSessionId);
    const existing = this.sources.get(sourceSessionId);
    if (existing) {
      existing.sourceSizeBytes = Number(input.sourceSizeBytes);
      existing.sourceModifiedAt =
        typeof input.sourceModifiedAt === "string"
          ? input.sourceModifiedAt
          : existing.sourceModifiedAt;
      existing.localSourcePath = String(input.localSourcePath);
      return { source: existing };
    }
    const frontier = Number(input.registrationFrontierOffset);
    const source: Source = {
      id: `source-${this.sources.size + 1}`,
      runId: String(input.runId),
      sourceSessionId,
      sourceFingerprint: String(input.sourceFingerprint),
      registrationFrontierOffset: frontier,
      registrationPrefixHash: String(input.registrationPrefixHash),
      liveCursorOffset: frontier,
      liveCursorLine: 0,
      liveCursorHash:
        frontier === 0 ? null : String(input.registrationPrefixHash),
      sourceSizeBytes: Number(input.sourceSizeBytes),
      sourceModifiedAt:
        typeof input.sourceModifiedAt === "string"
          ? input.sourceModifiedAt
          : null,
      localSourcePath: String(input.localSourcePath),
      detectedProject: (input.detectedProject ?? {}) as Record<string, unknown>
    };
    this.sources.set(sourceSessionId, source);
    return { source };
  }

  async observeHistoricalImportSource(
    sourceId: string,
    input: Record<string, unknown>
  ) {
    const source = [...this.sources.values()].find(
      (item) => item.id === sourceId
    )!;
    source.localSourcePath = String(input.localSourcePath);
    source.sourceSizeBytes = Number(input.sourceSizeBytes);
    source.sourceModifiedAt =
      typeof input.sourceModifiedAt === "string"
        ? input.sourceModifiedAt
        : source.sourceModifiedAt;
    return { source };
  }

  async advanceLiveTranscriptCursor(
    sourceId: string,
    input: Record<string, unknown>
  ) {
    const source = [...this.sources.values()].find(
      (item) => item.id === sourceId
    )!;
    source.liveCursorOffset = Number(input.cursorOffset);
    source.liveCursorLine = Number(input.cursorLine);
    source.liveCursorHash = String(input.cursorHash);
    source.sourceSizeBytes = Number(input.sourceSizeBytes);
    this.cursorWrites.push(input);
    return { source };
  }

  async effectiveCapturePolicy(input: Record<string, unknown> = {}) {
    this.policyRequests.push(input);
    return {
      policy: {
        captureState: this.policyEnabled ? this.captureState : "disabled",
        visibility: this.policyVisibility,
        paused: !this.policyEnabled || this.policyPaused
      }
    };
  }

  async createSession() {
    this.sessionCalls += 1;
    if (
      !this.policyEnabled ||
      this.captureState !== "enabled" ||
      this.policyPaused ||
      this.policyVisibility !== "personal"
    ) {
      return { skipped: true };
    }
    return { session: { id: "22222222-2222-4222-8222-222222222222" } };
  }

  async createConversationItems(input: Record<string, unknown>) {
    const items = input.items as Array<Record<string, unknown>>;
    this.itemBatches.push(items);
    this.afterCreateItems?.();
    return {
      items: items.map((item) => ({ ...item, id: `item-${++this.nextItem}` }))
    };
  }

  async projectConversationItems() {
    if (this.failProjection) throw new Error("projection unavailable");
    return {};
  }
}

const watcherConfig = (root: string): CodexTranscriptWatcherConfig => ({
  roots: [path.join(root, "codex", "sessions")],
  koedHome: path.join(root, "koed"),
  rescanIntervalMs: 60_000,
  debounceMs: 60_000,
  maxEntriesPerScan: 1_000,
  maxFilesPerScan: 100,
  maxBytesPerBatch: 64 * 1024
});

const transcriptPath = (root: string): string => {
  const directory = path.join(root, "codex", "sessions", "2026", "01", "01");
  fsMkdir(directory);
  return path.join(directory, "rollout-test.jsonl");
};

const fsMkdir = (directory: string): void => {
  mkdirSync(directory, { recursive: true });
};

describe("Codex Transcript Watcher", () => {
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

  it("skips boundary reads for unchanged transcript observations", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-unchanged")));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const readSync = vi.spyOn(fs, "readSync");

    await watcher.scanNow();

    expect(readSync).not.toHaveBeenCalled();
    readSync.mockRestore();
  });

  it("registers an existing source at complete frontier then captures append without Hook", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-existing")));
    const frontier = completeTranscriptBoundary(transcript);
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));

    await watcher.scanNow();
    expect(
      client.sources.get("session-existing")?.registrationFrontierOffset
    ).toBe(frontier);
    expect(client.itemBatches).toHaveLength(0);

    appendFileSync(transcript, line(userRecord("captured without hook")));
    await watcher.scanNow();

    const source = client.sources.get("session-existing")!;
    expect(source.liveCursorOffset).toBe(
      completeTranscriptBoundary(transcript)
    );
    expect(watcher.snapshot().bytesAdvanced).toBe(
      completeTranscriptBoundary(transcript) - frontier
    );
    expect(client.itemBatches.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTransport: "transcript",
          externalSessionId: "session-existing"
        })
      ])
    );
    await watcher.stop();
  });

  it("persists an incomplete activation frontier and captures its first complete records", async () => {
    const root = temporaryDirectory();
    const config = watcherConfig(root);
    const badPath = path.join(config.roots[0]!, "rollout-malformed.jsonl");
    fsMkdir(path.dirname(badPath));
    writeFileSync(badPath, "not-json");
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, config);

    await watcher.scanNow();
    expect(watcher.snapshot().state).toBe("running");

    const newTranscript = transcriptPath(root);
    writeFileSync(
      newTranscript,
      line(sessionRecord("session-after-malformed")) + line(userRecord("live"))
    );
    await watcher.scanNow();
    expect(
      client.sources.get("session-after-malformed")?.registrationFrontierOffset
    ).toBe(0);

    await watcher.stop();
    const restarted = trackedWatcher(client, config);
    writeFileSync(
      badPath,
      line(sessionRecord("session-baseline-recovery")) +
        line(userRecord("first live record"))
    );
    await restarted.scanNow();
    expect(
      client.sources.get("session-baseline-recovery")
        ?.registrationFrontierOffset
    ).toBe(0);
    expect(client.itemBatches.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalSessionId: "session-baseline-recovery"
        })
      ])
    );
  });

  it("keeps a boundary-failing baseline file historical after recovery", async () => {
    const root = temporaryDirectory();
    const config = watcherConfig(root);
    const transcript = path.join(config.roots[0]!, "rollout-oversized.jsonl");
    fsMkdir(path.dirname(transcript));
    writeFileSync(transcript, Buffer.alloc(16 * 1024 * 1024 + 2, "x"));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, config);

    await watcher.scanNow();
    expect(watcher.snapshot().state).toBe("running");

    writeFileSync(
      transcript,
      line(sessionRecord("session-oversized-recovery"))
    );
    await watcher.scanNow();
    expect(
      client.sources.get("session-oversized-recovery")
        ?.registrationFrontierOffset
    ).toBe(completeTranscriptBoundary(transcript));
  });

  it("persists a verified same-session path after rename and restart", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-moved")));
    const client = new FakeWatcherClient();
    const config = watcherConfig(root);
    const watcher = trackedWatcher(client, config);
    await watcher.scanNow();
    const source = client.sources.get("session-moved")!;
    const frontier = source.registrationFrontierOffset;

    const moved = path.join(path.dirname(transcript), "rollout-moved.jsonl");
    renameSync(transcript, moved);
    await watcher.scanNow();
    expect(source.localSourcePath).toBe(moved);
    expect(source.registrationFrontierOffset).toBe(frontier);
    await watcher.stop();

    appendFileSync(moved, line(userRecord("after restart")));
    const restarted = trackedWatcher(client, config);
    await restarted.scanNow();
    expect(source.localSourcePath).toBe(moved);
    expect(source.liveCursorOffset).toBe(completeTranscriptBoundary(moved));
  });

  it("captures a source created after activation from its first complete record", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const config = watcherConfig(root);
    const watcher = trackedWatcher(client, config);
    await watcher.scanNow();

    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("session-new")) + line(userRecord("first record"))
    );
    await watcher.scanNow();

    const source = client.sources.get("session-new")!;
    expect(source.registrationFrontierOffset).toBe(0);
    expect(source.liveCursorOffset).toBe(
      completeTranscriptBoundary(transcript)
    );
    expect(client.itemBatches.flat().length).toBeGreaterThanOrEqual(2);
    await watcher.stop();
  });

  it("resumes bounded held-record resolution beyond 16 MiB after restart", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-held-page")));
    const client = new FakeWatcherClient();
    const maxBytesPerBatch = 8 * 1024 * 1024;
    const assistant = line({
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "held answer" }
    });
    const filler = line({
      timestamp: "2026-01-01T00:00:01.500Z",
      type: "event_msg",
      payload: { type: "token_count", data: "x".repeat(1024 * 1024 - 200) }
    });
    const resolver = line({
      timestamp: "2026-01-01T00:00:02.000Z",
      type: "response_item",
      payload: {
        id: "held-answer-id",
        type: "message",
        role: "assistant",
        turn_id: "held-answer-turn",
        content: [{ type: "output_text", text: "held answer" }]
      }
    });
    const config = { ...watcherConfig(root), maxBytesPerBatch };
    let watcher = trackedWatcher(client, config);
    await watcher.scanNow();
    const frontier = client.sources.get("session-held-page")!.liveCursorOffset;
    appendFileSync(transcript, assistant + filler.repeat(17) + resolver);
    expect(completeTranscriptBoundary(transcript) - frontier).toBeGreaterThan(
      16 * 1024 * 1024
    );

    const readVolume = async () => {
      const reads = vi.spyOn(fs, "readSync");
      await watcher.scanNow();
      const bytes = reads.mock.calls.map((call) => call[1].byteLength);
      reads.mockRestore();
      expect(Math.max(...bytes)).toBeLessThanOrEqual(maxBytesPerBatch);
    };
    await readVolume();
    await readVolume();
    await watcher.stop();

    const state = readFileSync(
      path.join(root, "koed", "state", "codex-transcript-watcher.json"),
      "utf8"
    );
    expect(state).toContain("resolverProgress");
    expect(state).not.toContain(transcript);
    expect(state).not.toContain("held answer");

    watcher = trackedWatcher(client, config);
    for (let index = 0; index < 6; index += 1) {
      await readVolume();
    }
    expect(client.sources.get("session-held-page")!.liveCursorOffset).toBe(
      completeTranscriptBoundary(transcript)
    );
    expect(watcher.snapshot().bytesAdvanced).toBeGreaterThan(frontier);
  });

  it("holds partial and malformed appends without cursor corruption", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-partial")));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const frontier = client.sources.get("session-partial")!.liveCursorOffset;

    const completedLater = line(userRecord("completed later"));
    const splitAt = Math.floor(completedLater.length / 2);
    appendFileSync(transcript, completedLater.slice(0, splitAt));
    await watcher.scanNow();
    expect(client.sources.get("session-partial")!.liveCursorOffset).toBe(
      frontier
    );

    appendFileSync(transcript, completedLater.slice(splitAt));
    await watcher.scanNow();
    const completedCursor =
      client.sources.get("session-partial")!.liveCursorOffset;
    expect(completedCursor).toBeGreaterThan(frontier);

    appendFileSync(transcript, "not-json\n");
    await watcher.scanNow();
    expect(client.sources.get("session-partial")!.liveCursorOffset).toBe(
      completedCursor
    );
    expect(watcher.snapshot().lastErrorCode).toBe(
      "transcript_malformed_record"
    );
    await watcher.stop();
  });

  it("leaves cursor unchanged when policy or Projection blocks a batch", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-policy")));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const frontier = client.sources.get("session-policy")!.liveCursorOffset;

    client.policyEnabled = false;
    appendFileSync(transcript, line(userRecord("blocked")));
    await watcher.scanNow();
    expect(client.sources.get("session-policy")!.liveCursorOffset).toBe(
      frontier
    );

    client.policyEnabled = true;
    client.failProjection = true;
    await watcher.scanNow();
    expect(client.sources.get("session-policy")!.liveCursorOffset).toBe(
      frontier
    );

    client.failProjection = false;
    await watcher.scanNow();
    expect(
      client.sources.get("session-policy")!.liveCursorOffset
    ).toBeGreaterThan(frontier);
    await watcher.stop();
  });

  it("rejects mutation of parsed bytes during a write batch", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-race")));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const frontier = client.sources.get("session-race")!.liveCursorOffset;
    appendFileSync(transcript, line(userRecord("before mutation")));
    client.afterCreateItems = () => {
      client.afterCreateItems = undefined;
      const content = Buffer.from(readTranscript(transcript));
      content[frontier + 1] = content[frontier + 1] === 0x22 ? 0x20 : 0x22;
      writeFileSync(transcript, content);
    };

    await watcher.scanNow();

    expect(client.sources.get("session-race")!.liveCursorOffset).toBe(frontier);
    expect(watcher.snapshot().lastErrorCode).toBe(
      "transcript_mutated_during_batch"
    );
  });

  it("resumes from durable live cursor and rejects prefix mutation", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-restart")));
    const client = new FakeWatcherClient();
    const config = watcherConfig(root);
    const first = trackedWatcher(client, config);
    await first.scanNow();
    appendFileSync(transcript, line(userRecord("one")));
    await first.scanNow();
    await first.stop();
    const durableOffset =
      client.sources.get("session-restart")!.liveCursorOffset;

    appendFileSync(transcript, line(controlRecord(3)));
    const restarted = trackedWatcher(client, config);
    await restarted.scanNow();
    expect(client.cursorWrites.at(-1)?.expectedCursorOffset).toBe(
      durableOffset
    );

    const content = Buffer.from(readTranscript(transcript));
    content[0] = content[0] === 0x7b ? 0x5b : 0x7b;
    writeFileSync(transcript, content);
    appendFileSync(transcript, line(controlRecord(4)));
    const beforeMutationScan =
      client.sources.get("session-restart")!.liveCursorOffset;
    await restarted.scanNow();
    expect(client.sources.get("session-restart")!.liveCursorOffset).toBe(
      beforeMutationScan
    );
    expect(restarted.snapshot().lastErrorCode).toBe(
      "transcript_prefix_mutated"
    );
    await restarted.stop();
  });

  it("rejects a transcript smaller than its durable source observation", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    const content =
      line(sessionRecord("session-shrunk")) + "incomplete-record!";
    writeFileSync(transcript, content);
    expect(statSync(transcript).size).toBe(175);
    const client = new FakeWatcherClient();
    client.sources.set("session-shrunk", {
      id: "source-shrunk",
      runId: "11111111-1111-4111-8111-111111111111",
      sourceSessionId: "session-shrunk",
      sourceFingerprint: "1".repeat(64),
      registrationFrontierOffset: 0,
      registrationPrefixHash: "0".repeat(64),
      liveCursorOffset: 150,
      liveCursorLine: 1,
      liveCursorHash: "2".repeat(64),
      sourceSizeBytes: 200,
      sourceModifiedAt: null,
      localSourcePath: transcript,
      detectedProject: {}
    });
    const watcher = trackedWatcher(client, watcherConfig(root));

    await watcher.scanNow();

    expect(client.sources.get("session-shrunk")).toMatchObject({
      sourceSizeBytes: 200,
      liveCursorOffset: 150
    });
    expect(client.cursorWrites).toHaveLength(0);
    expect(watcher.snapshot().lastErrorCode).toBe("transcript_truncated");
  });

  it("rejects a mid-page truncation below its initial complete boundary", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    const sessionId = "session-mid-page-truncation";
    writeFileSync(transcript, line(sessionRecord(sessionId)));
    const frontier = completeTranscriptBoundary(transcript);
    const prefixHash = await hashFilePrefixSentinels(transcript, frontier);
    const client = new FakeWatcherClient();
    client.sources.set(sessionId, {
      id: "source-mid-page-truncation",
      runId: "11111111-1111-4111-8111-111111111111",
      sourceSessionId: sessionId,
      sourceFingerprint: "1".repeat(64),
      registrationFrontierOffset: frontier,
      registrationPrefixHash: prefixHash,
      liveCursorOffset: frontier,
      liveCursorLine: 1,
      liveCursorHash: prefixHash,
      sourceSizeBytes: frontier,
      sourceModifiedAt: null,
      localSourcePath: transcript,
      detectedProject: {}
    });
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();

    appendFileSync(
      transcript,
      Array.from({ length: 200 }, (_, index) =>
        line(userRecord("x".repeat(1_000), index + 1))
      ).join("")
    );
    const boundary = completeTranscriptBoundary(transcript);
    expect(boundary).toBeGreaterThan(128 * 1024);
    client.afterCreateItems = () => {
      writeFileSync(
        transcript,
        readFileSync(transcript).subarray(0, 100 * 1024)
      );
    };

    await watcher.scanNow();

    expect(statSync(transcript).size).toBeLessThan(boundary);
    expect(client.cursorWrites).toHaveLength(0);
    expect(client.sources.get(sessionId)).toMatchObject({
      sourceSizeBytes: frontier,
      liveCursorOffset: frontier
    });
    expect(watcher.snapshot().lastErrorCode).toBe("transcript_truncated");
  });

  it("detects truncation and treats inode rotation as a new live source", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-rotate")));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    appendFileSync(transcript, line(userRecord("captured")));
    await watcher.scanNow();
    const cursor = client.sources.get("session-rotate")!.liveCursorOffset;

    writeFileSync(transcript, line(sessionRecord("session-rotate")));
    await watcher.scanNow();
    expect(client.sources.get("session-rotate")!.liveCursorOffset).toBe(cursor);
    expect(watcher.snapshot().lastErrorCode).toMatch(
      /historical|transcript_truncated/
    );

    const replacement = `${transcript}.replacement`;
    writeFileSync(
      replacement,
      line(sessionRecord("session-replacement")) + line(userRecord("new"))
    );
    renameSync(replacement, transcript);
    await watcher.scanNow();
    expect(
      client.sources.get("session-replacement")?.registrationFrontierOffset
    ).toBe(0);
    expect(client.sources.get("session-replacement")!.liveCursorOffset).toBe(
      completeTranscriptBoundary(transcript)
    );
    await watcher.stop();
  });

  it("recovers an append through periodic rescan without scanNow or Hook", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-periodic")));
    const client = new FakeWatcherClient();
    const config = {
      ...watcherConfig(root),
      rescanIntervalMs: 20,
      debounceMs: 5
    };
    const watcher = trackedWatcher(client, config);
    await watcher.scanNow();
    const frontier = client.sources.get("session-periodic")!.liveCursorOffset;

    appendFileSync(transcript, line(userRecord("timer recovery")));
    await waitFor(
      () =>
        (client.sources.get("session-periodic")?.liveCursorOffset ?? 0) >
        frontier
    );
    expect(client.itemBatches.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceTransport: "transcript" })
      ])
    );
  });

  it("keeps post-activation source live across watcher restart", async () => {
    const root = temporaryDirectory();
    const client = new FakeWatcherClient();
    const config = watcherConfig(root);
    const first = trackedWatcher(client, config);
    await first.scanNow();
    await first.stop();

    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("session-after-stop")) + line(userRecord("live"))
    );
    const restarted = trackedWatcher(client, config);
    await restarted.scanNow();

    const source = client.sources.get("session-after-stop")!;
    expect(source.registrationFrontierOffset).toBe(0);
    expect(source.liveCursorOffset).toBe(
      completeTranscriptBoundary(transcript)
    );
  });

  it("continues bounded discovery across scans without following symlinks", async () => {
    const root = temporaryDirectory();
    const config = {
      ...watcherConfig(root),
      maxEntriesPerScan: 2,
      maxFilesPerScan: 1
    };
    for (const [index, sessionId] of ["one", "two", "three"].entries()) {
      const directory = path.join(config.roots[0]!, String(index));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, `rollout-${index}.jsonl`),
        line(sessionRecord(`session-${sessionId}`))
      );
    }
    const outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const outsideTranscript = path.join(outside, "rollout-outside.jsonl");
    writeFileSync(outsideTranscript, line(sessionRecord("session-outside")));
    symlinkSync(
      outsideTranscript,
      path.join(config.roots[0]!, "rollout-link.jsonl")
    );

    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, config);
    for (
      let attempt = 0;
      attempt < 20 && client.sources.size < 3;
      attempt += 1
    ) {
      await watcher.scanNow();
    }
    expect([...client.sources.keys()].sort()).toEqual([
      "session-one",
      "session-three",
      "session-two"
    ]);
    expect(client.sources.has("session-outside")).toBe(false);
  });

  it("uses retained project ID for Capture Policy when transcript has no cwd", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(
      transcript,
      line(sessionRecord("session-project-policy", ""))
    );
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    const source = client.sources.get("session-project-policy")!;
    source.detectedProject = { projectId: "project-policy-id" };
    client.captureState = "disabled";
    appendFileSync(transcript, line(userRecord("blocked by project policy")));
    await watcher.scanNow();

    expect(client.policyRequests.at(-1)).toMatchObject({
      projectId: "project-policy-id"
    });
    expect(client.sessionCalls).toBe(0);
    expect(source.liveCursorOffset).toBe(source.registrationFrontierOffset);
  });

  it("blocks ask, pause, and non-personal policy before session creation", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-policy-states")));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    appendFileSync(transcript, line(userRecord("blocked states")));

    client.captureState = "ask";
    await watcher.scanNow();
    client.captureState = "enabled";
    client.policyPaused = true;
    await watcher.scanNow();
    client.policyPaused = false;
    client.policyVisibility = "team";
    await watcher.scanNow();

    expect(client.sessionCalls).toBe(0);
    expect(client.cursorWrites).toHaveLength(0);
  });

  it("writes bounded redacted diagnostic status with private permissions", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-status")));
    const client = new FakeWatcherClient();
    const watcher = trackedWatcher(client, watcherConfig(root));
    await watcher.scanNow();
    await watcher.stop();

    const statusPath = path.join(
      root,
      "koed",
      "status",
      "codex-transcript-watcher.json"
    );
    const status = readFileSync(statusPath, "utf8");
    expect(status).not.toContain(root);
    expect(status).not.toContain("session-status");
    expect(status).not.toContain("watcher-token");
    const snapshot = JSON.parse(status) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      state: "stopped",
      lastErrorCode: null
    });
    expect(typeof snapshot.scans).toBe("number");
    expect(typeof snapshot.filesDiscovered).toBe("number");
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);
  });

  it("coalesces content-free Hook wake hints under isolated KOED_HOME", () => {
    const root = temporaryDirectory();
    const env = { KOED_HOME: path.join(root, "koed") };
    signalCodexTranscriptWatcher(env);
    signalCodexTranscriptWatcher(env);
    const wake = readFileSync(
      path.join(root, "koed", "run", "codex-transcript-watcher.wake"),
      "utf8"
    );
    expect(wake).toMatch(/^\d+\n$/);
    expect(wake).not.toContain(root);
  });

  it("computes bounded cursor prefix sentinels", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    writeFileSync(transcript, line(sessionRecord("session-hash")) + "partial");
    const boundary = completeTranscriptBoundary(transcript);
    expect(boundary).toBeLessThan(readTranscript(transcript).length);
    expect(await hashFilePrefixSentinels(transcript, 0)).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(await hashFilePrefixSentinels(transcript, boundary)).toMatch(
      /^[0-9a-f]{64}$/
    );
  });

  it("intentionally does not detect middle-prefix mutations outside sentinels", async () => {
    const root = temporaryDirectory();
    const transcript = transcriptPath(root);
    const content = Buffer.alloc(512 * 1024, "x");
    content[content.length - 1] = 0x0a;
    writeFileSync(transcript, content);
    const before = await hashFilePrefixSentinels(transcript, content.length);

    content[Math.floor(content.length / 2)] = 0x79;
    writeFileSync(transcript, content);

    expect(await hashFilePrefixSentinels(transcript, content.length)).toBe(
      before
    );
  });
});

const readTranscript = (transcript: string): string =>
  readFileSync(transcript, "utf8");
