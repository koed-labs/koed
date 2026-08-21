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
import type { ResolvedAcceleration } from "./acceleration.js";

const cpuAcceleration: ResolvedAcceleration = {
  policy: "cpu",
  backend: "cpu",
  device: null,
  gpuLayers: "0",
  fallbackReason: null,
  deviceListing: null
};

class RouteRuntime extends EmbeddingRuntime {
  embedCalls: Array<{ texts: string[]; priority: string | null }> = [];
  rerankCalls: Array<{ query: string; documents: string[] }> = [];
  healthModelLoaded = true;
  healthRerankerLoaded = true;
  resolvedEmbeddingAcceleration: ResolvedAcceleration = cpuAcceleration;
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
    artifact: "repo:reranker.gguf",
    artifactRevision: `sha256:${"a".repeat(64)}`,
    artifactHash: "a".repeat(64),
    latencyMs: 12,
    inputTokens: 29,
    costUsd: 0,
    scores: [0.2, 0.9]
  };

  override isModelLoaded(): boolean {
    return this.healthModelLoaded;
  }

  override isRerankerLoaded(): boolean {
    return this.healthRerankerLoaded;
  }

  override rerankerProvenance() {
    return this.healthRerankerLoaded && this.config.rerankerKey
      ? {
          model: this.config.rerankerKey,
          artifact: this.config.rerankerArtifact ?? "repo:reranker.gguf",
          artifactRevision: `sha256:${this.config.rerankerArtifactSha256 ?? "a".repeat(64)}`,
          artifactHash: this.config.rerankerArtifactSha256 ?? "a".repeat(64)
        }
      : null;
  }

  override healthQueueSnapshot() {
    return { active: false, waiting_interactive: 0, waiting_background: 1 };
  }

  override embeddingAcceleration(): ResolvedAcceleration {
    return this.resolvedEmbeddingAcceleration;
  }

  override rerankerAcceleration(): ResolvedAcceleration | null {
    return this.config.rerankerKey ? cpuAcceleration : null;
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
    const first = await capacityHardwareIdentity({
      policy: "cuda",
      backend: "cuda",
      device: "CUDA0",
      gpuLayers: "all",
      fallbackReason: null,
      deviceListing: "CUDA0: device-a"
    });
    const second = await capacityHardwareIdentity({
      policy: "cuda",
      backend: "cuda",
      device: "CUDA0",
      gpuLayers: "all",
      fallbackReason: null,
      deviceListing: "CUDA0: device-b"
    });

    expect(first.acceleratorFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second.acceleratorFingerprint).not.toBe(
      first.acceleratorFingerprint
    );
    expect(second.hardwareFingerprint).not.toBe(first.hardwareFingerprint);
  });

  it("fails non-CPU capacity identity closed without a device listing", async () => {
    await expect(
      capacityHardwareIdentity({
        policy: "metal",
        backend: "metal",
        device: "Metal",
        gpuLayers: "all",
        fallbackReason: null,
        deviceListing: null
      })
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
      rerankerModelPath: "/models/reranker.gguf",
      rerankerArtifact: "repo:reranker.gguf",
      rerankerArtifactSha256: "a".repeat(64)
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
      rerankerModelPath: "/models/reranker.gguf",
      rerankerArtifact: "repo:reranker.gguf",
      rerankerArtifactSha256: "a".repeat(64)
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
    expect(payload).toMatchObject({
      artifact: `sha256:06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`,
      artifactRevision: "main",
      artifactHash:
        "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      tokenizer: "qwen3-embedding-0.6b-gguf",
      tokenizerRevision:
        "embedded-in-artifact:06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      acceleration: "cpu;runtime=llama.cpp;n-gpu-layers=0"
    });
    expect(payload).not.toHaveProperty("gpuIdleUnloadSeconds");
    expect(payload.reranker).not.toHaveProperty("gpuIdleUnloadSeconds");
    expect(payload.reranker).toMatchObject({
      artifact: `sha256:${"a".repeat(64)}`,
      artifactRevision: `sha256:${"a".repeat(64)}`,
      artifactHash: "a".repeat(64)
    });
  });

  it("protects the content-free capacity identity with the internal token", async () => {
    const config = testConfig({
      embeddingServiceToken: "secret",
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

  it("exposes configured artifact provenance only to an authenticated health request", async () => {
    const config = testConfig({ embeddingServiceToken: "secret" });
    const runtime = new RouteRuntime(config, logger());
    const service = createEmbeddingService(config, runtime, logger());

    const response = await service.handle(
      new Request("http://127.0.0.1/health", {
        headers: { "x-koed-embedding-token": "secret" }
      })
    );
    const payload = await json(response);

    expect(payload.artifact).toBe(config.modelArtifact);
    expect(payload.gpuIdleUnloadSeconds).toBe(0);
    expect(payload.reranker).not.toHaveProperty("gpuIdleUnloadSeconds");
  });

  it("does not expose raw accelerator device details through public health", async () => {
    const config = testConfig();
    const runtime = new RouteRuntime(config, logger());
    runtime.resolvedEmbeddingAcceleration = {
      policy: "cuda",
      backend: "cuda",
      device: "CUDA0",
      gpuLayers: "all",
      fallbackReason: null,
      deviceListing: "CUDA0: private device description"
    };
    const service = createEmbeddingService(config, runtime, logger());

    const payload = await json(
      await service.handle(new Request("http://127.0.0.1/health"))
    );

    expect(payload.acceleration).toBe(
      "cuda;runtime=llama.cpp;n-gpu-layers=all"
    );
    expect(JSON.stringify(payload)).not.toContain("CUDA0");
    expect(JSON.stringify(payload)).not.toContain("private device");
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
      rerankerModelPath: "/models/reranker.gguf",
      rerankerArtifact: "repo:reranker.gguf",
      rerankerArtifactSha256: "a".repeat(64)
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
      artifact: "repo:reranker.gguf",
      artifactRevision: `sha256:${"a".repeat(64)}`,
      artifactHash: "a".repeat(64),
      latencyMs: 12,
      inputTokens: 29,
      costUsd: 0,
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
    expect(await json(failed)).toEqual({
      detail: "reranking request failed",
      code: "reranking_runtime_error"
    });
  });

  it("redacts runtime and model details from embedding responses and logs", async () => {
    const responseSentinel = "upstream-model-response-sentinel";
    const querySentinel = "team-query-log-sentinel";
    const lines: string[] = [];
    const config = testConfig();
    const redactingLogger = createEmbeddingLogger("debug", (line) =>
      lines.push(line)
    );
    const runtime = new RouteRuntime(config, redactingLogger);
    runtime.embedText = async () => {
      throw new Error(`${responseSentinel} ${querySentinel}`);
    };
    const service = createEmbeddingService(config, runtime, redactingLogger);

    const failed = await service.handle(
      new Request("http://127.0.0.1/embed", {
        method: "POST",
        body: JSON.stringify({ texts: [querySentinel] })
      })
    );

    expect(failed.status).toBe(500);
    expect(await json(failed)).toEqual({
      detail: "embedding request failed",
      code: "embedding_runtime_error"
    });
    const logged = lines.join("\n");
    expect(logged).not.toContain(responseSentinel);
    expect(logged).not.toContain(querySentinel);
  });
});
