import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkerEnv } from "./env-config.js";

describe("resolveWorkerEnv", () => {
  it("uses development defaults", () => {
    expect(resolveWorkerEnv({})).toEqual({
      teamCollaborationEnabled: false,
      queueBackend: "bullmq",
      redisUrl: "redis://localhost:6379",
      databaseConfigured: false,
      embeddingServiceUrl: "http://embedding-service:8000",
      embeddingPoolKey: "default",
      embeddingDimensions: 1024,
      embeddingVersion: "qwen3-0.6b",
      embeddingModelArtifactHash:
        "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
      embeddingTokenizer: "qwen3-embedding-0.6b-gguf",
      embeddingInputTransform: "qwen3-retrieval-document-v1",
      embeddingPooling: "last",
      embeddingNormalization: "l2",
      embeddingBatchLimit: 16,
      embeddingMaxTextChars: 200_000,
      embeddingMaxRequestChars: 1_000_000,
      embeddingRequestTimeoutMs: 900000,
      embeddingCapacityRefinedDelayMs: 1800000,
      rawProjectionBatchLimit: 1000,
      rawProjectionActorLimit: 10,
      crossIdentitySyncIntervalMs: 1000,
      crossIdentitySyncStaleAfterSeconds: 86400,
      retentionPurgeIntervalMs: 1000,
      collaborationReplayPruneIntervalMs: 60000,
      collaborationReplayPruneBatchLimit: 1000,
      koedHome: resolve(homedir(), ".koed"),
      historicalImport: {
        maxRows: 100,
        maxBytes: 1_000_000,
        maxRuntimeMs: 15_000,
        maxConcurrency: 1,
        maxLiveProjectionRows: 0
      },
      historicalImportApiReadyTimeoutMs: 1_000,
      logLevel: "info",
      logDestination: { destination: "stderr" },
      managedConversationAppServerBinary: "codex",
      managedConversationModel: "gpt-5.4",
      managedConversationClaudeModel: "claude-haiku-4-5-20251001",
      managedConversationReasoningEffort: "high",
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
        KOED_EMBEDDING_POOL_KEY: "hosted-cpu-a",
        EMBEDDING_BATCH_LIMIT: "8",
        EMBEDDING_MAX_TEXT_CHARS: "120000",
        EMBEDDING_MAX_REQUEST_CHARS: "640000",
        EMBEDDING_REQUEST_TIMEOUT_MS: "1200000",
        EMBEDDING_CAPACITY_REFINED_DELAY_MS: "5000",
        MEMORY_RAW_PROJECTION_BATCH_LIMIT: "50",
        MEMORY_RAW_PROJECTION_ACTOR_LIMIT: "4",
        CROSS_IDENTITY_SYNC_STALE_AFTER_SECONDS: "7200",
        MEMORY_HISTORICAL_IMPORT_BATCH_ROWS: "25",
        MEMORY_HISTORICAL_IMPORT_BATCH_BYTES: "250000",
        MEMORY_HISTORICAL_IMPORT_BATCH_RUNTIME_MS: "2000",
        MEMORY_HISTORICAL_IMPORT_CONCURRENCY: "1",
        MEMORY_HISTORICAL_IMPORT_LIVE_BACKLOG_MAX: "3",
        MEMORY_HISTORICAL_IMPORT_API_READY_URL: "http://api.test/ready",
        MEMORY_HISTORICAL_IMPORT_API_READY_TIMEOUT_MS: "500",
        RETENTION_PURGE_INTERVAL_MS: "1500",
        COLLABORATION_REPLAY_PRUNE_INTERVAL_MS: "45000",
        COLLABORATION_REPLAY_PRUNE_BATCH_LIMIT: "250",
        WORKER_LOG_LEVEL: "debug",
        WORKER_LOG_DESTINATION: "both",
        WORKER_LOG_FILE: "/tmp/koed-worker.log",
        EMBEDDING_MODEL: "qwen3-0.6b"
      })
    ).toMatchObject({
      teamCollaborationEnabled: false,
      queueBackend: "bullmq",
      redisUrl: "redis://local:6379",
      databaseUrl: "postgres://local",
      databaseConfigured: true,
      embeddingServiceUrl: "http://localhost:8000",
      embeddingServiceToken: "worker-token",
      embeddingPoolKey: "hosted-cpu-a",
      embeddingDimensions: 1024,
      embeddingVersion: "qwen3-0.6b",
      embeddingBatchLimit: 8,
      embeddingMaxTextChars: 120_000,
      embeddingMaxRequestChars: 640_000,
      embeddingRequestTimeoutMs: 1200000,
      embeddingCapacityRefinedDelayMs: 5000,
      rawProjectionBatchLimit: 50,
      rawProjectionActorLimit: 4,
      crossIdentitySyncStaleAfterSeconds: 7200,
      historicalImport: {
        maxRows: 25,
        maxBytes: 250000,
        maxRuntimeMs: 2000,
        maxConcurrency: 1,
        maxLiveProjectionRows: 3
      },
      historicalImportApiReadyUrl: "http://api.test/ready",
      historicalImportApiReadyTimeoutMs: 500,
      retentionPurgeIntervalMs: 1500,
      collaborationReplayPruneIntervalMs: 45000,
      collaborationReplayPruneBatchLimit: 250,
      logLevel: "debug",
      logDestination: {
        destination: "both",
        filePath: "/tmp/koed-worker.log"
      }
    });
  });

  it("rejects unsafe embedding pool identities", () => {
    expect(() =>
      resolveWorkerEnv({ KOED_EMBEDDING_POOL_KEY: "tenant/private pool" })
    ).toThrow("KOED_EMBEDDING_POOL_KEY");
  });

  it("rejects unsafe historical import bounds and health URLs", () => {
    expect(() =>
      resolveWorkerEnv({ MEMORY_HISTORICAL_IMPORT_CONCURRENCY: "2" })
    ).toThrow(
      "MEMORY_HISTORICAL_IMPORT_CONCURRENCY must be an integer from 1 to 1"
    );
    expect(() =>
      resolveWorkerEnv({ MEMORY_HISTORICAL_IMPORT_BATCH_ROWS: "0" })
    ).toThrow(
      "MEMORY_HISTORICAL_IMPORT_BATCH_ROWS must be an integer from 1 to 1000"
    );
    expect(() =>
      resolveWorkerEnv({ EMBEDDING_CAPACITY_REFINED_DELAY_MS: "999" })
    ).toThrow(
      "EMBEDDING_CAPACITY_REFINED_DELAY_MS must be an integer from 1000 to 86400000"
    );
    expect(() =>
      resolveWorkerEnv({
        MEMORY_HISTORICAL_IMPORT_API_READY_URL:
          "https://user:secret@api.test/ready"
      })
    ).toThrow(
      "MEMORY_HISTORICAL_IMPORT_API_READY_URL must be an HTTP(S) URL without credentials"
    );
  });

  it("derives historical admission readiness from the configured API target", () => {
    expect(
      resolveWorkerEnv({
        MEMORY_API_URL: "http://127.0.0.1:43301"
      }).historicalImportApiReadyUrl
    ).toBe("http://127.0.0.1:43301/ready");
    expect(
      resolveWorkerEnv({
        MEMORY_API_URL: "http://127.0.0.1:43301",
        MEMORY_HISTORICAL_IMPORT_API_READY_URL:
          "http://127.0.0.1:43302/custom-ready"
      }).historicalImportApiReadyUrl
    ).toBe("http://127.0.0.1:43302/custom-ready");
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

  it("uses the strict shared Team collaboration setting", () => {
    expect(
      resolveWorkerEnv({ KOED_TEAM_COLLABORATION_ENABLED: "true" })
        .teamCollaborationEnabled
    ).toBe(true);
    expect(
      resolveWorkerEnv({ KOED_TEAM_COLLABORATION_ENABLED: "false" })
        .teamCollaborationEnabled
    ).toBe(false);
    expect(() =>
      resolveWorkerEnv({ KOED_TEAM_COLLABORATION_ENABLED: "TRUE" })
    ).toThrow(
      'KOED_TEAM_COLLABORATION_ENABLED must be exactly "true" or "false"'
    );
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
        MANAGED_KMS_AUTH_TOKEN: "secret-token",
        TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER: "byok",
        TEAM_MEMORY_MANAGED_KMS_KEY_ID: "byok:team-key",
        TEAM_MEMORY_MANAGED_KMS_KEY_VERSION: "1",
        TEAM_MEMORY_MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example",
        TEAM_MEMORY_MANAGED_KMS_AUTH_TOKEN: "team-secret-token",
        OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER: "byok",
        OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID: "byok:owner-private-key",
        OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION: "1",
        OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL:
          "https://kms.koed.example",
        OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN: "owner-secret-token"
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
