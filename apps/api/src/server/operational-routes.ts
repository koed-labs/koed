import {
  capturePersonalEvent,
  searchMemory,
  type Visibility
} from "@koed/core";
import {
  createDbPool,
  getLatestMigrationTimestamp,
  inspectDatabaseReadiness,
  type DbPool,
  type MemorySourceRepository
} from "@koed/db";
import { readFile, statfs } from "node:fs/promises";
import {
  createHealth,
  createEncryptedJsonPackage,
  redactEnvelopeEncryptionProviderStatus,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig,
  type EnvelopeEncryptionProvider,
  type EnvelopeEncryptionProviderStatus,
  type KoedJobQueue
} from "@koed/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";
import type { ApiRouteContext } from "./context.js";
import {
  buildCapabilitiesResponse,
  type CommercialBillingInput,
  type CommercialEntitlementInput
} from "./capabilities.js";
import { openApiDocument } from "./openapi.js";
import type { EmbeddingSourceType, MemoryJobStatus } from "../memory/jobs.js";
import {
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  upstreamAdvertisesCapability
} from "../local-edge/upstream-routing.js";

interface OperationalRouteOptions {
  dbPool?: DbPool | null;
  repository: MemorySourceRepository | null;
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  alertFetch?: typeof fetch;
  embeddingQueue: KoedJobQueue<unknown> | null;
  compactionQueue: KoedJobQueue<unknown> | null;
  runCompactionInline(
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    visibility: Visibility
  ): Promise<{ leafNodeIds: string[]; rollupNodeId: string | null }>;
  enqueueEmbedding(
    sourceType: EmbeddingSourceType,
    sourceId: string
  ): Promise<MemoryJobStatus>;
}

const hostedOpsProfiles = new Set([
  "private_vps",
  "team_self_hosted",
  "koed_managed_cloud"
]);

const applicationLayerEncryptionCapability = (
  provider: EnvelopeEncryptionProvider | undefined
) => {
  if (!provider) {
    return "unavailable" as const;
  }
  return provider.mode === "local_test_key"
    ? ("partial" as const)
    : ("available" as const);
};

const assertOpsOperatorSession = async (
  request: Parameters<ApiRouteContext["auth"]["authenticateSession"]>[0],
  context: ApiRouteContext
) => {
  const user = await context.auth.authenticateSession(request);
  if (!hostedOpsProfiles.has(context.config.deploymentProfile)) {
    return user;
  }
  if (context.config.ops.operatorEmails.includes(user.email.toLowerCase())) {
    return user;
  }
  throw Object.assign(new Error("Hosted operations access is restricted"), {
    statusCode: 403
  });
};

const capabilitiesAuthenticatedQuerySchema = z
  .object({
    teamId: z.string().uuid().optional()
  })
  .strict();

const opsSupportOverviewParamsSchema = z
  .object({
    teamId: z.string().uuid()
  })
  .strict();

const forbidden = (message: string) =>
  Object.assign(new Error(message), { statusCode: 403 });

type OpsComponentStatus =
  | "ok"
  | "degraded"
  | "error"
  | "not_configured"
  | "not_required";

type OpsComponent = {
  status: OpsComponentStatus;
  details?: Record<string, unknown>;
};

type OpsAlert = {
  code: string;
  severity: "warning" | "critical";
  component: string;
  status: OpsComponentStatus;
  runbookUrl: string | null;
};

type OpsAlertDelivery = {
  status: "configured" | "not_configured" | "sent" | "error";
  sink: "webhook" | "none";
  redacted: true;
  reason?: string;
};

const opsRunbookUrl = (
  baseUrl: string | undefined,
  code: string
): string | null => {
  if (!baseUrl) {
    return null;
  }
  try {
    return new URL(
      code,
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
    ).toString();
  } catch {
    return null;
  }
};

const opsOverallStatus = (components: Record<string, OpsComponent>) => {
  const statuses = Object.values(components).map(
    (component) => component.status
  );
  if (statuses.includes("error")) {
    return "error";
  }
  if (
    statuses.some(
      (status) => status === "degraded" || status === "not_configured"
    )
  ) {
    return "degraded";
  }
  return "ok";
};

const opsAlerts = (
  components: Record<string, OpsComponent>,
  runbookBaseUrl: string | undefined
): OpsAlert[] =>
  Object.entries(components)
    .filter(([, component]) =>
      ["degraded", "error", "not_configured"].includes(component.status)
    )
    .map(([componentName, component]) => ({
      code: `${componentName}.${component.status}`,
      severity: component.status === "error" ? "critical" : "warning",
      component: componentName,
      status: component.status,
      runbookUrl: opsRunbookUrl(
        runbookBaseUrl,
        `${componentName}.${component.status}`
      )
    }));

