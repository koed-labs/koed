import { describe, expect, it } from "vitest";
import { resolveWorkerEnv } from "./env-config.js";

describe("resolveWorkerEnv", () => {
  it("uses development defaults", () => {
    expect(resolveWorkerEnv({})).toEqual({
      redisUrl: "redis://localhost:6379",
      databaseConfigured: false,
      embeddingServiceUrl: "http://embedding-service:8000",
      embeddingDimensions: 1024,
      embeddingVersion: "qwen3-0.6b",
      nodeEnv: "development",
      production: false
    });
  });

  it("parses configured service values", () => {
    expect(
      resolveWorkerEnv({
        DATABASE_URL: "postgres://local",
        REDIS_URL: "redis://local:6379",
        EMBEDDING_SERVICE_URL: "http://localhost:8000",
        EMBEDDING_MODEL: "qwen3-0.6b"
      })
    ).toMatchObject({
      redisUrl: "redis://local:6379",
      databaseConfigured: true,
      embeddingServiceUrl: "http://localhost:8000",
      embeddingDimensions: 1024,
      embeddingVersion: "qwen3-0.6b"
    });
  });

  it("rejects unsupported embedding model keys", () => {
    expect(() =>
      resolveWorkerEnv({
        EMBEDDING_MODEL: "unsupported"
      })
    ).toThrow("Unsupported embedding model key");
  });

  it("rejects unsupported reranker model keys", () => {
    expect(() =>
      resolveWorkerEnv({
        RERANKER_KEY: "unsupported"
      })
    ).toThrow("Unsupported reranker model key");
  });

  it("requires production service configuration", () => {
    expect(() => resolveWorkerEnv({ NODE_ENV: "production" })).toThrow(
      "DATABASE_URL, REDIS_URL, DATA_ENCRYPTION_KEY, EMBEDDING_SERVICE_URL, EMBEDDING_SERVICE_TOKEN, EMBEDDING_MODEL"
    );
  });
});
