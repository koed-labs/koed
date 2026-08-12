import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createDbPool, type DbPool } from "@koed/db";
import {
  productStateManifestSchema,
  stableHash,
  type ProductRunProof,
  type ProductStateManifest
} from "./contracts.js";
import {
  RETRIEVAL_ARENA_DATASET_VERSION,
  retrievalArenaCases,
  retrievalArenaCorpusIdentity,
  retrievalArenaDatasetHash
} from "./cases.js";

const FIXTURE_SEED = "retrieval-arena-live-product-v1";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export type LiveSourceBinding = {
  itemId: string;
  sourceType: "memory_event" | "memory_node" | "curated_memory";
  sourceId: string;
};

export type LiveStateRow = {
  itemId: string;
  sourceType: LiveSourceBinding["sourceType"];
  sourceId: string;
  ownerUserId: string | null;
  visibility: string;
  eventType: string;
  sessionId: string | null;
  payload: unknown;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  invalidatedAt: string | null;
  lcmNodes: unknown[];
  curatedSources: unknown[];
};

export interface LiveProductStateReader {
  runtimeIdentity(baseUrl: string): Promise<string>;
  readCaseState(sources: LiveSourceBinding[]): Promise<LiveStateRow[]>;
}

const assertLocalHarness = (baseUrl: string, databaseUrl?: string): void => {
  const runtime = new URL(baseUrl);
  if (
    process.env.NODE_ENV === "production" ||
    !LOCAL_HOSTS.has(runtime.hostname) ||
    (databaseUrl && !LOCAL_HOSTS.has(new URL(databaseUrl).hostname))
  )
    throw new Error(
      "Retrieval Arena live fixture is a test-only local harness; remote and production targets are rejected"
    );
};

export const liveCaseStateHash = (rows: LiveStateRow[]): string =>
  stableHash([...rows].sort((a, b) => a.itemId.localeCompare(b.itemId)));