const collectAlertDeliveryStatus = (
  webhookUrl: string | undefined,
  tokenConfigured: boolean
): OpsComponent => {
  if (!webhookUrl) {
    return {
      status: "not_configured",
      details: {
        sink: "none",
        reason: "KOED_OPS_ALERT_WEBHOOK_URL is not configured"
      }
    };
  }
  return {
    status: "ok",
    details: {
      sink: "webhook",
      tokenConfigured,
      endpointConfigured: true
    }
  };
};

const deliverOpsAlert = async (
  alertFetch: typeof fetch,
  webhookUrl: string | undefined,
  webhookToken: string | undefined,
  alert: OpsAlert
): Promise<OpsAlertDelivery> => {
  if (!webhookUrl) {
    return {
      status: "not_configured",
      sink: "none",
      redacted: true,
      reason: "KOED_OPS_ALERT_WEBHOOK_URL is not configured"
    };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5000);
  try {
    const response = await alertFetch(webhookUrl, {
      method: "POST",
      signal: abortController.signal,
      headers: {
        "content-type": "application/json",
        ...(webhookToken ? { authorization: `Bearer ${webhookToken}` } : {})
      },
      body: JSON.stringify({
        product: "koed",
        generatedAt: new Date().toISOString(),
        redacted: true,
        alert
      })
    });
    if (!response.ok) {
      return {
        status: "error",
        sink: "webhook",
        redacted: true,
        reason: "alert_webhook_rejected"
      };
    }
    return { status: "sent", sink: "webhook", redacted: true };
  } catch {
    return {
      status: "error",
      sink: "webhook",
      redacted: true,
      reason: "alert_webhook_unavailable"
    };
  } finally {
    clearTimeout(timeout);
  }
};

const safeNumber = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
};

const collectQueueCounts = async (
  queue: KoedJobQueue<unknown> | null
): Promise<OpsComponent> => {
  if (!queue) {
    return { status: "not_configured" };
  }
  try {
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed"
    );
    const failed = counts.failed ?? 0;
    return {
      status: failed > 0 ? "error" : "ok",
      details: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed
      }
    };
  } catch {
    return { status: "error", details: { reason: "queue_counts_unavailable" } };
  }
};

const collectHistoricalImportStatus = async (
  repository: MemorySourceRepository
): Promise<OpsComponent> => {
  try {
    const backlog = await repository.getConversationProjectionBacklog();
    return {
      status: "ok",
      details: {
        diagnosticOnly: true,
        pendingRows: backlog.historicalImportRows,
        pendingBytes: backlog.historicalImportBytes,
        liveProjectionRows: backlog.liveProjectionRows,
        interactiveQuestionRows: backlog.interactiveQuestionRows
      }
    };
  } catch {
    return {
      status: "ok",
      details: {
        diagnosticOnly: true,
        availability: "unavailable"
      }
    };
  }
};

const envelopeProviderStatusToOpsStatus = (
  status: EnvelopeEncryptionProviderStatus["status"]
): OpsComponentStatus => {
  switch (status) {
    case "available":
    case "configured":
      return "ok";
    case "degraded":
      return "degraded";
    case "unavailable":
      return "error";
  }
};

const collectEnvelopeEncryptionStatus = async (
  provider: EnvelopeEncryptionProvider | undefined
): Promise<OpsComponent> => {
  if (!provider) {
    return { status: "not_configured" };
  }

  try {
    const rawStatus =
      (await provider.status?.()) ??
      ({
        mode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion,
        status: "configured"
      } satisfies EnvelopeEncryptionProviderStatus);
    const status = redactEnvelopeEncryptionProviderStatus(rawStatus);
    return {
      status: envelopeProviderStatusToOpsStatus(status.status),
      details: {
        mode: status.mode,
        keyId: status.keyId,
        keyVersion: status.keyVersion,
        status: status.status,
        details: status.details ?? {}
      }
    };
  } catch {
    const status = redactEnvelopeEncryptionProviderStatus({
      mode: provider.mode,
      keyId: provider.keyId,
      keyVersion: provider.keyVersion,
      status: "unavailable"
    });
    return {
      status: "error",
      details: {
        mode: status.mode,
        keyId: status.keyId,
        keyVersion: status.keyVersion
      }
    };
  }
};

