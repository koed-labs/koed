import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createMemorySourceRepository } from "../src/index.js";

describe("local embedding status", () => {
  const originalEmbeddingServiceUrl = process.env.EMBEDDING_SERVICE_URL;
  const originalEmbeddingServiceToken = process.env.EMBEDDING_SERVICE_TOKEN;
  const originalEmbeddingServiceHealthTimeoutMs =
    process.env.EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalEmbeddingServiceUrl === undefined) {
      delete process.env.EMBEDDING_SERVICE_URL;
    } else {
      process.env.EMBEDDING_SERVICE_URL = originalEmbeddingServiceUrl;
    }
    if (originalEmbeddingServiceToken === undefined) {
      delete process.env.EMBEDDING_SERVICE_TOKEN;
    } else {
      process.env.EMBEDDING_SERVICE_TOKEN = originalEmbeddingServiceToken;
    }
    if (originalEmbeddingServiceHealthTimeoutMs === undefined) {
      delete process.env.EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS;
    } else {
      process.env.EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS =
        originalEmbeddingServiceHealthTimeoutMs;
    }
  });

  it("reports embedding retrieval as disabled when the service URL is blank", async () => {
    process.env.EMBEDDING_SERVICE_URL = "";
    const repo = createMemorySourceRepository({} as pg.Pool);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(repo.getLocalEmbeddingStatus()).resolves.toMatchObject({
      enabled: false,
      healthy: false,
      model: null,
      dimensions: null,
      error: "EMBEDDING_SERVICE_URL is not configured"
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports embedding health as unhealthy when the service rejects the configured token", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_SERVICE_TOKEN = "api-token";
    const repo = createMemorySourceRepository({} as pg.Pool);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "qwen3-0.6b",
          dimensions: 1024,
          authRequired: true,
          authValid: false
        }),
        { status: 200 }
      )
    );

    await expect(repo.getLocalEmbeddingStatus()).resolves.toMatchObject({
      enabled: true,
      healthy: false,
      model: "qwen3-0.6b",
      dimensions: 1024,
      error: "Embedding service token rejected"
    });
    expect(
      new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).get(
        "x-koed-embedding-token"
      )
    ).toBe("api-token");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBeInstanceOf(
      AbortSignal
    );
  });

  it("reports embedding health as healthy when token authentication succeeds", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_SERVICE_TOKEN = "api-token";
    const repo = createMemorySourceRepository({} as pg.Pool);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "qwen3-0.6b",
          dimensions: 1024,
          authRequired: true,
          authValid: true
        }),
        { status: 200 }
      )
    );

    await expect(repo.getLocalEmbeddingStatus()).resolves.toMatchObject({
      enabled: true,
      healthy: true,
      model: "qwen3-0.6b",
      dimensions: 1024
    });
  });

  it("bounds embedding health checks with a configurable timeout", async () => {
    vi.useFakeTimers();
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS = "75";
    const repo = createMemorySourceRepository({} as pg.Pool);

    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        })
    );

    const status = repo.getLocalEmbeddingStatus();
    await vi.advanceTimersByTimeAsync(75);

    await expect(status).resolves.toMatchObject({
      enabled: true,
      healthy: false,
      model: null,
      dimensions: null,
      error: "Embedding service health check timed out after 75ms"
    });
  });

  it("keeps the health timeout active while parsing the response body", async () => {
    vi.useFakeTimers();
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS = "75";
    const repo = createMemorySourceRepository({} as pg.Pool);
    const response = new Response("", { status: 200 });
    const json = vi
      .spyOn(response, "json")
      .mockImplementation(() => new Promise<unknown>(() => undefined));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const status = repo.getLocalEmbeddingStatus();
    await vi.advanceTimersByTimeAsync(75);

    await expect(status).resolves.toMatchObject({
      enabled: true,
      healthy: false,
      model: null,
      dimensions: null,
      error: "Embedding service health check timed out after 75ms"
    });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default health timeout when configured with an invalid value", async () => {
    vi.useFakeTimers();
    process.env.EMBEDDING_SERVICE_URL = "http://embedding.test";
    process.env.EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS = "not-a-number";
    const repo = createMemorySourceRepository({} as pg.Pool);

    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        })
    );

    const status = repo.getLocalEmbeddingStatus();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(status).resolves.toMatchObject({
      enabled: true,
      healthy: false,
      error: "Embedding service health check timed out after 1000ms"
    });
  });
});
