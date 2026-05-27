export type HealthStatus = "ok" | "degraded" | "error";

export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export const createHealth = (
  service: string,
  status: HealthStatus = "ok",
  details?: Record<string, unknown>
): ServiceHealth => ({
  service,
  status,
  checkedAt: new Date().toISOString(),
  ...(details ? { details } : {})
});

export const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const requireEnv = (
  names: string[],
  environment: NodeJS.ProcessEnv = process.env
): void => {
  const missing = names.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${
        missing.length === 1 ? "" : "s"
      }: ${missing.join(", ")}`
    );
  }
};

const truthyConfigValues = new Set(["1", "true", "yes", "on"]);

export const configFlagEnabled = (value: string | undefined): boolean =>
  value ? truthyConfigValues.has(value.trim().toLowerCase()) : false;

export interface SupportedEmbeddingModelConfig {
  key: string;
  dimensions: number;
}

export interface SupportedRerankerModelConfig {
  key: string;
  model: string;
}

export const DEFAULT_EMBEDDING_MODEL_KEY = "qwen3-0.6b";
export const DEFAULT_RERANKER_MODEL_KEY = "qwen3-reranker-0.6b";

export const SUPPORTED_EMBEDDING_MODELS: Record<
  string,
  SupportedEmbeddingModelConfig
> = {
  "qwen3-0.6b": {
    key: "qwen3-0.6b",
    dimensions: 1024
  }
};

export const SUPPORTED_RERANKER_MODELS: Record<
  string,
  SupportedRerankerModelConfig
> = {
  "qwen3-reranker-0.6b": {
    key: "qwen3-reranker-0.6b",
    model: "n24q02m/Qwen3-Reranker-0.6B-ONNX"
  }
};

export const resolveSupportedEmbeddingModelConfig = (
  key: string | undefined = DEFAULT_EMBEDDING_MODEL_KEY
): SupportedEmbeddingModelConfig => {
  const normalized = key.trim() || DEFAULT_EMBEDDING_MODEL_KEY;
  const config = SUPPORTED_EMBEDDING_MODELS[normalized];
  if (!config) {
    throw new Error(
      `Unsupported embedding model key: ${normalized}. Supported model keys: ${Object.keys(
        SUPPORTED_EMBEDDING_MODELS
      )
        .sort()
        .join(", ")}`
    );
  }
  return config;
};

export const resolveSupportedRerankerModelConfig = (
  key: string | undefined
): SupportedRerankerModelConfig | null => {
  const normalized = key?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  const config = SUPPORTED_RERANKER_MODELS[normalized];
  if (!config) {
    throw new Error(
      `Unsupported reranker model key: ${normalized}. Supported model keys: ${Object.keys(
        SUPPORTED_RERANKER_MODELS
      )
        .sort()
        .join(", ")}`
    );
  }
  return config;
};
