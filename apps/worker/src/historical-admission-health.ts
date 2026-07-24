import type { MemorySourceRepository } from "@koed/db";
import type { KoedJobQueue } from "@koed/shared";

export interface HistoricalAdmissionHealthConfig {
  apiReadyTimeoutMs: number;
  apiReadyUrl?: string;
  embeddingQueue: KoedJobQueue<unknown>;
  repository: MemorySourceRepository;
  fetch?: typeof fetch;
}

const apiIsReady = async (
  url: string | undefined,
  timeoutMs: number,
  fetcher: typeof fetch
): Promise<boolean> => {
  if (!url) {
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { status?: unknown };
    return payload.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

const queueIsHealthy = async (
  queue: KoedJobQueue<unknown>
): Promise<boolean> => {
  try {
    await queue.getJobCounts("waiting", "active");
    return true;
  } catch {
    return false;
  }
};

const embeddingServiceIsHealthy = async (
  repository: MemorySourceRepository
): Promise<boolean> => {
  try {
    return (await repository.getLocalEmbeddingStatus()).healthy;
  } catch {
    return false;
  }
};

export const createHistoricalAdmissionHealth = (
  config: HistoricalAdmissionHealthConfig
) => {
  const fetcher = config.fetch ?? globalThis.fetch.bind(globalThis);
  return async () => {
    const [apiHealthy, queueHealthy, embeddingServiceHealthy] =
      await Promise.all([
        apiIsReady(config.apiReadyUrl, config.apiReadyTimeoutMs, fetcher),
        queueIsHealthy(config.embeddingQueue),
        embeddingServiceIsHealthy(config.repository)
      ]);
    return { apiHealthy, queueHealthy, embeddingServiceHealthy };
  };
};
