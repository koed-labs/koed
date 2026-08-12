import { describe, expect, it } from "vitest";
import { createEmbeddingLogger } from "./logging.js";
import { EmbeddingRuntime } from "./runtime.js";
import type { EmbedResponse, RerankResponse } from "./schemas.js";
import {
  capacityHardwareIdentity,
  createEmbeddingService,
  createNodeHttpServer,
  listenNodeHttpServer
} from "./server.js";
import { testConfig } from "./test-helpers.js";

class RouteRuntime extends EmbeddingRuntime {
  embedCalls: Array<{ texts: string[]; priority: string | null }> = [];
  rerankCalls: Array<{ query: string; documents: string[] }> = [];
  healthModelLoaded = true;
  healthRerankerLoaded = true;
  embedResult: EmbedResponse = {
    model: "qwen3-0.6b",
    dimensions: 3,
    measuredTokens: 2,
    vectors: [[1, 0, 0]],
    chunks: [
      {
        inputIndex: 0,
        chunkIndex: 0,
        chunkCount: 1,
        tokenCount: 2,
        text: "hello memory",
        vector: [1, 0, 0]
      }
    ]
  };
  rerankResult: RerankResponse = {
    model: "qwen3-reranker-0.6b",
    scores: [0.2, 0.9]
  };

  override isModelLoaded(): boolean {
    return this.healthModelLoaded;
  }

  override isRerankerLoaded(): boolean {
    return this.healthRerankerLoaded;
  }

  override healthQueueSnapshot() {
    return { active: false, waiting_interactive: 0, waiting_background: 1 };
  }

  override async embedText(
    texts: string[],
    requestedPriority: string | null
  ): Promise<EmbedResponse> {
    this.embedCalls.push({ texts, priority: requestedPriority });
    return this.embedResult;
  }

  override async rerankTexts(
    query: string,
    documents: string[]
  ): Promise<RerankResponse> {
    this.rerankCalls.push({ query, documents });
    return this.rerankResult;
  }
}

const json = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

const logger = () => createEmbeddingLogger("critical", () => undefined);

