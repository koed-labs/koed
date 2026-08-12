import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { MemorySearchResult } from "@koed/core";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  type EmbeddableSourceRecord,
  type MemorySourceRepository
} from "@koed/db";
import {
  answerWithMemoryWorker,
  resolveMemoryAnswerWorkerConfig,
  type MemoryAnswerRetrievalClient,
  type MemoryAnswerWorkerResponse
} from "@koed/mcp-server";
import { resolveSupportedEmbeddingModelConfig } from "@koed/shared";
import { retrievalSuccessCases, type RetrievalSuccessCase } from "./cases.js";
import {
  scoreRetrievalSuccessRun,
  summarizeRetrievalSuccessBenchmark,
  type RetrievalSuccessBenchmarkSummary,
  type RetrievalSuccessRunInput
} from "./benchmark.js";

const EMBEDDING_MODEL = "qwen3-0.6b";
const EMBEDDING_DIMENSIONS = 1024;
const EMBEDDING_TOKEN = "koed-retrieval-success-eval";
const DEFAULT_DATABASE_ENV = "RETRIEVAL_SUCCESS_DATABASE_URL";
const DEFAULT_SERVICE_EMBED_BATCH_SIZE = 32;

export type EmbeddingProviderOption = "deterministic" | "service";
export type QueryInstructionOption = "env" | "enabled" | "disabled" | "both";

interface EmbeddingResponse {
  model: string;
  dimensions: number;
  vectors: number[][];
}

interface SourceEmbeddingProvider {
  provider: LiveRetrievalSuccessReport["embedding"]["provider"];
  serviceUrl: string;
  serviceToken: string;
  model: string;
  dimensions: number;
  close(): Promise<void>;
  embed(texts: string[]): Promise<EmbeddingResponse>;
}

interface TemporaryDatabase {
  databaseName: string;
  databaseUrl: string;
  drop(): Promise<void>;
}

interface DeterministicEmbeddingServer {
  url: string;
  close(): Promise<void>;
}

export interface LiveRetrievalSuccessOptions {
  databaseUrl?: string;
  keepDatabase?: boolean;
  runs?: number;
  caseIds?: string[];
  outputPath?: string;
  embeddingProvider?: EmbeddingProviderOption;
  embeddingServiceUrl?: string;
  embeddingServiceToken?: string;
  queryInstruction?: QueryInstructionOption;
}

export interface LiveRetrievalSuccessReport {
  suite: "retrieval-success-live";
  generatedAt: string;
  boundaryProfile: "post-koe-166-defaults";
  database: {
    isolation: "temporary_database";
    name: string;
    kept: boolean;
  };
  embedding: {
    provider: "deterministic-local-http" | "service";
    model: string;
    dimensions: number;
  };
  queryInstruction: {
    enabled: boolean | "env";
    instruction?: string;
  };
  cases: string[];
  runInputs: RetrievalSuccessRunInput[];
  summary: RetrievalSuccessBenchmarkSummary;
}

export interface LiveRetrievalSuccessComparisonReport {
  suite: "retrieval-success-live-comparison";
  generatedAt: string;
  boundaryProfile: "post-koe-166-defaults";
  embedding: LiveRetrievalSuccessReport["embedding"];
  cases: string[];
  variants: LiveRetrievalSuccessReport[];
}

const usage = [
  "Usage:",
  "  pnpm --filter @koed/evals eval:retrieval-success:live -- --database-url <postgres-url> [--runs 1] [--case id1,id2] [--out report.json]",
  "  pnpm --filter @koed/evals eval:retrieval-success:live -- --embedding-provider service --embedding-service-url http://127.0.0.1:8000 --embedding-service-token <token> --database-url <postgres-url>",
  "",
  "Options:",
  "  --embedding-provider deterministic|service   Defaults to deterministic.",
  "  --embedding-service-url <url>                 Required for service mode unless EMBEDDING_SERVICE_URL is set.",
  "  --embedding-service-token <token>             Required for service mode unless EMBEDDING_SERVICE_TOKEN is set.",
  "  --query-instruction env|enabled|disabled|both Defaults to env. Use both to run comparable enabled and disabled variants.",
  "",
  `If --database-url is omitted, ${DEFAULT_DATABASE_ENV} is used first, then DATABASE_URL.`,
  "The runner creates a temporary database, applies migrations, seeds benchmark memory, runs real Memory Answer retrieval, scores observed output, and drops the database unless --keep-database is passed.",
  "Docker Compose note: the embedding-service container is internal by default. Run service mode from a compose service on the same network with --embedding-service-url http://embedding-service:8000, or publish/start a local embedding service and point --embedding-service-url at it."
].join("\n");

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const databaseUrlWithName = (
  baseUrl: string,
  databaseName: string
): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