const collectRequestMetricsStatus = async (
  path: string | undefined,
  maxAgeSeconds: number
): Promise<OpsComponent> => {
  if (!path) {
    return { status: "not_configured" };
  }
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      status?: unknown;
      checkedAt?: unknown;
      windowSeconds?: unknown;
      requestRatePerSecond?: unknown;
      p95LatencyMs?: unknown;
      p99LatencyMs?: unknown;
      errorRate?: unknown;
    };
    const checkedAt = typeof raw.checkedAt === "string" ? raw.checkedAt : null;
    const ageSeconds = checkedAt
      ? Math.floor((Date.now() - Date.parse(checkedAt)) / 1000)
      : null;
    const sourceStatus =
      raw.status === "ok" || raw.status === "degraded" || raw.status === "error"
        ? raw.status
        : "degraded";
    const stale =
      ageSeconds === null ||
      !Number.isFinite(ageSeconds) ||
      ageSeconds > maxAgeSeconds;
    return {
      status:
        sourceStatus === "error" ? "error" : stale ? "degraded" : sourceStatus,
      details: {
        path,
        checkedAt,
        ageSeconds,
        maxAgeSeconds,
        windowSeconds: safeNumber(raw.windowSeconds),
        requestRatePerSecond: safeNumber(raw.requestRatePerSecond),
        p95LatencyMs: safeNumber(raw.p95LatencyMs),
        p99LatencyMs: safeNumber(raw.p99LatencyMs),
        errorRate: safeNumber(raw.errorRate)
      }
    };
  } catch {
    return {
      status: "error",
      details: { path, reason: "request_metrics_status_unavailable" }
    };
  }
};

const collectRuntimeResourceStatus = (maxRssBytes: number): OpsComponent => {
  const memory = process.memoryUsage();
  const rssRatio = maxRssBytes > 0 ? memory.rss / maxRssBytes : 1;
  const status = rssRatio >= 1 ? "error" : rssRatio >= 0.9 ? "degraded" : "ok";
  const cpu = process.cpuUsage();
  return {
    status,
    details: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      maxRssBytes,
      rssUsedPercent: Math.round(rssRatio * 10_000) / 100,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system
    }
  };
};

const collectDiskStatus = async (path: string): Promise<OpsComponent> => {
  try {
    const stats = await statfs(path);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedRatio = totalBytes > 0 ? 1 - freeBytes / totalBytes : 1;
    const status =
      usedRatio >= 0.95 ? "error" : usedRatio >= 0.9 ? "degraded" : "ok";
    return {
      status,
      details: {
        path,
        totalBytes,
        freeBytes,
        usedPercent: Math.round(usedRatio * 10_000) / 100
      }
    };
  } catch {
    return {
      status: "error",
      details: { path, reason: "disk_status_unavailable" }
    };
  }
};

const collectBackupStatus = async (
  path: string | undefined,
  maxAgeSeconds: number
): Promise<OpsComponent> => {
  if (!path) {
    return { status: "not_configured" };
  }
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      status?: unknown;
      lastSuccessfulAt?: unknown;
      provider?: unknown;
      checkedAt?: unknown;
    };
    const lastSuccessfulAt =
      typeof raw.lastSuccessfulAt === "string" ? raw.lastSuccessfulAt : null;
    const ageSeconds = lastSuccessfulAt
      ? Math.floor((Date.now() - Date.parse(lastSuccessfulAt)) / 1000)
      : null;
    const status =
      raw.status === "ok" &&
      ageSeconds !== null &&
      Number.isFinite(ageSeconds) &&
      ageSeconds <= maxAgeSeconds
        ? "ok"
        : "degraded";
    return {
      status,
      details: {
        path,
        provider: typeof raw.provider === "string" ? raw.provider : null,
        checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : null,
        lastSuccessfulAt,
        maxAgeSeconds,
        ageSeconds
      }
    };
  } catch {
    return {
      status: "error",
      details: { path, reason: "backup_status_unavailable" }
    };
  }
};

