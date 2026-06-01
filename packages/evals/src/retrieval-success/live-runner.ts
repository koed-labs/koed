import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { answerMemory, type MemorySearchResult } from "@koed/core";
import {
  createDbPool,
  createMemorySourceRepository,
  type MemorySourceRepository
} from "@koed/db";
import {
  retrievalSuccessCases,
  type RetrievalStage,
  type RetrievalSuccessCase
} from "./cases.js";
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
    provider: "deterministic-local-http";
    model: string;
    dimensions: number;
  };
  cases: string[];
  runInputs: RetrievalSuccessRunInput[];
  summary: RetrievalSuccessBenchmarkSummary;
}

const usage = [
  "Usage:",
  "  pnpm --filter @koed/evals eval:retrieval-success:live -- --database-url <postgres-url> [--runs 1] [--case id1,id2] [--out report.json]",
  "",
  `If --database-url is omitted, ${DEFAULT_DATABASE_ENV} is used first, then DATABASE_URL.`,
  "The runner creates a temporary database, applies migrations, seeds benchmark memory, runs real Memory Answer retrieval, scores observed output, and drops the database unless --keep-database is passed."
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
    const migrationsDir = findRepoPath("packages/db/src/migrations");
    const migrations = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const migrationFile of migrations) {
      const migration = await readFile(
        path.join(migrationsDir, migrationFile),
        "utf8"
      );
      await pool.query(migration);
    }
  } finally {
    await pool.end();
  }
};

const findRepoPath = (relativePath: string): string => {
  let current = process.cwd();
  for (;;) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find ${relativePath} from ${process.cwd()}`);
    }
    current = parent;
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

export const withTemporaryEmbeddingEnv = <T>(
  embeddingUrl: string,
  callback: () => Promise<T>
): Promise<T> => {
  const previous = {
    EMBEDDING_SERVICE_URL: process.env.EMBEDDING_SERVICE_URL,
    EMBEDDING_SERVICE_TOKEN: process.env.EMBEDDING_SERVICE_TOKEN,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
    EMBEDDING_RERANKER_KEY: process.env.EMBEDDING_RERANKER_KEY,
    RERANKER_KEY: process.env.RERANKER_KEY
  };
  process.env.EMBEDDING_SERVICE_URL = embeddingUrl;
  process.env.EMBEDDING_SERVICE_TOKEN = EMBEDDING_TOKEN;
  process.env.EMBEDDING_MODEL = EMBEDDING_MODEL;
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
  benchmarkCase: RetrievalSuccessCase
): Promise<{
  userId: string;
  workspaceId: string;
  sourceIdAliases: Map<string, string>;
}> => {
  const user = await repo.createUser({
    email: `${benchmarkCase.id}-${randomUUID()}@eval.koed.local`,
    displayName: benchmarkCase.id
  });
  const workspaceId = `eval://${benchmarkCase.id}`;
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
          workspaceId,
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
        workspaceId,
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

  await embedPendingSources(repo);
  return { userId: user.id, workspaceId, sourceIdAliases };
};

const embedPendingSources = async (
  repo: MemorySourceRepository
): Promise<void> => {
  for (;;) {
    const sources = await repo.listSourcesNeedingEmbeddings(200);
    if (sources.length === 0) {
      break;
    }
    for (const source of sources) {
      await repo.upsertSourceEmbedding({
        source,
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        version: EMBEDDING_MODEL,
        vector: deterministicEmbeddingVector(source.text)
      });
    }
  }
};

const retrievalStageForCase = (
  benchmarkCase: RetrievalSuccessCase
): RetrievalStage | undefined => {
  const required = benchmarkCase.expected.requiredStages ?? [];
  if (required.includes("lexical_search")) {
    return "lexical_search";
  }
  return undefined;
};

const toRunInput = (
  benchmarkCase: RetrievalSuccessCase,
  runIndex: number,
  answer: Awaited<ReturnType<typeof answerMemory>>,
  sourceIdAliases: Map<string, string>
): RetrievalSuccessRunInput => {
  const evidence = answer.evidenceBundle.evidence.map(
    (item: MemorySearchResult) => ({
      sourceId:
        (item.sourceId && sourceIdAliases.get(item.sourceId)) ??
        sourceIdAliases.get(item.nodeId) ??
        item.sourceId,
      nodeId: sourceIdAliases.get(item.nodeId) ?? item.nodeId,
      sourceType: item.sourceType,
      retrievalStage: item.retrievalStage,
      summaryText: item.summaryText,
      relevance: `score=${item.score}`
    })
  );
  return {
    caseId: benchmarkCase.id,
    runIndex,
    answer: {
      memoryStatus: evidence.length > 0 ? "found" : "not_found",
      answerMarkdown: answer.answer
    },
    evidence,
    searches: (answer.evidenceBundle.retrieval.stages ?? []).map((stage) => ({
      retrievalStage: stage.name,
      limit: stage.maxAllowed
    })),
    retrievals: [answer.evidenceBundle.retrieval],
    notes: "Observed from live temporary-database retrieval run."
  };
};

export const runLiveRetrievalSuccessBenchmark = async (
  options: LiveRetrievalSuccessOptions = {}
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

  const selected = new Set(options.caseIds ?? []);
  const casesToRun =
    selected.size > 0
      ? retrievalSuccessCases.filter((benchmarkCase) =>
          selected.has(benchmarkCase.id)
        )
      : retrievalSuccessCases;
  if (casesToRun.length === 0) {
    throw new Error("No retrieval-success benchmark cases selected");
  }

  const tempDb = await createTemporaryDatabase(
    baseDatabaseUrl,
    Boolean(options.keepDatabase)
  );
  const embeddingServer = await startDeterministicEmbeddingServer();
  const pool = createDbPool({ connectionString: tempDb.databaseUrl });
  const repo = createMemorySourceRepository(pool);
  const runInputs: RetrievalSuccessRunInput[] = [];

  try {
    await runMigrations(tempDb.databaseUrl);
    await withTemporaryEmbeddingEnv(embeddingServer.url, async () => {
      for (const benchmarkCase of casesToRun) {
        const seeded = await seedCase(pool, repo, benchmarkCase);
        const runCount = options.runs ?? benchmarkCase.runs;
        for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
          const answer = await answerMemory({
            repository: repo,
            requesterContext: { userId: seeded.userId },
            query: benchmarkCase.prompt,
            scope: "personal",
            searchDomain: "global",
            workspaceId: seeded.workspaceId,
            recentDays: benchmarkCase.expected.temporal?.recentDays,
            sourceAfter: benchmarkCase.expected.temporal?.sourceAfter,
            sourceBefore: benchmarkCase.expected.temporal?.sourceBefore,
            retrievalStage: retrievalStageForCase(benchmarkCase),
            limit: 10
          });
          runInputs.push(
            toRunInput(benchmarkCase, runIndex, answer, seeded.sourceIdAliases)
          );
        }
      }
    });
  } finally {
    await pool.end();
    await embeddingServer.close();
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
      provider: "deterministic-local-http",
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS
    },
    cases: casesToRun.map((benchmarkCase) => benchmarkCase.id),
    runInputs,
    summary: summarizeRetrievalSuccessBenchmark(scored)
  };
  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
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
    outputPath: optionValue("--out")
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