export const maintenanceDatabaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  return url.toString();
};

const createTemporaryDatabase = async (
  baseUrl: string,
  keepDatabase: boolean
): Promise<TemporaryDatabase> => {
  const databaseName = `koed_eval_${process.pid}_${randomUUID().replaceAll(
    "-",
    ""
  )}`;
  const maintenancePool = createDbPool({
    connectionString: maintenanceDatabaseUrl(baseUrl)
  });
  await maintenancePool.query(`create database ${quoteIdent(databaseName)}`);
  await maintenancePool.end();

  const databaseUrl = databaseUrlWithName(baseUrl, databaseName);
  return {
    databaseName,
    databaseUrl,
    async drop() {
      if (keepDatabase) {
        return;
      }
      const pool = createDbPool({
        connectionString: maintenanceDatabaseUrl(baseUrl)
      });
      try {
        await pool.query(
          `drop database if exists ${quoteIdent(databaseName)} with (force)`
        );
      } catch {
        await pool.query(`drop database if exists ${quoteIdent(databaseName)}`);
      } finally {
        await pool.end();
      }
    }
  };
};

const runMigrations = async (databaseUrl: string): Promise<void> => {
  const pool = createDbPool({ connectionString: databaseUrl });
  try {
    await runDbMigrations(pool);
  } finally {
    await pool.end();
  }
};

const hashNumber = (value: string): number =>
  createHash("sha256").update(value).digest().readUInt32BE(0);

const stopWords = new Set([
  "about",
  "after",
  "again",
  "answer",
  "before",
  "being",
  "could",
  "during",
  "enabled",
  "final",
  "found",
  "from",
  "have",
  "into",
  "local",
  "memory",
  "name",
  "note",
  "that",
  "their",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would"
]);

const termsForEmbedding = (text: string): string[] => {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9_'-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !stopWords.has(term));
  return [...new Set(terms)];
};

export const deterministicEmbeddingVector = (text: string): number[] => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  for (const term of termsForEmbedding(text)) {
    const hash = hashNumber(term);
    const index = hash % EMBEDDING_DIMENSIONS;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
};

const readRequestBody = async (
  request: NodeJS.ReadableStream
): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const startDeterministicEmbeddingServer =
  async (): Promise<DeterministicEmbeddingServer> => {
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/embed") {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ detail: "not found" }));
          return;
        }
        if (request.headers["x-koed-embedding-token"] !== EMBEDDING_TOKEN) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ detail: "invalid embedding token" }));
          return;
        }
        const body = JSON.parse(await readRequestBody(request)) as {
          texts?: unknown;
        };
        const texts = Array.isArray(body.texts)
          ? body.texts.map((text) => String(text))
          : [];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
            vectors: texts.map(deterministicEmbeddingVector)
          })
        );
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            detail: error instanceof Error ? error.message : "embedding error"
          })
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start deterministic embedding server");
    }
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          (server as Server).close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        })
    };
  };

const parseEmbeddingResponse = (payload: unknown): EmbeddingResponse => {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (
    typeof record.model !== "string" ||
    typeof record.dimensions !== "number" ||
    !Array.isArray(record.vectors) ||
    !record.vectors.every(
      (vector) =>
        Array.isArray(vector) &&
        vector.every((value) => typeof value === "number")
    )
  ) {
    throw new Error("embedding service returned an invalid response");
  }
  return {
    model: record.model,
    dimensions: record.dimensions,
    vectors: record.vectors as number[][]
  };
};

