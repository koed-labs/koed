import { describe, expect, it } from "vitest";
import { redactPublicationReport } from "./core/report.js";
import {
  assertCompleteReplayTelemetry,
  mergeReplayTelemetry,
  type AttemptTelemetryIdentity,
  type ReplayTelemetryMergeInput,
  type TelemetryEnvelope
} from "./telemetry.js";

const identity: AttemptTelemetryIdentity = {
  taskDigest: `sha256:${"a".repeat(64)}`,
  condition: "relevant",
  repeat: 2
};

const available = (metrics: unknown): TelemetryEnvelope => ({
  identity,
  status: "available",
  metrics
});

const completeInput = (): ReplayTelemetryMergeInput => ({
  identity,
  harbor: available({
    reward: 1,
    passed: true,
    setupMs: 100,
    agentMs: 2_000,
    verifierMs: 300,
    failureCategory: null,
    failureKind: null,
    failurePhase: null
  }),
  codex: available({
    tokens: { uncachedInput: 10, cachedInput: 20, output: 30, reasoning: 40 },
    costs: {
      providerBilledUsd: 0.9,
      apiEquivalentUsd: 1,
      subscriptionUsd: 0
    },
    turns: 5,
    toolCalls: 4,
    toolFailures: 1,
    mcpCalls: 3,
    mcpFailures: 1,
    memoryAnswerCalls: 2,
    memoryAnswerFailures: 0
  }),
  koedRecall: available({
    searches: 2,
    expansions: 3,
    stages: 4,
    evidenceCount: 5,
    projectionMs: 11,
    lcmMs: 12,
    queueMs: 13
  }),
  modelWorkflows: available({
    memoryAnswer: {
      calls: 2,
      failures: 0,
      durationMs: 200,
      tokens: { uncachedInput: 1, cachedInput: 2, output: 3, reasoning: 4 },
      costs: {
        providerBilledUsd: 0.1,
        apiEquivalentUsd: 0.2,
        subscriptionUsd: 0
      }
    },
    lcmSummary: {
      calls: 1,
      failures: 0,
      durationMs: 50,
      tokens: { uncachedInput: 5, cachedInput: 6, output: 7, reasoning: 8 },
      costs: {
        providerBilledUsd: 0.25,
        apiEquivalentUsd: 0.3,
        subscriptionUsd: 0
      }
    },
    sessionTitle: {
      calls: 1,
      failures: 0,
      durationMs: 25,
      tokens: { uncachedInput: 2, cachedInput: 3, output: 4, reasoning: 5 },
      costs: {
        providerBilledUsd: 0.35,
        apiEquivalentUsd: 0.4,
        subscriptionUsd: 0
      }
    }
  }),
  embeddings: available({ calls: 7, tokens: 800, durationMs: 90 }),
  processRss: available({
    apiBytes: 100_000,
    runtimeBytes: 200_000,
    workerBytes: 300_000
  })
});

