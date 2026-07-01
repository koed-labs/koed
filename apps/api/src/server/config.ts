import {
  resolveKoedQueueBackend,
  type KoedQueueBackend,
  resolveRerankerKeyFromEnv
} from "@koed/shared";
import type { RateLimitName, RateLimitPolicy } from "../infra/rate-limit.js";
import { parseCsv } from "./utils.js";

export interface ApiServerConfig {
  nodeEnv: string;
  production: boolean;
  test: boolean;
  logLevel: string;
  requestBodyLimitBytes: number;
  databaseUrl?: string;
  redisUrl?: string;
  queueBackend: KoedQueueBackend;
  apiPort?: string;
  dataEncryptionKeyConfigured: boolean;
  apiTokenPepperConfigured: boolean;
  apiTokenPepper: string;
  cookieSecure: boolean;
  publicRegistrationEnabled: boolean;
  corsOrigins: Set<string>;
  rateLimit: {
    store: string;
    redisUrl?: string;
    policies: Record<RateLimitName, RateLimitPolicy>;
  };
  cache: {
    store: string;
    redisUrl?: string;
    graphCacheTtlSeconds: number;
  };
  graph: {
    updateDebounceMs: number;
    memoryEventUpdateDebounceMs: number;
  };
  embeddingModel?: string;
  rerankerKey?: string;
}

const optionalEnv = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const positiveIntEnv = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const parsed = Number.parseInt(environment[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, "");

const resolveCorsOrigins = (
  environment: NodeJS.ProcessEnv,
  nodeEnv: string
): Set<string> => {
  const configured = parseCsv(environment.CORS_ORIGINS);
  const derived = [environment.PUBLIC_APP_URL, environment.API_BASE_URL].filter(
    (value): value is string => Boolean(optionalEnv(value))
  );
  const development =
    nodeEnv === "production"
      ? []
      : [
          "http://localhost:5174",
          "http://127.0.0.1:5174",
          "http://localhost:3000"
        ];

  return new Set(
    [...configured, ...derived, ...development].map(normalizeOrigin)
  );
};

export const resolveApiServerConfig = (
  environment: NodeJS.ProcessEnv = process.env
): ApiServerConfig => {
  const nodeEnv = environment.NODE_ENV ?? "development";
  const databaseUrl = optionalEnv(environment.DATABASE_URL);
  const redisUrl = optionalEnv(environment.REDIS_URL);
  const memoryRateLimitWindowMs = positiveIntEnv(
    environment,
    "MEMORY_RATE_LIMIT_WINDOW_MS",
    60_000
  );
  const memoryRateLimitMax = positiveIntEnv(
    environment,
    "MEMORY_RATE_LIMIT_MAX",
    1000
  );
  const graphUpdateDebounceMs = positiveIntEnv(
    environment,
    "GRAPH_UPDATE_DEBOUNCE_MS",
    1_000
  );

  return {
    nodeEnv,
    production: nodeEnv === "production",
    test: nodeEnv === "test",
    logLevel: environment.LOG_LEVEL ?? "info",
    requestBodyLimitBytes: positiveIntEnv(
      environment,
      "REQUEST_BODY_LIMIT_BYTES",
      4 * 1024 * 1024
    ),
    databaseUrl,
    redisUrl,
    queueBackend: resolveKoedQueueBackend(environment.WORK_QUEUE_BACKEND),
    apiPort: optionalEnv(environment.API_PORT),
    dataEncryptionKeyConfigured: Boolean(
      optionalEnv(environment.DATA_ENCRYPTION_KEY)
    ),
    apiTokenPepperConfigured: Boolean(
      optionalEnv(environment.API_TOKEN_PEPPER)
    ),
    apiTokenPepper: environment.API_TOKEN_PEPPER ?? "",
    cookieSecure: environment.COOKIE_SECURE === "false" ? false : true,
    publicRegistrationEnabled:
      environment.KOED_ALLOW_PUBLIC_REGISTRATION === "true",
    corsOrigins: resolveCorsOrigins(environment, nodeEnv),
    rateLimit: {
      store: optionalEnv(environment.RATE_LIMIT_STORE) ?? "memory",
      redisUrl: optionalEnv(environment.RATE_LIMIT_REDIS_URL) ?? redisUrl,
      policies: {
        auth: {
          windowMs: positiveIntEnv(
            environment,
            "AUTH_RATE_LIMIT_WINDOW_MS",
            60_000
          ),
          max: positiveIntEnv(environment, "AUTH_RATE_LIMIT_MAX", 20)
        },
        memoryRead: {
          windowMs: positiveIntEnv(
            environment,
            "MEMORY_READ_RATE_LIMIT_WINDOW_MS",
            memoryRateLimitWindowMs
          ),
          max: positiveIntEnv(
            environment,
            "MEMORY_READ_RATE_LIMIT_MAX",
            memoryRateLimitMax
          )
        },
        memoryWrite: {
          windowMs: positiveIntEnv(
            environment,
            "MEMORY_WRITE_RATE_LIMIT_WINDOW_MS",
            memoryRateLimitWindowMs
          ),
          max: positiveIntEnv(
            environment,
            "MEMORY_WRITE_RATE_LIMIT_MAX",
            memoryRateLimitMax
          )
        },
        memoryRecall: {
          windowMs: positiveIntEnv(
            environment,
            "MEMORY_RECALL_RATE_LIMIT_WINDOW_MS",
            memoryRateLimitWindowMs
          ),
          max: positiveIntEnv(
            environment,
            "MEMORY_RECALL_RATE_LIMIT_MAX",
            memoryRateLimitMax
          )
        }
      }
    },
    cache: {
      store: optionalEnv(environment.CACHE_STORE) ?? "memory",
      redisUrl: optionalEnv(environment.CACHE_REDIS_URL) ?? redisUrl,
      graphCacheTtlSeconds: positiveIntEnv(
        environment,
        "GRAPH_CACHE_TTL_SECONDS",
        5
      )
    },
    graph: {
      updateDebounceMs: graphUpdateDebounceMs,
      memoryEventUpdateDebounceMs: positiveIntEnv(
        environment,
        "MEMORY_EVENT_GRAPH_UPDATE_DEBOUNCE_MS",
        Math.min(graphUpdateDebounceMs, 100)
      )
    },
    embeddingModel: optionalEnv(environment.EMBEDDING_MODEL),
    rerankerKey: optionalEnv(resolveRerankerKeyFromEnv(environment))
  };
};
