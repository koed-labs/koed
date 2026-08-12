import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import pg from "pg";
import {
  createDbPool,
  createMemorySourceRepository,
  getLatestMigrationTimestamp,
  inspectDatabaseReadiness,
  runDbMigrations,
  type ActorContext,
  type MemorySourceRepository
} from "@koed/db";
import { resolveSupportedEmbeddingModelConfig } from "@koed/shared";
import type { MemorySearchResult, RetrievalMetadata } from "@koed/core";
import type { AtifSanitizationResult } from "./atif/index.js";
import {
  ExperienceReplayDatabaseTemplates,
  type FrozenDatabaseAttestation
} from "./database-templates.js";
import {
  startDeterministicEmbeddingService,
  type DeterministicEmbeddingServiceHandle
} from "./deterministic-embedding.js";
import { immutableHash } from "./core/hash.js";
import {
  importNormalizedAttempt,
  type NormalizedProjectionAttestation
} from "./ingestion.js";
import { assertLoopbackUrl } from "./isolation.js";
import {
  createProductionNormalizedImportClient,
  awaitExperienceReplayProductState,
  type ExperienceReplayProductStateAttestation
} from "./product-state.js";
import {
  startProductApiProcess,
  type ProductApiCloseAttestation,
  type ProductApiHandle
} from "./product-api-process.js";

const SMOKE_MODEL = "qwen3-0.6b";
const SMOKE_DIMENSIONS = 1024;
const BATCH_SIZE = 32;

export interface RecordedEmbeddingServiceOptions {
  url: string;
  token: string;
  model: string;
  dimensions: number;
  modelArtifactHash: string;
}

export interface ScheduledLcmJobAttestation {
  nodeIds: string[];
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LocalProductAdapterOptions {
  runId: string;
  mode: "smoke" | "recorded";
  postgres: {
    /** Credential-free URL of the caller-owned loopback admin database. */
    adminUrl: string;
    user: string;
    password: string;
  };
  recordedEmbedding?: RecordedEmbeddingServiceOptions;
  readinessTimeoutMs?: number;
  readinessIntervalMs?: number;
  productApiEnvironment?: NodeJS.ProcessEnv;
  lcmSummaryConfig?: { model: string; promptVersion: string };
  runScheduledLcmJobs?: (input: {
    repository: MemorySourceRepository;
    actor: ActorContext;
    scheduledEventIds: readonly string[];
  }) => Promise<ScheduledLcmJobAttestation>;
}

export interface LocalProductDatabaseAttestation {
  databaseName: string;
  currentDatabase: string;
  migrationsCurrent: true;
  latestMigrationTimestamp: number;
  postgresVersionNum: number;
  pgvectorVersion: string;
  rows: {
    users: number;
    apiTokens: number;
    capturedSessions: number;
    conversationItems: number;
    memoryEvents: number;
    memoryNodes: number;
    embeddingChunks: number;
  };
  stateHash: string;
}

export interface LocalProductIdentityAttestation {
  user: { id: string; email: string };
  apiToken: { id: string; ownerUserId: string; tokenPrefix: string };
  authenticatedSessionRead: {
    sessionId: string;
    ownerUserId: string;
    visibility: "personal";
    projectId: string;
  };
}

export interface LocalProductEmbeddingAttestation {
  transport: "loopback-http";
  provider: "deterministic-smoke" | "configured-recorded";
  serviceUrl: string;
  model: string;
  dimensions: number;
  modelArtifactHash: string;
  health: {
    status: "ok";
    model: string;
    dimensions: number;
    modelArtifactHash: string;
    authRequired: boolean | null;
    authValid: boolean | null;
  };
  preparationCalls: number;
  preparationTexts: number;
}

export interface LocalProductTemplateAttestation {
  schema: "koed-experience-replay-local-product-template-v1";
  condition: "empty" | "placebo" | "relevant";
  taskDigest: string;
  sourceTaskDigest: string | null;
  projectId: string;
  project: {
    id: string;
    cwd: string;
    anchorSessionId: string;
    ownerUserId: string;
    visibility: "personal";
  };
  database: LocalProductDatabaseAttestation;
  identity: LocalProductIdentityAttestation;
  embedding: LocalProductEmbeddingAttestation;
  normalizedImport: {
    sessionId: string;
    conversationItemIds: string[];
    projection: NormalizedProjectionAttestation;
  } | null;
  readiness: ExperienceReplayProductStateAttestation;
  scheduledLcmJobs: ScheduledLcmJobAttestation | null;
  frozenDatabase: FrozenDatabaseAttestation;
  frozenAt: string;
}

export interface LocalProductTemplateHandle {
  templateId: string;
  sourceStateHash: string;
  attestation: LocalProductTemplateAttestation;
}

export interface LocalProductReplayProvision {
  cloneId: string;
  databaseUrl: string;
  actor: ActorContext;
  authorization: string;
  api: ProductApiHandle;
  telemetry?(): {
    embeddings: { calls: number; tokens: number | null; durationMs: number };
  };
  templateAttestationHash: string;
  close(): Promise<{ api: ProductApiCloseAttestation }>;
}

interface EmbeddingRuntime {
  provider: LocalProductEmbeddingAttestation["provider"];
  url: string;
  token: string;
  model: string;
  dimensions: number;
  modelArtifactHash: string;
  health: LocalProductEmbeddingAttestation["health"];
  close(): Promise<void>;
  metrics(): {
    calls: number;
    texts: number;
    tokens: number | null;
    durationMs: number;
  };
}

interface RegisteredTemplate {
  attestationHash: string;
}

const hashSecret = (pepper: string, secret: string): string =>
  createHash("sha256").update(`${pepper}${secret}`).digest("hex");

const safeRunPart = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 10);

