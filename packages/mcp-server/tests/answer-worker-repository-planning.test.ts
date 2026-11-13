import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryIdentity } from "@koed-labs/shared";
import { createMemorySourceRepository } from "../../db/src/repository.js";
import { runScriptedMemoryAnswerFirstPass } from "../src/answer-worker.js";

type RepositorySearchInput = Parameters<
  ReturnType<typeof createMemorySourceRepository>["searchMemoryNodes"]
>[1];

const repositoryInput = (
  input: Record<string, unknown>
): RepositorySearchInput => ({
  query: input.query as string,
  scope: "personal",
  searchDomain: "global",
  repositoryContext: input.repository_context as
    | RepositoryIdentity
    | null
    | undefined,
  maxSearchPasses: input.max_search_passes as 1 | 2 | undefined,
  retrievalStage:
    input.retrieval_stage as RepositorySearchInput["retrievalStage"],
  strictLimit: input.strict_limit as boolean | undefined,
  limit: input.limit as number | undefined
});

const actor = { userId: "00000000-0000-4000-8000-000000000001" };
const repositoryContext: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_current",
  root: "/current",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout_current",
  originatingDeviceId: "device_current",
  selectedRemote: "origin",
  anchorDisplay: null
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const repositoryFixture = (candidateCount = 3) => {
  vi.stubEnv("EMBEDDING_SERVICE_URL", "http://embedding.fixture");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        model: "qwen3-0.6b",
        dimensions: 1024,
        vectors: [Array.from({ length: 1024 }, () => 0)]
      })
    )
  );
  const plannedStages: Array<{
    stage: string;
    global: number;
    current: number;
  }> = [];
  // Fixture leaves have no parent relationship to the fixture rollups.
  const stageIds = ["rollup_search", "leaf_search"];
  const pool = {
    async query(sql: string, args: unknown[]) {
      if (sql.includes("with candidates as")) {
        const stage = String(args[7]);
        plannedStages.push({
          stage,
          global: Number(args[3]),
          current: Number(args[12])
        });
        const stageIndex = stageIds.indexOf(stage);
        if (stageIndex === -1) return { rows: [] };
        return {
          rows: Array.from({ length: candidateCount }, (_, index) => {
            const id = `00000000-0000-4000-8000-${String(
              10 * (stageIndex + 1) + index
            ).padStart(12, "0")}`;
            return {
              id,
              embedding_id: id,
              source_type: "memory_node",
              source_id: id,
              owner_user_id: actor.userId,
              retrieval_stage: stage,
              parent_node_ids: [],
              has_out_of_window_sources: false,
              filtered_source_items: null,
              visibility: "personal",
              summary_text: `Release guidance ${stage} ${index}`,
              summary_structured_json: null,
              lexical_anchors: [],
              lcm_summary_model: null,
              lcm_summary_pending: true,
              source_generation: 1,
              score: 0.8,
              created_at: new Date("2026-01-01T00:00:00Z"),
              occurred_at: new Date("2026-01-01T00:00:00Z"),
              source_chunk_index: 0,
              source_chunk_count: 1,
              repository_contexts: [],
              candidate_pool: "global"
            };
          })
        };
      }
      // Source authorization is assumed at the fake I/O boundary, not tested.
      if (sql.includes("as can_read_body")) {
        return {
          rows: (args[1] as string[]).map((source_id) => ({
            source_type: "memory_node",
            source_id,
            can_read_body: true
          }))
        };
      }
      throw new Error(`Unexpected fixture query: ${sql.slice(0, 100)}`);
    },
    async connect() {
      throw new Error("Database connection is not part of this fixture");
    }
  };
  const repository = createMemorySourceRepository(
    pool as unknown as Parameters<typeof createMemorySourceRepository>[0]
  );
  return { repository, plannedStages };
};

