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
      embeddingBatchLimit: 16,
      embeddingMaxTextChars: 200_000,
      embeddingMaxRequestChars: 1_000_000,
      embeddingRequestTimeoutMs: 900000,
      rawProjectionIntervalMs: 5000,
      rawProjectionBatchLimit: 1000,
      rawProjectionActorLimit: 10,
      crossIdentitySyncIntervalMs: 1000,
      crossIdentitySyncStaleAfterSeconds: 86400,
      koedHome: resolve(homedir(), ".koed"),
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
        EMBEDDING_BATCH_LIMIT: "8",
        EMBEDDING_MAX_TEXT_CHARS: "120000",
        EMBEDDING_MAX_REQUEST_CHARS: "640000",
        EMBEDDING_REQUEST_TIMEOUT_MS: "1200000",
        MEMORY_RAW_PROJECTION_INTERVAL_MS: "3000",
        MEMORY_RAW_PROJECTION_BATCH_LIMIT: "50",
        MEMORY_RAW_PROJECTION_ACTOR_LIMIT: "4",
        CROSS_IDENTITY_SYNC_STALE_AFTER_SECONDS: "7200",
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
      embeddingBatchLimit: 8,
      embeddingMaxTextChars: 120_000,
      embeddingMaxRequestChars: 640_000,
      embeddingRequestTimeoutMs: 1200000,
      rawProjectionIntervalMs: 3000,
      rawProjectionBatchLimit: 50,
      rawProjectionActorLimit: 4,
      crossIdentitySyncStaleAfterSeconds: 7200,
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
      "DATABASE_URL, REDIS_URL, EMBEDDING_SERVICE_URL, EMBEDDING_SERVICE_TOKEN, EMBEDDING_MODEL"
    );
    expect(() =>
      resolveWorkerEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://local",
        REDIS_URL: "redis://localhost:6379",
        EMBEDDING_SERVICE_URL: "http://localhost:8000",
        EMBEDDING_SERVICE_TOKEN: "token",
        EMBEDDING_MODEL: "qwen3-0.6b"
      })
    ).toThrow(
      "Missing required environment variable: API_DATA_ENCRYPTION_KEY (or DATA_ENCRYPTION_KEY)"
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

  it("requires a KMS-backed provider for paid Koed-managed cloud", () => {
    const base = {
      NODE_ENV: "production",
      KOED_DEPLOYMENT_PROFILE: "koed_managed_cloud",
      KOED_MANAGED_CLOUD_RELEASE_STAGE: "paid",
      WORK_QUEUE_BACKEND: "local",
      DATABASE_URL: "postgres://local",
      EMBEDDING_SERVICE_URL: "http://localhost:8000",
      EMBEDDING_SERVICE_TOKEN: "token",
      EMBEDDING_MODEL: "qwen3-0.6b"
    };

    expect(() => resolveWorkerEnv(base)).toThrow(
      "A KMS-backed API_ENVELOPE_ENCRYPTION_PROVIDER"
    );
    expect(() =>
      resolveWorkerEnv({
        ...base,
        DATA_ENCRYPTION_KEY: "secret",
        API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms"
      })
    ).toThrow(
      "MANAGED_KMS_KEY_ID, MANAGED_KMS_KEY_VERSION, MANAGED_KMS_ENDPOINT_URL, MANAGED_KMS_AUTH_TOKEN"
    );
    expect(() =>
      resolveWorkerEnv({
        ...base,
        API_ENVELOPE_ENCRYPTION_PROVIDER: "byok",
        MANAGED_KMS_KEY_ID: "byok:customer-key",
        MANAGED_KMS_KEY_VERSION: "1",
        MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example",
        MANAGED_KMS_AUTH_TOKEN: "secret-token"
      })
    ).not.toThrow();
  });

  it("rejects unsupported commercial encryption providers", () => {
    const base = {
      NODE_ENV: "production",
      WORK_QUEUE_BACKEND: "local",
      DATABASE_URL: "postgres://local",
      EMBEDDING_SERVICE_URL: "http://localhost:8000",
      EMBEDDING_SERVICE_TOKEN: "token",
      EMBEDDING_MODEL: "qwen3-0.6b"
    };

    expect(() =>
      resolveWorkerEnv({
        ...base,
        API_ENVELOPE_ENCRYPTION_PROVIDER: "nonsense"
      })
    ).toThrow("Unsupported API_ENVELOPE_ENCRYPTION_PROVIDER");
    expect(() =>
      resolveWorkerEnv({
        ...base,
        API_ENVELOPE_ENCRYPTION_PROVIDER: "operator_kms"
      })
    ).toThrow("Envelope encryption provider is not implemented: operator_kms");
  });
});
import { homedir } from "node:os";
import { resolve } from "node:path";
