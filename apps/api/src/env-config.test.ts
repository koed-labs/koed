import { describe, expect, it } from "vitest";
import { resolveApiEnv } from "./env-config.js";

describe("resolveApiEnv", () => {
  it("uses development defaults", () => {
    expect(resolveApiEnv({})).toEqual({
      host: "127.0.0.1",
      port: 3300,
      nodeEnv: "development",
      production: false
    });
  });

  it("validates the Team collaboration feature switch", () => {
    expect(() =>
      resolveApiEnv({ KOED_TEAM_COLLABORATION_ENABLED: "TRUE" })
    ).toThrow(
      'KOED_TEAM_COLLABORATION_ENABLED must be exactly "true" or "false"'
    );
  });

  it("uses production defaults", () => {
    expect(
      resolveApiEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost/db",
        REDIS_URL: "redis://localhost:6379",
        API_DATA_ENCRYPTION_KEY: "key",
        API_ENVELOPE_ENCRYPTION_PROVIDER: "local_test_key",
        API_TOKEN_PEPPER: "pepper",
        COLLABORATION_LOCAL_BROKER_SECRET: "local-broker-secret",
        COLLABORATION_REALTIME_CURSOR_SECRET: "realtime-secret",
        EMBEDDING_SERVICE_TOKEN: "token",
        CORS_ORIGINS: "http://localhost:5174"
      })
    ).toEqual({
      host: "0.0.0.0",
      port: 3300,
      nodeEnv: "production",
      production: true
    });
  });

  it("parses configured host and port", () => {
    expect(
      resolveApiEnv({
        API_HOST: "127.0.0.1",
        API_PORT: "4000"
      })
    ).toMatchObject({
      host: "127.0.0.1",
      port: 4000
    });
  });

  it("requires complete WorkOS AuthKit config when enabled", () => {
    expect(() =>
      resolveApiEnv({
        WORKOS_AUTHKIT_ENABLED: "true",
        WORKOS_CLIENT_ID: "client_test_123"
      })
    ).toThrow("WORKOS_API_KEY, WORKOS_REDIRECT_URI");

    expect(() =>
      resolveApiEnv({
        WORKOS_AUTHKIT_ENABLED: "true",
        WORKOS_CLIENT_ID: "client_test_123",
        WORKOS_API_KEY: "sk_test_secret",
        WORKOS_REDIRECT_URI: "http://127.0.0.1:3300/auth/workos/callback"
      })
    ).toThrow(
      "WORKOS_REDIRECT_URI must be an absolute HTTPS URL, or localhost for development"
    );

    expect(() =>
      resolveApiEnv({
        WORKOS_AUTHKIT_ENABLED: "true",
        WORKOS_CLIENT_ID: "client_test_123",
        WORKOS_API_KEY: "sk_test_secret",
        WORKOS_REDIRECT_URI: "http://localhost:3300/auth/workos/callback"
      })
    ).not.toThrow();
  });

  it("rejects unsupported reranker model keys", () => {
    expect(() =>
      resolveApiEnv({
        RERANKER_KEY: "unsupported"
      })
    ).toThrow("Unsupported reranker model key");
  });

  it("validates the documented root reranker key alias", () => {
    expect(() =>
      resolveApiEnv({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b"
      })
    ).not.toThrow();
    expect(() =>
      resolveApiEnv({
        EMBEDDING_RERANKER_KEY: "unsupported"
      })
    ).toThrow("Unsupported reranker model key");
  });

  it("requires production secrets and service URLs", () => {
    expect(() => resolveApiEnv({ NODE_ENV: "production" })).toThrow(
      "DATABASE_URL, REDIS_URL, API_TOKEN_PEPPER, COLLABORATION_LOCAL_BROKER_SECRET, COLLABORATION_REALTIME_CURSOR_SECRET, EMBEDDING_SERVICE_TOKEN, CORS_ORIGINS"
    );
    expect(() =>
      resolveApiEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost/db",
        REDIS_URL: "redis://localhost:6379",
        API_TOKEN_PEPPER: "pepper",
        COLLABORATION_LOCAL_BROKER_SECRET: "local-broker-secret",
        COLLABORATION_REALTIME_CURSOR_SECRET: "realtime-secret",
        EMBEDDING_SERVICE_TOKEN: "token",
        CORS_ORIGINS: "http://localhost:5174"
      })
    ).toThrow(
      "Missing required environment variable: API_DATA_ENCRYPTION_KEY (or DATA_ENCRYPTION_KEY)"
    );
  });

  it("requires Personal collaboration realtime secrets when Team collaboration is disabled", () => {
    expect(() =>
      resolveApiEnv({
        NODE_ENV: "production",
        KOED_TEAM_COLLABORATION_ENABLED: "false",
        WORK_QUEUE_BACKEND: "local",
        DATABASE_URL: "postgres://localhost/db",
        API_TOKEN_PEPPER: "pepper",
        EMBEDDING_SERVICE_TOKEN: "token",
        CORS_ORIGINS: "https://api.example.test"
      })
    ).toThrow(
      "COLLABORATION_LOCAL_BROKER_SECRET, COLLABORATION_REALTIME_CURSOR_SECRET"
    );
  });

  it("does not require Redis in production with the local work queue", () => {
    expect(() =>
      resolveApiEnv({
        NODE_ENV: "production",
        WORK_QUEUE_BACKEND: "local",
        DATABASE_URL: "postgres://localhost/db",
        DATA_ENCRYPTION_KEY: "key",
        API_ENVELOPE_ENCRYPTION_PROVIDER: "local_test_key",
        API_TOKEN_PEPPER: "pepper",
        COLLABORATION_LOCAL_BROKER_SECRET: "local-broker-secret",
        COLLABORATION_REALTIME_CURSOR_SECRET: "realtime-secret",
        EMBEDDING_SERVICE_TOKEN: "token",
        CORS_ORIGINS: "http://localhost:5174"
      })
    ).not.toThrow();
  });

  it("does not require a local broker secret for an external server runtime", () => {
    expect(() =>
      resolveApiEnv({
        NODE_ENV: "production",
        KOED_RUNTIME_MODE: "external",
        WORK_QUEUE_BACKEND: "local",
        DATABASE_URL: "postgres://localhost/db",
        DATA_ENCRYPTION_KEY: "key",
        API_ENVELOPE_ENCRYPTION_PROVIDER: "local_test_key",
        API_TOKEN_PEPPER: "pepper",
        COLLABORATION_REALTIME_CURSOR_SECRET: "realtime-secret",
        EMBEDDING_SERVICE_TOKEN: "token",
        CORS_ORIGINS: "https://api.example.test"
      })
    ).not.toThrow();
  });

  it("requires a KMS-backed provider for paid Koed-managed cloud", () => {
    const base = {
      NODE_ENV: "production",
      KOED_DEPLOYMENT_PROFILE: "koed_managed_cloud",
      KOED_MANAGED_CLOUD_RELEASE_STAGE: "paid",
      WORK_QUEUE_BACKEND: "local",
      DATABASE_URL: "postgres://localhost/db",
      API_TOKEN_PEPPER: "pepper",
      COLLABORATION_LOCAL_BROKER_SECRET: "local-broker-secret",
      COLLABORATION_REALTIME_CURSOR_SECRET: "realtime-secret",
      EMBEDDING_SERVICE_TOKEN: "token",
      CORS_ORIGINS: "https://app.koed.example"
    };
    const ownerPrivateKms = {
      OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
      OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID: "managed-kms:owner-private-key",
      OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION: "1",
      OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL:
        "https://kms.koed.example",
      OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN: "owner-secret-token"
    };

    expect(() => resolveApiEnv(base)).toThrow(
      "A KMS-backed API_ENVELOPE_ENCRYPTION_PROVIDER"
    );
    expect(() =>
      resolveApiEnv({
        ...base,
        DATA_ENCRYPTION_KEY: "key",
        API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms"
      })
    ).toThrow(
      "MANAGED_KMS_KEY_ID, MANAGED_KMS_KEY_VERSION, MANAGED_KMS_ENDPOINT_URL, MANAGED_KMS_AUTH_TOKEN"
    );
    expect(() =>
      resolveApiEnv({
        ...base,
        API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
        MANAGED_KMS_KEY_ID: "managed-kms:tenant-key",
        MANAGED_KMS_KEY_VERSION: "1",
        MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example",
        MANAGED_KMS_AUTH_TOKEN: "secret-token",
        ...ownerPrivateKms
      })
    ).not.toThrow();
    expect(() =>
      resolveApiEnv({
        ...base,
        API_ENVELOPE_ENCRYPTION_PROVIDER: "cmek",
        MANAGED_KMS_KEY_ID: "cmek:customer-key",
        MANAGED_KMS_KEY_VERSION: "1",
        MANAGED_KMS_ENDPOINT_URL: "https://kms.koed.example",
        MANAGED_KMS_AUTH_TOKEN: "secret-token",
        ...ownerPrivateKms
      })
    ).not.toThrow();
  });

  it("rejects unsupported commercial encryption providers", () => {
    const base = {
      NODE_ENV: "production",
      WORK_QUEUE_BACKEND: "local",
      DATABASE_URL: "postgres://localhost/db",
      API_TOKEN_PEPPER: "pepper",
      COLLABORATION_LOCAL_BROKER_SECRET: "local-broker-secret",
      COLLABORATION_REALTIME_CURSOR_SECRET: "realtime-secret",
      EMBEDDING_SERVICE_TOKEN: "token",
      CORS_ORIGINS: "https://app.koed.example"
    };

    expect(() =>
      resolveApiEnv({
        ...base,
        API_ENVELOPE_ENCRYPTION_PROVIDER: "nonsense"
      })
    ).toThrow("Unsupported API_ENVELOPE_ENCRYPTION_PROVIDER");
    expect(() =>
      resolveApiEnv({
        ...base,
        API_ENVELOPE_ENCRYPTION_PROVIDER: "operator_kms"
      })
    ).toThrow("Envelope encryption provider is not implemented: operator_kms");
  });
});