const postEmbeddings = async (
  embeddingUrl: string,
  embeddingToken: string,
  texts: string[]
): Promise<EmbeddingResponse> => {
  const response = await fetch(`${embeddingUrl.replace(/\/+$/, "")}/embed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-koed-embedding-token": embeddingToken
    },
    body: JSON.stringify({ texts })
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? (payload as { detail?: unknown }).detail
        : undefined;
    throw new Error(
      typeof detail === "string"
        ? detail
        : `embedding service /embed failed with HTTP ${response.status}`
    );
  }
  return parseEmbeddingResponse(payload);
};

const createDeterministicEmbeddingProvider =
  async (): Promise<SourceEmbeddingProvider> => {
    const server = await startDeterministicEmbeddingServer();
    return {
      provider: "deterministic-local-http",
      serviceUrl: server.url,
      serviceToken: EMBEDDING_TOKEN,
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      close: server.close,
      embed: (texts) =>
        Promise.resolve({
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMENSIONS,
          vectors: texts.map(deterministicEmbeddingVector)
        })
    };
  };

export const createServiceEmbeddingProvider = async (input: {
  embeddingServiceUrl?: string;
  embeddingServiceToken?: string;
}): Promise<SourceEmbeddingProvider> => {
  const serviceUrl =
    input.embeddingServiceUrl ?? process.env.EMBEDDING_SERVICE_URL;
  const serviceToken =
    input.embeddingServiceToken ?? process.env.EMBEDDING_SERVICE_TOKEN;
  if (!serviceUrl) {
    throw new Error(
      "Service embedding mode requires --embedding-service-url or EMBEDDING_SERVICE_URL."
    );
  }
  if (!serviceToken) {
    throw new Error(
      "Service embedding mode requires --embedding-service-token or EMBEDDING_SERVICE_TOKEN."
    );
  }

  const healthResponse = await fetch(
    `${serviceUrl.replace(/\/+$/, "")}/health`,
    {
      headers: { "x-koed-embedding-token": serviceToken }
    }
  );
  const health = (await healthResponse.json().catch(() => ({}))) as {
    status?: string;
    modelKey?: string;
    dimensions?: number;
    authRequired?: boolean;
    authValid?: boolean;
    detail?: string;
  };
  if (!healthResponse.ok || health.status !== "ok") {
    throw new Error(
      health.detail ??
        `embedding service is not healthy: HTTP ${healthResponse.status}, status ${health.status ?? "unknown"}`
    );
  }
  if (health.authRequired && !health.authValid) {
    throw new Error("embedding service rejected the configured token");
  }
  if (!health.modelKey || !health.dimensions) {
    throw new Error(
      "embedding service /health returned missing model metadata"
    );
  }

  return {
    provider: "service",
    serviceUrl,
    serviceToken,
    model: health.modelKey,
    dimensions: health.dimensions,
    close: () => Promise.resolve(),
    embed: (texts) => postEmbeddings(serviceUrl, serviceToken, texts)
  };
};

export const createEmbeddingProvider = (
  options: LiveRetrievalSuccessOptions
): Promise<SourceEmbeddingProvider> =>
  (options.embeddingProvider ?? "deterministic") === "service"
    ? createServiceEmbeddingProvider({
        embeddingServiceUrl: options.embeddingServiceUrl,
        embeddingServiceToken: options.embeddingServiceToken
      })
    : createDeterministicEmbeddingProvider();

export const withTemporaryEmbeddingEnv = <T>(
  embeddingUrl: string,
  embeddingToken: string,
  embeddingModel: string,
  queryInstruction: Exclude<QueryInstructionOption, "both">,
  callback: () => Promise<T>
): Promise<T> => {
  const previous = {
    EMBEDDING_SERVICE_URL: process.env.EMBEDDING_SERVICE_URL,
    EMBEDDING_SERVICE_TOKEN: process.env.EMBEDDING_SERVICE_TOKEN,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
    EMBEDDING_QUERY_INSTRUCTION_ENABLED:
      process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED,
    EMBEDDING_RERANKER_KEY: process.env.EMBEDDING_RERANKER_KEY,
    RERANKER_KEY: process.env.RERANKER_KEY
  };
  process.env.EMBEDDING_SERVICE_URL = embeddingUrl;
  process.env.EMBEDDING_SERVICE_TOKEN = embeddingToken;
  process.env.EMBEDDING_MODEL = embeddingModel;
  if (queryInstruction === "enabled") {
    process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED = "true";
  } else if (queryInstruction === "disabled") {
    process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED = "false";
  }
  delete process.env.EMBEDDING_RERANKER_KEY;
  delete process.env.RERANKER_KEY;

  return callback().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
};

const actorForSeed = (seed: { tags?: string[] }): "agent" | "tool" =>
  seed.tags?.includes("tool-output") ? "tool" : "agent";

const capturedAtForDaysAgo = (daysAgo: number, offsetSeconds: number): string =>
  new Date(
    Date.now() - daysAgo * 24 * 60 * 60 * 1000 + offsetSeconds * 1000
  ).toISOString();

const seedCase = async (
  pool: ReturnType<typeof createDbPool>,
  repo: MemorySourceRepository,
  benchmarkCase: RetrievalSuccessCase,
  embeddingProvider: SourceEmbeddingProvider
): Promise<{
  userId: string;
  projectId: string;
  sourceIdAliases: Map<string, string>;
}> => {
  const user = await repo.createUser({
    email: `${benchmarkCase.id}-${randomUUID()}@eval.koed.local`,
    displayName: benchmarkCase.id
  });
  const projectId = `eval://${benchmarkCase.id}`;
  const seedEventIds = new Map<string, string>();
  const seedNodeIds = new Map<string, string>();
  const nodeSourceEvents = new Map<string, string[]>();
  const sourceIdAliases = new Map<string, string>();

  for (let index = 0; index < benchmarkCase.seed.length; index += 1) {
    const seed = benchmarkCase.seed[index]!;
    if (seed.sourceType === "memory_event") {
      const event = await repo.createMemoryEvent(
        { userId: user.id },
        {
          projectId,
          actor: actorForSeed(seed),
          eventType: "captured",
          rawEventType: "eval_seed",
          content: seed.text,
          metadata: { benchmarkCaseId: benchmarkCase.id, seedId: seed.id },
          visibility: "personal",
          sourceRuntime: "codex",
          captureMethod: "mcp",
          idempotencyKey: `eval:${benchmarkCase.id}:${seed.id}`,
          capturedAt: capturedAtForDaysAgo(seed.createdDaysAgo, index)
        }
      );
      seedEventIds.set(seed.id, event.id);
      sourceIdAliases.set(event.id, seed.id);
      continue;
    }

    const backingEvent = await repo.createMemoryEvent(
      { userId: user.id },
      {
        projectId,
        actor: "agent",
        eventType: "captured",
        rawEventType: "eval_lcm_source",
        content: seed.text,
        metadata: { benchmarkCaseId: benchmarkCase.id, seedId: seed.id },
        visibility: "personal",
        sourceRuntime: "codex",
        captureMethod: "mcp",
        idempotencyKey: `eval:${benchmarkCase.id}:${seed.id}:source`,
        capturedAt: capturedAtForDaysAgo(seed.createdDaysAgo, index)
      }
    );
    seedEventIds.set(seed.id, backingEvent.id);
    sourceIdAliases.set(backingEvent.id, seed.id);

    const node = await repo.createMemoryNode(
      { userId: user.id },
      {
        visibility: "personal",
        title: seed.id,
        summaryText: seed.text,
        bodyText: seed.text,
        captureMethod: "mcp",
        sourceRuntime: "codex",
        idempotencyKey: `eval:${benchmarkCase.id}:${seed.id}:node`,
        sourceHash: `eval:${benchmarkCase.id}:${seed.id}:node`,
        summaryModel:
          seed.lcmSummaryStatus === "summarized" ? "eval-lcm" : undefined,
        summaryPromptVersion:
          seed.lcmSummaryStatus === "summarized" ? "eval-v1" : undefined,
        lcmAlgorithmVersion: "eval-v1"
      }
    );
    seedNodeIds.set(seed.id, node.id);
    sourceIdAliases.set(node.id, seed.id);
    nodeSourceEvents.set(seed.id, [backingEvent.id]);
    await pool.query(
      `
        update memory_nodes
        set kind = $2,
            depth = $3,
            captured_at = $4::timestamptz,
            created_at = $4::timestamptz,
            updated_at = $4::timestamptz
        where id = $1
      `,
      [
        node.id,
        seed.lcmDepth === 1 ? "rollup" : "leaf",
        seed.lcmDepth ?? 0,
        capturedAtForDaysAgo(seed.createdDaysAgo, index)
      ]
    );
  }

  for (const seed of benchmarkCase.seed) {
    if (seed.sourceType !== "memory_node") {
      continue;
    }
    const nodeId = seedNodeIds.get(seed.id);
    if (!nodeId) {
      continue;
    }
    const sourceEvents = nodeSourceEvents.get(seed.id) ?? [];
    for (let index = 0; index < sourceEvents.length; index += 1) {
      await pool.query(
        `
          insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
          values ($1, $2, $3)
          on conflict do nothing
        `,
        [nodeId, sourceEvents[index], index]
      );
    }
  }

  for (const seed of benchmarkCase.seed) {
    if (seed.sourceType !== "memory_node" || seed.parentNodeIds?.length !== 1) {
      continue;
    }
    const childId = seedNodeIds.get(seed.id);
    const parentId = seedNodeIds.get(seed.parentNodeIds[0]!);
    if (!childId || !parentId) {
      continue;
    }
    await pool.query(
      `
        insert into memory_node_children (parent_memory_node_id, child_memory_node_id, child_order)
        values ($1, $2, 0)
        on conflict do nothing
      `,
      [parentId, childId]
    );
    const childEventIds = nodeSourceEvents.get(seed.id) ?? [];
    const existingParentSources =
      nodeSourceEvents.get(seed.parentNodeIds[0]!) ?? [];
    nodeSourceEvents.set(seed.parentNodeIds[0]!, [
      ...existingParentSources,
      ...childEventIds
    ]);
  }

  for (const [seedId, sourceEvents] of nodeSourceEvents) {
    const nodeId = seedNodeIds.get(seedId);
    if (!nodeId) {
      continue;
    }
    for (let index = 0; index < sourceEvents.length; index += 1) {
      await pool.query(
        `
          insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
          values ($1, $2, $3)
          on conflict do nothing
        `,
        [nodeId, sourceEvents[index], index]
      );
    }
  }

  await embedPendingSources(repo, embeddingProvider);
  return { userId: user.id, projectId, sourceIdAliases };
};

interface EmbeddingSourceRepository {
  listSourcesNeedingEmbeddings(
    limit?: number
  ): Promise<EmbeddableSourceRecord[]>;
  upsertSourceEmbedding: MemorySourceRepository["upsertSourceEmbedding"];
}

export const embedPendingSources = async (
  repo: EmbeddingSourceRepository,
  embeddingProvider: Pick<
    SourceEmbeddingProvider,
    "model" | "dimensions" | "embed"
  >,
  batchSize = DEFAULT_SERVICE_EMBED_BATCH_SIZE
): Promise<void> => {
  for (;;) {
    const sources = await repo.listSourcesNeedingEmbeddings(batchSize);
    if (sources.length === 0) {
      break;
    }
    const embedded = await embeddingProvider.embed(
      sources.map((source) => source.text)
    );
    if (embedded.vectors.length !== sources.length) {
      throw new Error(
        `embedding provider returned ${embedded.vectors.length} vectors for ${sources.length} sources`
      );
    }
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      const vector = embedded.vectors[index]!;
      const embeddingModel = resolveSupportedEmbeddingModelConfig(
        embedded.model || embeddingProvider.model
      );
      await repo.upsertSourceEmbedding({
        source,
        model: embeddingModel.key,
        modelArtifactHash:
          process.env.KOED_EMBEDDING_MODEL_SHA256?.trim() ||
          embeddingModel.defaultArtifactSha256,
        dimensions: embedded.dimensions || embeddingProvider.dimensions,
        version: embeddingModel.key,
        tokenizer: embeddingModel.tokenizer,
        inputTransform: embeddingModel.inputTransform,
        pooling: embeddingModel.pooling,
        normalization: embeddingModel.normalization,
        vector
      });
    }
  }
};

