import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "@koed-labs/db";
import {
  createAuthHelpers,
  createHashSecret
} from "../../../apps/api/src/auth/session.js";
import { registerRecallRoutes } from "../../../apps/api/src/memory/recall-routes.js";
import type { ApiRouteContext } from "../../../apps/api/src/server/context.js";
import { MemoryApiClient } from "../src/index.js";
import { runScriptedMemoryAnswerFirstPass } from "../src/answer-worker.js";

vi.mock("node-pty", () => ({
  spawn: () => {
    throw new Error("Unexpected terminal launch");
  }
}));

const databaseUrl = process.env.KOED_SCOPED_LEAF_TEST_DATABASE_URL;
const apiRequire = createRequire(
  new URL("../../../apps/api/package.json", import.meta.url)
);
const Fastify = apiRequire("fastify") as unknown as () => Parameters<
  typeof registerRecallRoutes
>[0];
const pepper = "synthetic-scoped-leaf-routing-pepper";
const vector = (score: number) =>
  Array.from({ length: 1024 }, (_, index) =>
    index === 0 ? score : index === 1 ? Math.sqrt(1 - score * score) : 0
  );

// Opt in to an isolated database; this fixture never creates or drops databases.
describe.skipIf(!databaseUrl)(
  "authenticated PostgreSQL scoped-leaf routing",
  () => {
    const pool = createDbPool({ connectionString: databaseUrl });
    const repo = createMemorySourceRepository(pool);
    const fetchHttp = globalThis.fetch;
    let app: ReturnType<typeof Fastify>;
    let base: string;
    beforeAll(async () => {
      vi.stubEnv("KOED_DEPLOYMENT_PROFILE", "developer");
      vi.stubEnv("API_TOKEN_PEPPER", pepper);
      vi.stubEnv(
        "EMBEDDING_SERVICE_URL",
        "http://embedding.scoped-leaf.fixture"
      );
      vi.stubEnv("EMBEDDING_MODEL", "qwen3-0.6b");
      vi.stubEnv("MEMORY_RAG_ROLLUP_RESULT_LIMIT", "1");
      vi.stubGlobal(
        "fetch",
        (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          String(input).startsWith("http://embedding.scoped-leaf.fixture")
            ? Promise.resolve(
                Response.json({
                  model: "qwen3-0.6b",
                  dimensions: 1024,
                  vectors: [vector(1)],
                  measuredTokens: 5
                })
              )
            : fetchHttp(input, init)
      );
      await runDbMigrations(pool);
      app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const failure = error as Error & { statusCode?: number };
        return reply
          .status(failure.statusCode ?? 500)
          .send({ error: failure.message });
      });
      registerRecallRoutes(app, {
        requireRepository: () => repo,
        auth: createAuthHelpers(() => repo, {
          hashSecret: createHashSecret(pepper),
          cookieSecure: false
        }),
        config: {
          embeddingModel: "qwen3-0.6b",
          apiTokenPepper: pepper,
          teamCollaborationEnabled: false
        },
        internalServices: { fetch: globalThis.fetch },
        rateLimit: { memoryRecall: async () => {} }
      } as unknown as ApiRouteContext);
      base = await app.listen({ host: "127.0.0.1", port: 0 });
    }, 120_000);
    afterAll(async () => {
      await app?.close();
      await pool.end();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it("routes scan parents to authorized children without admitting unrelated or foreign-owned children", async () => {
      const owner = await repo.createUser({
        email: `scoped-owner-${randomUUID()}@example.test`
      });
      const foreign = await repo.createUser({
        email: `scoped-foreign-${randomUUID()}@example.test`
      });
      const token = `synthetic-${randomUUID()}`;
      await repo.createApiToken({
        ownerUserId: owner.id,
        name: "Scoped leaf fixture",
        tokenPrefix: token.slice(0, 12),
        tokenHash: createHash("sha256")
          .update(`${pepper}${token}`)
          .digest("hex")
      });
      const node = async (
        userId: string,
        body: string,
        score?: number,
        childId?: string
      ) => {
        const nodeActor = { userId };
        const created = await repo.createMemoryNode(nodeActor, {
          visibility: "personal",
          summaryText: body,
          sourceHash: randomUUID()
        });
        if (childId) {
          await pool.query(
            "update memory_nodes set kind='rollup',depth=1 where id=$1",
            [created.id]
          );
          await pool.query(
            "insert into memory_node_children(parent_memory_node_id,child_memory_node_id,child_order) values($1,$2,0)",
            [created.id, childId]
          );
        } else {
          const session = await repo.createCapturedSession(nodeActor, {
            externalSessionId: randomUUID(),
            cwd: `/fixture/${randomUUID()}`
          });
          const event = await repo.createMemoryEvent(nodeActor, {
            sessionId: session.id,
            projectId: "fixture",
            actor: "user",
            visibility: "personal",
            eventType: "captured",
            rawEventType: "user_message",
            content: body,
            idempotencyKey: randomUUID()
          });
          await pool.query(
            "insert into memory_node_sources(memory_node_id,memory_event_id,source_order) values($1,$2,0)",
            [created.id, event.id]
          );
        }
        await repo.updateLcmNodeSummary({
          nodeId: created.id,
          summaryText: body,
          summaryModel: "fixture-client",
          summaryTokenEstimate: 12,
          summaryPromptVersion: "fixture",
          summaryStructuredSchemaVersion: "lcm-semantic-summary-v1",
          summaryStructuredJson: {
            schema_version: "lcm-semantic-summary-v1",
            title: "Release decision",
            summary_text: body,
            lexical_anchors: []
          }
        });
        if (score !== undefined) {
          const source = await repo.getEmbeddableSource(
            "memory_node",
            created.id
          );
          expect(source).not.toBeNull();
          await repo.upsertSourceEmbedding({
            source: source!,
            model: "qwen3-0.6b",
            dimensions: 1024,
            version: "qwen3-0.6b",
            vector: vector(score),
            modelArtifactHash: "a".repeat(64),
            tokenizer: "qwen3-embedding-0.6b-gguf",
            inputTransform: "qwen3-retrieval-document-v1",
            pooling: "last",
            normalization: "l2"
          });
        }
        return created;
      };
      const child = await node(
        owner.id,
        "AUTHORIZED_CHILD: release requires an audit.",
        0.9
      );
      const parent = await node(
        owner.id,
        "AUTHORIZED_PARENT: audited release decision.",
        0.95,
        child.id
      );
      const unrelated = await node(
        owner.id,
        "UNRELATED_CHILD: a separate rollout.",
        0.99
      );
      await node(
        owner.id,
        "Unembedded unrelated parent",
        undefined,
        unrelated.id
      );
      const denied = await node(foreign.id, "FOREIGN_OWNER_SECRET_CHILD", 1);
      const deniedParent = await node(
        foreign.id,
        "FOREIGN_OWNER_SECRET_PARENT",
        1,
        denied.id
      );
      const client = new MemoryApiClient({ apiUrl: base, apiToken: token });
      const requests: Array<{
        input: Record<string, unknown>;
        result: Record<string, unknown>;
      }> = [];
      const result = await runScriptedMemoryAnswerFirstPass({
        query: "release audit decision",
        retrievalHints: { semantic: ["audit rollout requirements"] },
        retrievalScope: "personal",
        searchDomain: "global",
        repositoryContext: null,
        limit: 10,
        maxSearches: 16,
        client: {
          async search(input) {
            const result = await client.search(input);
            requests.push({ input, result });
            return result;
          },
          async expand() {
            throw new Error("Unexpected expansion");
          }
        }
      });
      expect(result.errors).toEqual([]);
      const scans = requests.filter(
        ({ input }) => input.retrieval_stage === "score_scan"
      );
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        const retrieval = scan.result.retrieval as {
          stages: Array<{ name: string; parentNodeIds?: string[] }>;
        };
        expect(
          retrieval.stages.find((stage) => stage.name === "scoped_leaf_search")
            ?.parentNodeIds
        ).toEqual([parent.id]);
      }
      const scoped = requests.filter(
        ({ input }) => input.retrieval_stage === "scoped_leaf_search"
      );
      expect(scoped.length).toBeGreaterThan(0);
      for (const request of scoped) {
        expect(request.input.parent_node_ids).toEqual([parent.id]);
        expect(
          (request.result.hits as Array<{ sourceId: string }>).map(
            (hit) => hit.sourceId
          )
        ).toEqual([child.id]);
      }
      expect(JSON.stringify(result)).not.toContain("FOREIGN_OWNER_SECRET");
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          sourceId: child.id,
          parentNodeIds: [parent.id]
        })
      );
      // Caller-supplied foreign parents are filtered by the same HTTP authorization path.
      const narrowed = await client.search({
        query: "release",
        retrieval_scope: "personal",
        search_domain: "global",
        retrieval_stage: "scoped_leaf_search",
        parent_node_ids: [parent.id, deniedParent.id],
        limit: 10
      });
      expect(
        (narrowed.hits as Array<{ sourceId: string }>).map(
          (hit) => hit.sourceId
        )
      ).toEqual([child.id]);
      const unauthorized = new MemoryApiClient({
        apiUrl: base,
        apiToken: "synthetic-invalid-token"
      });
      await expect(
        unauthorized.search({
          query: "release",
          retrieval_scope: "personal",
          search_domain: "global",
          limit: 1
        })
      ).rejects.toMatchObject({ status: 401 });
    }, 120_000);
  }
);
