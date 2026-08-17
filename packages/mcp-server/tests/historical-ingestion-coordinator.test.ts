import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexHistoricalBatch,
  createCodexHistoricalProviderAdapter,
  type CodexHistoricalCandidate
} from "../src/codex-historical-ingestion.js";
import {
  startHistoricalIngestionCoordinator,
  type HistoricalProviderAdapter
} from "../src/historical-ingestion-coordinator.js";
import type { MemoryApiClient } from "../src/index.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "koed-history-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const candidate = (input: {
  id: string;
  latestActivityAt: string;
  transcriptStartedAt?: string;
  transcriptPath?: string;
}): CodexHistoricalCandidate => ({
  sourceSessionId: input.id,
  transcriptPath: input.transcriptPath ?? `/local-only/${input.id}.jsonl`,
  context: {
    threadKind: "conversation",
    transcriptSessionId: input.id,
    transcriptMetadata: {
      id: input.id,
      timestamp: input.transcriptStartedAt ?? input.latestActivityAt
    }
  },
  sourceSession: {
    externalSessionId: input.id,
    sourceRuntime: "codex-cli",
    captureMethod: "api",
    idempotencyKey: `session-${input.id}`,
    metadata: {}
  },
  frontierOffset: 100,
  frontierLine: 2,
  latestActivityAt: input.latestActivityAt,
  projectName: "Unassigned"
});

describe("automatic historical ingestion selection", () => {
  it("selects the newest 50 active Conversations then processes them chronologically", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const entries = Array.from({ length: 52 }, (_, index) =>
      candidate({
        id: `conversation-${String(index).padStart(2, "0")}`,
        latestActivityAt: new Date(
          now.getTime() - index * 12 * 60 * 60 * 1_000
        ).toISOString()
      })
    );
    entries.push(
      candidate({
        id: "exact-cutoff",
        latestActivityAt: new Date(
          now.getTime() - 30 * 24 * 60 * 60 * 1_000
        ).toISOString()
      }),
      candidate({
        id: "outside-window",
        latestActivityAt: new Date(
          now.getTime() - 30 * 24 * 60 * 60 * 1_000 - 1
        ).toISOString()
      }),
      candidate({
        id: "future",
        latestActivityAt: new Date(now.getTime() + 1).toISOString()
      })
    );
    const adapter = createCodexHistoricalProviderAdapter({
      client: {} as MemoryApiClient
    });

    const selected = adapter.selectCandidates(entries, now);

    expect(selected).toHaveLength(50);
    expect(selected.map((entry) => entry.latestActivityAt)).toEqual(
      [...selected]
        .map((entry) => entry.latestActivityAt)
        .sort((left, right) => left.localeCompare(right))
    );
    expect(selected.map((entry) => entry.candidateId)).not.toContain(
      "outside-window"
    );
    expect(selected.map((entry) => entry.candidateId)).not.toContain("future");
    expect(JSON.stringify(selected)).not.toContain("/local-only/");
  });

  it("uses latest activity so a long-running Conversation remains eligible", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const adapter = createCodexHistoricalProviderAdapter({
      client: {} as MemoryApiClient
    });
    const selected = adapter.selectCandidates(
      [
        candidate({
          id: "long-running",
          transcriptStartedAt: "2025-01-01T00:00:00.000Z",
          latestActivityAt: "2026-08-16T00:00:00.000Z"
        })
      ],
      now
    );

    expect(selected.map((entry) => entry.candidateId)).toEqual([
      "long-running"
    ]);
  });

  it("includes the exact 30-day boundary and excludes one millisecond older", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1_000;
    const adapter = createCodexHistoricalProviderAdapter({
      client: {} as MemoryApiClient
    });

    const selected = adapter.selectCandidates(
      [
        candidate({
          id: "at-cutoff",
          latestActivityAt: new Date(cutoff).toISOString()
        }),
        candidate({
          id: "before-cutoff",
          latestActivityAt: new Date(cutoff - 1).toISOString()
        })
      ],
      now
    );

    expect(selected.map((entry) => entry.candidateId)).toEqual(["at-cutoff"]);
  });

  it("breaks equal-activity ties by stable Conversation identity", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const adapter = createCodexHistoricalProviderAdapter({
      client: {} as MemoryApiClient
    });
    const selected = adapter.selectCandidates(
      ["zeta", "alpha", "middle"].map((id) =>
        candidate({ id, latestActivityAt: "2026-08-17T00:00:00.000Z" })
      ),
      now
    );

    expect(selected.map((entry) => entry.candidateId)).toEqual([
      "alpha",
      "middle",
      "zeta"
    ]);
  });
});