const stringInput = (
  input: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof input[key] === "string" && input[key].trim()
    ? input[key].trim()
    : undefined;

const numberInput = (
  input: Record<string, unknown>,
  key: string
): number | undefined =>
  typeof input[key] === "number" && Number.isFinite(input[key])
    ? input[key]
    : undefined;

const stringArrayInput = (
  input: Record<string, unknown>,
  key: string
): string[] | undefined =>
  Array.isArray(input[key])
    ? input[key].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    : undefined;

const createWorkerRetrievalClient = (
  repo: MemorySourceRepository,
  userId: string
): MemoryAnswerRetrievalClient => ({
  async search(input) {
    const searchDomain = stringInput(input, "search_domain");
    const result = await repo.searchMemoryNodes(
      { userId },
      {
        scope: "personal",
        query: stringInput(input, "query") ?? "",
        searchDomain:
          searchDomain === "session"
            ? "session"
            : searchDomain === "global"
              ? "global"
              : "project",
        sessionId: stringInput(input, "session_id"),
        projectId: stringInput(input, "project_id"),
        limit: numberInput(input, "limit"),
        recentDays: numberInput(input, "recent_days"),
        sourceAfter: stringInput(input, "source_after"),
        sourceBefore: stringInput(input, "source_before"),
        retrievalStage: stringInput(input, "retrieval_stage") as
          | "score_scan"
          | "rollup_search"
          | "scoped_leaf_search"
          | "leaf_search"
          | "fresh_pending_search"
          | "raw_fallback_search"
          | undefined,
        parentNodeIds: stringArrayInput(input, "parent_node_ids"),
        strictLimit: input.strict_limit === true
      }
    );
    return {
      hits: result.results,
      retrieval: result.metadata
    };
  },
  async expand(nodeId, input = {}) {
    const searchDomain =
      input.searchDomain === "session"
        ? "session"
        : input.searchDomain === "global"
          ? "global"
          : input.searchDomain === "project"
            ? "project"
            : undefined;
    const result = await repo.expandMemoryNode(
      nodeId,
      { userId },
      {
        ...input,
        searchDomain
      }
    );
    return result as unknown as Record<string, unknown>;
  }
});

const toRunInput = (
  benchmarkCase: RetrievalSuccessCase,
  runIndex: number,
  answer: MemoryAnswerWorkerResponse,
  sourceIdAliases: Map<string, string>
): RetrievalSuccessRunInput => {
  const evidenceRecords = Array.isArray(answer.evidence)
    ? answer.evidence
    : Array.isArray(answer.evidenceBundle?.evidence)
      ? answer.evidenceBundle.evidence
      : [];
  const evidence = evidenceRecords.map((item) => {
    const record = item as Partial<MemorySearchResult>;
    return {
      sourceId:
        (record.sourceId && sourceIdAliases.get(record.sourceId)) ??
        (record.nodeId && sourceIdAliases.get(record.nodeId)) ??
        record.sourceId,
      nodeId:
        (record.nodeId && sourceIdAliases.get(record.nodeId)) ?? record.nodeId,
      sourceType: record.sourceType,
      retrievalStage: record.retrievalStage,
      summaryText: record.summaryText,
      relevance:
        typeof record.score === "number" ? `score=${record.score}` : undefined
    };
  });
  const retrieval =
    answer.evidenceBundle?.retrieval &&
    typeof answer.evidenceBundle.retrieval === "object"
      ? (answer.evidenceBundle.retrieval as {
          searches?: RetrievalSuccessRunInput["searches"];
        })
      : {};
  return {
    caseId: benchmarkCase.id,
    runIndex,
    answer: {
      memoryStatus:
        answer.localMemoryWorker.memoryStatus ??
        (evidence.length > 0 ? "found" : "not_found"),
      answerMarkdown: answer.markdown ?? ""
    },
    evidence,
    searches: retrieval.searches,
    retrievals: answer.evidenceBundle?.retrieval
      ? [answer.evidenceBundle.retrieval]
      : [],
    notes:
      "Observed from live temporary-database memory-answer worker retrieval run."
  };
};

const selectedCases = (caseIds?: string[]): RetrievalSuccessCase[] => {
  const selected = new Set(caseIds ?? []);
  const casesToRun =
    selected.size > 0
      ? retrievalSuccessCases.filter((benchmarkCase) =>
          selected.has(benchmarkCase.id)
        )
      : retrievalSuccessCases;
  if (casesToRun.length === 0) {
    throw new Error("No retrieval-success benchmark cases selected");
  }
  return casesToRun;
};

const queryInstructionVariants = (
  queryInstruction: QueryInstructionOption = "env"
): Exclude<QueryInstructionOption, "both">[] =>
  queryInstruction === "both" ? ["disabled", "enabled"] : [queryInstruction];

const queryInstructionReport = (
  queryInstruction: Exclude<QueryInstructionOption, "both">
): LiveRetrievalSuccessReport["queryInstruction"] => {
  if (queryInstruction === "env") {
    return {
      enabled: "env",
      instruction: process.env.EMBEDDING_QUERY_INSTRUCTION
    };
  }
  return {
    enabled: queryInstruction === "enabled",
    instruction: process.env.EMBEDDING_QUERY_INSTRUCTION
  };
};

const runLiveRetrievalSuccessVariant = async (
  options: LiveRetrievalSuccessOptions,
  embeddingProvider: SourceEmbeddingProvider,
  queryInstruction: Exclude<QueryInstructionOption, "both">
): Promise<LiveRetrievalSuccessReport> => {
  const baseDatabaseUrl =
    options.databaseUrl ??
    process.env[DEFAULT_DATABASE_ENV] ??
    process.env.DATABASE_URL;
  if (!baseDatabaseUrl) {
    throw new Error(
      `A database URL is required. Pass --database-url or set ${DEFAULT_DATABASE_ENV}/DATABASE_URL.`
    );
  }

  const casesToRun = selectedCases(options.caseIds);

  const tempDb = await createTemporaryDatabase(
    baseDatabaseUrl,
    Boolean(options.keepDatabase)
  );
  const pool = createDbPool({ connectionString: tempDb.databaseUrl });
  const repo = createMemorySourceRepository(pool);
  const runInputs: RetrievalSuccessRunInput[] = [];

  try {
    await runMigrations(tempDb.databaseUrl);
    await withTemporaryEmbeddingEnv(
      embeddingProvider.serviceUrl,
      embeddingProvider.serviceToken,
      embeddingProvider.model,
      queryInstruction,
      async () => {
        for (const benchmarkCase of casesToRun) {
          const seeded = await seedCase(
            pool,
            repo,
            benchmarkCase,
            embeddingProvider
          );
          const runCount = options.runs ?? benchmarkCase.runs;
          for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
            const answer = await answerWithMemoryWorker(
              {
                markdown: "",
                evidenceBundle: {
                  query: benchmarkCase.prompt,
                  evidence: [],
                  retrieval: { mode: "retrieval_success_live_seed" }
                }
              },
              {
                client: createWorkerRetrievalClient(repo, seeded.userId),
                retrievalScope: "personal",
                responseDetail: "internal",
                config: resolveMemoryAnswerWorkerConfig(),
                limit: 10,
                recentDays: benchmarkCase.expected.temporal?.recentDays,
                sourceAfter: benchmarkCase.expected.temporal?.sourceAfter,
                sourceBefore: benchmarkCase.expected.temporal?.sourceBefore,
                projectId: seeded.projectId,
                searchDomain: "global"
              }
            );
            runInputs.push(
              toRunInput(
                benchmarkCase,
                runIndex,
                answer,
                seeded.sourceIdAliases
              )
            );
          }
        }
      }
    );
  } finally {
    await pool.end();
    await tempDb.drop();
  }

  const caseById = new Map(
    retrievalSuccessCases.map((benchmarkCase) => [
      benchmarkCase.id,
      benchmarkCase
    ])
  );
  const scored = runInputs.map((run) =>
    scoreRetrievalSuccessRun(caseById.get(run.caseId)!, run)
  );
  const report: LiveRetrievalSuccessReport = {
    suite: "retrieval-success-live",
    generatedAt: new Date().toISOString(),
    boundaryProfile: "post-koe-166-defaults",
    database: {
      isolation: "temporary_database",
      name: tempDb.databaseName,
      kept: Boolean(options.keepDatabase)
    },
    embedding: {
      provider: embeddingProvider.provider,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions
    },
    queryInstruction: queryInstructionReport(queryInstruction),
    cases: casesToRun.map((benchmarkCase) => benchmarkCase.id),
    runInputs,
    summary: summarizeRetrievalSuccessBenchmark(scored)
  };
  return report;
};

