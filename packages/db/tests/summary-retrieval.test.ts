import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  repositoryScopeId,
  type RepositoryIdentity
} from "@koed-labs/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const identity = (key: string): RepositoryIdentity => ({
  kind: "portable_repository",
  key: `gr_${key}`,
  root: `/fixture/${key}`,
  branch: "main",
  reason: "origin",
  checkoutId: key,
  originatingDeviceId: "fixture",
  selectedRemote: "origin",
  anchorDisplay: key
});
const vector = (score: number) =>
  Array.from({ length: 1024 }, (_, index) =>
    index === 0 ? score : index === 1 ? Math.sqrt(1 - score * score) : 0
  );

describe.skipIf(!databaseUrl)("authorized full-summary retrieval", () => {
  let pool: pg.Pool;
  const fixtureOwners: string[] = [];
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });
  afterEach(async () => {
    // Embedding inventory is deployment-wide, so retire encrypted fixture work.
    if (fixtureOwners.length > 0) {
      await pool.query(
        "update memory_nodes set invalidated_at=now() where owner_user_id=any($1::uuid[])",
        [fixtureOwners]
      );
      await pool.query(
        "update memory_events set include_in_embedding=false where owner_user_id=any($1::uuid[])",
        [fixtureOwners]
      );
      fixtureOwners.length = 0;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await pool?.end();
  });

  it.each([false, true])(
    "admits each summary generation once before quotas (encrypted=%s)",
    async (encrypted) => {
      vi.stubEnv(
        "KOED_DEPLOYMENT_PROFILE",
        encrypted ? "private_vps" : "self_hosted"
      );
      const repo = createMemorySourceRepository(
        pool,
        encrypted
          ? {
              envelopeEncryptionProvider:
                createLocalTestKeyEnvelopeEncryptionProvider(
                  Buffer.alloc(32, 79).toString("base64")
                )
            }
          : {}
      );
      const owner = await repo.createUser({
        email: `${randomUUID()}@summary.test`
      });
      fixtureOwners.push(owner.id);
      const actor = { userId: owner.id };
      const current = identity(randomUUID()),
        foreign = identity(randomUUID());
      const body =
        "Complete authorized summary. " +
        "Detailed retained context. ".repeat(180) +
        "End of complete summary.";
      vi.stubEnv("EMBEDDING_SERVICE_URL", "http://summary.fixture");
      vi.stubEnv("MEMORY_RAG_LEAF_CANDIDATE_LIMIT", "3");
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              model: "qwen3-0.6b",
              dimensions: 1024,
              vectors: [vector(1)]
            }),
            { status: 200 }
          )
      );
      const session = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        cwd: current.root!,
        repositoryIdentity: current
      });
      const foreignSession = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        cwd: foreign.root!,
        repositoryIdentity: foreign
      });
      const capture = async (sessionId: string, content: string) =>
        repo.createMemoryEvent(actor, {
          sessionId,
          projectId: "fixture",
          actor: "user",
          visibility: "personal",
          eventType: "captured",
          rawEventType: "user_message",
          content,
          idempotencyKey: randomUUID()
        });
      const currentEvent = await capture(session.id, "CURRENT_SAFE_SOURCE");
      const foreignEvent = await capture(
        foreignSession.id,
        "FOREIGN_SECRET_SOURCE"
      );
      const summarize = async (
        eventIds: string[],
        score: number,
        chunks: number,
        pending = false
      ) => {
        const node = await repo.createMemoryNode(actor, {
          visibility: "personal",
          summaryText: body,
          sourceHash: randomUUID()
        });
        for (const [order, eventId] of eventIds.entries())
          await pool.query(
            "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,$3)",
            [node.id, eventId, order]
          );
        if (!pending)
          await repo.updateLcmNodeSummary({
            nodeId: node.id,
            summaryText: body,
            summaryModel: "fixture-client",
            summaryTokenEstimate: 1000,
            summaryPromptVersion: "fixture",
            summaryStructuredSchemaVersion: "lcm-semantic-summary-v1",
            summaryStructuredJson: {
              schema_version: "lcm-semantic-summary-v1",
              title: "Summary",
              summary_text: body,
              lexical_anchors: []
            }
          });
        const source = (await repo.getEmbeddableSource(
          "memory_node",
          node.id
        ))!;
        for (let index = 0; index < chunks; index++)
          await repo.upsertSourceEmbedding({
            source,
            model: "qwen3-0.6b",
            dimensions: 1024,
            version: "qwen3-0.6b",
            vector: vector(score - index * 0.001),
            chunkIndex: index,
            chunkCount: chunks,
            sourceText: `Search chunk ${index}`,
            modelArtifactHash: "a".repeat(64),
            tokenizer: "qwen3-embedding-0.6b-gguf",
            inputTransform: "qwen3-retrieval-document-v1",
            pooling: "last",
            normalization: "l2"
          });
        return node;
      };
      const first = await summarize([currentEvent.id], 0.95, 3);
      const second = await summarize([currentEvent.id], 0.8, 1);
      const third = await summarize([foreignEvent.id], 0.75, 1);
      const search = (domain: "global" | "project" | "session") =>
        repo.searchMemoryNodes(actor, {
          query: "authorized summary",
          scope: "personal",
          searchDomain: domain,
          repositoryContext: current,
          projectId: repositoryScopeId(current)!,
          sessionId: session.id,
          retrievalStage: "leaf_search",
          limit: 3
        });
      const global = await search("global");
      expect(global.results.map((result) => result.sourceId)).toEqual([
        first.id,
        second.id,
        third.id
      ]);
      expect(global.metadata).toMatchObject({
        globalCandidateCount: 2,
        currentRepositoryCandidateCount: 1,
        hydrationCount: 3
      });
      if (encrypted) expect(global.metadata.decryptCount).toBe(6);
      for (const result of global.results) {
        expect(result.summaryText).toBe(body);
        expect(result.summaryRepresentation).toBe("complete_summary");
        expect(typeof result.sourceGeneration).toBe("string");
      }
      expect(
        new Set(
          global.results[0]!.observedReferences?.map(
            (reference) => reference.sourceChunkIndex
          )
        )
      ).toEqual(new Set([0, 1, 2]));
      expect(global.results[0]!.observedReferences).toHaveLength(6);
      expect(global.results[0]!.sourceChunkIndex).toBe(0);
      const scan = await repo.searchMemoryNodes(actor, {
        query: "authorized summary",
        scope: "personal",
        searchDomain: "global",
        repositoryContext: current,
        retrievalStage: "score_scan",
        limit: 3
      });
      expect(scan.results).toEqual([]);
      expect(scan.metadata.stages).toContainEqual(
        expect.objectContaining({
          name: "leaf_search",
          countAboveThreshold: 3
        })
      );
      for (const domain of ["project", "session"] as const) {
        const scoped = await search(domain);
        expect(scoped.results.map((result) => result.sourceId)).toEqual([
          first.id,
          second.id
        ]);
        expect(scoped.metadata.hydrationCount).toBe(2);
        expect(scoped.results[0]!.observedReferences).toHaveLength(3);
      }
      // A revised summary must not inherit matches from its old embedding chunks.
      await repo.updateLcmNodeSummary({
        nodeId: first.id,
        summaryText: "Revised summary",
        summaryModel: "fixture-client",
        summaryTokenEstimate: 3,
        summaryPromptVersion: "fixture",
        summaryStructuredSchemaVersion: "lcm-semantic-summary-v1",
        summaryStructuredJson: {
          schema_version: "lcm-semantic-summary-v1",
          title: "Revised",
          summary_text: "Revised summary",
          lexical_anchors: []
        }
      });
      await pool.query(
        "update memory_embeddings set invalidated_at=null,invalidation_reason=null where memory_node_id=$1",
        [first.id]
      );
      expect(
        (await search("global")).results.map((result) => result.sourceId)
      ).toEqual([second.id, third.id]);

      const mixed = await summarize(
        [currentEvent.id, foreignEvent.id],
        0.99,
        3,
        true
      );
      const partial = await search("project");
      const filtered = partial.results.find(
        (result) => result.sourceId === mixed.id
      )!;
      expect(filtered.summaryRepresentation).toBe("filtered_sources");
      expect(filtered.summaryText).toContain("CURRENT_SAFE_SOURCE");
      expect(filtered.summaryText).not.toContain("FOREIGN_SECRET_SOURCE");
      expect(filtered.observedReferences).toHaveLength(3);
      const full = (await search("global")).results.find(
        (result) => result.sourceId === mixed.id
      )!;
      expect(full.summaryRepresentation).toBe("complete_summary");
      expect(full.summaryText).toBe(body);
    }
  );
});
