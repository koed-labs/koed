import { randomBytes, createHash } from "node:crypto";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import argon2 from "argon2";
import { Queue } from "bullmq";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";
import {
  answerMemory,
  capturePersonalEvent,
  scheduleCompaction,
  searchMemory,
  type MemoryScope,
  type Visibility
} from "@koed/core";
import {
  createDbPool,
  createMemorySourceRepository,
  type MemorySourceRepository
} from "@koed/db";
import { createHealth } from "@koed/shared";

const sessionCookieName = "cm_session";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;

interface BuildServerOptions {
  repository?: MemorySourceRepository;
  runMemoryJobsInlineForTests?: boolean;
}

type RateLimitName = "auth" | "memory";
type EmbeddingSourceType = "memory_node" | "memory_event" | "message";

interface MemoryJobStatus {
  queued: boolean;
  inline: boolean;
  jobId?: string;
  reason?: string;
  compaction?: {
    leafNodeIds: string[];
    rollupNodeId: string | null;
  };
}

const hashSecret = (secret: string): string =>
  createHash("sha256")
    .update(`${process.env.API_TOKEN_PEPPER ?? ""}${secret}`)
    .digest("hex");

const createOpaqueSecret = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

const createInviteCode = (): string =>
  randomBytes(9).toString("base64url").toUpperCase();

const parseCsv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parsePositiveInt = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });

const allowedCorsOrigins = (): Set<string> => {
  const configured = parseCsv(process.env.CORS_ORIGINS);
  const derived = [process.env.PUBLIC_APP_URL, process.env.API_BASE_URL].filter(
    (value): value is string => Boolean(value)
  );
  const development =
    process.env.NODE_ENV === "production"
      ? []
      : [
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:3000"
        ];
  return new Set(
    [...configured, ...derived, ...development].map((origin) =>
      origin.replace(/\/+$/, "")
    )
  );
};

const rateLimits = {
  auth: {
    windowMs: parsePositiveInt("AUTH_RATE_LIMIT_WINDOW_MS", 60_000),
    max: parsePositiveInt("AUTH_RATE_LIMIT_MAX", 20)
  },
  memory: {
    windowMs: parsePositiveInt("MEMORY_RATE_LIMIT_WINDOW_MS", 60_000),
    max: parsePositiveInt("MEMORY_RATE_LIMIT_MAX", 120)
  }
} satisfies Record<RateLimitName, { windowMs: number; max: number }>;

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const publicUser = (user: {
  id: string;
  email: string;
  displayName: string | null;
}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(120).optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const createTeamSchema = z.object({
  name: z.string().min(1).max(120)
});

const joinTeamSchema = z.object({
  inviteCode: z.string().min(4).max(64)
});

const createApiTokenSchema = z.object({
  name: z.string().min(1).max(120),
  teamId: z.string().uuid().optional(),
  scopes: z.array(z.string().min(1)).default([])
});

const metadataSchema = z.record(z.string(), z.unknown()).default({});

const captureStateSchema = z.enum(["enabled", "disabled", "ask"]);
const visibilitySchema = z.enum(["personal", "team"]);

const createMcpSessionSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  externalSessionId: z.string().min(1).optional(),
  sourceRuntime: z.enum(["codex", "codex-cli"]).default("codex"),
  captureMethod: z.enum(["hook", "mcp", "web", "api"]).default("mcp"),
  model: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  codexTranscriptPath: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  sourceHash: z.string().min(1).optional()
});

const mcpSessionEventSchema = z.object({
  workspaceId: z.string().min(1).default("default"),
  turnId: z.string().uuid().optional(),
  actor: z.enum(["user", "assistant", "tool", "system"]),
  eventType: z.string().min(1).default("session_event"),
  content: z.string().min(1),
  metadata: metadataSchema
});

const capturePersonalEventSchema = z.object({
  workspaceId: z.string().min(1).default("default"),
  sessionId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
  actor: z.enum(["user", "assistant", "tool", "system"]),
  eventType: z.string().min(1),
  content: z.string().min(1),
  metadata: metadataSchema,
  sourceRuntime: z.enum(["codex", "codex-cli"]).default("codex-cli"),
  captureMethod: z.enum(["hook", "mcp", "web", "api"]).default("hook"),
  codexTranscriptPath: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  sourceHash: z.string().min(1).optional()
});

const capturePolicySchema = z.object({
  targetType: z.enum(["global", "project", "thread"]),
  projectId: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  projectPath: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  threadName: z.string().min(1).optional(),
  captureState: captureStateSchema.nullable().optional(),
  visibility: visibilitySchema.nullable().optional(),
  pauseUntil: z.string().datetime({ offset: true }).nullable().optional()
});

const effectivePolicyQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  sessionId: z.string().uuid().optional()
});

const memoryBrowserQuerySchema = z.object({
  query: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  pinned: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50)
});

const memoryClusterQuerySchema = memoryBrowserQuerySchema.extend({
  itemsPerCluster: z.coerce.number().int().positive().max(10).default(4)
});

