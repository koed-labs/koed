import { describe, expect, it } from "vitest";
import type { LlamaEmbeddingClient } from "./runtime.js";
import { EmbeddingRuntime } from "./runtime.js";
import type { TokenPiece } from "./llama-server.js";
import { testConfig, testLogger } from "./test-helpers.js";

class FakeLlamaServer implements LlamaEmbeddingClient {
  embedInputs: string[][] = [];
  rerankInputs: Array<{ query: string; documents: string[] }> = [];
  tokenTextById = new Map<number, string>();

  isRunning(): boolean {
    return true;
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }

  async tokenize(text: string): Promise<TokenPiece[]> {
    this.tokenTextById = new Map(
      text
        .split(" ")
        .map((piece, index) => [index, index === 0 ? piece : ` ${piece}`])
    );
    return [...this.tokenTextById.entries()].map(([tokenId, piece]) => ({
      tokenId,
      text: piece
    }));
  }

  async detokenize(tokenIds: number[]): Promise<string> {
    return tokenIds
      .map((tokenId) => this.tokenTextById.get(tokenId) ?? "")
      .join("");
  }

  async embed(texts: string[]): Promise<{
    vectors: number[][];
    measuredTokens: number | null;
  }> {
    this.embedInputs.push(texts);
    return {
      vectors: texts.map((_, index) => [index + 1, 1, 0]),
      measuredTokens: texts.join(" ").split(" ").length
    };
  }

  async rerank(query: string, documents: string[]) {
    this.rerankInputs.push({ query, documents });
    return {
      scores: documents.map((document) => document.length),
      measuredTokens: 37
    };
  }
}