describe("bounded Codex historical parsing", () => {
  const source = {
    id: "source-1",
    runId: "run-1",
    artifactId: "artifact-1",
    sessionId: "11111111-1111-4111-8111-111111111111",
    sourceSessionId: "source-session-1",
    sourceFingerprint: "a".repeat(64),
    historicalCursorOffset: 0,
    historicalCursorLine: 0,
    registrationFrontierOffset: 1_000,
    state: "importing"
  };
  const selection = {
    aiClient: "codex",
    candidateId: "source-session-1",
    frontierOffset: 1_000,
    frontierLine: 10,
    latestActivityAt: "2026-08-17T00:00:00.000Z",
    adapterState: { threadKind: "conversation" }
  };

  it("skips malformed complete records while advancing a resumable checkpoint", () => {
    const valid = JSON.stringify({
      timestamp: "2026-08-17T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "remember this" }
    });
    const bytes = Buffer.from(`{malformed}\n${valid}\n`);

    const batch = buildCodexHistoricalBatch({
      bytes,
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      prior: {},
      source,
      selection,
      config: {
        maxBatchRows: 100,
        maxBatchBytes: 100_000,
        maxBatchRuntimeMs: 15_000,
        maxJournalBytesPerBatch: 100_000
      }
    });

    expect(batch).toMatchObject({
      bytesConsumed: bytes.byteLength,
      sourceLine: 2,
      malformedRecordCount: 1,
      parserState: { lastEventTime: "2026-08-17T00:00:01.000Z" }
    });
    expect(batch.items.map((item) => item.rawText)).toEqual(["remember this"]);
  });

  it("yields on the row cap only after a complete record", () => {
    const lines = ["first", "second"].map((message, index) =>
      JSON.stringify({
        timestamp: `2026-08-17T00:00:0${index + 1}.000Z`,
        type: "event_msg",
        payload: { type: "user_message", message }
      })
    );
    const firstRecordBytes = Buffer.byteLength(`${lines[0]}\n`);

    const batch = buildCodexHistoricalBatch({
      bytes: Buffer.from(`${lines.join("\n")}\n`),
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      prior: {},
      source,
      selection,
      config: {
        maxBatchRows: 1,
        maxBatchBytes: 100_000,
        maxBatchRuntimeMs: 15_000,
        maxJournalBytesPerBatch: 100_000
      }
    });

    expect(batch.bytesConsumed).toBe(firstRecordBytes);
    expect(batch.sourceLine).toBe(1);
    expect(batch.items.map((item) => item.rawText)).toEqual(["first"]);
  });

  it("yields on byte and runtime caps only after complete records", () => {
    const lines = ["first bounded record", "second bounded record"].map(
      (message, index) =>
        JSON.stringify({
          timestamp: `2026-08-17T00:00:0${index + 1}.000Z`,
          type: "event_msg",
          payload: { type: "user_message", message }
        })
    );
    const bytes = Buffer.from(`${lines.join("\n")}\n`);
    const firstRecordBytes = Buffer.byteLength(`${lines[0]}\n`);
    const baseConfig = {
      maxBatchRows: 100,
      maxBatchBytes: 100_000,
      maxBatchRuntimeMs: 15_000,
      maxJournalBytesPerBatch: 100_000
    };
    const first = buildCodexHistoricalBatch({
      bytes: bytes.subarray(0, firstRecordBytes),
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      prior: {},
      source,
      selection,
      config: baseConfig
    });
    const exactFirstPayloadBytes = Buffer.byteLength(
      JSON.stringify(first.items),
      "utf8"
    );

    const byteBounded = buildCodexHistoricalBatch({
      bytes,
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      prior: {},
      source,
      selection,
      config: { ...baseConfig, maxBatchBytes: exactFirstPayloadBytes }
    });
    let clockCalls = 0;
    const runtimeBounded = buildCodexHistoricalBatch({
      bytes,
      absoluteStartOffset: 0,
      lineIndexOffset: 0,
      prior: {},
      source,
      selection,
      config: { ...baseConfig, maxBatchRuntimeMs: 100 },
      now: () => (clockCalls++ === 0 ? 0 : 100)
    });

    expect(byteBounded.bytesConsumed).toBe(firstRecordBytes);
    expect(runtimeBounded.bytesConsumed).toBe(firstRecordBytes);
  });
});