export const registerOperationalRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  options: OperationalRouteOptions
) => {
  const { config, requireRepository, auth } = context;
  const readCrossIdentitySyncStatus = async () => {
    try {
      return await requireRepository().getCrossIdentitySyncOperationalStatus();
    } catch {
      return null;
    }
  };
  const pdsRelayCapability = async () => {
    const secureKeyProvider = context.personalDeviceSync.secureKeyProvider;
    if (
      !context.personalDeviceSync.authoritySigner ||
      !secureKeyProvider ||
      (secureKeyProvider.isReady && !(await secureKeyProvider.isReady()))
    ) {
      return "unavailable" as const;
    }
    try {
      const repository = requireRepository();
      await repository.getPdsRelayOperationalStatus();
      return (await repository.isPdsWorkerReady())
        ? ("available" as const)
        : ("unavailable" as const);
    } catch {
      return "unavailable" as const;
    }
  };
  const crossIdentitySyncCapability = async () => {
    if (
      applicationLayerEncryptionCapability(
        options.envelopeEncryptionProvider
      ) === "unavailable"
    ) {
      return "unavailable" as const;
    }
    if (!["developer", "local_personal"].includes(config.deploymentProfile)) {
      try {
        return (await requireRepository().isCrossIdentitySyncWorkerReady())
          ? ("available" as const)
          : ("unavailable" as const);
      } catch {
        return "unavailable" as const;
      }
    }
    const registry = readLocalEdgeUpstreamRegistry(
      context.localEdge.upstreamBackendsPath
    );
    return registry.backends.some((backend) => {
      const authorization =
        context.localEdge.resolveUpstreamAuthorization(backend);
      return (
        upstreamAdvertisesCapability(backend, "memory.crossIdentitySync") &&
        resolveLocalEdgeRouteDecision({
          operationFamily: "sync",
          upstreamBackend: backend,
          upstreamBackendId: backend.id,
          upstreamCredentialAvailable: Boolean(authorization),
          identityRemoteOperationsAllowed:
            context.localEdge.remoteOperationsAllowed()
        }).action === "queued_sync_handoff"
      );
    })
      ? ("available" as const)
      : ("unavailable" as const);
  };
  const {
    dbPool,
    repository,
    embeddingQueue,
    compactionQueue,
    runCompactionInline,
    enqueueEmbedding
  } = options;

  app.get("/", () => ({
    service: "koed-api",
    status: "ok",
    routes: {
      health: "/health",
      readiness: "/ready",
      publicStatus: "/self-host/status",
      capabilities: "/v1/capabilities",
      openapi: "/openapi.json"
    },
    explorer: {
      defaultUrl: "http://localhost:5174"
    }
  }));

  app.get("/health", async (_request, reply) =>
    reply.type("text/plain").send("OK")
  );

  const publicHealth = (
    service: string,
    status: "ok" | "degraded" | "error" = "ok",
    details?: Record<string, unknown>
  ) => createHealth(service, status, details);

  app.get("/ready", async (_request, reply) => {
    const checks = [publicHealth("api")];
    const repo = repository;

    if (config.databaseUrl && (dbPool || !repo)) {
      const pool =
        dbPool ?? createDbPool({ connectionString: config.databaseUrl });
      try {
        const readiness = await inspectDatabaseReadiness(pool, {
          expectedLatestMigrationTimestamp: await getLatestMigrationTimestamp()
        });
        checks.push(
          publicHealth("postgres", readiness.reachable ? "ok" : "error")
        );
        checks.push(
          publicHealth(
            "postgres-version",
            readiness.postgresCompatible ? "ok" : "error"
          )
        );
        checks.push(
          publicHealth(
            "migrations",
            readiness.migrationsCurrent ? "ok" : "error"
          )
        );
        checks.push(
          publicHealth("pgvector", readiness.pgvectorInstalled ? "ok" : "error")
        );
      } catch {
        checks.push(publicHealth("postgres", "error"));
        checks.push(publicHealth("postgres-version", "error"));
        checks.push(publicHealth("migrations", "error"));
        checks.push(publicHealth("pgvector", "error"));
      } finally {
        if (!dbPool) {
          await pool.end();
        }
      }
    } else if (repo) {
      try {
        checks.push(
          publicHealth("postgres", (await repo.health()) ? "ok" : "error")
        );
      } catch {
        checks.push(publicHealth("postgres", "error"));
      }
    }

    const redisRequired =
      config.queueBackend === "bullmq" ||
      config.rateLimit.store === "redis" ||
      config.cache.store === "redis";

    if (redisRequired) {
      if (config.redisUrl) {
        const redis = new Redis(config.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1
        });
        try {
          await redis.connect();
          await redis.ping();
          checks.push(publicHealth("redis"));
        } catch {
          checks.push(publicHealth("redis", "error"));
        } finally {
          redis.disconnect();
        }
      } else {
        checks.push(publicHealth("redis", "error"));
      }
    }

    if (repo) {
      try {
        const status = await repo.getLocalEmbeddingStatus();
        const expected = resolveSupportedEmbeddingModelConfig(
          config.embeddingModel ?? status.model ?? undefined
        );
        const compatible =
          status.healthy &&
          status.dimensions === expected.dimensions &&
          (!status.model || status.model === expected.key);
        checks.push(
          publicHealth("embedding-service", status.healthy ? "ok" : "degraded")
        );
        checks.push(
          publicHealth("embedding-model", compatible ? "ok" : "degraded")
        );
      } catch {
        checks.push(publicHealth("embedding-service", "error"));
        checks.push(publicHealth("embedding-model", "error"));
      }
    }

    checks.push(
      publicHealth(
        "work-queue",
        config.queueBackend === "local" || config.redisUrl ? "ok" : "error"
      )
    );

    const ready = checks.every((check) => check.status === "ok");
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? "ok" : "error", checks });
  });

  app.get("/openapi.json", () => openApiDocument);

  app.get("/v1/capabilities", async () =>
    buildCapabilitiesResponse(
      {
        deploymentProfile: config.deploymentProfile,
        runtimeMode: config.runtimeMode,
        dependencyMode: config.dependencyMode,
        workosAuthKitEnabled: config.workos.authkitEnabled,
        applicationLayerEncryption: applicationLayerEncryptionCapability(
          options.envelopeEncryptionProvider
        ),
        crossIdentitySync: await crossIdentitySyncCapability(),
        conversationSourceReplication:
          applicationLayerEncryptionCapability(
            options.envelopeEncryptionProvider
          ) === "unavailable"
            ? "unavailable"
            : "available",
        teamCollaborationEnabled: config.teamCollaborationEnabled,
        personalDeviceSync: await pdsRelayCapability()
      },
      "public"
    )
  );

  app.get("/v1/capabilities/authenticated", async (request) => {
    const user = await auth.authenticateSession(request);
    const query = capabilitiesAuthenticatedQuerySchema.parse(request.query);
    let entitlement: CommercialEntitlementInput | null = null;
    let billing: CommercialBillingInput | null = null;
    if (query.teamId && config.teamCollaborationEnabled) {
      const repo = requireRepository();
      const gate = await repo.getTeamEntitlementGate(
        { userId: user.id },
        query.teamId
      );
      if (!gate) {
        throw forbidden("Team entitlement capability cannot be viewed");
      }
      entitlement = {
        teamId: gate.teamId,
        status: gate.status,
        allowsTeamAccess: gate.allowsTeamAccess,
        deniedOperationFamilies: gate.deniedOperationFamilies
      };
      const billingSeats = await repo.getTeamBillingSeatState(
        { userId: user.id },
        query.teamId
      );
      billing = billingSeats
        ? {
            syncStatus: billingSeats.syncStatus,
            overLimitAt: billingSeats.overLimitAt
          }
        : null;
    }
    return buildCapabilitiesResponse(
      {
        deploymentProfile: config.deploymentProfile,
        runtimeMode: config.runtimeMode,
        dependencyMode: config.dependencyMode,
        workosAuthKitEnabled: config.workos.authkitEnabled,
        applicationLayerEncryption: applicationLayerEncryptionCapability(
          options.envelopeEncryptionProvider
        ),
        crossIdentitySync: await crossIdentitySyncCapability(),
        conversationSourceReplication:
          applicationLayerEncryptionCapability(
            options.envelopeEncryptionProvider
          ) === "unavailable"
            ? "unavailable"
            : "available",
        teamCollaborationEnabled: config.teamCollaborationEnabled,
        personalDeviceSync: await pdsRelayCapability()
      },
      "authenticated",
      entitlement,
      billing
    );
  });

  app.get("/health/details", async (request) => {
    await assertOpsOperatorSession(request, context);
    const checks = [createHealth("api")];

    if (config.databaseUrl) {
      const pool = createDbPool();
      try {
        await pool.query("select 1");
        checks.push(createHealth("postgres"));
      } catch {
        checks.push(createHealth("postgres", "error"));
      } finally {
        await pool.end();
      }
    }

    if (config.redisUrl) {
      const redis = new Redis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1
      });
      try {
        await redis.connect();
        await redis.ping();
        checks.push(createHealth("redis"));
      } catch {
        checks.push(createHealth("redis", "error"));
      } finally {
        redis.disconnect();
      }
    }

    const crossIdentitySync = await readCrossIdentitySyncStatus();
    return {
      status: checks.every((check) => check.status === "ok")
        ? "ok"
        : "degraded",
      checks,
      crossIdentitySync
    };
  });

  app.get("/self-host/status", async (request) => {
    const repo = requireRepository();
    const user = await assertOpsOperatorSession(request, context).catch(
      () => null
    );
    if (!user) {
      const ready = await repo.health().catch(() => false);
      return {
        status: ready ? "ok" : "error",
        components: {
          api: { status: "ok" },
          postgres: { status: ready ? "ok" : "error" },
          redis: {
            status: config.redisUrl ? "configured" : "not_configured"
          },
          embeddingService: { status: "not_disclosed" },
          workerQueues: {
            status: "not_disclosed",
            backend: config.queueBackend
          }
        },
        redacted: true
      };
    }
    const [ready, embedding, embeddingJobs, compactionJobs, crossIdentitySync] =
      await Promise.all([
        repo.health().catch(() => false),
        repo.getLocalEmbeddingStatus().catch(() => ({
          enabled: true,
          healthy: false,
          model: null,
          dimensions: null,
          error: "unavailable"
        })),
        embeddingQueue
          ?.getJobCounts("waiting", "active", "delayed", "failed")
          .catch(() => ({ status: "unavailable" })),
        compactionQueue
          ?.getJobCounts("waiting", "active", "delayed", "failed")
          .catch(() => ({ status: "unavailable" })),
        readCrossIdentitySyncStatus()
      ]);

    return {
      status: ready ? "ok" : "error",
      components: {
        api: { status: "ok" },
        postgres: { status: ready ? "ok" : "error" },
        redis: {
          status: config.redisUrl ? "configured" : "not_configured"
        },
        embeddingService: embedding,
        workerQueues: {
          backend: config.queueBackend,
          embedding: embeddingJobs ?? { status: "not_configured" },
          compaction: compactionJobs ?? { status: "not_configured" }
        },
        crossIdentitySync
      },
      configuration: {
        supportedClients: ["codex"],
        embeddingModel: config.embeddingModel ?? embedding.model,
        embeddingDimensions: resolveSupportedEmbeddingModelConfig(
          config.embeddingModel ?? embedding.model ?? undefined
        ).dimensions,
        rerankingEnabled:
          resolveSupportedRerankerModelConfig(config.rerankerKey) !== null
      }
    };
  });

  app.get("/ops/status", async (request) => {
    await assertOpsOperatorSession(request, context);
    const repo = requireRepository();
    const components: Record<string, OpsComponent> = {
      api: {
        status: "ok",
        details: {
          uptimeSeconds: Math.floor(process.uptime()),
          pid: process.pid
        }
      }
    };

    if (config.databaseUrl && dbPool) {
      try {
        const expectedLatestMigrationTimestamp =
          await getLatestMigrationTimestamp();
        const readiness = await inspectDatabaseReadiness(dbPool, {
          expectedLatestMigrationTimestamp
        });
        components.postgres = {
          status:
            readiness.reachable && readiness.postgresCompatible
              ? "ok"
              : "error",
          details: {
            reachable: readiness.reachable,
            postgresCompatible: readiness.postgresCompatible,
            postgresVersion: readiness.postgresVersion,
            postgresVersionNum: readiness.postgresVersionNum
          }
        };
        components.migrations = {
          status: readiness.migrationsCurrent ? "ok" : "error",
          details: {
            current: readiness.migrationsCurrent,
            expectedLatestMigrationTimestamp
          }
        };
        components.pgvector = {
          status: readiness.pgvectorInstalled ? "ok" : "error",
          details: {
            installed: readiness.pgvectorInstalled,
            version: readiness.pgvectorVersion
          }
        };
      } catch {
        components.postgres = { status: "error" };
        components.migrations = { status: "error" };
        components.pgvector = { status: "error" };
      }
    } else {
      const ready = await repo.health().catch(() => false);
      components.postgres = { status: ready ? "ok" : "error" };
      components.migrations = { status: "not_configured" };
      components.pgvector = { status: "not_configured" };
    }

    const redisRequired =
      config.queueBackend === "bullmq" ||
      config.rateLimit.store === "redis" ||
      config.cache.store === "redis";
    if (redisRequired) {
      if (config.redisUrl) {
        const redis = new Redis(config.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1
        });
        try {
          await redis.connect();
          await redis.ping();
          components.redis = { status: "ok" };
        } catch {
          components.redis = { status: "error" };
        } finally {
          redis.disconnect();
        }
      } else {
        components.redis = { status: "error" };
      }
    } else {
      components.redis = { status: "not_required" };
    }

    try {
      const status = await repo.getLocalEmbeddingStatus();
      const expected = resolveSupportedEmbeddingModelConfig(
        config.embeddingModel ?? status.model ?? undefined
      );
      const compatible =
        status.healthy &&
        status.dimensions === expected.dimensions &&
        (!status.model || status.model === expected.key);
      components.embeddingService = {
        status: status.healthy ? "ok" : "degraded",
        details: {
          enabled: status.enabled,
          healthy: status.healthy,
          model: status.model,
          dimensions: status.dimensions,
          error: status.error
        }
      };
      components.embeddingModel = {
        status: compatible ? "ok" : "degraded",
        details: {
          configuredModel: config.embeddingModel ?? null,
          expectedModel: expected.key,
          expectedDimensions: expected.dimensions,
          observedModel: status.model,
          observedDimensions: status.dimensions
        }
      };
    } catch {
      components.embeddingService = { status: "error" };
      components.embeddingModel = { status: "error" };
    }

    components.memoryEmbedQueue = await collectQueueCounts(embeddingQueue);
    components.lcmCompactQueue = await collectQueueCounts(compactionQueue);
    components.historicalImport = await collectHistoricalImportStatus(repo);
    components.envelopeEncryption = await collectEnvelopeEncryptionStatus(
      options.envelopeEncryptionProvider
    );
    components.requestMetrics = await collectRequestMetricsStatus(
      config.ops.requestMetricsStatusPath,
      config.ops.requestMetricsMaxAgeSeconds
    );
    components.runtimeResources = collectRuntimeResourceStatus(
      config.ops.maxRssBytes
    );
    components.disk = await collectDiskStatus(config.koedHome);
    components.backups = await collectBackupStatus(
      config.ops.backupStatusPath,
      config.ops.backupMaxAgeSeconds
    );
    components.alertDelivery = collectAlertDeliveryStatus(
      config.ops.alertWebhookUrl,
      Boolean(config.ops.alertWebhookToken)
    );
    try {
      const relay = await repo.getPdsRelayOperationalStatus();
      components.pdsRelay = {
        status: relay.transports.expired > 0 ? "degraded" : "ok",
        details: { ...relay }
      };
    } catch {
      components.pdsRelay = { status: "error" };
    }
    try {
      const sync = await repo.getCrossIdentitySyncOperationalStatus();
      components.crossIdentitySync = {
        status:
          sync.outbox.failed > 0 ||
          sync.inbox.failed > 0 ||
          sync.relationships.failed > 0
            ? "degraded"
            : "ok",
        details: { ...sync }
      };
    } catch {
      components.crossIdentitySync = { status: "error" };
    }

    const status = opsOverallStatus(components);
    return {
      generatedAt: new Date().toISOString(),
      status,
      deployment: {
        profile: config.deploymentProfile,
        runtimeMode: config.runtimeMode,
        dependencyMode: config.dependencyMode,
        nodeEnv: config.nodeEnv,
        queueBackend: config.queueBackend
      },
      redacted: true,
      components,
      alerts: opsAlerts(components, config.ops.runbookBaseUrl)
    };
  });

  app.post("/ops/test-alert", async (request) => {
    await assertOpsOperatorSession(request, context);
    const alert: OpsAlert = {
      code: "testAlert.degraded",
      severity: "warning",
      component: "testAlert",
      status: "degraded",
      runbookUrl: opsRunbookUrl(config.ops.runbookBaseUrl, "testAlert.degraded")
    };
    const delivery = await deliverOpsAlert(
      options.alertFetch ?? globalThis.fetch.bind(globalThis),
      config.ops.alertWebhookUrl,
      config.ops.alertWebhookToken,
      alert
    );
    return {
      generatedAt: new Date().toISOString(),
      redacted: true,
      test: true,
      alert,
      delivery
    };
  });

  app.get("/ops/support/teams/:teamId/overview", async (request) => {
    const repo = requireRepository();
    const user = await assertOpsOperatorSession(request, context);
    const params = opsSupportOverviewParamsSchema.parse(request.params);
    const supportOverview = await repo.getHostedSupportOverview(
      { userId: user.id },
      params.teamId
    );
    if (!supportOverview) {
      throw forbidden("Hosted support overview cannot be viewed");
    }
    return { supportOverview };
  });

  app.post("/ops/support/teams/:teamId/bundle", async (request) => {
    const repo = requireRepository();
    const user = await assertOpsOperatorSession(request, context);
    const params = opsSupportOverviewParamsSchema.parse(request.params);
    if (!options.envelopeEncryptionProvider) {
      throw Object.assign(
        new Error("Encrypted support bundle provider required"),
        { statusCode: 503 }
      );
    }
    const supportOverview = await repo.getHostedSupportOverview(
      { userId: user.id },
      params.teamId
    );
    if (!supportOverview) {
      throw forbidden("Hosted support bundle cannot be created");
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const encryptedPackage = await createEncryptedJsonPackage(
      options.envelopeEncryptionProvider,
      {
        objectClass: "support_bundle",
        payload: {
          generatedAt: now.toISOString(),
          redacted: true,
          supportOverview
        },
        scope: {
          tenantId: params.teamId,
          teamId: params.teamId
        },
        provenance: {
          rowFamily: "hosted_support_bundles",
          sourceId: params.teamId
        },
        ciphertextLocation: "support_bundle.payload",
        aad: {
          route: "/ops/support/teams/:teamId/bundle",
          actorUserId: user.id,
          teamId: params.teamId,
          reason: "hosted_support_diagnostics"
        },
        metadata: {
          actorUserId: user.id,
          teamId: params.teamId,
          reason: "hosted_support_diagnostics",
          redacted: true,
          expiresAt: expiresAt.toISOString()
        },
        expiresAt,
        now
      }
    );
    await repo.recordAuditEvent({
      actorUserId: user.id,
      ownerUserId: null,
      visibility: null,
      action: "team.hosted_support_bundle.created",
      targetTable: "teams",
      targetId: params.teamId,
      metadata: {
        teamId: params.teamId,
        packageId: encryptedPackage.manifest.packageId,
        policy: "hosted_operator_redacted",
        rawContentAccess: "not_permitted",
        expiresAt: expiresAt.toISOString()
      }
    });
    return {
      encryptedPackage,
      redacted: true
    };
  });

  app.get("/self-host/diagnostics", async (request) => {
    const repo = requireRepository();
    const user = await auth.authenticateSession(request);
    const [overview, embeddingStatus, policies, tokens] = await Promise.all([
      repo.getLcmGraphOverview({ userId: user.id }),
      repo.getLocalEmbeddingStatus(),
      repo.listCapturePolicies({ userId: user.id }),
      repo.listApiTokens(user.id)
    ]);

    return {
      generatedAt: new Date().toISOString(),
      redacted: true,
      runtime: {
        nodeEnv: config.nodeEnv,
        apiPort: config.apiPort ?? null,
        databaseConfigured: Boolean(config.databaseUrl),
        redisConfigured: Boolean(config.redisUrl),
        queueBackend: config.queueBackend,
        dataEncryptionKeyConfigured: config.dataEncryptionKeyConfigured,
        apiTokenPepperConfigured: config.apiTokenPepperConfigured
      },
      integration: {
        supportedClients: ["codex"],
        unsupportedClients: []
      },
      embeddingStatus,
      overview,
      capturePolicies: policies,
      apiTokens: tokens.map((token) => ({
        id: token.id,
        name: token.name,
        tokenPrefix: token.tokenPrefix,
        scopes: token.scopes,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        revokedAt: token.revokedAt
      }))
    };
  });

  const waitForSmokeQueues = async () => {
    const readCounts = async (queue: KoedJobQueue<unknown> | null) => {
      if (!queue) {
        throw new Error("Smoke test queue is not configured.");
      }
      const counts = await queue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed"
      );
      for (const key of ["waiting", "active", "delayed", "failed"]) {
        if (!Number.isFinite(counts[key])) {
          throw new Error(`Smoke test queue count missing: ${key}`);
        }
      }
      if ((counts.failed ?? 0) > 0) {
        throw new Error("Smoke test queue has failed jobs.");
      }
      return counts;
    };
    let lastCounts = {
      embedding: await readCounts(embeddingQueue),
      compaction: await readCounts(compactionQueue)
    };
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      const pending = [lastCounts.embedding, lastCounts.compaction].reduce(
        (total, counts) =>
          total +
          (counts.waiting ?? 0) +
          (counts.active ?? 0) +
          (counts.delayed ?? 0),
        0
      );
      if (pending === 0) {
        return lastCounts;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      lastCounts = {
        embedding: await readCounts(embeddingQueue),
        compaction: await readCounts(compactionQueue)
      };
    }
    throw new Error("Timed out waiting for smoke test queues to drain.");
  };

  app.post("/self-host/smoke-test", async (request) => {
    const repo = requireRepository();
    const user = await auth.authenticateApiToken(request);
    const requesterContext = { userId: user.id };
    const marker = `koed-self-hosted-console-${Date.now()}`;
    const content = `Koed self-hosted smoke test memory ${marker}. The setup is working.`;
    const event = await capturePersonalEvent({
      repository: repo,
      requesterContext,
      projectId: "koed-self-hosted-console",
      actor: "user",
      eventType: "console_smoke_test",
      content,
      metadata: {
        source: "self-hosted-console",
        marker
      },
      visibility: "personal"
    });
    const compaction = await runCompactionInline(
      repo,
      requesterContext,
      "personal"
    );
    const embeddingJobs = await Promise.all([
      enqueueEmbedding("memory_event", event.id),
      ...compaction.leafNodeIds.map((nodeId) =>
        enqueueEmbedding("memory_node", nodeId)
      ),
      ...(compaction.rollupNodeId
        ? [enqueueEmbedding("memory_node", compaction.rollupNodeId)]
        : [])
    ]);
    const queueDrain = await waitForSmokeQueues();
    const search = await searchMemory({
      repository: repo,
      requesterContext,
      query: marker,
      scope: "personal",
      searchDomain: "global",
      limit: 5
    });

    return {
      ok: search.results.length > 0,
      marker,
      content,
      event,
      compaction,
      embeddingJobs,
      queueDrain,
      recall: {
        hits: search.results.length,
        topHit: search.results[0] ?? null,
        retrieval: search.metadata
      }
    };
  });
};
