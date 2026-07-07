import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_LLAMA_SERVER_BINARY,
  QWEN_OPERATIONAL_MAX_TOKENS,
  boolEnv,
  intEnv,
  loadEmbeddingServiceEnv,
  rerankerModel,
  resolveEnv,
  strEnv
} from "./env-config.js";

describe("Embedding Service env config", () => {
  it("uses positive integer, bool, and trimmed string helpers", () => {
    expect(intEnv({ COUNT: "12" }, "COUNT", 3)).toBe(12);
    expect(intEnv({ COUNT: "0" }, "COUNT", 3)).toBe(3);
    expect(intEnv({ COUNT: "nope" }, "COUNT", 3)).toBe(3);
    expect(boolEnv({ FLAG: "yes" }, "FLAG", false)).toBe(true);
    expect(boolEnv({ FLAG: "false" }, "FLAG", true)).toBe(false);
    expect(
      strEnv({ PATH_VALUE: " /custom/bin " }, "PATH_VALUE", "/fallback")
    ).toBe("/custom/bin");
    expect(strEnv({ PATH_VALUE: "" }, "PATH_VALUE", "/fallback")).toBe(
      "/fallback"
    );
  });

  it("loads app .env values without overriding process values", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "koed-embedding-env-"));
    try {
      const path = resolve(dir, ".env");
      writeFileSync(
        path,
        "MODEL_KEY=qwen3-0.6b\nLOG_LEVEL=debug\nEMBEDDING_SERVICE_TOKEN='from-file'\n"
      );
      const environment: NodeJS.ProcessEnv = {
        EMBEDDING_SERVICE_TOKEN: "existing"
      };

      loadEmbeddingServiceEnv(path, environment);

      expect(environment.MODEL_KEY).toBe("qwen3-0.6b");
      expect(environment.LOG_LEVEL).toBe("debug");
      expect(environment.EMBEDDING_SERVICE_TOKEN).toBe("existing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies defaults and root/app aliases", () => {
    const config = resolveEnv({
      EMBEDDING_MODEL_KEY: "qwen3-0.6b",
      EMBEDDING_LLAMA_N_CTX: "4096",
      EMBEDDING_SERVICE_TOKEN: " token ",
      EMBEDDING_LOG_LEVEL: "debug",
      EMBEDDING_LLAMA_SERVER_BINARY: "/custom/llama-server",
      EMBEDDING_MODEL_PATH: "/models/embedding.gguf"
    });

    expect(config.modelKey).toBe("qwen3-0.6b");
    expect(config.modelRepo).toBe("Qwen/Qwen3-Embedding-0.6B-GGUF");
    expect(config.modelName).toBe("qwen3-0.6b");
    expect(config.expectedDimensions).toBe(1024);
    expect(config.llamaNCtx).toBe(4096);
    expect(config.embeddingMaxTokens).toBe(4096);
    expect(config.embeddingServiceToken).toBe("token");
    expect(config.logLevel).toBe("debug");
    expect(config.llamaNBatch).toBe(8192);
    expect(config.llamaBatchTokenHeadroom).toBe(8);
    expect(config.llamaNUbatch).toBe(8192);
    expect(config.llamaParallel).toBe(1);
    expect(config.llamaServerBinary).toBe("/custom/llama-server");
    expect(config.modelPath).toBe("/models/embedding.gguf");
    expect(config.embeddingServerPort).toBe(18080);
    expect(config.rerankerContextPerSlot).toBe(8192);
    expect(config.rerankerNCtx).toBe(32768);
    expect(config.rerankerNBatch).toBe(8192);
    expect(config.rerankerNUbatch).toBe(8192);
    expect(config.rerankerParallel).toBe(4);
    expect(config.rerankerPromptCacheEnabled).toBe(true);
  });

  it("uses MODEL_KEY app-local precedence and defaults blank keys", () => {
    expect(resolveEnv({ MODEL_KEY: "" }).modelKey).toBe("qwen3-0.6b");
    expect(
      resolveEnv({
        MODEL_KEY: "qwen3-0.6b",
        EMBEDDING_MODEL_KEY: "ignored"
      }).modelKey
    ).toBe("qwen3-0.6b");
  });

  it("caps max tokens with the requested formula", () => {
    expect(
      resolveEnv({
        LLAMA_N_CTX: String(QWEN_OPERATIONAL_MAX_TOKENS + 1),
        LLAMA_N_BATCH: String(QWEN_OPERATIONAL_MAX_TOKENS + 8),
        LLAMA_BATCH_TOKEN_HEADROOM: "8",
        EMBEDDING_MAX_TOKENS: String(QWEN_OPERATIONAL_MAX_TOKENS + 1)
      }).embeddingMaxTokens
    ).toBe(QWEN_OPERATIONAL_MAX_TOKENS);

    expect(
      resolveEnv({
        LLAMA_N_CTX: "2048",
        LLAMA_N_BATCH: "8192",
        EMBEDDING_MAX_TOKENS: "4096"
      }).embeddingMaxTokens
    ).toBe(2048);

    expect(
      resolveEnv({
        LLAMA_N_CTX: "32768",
        LLAMA_N_BATCH: "8192",
        LLAMA_BATCH_TOKEN_HEADROOM: "8",
        EMBEDDING_MAX_TOKENS: "32768"
      }).embeddingMaxTokens
    ).toBe(8184);

    expect(
      resolveEnv({
        LLAMA_N_CTX: "32768",
        LLAMA_N_BATCH: "4",
        LLAMA_BATCH_TOKEN_HEADROOM: "8",
        EMBEDDING_MAX_TOKENS: "32768"
      }).embeddingMaxTokens
    ).toBe(1);
  });

  it("resolves and validates reranker settings", () => {
    const config = resolveEnv({
      EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
      EMBEDDING_RERANKER_MODEL_PATH: "/models/reranker.gguf",
      EMBEDDING_RERANKER_CONTEXT_PER_SLOT: "2048",
      EMBEDDING_RERANKER_PARALLEL: "3",
      EMBEDDING_RERANKER_LLAMA_N_THREADS: "7",
      EMBEDDING_RERANKER_LLAMA_N_BATCH: "2048",
      EMBEDDING_RERANKER_LLAMA_N_UBATCH: "1024",
      EMBEDDING_RERANKER_PROMPT_CACHE_ENABLED: "false"
    });

    expect(config.rerankerKey).toBe("qwen3-reranker-0.6b");
    expect(config.rerankerRepo).toBe(
      "Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp"
    );
    expect(config.rerankerFile).toBe("Qwen3-Reranker-0.6B-Q4_K_M.gguf");
    expect(rerankerModel(config)).toBe("/models/reranker.gguf");
    expect(config.rerankerContextPerSlot).toBe(2048);
    expect(config.rerankerNCtx).toBe(6144);
    expect(config.rerankerNThreads).toBe(7);
    expect(config.rerankerNBatch).toBe(2048);
    expect(config.rerankerNUbatch).toBe(1024);
    expect(config.rerankerParallel).toBe(3);
    expect(config.rerankerPromptCacheEnabled).toBe(false);
  });

  it("rejects unsupported keys and port collisions", () => {
    expect(() => resolveEnv({ MODEL_KEY: "unsupported" })).toThrow(
      "Unsupported MODEL_KEY"
    );
    expect(() => resolveEnv({ RERANKER_KEY: "unsupported" })).toThrow(
      "Unsupported RERANKER_KEY"
    );
    expect(() =>
      resolveEnv({ RERANKER_MODEL_PATH: "/models/reranker.gguf" })
    ).toThrow("RERANKER_MODEL_PATH requires");
    expect(() =>
      resolveEnv({
        LLAMA_EMBEDDING_SERVER_PORT: "18080",
        LLAMA_RERANKER_SERVER_PORT: "18080"
      })
    ).toThrow("must differ");
  });

  it("keeps Python default llama-server path for app-local direct runs", () => {
    expect(resolveEnv({ LLAMA_SERVER_BINARY: "" }).llamaServerBinary).toBe(
      DEFAULT_LLAMA_SERVER_BINARY
    );
  });
});