const count = async (pool: pg.Pool, table: string): Promise<number> => {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`
  );
  return Number(result.rows[0]?.count ?? "0");
};

const databaseUrl = (
  adminUrl: string,
  user: string,
  password: string,
  databaseName: string
): string => {
  const url = new URL(adminUrl);
  url.username = user;
  url.password = password;
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const readJson = async (response: Response): Promise<unknown> => {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Embedding Service returned HTTP ${response.status}`);
  }
  return value;
};

export const createRecordedEmbeddingRuntime = async (
  configured: RecordedEmbeddingServiceOptions
): Promise<EmbeddingRuntime> => {
  const url = assertLoopbackUrl(configured.url, "Recorded Embedding Service")
    .toString()
    .replace(/\/+$/, "");
  if (!configured.token)
    throw new Error("Recorded Embedding Service token is required");
  const configuredModel = resolveSupportedEmbeddingModelConfig(
    configured.model
  );
  if (
    configured.dimensions !== configuredModel.dimensions ||
    !configured.modelArtifactHash.trim()
  ) {
    throw new Error(
      "Recorded Embedding Service config has invalid model metadata"
    );
  }
  const health = await readJson(
    await fetch(`${url}/health`, {
      headers: { "x-koed-embedding-token": configured.token }
    })
  );
  const record = health as Record<string, unknown>;
  const model =
    typeof record.modelKey === "string"
      ? record.modelKey
      : typeof record.model === "string"
        ? record.model
        : null;
  const dimensions = record.dimensions;
  const artifactHash =
    typeof record.artifactHash === "string" ? record.artifactHash : null;
  if (
    record.status !== "ok" ||
    !model ||
    !Number.isSafeInteger(dimensions) ||
    (record.authRequired === true && record.authValid !== true)
  ) {
    throw new Error(
      "Recorded Embedding Service health lacks exact model metadata"
    );
  }
  if (
    model !== configuredModel.key ||
    dimensions !== configured.dimensions ||
    artifactHash !== configured.modelArtifactHash
  ) {
    throw new Error(
      "Recorded Embedding Service health does not match resolved configuration"
    );
  }
  let calls = 0;
  let texts = 0;
  let tokens = 0;
  let durationMs = 0;
  const proxy = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const rawValue of request) {
        const value: unknown = rawValue;
        if (!Buffer.isBuffer(value)) {
          throw new Error("Embedding observation received a non-buffer chunk");
        }
        const chunk = value;
        bytes += chunk.byteLength;
        if (bytes > 16 * 1024 * 1024)
          throw new Error("Embedding observation request exceeded limit");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const started = performance.now();
      const upstream = await fetch(`${url}${request.url ?? "/"}`, {
        method: request.method,
        headers: {
          ...(body.byteLength ? { "content-type": "application/json" } : {}),
          "x-koed-embedding-token": configured.token
        },
        ...(body.byteLength ? { body } : {})
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      if (request.method === "POST" && request.url === "/embed") {
        let input: unknown;
        let output: unknown;
        try {
          input = JSON.parse(body.toString("utf8"));
          output = JSON.parse(payload.toString("utf8"));
        } catch (error) {
          throw new Error("Embedding observation encountered corrupt JSON", {
            cause: error
          });
        }
        const inputTexts = (input as { texts?: unknown }).texts;
        const measured = (output as { measuredTokens?: unknown })
          .measuredTokens;
        if (
          !Array.isArray(inputTexts) ||
          !Number.isSafeInteger(measured) ||
          (measured as number) < 0
        )
          throw new Error(
            "Embedding provider omitted mandatory measured token usage"
          );
        calls += 1;
        texts += inputTexts.length;
        tokens += measured as number;
        durationMs += performance.now() - started;
      }
      response.writeHead(
        upstream.status,
        Object.fromEntries(upstream.headers.entries())
      );
      response.end(payload);
    })().catch(() => {
      if (!response.headersSent)
        response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: "embedding observation failed closed" })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      proxy.off("error", reject);
      resolve();
    });
  });
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string")
    throw new Error("Embedding observer did not bind");
  const observedUrl = `http://127.0.0.1:${proxyAddress.port}`;
  return {
    provider: "configured-recorded",
    url: observedUrl,
    token: configured.token,
    model,
    dimensions: Number(dimensions),
    modelArtifactHash: configured.modelArtifactHash,
    health: {
      status: "ok",
      model,
      dimensions: Number(dimensions),
      modelArtifactHash: configured.modelArtifactHash,
      authRequired:
        typeof record.authRequired === "boolean" ? record.authRequired : null,
      authValid: typeof record.authValid === "boolean" ? record.authValid : null
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve()))
      ),
    metrics: () => ({ calls, texts, tokens, durationMs })
  } as EmbeddingRuntime;
};

