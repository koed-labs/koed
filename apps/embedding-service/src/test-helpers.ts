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
  rerankerServerPort: 18081,
  rerankerBatchLimit: 100,
  rerankerContextPerSlot: 8192,
  rerankerNCtx: 100,
  rerankerNThreads: 4,
  rerankerNBatch: 5,
  rerankerNUbatch: 5,
  rerankerParallel: 1,
  rerankerPromptCacheEnabled: true,
  embeddingServiceToken: "",
  logLevel: "critical",
  ...overrides
});

export const testLogger = () =>
  createEmbeddingLogger("critical", () => undefined);
