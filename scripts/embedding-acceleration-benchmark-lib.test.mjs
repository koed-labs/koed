import assert from "node:assert/strict";
import test from "node:test";
import {
  cosineSimilarity,
  parseEmbeddingAccelerationBenchmarkArgs,
  realisticMemoryEventInputs,
  summarizeBackendSamples
} from "./embedding-acceleration-benchmark-lib.mjs";

test("parses explicit benchmark runtime settings", () => {
  assert.deepEqual(
    parseEmbeddingAccelerationBenchmarkArgs(
      [
        "--llama-server",
        "/runtime/llama-server",
        "--model-path",
        "/models/embedding.gguf",
        "--gpu-backend",
        "metal",
        "--warm-iterations",
        "5",
        "--idle-seconds",
        "4",
        "--json"
      ],
      {},
      "darwin"
    ),
    {
      modelPath: "/models/embedding.gguf",
      llamaServer: "/runtime/llama-server",
      gpuBackend: "metal",
      warmIterations: 5,
      idleSeconds: 4,
      output: null,
      json: true,
      help: false
    }
  );
});

test("uses deterministic realistic Memory Event classes", () => {
  assert.deepEqual(
    realisticMemoryEventInputs.map(({ targetTokens }) => targetTokens),
    [256, 1024, 2048]
  );
  assert.ok(realisticMemoryEventInputs.every(({ text }) => text.length > 1000));
});

test("summarizes warm throughput and vector agreement", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.deepEqual(
    summarizeBackendSamples({
      backend: "cpu",
      startupMs: 100,
      cold: { durationMs: 40, measuredTokens: 100 },
      wake: null,
      warm: [
        { durationMs: 20, measuredTokens: 100 },
        { durationMs: 40, measuredTokens: 100 }
      ],
      peakRamMiB: 400,
      peakVramMiB: null
    }),
    {
      backend: "cpu",
      startupMs: 100,
      coldRequestMs: 40,
      idleWakeRequestMs: null,
      warm: {
        iterations: 2,
        p50Ms: 20,
        p95Ms: 40,
        measuredTokens: 200,
        tokensPerSecond: 200 / 0.06
      },
      peakRamMiB: 400,
      peakVramMiB: null,
      idleVramMiB: null,
      vramMeasurement: "unavailable"
    }
  );
});
