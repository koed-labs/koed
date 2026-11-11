import { describe, expect, it } from "vitest";
import type { RecallActivityOverview } from "@koed/shared/personal-desktop";
import {
  recallCallerPresentation,
  recallChartModel,
  recallDateRange,
  recallPresetDates
} from "./recall-activity-model.js";

describe("Recall calling AI Client", () => {
  it("recognizes Codex's MCP identity while preserving unknown provenance", () => {
    expect(recallCallerPresentation("codex-mcp-client")).toEqual({
      label: "Codex",
      icon: "codex"
    });
    expect(recallCallerPresentation(null)).toEqual({
      label: "Unknown AI Client",
      icon: null
    });
    expect(recallCallerPresentation("another-client")).toEqual({
      label: "another-client",
      icon: null
    });
  });
});

const overview = (
  bucket: RecallActivityOverview["bucket"],
  starts: string[]
): RecallActivityOverview => ({
  asOf: starts[0]!,
  timezone: "Europe/London",
  bucket,
  recordedQuestions: starts.length * 4,
  recordedErrors: starts.length,
  linkedQuestions: 0,
  knownDurations: 0,
  medianDurationMs: null,
  memoryResults: {
    found: starts.length,
    not_found: starts.length,
    insufficient: 0,
    pending_summary: 0,
    unknown: starts.length * 2,
    foundPercentage: 50
  },
  tokens: {
    coverage: "unavailable",
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    recordedAttempts: 0,
    includesEstimates: false
  },
  tokenTimeline: [],
  questions: starts.map((start) => ({
    start,
    count: 4,
    errors: 1,
    found: 1,
    notFound: 1,
    insufficient: 0,
    pendingSummary: 0,
    unknown: 2
  }))
});

describe("Recall chart range resolution", () => {
  it("groups the whole 30-day overview into ten intervals without double-counting error outcomes", () => {
    const starts = Array.from({ length: 30 }, (_, index) =>
      new Date(Date.UTC(2026, 10, index + 1)).toISOString()
    );
    const chart = recallChartModel(
      overview("day", starts),
      starts[0]!,
      "2026-12-01T00:00:00Z"
    );
    expect(chart.resolution).toBe("Every 3 days");
    expect(chart.buckets).toHaveLength(10);
    expect(chart.buckets[0]).toMatchObject({
      count: 12,
      found: 3,
      other: 6,
      errors: 3
    });
    expect(chart.buckets.reduce((n, point) => n + point.count, 0)).toBe(120);
    expect(chart.buckets.at(-1)?.end).toBe("2026-12-01T00:00:00Z");
  });
  it("keeps seven daily intervals, including zero-activity days", () => {
    const starts = Array.from({ length: 7 }, (_, index) =>
      new Date(Date.UTC(2026, 10, index + 1)).toISOString()
    );
    const data = overview("day", starts);
    data.questions[2] = {
      ...data.questions[2]!,
      count: 0,
      found: 0,
      errors: 0,
      notFound: 0,
      unknown: 0
    };
    const chart = recallChartModel(data, starts[0]!, "2026-11-08T00:00:00Z");
    expect(chart.resolution).toBe("Daily");
    expect(chart.buckets).toHaveLength(7);
    expect(chart.buckets[2]).toMatchObject({ count: 0, other: 0, errors: 0 });
  });
  it("distinguishes repeated local hours on the autumn clock change", () => {
    const starts = Array.from({ length: 25 }, (_, index) =>
      new Date(Date.UTC(2026, 9, 24, 23 + index)).toISOString()
    );
    const chart = recallChartModel(
      overview("hour", starts),
      starts[0]!,
      "2026-10-26T00:00:00Z"
    );
    expect(chart.resolution).toBe("Hourly");
    expect(chart.buckets).toHaveLength(25);
    expect(chart.buckets[1]!.label).toBe(chart.buckets[2]!.label);
    expect(chart.buckets[1]!.rangeLabel).not.toBe(chart.buckets[2]!.rangeLabel);
    expect(new Set(chart.buckets.map((point) => point.start)).size).toBe(25);
  });
  it("uses inclusive local calendar presets and rejects normalized invalid dates", () => {
    expect(recallPresetDates("7", new Date(2026, 0, 3, 12))).toEqual({
      from: "2025-12-28",
      to: "2026-01-03"
    });
    const dates = recallDateRange("2026-11-11", "2026-11-11");
    expect(new Date(dates.from).getDate()).toBe(11);
    expect(new Date(dates.to).getDate()).toBe(12);
    expect(() => recallDateRange("2026-02-30", "2026-03-01")).toThrow();
    expect(() => recallDateRange("", "2026-03-01")).toThrow();
  });
});
