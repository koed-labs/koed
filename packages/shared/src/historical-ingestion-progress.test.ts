import { describe, expect, it } from "vitest";
import {
  HISTORICAL_INGESTION_STALE_MS,
  summarizeHistoricalIngestionState
} from "./historical-ingestion-progress.js";

const now = Date.parse("2026-11-03T12:00:00Z");
const at = (msAgo: number) => new Date(now - msAgo).toISOString();
const state = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  selectionFrozen: true,
  runCompleted: false,
  selections: [
    { candidateId: "a", terminalState: "completed" },
    { candidateId: "b", terminalState: "skipped" },
    { candidateId: "c" }
  ],
  progress: { updatedAt: at(1_000), lastBatchState: "progress" },
  ...overrides
});

describe("summarizeHistoricalIngestionState", () => {
  it("is unknown without a readable, frozen selection", () => {
    expect(summarizeHistoricalIngestionState(undefined, now)).toMatchObject({
      lifecycle: "unknown",
      selected: null
    });
    expect(
      summarizeHistoricalIngestionState(state({ selectionFrozen: false }), now)
        .lifecycle
    ).toBe("unknown");
  });

  it("counts completed and skipped Conversations separately", () => {
    expect(summarizeHistoricalIngestionState(state(), now)).toEqual({
      lifecycle: "running",
      selected: 3,
      completed: 1,
      skipped: 1,
      updatedAt: at(1_000),
      lastErrorCode: null
    });
  });

  it("treats an empty selection or completed run as completed", () => {
    expect(
      summarizeHistoricalIngestionState(state({ selections: [] }), now)
        .lifecycle
    ).toBe("completed");
    expect(
      summarizeHistoricalIngestionState(state({ runCompleted: true }), now)
        .lifecycle
    ).toBe("completed");
  });

  it("reports a failure newer than the last progress", () => {
    const summary = summarizeHistoricalIngestionState(
      state({
        progress: {
          updatedAt: at(1_000),
          lastProgressAt: at(60_000),
          lastErrorCode: "historical_ingestion_pass_failed",
          lastErrorAt: at(1_000)
        }
      }),
      now
    );
    expect(summary).toMatchObject({
      lifecycle: "failed",
      lastErrorCode: "historical_ingestion_pass_failed"
    });
  });

  it("does not claim an interrupted or waiting run is running", () => {
    expect(
      summarizeHistoricalIngestionState(
        state({
          progress: { updatedAt: at(HISTORICAL_INGESTION_STALE_MS + 1) }
        }),
        now
      ).lifecycle
    ).toBe("idle");
    expect(
      summarizeHistoricalIngestionState(
        state({ progress: { updatedAt: at(1), lastBatchState: "waiting" } }),
        now
      ).lifecycle
    ).toBe("idle");
    expect(
      summarizeHistoricalIngestionState(state({ progress: undefined }), now)
        .lifecycle
    ).toBe("unknown");
  });
});