describe("Embedding Service routes", () => {
  it("changes non-CPU hardware identity when the accelerator changes", async () => {
    const config = testConfig({ backendClass: "cuda" });
    const first = await capacityHardwareIdentity(
      config,
      async () => "CUDA0: device-a"
    );
    const second = await capacityHardwareIdentity(
      config,
      async () => "CUDA0: device-b"
    );

    expect(first.acceleratorFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second.acceleratorFingerprint).not.toBe(
      first.acceleratorFingerprint
    );
    expect(second.hardwareFingerprint).not.toBe(first.hardwareFingerprint);
  });

  it("fails non-CPU capacity identity closed without a device listing", async () => {
    const config = testConfig({ backendClass: "metal" });

    await expect(
      capacityHardwareIdentity(config, async () => null)
    ).rejects.toMatchObject({
      statusCode: 503,
      detail: "embedding accelerator identity is unavailable"
    });
  });

  it("rejects HTTP bind failures through the awaited startup path", async () => {
    const service = {
      handle: async () => new Response(null, { status: 204 })
    };
    const occupied = createNodeHttpServer(service);
    await listenNodeHttpServer(occupied, "127.0.0.1", 0);
    const address = occupied.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");

    const conflicting = createNodeHttpServer(service);
    await expect(
      listenNodeHttpServer(
        conflicting,
        "127.0.0.1",
        typeof address === "string" || address === null ? 0 : address.port
      )
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("reports loading health until configured reranker is loaded", async () => {
    const config = testConfig({
      embeddingServiceToken: "secret",
      rerankerKey: "qwen3-reranker-0.6b",
      rerankerRepo: "repo",
      rerankerFile: "reranker.gguf",
      rerankerModelPath: "/models/reranker.gguf"
    });
    const runtime = new RouteRuntime(config, logger());
    runtime.healthRerankerLoaded = false;
    const service = createEmbeddingService(config, runtime, logger());

    const response = await service.handle(
      new Request("http://127.0.0.1/health", {
        headers: { "x-koed-embedding-token": "secret" }
      })
    );
    const payload = await json(response);

    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(payload.status).toBe("loading");
    expect(payload.queue).toEqual({
      active: false,
      waiting_interactive: 0,
      waiting_background: 1
    });
    expect(payload.reranker).toMatchObject({
      enabled: true,
      loaded: false,
      modelKey: "qwen3-reranker-0.6b",
      batchLimit: 100
    });
  });

  it("returns ready health with configured request id", async () => {
    const config = testConfig({
      rerankerKey: "qwen3-reranker-0.6b",
      rerankerRepo: "repo",
      rerankerFile: "reranker.gguf",
      rerankerModelPath: "/models/reranker.gguf"
    });
    const runtime = new RouteRuntime(config, logger());
    const service = createEmbeddingService(config, runtime, logger());

    const response = await service.handle(
      new Request("http://127.0.0.1/health", {
        headers: { "x-request-id": "operator-request-1" }
      })
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("operator-request-1");
    expect(payload.status).toBe("ok");
    expect(payload.modelKey).toBe("qwen3-0.6b");
    expect(payload.normalized).toBe(true);
  });

  it("protects the content-free capacity identity with the internal token", async () => {
    const config = testConfig({
      embeddingServiceToken: "secret",
      backendClass: "cpu",
      runtimeVersion: "llama-server-test"
    });
    const runtime = new RouteRuntime(config, logger());
    const service = createEmbeddingService(config, runtime, logger());

    const rejected = await service.handle(
      new Request("http://127.0.0.1/capacity/identity")
    );
    const accepted = await service.handle(
      new Request("http://127.0.0.1/capacity/identity", {
        headers: { "x-koed-embedding-token": "secret" }
      })
    );
    const payload = await json(accepted);

    expect(rejected.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      modelKey: "qwen3-0.6b",
      dimensions: 3,
      runtimeKind: "llama-server",
      runtimeVersion: "llama-server-test",
      backendClass: "cpu"
    });
    expect(payload.acceleratorFingerprint).toBeNull();
    expect(payload.hardwareFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.settingsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(payload)).not.toContain("/models/embedding.gguf");
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("requires embed auth and returns chunk metadata", async () => {
    const config = testConfig({ embeddingServiceToken: "secret" });
    const runtime = new RouteRuntime(config, logger());
    const service = createEmbeddingService(config, runtime, logger());

    const rejected = await service.handle(
      new Request("http://127.0.0.1/embed", {
        method: "POST",
        body: JSON.stringify({ texts: ["hello memory"] })
      })
    );
    const accepted = await service.handle(
      new Request("http://127.0.0.1/embed", {
        method: "POST",
        body: JSON.stringify({ texts: ["hello memory"] }),
        headers: {
          "x-koed-embedding-token": "secret",
          "x-koed-embedding-priority": "background"
        }
      })
    );
    const payload = await json(accepted);

    expect(rejected.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(payload.measuredTokens).toBe(2);
    expect((payload.chunks as Array<Record<string, unknown>>)[0]).toMatchObject(
      {
        chunkCount: 1,
        tokenCount: 2
      }
    );
    expect(runtime.embedCalls).toEqual([
      { texts: ["hello memory"], priority: "background" }
    ]);
  });

  it("validates embed limits before runtime calls", async () => {
    const config = testConfig({
      batchLimit: 1,
      embeddingMaxTextChars: 5,
      embeddingMaxRequestChars: 10
    });
    const runtime = new RouteRuntime(config, logger());
    const service = createEmbeddingService(config, runtime, logger());

    const tooMany = await service.handle(
      new Request("http://127.0.0.1/embed", {
        method: "POST",
        body: JSON.stringify({ texts: ["one", "two"] })
      })
    );
    const tooLong = await service.handle(
      new Request("http://127.0.0.1/embed", {
        method: "POST",
        body: JSON.stringify({ texts: ["toolong"] })
      })
    );

    expect(tooMany.status).toBe(422);
    expect(tooLong.status).toBe(422);
    expect(runtime.embedCalls).toEqual([]);
  });

  it("returns rerank scores and maps failures", async () => {
    const config = testConfig({
      rerankerKey: "qwen3-reranker-0.6b",
      rerankerRepo: "repo",
      rerankerFile: "reranker.gguf",
      rerankerModelPath: "/models/reranker.gguf"
    });
    const runtime = new RouteRuntime(config, logger());
    const service = createEmbeddingService(config, runtime, logger());

    const response = await service.handle(
      new Request("http://127.0.0.1/rerank", {
        method: "POST",
        body: JSON.stringify({ query: "question", documents: ["one", "two"] })
      })
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      model: "qwen3-reranker-0.6b",
      scores: [0.2, 0.9]
    });
    expect(runtime.rerankCalls).toEqual([
      { query: "question", documents: ["one", "two"] }
    ]);

    runtime.rerankTexts = async () => {
      throw new Error("server down");
    };
    const failed = await service.handle(
      new Request("http://127.0.0.1/rerank", {
        method: "POST",
        body: JSON.stringify({ query: "question", documents: ["one", "two"] })
      })
    );
    expect(failed.status).toBe(500);
    expect((await json(failed)).detail).toContain("model reranking failed");
  });
});
