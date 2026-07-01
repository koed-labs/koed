import { describe, expect, it } from "vitest";
import { resolveWorkerEnv } from "./env-config.js";

describe("resolveWorkerEnv", () => {
  it("uses development defaults", () => {
    expect(resolveWorkerEnv({})).toEqual({
      queueBackend: "bullmq",
      redisUrl: "redis://localhost:6379",
      databaseConfigured: false,
      embeddingServiceUrl: "http://embedding-service:8000",
      embeddingDimensions: 1024,
      embeddingVersion: "qwen3-0.6b",
      rawProjectionIntervalMs: 5000,
      rawProjectionBatchLimit: 1000,
      rawProjectionActorLimit: 10,
      logLevel: "info",
      logDestination: { destination: "stderr" },
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
        EMBEDDING_SERVICE_TOKEN: " worker-token ",
        MEMORY_RAW_PROJECTION_INTERVAL_MS: "3000",
        MEMORY_RAW_PROJECTION_BATCH_LIMIT: "50",
        MEMORY_RAW_PROJECTION_ACTOR_LIMIT: "4",
        WORKER_LOG_LEVEL: "debug",
        WORKER_LOG_DESTINATION: "both",
        WORKER_LOG_FILE: "/tmp/koed-worker.log",
        EMBEDDING_MODEL: "qwen3-0.6b"
      })
    ).toMatchObject({
      queueBackend: "bullmq",
      redisUrl: "redis://local:6379",
      databaseUrl: "postgres://local",
      databaseConfigured: true,
      embeddingServiceUrl: "http://localhost:8000",
      embeddingServiceToken: "worker-token",
      embeddingDimensions: 1024,
      embeddingVersion: "qwen3-0.6b",
      rawProjectionIntervalMs: 3000,
      rawProjectionBatchLimit: 50,
      rawProjectionActorLimit: 4,
      logLevel: "debug",
      logDestination: {
        destination: "both",
        filePath: "/tmp/koed-worker.log"
      }
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

  it("validates the documented root reranker key alias", () => {
    expect(() =>
      resolveWorkerEnv({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b"
      })
    ).not.toThrow();
    expect(() =>
      resolveWorkerEnv({
        EMBEDDING_RERANKER_KEY: "unsupported"
      })
    ).toThrow("Unsupported reranker model key");
  });

  it("accepts local queue backend override", () => {
    expect(
      resolveWorkerEnv({
        WORK_QUEUE_BACKEND: "local"
      }).queueBackend
    ).toBe("local");
  });

  it("requires production BullMQ service configuration", () => {
    expect(() => resolveWorkerEnv({ NODE_ENV: "production" })).toThrow(
      "DATABASE_URL, REDIS_URL, DATA_ENCRYPTION_KEY, EMBEDDING_SERVICE_URL, EMBEDDING_SERVICE_TOKEN, EMBEDDING_MODEL"
    );
  });

  it("does not require Redis in production local queue mode", () => {
    expect(() =>
      resolveWorkerEnv({
        NODE_ENV: "production",
        WORK_QUEUE_BACKEND: "local",
        DATABASE_URL: "postgres://local",
        DATA_ENCRYPTION_KEY: "secret",
        EMBEDDING_SERVICE_URL: "http://localhost:8000",
        EMBEDDING_SERVICE_TOKEN: "token",
        EMBEDDING_MODEL: "qwen3-0.6b"
      })
    ).not.toThrow();
  });
});
