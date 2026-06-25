import { describe, expect, it } from "vitest";
import { resolveApiServerConfig } from "./config.js";

describe("resolveApiServerConfig", () => {
  it("resolves development defaults", () => {
    const config = resolveApiServerConfig({});

    expect(config).toMatchObject({
      nodeEnv: "development",
      production: false,
      test: false,
      logLevel: "info",
      requestBodyLimitBytes: 4 * 1024 * 1024,
      queueBackend: "bullmq",
      cookieSecure: true,
      publicRegistrationEnabled: false,
      rateLimit: {
        store: "memory",
        policies: {
          auth: { windowMs: 60_000, max: 20 },
          memoryRead: { windowMs: 60_000, max: 1000 },
          memoryWrite: { windowMs: 60_000, max: 1000 },
          memoryRecall: { windowMs: 60_000, max: 1000 }
        }
      },
      cache: {
        store: "memory",
        graphCacheTtlSeconds: 5
      },
      graph: {
        updateDebounceMs: 1_000,
        memoryEventUpdateDebounceMs: 100
      }
    });
    expect(config.corsOrigins.has("http://localhost:5174")).toBe(true);
    expect(config.corsOrigins.has("http://localhost:5173")).toBe(false);
  });

  it("normalizes configured origins and keeps API_CORS_ORIGINS root-only", () => {
    const config = resolveApiServerConfig({
      NODE_ENV: "production",
      CORS_ORIGINS:
        "https://console.example.test/, https://history.example.test",
      API_CORS_ORIGINS: "https://legacy.example.test",
      PUBLIC_APP_URL: "https://console-public.example.test/",
      API_BASE_URL: "https://api.example.test/"
    });

    expect([...config.corsOrigins].sort()).toEqual([
      "https://api.example.test",
      "https://console-public.example.test",
      "https://console.example.test",
      "https://history.example.test"
    ]);
  });

  it("resolves Redis-backed cache and rate-limit settings", () => {
    const config = resolveApiServerConfig({
      REDIS_URL: "redis://default:6379",
      RATE_LIMIT_STORE: "redis",
      RATE_LIMIT_REDIS_URL: "redis://rate-limit:6379",
      CACHE_STORE: "redis",
      GRAPH_CACHE_TTL_SECONDS: "30",
      MEMORY_RATE_LIMIT_WINDOW_MS: "120000",
      MEMORY_RATE_LIMIT_MAX: "50",
      MEMORY_WRITE_RATE_LIMIT_MAX: "10"
    });

    expect(config.rateLimit.store).toBe("redis");
    expect(config.rateLimit.redisUrl).toBe("redis://rate-limit:6379");
    expect(config.rateLimit.policies.memoryRead).toEqual({
      windowMs: 120_000,
      max: 50
    });
    expect(config.rateLimit.policies.memoryWrite).toEqual({
      windowMs: 120_000,
      max: 10
    });
    expect(config.cache).toMatchObject({
      store: "redis",
      redisUrl: "redis://default:6379",
      graphCacheTtlSeconds: 30
    });
  });

  it("accepts local queue backend override", () => {
    expect(
      resolveApiServerConfig({
        WORK_QUEUE_BACKEND: "local"
      }).queueBackend
    ).toBe("local");
  });

  it("uses the documented root reranker key for server config", () => {
    expect(
      resolveApiServerConfig({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b"
      }).rerankerKey
    ).toBe("qwen3-reranker-0.6b");

    expect(
      resolveApiServerConfig({
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
        RERANKER_KEY: "app-local"
      }).rerankerKey
    ).toBe("app-local");
  });
});
