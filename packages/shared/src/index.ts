export type HealthStatus = "ok" | "degraded" | "error";

export const memoryEmbedQueueName = "memory-embed";
export const lcmCompactQueueName = "lcm-compact";
export const lcmEmbedQueueName = "lcm-embed";

export const workerQueueNames = [
  memoryEmbedQueueName,
  lcmCompactQueueName,
  lcmEmbedQueueName
] as const;

export type WorkerQueueName = (typeof workerQueueNames)[number];

export type KoedQueueBackend = "bullmq" | "local";

const koedQueueBackends = new Set<KoedQueueBackend>(["bullmq", "local"]);

export const resolveKoedQueueBackend = (
  value: string | undefined,
  fallback: KoedQueueBackend = "bullmq"
): KoedQueueBackend => {
  const normalized = value?.trim();
  return normalized && koedQueueBackends.has(normalized as KoedQueueBackend)
    ? (normalized as KoedQueueBackend)
    : fallback;
};

export interface KoedJobHandle {
  id: string | number | undefined;
}

export interface KoedJobEnqueueOptions {
  jobId?: string;
  attempts?: number;
  backoff?: {
    type: string;
    delay: number;
  };
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
}

export interface KoedJobQueue<TJobData = unknown> {
  add(
    name: string,
    data: TJobData,
    options?: KoedJobEnqueueOptions
  ): Promise<KoedJobHandle>;
  getJobCounts(...statuses: string[]): Promise<Record<string, number>>;
  close(): Promise<void>;
}

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

export interface StorageSanitizationCounts {
  nulCharacters: number;
  malformedUtf16: number;
}

export interface StorageSanitizationResult {
  value: unknown;
  replacementCount: number;
  counts: StorageSanitizationCounts;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value as object);
  return prototype === Object.prototype || prototype === null;
};

const emptyStorageSanitizationCounts = (): StorageSanitizationCounts => ({
  nulCharacters: 0,
  malformedUtf16: 0
});

const addStorageSanitizationCounts = (
  target: StorageSanitizationCounts,
  source: StorageSanitizationCounts
): void => {
  target.nulCharacters += source.nulCharacters;
  target.malformedUtf16 += source.malformedUtf16;
};

const totalStorageSanitizationCount = (
  counts: StorageSanitizationCounts
): number => counts.nulCharacters + counts.malformedUtf16;

export const combineStorageSanitizationCounts = (
  ...results: Array<{ counts: StorageSanitizationCounts }>
): StorageSanitizationCounts => {
  const counts = emptyStorageSanitizationCounts();
  for (const result of results) {
    addStorageSanitizationCounts(counts, result.counts);
  }
  return counts;
};

const countMalformedUtf16CodeUnits = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
      } else {
        count += 1;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      count += 1;
    }
  }
  return count;
};

const fallbackToWellFormed = (value: string): string => {
  let wellFormed = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        wellFormed += value[index] ?? "";
        wellFormed += value[index + 1] ?? "";
        index += 1;
      } else {
        wellFormed += NUL_DISPLAY_REPLACEMENT;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      wellFormed += NUL_DISPLAY_REPLACEMENT;
    } else {
      wellFormed += value[index] ?? "";
    }
  }
  return wellFormed;
};

const toWellFormedStorageString = (value: string): string => {
  const nativeToWellFormed = (value as string & { toWellFormed?: () => string })
    .toWellFormed;
  return typeof nativeToWellFormed === "function"
    ? nativeToWellFormed.call(value)
    : fallbackToWellFormed(value);
};

export const sanitizeForPostgresStorage = (
  value: unknown
): StorageSanitizationResult => {
  if (typeof value === "string") {
    const nulCharacters = value.split(NUL_CHARACTER).length - 1;
    const withoutNul =
      nulCharacters > 0
        ? value.replaceAll(NUL_CHARACTER, NUL_DISPLAY_REPLACEMENT)
        : value;
    const malformedUtf16 = countMalformedUtf16CodeUnits(withoutNul);
    const sanitized =
      malformedUtf16 > 0 ? toWellFormedStorageString(withoutNul) : withoutNul;
    const counts = { nulCharacters, malformedUtf16 };
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  if (Array.isArray(value)) {
    const counts = emptyStorageSanitizationCounts();
    const sanitized = value.map((item) => {
      const result = sanitizeForPostgresStorage(item);
      addStorageSanitizationCounts(counts, result.counts);
      return result.value;
    });
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  if (isPlainRecord(value)) {
    const counts = emptyStorageSanitizationCounts();
    const sanitized: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const sanitizedKey = sanitizeForPostgresStorage(key);
      const sanitizedField = sanitizeForPostgresStorage(field);
      addStorageSanitizationCounts(counts, sanitizedKey.counts);
      addStorageSanitizationCounts(counts, sanitizedField.counts);
      sanitized[String(sanitizedKey.value)] = sanitizedField.value;
    }
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  const counts = emptyStorageSanitizationCounts();
  return { value, replacementCount: 0, counts };
};

export const metadataWithStorageSanitization = (
  metadata: Record<string, unknown>,
  counts: StorageSanitizationCounts
): Record<string, unknown> => {
  if (totalStorageSanitizationCount(counts) === 0) {
    return metadata;
  }
  const existingKoed = isPlainRecord(metadata.koedSanitization)
    ? metadata.koedSanitization
    : {};
  const sanitization: Record<string, unknown> = { ...existingKoed };
  if (counts.nulCharacters > 0) {
    sanitization.nulCharacters = {
      replacement: "U+FFFD",
      replacementCount: counts.nulCharacters
    };
  }
  if (counts.malformedUtf16 > 0) {
    sanitization.malformedUtf16 = {
      replacement: "U+FFFD",
      replacementCount: counts.malformedUtf16
    };
  }
  return {
    ...metadata,
    koedSanitization: sanitization
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
    model:
      "Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp:Qwen3-Reranker-0.6B-Q4_K_M.gguf"
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
