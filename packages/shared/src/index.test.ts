import { describe, expect, it } from "vitest";
import {
  configFlagEnabled,
  createHealth,
  memoryEmbedQueueName,
  metadataWithStorageSanitization,
  requireEnv,
  resolveKoedQueueBackend,
  resolveRerankerKeyFromEnv,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig,
  sanitizeForPostgresStorage,
  workerQueueNames
} from "./index.js";

describe("createHealth", () => {
  it("creates an ok health payload", () => {
    expect(createHealth("test").status).toBe("ok");
  });
});

describe("resolveKoedQueueBackend", () => {
  it("uses bullmq default and keeps known values", () => {
    expect(resolveKoedQueueBackend(undefined)).toBe("bullmq");
    expect(resolveKoedQueueBackend("local")).toBe("local");
  });

  it("falls back for unsupported queue backends", () => {
    expect(resolveKoedQueueBackend("unsupported", "local")).toBe("local");
  });
});

describe("workerQueueNames", () => {
  it("keeps memory embed queue name stable", () => {
    expect(memoryEmbedQueueName).toBe("memory-embed");
    expect(workerQueueNames).toEqual([
      "memory-embed",
      "lcm-compact",
      "lcm-embed"
    ]);
  });
});

describe("configFlagEnabled", () => {
  it("parses common truthy flag values", () => {
    expect(configFlagEnabled("true")).toBe(true);
    expect(configFlagEnabled(" YES ")).toBe(true);
    expect(configFlagEnabled("0")).toBe(false);
  });
});

describe("requireEnv", () => {
  it("throws for missing required values", () => {
    expect(() => requireEnv(["DATABASE_URL", "API_TOKEN_PEPPER"], {})).toThrow(
      "DATABASE_URL, API_TOKEN_PEPPER"
    );
  });

  it("rejects generated-secret placeholders", () => {
    expect(() =>
      requireEnv(["COLLABORATION_REALTIME_CURSOR_SECRET"], {
        COLLABORATION_REALTIME_CURSOR_SECRET:
          "replace_with_generated_realtime_cursor_secret"
      })
    ).toThrow("COLLABORATION_REALTIME_CURSOR_SECRET");
  });

  it("allows present required values", () => {
    expect(() =>
      requireEnv(["DATABASE_URL"], { DATABASE_URL: "postgres://db" })
    ).not.toThrow();
  });
});

describe("sanitizeForPostgresStorage", () => {
  it("replaces NUL characters and malformed UTF-16 in nested values and object keys", () => {
    const result = sanitizeForPostgresStorage({
      plain: `a${"\u0000"}b${"\uD800"}c`,
      nested: [{ [`key${"\uDC00"}name`]: `value${"\uD800"}text` }]
    });

    expect(result.replacementCount).toBe(4);
    expect(result.counts).toEqual({
      nulCharacters: 1,
      malformedUtf16: 3
    });
    expect(result.value).toEqual({
      plain: "a�b�c",
      nested: [{ "key�name": "value�text" }]
    });
  });

  it("leaves valid Unicode and normal whitespace unchanged", () => {
    const value = {
      mandarin: "你好，世界",
      emoji: "Koed 🚀",
      accents: "Cafe\u0301",
      whitespace: "line one\nline two\tindented"
    };

    expect(sanitizeForPostgresStorage(value)).toEqual({
      value,
      replacementCount: 0,
      counts: {
        nulCharacters: 0,
        malformedUtf16: 0
      }
    });
  });
});

describe("metadataWithStorageSanitization", () => {
  it("adds separate storage sanitization markers without dropping metadata", () => {
    expect(
      metadataWithStorageSanitization(
        {
          workflow: "capture",
          koedSanitization: {
            previous: true
          }
        },
        {
          nulCharacters: 2,
          malformedUtf16: 3
        }
      )
    ).toEqual({
      workflow: "capture",
      koedSanitization: {
        previous: true,
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 2
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 3
        }
      }
    });
  });
});

describe("resolveSupportedEmbeddingModelConfig", () => {
  it("resolves supported embedding model metadata", () => {
    expect(resolveSupportedEmbeddingModelConfig("qwen3-0.6b")).toEqual({
      key: "qwen3-0.6b",
      dimensions: 1024,
      artifact:
        "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
      artifactRevision: "main",
      defaultArtifactSha256:
        "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      tokenizer: "qwen3-embedding-0.6b-gguf",
      tokenizerRevision:
        "embedded-in-artifact:06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      inputTransform: "qwen3-retrieval-document-v1",
      pooling: "last",
      normalization: "l2",
      acceleration: "cpu;runtime=llama.cpp;n-gpu-layers=0"
    });
  });

  it("rejects unsupported embedding model keys", () => {
    expect(() => resolveSupportedEmbeddingModelConfig("unknown")).toThrow(
      "Unsupported embedding model key"
    );
  });
});

describe("resolveSupportedRerankerModelConfig", () => {
  it("resolves supported reranker model metadata", () => {
    expect(resolveSupportedRerankerModelConfig("qwen3-reranker-0.6b")).toEqual({
      key: "qwen3-reranker-0.6b",
      model:
        "Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp:Qwen3-Reranker-0.6B-Q4_K_M.gguf"
    });
  });

  it("treats a blank reranker key as disabled", () => {
    expect(resolveSupportedRerankerModelConfig("")).toBeNull();
    expect(resolveSupportedRerankerModelConfig(undefined)).toBeNull();
  });

  it("rejects unsupported reranker model keys", () => {
    expect(() => resolveSupportedRerankerModelConfig("unknown")).toThrow(
      "Unsupported reranker model key"
    );
  });
});

describe("resolveRerankerKeyFromEnv", () => {
  it("uses the documented root reranker key when the app-local key is absent", () => {
    expect(
      resolveRerankerKeyFromEnv({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b"
      })
    ).toBe("qwen3-reranker-0.6b");
  });

  it("lets the app-local reranker key override the generated root key", () => {
    expect(
      resolveRerankerKeyFromEnv({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
        RERANKER_KEY: "app-local"
      })
    ).toBe("app-local");
  });

  it("lets a blank app-local reranker key disable a generated root key", () => {
    expect(
      resolveRerankerKeyFromEnv({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
        RERANKER_KEY: ""
      })
    ).toBe("");
  });
});
