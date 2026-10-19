import { describe, expect, it } from "vitest";

import {
  deriveEmbeddingActivity,
  type EmbeddingStateSnapshot
} from "./embedding-state.js";

const snapshot = (
  overrides: Partial<Omit<EmbeddingStateSnapshot, "activity" | "generatedAt">>
): Omit<EmbeddingStateSnapshot, "activity" | "generatedAt"> => ({
  service: {
    healthy: true,
    compatible: true,
    model: "qwen3-0.6b",
    dimensions: 1024,
    expectedModel: "qwen3-0.6b",
    expectedDimensions: 1024
  },
  calibration: null,
  backlog: {
    pendingMemoryEvents: 0,
    pendingMemoryNodes: 0,
    pendingEstimatedTokens: 0
  },
  throughput: null,
  drainEstimate: null,
  queues: { memory: null, lcm: null },
  projection: null,
  historicalAdmission: null,
  ...overrides
});

describe("deriveEmbeddingActivity", () => {
  it("reports idle only when backlog telemetry shows no pending work", () => {
    expect(deriveEmbeddingActivity(snapshot({}))).toBe("idle");
  });

  it("reports unknown when backlog telemetry is missing", () => {
    expect(deriveEmbeddingActivity(snapshot({ backlog: null }))).toBe(
      "unknown"
    );
  });

  it("reports working from busy queues even without backlog telemetry", () => {
    expect(
      deriveEmbeddingActivity(
        snapshot({
          backlog: null,
          queues: {
            memory: { waiting: 1, active: 0, delayed: 0, failed: 0 },
            lcm: null
          }
        })
      )
    ).toBe("working");
  });

  it("reports unavailable when the Embedding Service is not ready", () => {
    expect(
      deriveEmbeddingActivity(
        snapshot({
          service: { ...snapshot({}).service, healthy: false }
        })
      )
    ).toBe("unavailable");
  });
});