describe("EmbeddingRuntime", () => {
  it("preserves chunk order and metadata", async () => {
    const fakeServer = new FakeLlamaServer();
    const runtime = new EmbeddingRuntime(testConfig(), testLogger());
    runtime.embeddingServer = fakeServer;

    const response = await runtime.embedText(
      ["one two", "three four"],
      "background"
    );

    expect(response.model).toBe("test-model");
    expect(response.dimensions).toBe(3);
    expect(response.measuredTokens).toBe(4);
    expect(fakeServer.embedInputs).toEqual([["one two", "three four"]]);
    expect(response.chunks.map((chunk) => chunk.inputIndex)).toEqual([0, 1]);
    expect(response.chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 0]);
    expect(response.chunks.map((chunk) => chunk.chunkCount)).toEqual([1, 1]);
    expect(response.chunks.map((chunk) => chunk.tokenCount)).toEqual([2, 2]);
    expect(response.chunks.map((chunk) => chunk.text)).toEqual([
      "one two",
      "three four"
    ]);
    expect(response.vectors).toHaveLength(2);
  });

  it("batches short chunks and splits long input", async () => {
    const fakeServer = new FakeLlamaServer();
    const runtime = new EmbeddingRuntime(testConfig(), testLogger());
    runtime.embeddingServer = fakeServer;

    await runtime.embedText(
      ["one two", "three four", "five six seven eight nine ten"],
      "background"
    );

    expect(fakeServer.embedInputs).toEqual([
      ["one two", "three four"],
      ["five six seven eight nine"],
      ["ten"]
    ]);
  });

  it("uses detokenize for chunk text and drops empty detokenized chunks", async () => {
    class UnicodeSplitServer extends FakeLlamaServer {
      override async tokenize(): Promise<TokenPiece[]> {
        return [
          { tokenId: 101, text: "caf" },
          { tokenId: 102, text: "�" },
          { tokenId: 103, text: " " },
          { tokenId: 104, text: " au" },
          { tokenId: 105, text: " lait" }
        ];
      }

      override async detokenize(tokenIds: number[]): Promise<string> {
        const mapping = new Map([
          ["101,102", "café"],
          ["103,104", " "],
          ["105", "lait"]
        ]);
        return mapping.get(tokenIds.join(",")) ?? "";
      }
    }
    const runtime = new EmbeddingRuntime(
      testConfig({ embeddingMaxTokens: 2 }),
      testLogger()
    );
    runtime.embeddingServer = new UnicodeSplitServer();

    const chunks = await runtime.splitTextByEmbeddingTokens("café au lait", 0);

    expect(chunks.map((chunk) => chunk.text)).toEqual(["café", "lait"]);
    expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([2, 1]);
    expect(chunks.map((chunk) => chunk.chunkCount)).toEqual([2, 2]);
  });

  it("respects batch token headroom for splitting and groups", async () => {
    const fakeServer = new FakeLlamaServer();
    const runtime = new EmbeddingRuntime(
      testConfig({
        embeddingMaxTokens: 5,
        llamaNCtx: 100,
        llamaNBatch: 5,
        llamaBatchTokenHeadroom: 1
      }),
      testLogger()
    );
    runtime.embeddingServer = fakeServer;

    const chunks = await runtime.splitTextByEmbeddingTokens(
      "one two three four five",
      0
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "one two three four",
      "five"
    ]);
    expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([4, 1]);
    expect(
      runtime
        .embeddingGroups([
          {
            inputIndex: 0,
            chunkIndex: 0,
            chunkCount: 1,
            text: "a",
            tokenCount: 2
          },
          {
            inputIndex: 1,
            chunkIndex: 0,
            chunkCount: 1,
            text: "b",
            tokenCount: 3
          },
          {
            inputIndex: 2,
            chunkIndex: 0,
            chunkCount: 1,
            text: "c",
            tokenCount: 1
          }
        ])
        .map((group) => group.map((chunk) => chunk.text))
    ).toEqual([["a"], ["b", "c"]]);
  });

  it("limits embedding batches to llama-server's physical microbatch", async () => {
    const runtime = new EmbeddingRuntime(
      testConfig({
        llamaNBatch: 8192,
        llamaNUbatch: 512,
        llamaBatchTokenHeadroom: 8
      }),
      testLogger()
    );

    expect(runtime.embeddingBatchTokenLimit()).toBe(504);
  });

  it("uses llama-server rerank scores", async () => {
    const fakeServer = new FakeLlamaServer();
    const runtime = new EmbeddingRuntime(
      testConfig({
        rerankerKey: "test-reranker",
        rerankerRepo: "repo",
        rerankerFile: "reranker.gguf",
        rerankerModelPath: "/models/reranker.gguf",
        rerankerArtifact: "repo:reranker.gguf",
        rerankerArtifactSha256: "a".repeat(64)
      }),
      testLogger()
    );
    runtime.rerankerServer = fakeServer;
    (
      runtime as unknown as { loadedRerankerArtifactSha256: string }
    ).loadedRerankerArtifactSha256 = "a".repeat(64);

    const response = await runtime.rerankTexts("query", ["short", "longer"]);

    expect(response).toMatchObject({
      model: "test-reranker",
      artifact: "repo:reranker.gguf",
      artifactRevision: `sha256:${"a".repeat(64)}`,
      artifactHash: "a".repeat(64),
      inputTokens: 37,
      costUsd: 0,
      scores: [5, 6]
    });
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fakeServer.rerankInputs).toEqual([
      { query: "query", documents: ["short", "longer"] }
    ]);
  });

  it("loads llama-server clients with expected options", async () => {
    const created: unknown[] = [];
    const runtime = new EmbeddingRuntime(
      testConfig({ modelPath: "/models/embedding.gguf" }),
      testLogger(),
      (options) => {
        created.push(options);
        return new FakeLlamaServer();
      }
    );

    await runtime.loadEmbeddingModel();

    expect(created[0]).toMatchObject({
      modelPath: "/models/embedding.gguf",
      pooling: "last",
      embedding: true,
      reranking: false
    });
  });

  it("derives the default embedding model path from the supported model key", async () => {
    const created: unknown[] = [];
    const runtime = new EmbeddingRuntime(
      testConfig({ modelPath: null }),
      testLogger(),
      (options) => {
        created.push(options);
        return new FakeLlamaServer();
      }
    );

    await runtime.loadEmbeddingModel();

    expect(created[0]).toMatchObject({
      modelPath: "/models/Qwen3-Embedding-0.6B-Q8_0.gguf"
    });
  });
});
