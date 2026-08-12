import { describe, expect, it } from "vitest";
import {
  createRecordedReplayTelemetryCollector,
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

describe("recorded replay telemetry provisioning", () => {
  it("rejects a non-cold attempt without a live identity-bound observation", async () => {
    await expect(
      createRecordedReplayTelemetryCollector()({ identity, captured })
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
        workerPeakRssBytes: 8192
      }),
      embeddings: () => ({ calls: 2, tokens: null, durationMs: 12 })
    });
    try {
      await expect(
        createRecordedReplayTelemetryCollector()({ identity, captured })
      ).rejects.toThrow("lacks its database observation");
    } finally {
      unregister();
    }
  });

  it("reports observed cold inactivity and explicit unavailable process metrics", async () => {
    const cold = { ...identity, condition: "cold" as const };
    const result = await createRecordedReplayTelemetryCollector()({
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
    expect(result.processRss?.metrics).toEqual({
      apiBytes: null,
      runtimeBytes: null,
      workerBytes: null
    });
  });
});