describe("Memory Answer repository pass planning", () => {
  it.each([
    { context: repositoryContext, allowance: 2 as const },
    { context: null, allowance: 2 as const },
    { context: repositoryContext, allowance: 1 as const }
  ])(
    "keeps every Personal scan stage within one pass with $allowance allowed",
    async ({ context, allowance }) => {
      const { repository, plannedStages } = repositoryFixture();
      const result = await repository.searchMemoryNodes(actor, {
        query: "release guidance",
        scope: "personal",
        searchDomain: "global",
        repositoryContext: context,
        maxSearchPasses: allowance,
        retrievalStage: "score_scan",
        limit: 10
      });
      expect(result.results).toEqual([]);
      expect(result.metadata).toMatchObject({ searchPasses: 1 });
      expect(result.metadata.stages).toContainEqual(
        expect.objectContaining({
          name: "rollup_search",
          countAboveThreshold: 3
        })
      );
      expect(plannedStages.length).toBeGreaterThan(0);
      expect(plannedStages.every((stage) => stage.current === 0)).toBe(true);
    }
  );

  it.each([
    { limit: 1, allowance: 2 as const, expectedPasses: 1 },
    { limit: 3, allowance: 1 as const, expectedPasses: 1 },
    { limit: 3, allowance: 2 as const, expectedPasses: 2 }
  ])(
    "plans $limit results with $allowance allowed independently of the stage cap",
    async ({ limit, allowance, expectedPasses }) => {
      const { repository, plannedStages } = repositoryFixture();
      const result = await repository.searchMemoryNodes(actor, {
        query: "release guidance",
        scope: "personal",
        searchDomain: "global",
        repositoryContext,
        maxSearchPasses: allowance,
        retrievalStage: "leaf_search",
        limit
      });
      expect(result.results).toHaveLength(limit);
      expect(result.metadata).toMatchObject({ searchPasses: expectedPasses });
      expect(plannedStages).toEqual([
        {
          stage: "leaf_search",
          global: 20,
          current: expectedPasses === 2 ? 5 : 0
        }
      ]);
    }
  );

  it.each([
    { context: repositoryContext, candidateCount: 3 },
    { context: repositoryContext, candidateCount: 1 },
    { context: null, candidateCount: 3 }
  ])(
    "routes evidence through real Personal planning after one-pass scans ($candidateCount candidates)",
    async ({ context, candidateCount }) => {
      const { repository } = repositoryFixture(candidateCount);
      const requests: Record<string, unknown>[] = [];
      const result = await runScriptedMemoryAnswerFirstPass({
        query: "release guidance",
        retrievalHints: {
          semantic: ["shipping decision"],
          lexical: ["rollout"]
        },
        retrievalScope: "personal",
        searchDomain: "global",
        repositoryContext: context,
        limit: 10,
        maxSearches: 6,
        client: {
          async search(input) {
            requests.push(input);
            const response = await repository.searchMemoryNodes(
              actor,
              repositoryInput(input)
            );
            return { hits: response.results, retrieval: response.metadata };
          },
          async expand() {
            throw new Error("Unexpected expansion");
          }
        }
      });
      const scans = requests.filter(
        (request) => request.retrieval_stage === "score_scan"
      );
      const routes = requests.filter(
        (request) => request.retrieval_stage !== "score_scan"
      );
      expect(scans.length).toBeGreaterThan(0);
      expect(scans.every((request) => request.max_search_passes === 1)).toBe(
        true
      );
      expect(routes.length).toBeGreaterThan(0);
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
      expect(
        result.searches
          .filter((search) => search.retrievalStage === "score_scan")
          .every((search) => search.searchPasses === 1)
      ).toBe(true);
      const charged = result.searches.reduce(
        (sum, search) => sum + (search.searchPasses ?? 1),
        0
      );
      expect(charged).toBeLessThanOrEqual(context ? 4 : 5);
      if (candidateCount === 1) {
        expect(routes.every((request) => request.max_search_passes === 1)).toBe(
          true
        );
      }
    }
  );

  it.each([1, 2, 3, 4, 6, 9])(
    "uses consistent requested and charged costs within a %i-pass request budget",
    async (maxSearches) => {
      const { repository } = repositoryFixture();
      const requests: Record<string, unknown>[] = [];
      const result = await runScriptedMemoryAnswerFirstPass({
        query: "release guidance",
        retrievalHints: { semantic: ["shipping decision"] },
        retrievalScope: "personal",
        searchDomain: "global",
        repositoryContext,
        limit: 10,
        maxSearches,
        client: {
          async search(input) {
            requests.push(input);
            const response = await repository.searchMemoryNodes(
              actor,
              repositoryInput(input)
            );
            return { hits: response.results, retrieval: response.metadata };
          },
          async expand() {
            throw new Error("Unexpected expansion");
          }
        }
      });
      expect(result.errors).toEqual([]);
      expect(result.searches).toHaveLength(requests.length);
      for (const search of result.searches) {
        const request = requests.find(
          (input) =>
            input.query === search.query &&
            input.retrieval_stage === search.retrievalStage
        );
        expect(request).toBeDefined();
        expect(search.searchPasses).toBe(request!.max_search_passes);
      }
      expect(
        result.searches.reduce(
          (sum, search) => sum + (search.searchPasses ?? 1),
          0
        )
      ).toBeLessThanOrEqual(maxSearches);
    }
  );

  it.each([1, 3])(
    "retains the planned cost when routed retrieval fails with %i available candidates",
    async (candidateCount) => {
      const { repository } = repositoryFixture(candidateCount);
      const failedAllowances: number[] = [];
      const result = await runScriptedMemoryAnswerFirstPass({
        query: "release guidance",
        retrievalHints: { semantic: ["shipping decision"] },
        retrievalScope: "personal",
        searchDomain: "global",
        repositoryContext,
        limit: 10,
        maxSearches: 6,
        client: {
          async search(input) {
            if (input.retrieval_stage !== "score_scan") {
              failedAllowances.push(Number(input.max_search_passes));
              throw new Error("Fixture retrieval failed");
            }
            const response = await repository.searchMemoryNodes(
              actor,
              repositoryInput(input)
            );
            return { hits: response.results, retrieval: response.metadata };
          },
          async expand() {
            throw new Error("Unexpected expansion");
          }
        }
      });
      expect(failedAllowances).toHaveLength(candidateCount === 1 ? 2 : 1);
      expect(
        failedAllowances.every(
          (cost) => cost === (candidateCount === 1 ? 1 : 2)
        )
      ).toBe(true);
      expect(
        result.searches.reduce(
          (sum, search) => sum + (search.searchPasses ?? 1),
          0
        )
      ).toBe(4);
      expect(result.evidence).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  );
});
