import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";
import { type Visibility } from "@koed/core";
import {
  createCollaborationRepository,
  createDbPool,
  createEmbeddingCapacityRepository,
  createMemorySourceRepository,
  createPrivacyClassificationRepository,
  createRetentionLifecycleRepository,
  databaseErrorCode,
  runDbMigrations,
  type CollaborationRepository,
  type EmbeddingCapacityRepository,
  type MemorySourceRepository,
  type PrivacyClassificationRepository,
  type RetentionLifecycleRepository
} from "@koed/db";
import {
  createAuthHelpers,
  createHashSecret,
  registerAuthRoutes
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
import { readLocalEdgeUpstreamRegistry } from "../local-edge/upstream-routing.js";
import {
  createCollaborationActionGrantControl,
  type CollaborationActionGrantControl
} from "../local-edge/collaboration-action-grant-control.js";
import { createCollaborationActionGrantLifecycle } from "../local-edge/collaboration-action-grant-lifecycle.js";
import { createLocalSharedMemoryCandidatePreparation } from "../local-edge/shared-memory-candidate-preparation.js";
import {
  createPostgresCollaborationSharedMemoryAuthorityStore,
  type PostgresCollaborationSharedMemoryAuthorityStore
} from "../local-edge/collaboration-shared-memory-authority-store.js";
import {
  createCollaborationSharedMemoryControl,
  type CollaborationSharedMemoryControl
} from "../local-edge/collaboration-shared-memory-control.js";
import { createCollaborationRealtimeBroker } from "../local-edge/collaboration-realtime-broker.js";
import {
  canReceiveGraphStreamPayload,
  createGraphStreamService,
  createMemoryJobQueue,
  createMemoryJobScheduler,
  graphUpdateActionForPayload,
  registerCaptureRoutes,
  registerCuratedMemoryRoutes,
  registerConversationSourceJournalRoutes,
  registerGraphRoutes,
  registerHistoricalImportRoutes,
  registerLocalAgentSettingsRoutes,
  registerLcmRoutes,
  registerQuestionRoutes,
  registerRawConversationRoutes,
  registerRecallRoutes,
  shouldIgnoreGraphStreamPayload,
  type ConversationSourceSignerFactory
} from "../memory/index.js";
import {
  createEnvelopeEncryptionProviderFromEnvironment,
  crossIdentitySyncDeterministicUuid,
  createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment,
  createTeamMemoryEnvelopeEncryptionProviderFromEnvironment,
  derivePrivacyFingerprintKey,
  inspectDeviceIdentityAtKoedHome,
  reconcileDeviceIdentityDeployment,
  embeddingDispatchKey,
  readUpstreamCredentialAuthorization,
  type DeviceIdentityInspection,
  type EnvelopeEncryptionProvider,
  lcmCompactQueueName,
  lcmEmbedQueueName,
  memoryEmbedQueueName,
  requestKoedLocalWork,
  readLocalEdgeUpstreamEnrollmentBinding,
  resolveApiDataEncryptionKeyFromEnv,
  resolveSupportedEmbeddingModelConfig
} from "@koed/shared";
import { createHistoricalRawAdmission } from "../memory/historical-raw-admission.js";
import {
  createSecureUpstreamFetch,
  registeredPrivateNetworkPolicy
} from "@koed/shared/secure-upstream-fetch";
import { registerTeamRoutes } from "../team/index.js";
import { registerCrossIdentitySyncRoutes } from "../cross-identity-sync/index.js";
import {
  registerConversationSourceReplicationRoutes,
  registerConversationSourceRestoreRoutes
} from "../source-replication/index.js";
import {
  registerManagedConversationRoutes,
  registerManagedConversationRunnerRoutes
} from "../managed-conversations/index.js";
import {
  createCollaborationAdmissionController,
  createCollaborationRealtimeService,
  registerCollaborationRoutes
} from "../collaboration/index.js";
import { registerHighRiskRoutes } from "../high-risk/index.js";
import { registerSharedMemoryRoutes } from "../shared-memory/index.js";
import { prepareSourceSyncRelationship } from "../cross-identity-sync/source-relationship-service.js";
import { createTeamConversationSourceService } from "../team-conversation-source/index.js";
import { registerRetentionRoutes } from "../retention/index.js";
import {
  registerPersonalDeviceSyncRoutes,
  registerPersonalDeviceSyncRelayRoutes,
  type PdsAuthoritySigner,
  type PdsRemoteAccountLinkVerifier
} from "../personal-device-sync/index.js";
import type { PdsSecureKeyProvider } from "../personal-device-sync/local-source.js";
import {
  createPdsSecureRuntimeForApiStartup,
  createReloadablePdsSecureKeyProviderFromEnvironment
} from "../personal-device-sync/secure-runtime.js";
import { resolveApiServerConfig } from "./config.js";
import { registerBrowserWriteCsrfProtection } from "./browser-write-csrf.js";
import { registerBrowserApprovalRoutes } from "./browser-approval-routes.js";
import {
  apiLogSchemaVersion,
  apiServiceName,
  authenticatedRequestLogContext,
  formatApiLogBindings,
  getRequestLogContext,
  redactSensitiveRoutePath,
  resolveRequestId,
  sanitizeZodIssues,
  serializeApiRequest,
  setRequestLogContext
} from "./logging.js";
import { registerOperationalRoutes } from "./operational-routes.js";
import type { ApiRouteContext } from "./context.js";
import { registerTeamCollaborationFeatureGate } from "./team-collaboration-feature.js";

export {
  canReceiveGraphStreamPayload,
  graphUpdateActionForPayload,
  shouldIgnoreGraphStreamPayload
};

export interface BuildServerOptions {
  repository?: MemorySourceRepository;
  collaborationRepository?: CollaborationRepository;
  retentionRepository?: RetentionLifecycleRepository;
  embeddingCapacityRepository?: EmbeddingCapacityRepository;
  historicalImportAdmission?: ApiRouteContext["historicalImport"]["admission"];
  privacyClassificationRepository?: PrivacyClassificationRepository;
  /** Test-only queue factory injection. Production uses createMemoryJobQueue. */
  memoryJobQueueFactory?: typeof createMemoryJobQueue;
  runMemoryJobsInlineForTests?: boolean;
  rateLimitStore?: RateLimitStore;
  cacheProvider?: CacheProvider;
  upstreamBackendsPath?: string;
  upstreamEnrollmentsPath?: string;
  /** Test/deployment injection for trusted internal service requests. */
  internalServiceFetch?: typeof fetch;
  fetch?: typeof fetch;
  /** Test-only trusted service transport injection. Production uses global fetch. */
  trustedServiceFetch?: typeof fetch;
  resolveUpstreamAuthorization?: ApiRouteContext["localEdge"]["resolveUpstreamAuthorization"];
  resolveUpstreamEnrollmentBinding?: ApiRouteContext["localEdge"]["resolveUpstreamEnrollmentBinding"];
  remoteOperationsAllowed?: ApiRouteContext["localEdge"]["remoteOperationsAllowed"];
  inspectDeploymentIdentity?: () => DeviceIdentityInspection;
  workosClient?: WorkosAuthKitClient;
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  teamEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  ownerPrivateReplicaEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  collaborationSharedMemoryControl?: CollaborationSharedMemoryControl;
  /** Test-only durable authority-store injection. */
  collaborationSharedMemoryAuthorityStore?: PostgresCollaborationSharedMemoryAuthorityStore;
  collaborationActionGrantControl?: CollaborationActionGrantControl;
  /** Test-only injection. Production obtains PDS signer only from secret config. */
  pdsAuthoritySigner?: PdsAuthoritySigner | null;
  /** Test/deployment injection; absent verifier fails Remote Account Link closed. */
  pdsRemoteAccountLinkVerifier?: PdsRemoteAccountLinkVerifier | null;
  /** Secure PDS key/group-secret provider. Never populated from environment config. */
  pdsSecureKeyProvider?: PdsSecureKeyProvider | null;
  /** Test-only signer injection. Production derives generation keys from device proof. */
  conversationSourceSignerFactory?: ConversationSourceSignerFactory;
}

const normalizeOrigin = (value: string): string => value.replace(/\/+$/, "");

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

const createDefaultResolveUpstreamAuthorization =
  (
    koedHome: string
  ): ApiRouteContext["localEdge"]["resolveUpstreamAuthorization"] =>
  (backend) => {
    if (backend.credential?.status !== "configured") {
      return null;
    }
    const reference = backend.credential.reference?.trim();
    const storedAuthorization = readUpstreamCredentialAuthorization(
      koedHome,
      reference
    );
    if (storedAuthorization) {
      return storedAuthorization;
    }
    return normalizeUpstreamAuthorization(
      reference
        ? process.env[reference]
        : process.env[upstreamCredentialEnvironmentName(backend.id)]
    );
  };

export const buildServer = async (options: BuildServerOptions = {}) => {
  const config = resolveApiServerConfig();
  // Only configured secret references can enable PDS. No raw environment-key fallback.
  const pdsRuntime = await createPdsSecureRuntimeForApiStartup();
  const reloadablePdsSecureKeyProvider =
    createReloadablePdsSecureKeyProviderFromEnvironment();

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
    options.repository || !config.databaseUrl
      ? null
      : createDbPool({
          onPoolError: (error) => {
            app.log.warn(
              {
                event: {
                  name: "database.pool_connection_interrupted",
                  category: "database"
                },
                component: "database",
                database: { error_code: databaseErrorCode(error) }
              },
              "database pool connection interrupted"
            );
          }
        });
  if (pool) {
    await runDbMigrations(pool);
  }
  const envelopeEncryptionProvider: EnvelopeEncryptionProvider | undefined =
    options.envelopeEncryptionProvider ??
    createEnvelopeEncryptionProviderFromEnvironment();
  const ownerPrivateReplicaEnvelopeEncryptionProvider:
    | EnvelopeEncryptionProvider
    | undefined =
    options.ownerPrivateReplicaEnvelopeEncryptionProvider ??
    createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment();
  const teamEnvelopeEncryptionProvider =
    options.teamEnvelopeEncryptionProvider ??
    createTeamMemoryEnvelopeEncryptionProviderFromEnvironment();
  const privacyFingerprintRoot = resolveApiDataEncryptionKeyFromEnv();
  const privacyClassificationRepository =
    options.privacyClassificationRepository ??
    (pool && privacyFingerprintRoot
      ? createPrivacyClassificationRepository(pool, {
          fingerprintKey: derivePrivacyFingerprintKey(privacyFingerprintRoot)
        })
      : null);
  if (
    envelopeEncryptionProvider &&
    ownerPrivateReplicaEnvelopeEncryptionProvider &&
    envelopeEncryptionProvider.keyId ===
      ownerPrivateReplicaEnvelopeEncryptionProvider.keyId
  ) {
    throw new Error(
      "Owner-private replica envelope encryption must use a distinct key from the Team/general provider"
    );
  }
  if (
    teamEnvelopeEncryptionProvider &&
    (teamEnvelopeEncryptionProvider.keyId ===
      envelopeEncryptionProvider?.keyId ||
      teamEnvelopeEncryptionProvider.keyId ===
        ownerPrivateReplicaEnvelopeEncryptionProvider?.keyId)
  ) {
    throw new Error(
      "Team Memory envelope encryption must use a distinct key from Personal and owner-private providers"
    );
  }
  const repository =
    options.repository ??
    (pool
      ? createMemorySourceRepository(pool, {
          envelopeEncryptionProvider,
          teamEnvelopeEncryptionProvider,
          ownerPrivateReplicaEnvelopeEncryptionProvider
        })
      : null);
  const collaborationRepository =
    options.collaborationRepository ??
    (pool && envelopeEncryptionProvider
      ? createCollaborationRepository(pool, {
          envelopeEncryptionProvider,
          teamEnvelopeEncryptionProvider
        })
      : null);
  const retentionRepository =
    options.retentionRepository ??
    (pool
      ? createRetentionLifecycleRepository(pool, {
          authorizeHoldActor: async (context) => {
            if (context.target.scope === "owner_private_replica") {
              return context.authority === "personal_memory.legal_hold.manage";
            }
            const result = await pool.query(
              `select 1
                 from team_memberships tm
                 join teams t on t.id = tm.team_id
                where tm.team_id = $1
                  and tm.user_id = $2
                  and tm.role in ('owner', 'admin')
                  and tm.status = 'enabled'
                  and tm.disabled_at is null
                  and t.lifecycle in ('active', 'deletion_requested', 'purge_pending')
                limit 1`,
              [context.target.teamId, context.actorUserId]
            );
            return result.rowCount === 1;
          }
        })
      : null);
  if (repository && !options.repository) {
    const legacyDeployment = await repository.getLocalSyncDeployment();
    reconcileDeviceIdentityDeployment({
      koedHome: config.koedHome,
      protocolDeploymentId: legacyDeployment?.protocolDeploymentId ?? null,
      environment: process.env
    });
  }
  const memoryJobQueueFactory =
    options.memoryJobQueueFactory ?? createMemoryJobQueue;
  const createQueue = <TJobData>(name: string) =>
    memoryJobQueueFactory<TJobData>(name, {
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
  const lcmEmbeddingQueue = createQueue<{
    sourceType: "memory_node";
    sourceId: string;
  }>(lcmEmbedQueueName);
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
  let collaborationRealtimeService: {
    registerRoutes(): void;
    close(): void;
  } | null = null;
  let collaborationRealtimeBroker: {
    registerRoutes(): void;
    close(): Promise<void>;
  } | null = null;
  let teamConversationSourceService: {
    close(): Promise<void>;
  } | null = null;
  let localEdgeSecureFetch: ReturnType<
    typeof createSecureUpstreamFetch
  > | null = null;
  let pendingShareSourceWorkerTimer: NodeJS.Timeout | null = null;
  const relayCleanup = (
    repository as
      | (MemorySourceRepository & {
          cleanupPdsRelay?: () => Promise<unknown>;
        })
      | null
  )?.cleanupPdsRelay;
  const relayCleanupTimer = relayCleanup
    ? setInterval(
        () => {
          void relayCleanup().catch(() => undefined);
        },
        60 * 60 * 1_000
      )
    : null;
  relayCleanupTimer?.unref();
  if (relayCleanup) void relayCleanup().catch(() => undefined);
  const pendingShareWorker = config.teamCollaborationEnabled
    ? repository?.processPendingShares
    : undefined;
  const ensurePendingShareCompanion = collaborationRepository
    ? async (input: {
        actor: { userId: string };
        grant: {
          id: string;
          logicalMemoryId: string;
          teamId: string;
          teamWorkspaceId: string;
        };
      }): Promise<boolean> => {
        try {
          const thread = await collaborationRepository.createThread(
            input.actor,
            {
              kind: "shared_session_discussion",
              idempotencyKey: crossIdentitySyncDeterministicUuid({
                kind: "pending_share_companion",
                shareGrantId: input.grant.id
              }),
              teamId: input.grant.teamId,
              teamWorkspaceId: input.grant.teamWorkspaceId,
              sharedLogicalMemoryId: input.grant.logicalMemoryId,
              shareGrantId: input.grant.id,
              pendingShareActivation: true
            }
          );
          const matchesGrant = Boolean(
            thread &&
            thread.kind === "shared_session_discussion" &&
            thread.teamId === input.grant.teamId &&
            thread.teamWorkspaceId === input.grant.teamWorkspaceId &&
            thread.sharedLogicalMemoryId === input.grant.logicalMemoryId &&
            thread.shareGrantId === input.grant.id
          );
          if (!matchesGrant) {
            app.log.warn(
              {
                event: { name: "pending_share.companion.unavailable" },
                shareGrantId: input.grant.id
              },
              "Pending Share companion discussion is unavailable"
            );
          }
          return matchesGrant;
        } catch (error) {
          app.log.warn(
            {
              err: error,
              event: { name: "pending_share.companion.failed" },
              shareGrantId: input.grant.id
            },
            "Pending Share companion discussion could not be created"
          );
          return false;
        }
      }
    : undefined;
  let pendingShareWorkerRunning = false;
  const runPendingShareWorker = () => {
    if (!pendingShareWorker || pendingShareWorkerRunning) return;
    pendingShareWorkerRunning = true;
    void pendingShareWorker({
      limit: 10,
      ensureCompanion: ensurePendingShareCompanion
    })
      .catch((error: unknown) => {
        app.log.error(
          { err: error, event: { name: "pending_share.worker.failed" } },
          "Pending Share worker failed"
        );
      })
      .finally(() => {
        pendingShareWorkerRunning = false;
      });
  };
  const pendingShareWorkerTimer = pendingShareWorker
    ? setInterval(runPendingShareWorker, 5_000)
    : null;
  pendingShareWorkerTimer?.unref();
  runPendingShareWorker();
  const hashSecret = createHashSecret(config.apiTokenPepper);
  app.addHook("onClose", async () => {
    graphStreamService?.close();
    collaborationRealtimeService?.close();
    await collaborationRealtimeBroker?.close();
    await teamConversationSourceService?.close();
    if (relayCleanupTimer) clearInterval(relayCleanupTimer);
    if (pendingShareWorkerTimer) clearInterval(pendingShareWorkerTimer);
    if (pendingShareSourceWorkerTimer) {
      clearInterval(pendingShareSourceWorkerTimer);
    }
    await Promise.all([
      embeddingQueue?.close(),
      compactionQueue?.close(),
      lcmEmbeddingQueue?.close(),
      rateLimitStore.close?.(),
      cacheProvider.close?.(),
      localEdgeSecureFetch?.close()
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
  registerBrowserWriteCsrfProtection(app, corsOrigins);
  registerTeamCollaborationFeatureGate(app, {
    enabled: config.teamCollaborationEnabled,
    realtimeCursorSecret: config.collaborationRealtime.cursorSecret
  });
  const requireRepository = (): MemorySourceRepository => {
    if (!repository) {
      throw Object.assign(new Error("Database is not configured"), {
        statusCode: 503
      });
    }

    return repository;
  };
  const requireCollaborationRepository = (): CollaborationRepository => {
    if (!collaborationRepository) {
      throw Object.assign(new Error("Database is not configured"), {
        statusCode: 503
      });
    }

    return collaborationRepository;
  };
  const requireRetentionRepository = (): RetentionLifecycleRepository => {
    if (!retentionRepository) {
      throw Object.assign(new Error("Database is not configured"), {
        statusCode: 503
      });
    }

    return retentionRepository;
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
  const rateLimitHandlers = createRateLimitHandlers(
    rateLimitStore,
    hashSecret,
    config.rateLimit.policies,
    {
      resolveAuthenticatedUserId: async (request) =>
        getRequestLogContext(request).actor?.user_id ??
        (await authHelpers.resolveApiTokenUser(request))?.id ??
        (await authHelpers.resolveDeviceCredentialContext(request))?.user.id
    }
  );
  const collaborationAdmission = createCollaborationAdmissionController(
    rateLimitStore,
    hashSecret
  );
  const embeddingModelConfig = resolveSupportedEmbeddingModelConfig(
    config.embeddingModel
  );
  const embeddingCapacityRepository =
    options.embeddingCapacityRepository ??
    (pool ? createEmbeddingCapacityRepository(pool) : null);
  const configuredLiveBacklogMaximum = Number.parseInt(
    process.env.MEMORY_HISTORICAL_IMPORT_LIVE_BACKLOG_MAX ?? "0",
    10
  );
  const historicalImportAdmission =
    options.historicalImportAdmission ??
    (repository && embeddingCapacityRepository && embeddingQueue
      ? createHistoricalRawAdmission({
          repository,
          embeddingCapacityRepository,
          embeddingQueue,
          embeddingModel: embeddingModelConfig.key,
          embeddingDimensions: embeddingModelConfig.dimensions,
          maxLiveProjectionRows:
            Number.isInteger(configuredLiveBacklogMaximum) &&
            configuredLiveBacklogMaximum >= 0 &&
            configuredLiveBacklogMaximum <= 10_000
              ? configuredLiveBacklogMaximum
              : 0
        })
      : () =>
          Promise.resolve({
            admitted: false,
            reason: "api_degraded" as const
          }));
  const {
    runCompactionInline,
    enqueueEmbedding,
    scheduleMemoryEventProcessing,
    scheduleProjectedMemoryEventProcessing
  } = createMemoryJobScheduler({
    embeddingQueue,
    compactionQueue,
    embeddingDispatchKey: embeddingDispatchKey(
      embeddingModelConfig.key,
      embeddingModelConfig.dimensions
    ),
    runMemoryJobsInlineForTests: options.runMemoryJobsInlineForTests,
    log: app.log
  });

  const resolveCapturePolicyForRequest = async (
    repo: MemorySourceRepository,
    requesterContext: { userId: string },
    input: { projectId?: string; sessionId?: string; threadId?: string }
  ) =>
    repo.getEffectiveCapturePolicy(requesterContext, {
      projectId: input.projectId,
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

  const localEdgeUpstreamBackendsPath =
    options.upstreamBackendsPath ?? config.upstreamBackendsPath;
  const localEdgeUpstreamEnrollmentsPath =
    options.upstreamEnrollmentsPath ?? config.upstreamEnrollmentsPath;
  localEdgeSecureFetch = options.fetch
    ? null
    : createSecureUpstreamFetch({
        allowPrivateNetworkForUrl: registeredPrivateNetworkPolicy(() =>
          readLocalEdgeUpstreamRegistry(
            localEdgeUpstreamBackendsPath
          ).backends.map((backend) => ({
            baseUrl: backend.baseUrl,
            profile: backend.profile
          }))
        )
      });
  const localEdgeFetch = options.fetch ?? localEdgeSecureFetch!;
  const trustedServiceFetch =
    options.trustedServiceFetch ?? options.fetch ?? globalThis.fetch;
  const localEdgeResolveUpstreamAuthorization =
    options.resolveUpstreamAuthorization ??
    createDefaultResolveUpstreamAuthorization(config.koedHome);
  const localEdgeResolveUpstreamEnrollmentBinding =
    options.resolveUpstreamEnrollmentBinding ??
    ((backendId: string) =>
      readLocalEdgeUpstreamEnrollmentBinding(
        localEdgeUpstreamEnrollmentsPath,
        backendId
      ));
  const sharedMemoryAuthorityRepository =
    options.collaborationSharedMemoryAuthorityStore ??
    (pool && envelopeEncryptionProvider
      ? createPostgresCollaborationSharedMemoryAuthorityStore(pool, {
          envelopeEncryptionProvider
        })
      : null);
  const resolveVerifiedDeploymentId = (): string | null => {
    const identity = (
      options.inspectDeploymentIdentity ??
      (() =>
        inspectDeviceIdentityAtKoedHome({
          koedHome: config.koedHome,
          environment: process.env
        }))
    )();
    return identity.health === "healthy" && identity.deploymentId
      ? identity.deploymentId
      : null;
  };
  const preparePendingShareSource = async (input: {
    backendId: string;
    localOwnerUserId: string;
    sessionId: string;
    mutationId: string;
  }): Promise<void> => {
    if (!repository) return;
    const deploymentId = resolveVerifiedDeploymentId();
    if (!deploymentId) {
      throw new Error("Verified deployment identity unavailable");
    }
    await prepareSourceSyncRelationship(
      {
        deploymentProfile: config.deploymentProfile,
        resolveVerifiedLocalDeploymentId: () => deploymentId,
        upstreamBackendsPath: localEdgeUpstreamBackendsPath,
        fetch: localEdgeFetch,
        resolveUpstreamAuthorization: localEdgeResolveUpstreamAuthorization,
        requireRepository: () => repository
      },
      {
        localUserId: input.localOwnerUserId,
        sessionId: input.sessionId,
        upstreamBackendId: input.backendId,
        idempotencyKey: input.mutationId,
        consentedAt: new Date().toISOString()
      }
    );
  };
  const localSharedMemoryCandidatePreparation = repository
    ? createLocalSharedMemoryCandidatePreparation({
        repository,
        resolveDeploymentId: resolveVerifiedDeploymentId,
        requestLcmSummaryWork: () =>
          requestKoedLocalWork(config.koedHome, "lcm-summary")
      })
    : null;
  const collaborationActionGrantLifecycle =
    createCollaborationActionGrantLifecycle({ koedHome: config.koedHome });
  const collaborationSharedMemoryControl =
    options.collaborationSharedMemoryControl ??
    (sharedMemoryAuthorityRepository
      ? createCollaborationSharedMemoryControl({
          koedHome: config.koedHome,
          upstreamBackendsPath: localEdgeUpstreamBackendsPath,
          fetch: localEdgeFetch,
          resolveUpstreamAuthorization: localEdgeResolveUpstreamAuthorization,
          actionGrantLifecycle: collaborationActionGrantLifecycle,
          authorityStore: sharedMemoryAuthorityRepository,
          preparePendingShareSource,
          loadLocalCandidatePreview:
            localSharedMemoryCandidatePreparation?.loadCandidatePreview,
          prepareLocalLcmRepresentation:
            localSharedMemoryCandidatePreparation?.prepareLcmRepresentation,
          ensureEnrollmentBinding: (input) =>
            sharedMemoryAuthorityRepository.bindEnrollment({
              identity: input,
              remoteDeviceId: input.remoteDeviceId
            })
        })
      : undefined);
  if (config.teamCollaborationEnabled && sharedMemoryAuthorityRepository) {
    let sourceWorkerRunning = false;
    const drainPendingShareSourceWork = () => {
      if (sourceWorkerRunning) return;
      sourceWorkerRunning = true;
      void (async () => {
        const work =
          await sharedMemoryAuthorityRepository.claimPendingShareSourceWork({
            limit: 10
          });
        for (const item of work) {
          try {
            await preparePendingShareSource({
              backendId: item.backendId,
              localOwnerUserId: item.localOwnerUserId,
              sessionId: item.localSessionId,
              mutationId: item.mutationId
            });
            await sharedMemoryAuthorityRepository.finishPendingShareSourceWork({
              workId: item.workId,
              outcome: "completed"
            });
          } catch {
            await sharedMemoryAuthorityRepository.finishPendingShareSourceWork({
              workId: item.workId,
              outcome: "retry",
              redactedFailureCode: "source_preparation_failed"
            });
          }
        }
      })()
        .catch((error: unknown) => {
          app.log.error(
            {
              err: error,
              event: { name: "pending_share.source_worker.failed" }
            },
            "Pending Share source worker failed"
          );
        })
        .finally(() => {
          sourceWorkerRunning = false;
        });
    };
    pendingShareSourceWorkerTimer = setInterval(
      drainPendingShareSourceWork,
      5_000
    );
    pendingShareSourceWorkerTimer.unref();
    drainPendingShareSourceWork();
  }
  const collaborationActionGrantControl =
    options.collaborationActionGrantControl ??
    createCollaborationActionGrantControl({
      koedHome: config.koedHome,
      fetch: localEdgeFetch,
      actionGrantLifecycle: collaborationActionGrantLifecycle
    });

  const collaborationNavigationInvalidationListeners = new Set<
    (backendId: string) => void
  >();
  const routeContext = {
    config,
    requireRepository,
    auth: authHelpers,
    rateLimit: rateLimitHandlers,
    collaboration: {
      admission: collaborationAdmission,
      actionGrantLifecycle: collaborationActionGrantLifecycle,
      actionGrantControl: collaborationActionGrantControl,
      sharedMemoryControl: collaborationSharedMemoryControl,
      subscribeNavigationInvalidation: (
        listener: (backendId: string) => void
      ) => {
        collaborationNavigationInvalidationListeners.add(listener);
        return () => {
          collaborationNavigationInvalidationListeners.delete(listener);
        };
      }
    },
    jobs: {
      enqueueEmbedding
    },
    historicalImport: {
      admission: historicalImportAdmission
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
    deploymentIdentity: {
      inspect:
        options.inspectDeploymentIdentity ??
        (() =>
          inspectDeviceIdentityAtKoedHome({
            koedHome: config.koedHome,
            environment: process.env
          }))
    },
    managedConversations: {
      commandWakePool: pool
    },
    trustedServices: {
      fetch: trustedServiceFetch
    },
    localEdge: {
      upstreamBackendsPath: localEdgeUpstreamBackendsPath,
      remoteOperationsAllowed:
        options.remoteOperationsAllowed ??
        (config.test
          ? () => true
          : () =>
              inspectDeviceIdentityAtKoedHome({
                koedHome: config.koedHome,
                environment: process.env
              }).remoteOperationsAllowed),
      fetch: localEdgeFetch,
      resolveUpstreamAuthorization: localEdgeResolveUpstreamAuthorization,
      resolveUpstreamEnrollmentBinding:
        localEdgeResolveUpstreamEnrollmentBinding
    },
    internalServices: {
      fetch: options.internalServiceFetch ?? fetch
    },
    workos: {
      client:
        options.workosClient ??
        createWorkosAuthKitClient(config.workos, options.fetch)
    },
    personalDeviceSync: {
      authoritySigner: options.pdsAuthoritySigner ?? pdsRuntime.authoritySigner,
      remoteAccountLinkVerifier: options.pdsRemoteAccountLinkVerifier ?? null,
      secureKeyProvider:
        options.pdsSecureKeyProvider ??
        reloadablePdsSecureKeyProvider ??
        pdsRuntime.secureKeyProvider,
      wakePool: pool
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
  if (
    repository &&
    collaborationRepository &&
    pool &&
    config.collaborationRealtime.cursorSecret
  ) {
    const identity = routeContext.deploymentIdentity.inspect();
    if (identity.health !== "healthy" || !identity.deploymentId) {
      throw new Error(
        "A verified local deployment identity is required for collaboration realtime"
      );
    }
    const deployment = await repository.ensureLocalSyncDeployment({
      profile: config.deploymentProfile,
      protocolDeploymentId: identity.deploymentId
    });
    collaborationRealtimeService = await createCollaborationRealtimeService({
      app,
      auth: authHelpers,
      repository: collaborationRepository,
      materializationRepository: repository,
      sharedMemoryRepository: repository,
      teamPresenceRepository: repository,
      pool,
      corsOrigins,
      backendIdentity: deployment.protocolDeploymentId,
      cursorSecret: config.collaborationRealtime.cursorSecret,
      maxClients: config.collaborationRealtime.streamMaxClients,
      maxClientsPerPrincipal:
        config.collaborationRealtime.streamMaxClientsPerPrincipal
    });
  }
  if (
    pool &&
    config.runtimeMode !== "external" &&
    config.collaborationRealtime.localBrokerSecret
  ) {
    collaborationRealtimeBroker = createCollaborationRealtimeBroker({
      app,
      pool,
      koedHome: config.koedHome,
      upstreamBackendsPath: routeContext.localEdge.upstreamBackendsPath,
      brokerSecret: config.collaborationRealtime.localBrokerSecret,
      corsOrigins,
      resolveUpstreamAuthorization:
        routeContext.localEdge.resolveUpstreamAuthorization,
      requireCollaborationRepository,
      requireCollaborationMaterializationRepository: requireRepository,
      resolveActiveLocalUser: (userId) => requireRepository().getUser(userId),
      quarantineCrossIdentitySyncForBackend: async (
        ownerUserId,
        upstreamBackendId
      ) => {
        await requireRepository().quarantineCrossIdentitySyncForUpstreamBackend(
          { userId: ownerUserId },
          upstreamBackendId
        );
      },
      revokeSharedMemoryAuthorityForBackend: async (
        ownerUserId,
        upstreamBackendId
      ) => {
        if (!sharedMemoryAuthorityRepository) return;
        await sharedMemoryAuthorityRepository.revokeBackendEnrollments({
          localOwnerUserId: ownerUserId,
          backendId: upstreamBackendId,
          reason: "upstream_backend_disconnected"
        });
      },
      fetch: routeContext.localEdge.fetch,
      onRemoteNavigationInvalidated: (backendId) => {
        for (const listener of collaborationNavigationInvalidationListeners) {
          listener(backendId);
        }
      }
    });
  }

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
    const errorCodeCandidate =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    const errorCode =
      typeof errorCodeCandidate === "string" &&
      /^[a-z][a-z0-9_]{0,119}$/.test(errorCodeCandidate)
        ? errorCodeCandidate
        : undefined;

    const logBindings = {
      event: {
        name: "http.request.failed",
        category: "http"
      },
      request: {
        id: request.id,
        method: request.method,
        path:
          redactSensitiveRoutePath(
            requestPathname(request),
            request.routeOptions.url
          ) ?? requestPathname(request),
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
      error: statusCode === 500 ? "Internal Server Error" : message,
      ...(errorCode ? { code: errorCode } : {})
    });
  });

  registerOperationalRoutes(app, routeContext, {
    dbPool: pool,
    repository,
    embeddingQueue,
    lcmEmbeddingQueue,
    compactionQueue,
    embeddingCapacityRepository,
    envelopeEncryptionProvider,
    alertFetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    runCompactionInline,
    enqueueEmbedding
  });

  registerBrowserApprovalRoutes(app);
  registerAuthRoutes(app, routeContext);
  registerAnalyticsRoutes(app, routeContext);
  registerApiTokenRoutes(app, routeContext);
  registerTeamRoutes(app, routeContext);
  registerCollaborationRoutes(app, {
    requireCollaborationRepository,
    authenticateSessionOrDeviceCredential:
      authHelpers.authenticateSessionOrDeviceCredential,
    readRateLimit: rateLimitHandlers.memoryRead,
    writeRateLimit: rateLimitHandlers.memoryWrite,
    admission: routeContext.collaboration.admission
  });
  registerHighRiskRoutes(app, {
    requireRepository,
    hashSecret,
    authenticateSessionContext: authHelpers.authenticateSessionContext,
    authenticateDeviceCredential: authHelpers.authenticateDeviceCredential,
    rateLimit: {
      browser: rateLimitHandlers.auth,
      deviceRead: rateLimitHandlers.memoryRead,
      deviceWrite: rateLimitHandlers.memoryWrite
    }
  });
  registerSharedMemoryRoutes(app, {
    requireSharedMemoryRepository: requireRepository,
    requireTeamConversationSourceRepository: requireRepository,
    requireCollaborationRepository,
    requireHighRiskRepository: requireRepository,
    authenticateSession: authHelpers.authenticateSession,
    authenticateSessionContext: authHelpers.authenticateSessionContext,
    authenticateDeviceCredential: authHelpers.authenticateDeviceCredential,
    authenticateSessionOrDeviceCredential:
      authHelpers.authenticateSessionOrDeviceCredential,
    readRateLimit: rateLimitHandlers.memoryRead,
    writeRateLimit: rateLimitHandlers.memoryWrite
  });
  teamConversationSourceService = createTeamConversationSourceService({
    app,
    context: routeContext,
    pool,
    privacyRepository: privacyClassificationRepository,
    teamEncryptionProvider: teamEnvelopeEncryptionProvider
  });
  registerRetentionRoutes(app, {
    requireRetentionRepository,
    requireHighRiskRepository: requireRepository,
    authenticateSessionContext: authHelpers.authenticateSessionContext,
    authenticateDeviceCredential: authHelpers.authenticateDeviceCredential,
    writeRateLimit: rateLimitHandlers.memoryWrite
  });
  registerLocalEdgeRoutes(app, routeContext);
  registerCrossIdentitySyncRoutes(app, routeContext);
  registerConversationSourceReplicationRoutes(app, routeContext);
  registerConversationSourceRestoreRoutes(app, routeContext);
  registerManagedConversationRoutes(app, routeContext);
  registerManagedConversationRunnerRoutes(app, routeContext);
  registerPersonalDeviceSyncRoutes(app, routeContext);
  registerPersonalDeviceSyncRelayRoutes(app, routeContext);
  registerCaptureRoutes(app, routeContext);
  registerCuratedMemoryRoutes(app, routeContext);
  registerConversationSourceJournalRoutes(
    app,
    routeContext,
    undefined,
    options.conversationSourceSignerFactory
  );
  registerHistoricalImportRoutes(app, routeContext);
  registerRawConversationRoutes(app, routeContext);
  registerRecallRoutes(app, routeContext);
  registerLocalAgentSettingsRoutes(app, routeContext);
  registerQuestionRoutes(app, routeContext);
  registerLcmRoutes(app, routeContext);
  registerGraphRoutes(app, routeContext);
  graphStreamService.registerRoutes();
  collaborationRealtimeService?.registerRoutes();
  collaborationRealtimeBroker?.registerRoutes();

  return app;
};
