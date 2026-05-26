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
import {
  createHealth,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig
} from "@koed/shared";

const sessionCookieName = "cm_session";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;

interface BuildServerOptions {
  repository?: MemorySourceRepository;
  runMemoryJobsInlineForTests?: boolean;
  rateLimitStore?: RateLimitStore;
  cacheProvider?: CacheProvider;
}

type RateLimitName = "auth" | "memoryRead" | "memoryWrite" | "memoryRecall";
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

export interface GraphUpdatePayload {
  table?: string;
  operation?: string;
  id?: string | null;
  eventRefs?: GraphUpdateEventRef[];
  eventIds?: string[];
  questionIds?: string[];
  ownerUserId?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  threadId?: string | null;
  visibility?: "personal" | "team" | string | null;
  changedAt?: string;
  coalesced?: boolean;
}

interface GraphUpdateEventRef {
  id: string;
  projectId: string;
  threadId: string;
}

interface GraphStreamClient {
  userId: string;
  reply: FastifyReply;
}

export const shouldIgnoreGraphStreamPayload = (
  payload: GraphUpdatePayload
): boolean => payload.table === "memory_embeddings";

export const graphUpdateActionForPayload = (payload: GraphUpdatePayload) => ({
  broadcast: !shouldIgnoreGraphStreamPayload(payload),
  invalidateCache: payload.table !== "memory_questions"
});

export const canReceiveGraphStreamPayload = async (
  client: { userId: string },
  payload: GraphUpdatePayload,
  isTeamMember: (userId: string, teamId: string) => Promise<boolean>
): Promise<boolean> => {
  if (payload.visibility === "personal") {
    return Boolean(
      payload.ownerUserId && payload.ownerUserId === client.userId
    );
  }
  if (payload.visibility === "team") {
    return Boolean(
      payload.teamId && (await isTeamMember(client.userId, payload.teamId))
    );
  }
  return true;
};

interface GraphListenClient {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    callback: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", callback: (error: unknown) => void): void;
  release(): void;
}

interface RateLimitStore {
  increment(
    key: string,
    windowMs: number
  ): Promise<{ count: number; resetAt: number }>;
  close?(): Promise<void>;
}

interface CacheProvider {
  getJson<T>(key: string): Promise<T | null>;
  setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
  close?(): Promise<void>;
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
  const configured = [
    ...parseCsv(process.env.CORS_ORIGINS),
    ...parseCsv(process.env.API_CORS_ORIGINS)
  ];
  const derived = [process.env.PUBLIC_APP_URL, process.env.API_BASE_URL].filter(
    (value): value is string => Boolean(value)
  );
  const development =
    process.env.NODE_ENV === "production"
      ? []
      : [
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:5174",
          "http://127.0.0.1:5174",
          "http://localhost:3000"
        ];
  return new Set(
    [...configured, ...derived, ...development].map((origin) =>
      origin.replace(/\/+$/, "")
    )
  );
};

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
  "/auth/login"
]);

const requestPathname = (request: FastifyRequest): string => {
  try {
    return new URL(request.url, "http://koed.local").pathname;
  } catch {
    return request.url.split("?")[0] ?? request.url;
  }
};

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

class MemoryRateLimitStore implements RateLimitStore {
  increment(key: string, windowMs: number) {
    const now = Date.now();
    const current = rateLimitBuckets.get(key);
    const bucket =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : current;
    bucket.count += 1;
    rateLimitBuckets.set(key, bucket);
    return Promise.resolve(bucket);
  }
}

