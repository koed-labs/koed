import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_LLAMA_SERVER_BINARY,
  DEFAULT_LLAMA_N_CTX,
  QWEN_OPERATIONAL_MAX_TOKENS,
  boolEnv,
  intEnv,
  loadEmbeddingServiceEnv,
  resolveEnv,
  strEnv,
  verifyEmbeddingModelArtifact
} from "./env-config.js";

describe("Embedding Service env config", () => {
  it("verifies the configured artifact checksum once at startup", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "koed-embedding-model-"));
    const modelPath = resolve(directory, "model.gguf");
    writeFileSync(modelPath, "small fixture model");
    const modelArtifactSha256 = createHash("sha256")
      .update("small fixture model")
      .digest("hex");
    try {
      await expect(
        verifyEmbeddingModelArtifact({
          modelPath,
          modelFile: "model.gguf",
          modelArtifactSha256
        })
      ).resolves.toBeUndefined();
      await expect(
        verifyEmbeddingModelArtifact({
          modelPath,
          modelFile: "model.gguf",
          modelArtifactSha256: "0".repeat(64)
        })
      ).rejects.toThrow("artifact SHA-256 mismatch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
    expect(config.modelArtifactSha256).toBe(
      "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
    );
    expect(config.modelTokenizer).toBe("qwen3-embedding-0.6b-gguf");
    expect(config.embeddingAccelerationPolicy).toBe("auto");
    expect(config.embeddingAccelerationDevice).toBeNull();
    expect(config.embeddingGpuIdleUnloadSeconds).toBe(300);

    expect(config.expectedDimensions).toBe(1024);
    expect(config.llamaNCtx).toBe(4096);
    expect(config.embeddingMaxTokens).toBe(4096);
    expect(config.embeddingServiceToken).toBe("token");
    expect(config.logLevel).toBe("debug");
    expect(config.llamaNBatch).toBe(8192);
    expect(config.llamaBatchTokenHeadroom).toBe(8);
    expect(config.llamaNUbatch).toBe(512);
    expect(config.llamaParallel).toBe(1);
    expect(config.llamaServerBinary).toBe("/custom/llama-server");
    expect(config.modelPath).toBe("/models/embedding.gguf");
    expect(config.embeddingServerPort).toBe(18080);
  });

  it("keeps the safe acceleration defaults when values are blank", () => {
    const config = resolveEnv({
      KOED_EMBEDDING_ACCELERATION: ""
    });

    expect(config.embeddingAccelerationPolicy).toBe("auto");

    expect(config.llamaNCtx).toBe(DEFAULT_LLAMA_N_CTX);
    expect(config.llamaNBatch).toBe(8192);
    expect(config.llamaNUbatch).toBe(512);
    expect(config.llamaParallel).toBe(1);
  });

  it("rejects unknown acceleration policies", () => {
    expect(() =>
      resolveEnv({ KOED_EMBEDDING_ACCELERATION: "fastest" })
    ).toThrow("KOED_EMBEDDING_ACCELERATION must be auto, cpu, metal, or cuda");
  });

  it("rejects malformed GPU idle unload values", () => {
    expect(() =>
      resolveEnv({ KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS: "-1" })
    ).toThrow(
      "KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS must be a non-negative integer"
    );
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

  it("rejects unsupported keys and invalid limits", () => {
    expect(() => resolveEnv({ MODEL_KEY: "unsupported" })).toThrow(
      "Unsupported MODEL_KEY"
    );

    expect(() =>
      resolveEnv({ KOED_EMBEDDING_MODEL_SHA256: "not-a-sha" })
    ).toThrow("artifact SHA-256");
  });

  it("keeps the app-local default llama-server path for direct runs", () => {
    expect(resolveEnv({ LLAMA_SERVER_BINARY: "" }).llamaServerBinary).toBe(
      DEFAULT_LLAMA_SERVER_BINARY
    );
  });
});
