import type { EmbeddingServiceEnv } from "./env-config.js";
import { createEmbeddingLogger } from "./logging.js";

export const testConfig = (
  overrides: Partial<EmbeddingServiceEnv> = {}
): EmbeddingServiceEnv => ({
  host: "127.0.0.1",
  port: 3800,
  modelKey: "qwen3-0.6b",
  modelRepo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
  modelFile: "Qwen3-Embedding-0.6B-Q8_0.gguf",
  modelPath: "/models/embedding.gguf",
  modelName: "test-model",
  modelArtifact:
    "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
  modelArtifactRevision: "main",
  modelArtifactSha256:
    "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
  modelTokenizer: "qwen3-embedding-0.6b-gguf",
  modelTokenizerRevision:
    "embedded-in-artifact:06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
  embeddingAccelerationPolicy: "cpu",
  embeddingAccelerationDevice: null,
  embeddingGpuIdleUnloadSeconds: 300,
  expectedDimensions: 3,
  batchLimit: 16,
  llamaNCtx: 100,
  embeddingMaxTokens: 100,
  embeddingMaxTextChars: 200000,
  embeddingMaxRequestChars: 1000000,
  llamaNThreads: 4,
  llamaNBatch: 5,
  llamaBatchTokenHeadroom: 0,
  llamaNUbatch: 5,
  llamaParallel: 1,
  llamaServerBinary: "/opt/llama.cpp/llama-server",
  llamaServerStartupTimeoutSeconds: 180,
  embeddingServerPort: 18080,
  rerankerKey: null,
  rerankerRepo: null,
  rerankerFile: null,
  rerankerModelPath: null,
  rerankerArtifact: null,
  rerankerArtifactSha256: null,
  rerankerServerPort: 18081,
  rerankerBatchLimit: 100,
  rerankerContextPerSlot: 8192,
  rerankerNCtx: 100,
  rerankerNThreads: 4,
  rerankerNBatch: 5,
  rerankerNUbatch: 5,
  rerankerParallel: 1,
  rerankerPromptCacheEnabled: true,
  rerankerAccelerationPolicy: "cpu",
  rerankerAccelerationDevice: null,
  rerankerGpuIdleUnloadSeconds: 300,
  embeddingServiceToken: "",
  runtimeVersion: "test",
  logLevel: "critical",
  ...overrides
});

export const testLogger = () =>
  createEmbeddingLogger("critical", () => undefined);
