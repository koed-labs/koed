import { describe, expect, it } from "vitest";
import { resolveApiEnv } from "./env-config.js";

describe("resolveApiEnv", () => {
  it("uses development defaults", () => {
    expect(resolveApiEnv({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      nodeEnv: "development",
      production: false
    });
  });

  it("uses production defaults", () => {
    expect(
      resolveApiEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost/db",
        REDIS_URL: "redis://localhost:6379",
        DATA_ENCRYPTION_KEY: "key",
        API_TOKEN_PEPPER: "pepper",
        EMBEDDING_SERVICE_TOKEN: "token",
        CORS_ORIGINS: "http://localhost:5174"
      })
    ).toEqual({
      host: "0.0.0.0",
      port: 3000,
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
      "DATABASE_URL, REDIS_URL, DATA_ENCRYPTION_KEY, API_TOKEN_PEPPER, EMBEDDING_SERVICE_TOKEN, CORS_ORIGINS"
    );
  });
});
