import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";
import { type Visibility } from "@koed/core";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  type MemorySourceRepository
} from "@koed/db";
import {
  createAuthHelpers,
  createHashSecret,
  registerAuthRoutes,
  sessionCookieName
} from "../auth/index.js";
import { registerAnalyticsRoutes } from "../analytics/index.js";
import {
  createWorkosAuthKitClient,
  type WorkosAuthKitClient
} from "../auth/workos.js";
import { registerApiTokenRoutes } from "../api-tokens/index.js";
import {
  type CacheProvider,
  createRateLimitHandlers,
  MemoryRateLimitStore,
  NoopCacheProvider,
  RedisCacheProvider,
  RedisRateLimitStore,
  resetMemoryRateLimitStore,
  type RateLimitStore
} from "../infra/index.js";
import { registerLocalEdgeRoutes } from "../local-edge/routes.js";
import {
  canReceiveGraphStreamPayload,
  createGraphStreamService,
  createMemoryJobQueue,
  createMemoryJobScheduler,
  graphUpdateActionForPayload,
  registerCaptureRoutes,
  registerGraphRoutes,
  registerLocalAgentSettingsRoutes,
  registerLcmRoutes,
  registerQuestionRoutes,
  registerRawConversationRoutes,
  registerRecallRoutes,
  shouldIgnoreGraphStreamPayload
} from "../memory/index.js";
import {
  createEnvelopeEncryptionProviderFromEnvironment,
  type EnvelopeEncryptionProvider,
  lcmCompactQueueName,
  memoryEmbedQueueName
} from "@koed/shared";
import { registerTeamRoutes } from "../team/index.js";
import { resolveApiServerConfig } from "./config.js";
import {
  apiLogSchemaVersion,
  apiServiceName,
  authenticatedRequestLogContext,
  formatApiLogBindings,
  getRequestLogContext,
  resolveRequestId,
  sanitizeZodIssues,
  serializeApiRequest,
  setRequestLogContext
} from "./logging.js";
import { registerOperationalRoutes } from "./operational-routes.js";
import type { ApiRouteContext } from "./context.js";

export {
  canReceiveGraphStreamPayload,
  graphUpdateActionForPayload,
  shouldIgnoreGraphStreamPayload
};

interface BuildServerOptions {
  repository?: MemorySourceRepository;
  runMemoryJobsInlineForTests?: boolean;
  rateLimitStore?: RateLimitStore;
  cacheProvider?: CacheProvider;
  upstreamBackendsPath?: string;
  fetch?: typeof fetch;
  resolveUpstreamAuthorization?: ApiRouteContext["localEdge"]["resolveUpstreamAuthorization"];
  workosClient?: WorkosAuthKitClient;
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, "");

const originFromReferer = (referer: string | undefined): string | null => {
  if (!referer) {
    return null;
  }
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
};

const sessionEstablishingWritePaths = new Set([
  "/auth/setup",
  "/auth/register",
  "/auth/login",
  "/v1/team-invites/accept"
]);

const requestPathname = (request: FastifyRequest): string => {
  try {
    return new URL(request.url, "http://koed.local").pathname;
  } catch {
    return request.url.split("?")[0] ?? request.url;
  }
};