export const runLiveRetrievalSuccessBenchmark = async (
  options: LiveRetrievalSuccessOptions = {}
): Promise<
  LiveRetrievalSuccessReport | LiveRetrievalSuccessComparisonReport
> => {
  const embeddingProvider = await createEmbeddingProvider(options);
  try {
    const variants: LiveRetrievalSuccessReport[] = [];
    for (const variant of queryInstructionVariants(options.queryInstruction)) {
      variants.push(
        await runLiveRetrievalSuccessVariant(
          options,
          embeddingProvider,
          variant
        )
      );
    }
    const report =
      options.queryInstruction === "both"
        ? ({
            suite: "retrieval-success-live-comparison",
            generatedAt: new Date().toISOString(),
            boundaryProfile: "post-koe-166-defaults",
            embedding: {
              provider: embeddingProvider.provider,
              model: embeddingProvider.model,
              dimensions: embeddingProvider.dimensions
            },
            cases: selectedCases(options.caseIds).map(
              (benchmarkCase) => benchmarkCase.id
            ),
            variants
          } satisfies LiveRetrievalSuccessComparisonReport)
        : variants[0]!;
    if (options.outputPath) {
      await writeFile(
        options.outputPath,
        `${JSON.stringify(report, null, 2)}\n`
      );
    }
    return report;
  } finally {
    await embeddingProvider.close();
  }
};

