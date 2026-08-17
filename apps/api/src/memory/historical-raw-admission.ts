import {
  EMBEDDING_CAPACITY_CONTRACT_REVISION,
  type EmbeddingCapacityRepository,
  type MemorySourceRepository
} from "@koed/db";
import {
  decideHistoricalAdmission,
  type HistoricalAdmissionDecision,
  type KoedJobQueue
} from "@koed/shared";

export interface HistoricalRawAdmissionDependencies {
  repository: MemorySourceRepository;
  embeddingCapacityRepository: EmbeddingCapacityRepository;
  embeddingQueue: KoedJobQueue<unknown>;
  embeddingModel: string;
  embeddingDimensions: number;
  maxLiveProjectionRows: number;
}

const healthyQueue = async (queue: KoedJobQueue<unknown>): Promise<boolean> => {
  try {
    await queue.getJobCounts("waiting", "active");
    return true;
  } catch {
    return false;
  }
};

const healthyEmbeddingService = async (
  repository: MemorySourceRepository,
  expectedModel: string,
  expectedDimensions: number
): Promise<boolean> => {
  try {
    const status = await repository.getLocalEmbeddingStatus();
    return (
      status.healthy &&
      status.model === expectedModel &&
      status.dimensions === expectedDimensions
    );
  } catch {
    return false;
  }
};

const usableCapacityProfile = async (
  repository: EmbeddingCapacityRepository,
  modelKey: string,
  embeddingDimensions: number
): Promise<boolean> => {
  try {
    const profiles = await repository.listActiveUsableProfiles({
      modelKey,
      embeddingDimensions,
      capacityContractRevision: EMBEDDING_CAPACITY_CONTRACT_REVISION
    });
    return profiles.some(
      (profile) =>
        profile.state === "usable" && profile.measuredTokensPerSecond > 0
    );
  } catch {
    return false;
  }
};

/**
 * Authoritative, content-free admission for producing the next raw historical
 * batch. The Local AI Runtime calls this contract instead of reconstructing
 * Worker health or embedding-capacity policy itself.
 */
export const createHistoricalRawAdmission =
  (
    dependencies: HistoricalRawAdmissionDependencies
  ): (() => Promise<HistoricalAdmissionDecision>) =>
  async () => {
    let backlog: Awaited<
      ReturnType<MemorySourceRepository["getConversationProjectionBacklog"]>
    >;
    try {
      backlog =
        await dependencies.repository.getConversationProjectionBacklog();
    } catch {
      return { admitted: false, reason: "api_degraded" };
    }
    const [queueHealthy, embeddingServiceHealthy, capacityProfileHealthy] =
      await Promise.all([
        healthyQueue(dependencies.embeddingQueue),
        healthyEmbeddingService(
          dependencies.repository,
          dependencies.embeddingModel,
          dependencies.embeddingDimensions
        ),
        usableCapacityProfile(
          dependencies.embeddingCapacityRepository,
          dependencies.embeddingModel,
          dependencies.embeddingDimensions
        )
      ]);
    return decideHistoricalAdmission(
      {
        apiHealthy: true,
        queueHealthy,
        embeddingServiceHealthy,
        capacityProfileHealthy,
        // This endpoint decides whether one new raw batch may be produced. It is
        // intentionally useful before that batch creates Projection backlog.
        historicalImportRows: Math.max(1, backlog.historicalImportRows),
        liveProjectionRows: backlog.liveProjectionRows,
        activeHistoricalBatches: 0
      },
      {
        maxRows: 1,
        maxBytes: 1,
        maxRuntimeMs: 1,
        maxConcurrency: 1,
        maxLiveProjectionRows: dependencies.maxLiveProjectionRows
      }
    );
  };
