import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import { createHistoricalAdmissionHealth } from "./historical-admission-health.js";

const createQueue = () => ({
  add: vi.fn(),
  close: vi.fn(),
  getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0 })
});

const createRepository = (healthy = true) =>
  ({
    getLocalEmbeddingStatus: vi.fn().mockResolvedValue({ healthy })
  }) as unknown as MemorySourceRepository;

describe("historical admission health", () => {
  it("requires healthy API, queue, and Embedding Service", async () => {
    const health = createHistoricalAdmissionHealth({
      apiReadyUrl: "http://api.test/ready",
      apiReadyTimeoutMs: 1000,
      embeddingQueue: createQueue(),
      repository: createRepository(),
      capacityProfileAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" })
      })
    });

    await expect(health()).resolves.toEqual({
      apiHealthy: true,
      queueHealthy: true,
      embeddingServiceHealthy: true,
      capacityProfileHealthy: true
    });
  });

  it("fails closed when API readiness is missing or degraded", async () => {
    const missingUrl = createHistoricalAdmissionHealth({
      apiReadyTimeoutMs: 1000,
      embeddingQueue: createQueue(),
      repository: createRepository(),
      capacityProfileAvailable: vi.fn().mockResolvedValue(true)
    });
    const degradedApi = createHistoricalAdmissionHealth({
      apiReadyUrl: "http://api.test/ready",
      apiReadyTimeoutMs: 1000,
      embeddingQueue: createQueue(),
      repository: createRepository(),
      capacityProfileAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ status: "error" })
      })
    });

    await expect(missingUrl()).resolves.toMatchObject({ apiHealthy: false });
    await expect(degradedApi()).resolves.toMatchObject({ apiHealthy: false });
  });
});
