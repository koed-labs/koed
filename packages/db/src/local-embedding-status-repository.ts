import type { LocalEmbeddingStatus } from "./types.js";

export interface LocalEmbeddingStatusRepository {
  getLocalEmbeddingStatus(): Promise<LocalEmbeddingStatus>;
}

const DEFAULT_EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS = 1_000;
const MIN_EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS = 50;
const MAX_EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS = 60_000;

const localEmbeddingServiceUrl = (): string | null =>
  (
    process.env.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000"
  ).trim() || null;

const localEmbeddingServiceHealthTimeoutMs = (): number => {
  const raw = process.env.EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS;
  }
  return Math.min(
    MAX_EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS,
    Math.max(MIN_EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS, parsed)
  );
};

const embeddingServiceHeaders = (): Record<string, string> => {
  const token = process.env.EMBEDDING_SERVICE_TOKEN?.trim();
  return {
    ...(token ? { "x-koed-embedding-token": token } : {}),
    "x-koed-embedding-priority": "interactive"
  };
};

type EmbeddingHealthPayload = {
  model?: string;
  dimensions?: number;
  authRequired?: boolean;
  authValid?: boolean;
};

type EmbeddingHealthResponse = {
  response: Response;
  payload: EmbeddingHealthPayload;
};

const embeddingHealthTimeoutError = (timeoutMs: number): Error =>
  new Error(`Embedding service health check timed out after ${timeoutMs}ms`);

const fetchEmbeddingHealth = async (
  baseUrl: string
): Promise<EmbeddingHealthResponse> => {
  const timeoutMs = localEmbeddingServiceHealthTimeoutMs();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = embeddingHealthTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const healthRequest = async (): Promise<EmbeddingHealthResponse> => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      headers: embeddingServiceHeaders(),
      signal: controller.signal
    });
    const payload = (await response
      .json()
      .catch(() => ({}))) as EmbeddingHealthPayload | null;
    return {
      response,
      payload: payload ?? {}
    };
  };
  try {
    return await Promise.race([healthRequest(), timeoutPromise]);
  } catch (error) {
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason;
      throw reason instanceof Error
        ? reason
        : embeddingHealthTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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
        const { response, payload } = await fetchEmbeddingHealth(baseUrl);
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