describe("experience replay telemetry merge", () => {
  it("requires every observer and distinguishes zero activity from missing telemetry", () => {
    const complete = completeInput();
    expect(() => assertCompleteReplayTelemetry(complete)).not.toThrow();
    expect(() =>
      assertCompleteReplayTelemetry({ ...complete, koedRecall: undefined })
    ).toThrow("Koed Recall telemetry must be available");
    expect(() =>
      assertCompleteReplayTelemetry({
        ...complete,
        embeddings: { ...complete.embeddings!, status: "failed" }
      })
    ).toThrow("embedding telemetry must be available");
    expect(() =>
      assertCompleteReplayTelemetry({
        ...complete,
        harbor: available({
          reward: 1,
          passed: true,
          setupMs: 1,
          agentMs: 2,
          verifierMs: 3
        })
      })
    ).toThrow("missing required field failureCategory");
  });
  it("merges only bounded source contracts into a complete ReplayOutcome", () => {
    const merged = mergeReplayTelemetry(completeInput());
    expect(merged.outcome).toMatchObject({
      ...identity,
      reward: 1,
      passed: true,
      latencyMs: 2_000,
      tokens: 110,
      costUsd: 1.2,
      costs: {
        providerBilledUsd: 1,
        apiEquivalentUsd: 1.2,
        subscriptionUsd: 0
      },
      recall: { searches: 2, expansions: 3, stages: 4, evidenceCount: 5 },
      embedding: { calls: 7, tokens: 800, durationMs: 90 },
      rss: { apiBytes: 100_000, runtimeBytes: 200_000, workerBytes: 300_000 },
      telemetryStatus: {
        harbor: "available",
        codex: "available",
        koedRecall: "available",
        modelWorkflows: "available",
        embeddings: "available",
        processRss: "available"
      }
    });
  });

  it("keeps one-time preparation cost separate from replay execution cost", () => {
    const merged = mergeReplayTelemetry(completeInput());
    expect(merged.outcome.costUsd).toBeCloseTo(1.2);
    expect(merged.preparation.costUsd).toBeCloseTo(0.7);
    expect(merged.preparation.workers.lcmSummary.costs.apiEquivalentUsd).toBe(
      0.3
    );
    expect(merged.preparation.workers.sessionTitle.costs.apiEquivalentUsd).toBe(
      0.4
    );
    expect(merged.outcome.costUsd).not.toBeCloseTo(1.9);
  });

  it("preserves unavailable and failed collection explicitly without inventing zeros", () => {
    const merged = mergeReplayTelemetry({
      identity,
      harbor: { identity, status: "failed" },
      codex: { identity, status: "missing" }
    });
    expect(merged.outcome).toMatchObject({
      reward: null,
      passed: null,
      latencyMs: null,
      tokens: null,
      costUsd: null,
      durations: { setupMs: null, agentMs: null, verifierMs: null },
      tokenUsage: {
        uncachedInput: null,
        cachedInput: null,
        output: null,
        reasoning: null
      },
      interactions: { turns: null, toolCalls: null, mcpCalls: null },
      recall: {
        searches: null,
        expansions: null,
        stages: null,
        evidenceCount: null
      },
      rss: { apiBytes: null, runtimeBytes: null, workerBytes: null },
      telemetryStatus: {
        harbor: "failed",
        codex: "missing",
        koedRecall: "missing",
        modelWorkflows: "missing",
        embeddings: "missing",
        processRss: "missing"
      }
    });
    expect(merged.preparation.costUsd).toBeNull();
  });

  it("requires every source fragment to bind to the exact task/condition/repeat", () => {
    for (const changed of [
      { ...identity, taskDigest: "another-task" },
      { ...identity, condition: "placebo" as const },
      { ...identity, repeat: 3 }
    ]) {
      expect(() =>
        mergeReplayTelemetry({
          identity,
          harbor: { identity: changed, status: "available", metrics: {} }
        })
      ).toThrow("identity does not match");
    }
  });

  it.each([
    ["negative", { agentMs: -1 }],
    ["NaN", { agentMs: Number.NaN }],
    ["infinite", { agentMs: Number.POSITIVE_INFINITY }],
    ["fractional count", undefined]
  ])("rejects %s telemetry", (kind, harborMetrics) => {
    const input = completeInput();
    if (kind === "fractional count") {
      input.codex = available({ turns: 1.5 });
    } else {
      input.harbor = available(harborMetrics);
    }
    expect(() => mergeReplayTelemetry(input)).toThrow(
      kind === "fractional count" ? "safe integer" : "nonnegative finite"
    );
  });

  it("rejects impossible failure counters and partial failure classification", () => {
    expect(() =>
      mergeReplayTelemetry({
        identity,
        codex: available({ toolCalls: 1, toolFailures: 2 })
      })
    ).toThrow("cannot exceed");
    expect(() =>
      mergeReplayTelemetry({
        identity,
        harbor: available({ failureCategory: "agent_timeout" })
      })
    ).toThrow("must be supplied together");
  });

  it("rejects unknown fields, prototype-shaped arrays, and metrics on failed sources", () => {
    expect(() =>
      mergeReplayTelemetry({
        ...completeInput(),
        rawLogs: "secret payload"
      } as ReplayTelemetryMergeInput)
    ).toThrow("unexpected field rawLogs");
    expect(() =>
      mergeReplayTelemetry({
        identity,
        codex: available({ tokens: {}, transcript: "secret payload" })
      })
    ).toThrow("unexpected field transcript");
    expect(() =>
      mergeReplayTelemetry({
        identity,
        embeddings: { identity, status: "available", metrics: [] }
      })
    ).toThrow("requires metrics");
    expect(() =>
      mergeReplayTelemetry({
        identity,
        processRss: {
          identity,
          status: "failed",
          metrics: { stderr: "secret payload" }
        }
      })
    ).toThrow("must not carry metrics");
  });

  it("produces publication-safe allowlisted report inputs", () => {
    const merged = mergeReplayTelemetry(completeInput());
    const publication = redactPublicationReport({
      attempts: [merged.outcome],
      comparisons: [],
      exclusions: []
    }) as { attempts: Record<string, unknown>[] };
    expect(publication.attempts[0]).toMatchObject({
      taskDigest: identity.taskDigest,
      telemetryStatus: {
        harbor: "available",
        codex: "available",
        koedRecall: "available",
        modelWorkflows: "available",
        embeddings: "available",
        processRss: "available"
      }
    });
    expect(JSON.stringify(publication)).not.toContain("identity");
  });
});
