import { describe, expect, it } from "vitest";
import {
  createRecordedReplayTelemetryCollector,
  reconcileMemoryAnswerInteractionCounts,
  recordedApiEquivalentCost,
  registerRecordedAttemptObservation
} from "./recorded-runtime-telemetry.js";
import type { CapturedHarborExecutionResult } from "./harbor-execution-adapter.js";

const identity = {
  taskDigest: `sha256:${"a".repeat(64)}`,
  condition: "relevant" as const,
  repeat: 1
};

const captured = {
  trial: {
    usage: {
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 10,
      costUsd: 0.02
    },
    interactions: { turns: 3, toolCalls: 2 }
  }
} as CapturedHarborExecutionResult;

const telemetryOptions = {
  authMode: "subscription" as const,
  workflowModels: {
    mcp_memory_answer: "gpt-5.6-luna",
    lcm_summary: "gpt-5.6-luna",
    session_title: "gpt-5.6-luna"
  },
  prices: {
    "gpt-5.6-luna": {
      uncached_input_usd_per_million: 1,
      cached_input_usd_per_million: 0.1,
      output_usd_per_million: 5
    }
  }
};

describe("recorded replay telemetry provisioning", () => {
  it("prices uncached, cached, and output tokens independently", () => {
    expect(
      recordedApiEquivalentCost(
        { input: 100, cachedInput: 25, output: 10 },
        telemetryOptions.prices["gpt-5.6-luna"]!
      )
    ).toBeCloseTo(0.0001275, 12);
  });

  it("reconciles successful persisted Memory Questions with bridge observations", () => {
    expect(
      reconcileMemoryAnswerInteractionCounts(
        {
          mcpCalls: 0,
          mcpFailures: 0,
          memoryAnswerCalls: 0,
          memoryAnswerFailures: 0
        },
        { calls: 1, failures: 0 }
      )
    ).toEqual({
      mcpCalls: 1,
      mcpFailures: 0,
      memoryAnswerCalls: 1,
      memoryAnswerFailures: 0
    });
    expect(
      reconcileMemoryAnswerInteractionCounts(
        {
          mcpCalls: 3,
          mcpFailures: 1,
          memoryAnswerCalls: 2,
          memoryAnswerFailures: 1
        },
        { calls: 1, failures: 0 }
      )
    ).toEqual({
      mcpCalls: 3,
      mcpFailures: 1,
      memoryAnswerCalls: 2,
      memoryAnswerFailures: 1
    });
    expect(() =>
      reconcileMemoryAnswerInteractionCounts(
        {
          mcpCalls: 0,
          mcpFailures: 0,
          memoryAnswerCalls: 0,
          memoryAnswerFailures: 0
        },
        { calls: 0, failures: 1 }
      )
    ).toThrow("failures exceed calls");
  });

  it("rejects a non-cold attempt without a live identity-bound observation", async () => {
    await expect(
      createRecordedReplayTelemetryCollector(telemetryOptions)({
        identity,
        captured
      })
    ).rejects.toThrow("Mandatory recorded attempt observation is absent");
  });

  it("collects Harbor and live bridge observations without telemetry files", async () => {
    const unregister = registerRecordedAttemptObservation({
      identity,
      bridge: () => ({
        mcpCalls: 2,
        mcpFailures: 1,
        memoryAnswerCalls: 2,
        memoryAnswerFailures: 1,
        searches: 3,
        expansions: 1,
        stages: 4,
        evidenceCount: 5,
        workerPeakRssBytes: 8192,
        memoryAnswerRequests: [
          { responseDetail: "answer_only", searchDomain: "project" },
          { responseDetail: "answer_only", searchDomain: "project" }
        ]
      }),
      embeddings: () => ({ calls: 2, tokens: null, durationMs: 12 })
    });
    try {
      await expect(
        createRecordedReplayTelemetryCollector(telemetryOptions)({
          identity,
          captured
        })
      ).rejects.toThrow("lacks its database observation");
    } finally {
      unregister();
    }
  });

  it("reports observed cold inactivity and explicit unavailable process metrics", async () => {
    const cold = { ...identity, condition: "cold" as const };
    const result = await createRecordedReplayTelemetryCollector(
      telemetryOptions
    )({
      identity: cold,
      captured
    });
    expect(result.codex?.metrics).toMatchObject({
      tokens: {
        uncachedInput: 75,
        cachedInput: 25,
        output: 10,
        reasoning: null
      },
      turns: 3,
      toolCalls: 2,
      mcpCalls: 0
    });
    expect(result.codex?.metrics).toMatchObject({
      costs: {
        providerBilledUsd: 0,
        apiEquivalentUsd: 0.02,
        subscriptionUsd: 0
      }
    });
    expect(result.processRss?.metrics).toEqual({
      apiBytes: null,
      runtimeBytes: null,
      workerBytes: null
    });
  });

  it("reports an exited observed process as explicitly unavailable", async () => {
    const cold = { ...identity, condition: "cold" as const };
    const unregister = registerRecordedAttemptObservation({
      identity: cold,
      apiPid: 2_147_483_647
    });
    try {
      const result = await createRecordedReplayTelemetryCollector(
        telemetryOptions
      )({ identity: cold, captured });
      expect(result.processRss?.metrics).toEqual({
        apiBytes: null,
        runtimeBytes: null,
        workerBytes: null
      });
    } finally {
      unregister();
    }
  });
});
