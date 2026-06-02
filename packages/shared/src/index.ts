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

const NUL_CHARACTER = "\u0000";
export const NUL_DISPLAY_REPLACEMENT = "\uFFFD";

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value as object);
  return prototype === Object.prototype || prototype === null;
};

export const sanitizeNulCharacters = (
  value: unknown
): { value: unknown; replacementCount: number } => {
  if (typeof value === "string") {
    const replacementCount = value.split(NUL_CHARACTER).length - 1;
    return {
      value:
        replacementCount > 0
          ? value.replaceAll(NUL_CHARACTER, NUL_DISPLAY_REPLACEMENT)
          : value,
      replacementCount
    };
  }

  if (Array.isArray(value)) {
    let replacementCount = 0;
    const sanitized = value.map((item) => {
      const result = sanitizeNulCharacters(item);
      replacementCount += result.replacementCount;
      return result.value;
    });
    return { value: sanitized, replacementCount };
  }

  if (isPlainRecord(value)) {
    let replacementCount = 0;
    const sanitized: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const sanitizedKey = sanitizeNulCharacters(key);
      const sanitizedField = sanitizeNulCharacters(field);
      replacementCount +=
        sanitizedKey.replacementCount + sanitizedField.replacementCount;
      sanitized[String(sanitizedKey.value)] = sanitizedField.value;
    }
    return { value: sanitized, replacementCount };
  }

  return { value, replacementCount: 0 };
};

export const metadataWithNulSanitization = (
  metadata: Record<string, unknown>,
  replacementCount: number
): Record<string, unknown> => {
  if (replacementCount === 0) {
    return metadata;
  }
  const existingKoed = isPlainRecord(metadata.koedSanitization)
    ? metadata.koedSanitization
    : {};
  return {
    ...metadata,
    koedSanitization: {
      ...existingKoed,
      nulCharacters: {
        replacement: "U+FFFD",
        replacementCount
      }
    }
  };
};

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

export const resolveRerankerKeyFromEnv = (environment: {
  EMBEDDING_RERANKER_KEY?: string;
  RERANKER_KEY?: string;
}): string | undefined =>
  Object.prototype.hasOwnProperty.call(environment, "RERANKER_KEY")
    ? environment.RERANKER_KEY
    : environment.EMBEDDING_RERANKER_KEY;