const clusterIdParamsSchema = z.object({ clusterId: z.string().min(1) });

const updateMemorySchema = z.object({
  summaryText: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  visibility: visibilitySchema.optional()
});

const graphQuerySchema = z.object({
  query: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  includeInvalidated: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().positive().max(500).default(100)
});

const graphEventParamsSchema = z.object({ eventId: z.string().uuid() });

const graphEventDetailQuerySchema = z.object({
  includeInvalidated: z.coerce.boolean().default(false),
  includeRaw: z.coerce.boolean().default(false)
});

const graphEventPatchSchema = z.object({
  visibility: visibilitySchema.optional(),
  invalidated: z.boolean().optional()
});

const retrievalScopeSchema = z
  .enum(["personal", "personal+team"])
  .transform((scope): MemoryScope => {
    if (scope === "personal+team") {
      return "personal_and_team";
    }
    return scope;
  });

const searchDomainSchema = z.enum(["global", "project", "session"]);

const searchMemorySchema = z
  .object({
    query: z.string().min(1),
    retrieval_scope: retrievalScopeSchema.default("personal"),
    search_domain: searchDomainSchema.default("global"),
    session_id: z.string().uuid().optional(),
    workspace_id: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(50).default(10)
  })
  .superRefine((input, context) => {
    if (input.search_domain === "session" && !input.session_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session_id"],
        message: "session_id is required when search_domain is session"
      });
    }
    if (input.search_domain === "project" && !input.workspace_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_id"],
        message: "workspace_id is required when search_domain is project"
      });
    }
  });

const lcmPendingSummariesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(10)
});

const submitLcmSummarySchema = z.object({
  summaryText: z.string().min(1),
  summaryModel: z.string().min(1),
  summaryPromptVersion: z.string().min(1),
  summaryTokenEstimate: z.coerce.number().int().nonnegative()
});

const nodeIdParamsSchema = z.object({ nodeId: z.string().uuid() });
const sessionIdParamsSchema = z.object({ sessionId: z.string().uuid() });

const openApiEndpoints: Array<[string, string]> = [
  ["GET", "/v1/access/check"],
  ["GET", "/v1/capture-policy/effective"],
  ["GET", "/v1/capture-policies"],
  ["PUT", "/v1/capture-policies"],
  ["POST", "/v1/sessions"],
  ["POST", "/v1/sessions/{sessionId}/events"],
  ["POST", "/v1/memory/capture-personal-event"],
  ["GET", "/v1/memory/clusters"],
  ["GET", "/v1/memory/clusters/{clusterId}/memories"],
  ["GET", "/v1/memory/items"],
  ["GET", "/v1/memory/graph/overview"],
  ["GET", "/v1/memory/graph/nodes"],
  ["GET", "/v1/memory/graph/nodes/{nodeId}"],
  ["GET", "/v1/memory/graph/events"],
  ["GET", "/v1/memory/graph/events/{eventId}"],
  ["PATCH", "/v1/memory/graph/events/{eventId}"],
  ["DELETE", "/v1/memory/graph/events/{eventId}"],
  ["GET", "/v1/memory/export"],
  ["POST", "/v1/memory/search"],
  ["POST", "/v1/memory/answer"],
  ["PATCH", "/v1/memory/nodes/{nodeId}"],
  ["DELETE", "/v1/memory/nodes/{nodeId}"],
  ["GET", "/v1/memory/lcm/summaries/pending"],
  ["POST", "/v1/memory/lcm/summaries/{nodeId}"],
  ["GET", "/v1/memory/nodes/{nodeId}"],
  ["GET", "/v1/memory/nodes/{nodeId}/expand"]
];

const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "Koed Self-Hosted API", version: "0.1.0" },
  components: {
    securitySchemes: { bearerApiToken: { type: "http", scheme: "bearer" } }
  },
  security: [{ bearerApiToken: [] }],
  paths: Object.fromEntries(
    openApiEndpoints.map(([method, path]) => [
      path,
      {
        [method.toLowerCase()]: {
          responses: { "200": { description: "OK" } },
          security: [{ bearerApiToken: [] }]
        }
      }
    ])
  )
};