const smokeEmbeddingRuntime = async (): Promise<EmbeddingRuntime> => {
  const service: DeterministicEmbeddingServiceHandle =
    await startDeterministicEmbeddingService({
      token: randomBytes(24).toString("base64url"),
      model: SMOKE_MODEL,
      dimensions: SMOKE_DIMENSIONS
    });
  const health = await readJson(await fetch(`${service.url}/health`));
  const healthRecord = health as Record<string, unknown>;
  if (
    healthRecord.status !== "ok" ||
    healthRecord.model !== service.model ||
    healthRecord.dimensions !== service.dimensions
  ) {
    await service.close();
    throw new Error("Deterministic Embedding Service health identity mismatch");
  }
  const modelArtifactHash = resolveSupportedEmbeddingModelConfig(
    service.model
  ).defaultArtifactSha256;
  return {
    provider: "deterministic-smoke",
    url: service.url,
    token: service.token,
    model: service.model,
    dimensions: service.dimensions,
    modelArtifactHash,
    health: {
      status: "ok",
      model: service.model,
      dimensions: service.dimensions,
      modelArtifactHash,
      authRequired: null,
      authValid: null
    },
    close: () => service.close(),
    metrics: () => {
      const metrics = service.metrics();
      return {
        calls: metrics.calls,
        texts: metrics.texts,
        tokens: metrics.measuredTokens,
        durationMs: 0
      };
    }
  };
};

