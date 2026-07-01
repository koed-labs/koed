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
import {
  createHealth,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig,
  type KoedJobQueue
} from "@koed/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { ApiRouteContext } from "./context.js";
import { selfHostedCapabilities } from "./capabilities.js";
import { openApiDocument } from "./openapi.js";
import type { EmbeddingSourceType, MemoryJobStatus } from "../memory/jobs.js";

interface OperationalRouteOptions {
  dbPool?: DbPool | null;
  repository: MemorySourceRepository | null;
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

export const registerOperationalRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  options: OperationalRouteOptions
) => {
  const { config, requireRepository, auth } = context;
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

  app.get("/v1/capabilities", () => selfHostedCapabilities);

  app.get("/health/details", async (request) => {
    await auth.authenticateSession(request);
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

    return {
      status: checks.every((check) => check.status === "ok")
        ? "ok"
        : "degraded",
      checks
    };
  });

  app.get("/self-host/status", async (request) => {
    const repo = requireRepository();
    const user = await auth.authenticateSession(request).catch(() => null);
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
    const [ready, embedding, embeddingJobs, compactionJobs] = await Promise.all(
      [
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
          .catch(() => ({ status: "unavailable" }))
      ]
    );

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
        }
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
      workspaceId: "koed-self-hosted-console",
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
