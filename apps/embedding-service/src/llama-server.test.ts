import { EventEmitter } from "node:events";

import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  extractRerankScores,
  LlamaServerClient,
  llamaServerArgs,
  llamaServerEnvironment,
  tokenPieceText
} from "./llama-server.js";
import { testConfig, testLogger } from "./test-helpers.js";

describe("llama-server adapter helpers", () => {
  it("decodes token pieces from llama-server responses", () => {
    expect(tokenPieceText("hello")).toBe("hello");
    expect(tokenPieceText([99, 97, 102, 195, 169])).toBe("café");
    expect(tokenPieceText({ value: "x" })).toBe("[object Object]");
  });

  it("derives llama-server library path from configured binary", () => {
    expect(
      llamaServerEnvironment("/runtime/llama.cpp/llama-server", {})
    ).toEqual(
      expect.objectContaining({
        LD_LIBRARY_PATH: "/runtime/llama.cpp",
        LLAMA_ARG_UI: "false"
      })
    );
    expect(
      llamaServerEnvironment("/runtime/llama.cpp/llama-server", {
        LD_LIBRARY_PATH: "/existing",
        LLAMA_ARG_UI: "true"
      })
    ).toEqual(
      expect.objectContaining({
        LD_LIBRARY_PATH: "/runtime/llama.cpp:/existing",
        LLAMA_ARG_UI: "false"
      })
    );
  });

  it("uses arguments supported by the pinned and current llama-server builds", () => {
    const config = testConfig();
    const args = llamaServerArgs({
      name: "embedding",
      modelPath: config.modelPath!,
      port: config.embeddingServerPort,
      pooling: "last",
      embedding: true,
      reranking: false,
      nCtx: config.llamaNCtx,
      nThreads: config.llamaNThreads,
      nBatch: config.llamaNBatch,
      nUbatch: config.llamaNUbatch,
      parallel: config.llamaParallel,
      promptCacheEnabled: false
    });

    expect(args).toContain("--embedding");
    expect(args).not.toContain("--no-ui");
    expect(args).not.toContain("--embd-normalize");
  });

  it("extracts rerank scores in original document order", () => {
    expect(
      extractRerankScores(
        {
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.2 }
          ]
        },
        2
      )
    ).toEqual([0.2, 0.9]);

    expect(extractRerankScores({ scores: [0.1, 0.3] }, 2)).toEqual([0.1, 0.3]);
  });

  it("rejects incomplete rerank payloads", () => {
    expect(() =>
      extractRerankScores({ results: [{ index: 1, score: 0.5 }] }, 2)
    ).toThrow("incomplete rerank scores");
  });

  it("retains llama-server measured reranker prompt tokens", async () => {
    const config = testConfig({ rerankerKey: "qwen3-reranker-0.6b" });
    const client = new LlamaServerClient(
      config,
      testLogger(),
      {
        name: "reranker",
        modelPath: "/models/reranker.gguf",
        port: config.rerankerServerPort,
        pooling: "rank",
        embedding: true,
        reranking: true,
        nCtx: config.rerankerNCtx,
        nThreads: config.rerankerNThreads,
        nBatch: config.rerankerNBatch,
        nUbatch: config.rerankerNUbatch,
        parallel: config.rerankerParallel,
        promptCacheEnabled: true
      },
      async () =>
        new Response(
          JSON.stringify({
            results: [{ index: 0, relevance_score: 0.8 }],
            usage: { prompt_tokens: 41, total_tokens: 41 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );

    await expect(client.rerank("query", ["document"])).resolves.toEqual({
      scores: [0.8],
      measuredTokens: 41
    });
  });

  it("waits for the llama-server child to exit during shutdown", async () => {
    const childState = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdout: null,
      stderr: null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") {
          setTimeout(() => {
            childState.signalCode = signal;
            childState.emit("exit", null, signal);
          }, 10);
        }
        return true;
      })
    });
    const child = childState as unknown as ChildProcess;
    const config = testConfig();
    const client = new LlamaServerClient(
      config,
      testLogger(),
      {
        name: "embedding",
        modelPath: config.modelPath!,
        port: config.embeddingServerPort,
        pooling: "last",
        embedding: true,
        reranking: false,
        nCtx: config.llamaNCtx,
        nThreads: config.llamaNThreads,
        nBatch: config.llamaNBatch,
        nUbatch: config.llamaNUbatch,
        parallel: config.llamaParallel,
        promptCacheEnabled: false
      },
      async () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
      (() => child) as typeof import("node:child_process").spawn
    );

    await client.start();
    await client.stop();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.signalCode).toBe("SIGTERM");
    expect(client.isRunning()).toBe(false);
  });
});