class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, windowMs: number) {
    const redisKey = `koed:rate-limit:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.pexpire(redisKey, windowMs);
    }
    const ttl = await this.redis.pttl(redisKey);
    return {
      count,
      resetAt: Date.now() + (ttl > 0 ? ttl : windowMs)
    };
  }

  close() {
    this.redis.disconnect();
    return Promise.resolve();
  }
}

class NoopCacheProvider implements CacheProvider {
  getJson<T>(key: string): Promise<T | null> {
    void key;
    return Promise.resolve(null);
  }

  setJson<T>(key: string, value: T, ttlSeconds: number) {
    void key;
    void value;
    void ttlSeconds;
    return Promise.resolve();
  }

  deleteByPrefix(prefix: string) {
    void prefix;
    return Promise.resolve();
  }
}

class RedisCacheProvider implements CacheProvider {
  constructor(private readonly redis: Redis) {}

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number) {
    await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  async deleteByPrefix(prefix: string) {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        100
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  close() {
    this.redis.disconnect();
    return Promise.resolve();
  }
}

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

const createApiTokenSchema = z
  .object({
    name: z.string().min(1).max(120),
    teamId: z.string().uuid().optional(),
    scopes: z.array(z.string().min(1)).default([])
  })
  .superRefine((input, context) => {
    if (input.teamId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["teamId"],
        message: "Team-scoped API tokens are not supported in this build"
      });
    }
  });

const metadataSchema = z.record(z.string(), z.unknown()).default({});

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());

const captureStateSchema = z.enum(["enabled", "disabled", "ask"]);
const visibilitySchema = z.enum(["personal", "team"]);
const memoryActorSchema = z.enum([
  "user",
  "assistant",
  "agent",
  "subagent",
  "tool",
  "system"
]);

const createMcpSessionSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  externalSessionId: z.string().min(1).optional(),
  sourceRuntime: z.enum(["codex", "codex-cli"]).default("codex"),
  captureMethod: z.enum(["hook", "mcp", "web", "api"]).default("mcp"),
  model: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  codexTranscriptPath: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  sourceHash: z.string().min(1).optional(),
  metadata: metadataSchema
});

const mcpSessionEventSchema = z.object({
  workspaceId: z.string().min(1).default("default"),
  turnId: z.string().uuid().optional(),
  actor: memoryActorSchema,
  eventType: z.string().min(1).default("session_event"),
  content: z.string().min(1),
  metadata: metadataSchema
});

const capturePersonalEventSchema = z.object({
  workspaceId: z.string().min(1).default("default"),
  sessionId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
  actor: memoryActorSchema,
  eventType: z.string().min(1),
  content: z.string().min(1),
  metadata: metadataSchema,
  sourceRuntime: z.enum(["codex", "codex-cli"]).default("codex-cli"),
  captureMethod: z.enum(["hook", "mcp", "web", "api"]).default("hook"),
  codexTranscriptPath: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  sourceHash: z.string().min(1).optional()
});

const capturePolicySchema = z
  .object({
    targetType: z.enum(["global", "project", "thread"]),
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    projectPath: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    threadName: z.string().min(1).optional(),
    captureState: captureStateSchema.nullable().optional(),
    visibility: visibilitySchema.nullable().optional(),
    pauseUntil: z.string().datetime({ offset: true }).nullable().optional()
  })
  .superRefine((input, context) => {
    if (input.visibility === "team") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visibility"],
        message: "Team Memory capture policies are not supported in this build"
      });
    }
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
  pinned: queryBooleanSchema.optional(),
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
  includeInvalidated: queryBooleanSchema.default(false),
  limit: z.coerce.number().int().positive().max(500).default(100)
});

const graphNodesQuerySchema = graphQuerySchema.extend({
  ids: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().uuid()).max(100).optional())
});

const graphEventsQuerySchema = graphQuerySchema
  .extend({
    cursorTimestamp: z.string().datetime({ offset: true }).optional(),
    cursorId: z.string().uuid().optional(),
    includeContent: queryBooleanSchema.default(false),
    includeRaw: queryBooleanSchema.default(false)
  })
  .superRefine((input, context) => {
    if (Boolean(input.cursorTimestamp) !== Boolean(input.cursorId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cursorId"],
        message: "cursorTimestamp and cursorId must be provided together"
      });
    }
  });

const graphEventParamsSchema = z.object({ eventId: z.string().uuid() });

const graphEventDetailQuerySchema = z.object({
  includeInvalidated: queryBooleanSchema.default(false),
  includeRaw: queryBooleanSchema.default(false)
});

const graphEventPatchSchema = z.object({
  visibility: visibilitySchema.optional(),
  invalidated: z.boolean().optional()
});

const apiTokenRetrievalScopeInputSchema = z
  .enum(["personal", "personal+team"])
  .superRefine((scope, context) => {
    if (scope === "personal+team") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "personal+team retrieval is not supported for API-token integrations in this build"
      });
    }
  });
const retrievalScopeSchema = apiTokenRetrievalScopeInputSchema.transform(
  (): MemoryScope => "personal"
);
const memoryQuestionRetrievalScopeSchema =
  apiTokenRetrievalScopeInputSchema.transform((): "personal" => "personal");

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

const memoryQuestionSchema = z
  .object({
    query: z.string().min(1),
    retrieval_scope: memoryQuestionRetrievalScopeSchema.default("personal"),
    search_domain: searchDomainSchema.default("global"),
    workspace_id: z.string().min(1).optional(),
    project_name: z.string().min(1).optional(),
    project_path: z.string().min(1).optional(),
    session_id: z.string().uuid().optional(),
    thread_id: z.string().min(1).optional(),
    thread_name: z.string().min(1).optional()
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

const memoryQuestionsQuerySchema = z.object({
  query: z.string().min(1).optional(),
  search_domain: searchDomainSchema.optional(),
  status: z.enum(["pending", "answered", "error"]).optional(),
  workspace_id: z.string().min(1).optional(),
  session_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0)
});

const memoryQuestionParamsSchema = z.object({
  questionId: z.string().uuid()
});

const claimMemoryQuestionsSchema = z.object({
  question_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(10).default(1),
  lease_seconds: z.coerce.number().int().positive().max(3600).default(180)
});

const updateMemoryQuestionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("answered"),
    answer_markdown: z.string().min(1),
    attempt_count: z.number().int().positive().optional(),
    response: z.record(z.string(), z.unknown()).optional(),
    evidence: z.array(z.unknown()).optional(),
    citations: z.array(z.unknown()).optional(),
    retrieval: z.record(z.string(), z.unknown()).optional(),
    local_memory_worker: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    status: z.literal("error"),
    error_message: z.string().min(1),
    attempt_count: z.number().int().positive().optional(),
    response: z.record(z.string(), z.unknown()).optional(),
    retrieval: z.record(z.string(), z.unknown()).optional(),
    local_memory_worker: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    status: z.literal("pending"),
    last_error_message: z.string().min(1),
    attempt_count: z.number().int().positive().optional(),
    response: z.record(z.string(), z.unknown()).optional(),
    evidence: z.array(z.unknown()).optional(),
    citations: z.array(z.unknown()).optional(),
    retrieval: z.record(z.string(), z.unknown()).optional(),
    local_memory_worker: z.record(z.string(), z.unknown()).optional()
  })
]);

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
  ["GET", "/v1/memory/graph/threads"],
  ["GET", "/v1/memory/graph/events"],
  ["GET", "/v1/memory/graph/events/{eventId}"],
  ["PATCH", "/v1/memory/graph/events/{eventId}"],
  ["DELETE", "/v1/memory/graph/events/{eventId}"],
  ["GET", "/v1/memory/export"],
  ["GET", "/v1/memory/questions"],
  ["POST", "/v1/memory/questions"],
  ["POST", "/v1/memory/questions/claim-pending"],
  ["GET", "/v1/memory/questions/{questionId}"],
  ["PATCH", "/v1/memory/questions/{questionId}"],
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
  const rateLimitRedis =
    !options.rateLimitStore &&
    process.env.RATE_LIMIT_STORE === "redis" &&
    (process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL)
      ? new Redis(process.env.RATE_LIMIT_REDIS_URL ?? process.env.REDIS_URL!, {
          lazyConnect: true,
          maxRetriesPerRequest: null
        })
      : null;
  const cacheRedis =
    !options.cacheProvider &&
    process.env.CACHE_STORE === "redis" &&
    (process.env.CACHE_REDIS_URL || process.env.REDIS_URL)
      ? new Redis(process.env.CACHE_REDIS_URL ?? process.env.REDIS_URL!, {
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
  const graphCacheTtlSeconds = parsePositiveInt("GRAPH_CACHE_TTL_SECONDS", 5);
  const graphStreamClients = new Set<GraphStreamClient>();
  const graphUpdateDebounceMs = parsePositiveInt(
    "GRAPH_UPDATE_DEBOUNCE_MS",
    1_000
  );
  const memoryEventGraphUpdateDebounceMs = parsePositiveInt(
    "MEMORY_EVENT_GRAPH_UPDATE_DEBOUNCE_MS",
    Math.min(graphUpdateDebounceMs, 100)
  );
  const pendingGraphUpdates = new Map<
    string,
    {
      eventRefs: Map<string, GraphUpdateEventRef>;
      questionIds: Set<string>;
      payload: GraphUpdatePayload;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let graphListenClient: GraphListenClient | null = null;
  const memoryRateLimitWindowMs = parsePositiveInt(
    "MEMORY_RATE_LIMIT_WINDOW_MS",
    60_000
  );
  const memoryRateLimitMax = parsePositiveInt("MEMORY_RATE_LIMIT_MAX", 1000);
  const rateLimits = {
    auth: {
      windowMs: parsePositiveInt("AUTH_RATE_LIMIT_WINDOW_MS", 60_000),
      max: parsePositiveInt("AUTH_RATE_LIMIT_MAX", 20)
    },
    memoryRead: {
      windowMs: parsePositiveInt(
        "MEMORY_READ_RATE_LIMIT_WINDOW_MS",
        memoryRateLimitWindowMs
      ),
      max: parsePositiveInt("MEMORY_READ_RATE_LIMIT_MAX", memoryRateLimitMax)
    },
    memoryWrite: {
      windowMs: parsePositiveInt(
        "MEMORY_WRITE_RATE_LIMIT_WINDOW_MS",
        memoryRateLimitWindowMs
      ),
      max: parsePositiveInt("MEMORY_WRITE_RATE_LIMIT_MAX", memoryRateLimitMax)
    },
    memoryRecall: {
      windowMs: parsePositiveInt(
        "MEMORY_RECALL_RATE_LIMIT_WINDOW_MS",
        memoryRateLimitWindowMs
      ),
      max: parsePositiveInt("MEMORY_RECALL_RATE_LIMIT_MAX", memoryRateLimitMax)
    }
  } satisfies Record<RateLimitName, { windowMs: number; max: number }>;

  const writeGraphStreamEvent = (
    reply: FastifyReply,
    event: string,
    payload: unknown
  ) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const isGraphStreamTeamMember = async (
    userId: string,
    teamId: string
  ): Promise<boolean> => {
    const repo = repository;
    if (!repo) {
      return false;
    }
    try {
      await repo.listTeamMembers(userId, teamId);
      return true;
    } catch {
      return false;
    }
  };

  const broadcastGraphUpdate = async (payload: GraphUpdatePayload) => {
    const teamMembershipCache = new Map<string, Promise<boolean>>();
    const isTeamMember = (userId: string, teamId: string) => {
      const key = `${userId}:${teamId}`;
      const cached = teamMembershipCache.get(key);
      if (cached) {
        return cached;
      }
      const result = isGraphStreamTeamMember(userId, teamId);
      teamMembershipCache.set(key, result);
      return result;
    };

    for (const client of graphStreamClients) {
      if (
        !(await canReceiveGraphStreamPayload(client, payload, isTeamMember))
      ) {
        continue;
      }
      writeGraphStreamEvent(client.reply, "graph_update", payload);
    }
  };

  const graphUpdateKey = (payload: GraphUpdatePayload): string => {
    if (payload.visibility === "personal" && payload.ownerUserId) {
      return `personal:${payload.ownerUserId}`;
    }
    if (payload.visibility === "team" && payload.teamId) {
      return `team:${payload.teamId}`;
    }
    return "global";
  };

  const scheduleGraphUpdate = (payload: GraphUpdatePayload) => {
    const action = graphUpdateActionForPayload(payload);
    if (action.invalidateCache) {
      void cacheProvider
        .deleteByPrefix("koed:graph:")
        .catch((error: unknown) => {
          app.log.warn(
            { error: String(error) },
            "could not invalidate graph cache"
          );
        });
    }
    if (!action.broadcast) {
      return;
    }
    const key = graphUpdateKey(payload);
    const eventRef =
      payload.table === "memory_events" &&
      payload.operation !== "DELETE" &&
      payload.id &&
      payload.projectId &&
      payload.threadId
        ? {
            id: payload.id,
            projectId: payload.projectId,
            threadId: payload.threadId
          }
        : null;
    const questionId =
      payload.table === "memory_questions" && payload.id ? payload.id : null;
    const current = pendingGraphUpdates.get(key);
    if (current) {
      if (eventRef) {
        current.eventRefs.set(eventRef.id, eventRef);
      }
      if (questionId) {
        current.questionIds.add(questionId);
      }
      pendingGraphUpdates.set(key, { ...current, payload });
      return;
    }
    const timer = setTimeout(
      () => {
        const pending = pendingGraphUpdates.get(key);
        pendingGraphUpdates.delete(key);
        if (pending) {
          void broadcastGraphUpdate({
            ...pending.payload,
            coalesced: true,
            ...(pending.eventRefs.size > 0
              ? {
                  eventIds: [...pending.eventRefs.keys()],
                  eventRefs: [...pending.eventRefs.values()]
                }
              : {}),
            ...(pending.questionIds.size > 0
              ? { questionIds: [...pending.questionIds] }
              : {}),
            changedAt: new Date().toISOString()
          }).catch((error: unknown) => {
            app.log.warn(
              { error: String(error) },
              "could not broadcast graph update"
            );
          });
        }
      },
      eventRef ? memoryEventGraphUpdateDebounceMs : graphUpdateDebounceMs
    );
    pendingGraphUpdates.set(key, {
      eventRefs: new Map(eventRef ? [[eventRef.id, eventRef]] : []),
      questionIds: new Set(questionId ? [questionId] : []),
      payload,
      timer
    });
  };

  if (pool) {
    try {
      graphListenClient = await pool.connect();
      await graphListenClient.query("LISTEN koed_graph_updates");
      graphListenClient.on("notification", (message) => {
        if (message.channel !== "koed_graph_updates" || !message.payload) {
          return;
        }
        try {
          scheduleGraphUpdate(
            JSON.parse(message.payload) as GraphUpdatePayload
          );
        } catch (error) {
          app.log.warn(
            { error: String(error), payload: message.payload },
            "could not parse graph update notification"
          );
        }
      });
      graphListenClient.on("error", (error) => {
        app.log.warn({ error: String(error) }, "graph update listener failed");
      });
    } catch (error) {
      graphListenClient?.release();
      graphListenClient = null;
      app.log.warn(
        { error: String(error) },
        "could not start graph update listener"
      );
    }
  }

  app.addHook("onClose", async () => {
    for (const client of graphStreamClients) {
      client.reply.raw.end();
    }
    graphStreamClients.clear();
    for (const pending of pendingGraphUpdates.values()) {
      clearTimeout(pending.timer);
    }
    pendingGraphUpdates.clear();
    graphListenClient?.release();
    await Promise.all([
      embeddingQueue?.close(),
      compactionQueue?.close(),
      rateLimitStore.close?.(),
      cacheProvider.close?.()
    ]);
    await pool?.end();
  });

  const corsOrigins = allowedCorsOrigins();
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || corsOrigins.has(normalizeOrigin(origin))) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
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

  const authenticateSession = async (request: FastifyRequest) => {
    const repo = requireRepository();
    const sessionSecret = request.cookies[sessionCookieName];
    if (sessionSecret) {
      const user = await repo.getSessionUser(hashSecret(sessionSecret));
      if (user) {
        return user;
      }
    }

    throw Object.assign(new Error("Console session required"), {
      statusCode: 401
    });
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

  const rejectUnsupportedTeamCapturePolicy = (policy: {
    visibility: Visibility;
  }) => {
    if (policy.visibility === "team") {
      throw Object.assign(
        new Error(
          "Team Memory capture is not supported for API-token integrations in this build"
        ),
        { statusCode: 400 }
      );
    }
  };

  const rateLimit =
    (name: RateLimitName) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const policy = rateLimits[name];
      const authorization = request.headers.authorization;
      const keyMaterial = authorization
        ? hashSecret(authorization)
        : request.ip;
      const key = `${name}:${keyMaterial}`;
      const bucket = await rateLimitStore.increment(key, policy.windowMs);
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
        reply.header(
          "retry-after",
          String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)))
        );
        throw Object.assign(new Error("Rate limit exceeded"), {
          statusCode: 429
        });
      }
    };

  const authRateLimit = rateLimit("auth");
  const memoryReadRateLimit = rateLimit("memoryRead");
  const memoryWriteRateLimit = rateLimit("memoryWrite");
  const memoryRecallRateLimit = rateLimit("memoryRecall");

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
          : message.includes("not allowed to modify Team Memory")
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
    } else if (process.env.DATABASE_URL) {
      checks.push(publicHealth("postgres", "error"));
    }

    if (process.env.REDIS_URL) {
      const redis = new Redis(process.env.REDIS_URL, {
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

  app.get("/health/details", async (request) => {
    await authenticateSession(request);
    const checks = [createHealth("api")];

    if (process.env.DATABASE_URL) {
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

    if (process.env.REDIS_URL) {
      const redis = new Redis(process.env.REDIS_URL, {
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
    const user = await authenticateSession(request).catch(() => null);
    if (!user) {
      const ready = await repo.health().catch(() => false);
      return {
        status: ready ? "ok" : "error",
        components: {
          api: { status: "ok" },
          postgres: { status: ready ? "ok" : "error" },
          redis: {
            status: process.env.REDIS_URL ? "configured" : "not_configured"
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
        embeddingModel: process.env.EMBEDDING_MODEL ?? embedding.model,
        embeddingDimensions: resolveSupportedEmbeddingModelConfig(
          process.env.EMBEDDING_MODEL ?? embedding.model ?? undefined
        ).dimensions,
        rerankingEnabled:
          resolveSupportedRerankerModelConfig(process.env.RERANKER_KEY) !== null
      }
    };
  });

  app.get("/self-host/diagnostics", async (request) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);
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
    const user = await authenticateSession(request);
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
    const user = await authenticateSession(request);
    const currentTeam = await repo.getCurrentTeam(user.id);

    return {
      user: publicUser(user),
      currentTeam
    };
  });

  app.post("/teams", async (request) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);
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
    const user = await authenticateSession(request);
    const input = joinTeamSchema.parse(request.body);
    const team = await repo.joinTeamByInviteCode(user.id, input.inviteCode);

    return { team };
  });

  app.get("/teams/current", async (request) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);

    return { team: await repo.getCurrentTeam(user.id) };
  });

  app.get("/teams/current/members", async (request) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);
    const currentTeam = await repo.getCurrentTeam(user.id);
    if (!currentTeam) {
      return { members: [] };
    }

    return { members: await repo.listTeamMembers(user.id, currentTeam.id) };
  });

  app.post("/api-tokens", { preHandler: authRateLimit }, async (request) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);
    const input = createApiTokenSchema.parse(request.body);
    const token = createOpaqueSecret("cmt");
    const record = await repo.createApiToken({
      ownerUserId: user.id,
      teamId: undefined,
      name: input.name,
      tokenHash: hashSecret(token),
      tokenPrefix: token.slice(0, 12),
      scopes: []
    });

    return { token, apiToken: record };
  });

  app.get("/api-tokens", async (request) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);

    return { apiTokens: await repo.listApiTokens(user.id) };
  });

  app.delete("/api-tokens/:id", async (request, reply) => {
    const repo = requireRepository();
    const user = await authenticateSession(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await repo.revokeApiToken(user.id, params.id);

    return reply.status(deleted ? 200 : 404).send({ ok: deleted });
  });

  app.get(
    "/v1/access/check",
    { preHandler: memoryReadRateLimit },
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
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = effectivePolicyQuerySchema.parse(request.query);
      return {
        policy: await repo.getEffectiveCapturePolicy({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/capture-policies",
    { preHandler: memoryReadRateLimit },
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
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = capturePolicySchema.parse(request.body);
      return {
        policy: await repo.upsertCapturePolicy({ userId: user.id }, input)
      };
    }
  );

  app.post(
    "/v1/sessions",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
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
      rejectUnsupportedTeamCapturePolicy(policy);
      if (policy.captureState !== "enabled") {
        return { skipped: true, reason: "capture_disabled", policy };
      }
      const session = await repo.createCapturedSession(
        { userId: user.id },
        input
      );

      return { session, policy };
    }
  );

  app.post(
    "/v1/sessions/:sessionId/events",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = sessionIdParamsSchema.parse(request.params);
      const input = mcpSessionEventSchema.parse(request.body);
      const requesterContext = { userId: user.id };
      const policy = await resolveCapturePolicyForRequest(
        repo,
        requesterContext,
        { workspaceId: input.workspaceId, sessionId: params.sessionId }
      );
      rejectUnsupportedTeamCapturePolicy(policy);
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
        event.visibility,
        event.teamId ?? undefined
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
    { preHandler: memoryWriteRateLimit },
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
      rejectUnsupportedTeamCapturePolicy(policy);
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
        ...input,
        visibility: policy.visibility,
        teamId
      });
      const processing = await scheduleMemoryEventProcessing(
        repo,
        requesterContext,
        event.id,
        event.visibility,
        event.teamId ?? undefined
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
    { preHandler: memoryReadRateLimit },
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
    { preHandler: memoryReadRateLimit },
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
    { preHandler: memoryReadRateLimit },
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
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const cacheKey = `koed:graph:overview:${user.id}`;
      const cached = await cacheProvider.getJson<{ overview: unknown }>(
        cacheKey
      );
      if (cached) {
        return cached;
      }
      const response = {
        overview: await repo.getLcmGraphOverview({ userId: user.id })
      };
      await cacheProvider.setJson(cacheKey, response, graphCacheTtlSeconds);
      return response;
    }
  );

  app.get(
    "/v1/memory/graph/nodes",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = graphNodesQuerySchema.parse(request.query);
      return {
        nodes: await repo.listLcmGraphNodes(
          { userId: user.id },
          {
            ...query,
            nodeIds: query.ids
          }
        )
      };
    }
  );

  app.get(
    "/v1/memory/graph/nodes/:nodeId",
    { preHandler: memoryReadRateLimit },
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
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = graphEventsQuerySchema.parse(request.query);
      return {
        events: await repo.listLcmGraphEvents({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/memory/graph/threads",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = graphQuerySchema.parse(request.query);
      const cacheKey = `koed:graph:threads:${user.id}:${hashSecret(
        JSON.stringify(query)
      )}`;
      const cached = await cacheProvider.getJson<{ projects: unknown }>(
        cacheKey
      );
      if (cached) {
        return cached;
      }
      const response = {
        projects: await repo.listLcmGraphThreads({ userId: user.id }, query)
      };
      await cacheProvider.setJson(cacheKey, response, graphCacheTtlSeconds);
      return response;
    }
  );

  app.get("/v1/memory/graph/stream", async (request, reply) => {
    const user = await authenticate(request);
    const origin = request.headers.origin?.replace(/\/+$/, "");
    const streamCorsHeaders =
      origin && corsOrigins.has(origin)
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            vary: "Origin"
          }
        : {};

    reply.hijack();
    reply.raw.writeHead(200, {
      ...streamCorsHeaders,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    const client = { userId: user.id, reply };
    graphStreamClients.add(client);
    writeGraphStreamEvent(reply, "ready", {
      ok: true,
      changedAt: new Date().toISOString()
    });

    const heartbeat = setInterval(() => {
      writeGraphStreamEvent(reply, "heartbeat", {
        changedAt: new Date().toISOString()
      });
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      graphStreamClients.delete(client);
    });
  });

  app.get(
    "/v1/memory/graph/events/:eventId",
    { preHandler: memoryReadRateLimit },
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
    { preHandler: memoryWriteRateLimit },
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
    { preHandler: memoryWriteRateLimit },
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
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      return await repo.exportMemoryRecords({ userId: user.id });
    }
  );

  app.get(
    "/v1/memory/questions",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = memoryQuestionsQuerySchema.parse(request.query);
      const questions = await repo.listMemoryQuestions(
        { userId: user.id },
        {
          query: query.query,
          searchDomain: query.search_domain,
          status: query.status,
          workspaceId: query.workspace_id,
          sessionId: query.session_id,
          limit: query.limit,
          offset: query.offset
        }
      );
      return { questions };
    }
  );

  app.post(
    "/v1/memory/questions",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = memoryQuestionSchema.parse(request.body);
      const question = await repo.createMemoryQuestion(
        { userId: user.id },
        {
          query: input.query,
          retrievalScope: input.retrieval_scope,
          searchDomain: input.search_domain,
          workspaceId: input.workspace_id,
          projectName: input.project_name,
          projectPath: input.project_path,
          sessionId: input.session_id,
          threadId: input.thread_id,
          threadName: input.thread_name
        }
      );
      return { question };
    }
  );

  app.post(
    "/v1/memory/questions/claim-pending",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = claimMemoryQuestionsSchema.parse(request.body);
      const questions = await repo.claimPendingMemoryQuestions(
        { userId: user.id },
        {
          questionId: input.question_id,
          limit: input.limit,
          leaseSeconds: input.lease_seconds
        }
      );
      return { questions };
    }
  );

  app.get(
    "/v1/memory/questions/:questionId",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = memoryQuestionParamsSchema.parse(request.params);
      const question = await repo.getMemoryQuestion(
        { userId: user.id },
        params.questionId
      );
      return question
        ? { question }
        : reply
            .status(404)
            .send({ error: "Question not found or not visible" });
    }
  );

  app.patch(
    "/v1/memory/questions/:questionId",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = memoryQuestionParamsSchema.parse(request.params);
      const input = updateMemoryQuestionSchema.parse(request.body);
      const question = await repo.updateMemoryQuestion(
        { userId: user.id },
        params.questionId,
        input.status === "answered"
          ? {
              status: input.status,
              answerMarkdown: input.answer_markdown,
              attemptCount: input.attempt_count,
              response: input.response,
              evidence: input.evidence,
              citations: input.citations,
              retrieval: input.retrieval,
              localMemoryWorker: input.local_memory_worker
            }
          : input.status === "error"
            ? {
                status: input.status,
                errorMessage: input.error_message,
                attemptCount: input.attempt_count,
                response: input.response,
                retrieval: input.retrieval,
                localMemoryWorker: input.local_memory_worker
              }
            : {
                status: input.status,
                lastErrorMessage: input.last_error_message,
                attemptCount: input.attempt_count,
                response: input.response,
                evidence: input.evidence,
                citations: input.citations,
                retrieval: input.retrieval,
                localMemoryWorker: input.local_memory_worker
              }
      );
      return question
        ? { question }
        : reply
            .status(404)
            .send({ error: "Question not found or not visible" });
    }
  );

  app.post(
    "/v1/memory/search",
    { preHandler: memoryRecallRateLimit },
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
    { preHandler: memoryRecallRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
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
    { preHandler: memoryRecallRateLimit },
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
    { preHandler: memoryWriteRateLimit },
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
    { preHandler: memoryReadRateLimit },
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
    { preHandler: memoryWriteRateLimit },
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
    { preHandler: memoryWriteRateLimit },
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
    { preHandler: memoryReadRateLimit },
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
