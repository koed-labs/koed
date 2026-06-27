import {
  capturePersonalEvent,
  searchMemory,
  type Visibility
} from "@koed/core";
import { createDbPool, type MemorySourceRepository } from "@koed/db";
import {
  createHealth,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig
} from "@koed/shared";
import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { ApiRouteContext } from "./context.js";
import { selfHostedCapabilities } from "./capabilities.js";
import { openApiDocument } from "./openapi.js";
import type { EmbeddingSourceType, MemoryJobStatus } from "../memory/jobs.js";

interface OperationalRouteOptions {
  repository: MemorySourceRepository | null;
  embeddingQueue: Queue | null;
  compactionQueue: Queue | null;
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
    status: "ok" | "degraded" | "error" = "ok"
  ) => createHealth(service, status);

  app.get("/ready", async (_request, reply) => {
    const checks = [publicHealth("api")];
    const repo = repository;

    if (repo) {
      try {
        checks.push(
          publicHealth("postgres", (await repo.health()) ? "ok" : "error")
        );
      } catch {
        checks.push(publicHealth("postgres", "error"));
      }
    } else if (config.databaseUrl) {
      checks.push(publicHealth("postgres", "error"));
    }

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
    }

    if (repo) {
      try {
        const status = await repo.getLocalEmbeddingStatus();
        checks.push(
          publicHealth("embedding-service", status.healthy ? "ok" : "degraded")
        );
      } catch {
        checks.push(publicHealth("embedding-service", "error"));
      }
    }

    const ready = checks
      .filter((check) => check.service !== "embedding-service")
      .every((check) => check.status === "ok");
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
          workerQueues: { status: "not_disclosed" }
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

  app.post("/self-host/smoke-test", async (request) => {
    const repo = requireRepository();
    const user = await auth.authenticateSession(request);
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
      recall: {
        hits: search.results.length,
        topHit: search.results[0] ?? null,
        retrieval: search.metadata
      }
    };
  });
};
