import type { LocalEmbeddingStatus } from "./types.js";

export interface LocalEmbeddingStatusRepository {
  getLocalEmbeddingStatus(): Promise<LocalEmbeddingStatus>;
}

const localEmbeddingServiceUrl = (): string | null =>
  (
    process.env.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000"
  ).trim() || null;

const embeddingServiceHeaders = (): Record<string, string> => {
  const token = process.env.EMBEDDING_SERVICE_TOKEN?.trim();
  return {
    ...(token ? { "x-koed-embedding-token": token } : {}),
    "x-koed-embedding-priority": "interactive"
  };
};

export const createLocalEmbeddingStatusRepository =
  (): LocalEmbeddingStatusRepository => ({
    async getLocalEmbeddingStatus() {
      const baseUrl = localEmbeddingServiceUrl();
      if (!baseUrl) {
        return {
          enabled: false,
          healthy: false,
          model: null,
          dimensions: null,
          error: "EMBEDDING_SERVICE_URL is not configured"
        };
      }

      try {
        const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
          headers: embeddingServiceHeaders()
        });
        const payload = (await response.json().catch(() => ({}))) as {
          model?: string;
          dimensions?: number;
          authRequired?: boolean;
          authValid?: boolean;
        };
        const authHealthy = !payload.authRequired || payload.authValid === true;
        return {
          enabled: true,
          healthy: response.ok && authHealthy,
          model: payload.model ?? null,
          dimensions: payload.dimensions ?? null,
          ...(!response.ok
            ? { error: `HTTP ${response.status}` }
            : !authHealthy
              ? { error: "Embedding service token rejected" }
              : {})
        };
      } catch (error) {
        return {
          enabled: true,
          healthy: false,
          model: null,
          dimensions: null,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  });