export const buildServer = async (options: BuildServerOptions = {}) => {
  if (process.env.NODE_ENV === "test") {
    rateLimitBuckets.clear();
  }

  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers.set-cookie"
            ]
          },
    bodyLimit: parsePositiveInt("REQUEST_BODY_LIMIT_BYTES", 256 * 1024)
  });

  const pool =
    options.repository || !process.env.DATABASE_URL ? null : createDbPool();
  const repository =
    options.repository ?? (pool ? createMemorySourceRepository(pool) : null);
  const createQueue = (name: string) =>
    process.env.REDIS_URL
      ? new Queue(name, {
          connection: {
            url: process.env.REDIS_URL,
            maxRetriesPerRequest: null
          }
        })
      : null;
  const embeddingQueue = createQueue("memory-embed");
  const compactionQueue = createQueue("lcm-compact");

  app.addHook("onClose", async () => {
    await Promise.all([embeddingQueue?.close(), compactionQueue?.close()]);
    await pool?.end();
  });

  const corsOrigins = allowedCorsOrigins();
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || corsOrigins.has(origin.replace(/\/+$/, ""))) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin is not allowed"), false);
    },
    credentials: true
  });

  await app.register(cookie);
  const requireRepository = (): MemorySourceRepository => {
    if (!repository) {
      throw Object.assign(new Error("Database is not configured"), {
        statusCode: 503
      });
    }

    return repository;
  };

  const setSessionCookie = (reply: FastifyReply, secret: string): void => {
    reply.setCookie(sessionCookieName, secret, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "false" ? false : true,
      path: "/",
      maxAge: Math.floor(sessionTtlMs / 1000)
    });
  };

  const authenticate = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;

    if (bearer) {
      const user = await repo.getApiTokenUser(hashSecret(bearer));
      if (user) {
        return user;
      }
    }

    const sessionSecret = request.cookies[sessionCookieName];
    if (sessionSecret) {
      const user = await repo.getSessionUser(hashSecret(sessionSecret));
      if (user) {
        return user;
      }
    }

    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  };

  const authenticateApiToken = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;
    if (!bearer) {
      throw Object.assign(new Error("Bearer API token required"), {
        statusCode: 401
      });
    }
    const user = await repo.getApiTokenUser(hashSecret(bearer));
    if (!user) {
      throw Object.assign(new Error("Invalid API token"), { statusCode: 401 });
    }
    return user;
  };

  const runCompactionInline = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    visibility: Visibility,
    teamId?: string
  ) =>
    scheduleCompaction({
      repository: repo,
      requesterContext,
      visibility,
      teamId
    });

  const enqueueEmbedding = async (
    sourceType: EmbeddingSourceType,
    sourceId: string
  ): Promise<MemoryJobStatus> => {
    if (!embeddingQueue) {
      app.log.warn({ sourceType, sourceId }, "embedding queue is unavailable");
      return {
        queued: false,
        inline: false,
        reason: "embedding queue is unavailable"
      };
    }

    try {
      const job = await withTimeout(
        embeddingQueue.add(
          "embed-source",
          { sourceType, sourceId },
          {
            attempts: 5,
            backoff: { type: "exponential", delay: 10_000 },
            removeOnComplete: 1000,
            removeOnFail: 5000
          }
        ),
        750,
        "embedding enqueue timed out"
      );
      return { queued: true, inline: false, jobId: job.id };
    } catch (error) {
      app.log.warn(
        { sourceType, sourceId, error: String(error) },
        "could not enqueue embedding job"
      );
      return { queued: false, inline: false, reason: String(error) };
    }
  };

  const enqueueCompaction = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    visibility: Visibility,
    teamId?: string
  ): Promise<MemoryJobStatus> => {
    if (options.runMemoryJobsInlineForTests) {
      const compaction = await runCompactionInline(
        repo,
        requesterContext,
        visibility,
        teamId
      );
      return { queued: false, inline: true, compaction };
    }

    if (!compactionQueue) {
      app.log.warn(
        { userId: requesterContext.userId, visibility, teamId },
        "compaction queue is unavailable"
      );
      return {
        queued: false,
        inline: false,
        reason: "compaction queue is unavailable"
      };
    }

    try {
      const job = await withTimeout(
        compactionQueue.add(
          "compact-scope",
          { userId: requesterContext.userId, visibility, teamId },
          {
            attempts: 5,
            backoff: { type: "exponential", delay: 10_000 },
            removeOnComplete: 1000,
            removeOnFail: 5000
          }
        ),
        750,
        "compaction enqueue timed out"
      );
      return { queued: true, inline: false, jobId: job.id };
    } catch (error) {
      app.log.warn(
        {
          userId: requesterContext.userId,
          visibility,
          teamId,
          error: String(error)
        },
        "could not enqueue compaction job"
      );
      return { queued: false, inline: false, reason: String(error) };
    }
  };

  const scheduleMemoryEventProcessing = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    eventId: string,
    visibility: Visibility,
    teamId?: string
  ) => {
    const [embedding, compaction] = await Promise.all([
      enqueueEmbedding("memory_event", eventId),
      enqueueCompaction(repo, requesterContext, visibility, teamId)
    ]);

    return { embedding, compaction };
  };

  const resolveCapturePolicyForRequest = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    input: { workspaceId?: string; sessionId?: string; threadId?: string }
  ) =>
    repo.getEffectiveCapturePolicy(requesterContext, {
      projectId: input.workspaceId,
      threadId: input.threadId,
      sessionId: input.sessionId
    });

  const rateLimit =
    (name: RateLimitName) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const policy = rateLimits[name];
      const authorization = request.headers.authorization;
      const keyMaterial = authorization
        ? hashSecret(authorization)
        : request.ip;
      const key = `${name}:${keyMaterial}`;
      const now = Date.now();
      const current = rateLimitBuckets.get(key);
      const bucket =
        !current || current.resetAt <= now
          ? { count: 0, resetAt: now + policy.windowMs }
          : current;

      bucket.count += 1;
      rateLimitBuckets.set(key, bucket);
      reply.header("x-ratelimit-limit", String(policy.max));
      reply.header(
        "x-ratelimit-remaining",
        String(Math.max(0, policy.max - bucket.count))
      );
      reply.header(
        "x-ratelimit-reset",
        String(Math.ceil(bucket.resetAt / 1000))
      );

      if (bucket.count > policy.max) {
        throw Object.assign(new Error("Rate limit exceeded"), {
          statusCode: 429
        });
      }
    };

  const authRateLimit = rateLimit("auth");
  const memoryRateLimit = rateLimit("memory");

  app.setErrorHandler((error, request, reply) => {
    const statusCodeCandidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const zodError = error instanceof z.ZodError;
    const message = zodError
      ? "Invalid request payload"
      : error instanceof Error
        ? error.message
        : String(error);
    const domainStatusCode =
      message === "Team visibility requires a teamId" ||
      message === "Invalid invite code"
        ? 400
        : message.includes("not an active member")
          ? 403
          : message.includes("not found or not visible")
            ? 404
            : undefined;
    const statusCode =
      typeof statusCodeCandidate === "number"
        ? statusCodeCandidate
        : domainStatusCode
          ? domainStatusCode
          : zodError
            ? 400
            : 500;

    request.log.warn(
      {
        statusCode,
        route: request.routeOptions.url,
        method: request.method,
        errorName: error instanceof Error ? error.name : "Error"
      },
      "request failed"
    );

    reply.status(statusCode).send({
      error: statusCode === 500 ? "Internal Server Error" : message
    });
  });

  app.get("/health", async (_request, reply) =>
    reply.type("text/plain").send("OK")
  );

  app.get("/ready", async (_request, reply) => {
    const checks = [createHealth("api")];
    const repo = repository;

    if (repo) {
      try {
        checks.push(
          createHealth("postgres", (await repo.health()) ? "ok" : "error")
        );
      } catch (error) {
        checks.push(
          createHealth("postgres", "error", { message: String(error) })
        );
      }
    } else if (process.env.DATABASE_URL) {
      checks.push(
        createHealth("postgres", "error", {
          message: "Database repository is not configured"
        })
      );
    }

    if (process.env.REDIS_URL) {
      const redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1
      });
      try {
        await redis.connect();
        await redis.ping();
        checks.push(createHealth("redis"));
      } catch (error) {
        checks.push(createHealth("redis", "error", { message: String(error) }));
      } finally {
        redis.disconnect();
      }
    }

    if (repo) {
      try {
        const status = await repo.getLocalEmbeddingStatus();
        checks.push(
          createHealth(
            "embedding-service",
            status.healthy ? "ok" : "degraded",
            {
              enabled: status.enabled,
              model: status.model,
              dimensions: status.dimensions,
              error: status.error
            }
          )
        );
      } catch (error) {
        checks.push(
          createHealth("embedding-service", "error", { message: String(error) })
        );
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

  app.get("/health/details", async () => {
    const checks = [createHealth("api")];

    if (process.env.DATABASE_URL) {
      const pool = createDbPool();
      try {
        await pool.query("select 1");
        checks.push(createHealth("postgres"));
      } catch (error) {
        checks.push(
          createHealth("postgres", "error", { message: String(error) })
        );
      } finally {
        await pool.end();
      }
    }

    if (process.env.REDIS_URL) {
      const redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1
      });
      try {
        await redis.connect();
        await redis.ping();
        checks.push(createHealth("redis"));
      } catch (error) {
        checks.push(createHealth("redis", "error", { message: String(error) }));
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

  app.get("/self-host/status", async () => {
    const repo = requireRepository();
    const [ready, embedding, embeddingJobs, compactionJobs] = await Promise.all(
      [
        repo.health().catch(() => false),
        repo.getLocalEmbeddingStatus().catch((error) => ({
          enabled: true,
          healthy: false,
          model: null,
          dimensions: null,
          error: String(error)
        })),
        embeddingQueue
          ?.getJobCounts("waiting", "active", "delayed", "failed")
          .catch((error) => ({ error: String(error) })),
        compactionQueue
          ?.getJobCounts("waiting", "active", "delayed", "failed")
          .catch((error) => ({ error: String(error) }))
      ]
    );

    return {
      status: ready ? "ok" : "error",
      components: {
        api: { status: "ok" },
        postgres: { status: ready ? "ok" : "error" },
        redis: {
          status: process.env.REDIS_URL ? "configured" : "not_configured"
        },
        embeddingService: embedding,
        workerQueues: {
          embedding: embeddingJobs ?? { status: "not_configured" },
          compaction: compactionJobs ?? { status: "not_configured" }
        }
      },
      configuration: {
        supportedClients: ["codex"],
        plannedClients: ["claude", "gemini", "cursor", "pi"],
        localRepositoryPath: process.env.KOED_HOST_CHECKOUT_PATH ?? null,
        embeddingModel: process.env.EMBEDDING_MODEL ?? embedding.model,
        embeddingDimensions:
          Number(process.env.EMBEDDING_DIMENSIONS ?? embedding.dimensions) ||
          null,
        rerankingEnabled: process.env.RERANKING_ENABLED === "true"
      }
    };
  });

  app.get("/self-host/diagnostics", async (request) => {
    const repo = requireRepository();
    const user = await authenticate(request);
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
        nodeEnv: process.env.NODE_ENV ?? null,
        apiPort: process.env.API_PORT ?? null,
        databaseConfigured: Boolean(process.env.DATABASE_URL),
        redisConfigured: Boolean(process.env.REDIS_URL),
        dataEncryptionKeyConfigured: Boolean(process.env.DATA_ENCRYPTION_KEY),
        apiTokenPepperConfigured: Boolean(process.env.API_TOKEN_PEPPER)
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
    const user = await authenticate(request);
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

  app.get("/auth/setup-status", async () => {
    const repo = requireRepository();
    const userCount = await repo.countUsers();
    return {
      configured: userCount > 0,
      authMode: "first_run_local_admin"
    };
  });

  app.post(
    "/auth/setup",
    { preHandler: authRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      if ((await repo.countUsers()) > 0) {
        return reply
          .status(409)
          .send({ error: "Initial admin already exists" });
      }
      const input = registerSchema.parse(request.body);
      const passwordHash = await argon2.hash(input.password, {
        type: argon2.argon2id
      });
      const created = await repo.createUser({
        email: input.email,
        displayName: input.displayName,
        passwordHash
      });
      const user = await repo.getUser(created.id);

      const sessionSecret = createOpaqueSecret("cms");
      await repo.createSession(
        created.id,
        hashSecret(sessionSecret),
        new Date(Date.now() + sessionTtlMs)
      );
      setSessionCookie(reply, sessionSecret);

      return { user: publicUser(user!) };
    }
  );

  app.post(
    "/auth/register",
    { preHandler: authRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const userCount = await repo.countUsers();
      if (
        userCount > 0 &&
        process.env.KOED_ALLOW_PUBLIC_REGISTRATION !== "true"
      ) {
        return reply.status(410).send({
          error:
            "Public registration is disabled in the self-hosted distribution. Use /auth/setup for the first local admin."
        });
      }

      const input = registerSchema.parse(request.body);
      const passwordHash = await argon2.hash(input.password, {
        type: argon2.argon2id
      });
      const created = await repo.createUser({
        email: input.email,
        displayName: input.displayName,
        passwordHash
      });
      const user = await repo.getUser(created.id);

      const sessionSecret = createOpaqueSecret("cms");
      await repo.createSession(
        created.id,
        hashSecret(sessionSecret),
        new Date(Date.now() + sessionTtlMs)
      );
      setSessionCookie(reply, sessionSecret);

      return { user: publicUser(user!) };
    }
  );

  app.post(
    "/auth/login",
    { preHandler: authRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const input = loginSchema.parse(request.body);
      const user = await repo.findUserByEmail(input.email);

      if (
        !user?.passwordHash ||
        !(await argon2.verify(user.passwordHash, input.password))
      ) {
        return reply.status(401).send({ error: "Invalid email or password" });
      }

      const sessionSecret = createOpaqueSecret("cms");
      await repo.createSession(
        user.id,
        hashSecret(sessionSecret),
        new Date(Date.now() + sessionTtlMs)
      );
      setSessionCookie(reply, sessionSecret);

      return { user: publicUser(user) };
    }
  );

  app.post("/auth/logout", async (request, reply) => {
    const repo = requireRepository();
    const sessionSecret = request.cookies[sessionCookieName];
    if (sessionSecret) {
      await repo.revokeSession(hashSecret(sessionSecret));
    }

    reply.clearCookie(sessionCookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (request) => {
    const repo = requireRepository();
    const user = await authenticate(request);
    const currentTeam = await repo.getCurrentTeam(user.id);

    return {
      user: publicUser(user),
      currentTeam
    };
  });

  app.post("/teams", async (request) => {
    const repo = requireRepository();
    const user = await authenticate(request);
    const input = createTeamSchema.parse(request.body);
    const team = await repo.createTeam({
      name: input.name,
      createdByUserId: user.id,
      inviteCode: createInviteCode()
    });

    return { team: await repo.getCurrentTeam(user.id), teamId: team.id };
  });

  app.post("/teams/join", async (request) => {
    const repo = requireRepository();
    const user = await authenticate(request);
    const input = joinTeamSchema.parse(request.body);
    const team = await repo.joinTeamByInviteCode(user.id, input.inviteCode);

    return { team };
  });

  app.get("/teams/current", async (request) => {
    const repo = requireRepository();
    const user = await authenticate(request);

    return { team: await repo.getCurrentTeam(user.id) };
  });

  app.get("/teams/current/members", async (request) => {
    const repo = requireRepository();
    const user = await authenticate(request);
    const currentTeam = await repo.getCurrentTeam(user.id);
    if (!currentTeam) {
      return { members: [] };
    }

    return { members: await repo.listTeamMembers(user.id, currentTeam.id) };
  });

  app.post("/api-tokens", { preHandler: authRateLimit }, async (request) => {
    const repo = requireRepository();
    const user = await authenticate(request);
    const input = createApiTokenSchema.parse(request.body);
    const token = createOpaqueSecret("cmt");
    const record = await repo.createApiToken({
      ownerUserId: user.id,
      teamId: input.teamId,
      name: input.name,
      tokenHash: hashSecret(token),
      tokenPrefix: token.slice(0, 12),
      scopes: input.scopes
    });

    return { token, apiToken: record };
  });

  app.get("/api-tokens", async (request) => {
    const repo = requireRepository();
    const user = await authenticate(request);

    return { apiTokens: await repo.listApiTokens(user.id) };
  });

  app.delete("/api-tokens/:id", async (request, reply) => {
    const repo = requireRepository();
    const user = await authenticate(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await repo.revokeApiToken(user.id, params.id);

    return reply.status(deleted ? 200 : 404).send({ ok: deleted });
  });

  app.get(
    "/v1/access/check",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const currentTeam = await repo.getCurrentTeam(user.id);

      return {
        ok: true,
        auth: "bearer_api_token",
        user: publicUser(user),
        currentTeam,
        canWritePersonal: true,
        canWriteTeam: false,
        providerConfigSupported: false,
        embeddingRetrieval: await repo.getLocalEmbeddingStatus()
      };
    }
  );

  app.get(
    "/v1/capture-policy/effective",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = effectivePolicyQuerySchema.parse(request.query);
      return {
        policy: await repo.getEffectiveCapturePolicy({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/capture-policies",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = z
        .object({
          targetType: z.enum(["global", "project", "thread"]).optional()
        })
        .parse(request.query);
      return {
        policies: await repo.listCapturePolicies(
          { userId: user.id },
          query.targetType
        )
      };
    }
  );

  app.put(
    "/v1/capture-policies",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = capturePolicySchema.parse(request.body);
      return {
        policy: await repo.upsertCapturePolicy({ userId: user.id }, input)
      };
    }
  );

  app.post("/v1/sessions", { preHandler: memoryRateLimit }, async (request) => {
    const repo = requireRepository();
    const user = await authenticateApiToken(request);
    const input = createMcpSessionSchema.parse(request.body);
    const policy = await resolveCapturePolicyForRequest(
      repo,
      { userId: user.id },
      {
        workspaceId: input.cwd ?? input.workspaceId,
        threadId: input.externalSessionId
      }
    );
    if (policy.captureState !== "enabled") {
      return { skipped: true, reason: "capture_disabled", policy };
    }
    const session = await repo.createCapturedSession(
      { userId: user.id },
      input
    );

    return { session, policy };
  });

  app.post(
    "/v1/sessions/:sessionId/events",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = sessionIdParamsSchema.parse(request.params);
      const input = mcpSessionEventSchema.parse(request.body);
      const requesterContext = { userId: user.id };
      const policy = await resolveCapturePolicyForRequest(
        repo,
        requesterContext,
        { workspaceId: input.workspaceId, sessionId: params.sessionId }
      );
      if (policy.captureState !== "enabled") {
        return { skipped: true, reason: "capture_disabled", policy };
      }
      const teamId =
        policy.visibility === "team"
          ? (await repo.getCurrentTeam(user.id))?.id
          : undefined;
      const event = await capturePersonalEvent({
        repository: repo,
        requesterContext,
        workspaceId: input.workspaceId,
        sessionId: params.sessionId,
        turnId: input.turnId,
        actor: input.actor,
        eventType: input.eventType,
        content: input.content,
        metadata: input.metadata,
        visibility: policy.visibility,
        teamId
      });
      const processing = await scheduleMemoryEventProcessing(
        repo,
        requesterContext,
        event.id,
        policy.visibility,
        teamId
      );

      return {
        event,
        policy,
        processing,
        compaction: processing.compaction.compaction
      };
    }
  );

  app.post(
    "/v1/memory/capture-personal-event",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = capturePersonalEventSchema.parse(request.body);
      const requesterContext = { userId: user.id };
      const policy = await resolveCapturePolicyForRequest(
        repo,
        requesterContext,
        {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          threadId:
            typeof input.metadata.externalSessionId === "string"
              ? input.metadata.externalSessionId
              : undefined
        }
      );
      if (policy.captureState !== "enabled") {
        return { skipped: true, reason: "capture_disabled", policy };
      }
      const event = await capturePersonalEvent({
        repository: repo,
        requesterContext,
        ...input,
        visibility: policy.visibility,
        teamId:
          policy.visibility === "team"
            ? (await repo.getCurrentTeam(user.id))?.id
            : undefined
      });
      const processing = await scheduleMemoryEventProcessing(
        repo,
        requesterContext,
        event.id,
        policy.visibility,
        policy.visibility === "team"
          ? (await repo.getCurrentTeam(user.id))?.id
          : undefined
      );

      return {
        event,
        policy,
        processing,
        compaction: processing.compaction.compaction
      };
    }
  );

  app.get(
    "/v1/memory/clusters",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = memoryClusterQuerySchema.parse(request.query);
      reply.header("deprecation", "true");
      reply.header("x-koed-deprecated", "Use /v1/memory/graph/nodes");
      return {
        clusters: await repo.listMemoryClusters({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/memory/clusters/:clusterId/memories",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = clusterIdParamsSchema.parse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().positive().max(100).default(100)
        })
        .parse(request.query);
      reply.header("deprecation", "true");
      reply.header("x-koed-deprecated", "Use /v1/memory/graph/nodes");
      return {
        memories: await repo.listMemoriesInCluster(
          { userId: user.id },
          params.clusterId,
          query
        )
      };
    }
  );

  app.get(
    "/v1/memory/items",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = memoryBrowserQuerySchema.parse(request.query);
      reply.header("deprecation", "true");
      reply.header("x-koed-deprecated", "Use /v1/memory/graph/nodes");
      return {
        memories: await repo.listMemoryBrowserItems({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/memory/graph/overview",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      return { overview: await repo.getLcmGraphOverview({ userId: user.id }) };
    }
  );

  app.get(
    "/v1/memory/graph/nodes",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = graphQuerySchema.parse(request.query);
      return {
        nodes: await repo.listLcmGraphNodes({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/memory/graph/nodes/:nodeId",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const query = graphEventDetailQuerySchema.parse(request.query);
      const node = await repo.getLcmGraphNode(
        { userId: user.id },
        params.nodeId,
        {
          includeInvalidated: query.includeInvalidated
        }
      );
      return node
        ? { node }
        : reply
            .status(404)
            .send({ error: "LCM node not found or not visible" });
    }
  );

  app.get(
    "/v1/memory/graph/events",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = graphQuerySchema.parse(request.query);
      return {
        events: await repo.listLcmGraphEvents({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/memory/graph/events/:eventId",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = graphEventParamsSchema.parse(request.params);
      const query = graphEventDetailQuerySchema.parse(request.query);
      const event = await repo.getLcmGraphEvent(
        { userId: user.id },
        params.eventId,
        query
      );
      return event
        ? { event }
        : reply
            .status(404)
            .send({ error: "Captured event not found or not visible" });
    }
  );

  app.patch(
    "/v1/memory/graph/events/:eventId",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = graphEventParamsSchema.parse(request.params);
      const input = graphEventPatchSchema.parse(request.body);
      const event = await repo.updateLcmGraphEvent(
        { userId: user.id },
        params.eventId,
        input
      );
      return event
        ? { event }
        : reply
            .status(404)
            .send({ error: "Captured event not found or not visible" });
    }
  );

  app.delete(
    "/v1/memory/graph/events/:eventId",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = graphEventParamsSchema.parse(request.params);
      const deleted = await repo.invalidateLcmGraphEvent(
        { userId: user.id },
        params.eventId
      );
      return reply.status(deleted ? 200 : 404).send({ ok: deleted });
    }
  );

  app.get(
    "/v1/memory/export",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      return await repo.exportMemoryRecords({ userId: user.id });
    }
  );

  app.post(
    "/v1/memory/search",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = searchMemorySchema.parse(request.body);
      const result = await searchMemory({
        repository: repo,
        requesterContext: { userId: user.id },
        query: input.query,
        scope: input.retrieval_scope,
        searchDomain: input.search_domain,
        sessionId: input.session_id,
        workspaceId: input.workspace_id,
        limit: input.limit
      });

      return {
        hits: result.results,
        rawHitsCount: result.results.length,
        lcmHitsCount: result.results.length,
        retrieval: result.metadata,
        retrievalMode: result.metadata.retrievalMode,
        vectorHitsCount: result.metadata.vectorHitsCount,
        textHitsCount: result.metadata.textHitsCount,
        embeddingModel: result.metadata.embeddingModel,
        embeddingDimensions: result.metadata.embeddingDimensions,
        vectorCandidateCount: result.metadata.vectorCandidateCount,
        rerankedCount: result.metadata.rerankedCount,
        rerankerModel: result.metadata.rerankerModel,
        rerankingEnabled: result.metadata.rerankingEnabled,
        rerankingUnavailable: result.metadata.rerankingUnavailable,
        rerankingError: result.metadata.rerankingError,
        visibilityLabels: [
          ...new Set(result.results.map((hit) => hit.visibility))
        ]
      };
    }
  );

  app.post(
    "/v1/memory/answer",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = searchMemorySchema.parse(request.body);
      const result = await answerMemory({
        repository: repo,
        requesterContext: { userId: user.id },
        query: input.query,
        scope: input.retrieval_scope,
        searchDomain: input.search_domain,
        sessionId: input.session_id,
        workspaceId: input.workspace_id,
        limit: input.limit
      });
      const expandedNodeIds = [
        ...new Set(
          result.citations
            .filter(
              (citation) =>
                !citation.sourceType || citation.sourceType === "memory_node"
            )
            .map((citation) => citation.nodeId)
        )
      ];
      const visibilityLabels = [
        ...new Set(result.citations.map((citation) => citation.visibility))
      ];

      return {
        markdown: result.answer,
        instructions: result.evidenceBundle.instructions,
        evidenceBundle: result.evidenceBundle,
        evidence: result.evidenceBundle.evidence,
        citations: result.citations,
        rawHitsCount: result.citations.length,
        lcmHitsCount: result.citations.length,
        retrieval: result.evidenceBundle.retrieval,
        retrievalMode: result.evidenceBundle.retrieval.retrievalMode,
        vectorHitsCount: result.evidenceBundle.retrieval.vectorHitsCount,
        textHitsCount: result.evidenceBundle.retrieval.textHitsCount,
        embeddingModel: result.evidenceBundle.retrieval.embeddingModel,
        embeddingDimensions:
          result.evidenceBundle.retrieval.embeddingDimensions,
        vectorCandidateCount:
          result.evidenceBundle.retrieval.vectorCandidateCount,
        rerankedCount: result.evidenceBundle.retrieval.rerankedCount,
        rerankerModel: result.evidenceBundle.retrieval.rerankerModel,
        rerankingEnabled: result.evidenceBundle.retrieval.rerankingEnabled,
        rerankingUnavailable:
          result.evidenceBundle.retrieval.rerankingUnavailable,
        rerankingError: result.evidenceBundle.retrieval.rerankingError,
        expandedNodeIds,
        visibilityLabels,
        memoryIndexVersion: "lcm-depth0-contiguous-v1",
        lcmVersion: "depth0-contiguous-v1"
      };
    }
  );

  app.get(
    "/v1/memory/lcm/summaries/pending",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = lcmPendingSummariesQuerySchema.parse(request.query);
      const nodes = await repo.listLcmNodesNeedingSummaries(
        { userId: user.id },
        { limit: query.limit }
      );

      return {
        nodes,
        count: nodes.length,
        localOnly: true,
        instructions:
          "Run LCM summarisation locally through the user's Codex subscription, then submit each summary back to /v1/memory/lcm/summaries/{nodeId}. Backend workers do not call LLMs for LCM summaries."
      };
    }
  );

  app.post(
    "/v1/memory/lcm/summaries/:nodeId",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const input = submitLcmSummarySchema.parse(request.body);
      const node = await repo.getVisibleLcmNodeForSummarization(
        { userId: user.id },
        params.nodeId
      );
      if (!node) {
        return reply
          .status(404)
          .send({ error: "LCM node not found or not visible" });
      }

      await repo.updateLcmNodeSummary({
        nodeId: params.nodeId,
        summaryText: input.summaryText,
        summaryModel: input.summaryModel,
        summaryPromptVersion: input.summaryPromptVersion,
        summaryTokenEstimate: input.summaryTokenEstimate
      });
      const embedding = await enqueueEmbedding("memory_node", params.nodeId);

      return {
        nodeId: params.nodeId,
        kind: node.kind,
        depth: node.depth,
        summaryModel: input.summaryModel,
        summaryPromptVersion: input.summaryPromptVersion,
        summaryTokenEstimate: input.summaryTokenEstimate,
        embedding
      };
    }
  );

  app.get(
    "/v1/memory/nodes/:nodeId",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const node = await repo.getLcmGraphNode(
        { userId: user.id },
        params.nodeId
      );

      return node
        ? { node }
        : reply
            .status(404)
            .send({ error: "Memory node not found or not visible" });
    }
  );

  app.patch(
    "/v1/memory/nodes/:nodeId",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const input = updateMemorySchema.parse(request.body);
      const node =
        input.summaryText !== undefined || input.visibility !== undefined
          ? await repo.updateLcmGraphNode({ userId: user.id }, params.nodeId, {
              summaryText: input.summaryText,
              visibility: input.visibility
            })
          : null;
      const memory =
        input.pinned !== undefined
          ? await repo.updateMemoryPresentation(
              { userId: user.id },
              params.nodeId,
              { pinned: input.pinned }
            )
          : null;
      const result = node ?? memory;
      return result
        ? { node: node ?? undefined, memory: memory ?? undefined }
        : reply
            .status(404)
            .send({ error: "Memory node not found or not visible" });
    }
  );

  app.delete(
    "/v1/memory/nodes/:nodeId",
    { preHandler: memoryRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const deleted = await repo.invalidateLcmGraphNode(
        { userId: user.id },
        params.nodeId
      );
      return reply.status(deleted ? 200 : 404).send({ ok: deleted });
    }
  );

  app.get(
    "/v1/memory/nodes/:nodeId/expand",
    { preHandler: memoryRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = nodeIdParamsSchema.parse(request.params);
      const expanded = await repo.expandMemoryNode(params.nodeId, {
        userId: user.id
      });

      return { expanded };
    }
  );

  return app;
};