describe("provider-neutral historical ingestion coordination", () => {
  it("finishes selected source ranges in chronological order", async () => {
    const koedHome = temporaryDirectory();
    const attempts = new Map<string, number>();
    const calls: string[] = [];
    const adapter: HistoricalProviderAdapter<{ id: string }> = {
      aiClient: "ordered-provider",
      candidateId: (entry) => entry.id,
      selectCandidates: (entries) =>
        entries.map((entry, index) => ({
          aiClient: "ordered-provider",
          candidateId: entry.id,
          frontierOffset: 40,
          frontierLine: 2,
          latestActivityAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
        })),
      async processNextBatch({ selection }) {
        calls.push(selection.candidateId);
        const attempt = (attempts.get(selection.candidateId) ?? 0) + 1;
        attempts.set(selection.candidateId, attempt);
        return {
          state: attempt === 1 ? "progress" : "completed",
          selection,
          runId: "run-ordered"
        };
      },
      completeRun: async () => undefined
    };
    const coordinator = startHistoricalIngestionCoordinator({
      adapter,
      koedHome,
      retryMs: 60_000
    });

    coordinator.offerCandidates([{ id: "oldest" }, { id: "newest" }]);
    await vi.waitFor(() =>
      expect(coordinator.snapshot().runCompleted).toBe(true)
    );

    expect(calls).toEqual(["oldest", "oldest", "newest", "newest"]);
    await coordinator.stop();
  });

  it("persists path-free frozen selection and resumes without reprocessing a completed run", async () => {
    const koedHome = temporaryDirectory();
    const processed: string[] = [];
    let completedRuns = 0;
    type Offered = { id: string; localPath: string };
    const adapter: HistoricalProviderAdapter<Offered> = {
      aiClient: "test-provider",
      candidateId: (entry) => entry.id,
      selectCandidates: (entries) =>
        entries.map((entry) => ({
          aiClient: "test-provider",
          candidateId: entry.id,
          frontierOffset: 40,
          frontierLine: 2,
          latestActivityAt: "2026-08-17T00:00:00.000Z"
        })),
      async processNextBatch({ candidate, selection }) {
        expect(candidate?.localPath).toBe("/private/transcript.jsonl");
        processed.push(selection.candidateId);
        return { state: "completed", selection, runId: "run-1" };
      },
      async completeRun(runId) {
        expect(runId).toBe("run-1");
        completedRuns += 1;
      }
    };
    const coordinator = startHistoricalIngestionCoordinator({
      adapter,
      koedHome,
      retryMs: 60_000
    });

    coordinator.offerCandidates([
      { id: "conversation-1", localPath: "/private/transcript.jsonl" }
    ]);
    await vi.waitFor(() => expect(completedRuns).toBe(1));
    const statePath = path.join(
      koedHome,
      "state",
      "test-provider-historical-ingestion.json"
    );
    expect(readFileSync(statePath, "utf8")).not.toContain("/private/");
    expect(coordinator.snapshot()).toMatchObject({
      selectionFrozen: true,
      runCompleted: true,
      runId: "run-1"
    });
    await coordinator.stop();

    const restarted = startHistoricalIngestionCoordinator({
      adapter,
      koedHome,
      retryMs: 60_000
    });
    restarted.offerCandidates([
      { id: "conversation-1", localPath: "/private/transcript.jsonl" }
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(processed).toEqual(["conversation-1"]);
    expect(completedRuns).toBe(1);
    await restarted.stop();
  });
});
