import type {
  EmbeddingCapacityRepository,
  MemorySourceRepository
} from "@koed/db";
import type { KoedJobQueue } from "@koed/shared";
import { describe, expect, it } from "vitest";

import { createHistoricalRawAdmission } from "./historical-raw-admission.js";

const dependencies = () => {
  let backlog = {
    liveProjectionRows: 0,
    historicalImportRows: 0,
    historicalImportBytes: 0
  };
  let repositoryHealthy = true;
  let embeddingHealthy = true;
  let embeddingModel = "test-model";
  let capacityUsable = true;
  let queueHealthy = true;
  const repository = {
    async getConversationProjectionBacklog() {
      if (!repositoryHealthy) throw new Error("repository unavailable");
      return backlog;
    },
    async getLocalEmbeddingStatus() {
      return {
        enabled: true,
        healthy: embeddingHealthy,
        model: embeddingModel,
        dimensions: 384
      };
    }
  } as MemorySourceRepository;
  const embeddingCapacityRepository = {
    async listActiveUsableProfiles() {
      return capacityUsable
        ? ([{ state: "usable", measuredTokensPerSecond: 25 }] as never)
        : [];
    }
  } as unknown as EmbeddingCapacityRepository;
  const embeddingQueue = {
    async getJobCounts() {
      if (!queueHealthy) throw new Error("queue unavailable");
      return { waiting: 0, active: 0 };
    }
  } as unknown as KoedJobQueue<unknown>;
  return {
    input: {
      repository,
      embeddingCapacityRepository,
      embeddingQueue,
      embeddingModel: "test-model",
      embeddingDimensions: 384,
      maxLiveProjectionRows: 2
    },
    setBacklog(value: typeof backlog) {
      backlog = value;
    },
    setRepositoryHealthy(value: boolean) {
      repositoryHealthy = value;
    },
    setEmbeddingHealthy(value: boolean) {
      embeddingHealthy = value;
    },
    setEmbeddingModel(value: string) {
      embeddingModel = value;
    },
    setCapacityUsable(value: boolean) {
      capacityUsable = value;
    },
    setQueueHealthy(value: boolean) {
      queueHealthy = value;
    }
  };
};

describe("raw historical admission", () => {
  it("admits an upcoming raw batch with healthy downstream capacity", async () => {
    const fixture = dependencies();
    const admission = createHistoricalRawAdmission(fixture.input);

    await expect(admission()).resolves.toEqual({ admitted: true });
  });

  it("rechecks recalibrated capacity before each batch", async () => {
    const fixture = dependencies();
    const admission = createHistoricalRawAdmission(fixture.input);
    fixture.setCapacityUsable(false);

    await expect(admission()).resolves.toEqual({
      admitted: false,
      reason: "capacity_profile_unavailable"
    });

    fixture.setCapacityUsable(true);
    await expect(admission()).resolves.toEqual({ admitted: true });
  });

  it.each([
    {
      arrange: (fixture: ReturnType<typeof dependencies>) =>
        fixture.setRepositoryHealthy(false),
      reason: "api_degraded"
    },
    {
      arrange: (fixture: ReturnType<typeof dependencies>) =>
        fixture.setQueueHealthy(false),
      reason: "queue_degraded"
    },
    {
      arrange: (fixture: ReturnType<typeof dependencies>) =>
        fixture.setEmbeddingHealthy(false),
      reason: "embedding_service_degraded"
    },
    {
      arrange: (fixture: ReturnType<typeof dependencies>) =>
        fixture.setEmbeddingModel("stale-model"),
      reason: "embedding_service_degraded"
    },
    {
      arrange: (fixture: ReturnType<typeof dependencies>) =>
        fixture.setBacklog({
          liveProjectionRows: 3,
          historicalImportRows: 0,
          historicalImportBytes: 0
        }),
      reason: "live_projection_pressure"
    }
  ])("fails closed for $reason", async ({ arrange, reason }) => {
    const fixture = dependencies();
    arrange(fixture);

    await expect(
      createHistoricalRawAdmission(fixture.input)()
    ).resolves.toEqual({ admitted: false, reason });
  });
});