const args = process.argv.slice(2);

const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const parseCaseIds = (): string[] | undefined =>
  optionValue("--case")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const parseRuns = (): number | undefined => {
  const value = optionValue("--runs");
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--runs must be a positive integer");
  }
  return parsed;
};

const parseEmbeddingProvider = (): EmbeddingProviderOption | undefined => {
  const value = optionValue("--embedding-provider");
  if (!value) {
    return undefined;
  }
  if (value === "deterministic" || value === "service") {
    return value;
  }
  throw new Error("--embedding-provider must be deterministic or service");
};

const parseQueryInstruction = (): QueryInstructionOption | undefined => {
  const value = optionValue("--query-instruction");
  if (!value) {
    return undefined;
  }
  if (
    value === "env" ||
    value === "enabled" ||
    value === "disabled" ||
    value === "both"
  ) {
    return value;
  }
  throw new Error(
    "--query-instruction must be env, enabled, disabled, or both"
  );
};

const main = async (): Promise<void> => {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  const report = await runLiveRetrievalSuccessBenchmark({
    databaseUrl: optionValue("--database-url"),
    keepDatabase: args.includes("--keep-database"),
    runs: parseRuns(),
    caseIds: parseCaseIds(),
    outputPath: optionValue("--out"),
    embeddingProvider: parseEmbeddingProvider(),
    embeddingServiceUrl: optionValue("--embedding-service-url"),
    embeddingServiceToken: optionValue("--embedding-service-token"),
    queryInstruction: parseQueryInstruction()
  });
  if (!optionValue("--out")) {
    console.log(JSON.stringify(report, null, 2));
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
