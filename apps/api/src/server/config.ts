import {
  resolveApiDataEncryptionKeyFromEnv,
  resolveKoedQueueBackend,
  type KoedQueueBackend,
  resolveRerankerKeyFromEnv
} from "@koed/shared";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  resolveDeploymentProfile,
  resolveRuntimeDependencyMode,
  type DeploymentProfile,
  type RuntimeDependencyMode
} from "./capabilities.js";
import type { RateLimitName, RateLimitPolicy } from "../infra/rate-limit.js";
import { parseCsv } from "./utils.js";
import { resolveTeamCollaborationEnabled } from "./team-collaboration-feature.js";

export interface ApiServerConfig {
  nodeEnv: string;
  production: boolean;
  test: boolean;
  logLevel: string;
  requestBodyLimitBytes: number;
  databaseUrl?: string;
  redisUrl?: string;
  queueBackend: KoedQueueBackend;
  deploymentProfile: DeploymentProfile;
  runtimeMode: "developer" | "local-personal" | "external";
  dependencyMode: RuntimeDependencyMode;
  apiPort?: string;
  koedHome: string;
  explorerPublicUrl?: string;
  upstreamBackendsPath: string;
  upstreamEnrollmentsPath: string;
  dataEncryptionKeyConfigured: boolean;
  apiTokenPepperConfigured: boolean;
  apiTokenPepper: string;
  cookieSecure: boolean;
  publicRegistrationEnabled: boolean;
  teamCollaborationEnabled: boolean;
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
  collaborationRealtime: {
    cursorSecret?: string;
    localBrokerSecret?: string;
    streamMaxClients: number;
    streamMaxClientsPerPrincipal: number;
  };
  crossIdentitySyncStaleAfterSeconds: number;
  embeddingModel?: string;
  rerankerKey?: string;
  workos: {
    authkitEnabled: boolean;
    apiBaseUrl: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    providerEnvironment: string;
  };
  ops: {
    backupStatusPath?: string;
    backupMaxAgeSeconds: number;
    requestMetricsStatusPath?: string;
    requestMetricsMaxAgeSeconds: number;
    maxRssBytes: number;
    runbookBaseUrl?: string;
    operatorEmails: string[];
    alertWebhookUrl?: string;
    alertWebhookToken?: string;
  };
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

const optionalPublicHttpUrl = (
  value: string | undefined,
  name: string
): string | undefined => {
  const configured = optionalEnv(value);
  if (!configured) return undefined;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${name} must be an absolute HTTP or HTTPS URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an absolute HTTP or HTTPS URL without credentials, query, or fragment`
    );
  }
  return url.toString().replace(/\/$/, "");
};

const resolveRuntimeMode = (
  value: string | undefined
): ApiServerConfig["runtimeMode"] =>
  value === "local-personal" || value === "external" || value === "developer"
    ? value
    : "developer";

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
          "http://localhost:3300"
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
  const koedHome = resolve(
    optionalEnv(environment.KOED_HOME) ?? `${homedir()}/.koed`
  );
  const runtimeMode = resolveRuntimeMode(environment.KOED_RUNTIME_MODE);
  const dependencyMode = resolveRuntimeDependencyMode(
    environment.KOED_DEPENDENCY_MODE
  );
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
    deploymentProfile: resolveDeploymentProfile(
      environment.KOED_DEPLOYMENT_PROFILE,
      runtimeMode
    ),
    runtimeMode,
    dependencyMode,
    apiPort: optionalEnv(environment.API_PORT),
    koedHome,
    explorerPublicUrl: optionalPublicHttpUrl(
      environment.EXPLORER_PUBLIC_URL,
      "EXPLORER_PUBLIC_URL"
    ),
    upstreamBackendsPath: resolve(koedHome, "config", "upstream-backends.json"),
    upstreamEnrollmentsPath: resolve(
      koedHome,
      "run",
      "upstream-enrollments.json"
    ),
    dataEncryptionKeyConfigured: Boolean(
      resolveApiDataEncryptionKeyFromEnv(environment)
    ),
    apiTokenPepperConfigured: Boolean(
      optionalEnv(environment.API_TOKEN_PEPPER)
    ),
    apiTokenPepper: environment.API_TOKEN_PEPPER ?? "",
    cookieSecure: environment.COOKIE_SECURE === "false" ? false : true,
    publicRegistrationEnabled:
      environment.KOED_ALLOW_PUBLIC_REGISTRATION === "true",
    teamCollaborationEnabled: resolveTeamCollaborationEnabled(environment),
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
        },
        sourceJournal: {
          windowMs: positiveIntEnv(
            environment,
            "SOURCE_JOURNAL_RATE_LIMIT_WINDOW_MS",
            memoryRateLimitWindowMs
          ),
          max: positiveIntEnv(
            environment,
            "SOURCE_JOURNAL_RATE_LIMIT_MAX",
            10_000
          )
        },
        projectionRebuild: {
          windowMs: positiveIntEnv(
            environment,
            "MEMORY_PROJECTION_REBUILD_RATE_LIMIT_WINDOW_MS",
            60_000
          ),
          max: positiveIntEnv(
            environment,
            "MEMORY_PROJECTION_REBUILD_RATE_LIMIT_MAX",
            2
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
    collaborationRealtime: {
      localBrokerSecret: optionalEnv(
        environment.COLLABORATION_LOCAL_BROKER_SECRET
      ),
      cursorSecret: optionalEnv(
        environment.COLLABORATION_REALTIME_CURSOR_SECRET
      ),
      streamMaxClients: positiveIntEnv(
        environment,
        "COLLABORATION_REALTIME_STREAM_MAX_CLIENTS",
        1_000
      ),
      streamMaxClientsPerPrincipal: positiveIntEnv(
        environment,
        "COLLABORATION_REALTIME_STREAM_MAX_CLIENTS_PER_PRINCIPAL",
        6
      )
    },
    crossIdentitySyncStaleAfterSeconds: positiveIntEnv(
      environment,
      "CROSS_IDENTITY_SYNC_STALE_AFTER_SECONDS",
      86_400
    ),
    embeddingModel: optionalEnv(environment.EMBEDDING_MODEL),
    rerankerKey: optionalEnv(resolveRerankerKeyFromEnv(environment)),
    workos: {
      authkitEnabled: environment.WORKOS_AUTHKIT_ENABLED === "true",
      apiBaseUrl:
        optionalEnv(environment.WORKOS_API_BASE_URL) ??
        "https://api.workos.com",
      clientId: optionalEnv(environment.WORKOS_CLIENT_ID),
      clientSecret: optionalEnv(environment.WORKOS_API_KEY),
      redirectUri: optionalEnv(environment.WORKOS_REDIRECT_URI),
      providerEnvironment:
        optionalEnv(environment.WORKOS_PROVIDER_ENVIRONMENT) ?? "default"
    },
    ops: {
      backupStatusPath: optionalEnv(environment.KOED_BACKUP_STATUS_PATH),
      backupMaxAgeSeconds: positiveIntEnv(
        environment,
        "KOED_BACKUP_MAX_AGE_SECONDS",
        24 * 60 * 60
      ),
      requestMetricsStatusPath: optionalEnv(
        environment.KOED_OPS_REQUEST_METRICS_STATUS_PATH
      ),
      requestMetricsMaxAgeSeconds: positiveIntEnv(
        environment,
        "KOED_OPS_REQUEST_METRICS_MAX_AGE_SECONDS",
        5 * 60
      ),
      maxRssBytes: positiveIntEnv(
        environment,
        "KOED_OPS_MAX_RSS_BYTES",
        1536 * 1024 * 1024
      ),
      runbookBaseUrl: optionalEnv(environment.KOED_RUNBOOK_BASE_URL),
      operatorEmails: parseCsv(environment.KOED_OPS_OPERATOR_EMAILS).map(
        (email) => email.toLowerCase()
      ),
      alertWebhookUrl: optionalEnv(environment.KOED_OPS_ALERT_WEBHOOK_URL),
      alertWebhookToken: optionalEnv(environment.KOED_OPS_ALERT_WEBHOOK_TOKEN)
    }
  };
};
