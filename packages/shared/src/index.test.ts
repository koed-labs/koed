import { describe, expect, it } from "vitest";
import {
  configFlagEnabled,
  createHealth,
  requireEnv,
  resolveRerankerKeyFromEnv,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig
} from "./index.js";

describe("createHealth", () => {
  it("creates an ok health payload", () => {
    expect(createHealth("test").status).toBe("ok");
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

  it("allows present required values", () => {
    expect(() =>
      requireEnv(["DATABASE_URL"], { DATABASE_URL: "postgres://db" })
    ).not.toThrow();
  });
});

describe("resolveSupportedEmbeddingModelConfig", () => {
  it("resolves supported embedding model metadata", () => {
    expect(resolveSupportedEmbeddingModelConfig("qwen3-0.6b")).toEqual({
      key: "qwen3-0.6b",
      dimensions: 1024
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
      model: "n24q02m/Qwen3-Reranker-0.6B-ONNX"
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