const embedThroughService = async (
  runtime: EmbeddingRuntime,
  texts: string[]
): Promise<{ model: string; dimensions: number; vectors: number[][] }> => {
  const payload = (await readJson(
    await fetch(`${runtime.url}/embed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-koed-embedding-token": runtime.token
      },
      body: JSON.stringify({ texts })
    })
  )) as Record<string, unknown>;
  if (
    typeof payload.model !== "string" ||
    !Number.isSafeInteger(payload.dimensions) ||
    !Array.isArray(payload.vectors) ||
    payload.vectors.length !== texts.length ||
    !payload.vectors.every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length === runtime.dimensions &&
        vector.every(
          (number) => typeof number === "number" && Number.isFinite(number)
        )
    ) ||
    payload.model !== runtime.model ||
    payload.dimensions !== runtime.dimensions
  ) {
    throw new Error(
      "Embedding Service returned vectors with wrong identity or shape"
    );
  }
  return payload as unknown as {
    model: string;
    dimensions: number;
    vectors: number[][];
  };
};

const embedPendingSources = async (
  repository: MemorySourceRepository,
  runtime: EmbeddingRuntime
): Promise<void> => {
  for (;;) {
    const sources = await repository.listSourcesNeedingEmbeddings(BATCH_SIZE);
    if (sources.length === 0) return;
    const embedded = await embedThroughService(
      runtime,
      sources.map((source) => source.text)
    );
    const model = resolveSupportedEmbeddingModelConfig(embedded.model);
    for (const [index, source] of sources.entries()) {
      await repository.upsertSourceEmbedding({
        source,
        model: model.key,
        modelArtifactHash: runtime.modelArtifactHash,
        dimensions: embedded.dimensions,
        version: model.key,
        tokenizer: model.tokenizer,
        inputTransform: model.inputTransform,
        pooling: model.pooling,
        normalization: model.normalization,
        vector: embedded.vectors[index]!
      });
    }
  }
};

const apiBackedReadinessRepository = (
  repository: MemorySourceRepository,
  api: ProductApiHandle,
  authorization: string
): MemorySourceRepository => ({
  ...repository,
  searchMemoryNodes: async (
    _actor: ActorContext,
    input: Parameters<MemorySourceRepository["searchMemoryNodes"]>[1]
  ) => {
    const response = (await api.request({
      method: "POST",
      path: "/v1/memory/search",
      headers: { authorization },
      body: {
        query: input.query,
        retrieval_scope: input.scope,
        search_domain: input.searchDomain ?? "global",
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.projectId ? { project_id: input.projectId } : {}),
        limit: input.limit ?? 10,
        strict_limit: input.strictLimit ?? true
      }
    })) as {
      hits?: unknown;
      retrieval?: unknown;
    };
    if (!Array.isArray(response.hits) || !response.retrieval) {
      throw new Error("Product Recall returned no structured retrieval proof");
    }
    return {
      results: response.hits as MemorySearchResult[],
      metadata: response.retrieval as RetrievalMetadata
    };
  }
});

export class LocalExperienceReplayProductAdapter {
  private readonly templates: ExperienceReplayDatabaseTemplates;
  private readonly runPart: string;
  private readonly ownershipId: string;
  private readonly instancePart = randomBytes(4).toString("hex");
  private readonly registeredTemplates = new Map<string, RegisteredTemplate>();
  private readonly activeClones = new Map<string, ProductApiHandle>();
  private sequence = 0;
  private embedding?: EmbeddingRuntime;
  private closed = false;

  constructor(private readonly options: LocalProductAdapterOptions) {
    assertLoopbackUrl(options.postgres.adminUrl, "Benchmark PostgreSQL admin");
    if (!options.postgres.user || !options.postgres.password) {
      throw new Error("Benchmark PostgreSQL credentials are required");
    }
    if (options.mode === "recorded" && !options.recordedEmbedding) {
      throw new Error("Recorded runs require a configured Embedding Service");
    }
    if (options.mode === "smoke" && options.recordedEmbedding) {
      throw new Error(
        "Smoke runs must use the deterministic HTTP Embedding Service"
      );
    }
    this.runPart = safeRunPart(options.runId);
    this.ownershipId = createHash("sha256").update(options.runId).digest("hex");
    this.templates = new ExperienceReplayDatabaseTemplates({
      adminDatabaseUrl: options.postgres.adminUrl,
      user: options.postgres.user,
      password: options.postgres.password,
      ownerId: this.ownershipId
    });
  }

  private nextName(kind: "stage" | "template" | "clone"): string {
    this.sequence += 1;
    return `koed_eval_${this.runPart}_${this.instancePart}_${String(this.sequence).padStart(4, "0")}_${kind}`;
  }

  private async embeddingRuntime(): Promise<EmbeddingRuntime> {
    this.embedding ??=
      this.options.mode === "smoke"
        ? await smokeEmbeddingRuntime()
        : await createRecordedEmbeddingRuntime(this.options.recordedEmbedding!);
    return this.embedding;
  }

  private apiEnvironment(
    url: string,
    runtime: EmbeddingRuntime,
    pepper: string
  ): NodeJS.ProcessEnv {
    return {
      ...this.options.productApiEnvironment,
      NODE_ENV: "test",
      DATABASE_URL: url,
      API_TOKEN_PEPPER: pepper,
      WORK_QUEUE_BACKEND: "local",
      CACHE_STORE: "memory",
      RATE_LIMIT_STORE: "memory",
      KOED_RUNTIME_MODE: "external",
      KOED_DEPLOYMENT_PROFILE: "personal_self_hosted",
      EMBEDDING_SERVICE_URL: runtime.url,
      EMBEDDING_SERVICE_TOKEN: runtime.token,
      EMBEDDING_MODEL: runtime.model
    };
  }

  async prepareTemplate(input: {
    condition: "empty" | "placebo" | "relevant";
    taskDigest: string;
    sourceTaskDigest: string | null;
    sourceAttemptId?: string;
    sanitizedSource: AtifSanitizationResult | null;
    recallQuery: string;
    signal?: AbortSignal;
  }): Promise<LocalProductTemplateHandle> {
    if (input.signal?.aborted)
      throw new Error("Template preparation was cancelled");
    if (this.closed) throw new Error("Local product adapter is closed");
    const hasSource = input.condition !== "empty";
    if (
      hasSource !== Boolean(input.sanitizedSource) ||
      hasSource !== Boolean(input.sourceTaskDigest) ||
      hasSource !== Boolean(input.sourceAttemptId)
    ) {
      throw new Error("Template condition and sanitized source do not agree");
    }
    if (!input.recallQuery.trim())
      throw new Error("Semantic Recall probe is required");

    const runtime = await this.embeddingRuntime();
    const stageName = this.nextName("stage");
    const templateName = this.nextName("template");
    const projectId = `eval://experience-replay/${this.runPart}/${safeRunPart(
      input.taskDigest
    )}/${input.condition}`;
    const projectCwd = path.join(
      os.tmpdir(),
      "koed-eval",
      this.runPart,
      safeRunPart(input.taskDigest),
      input.condition
    );
    await this.templates.createRunDatabase(stageName);
    const url = databaseUrl(
      this.options.postgres.adminUrl,
      this.options.postgres.user,
      this.options.postgres.password,
      stageName
    );
    const pool = createDbPool({ connectionString: url });
    let api: ProductApiHandle | undefined;
    try {
      await runDbMigrations(pool);
      const latestMigrationTimestamp = await getLatestMigrationTimestamp();
      const readiness = await inspectDatabaseReadiness(pool, {
        expectedLatestMigrationTimestamp: latestMigrationTimestamp
      });
      if (
        !readiness.reachable ||
        !readiness.migrationsCurrent ||
        !readiness.postgresCompatible ||
        !readiness.pgvectorInstalled ||
        !readiness.postgresVersionNum ||
        !readiness.pgvectorVersion
      ) {
        throw new Error(
          "Migrated eval database did not pass PostgreSQL readiness"
        );
      }
      const repository = createMemorySourceRepository(pool);
      const token = `cmt_${randomBytes(32).toString("base64url")}`;
      const pepper = randomBytes(32).toString("base64url");
      const email = `${this.runPart}-${this.sequence}@experience-replay.koed.local`;
      const user = await repository.createUser({
        email,
        displayName: `Experience Replay ${input.condition}`
      });
      const apiToken = await repository.createApiToken({
        ownerUserId: user.id,
        name: `experience-replay-${input.condition}`,
        tokenHash: hashSecret(pepper, token),
        tokenPrefix: token.slice(0, 12),
        scopes: [],
        audit: { actorUserId: user.id, actorType: "user" }
      });
      const actor = { userId: user.id };
      api = await startProductApiProcess({
        environment: this.apiEnvironment(url, runtime, pepper)
      });
      const authorization = `Bearer ${token}`;
      const importClient = createProductionNormalizedImportClient({
        api,
        repository,
        actor,
        authorization
      });
      const projectAnchor = await importClient.createSession({
        projectId,
        externalSessionId: `project-anchor-${safeRunPart(projectId)}`,
        sourceRuntime: "codex-cli",
        captureMethod: "api",
        cwd: projectCwd,
        idempotencyKey: `experience-replay-project:${safeRunPart(projectId)}`,
        sourceHash: `sha256:${createHash("sha256").update(projectId).digest("hex")}`,
        metadata: { sourceKind: "benchmark_project_anchor" }
      });
      if (projectAnchor.skipped || !projectAnchor.session?.id) {
        throw new Error("Dedicated benchmark Project was not admitted");
      }
      const authenticatedSessionResponse = (await api.request({
        method: "GET",
        path: `/v1/sessions/${projectAnchor.session.id}?project_id=${encodeURIComponent(
          projectId
        )}`,
        headers: { authorization }
      })) as { session?: Record<string, unknown> };
      const authenticatedSession = authenticatedSessionResponse.session;
      const authenticatedProject = authenticatedSession?.project as
        | Record<string, unknown>
        | undefined;
      if (
        authenticatedSession?.id !== projectAnchor.session.id ||
        authenticatedSession.ownerUserId !== user.id ||
        authenticatedSession.visibility !== "personal" ||
        authenticatedProject?.id !== projectId
      ) {
        throw new Error("Authenticated Project identity proof did not match");
      }
      const authenticatedSessionRead = {
        sessionId: projectAnchor.session.id,
        ownerUserId: user.id,
        visibility: "personal" as const,
        projectId
      };

      let normalizedImport: LocalProductTemplateAttestation["normalizedImport"] =
        null;
      if (input.sanitizedSource) {
        normalizedImport = await importNormalizedAttempt({
          client: importClient,
          projectId,
          projectCwd,
          taskDigest: input.sourceTaskDigest!,
          sourceAttemptId: input.sourceAttemptId!,
          items: input.sanitizedSource.normalizedItems,
          sanitizationManifest: input.sanitizedSource.manifest
        });
      }

      await embedPendingSources(repository, runtime);
      const scheduledLcmEventIds =
        normalizedImport?.projection.scheduledLcmEventIds ?? [];
      let scheduledLcmJobs: ScheduledLcmJobAttestation | null = null;
      if (scheduledLcmEventIds.length > 0) {
        if (
          !this.options.runScheduledLcmJobs ||
          !this.options.lcmSummaryConfig
        ) {
          throw new Error(
            "Projection scheduled LCM work but no Local AI Runtime job runner was configured"
          );
        }
        scheduledLcmJobs = await this.options.runScheduledLcmJobs({
          repository,
          actor,
          scheduledEventIds: scheduledLcmEventIds
        });
        if (
          scheduledLcmJobs.nodeIds.length === 0 ||
          scheduledLcmJobs.model !== this.options.lcmSummaryConfig.model ||
          scheduledLcmJobs.promptVersion !==
            this.options.lcmSummaryConfig.promptVersion ||
          !Number.isSafeInteger(scheduledLcmJobs.inputTokens) ||
          !Number.isSafeInteger(scheduledLcmJobs.outputTokens) ||
          scheduledLcmJobs.inputTokens < 0 ||
          scheduledLcmJobs.outputTokens < 0
        ) {
          throw new Error(
            "LCM job runner returned an invalid structured attestation"
          );
        }
        await embedPendingSources(repository, runtime);
      }
      const productReadiness = await awaitExperienceReplayProductState({
        repository: apiBackedReadinessRepository(
          repository,
          api,
          authorization
        ),
        expectation: {
          condition: input.condition,
          actor,
          projectId,
          ...(normalizedImport
            ? {
                sessionId: normalizedImport.sessionId,
                conversationItems: input.sanitizedSource!.normalizedItems.map(
                  (item, index) => ({
                    id: normalizedImport!.conversationItemIds[index]!,
                    canonicalStableItemId: item.sourceIdentity,
                    sourceSequence: item.sequence,
                    sourceEventType: item.type
                  })
                ),
                projectionDispositions:
                  normalizedImport.projection.dispositions.map((scope) => ({
                    eventId: scope.eventId,
                    includeInEmbedding: scope.includeInEmbedding,
                    includeInLcm: scope.includeInLcm
                  })),
                scheduledLcmEventIds
              }
            : {}),
          embedding: {
            model: runtime.model,
            dimensions: runtime.dimensions,
            version: runtime.model
          },
          recall: {
            query: input.recallQuery,
            expectedSourceIds:
              normalizedImport?.projection.dispositions
                .filter((scope) => scope.includeInEmbedding)
                .map((scope) => scope.eventId) ?? []
          }
        },
        timeoutMs: this.options.readinessTimeoutMs,
        intervalMs: this.options.readinessIntervalMs
      });
      if (
        scheduledLcmJobs &&
        immutableHash([...scheduledLcmJobs.nodeIds].sort()) !==
          immutableHash([...productReadiness.summarizedLcmNodeIds].sort())
      ) {
        throw new Error(
          "LCM job attestation does not match database-observed summarized nodes"
        );
      }

      const rows = {
        users: await count(pool, "users"),
        apiTokens: await count(pool, "api_tokens"),
        capturedSessions: await count(pool, "sessions"),
        conversationItems: await count(pool, "conversation_items"),
        memoryEvents: await count(pool, "memory_events"),
        memoryNodes: await count(pool, "memory_nodes"),
        embeddingChunks: await count(pool, "memory_embeddings_1024")
      };
      const currentDatabase = (
        await pool.query<{ current_database: string }>(
          "SELECT current_database() AS current_database"
        )
      ).rows[0]!.current_database;
      const stateHash = immutableHash({
        condition: input.condition,
        taskDigest: input.taskDigest,
        sourceTaskDigest: input.sourceTaskDigest,
        projectId,
        rows,
        conversationItemIds: normalizedImport?.conversationItemIds ?? [],
        projection: normalizedImport?.projection ?? null,
        projectAnchor: authenticatedSessionRead,
        scheduledLcmJobs,
        readiness: productReadiness
      });
      const database: LocalProductDatabaseAttestation = {
        databaseName: stageName,
        currentDatabase,
        migrationsCurrent: true,
        latestMigrationTimestamp,
        postgresVersionNum: readiness.postgresVersionNum,
        pgvectorVersion: readiness.pgvectorVersion,
        rows,
        stateHash
      };
      const identity: LocalProductIdentityAttestation = {
        user: { id: user.id, email },
        apiToken: {
          id: apiToken.id,
          ownerUserId: apiToken.ownerUserId,
          tokenPrefix: apiToken.tokenPrefix
        },
        authenticatedSessionRead
      };
      const metrics = runtime.metrics();
      await api.close();
      api = undefined;
      await pool.end();
      await this.templates.createTemplate({
        templateName,
        sourceDatabaseName: stageName
      });
      const frozenDatabase = await this.templates.attestFrozen(templateName);
      await this.templates.drop(stageName);
      const attestation: LocalProductTemplateAttestation = {
        schema: "koed-experience-replay-local-product-template-v1",
        condition: input.condition,
        taskDigest: input.taskDigest,
        sourceTaskDigest: input.sourceTaskDigest,
        projectId,
        project: {
          id: projectId,
          cwd: projectCwd,
          anchorSessionId: projectAnchor.session.id,
          ownerUserId: user.id,
          visibility: "personal"
        },
        database,
        identity,
        embedding: {
          transport: "loopback-http",
          provider: runtime.provider,
          serviceUrl: runtime.url,
          model: runtime.model,
          dimensions: runtime.dimensions,
          modelArtifactHash: runtime.modelArtifactHash,
          health: runtime.health,
          preparationCalls: metrics.calls,
          preparationTexts: metrics.texts
        },
        normalizedImport,
        readiness: productReadiness,
        scheduledLcmJobs,
        frozenDatabase,
        frozenAt: new Date().toISOString()
      };
      const attestationHash = immutableHash(attestation);
      this.registeredTemplates.set(templateName, { attestationHash });
      return {
        templateId: templateName,
        sourceStateHash: stateHash,
        attestation
      };
    } catch (error) {
      if (api) await api.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      // Only the explicitly run-owned stage is eligible for this cleanup.
      await this.templates.drop(stageName).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Re-attests a credential-free persisted handle and adopts its surviving
   * frozen database. No preparation token or pepper crosses the restart.
   */
  async adoptTemplate(
    template: LocalProductTemplateHandle
  ): Promise<LocalProductTemplateHandle> {
    if (this.closed) throw new Error("Local product adapter is closed");
    const { attestation } = template;
    if (
      attestation.schema !==
        "koed-experience-replay-local-product-template-v1" ||
      attestation.frozenDatabase.name !== template.templateId ||
      attestation.database.stateHash !== template.sourceStateHash ||
      attestation.taskDigest.length === 0 ||
      attestation.project.id !== attestation.projectId ||
      attestation.project.ownerUserId !== attestation.identity.user.id ||
      attestation.identity.apiToken.ownerUserId !==
        attestation.identity.user.id ||
      attestation.identity.authenticatedSessionRead.ownerUserId !==
        attestation.identity.user.id ||
      attestation.identity.authenticatedSessionRead.projectId !==
        attestation.projectId
    ) {
      throw new Error(
        "Persisted template attestation is internally inconsistent"
      );
    }
    const frozen = await this.templates.adoptFrozenTemplate(
      template.templateId
    );
    if (
      frozen.name !== attestation.frozenDatabase.name ||
      frozen.allowConnections !== attestation.frozenDatabase.allowConnections ||
      frozen.isTemplate !== attestation.frozenDatabase.isTemplate
    ) {
      throw new Error(
        "Persisted template no longer matches its frozen attestation"
      );
    }
    this.registeredTemplates.set(template.templateId, {
      attestationHash: immutableHash(attestation)
    });
    return template;
  }

  private async attestCloneState(
    pool: pg.Pool,
    template: LocalProductTemplateHandle
  ): Promise<void> {
    const expected = template.attestation;
    const rows = {
      users: await count(pool, "users"),
      apiTokens: await count(pool, "api_tokens"),
      capturedSessions: await count(pool, "sessions"),
      conversationItems: await count(pool, "conversation_items"),
      memoryEvents: await count(pool, "memory_events"),
      memoryNodes: await count(pool, "memory_nodes"),
      embeddingChunks: await count(pool, "memory_embeddings_1024")
    };
    if (immutableHash(rows) !== immutableHash(expected.database.rows)) {
      throw new Error("Adopted template database row attestation changed");
    }
    const identity = await pool.query<{
      user_exists: boolean;
      token_exists: boolean;
      anchor_exists: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM users WHERE id = $1 AND email = $3
         ) AS user_exists,
         EXISTS (
           SELECT 1 FROM api_tokens
           WHERE id = $2 AND owner_user_id = $1 AND token_prefix = $4
         ) AS token_exists,
         EXISTS (
           SELECT 1 FROM sessions
           WHERE id = $5 AND owner_user_id = $1
             AND visibility = 'personal' AND cwd = $6
         ) AS anchor_exists`,
      [
        expected.identity.user.id,
        expected.identity.apiToken.id,
        expected.identity.user.email,
        expected.identity.apiToken.tokenPrefix,
        expected.project.anchorSessionId,
        expected.project.cwd
      ]
    );
    if (
      !identity.rows[0]?.user_exists ||
      !identity.rows[0]?.token_exists ||
      !identity.rows[0]?.anchor_exists
    ) {
      throw new Error("Adopted template database identity attestation changed");
    }
  }

  async cloneForReplay(
    template: LocalProductTemplateHandle
  ): Promise<LocalProductReplayProvision> {
    if (this.closed) throw new Error("Local product adapter is closed");
    let registration = this.registeredTemplates.get(template.templateId);
    if (!registration) {
      await this.adoptTemplate(template);
      registration = this.registeredTemplates.get(template.templateId)!;
    }
    if (immutableHash(template.attestation) !== registration.attestationHash) {
      throw new Error("Template attestation changed after freezing");
    }
    const runtime = await this.embeddingRuntime();
    const cloneId = this.nextName("clone");
    await this.templates.cloneTemplate({
      templateName: template.templateId,
      cloneName: cloneId
    });
    const url = databaseUrl(
      this.options.postgres.adminUrl,
      this.options.postgres.user,
      this.options.postgres.password,
      cloneId
    );
    const token = `cmt_${randomBytes(32).toString("base64url")}`;
    const pepper = randomBytes(32).toString("base64url");
    const actor = { userId: template.attestation.identity.user.id };
    const clonePool = createDbPool({ connectionString: url });
    let api: ProductApiHandle;
    try {
      await this.attestCloneState(clonePool, template);
      const repository = createMemorySourceRepository(clonePool);
      await repository.createApiToken({
        ownerUserId: actor.userId,
        name: `experience-replay-clone-${this.instancePart}-${this.sequence}`,
        tokenHash: hashSecret(pepper, token),
        tokenPrefix: token.slice(0, 12),
        scopes: [],
        audit: { actorUserId: actor.userId, actorType: "user" }
      });
      await clonePool.end();
      api = await startProductApiProcess({
        environment: this.apiEnvironment(url, runtime, pepper)
      });
    } catch (error) {
      await clonePool.end().catch(() => undefined);
      await this.templates.drop(cloneId).catch(() => undefined);
      throw error;
    }
    this.activeClones.set(cloneId, api);
    const embeddingBaseline = runtime.metrics();
    let closePromise: Promise<{ api: ProductApiCloseAttestation }> | undefined;
    return {
      cloneId,
      databaseUrl: url,
      actor,
      authorization: `Bearer ${token}`,
      api,
      telemetry: () => {
        const current = runtime.metrics();
        return {
          embeddings: {
            calls: current.calls - embeddingBaseline.calls,
            tokens:
              current.tokens === null || embeddingBaseline.tokens === null
                ? null
                : current.tokens - embeddingBaseline.tokens,
            durationMs: current.durationMs - embeddingBaseline.durationMs
          }
        };
      },
      templateAttestationHash: immutableHash(template.attestation),
      close: () => {
        closePromise ??= (async () => {
          let apiAttestation: ProductApiCloseAttestation | undefined;
          const failures: Error[] = [];
          try {
            apiAttestation = await api.close();
          } catch (error) {
            failures.push(
              error instanceof Error ? error : new Error(String(error))
            );
          }
          try {
            if (this.activeClones.has(cloneId)) {
              await this.templates.drop(cloneId);
            }
          } catch (error) {
            failures.push(
              error instanceof Error ? error : new Error(String(error))
            );
          } finally {
            this.activeClones.delete(cloneId);
          }
          if (failures.length > 0 || !apiAttestation) {
            throw new AggregateError(
              failures,
              `Failed to clean replay provision ${cloneId}`
            );
          }
          return { api: apiAttestation };
        })();
        return closePromise;
      }
    };
  }

  async close({
    preserveTemplates = false
  }: { preserveTemplates?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures: Error[] = [];
    for (const [cloneId, api] of this.activeClones) {
      await api
        .close()
        .catch((error) =>
          failures.push(
            error instanceof Error ? error : new Error(String(error))
          )
        );
      this.activeClones.delete(cloneId);
    }
    await this.templates
      .close({ preserveTemplates })
      .catch((error) =>
        failures.push(error instanceof Error ? error : new Error(String(error)))
      );
    await this.embedding
      ?.close()
      .catch((error) =>
        failures.push(error instanceof Error ? error : new Error(String(error)))
      );
    if (failures.length)
      throw new AggregateError(failures, "Local product cleanup failed");
  }
}

export const createLocalExperienceReplayProductAdapter = (
  options: LocalProductAdapterOptions
): LocalExperienceReplayProductAdapter =>
  new LocalExperienceReplayProductAdapter(options);