const databaseStateReader = (pool: DbPool): LiveProductStateReader => ({
  async runtimeIdentity(baseUrl) {
    const database = await pool.query<{
      database_name: string;
      schema_name: string;
      server_address: string | null;
      server_port: number | null;
    }>(`select current_database() as database_name,
               current_schema() as schema_name,
               inet_server_addr()::text as server_address,
               inet_server_port() as server_port`);
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/v1/capabilities`
    );
    if (!response.ok)
      throw new Error(`runtime capabilities returned HTTP ${response.status}`);
    const capabilities: unknown = await response.json();
    return stableHash({
      baseUrl: baseUrl.replace(/\/$/, ""),
      database: database.rows[0],
      capabilities
    });
  },
  async readCaseState(sources) {
    const unsupported = sources.find(
      (source) => source.sourceType !== "memory_event"
    );
    if (unsupported)
      throw new Error(
        `live source type ${unsupported.sourceType} is not implemented by the eval attestor; refusing a Memory Event substitute`
      );
    const ids = sources.map((source) => source.sourceId);
    const result = await pool.query<{
      id: string;
      owner_user_id: string | null;
      visibility: string;
      event_type: string;
      session_id: string | null;
      payload: unknown;
      include_in_embedding: boolean;
      include_in_lcm: boolean;
      invalidated_at: Date | null;
      lcm_nodes: unknown[];
      curated_sources: unknown[];
    }>(
      `select me.id::text, me.owner_user_id::text, me.visibility::text,
              me.event_type::text, me.session_id::text, me.payload,
              me.include_in_embedding, me.include_in_lcm, me.invalidated_at,
              coalesce((select jsonb_agg(jsonb_build_object(
                'id', mn.id::text, 'kind', mn.kind, 'depth', mn.depth,
                'summaryText', mn.summary_text,
                'structured', mn.summary_structured_json,
                'invalidatedAt', mn.invalidated_at
              ) order by mn.id)
                from memory_node_sources mns
                join memory_nodes mn on mn.id = mns.memory_node_id
                where mns.memory_event_id = me.id), '[]') as lcm_nodes,
              coalesce((select jsonb_agg(jsonb_build_object(
                'id', cms.id::text, 'assertionId', cms.assertion_id::text,
                'sourceType', cms.source_type, 'assertionStatus', cma.status,
                'suppressedAt', cma.suppressed_at
              ) order by cms.id)
                from curated_memory_sources cms
                join curated_memory_assertions cma on cma.id = cms.assertion_id
                where cms.memory_event_id = me.id), '[]') as curated_sources
         from memory_events me where me.id = any($1::uuid[])`,
      [ids]
    );
    const bindings = new Map(
      sources.map((source) => [source.sourceId, source])
    );
    return result.rows.map((row) => {
      const binding = bindings.get(row.id)!;
      return {
        itemId: binding.itemId,
        sourceType: binding.sourceType,
        sourceId: row.id,
        ownerUserId: row.owner_user_id,
        visibility: row.visibility,
        eventType: row.event_type,
        sessionId: row.session_id,
        payload: row.payload,
        includeInEmbedding: row.include_in_embedding,
        includeInLcm: row.include_in_lcm,
        invalidatedAt: row.invalidated_at?.toISOString() ?? null,
        lcmNodes: row.lcm_nodes,
        curatedSources: row.curated_sources
      };
    });
  }
});

export const createDatabaseLiveProductStateReader = (options: {
  databaseUrl: string;
}): { reader: LiveProductStateReader; close: () => Promise<void> } => {
  assertLocalHarness("http://127.0.0.1", options.databaseUrl);
  const pool = createDbPool({ connectionString: options.databaseUrl });
  return { reader: databaseStateReader(pool), close: () => pool.end() };
};

export const createOnDemandDatabaseLiveProductStateReader = (options: {
  databaseUrl: string;
}): LiveProductStateReader => {
  assertLocalHarness("http://127.0.0.1", options.databaseUrl);
  return {
    async runtimeIdentity(baseUrl) {
      assertLocalHarness(baseUrl, options.databaseUrl);
      const state = createDatabaseLiveProductStateReader(options);
      try {
        return await state.reader.runtimeIdentity(baseUrl);
      } finally {
        await state.close();
      }
    },
    async readCaseState(sources) {
      const state = createDatabaseLiveProductStateReader(options);
      try {
        return await state.reader.readCaseState(sources);
      } finally {
        await state.close();
      }
    }
  };
};

export const attestLiveProductState = async (input: {
  manifest: ProductStateManifest;
  manifestHash: string;
  caseId: string;
  baseUrl: string;
  configurationHash: string;
  reader: LiveProductStateReader;
}): Promise<ProductRunProof> => {
  const entry = input.manifest.cases.find(
    (item) => item.caseId === input.caseId
  );
  const benchmarkCase = retrievalArenaCases.find(
    (item) => item.id === input.caseId
  );
  if (!entry?.liveSources || !benchmarkCase)
    throw new Error(
      `product-state manifest has no live bindings for ${input.caseId}`
    );
  if (
    entry.productContextHash !== stableHash(benchmarkCase.productContext) ||
    entry.liveSources.some(
      (source) =>
        benchmarkCase.corpus.find((item) => item.id === source.itemId)
          ?.sourceType !== source.sourceType
    )
  )
    throw new Error(
      `live bindings do not match source types and product context for ${input.caseId}`
    );
  const [runtimeIdentity, rows] = await Promise.all([
    input.reader.runtimeIdentity(input.baseUrl),
    input.reader.readCaseState(entry.liveSources)
  ]);
  const observedStateHash = liveCaseStateHash(rows);
  const rowsMatchCorpus = rows.every((row) => {
    const corpusItem = benchmarkCase.corpus.find(
      (item) => item.id === row.itemId
    );
    const payload =
      row.payload &&
      typeof row.payload === "object" &&
      !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    return corpusItem?.text === payload.content;
  });
  if (
    input.manifest.seed !== FIXTURE_SEED ||
    runtimeIdentity !== input.manifest.runtimeIdentity ||
    rows.length !== entry.liveSources.length ||
    rows.some((row) => row.invalidatedAt !== null) ||
    !rowsMatchCorpus ||
    observedStateHash !== entry.stateHash
  )
    throw new Error(
      "live product database state is stale, incomplete, invalidated, or belongs to another runtime"
    );
  return {
    kind: "live_product",
    manifestHash: input.manifestHash,
    seed: input.manifest.seed,
    datasetHash: retrievalArenaDatasetHash,
    corpusIdentity: retrievalArenaCorpusIdentity,
    runtimeIdentity,
    caseStateHash: observedStateHash,
    caseCorpusHash: stableHash(benchmarkCase.corpus),
    configurationHash: input.configurationHash,
    observedConfigurationHash: input.configurationHash
  };
};

const requestJson = async (
  baseUrl: string,
  authorization: string,
  pathname: string,
  body: unknown
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${pathname}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      `${pathname} returned HTTP ${response.status}: ${JSON.stringify(payload)}`
    );
  return payload;
};

const unsupportedReason = (
  benchmarkCase: (typeof retrievalArenaCases)[number]
): string | null => {
  const source = benchmarkCase.corpus.find(
    (item) => item.sourceType !== "memory_event"
  );
  if (source) return `requires ${source.sourceType}`;
  if (benchmarkCase.productContext.memoryClass !== "personal")
    return "requires Team Workspace authority";
  if (
    benchmarkCase.corpus.some(
      (item) =>
        item.metadata.visibility === "team" ||
        item.metadata.visibility === "team_shared" ||
        item.metadata.owner === "other" ||
        item.metadata.revoked === true
    )
  )
    return "requires cross-User, Team, or revoked authority state";
  return null;
};

export const seedLiveProductFixture = async (options: {
  baseUrl: string;
  authorization: string;
  databaseUrl: string;
  outputPath: string;
  caseIds: string[];
}): Promise<ProductStateManifest> => {
  assertLocalHarness(options.baseUrl, options.databaseUrl);
  const selected = retrievalArenaCases.filter((item) =>
    options.caseIds.includes(item.id)
  );
  if (!selected.length || selected.length !== new Set(options.caseIds).size)
    throw new Error("Every requested fixture case must be a known Arena case");
  for (const benchmarkCase of selected) {
    const reason = unsupportedReason(benchmarkCase);
    if (reason)
      throw new Error(
        `case ${benchmarkCase.id} is unsupported by the live seeder: ${reason}; refusing a Personal Memory Event substitute`
      );
  }
  const state = createDatabaseLiveProductStateReader({
    databaseUrl: options.databaseUrl
  });
  try {
    const cases: ProductStateManifest["cases"] = [];
    for (const benchmarkCase of selected) {
      const sessionPayload = await requestJson(
        options.baseUrl,
        options.authorization,
        "/v1/sessions",
        {
          externalSessionId: `${FIXTURE_SEED}:${benchmarkCase.id}`,
          sourceRuntime: "codex",
          captureMethod: "api",
          projectId: benchmarkCase.productContext.projectId ?? FIXTURE_SEED,
          metadata: { fixture: FIXTURE_SEED, caseId: benchmarkCase.id }
        }
      );
      const sessionId = (sessionPayload.session as { id?: unknown } | undefined)
        ?.id;
      if (typeof sessionId !== "string")
        throw new Error("fixture session was not created");
      await requestJson(
        options.baseUrl,
        options.authorization,
        "/v1/memory/conversation-items",
        {
          items: benchmarkCase.corpus.map((item, index) => ({
            sessionId,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            sourceRecordType: "event_msg",
            sourceEventType: "user_message",
            sourceSequence: index,
            eventTime:
              typeof item.metadata.sourceTime === "string"
                ? `${item.metadata.sourceTime}T12:00:00.000Z`
                : new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
            rawJson: {
              timestamp:
                typeof item.metadata.sourceTime === "string"
                  ? `${item.metadata.sourceTime}T12:00:00.000Z`
                  : new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
              type: "event_msg",
              payload: { type: "user_message", message: item.text }
            },
            sourceHash: sha256(
              `${FIXTURE_SEED}:${benchmarkCase.id}:${item.id}:source`
            ),
            idempotencyKey: `${FIXTURE_SEED}:${benchmarkCase.id}:${item.id}`,
            metadata: {
              projectId: benchmarkCase.productContext.projectId ?? FIXTURE_SEED,
              transcriptType: "user_message",
              retrievalArenaCaseId: benchmarkCase.id,
              retrievalArenaItemId: item.id
            }
          }))
        }
      );
      const projected = await requestJson(
        options.baseUrl,
        options.authorization,
        "/v1/memory/conversation-items/project",
        { limit: Math.max(100, benchmarkCase.corpus.length) }
      );
      const eventIds = (
        projected.projection as { memoryEventIds?: unknown } | undefined
      )?.memoryEventIds;
      if (
        !Array.isArray(eventIds) ||
        eventIds.length !== benchmarkCase.corpus.length
      )
        throw new Error(
          `Projection did not produce exactly this case's events for ${benchmarkCase.id}; use a fresh isolated database`
        );
      const liveSources = benchmarkCase.corpus.map((item, index) => ({
        itemId: item.id,
        sourceType: item.sourceType,
        sourceId: eventIds[index] as string
      }));
      const rows = await state.reader.readCaseState(liveSources);
      cases.push({
        caseId: benchmarkCase.id,
        corpusHash: stableHash(benchmarkCase.corpus),
        stateHash: liveCaseStateHash(rows),
        itemIds: benchmarkCase.corpus.map((item) => item.id),
        productContextHash: stableHash(benchmarkCase.productContext),
        liveSources
      });
    }
    const manifest = productStateManifestSchema.parse({
      schemaVersion: "koed-retrieval-arena-product-state-v1",
      seed: FIXTURE_SEED,
      datasetVersion: RETRIEVAL_ARENA_DATASET_VERSION,
      datasetHash: retrievalArenaDatasetHash,
      corpusIdentity: retrievalArenaCorpusIdentity,
      runtimeIdentity: await state.reader.runtimeIdentity(options.baseUrl),
      cases
    });
    await writeFile(
      options.outputPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" }
    );
    return manifest;
  } finally {
    await state.close();
  }
};