const upstreamCredentialEnvironmentName = (backendId: string): string =>
  `KOED_UPSTREAM_CREDENTIAL_${backendId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;

const normalizeUpstreamAuthorization = (
  value: string | undefined
): string | null => {
  const trimmed = value?.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    return null;
  }
  if (/^(?:Bearer|Koed-Device)\s+\S+/i.test(trimmed)) {
    return trimmed;
  }
  return `Koed-Device ${trimmed}`;
};

const defaultResolveUpstreamAuthorization: ApiRouteContext["localEdge"]["resolveUpstreamAuthorization"] =
  (backend) => {
    if (backend.credential?.status !== "configured") {
      return null;
    }
    const reference = backend.credential.reference?.trim();
    return normalizeUpstreamAuthorization(
      reference
        ? process.env[reference]
        : process.env[upstreamCredentialEnvironmentName(backend.id)]
    );
  };

export const buildServer = async (options: BuildServerOptions = {}) => {
  const config = resolveApiServerConfig();

  if (config.test) {
    resetMemoryRateLimitStore();
  }

  const app = Fastify({
    genReqId: (request) => resolveRequestId(request.headers["x-request-id"]),
    requestIdHeader: "x-request-id",
    logger: config.test
      ? false
      : {
          level: config.logLevel,
          base: {
            schema_version: apiLogSchemaVersion,
            service: apiServiceName,
            env: config.nodeEnv
          },
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie",
            "request.headers.authorization",
            "request.headers.cookie",
            "response.headers.set-cookie"
          ],
          serializers: {
            req: serializeApiRequest
          },
          formatters: {
            log: formatApiLogBindings
          }
        },
    bodyLimit: config.requestBodyLimitBytes
  });

  const pool =
    options.repository || !config.databaseUrl ? null : createDbPool();
  if (pool) {
    await runDbMigrations(pool);
  }
  const envelopeEncryptionProvider: EnvelopeEncryptionProvider | undefined =
    options.envelopeEncryptionProvider ??
    createEnvelopeEncryptionProviderFromEnvironment();
  const repository =
    options.repository ??
    (pool
      ? createMemorySourceRepository(pool, {
          envelopeEncryptionProvider
        })
      : null);
  const createQueue = <TJobData>(name: string) =>
    createMemoryJobQueue<TJobData>(name, {
      backend: config.queueBackend,
      redisUrl: config.redisUrl,
      pool
    });
  const embeddingQueue = createQueue<{
    sourceType: "memory_node" | "memory_event" | "message";
    sourceId: string;
  }>(memoryEmbedQueueName);
  const compactionQueue = createQueue<{
    userId: string;
    visibility: Visibility;
  }>(lcmCompactQueueName);
  const rateLimitRedis =
    !options.rateLimitStore &&
    config.rateLimit.store === "redis" &&
    config.rateLimit.redisUrl
      ? new Redis(config.rateLimit.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: null
        })
      : null;
  const cacheRedis =
    !options.cacheProvider &&
    config.cache.store === "redis" &&
    config.cache.redisUrl
      ? new Redis(config.cache.redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: null
        })
      : null;
  const rateLimitStore: RateLimitStore =
    options.rateLimitStore ??
    (rateLimitRedis
      ? new RedisRateLimitStore(rateLimitRedis)
      : new MemoryRateLimitStore());
  const cacheProvider: CacheProvider =
    options.cacheProvider ??
    (cacheRedis ? new RedisCacheProvider(cacheRedis) : new NoopCacheProvider());
  let graphStreamService: { registerRoutes(): void; close(): void } | null =
    null;
  const hashSecret = createHashSecret(config.apiTokenPepper);
  const rateLimitHandlers = createRateLimitHandlers(
    rateLimitStore,
    hashSecret,
    config.rateLimit.policies
  );

  app.addHook("onClose", async () => {
    graphStreamService?.close();
    await Promise.all([
      embeddingQueue?.close(),
      compactionQueue?.close(),
      rateLimitStore.close?.(),
      cacheProvider.close?.()
    ]);
    await pool?.end();
  });
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    done();
  });

  const corsOrigins = config.corsOrigins;
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || corsOrigins.has(normalizeOrigin(origin))) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    preflight: true,
    credentials: true
  });

  await app.register(cookie);
  app.addHook("preHandler", (request, _reply, done) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      done();
      return;
    }
    const hasSessionCookie = Boolean(request.cookies[sessionCookieName]);
    const createsSessionCookie = sessionEstablishingWritePaths.has(
      requestPathname(request)
    );
    if (!hasSessionCookie && !createsSessionCookie) {
      done();
      return;
    }
    const requestOrigin =
      request.headers.origin ?? originFromReferer(request.headers.referer);
    if (requestOrigin && !corsOrigins.has(normalizeOrigin(requestOrigin))) {
      done(
        Object.assign(new Error("Invalid request origin"), {
          statusCode: 403
        })
      );
      return;
    }
    done();
  });
  const requireRepository = (): MemorySourceRepository => {
    if (!repository) {
      throw Object.assign(new Error("Database is not configured"), {
        statusCode: 503
      });
    }

    return repository;
  };
  const authHelpers = createAuthHelpers(requireRepository, {
    hashSecret,
    cookieSecure: config.cookieSecure,
    recordAuthContext: (request, authContext) =>
      setRequestLogContext(
        request,
        authenticatedRequestLogContext(authContext.kind, authContext.userId)
      )
  });
  const {
    runCompactionInline,
    enqueueEmbedding,
    scheduleMemoryEventProcessing,
    scheduleProjectedMemoryEventProcessing
  } = createMemoryJobScheduler({
    embeddingQueue,
    compactionQueue,
    runMemoryJobsInlineForTests: options.runMemoryJobsInlineForTests,
    log: app.log
  });

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

  const rejectUnsupportedCapturePolicy = (policy: {
    visibility: Visibility;
  }) => {
    if (policy.visibility !== "personal") {
      throw Object.assign(
        new Error(
          "Only personal capture visibility is supported in this build"
        ),
        { statusCode: 400 }
      );
    }
  };

  const routeContext = {
    config,
    requireRepository,
    auth: authHelpers,
    rateLimit: rateLimitHandlers,
    jobs: {
      enqueueEmbedding
    },
    graph: {
      cacheProvider,
      graphCacheTtlSeconds: config.cache.graphCacheTtlSeconds,
      hashCacheKey: hashSecret
    },
    encryption: {
      envelopeEncryptionProvider
    },
    capture: {
      scheduleMemoryEventProcessing,
      scheduleProjectedMemoryEventProcessing,
      resolveCapturePolicyForRequest,
      rejectUnsupportedCapturePolicy
    },
    localEdge: {
      upstreamBackendsPath:
        options.upstreamBackendsPath ?? config.upstreamBackendsPath,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      resolveUpstreamAuthorization:
        options.resolveUpstreamAuthorization ??
        defaultResolveUpstreamAuthorization
    },
    workos: {
      client:
        options.workosClient ??
        createWorkosAuthKitClient(config.workos, options.fetch)
    }
  };
  graphStreamService = await createGraphStreamService({
    app,
    auth: authHelpers,
    pool,
    cacheProvider,
    corsOrigins,
    graphUpdateDebounceMs: config.graph.updateDebounceMs,
    memoryEventGraphUpdateDebounceMs: config.graph.memoryEventUpdateDebounceMs
  });

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
      message === "Invalid invite code"
        ? 400
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

    const logBindings = {
      event: {
        name: "http.request.failed",
        category: "http"
      },
      request: {
        id: request.id,
        method: request.method,
        path: requestPathname(request),
        route: request.routeOptions.url
      },
      http: {
        status_code: statusCode
      },
      ...getRequestLogContext(request),
      error_name: error instanceof Error ? error.name : "Error",
      ...(zodError ? { validation_issues: sanitizeZodIssues(error) } : {})
    };

    if (statusCode >= 500) {
      request.log.error({ ...logBindings, err: error }, "request failed");
    } else {
      request.log.warn(logBindings, "request failed");
    }

    reply.status(statusCode).send({
      error: statusCode === 500 ? "Internal Server Error" : message
    });
  });

  registerOperationalRoutes(app, routeContext, {
    dbPool: pool,
    repository,
    embeddingQueue,
    compactionQueue,
    envelopeEncryptionProvider,
    alertFetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    runCompactionInline,
    enqueueEmbedding
  });

  registerAuthRoutes(app, routeContext);
  registerAnalyticsRoutes(app, routeContext);
  registerApiTokenRoutes(app, routeContext);
  registerTeamRoutes(app, routeContext);
  registerLocalEdgeRoutes(app, routeContext);
  registerCaptureRoutes(app, routeContext);
  registerRawConversationRoutes(app, routeContext);
  registerRecallRoutes(app, routeContext);
  registerLocalAgentSettingsRoutes(app, routeContext);
  registerQuestionRoutes(app, routeContext);
  registerLcmRoutes(app, routeContext);
  registerGraphRoutes(app, routeContext);
  graphStreamService.registerRoutes();

  return app;
};
