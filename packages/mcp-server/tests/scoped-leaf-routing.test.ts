import { describe, expect, it } from "vitest";
import { runScriptedMemoryAnswerFirstPass } from "../src/answer-worker.js";

const parents = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002"
];

describe("scripted scoped-leaf routing", () => {
  it.each([{ parentNodeIds: parents }, { parentNodeIds: [parents[0]!] }])(
    "passes the scan's parent context to every routed child search: $parentNodeIds",
    async ({ parentNodeIds }) => {
      const requests: Record<string, unknown>[] = [];
      const result = await runScriptedMemoryAnswerFirstPass({
        query: "release decision",
        retrievalHints: { semantic: ["rollout requirements"] },
        retrievalScope: "personal",
        searchDomain: "global",
        repositoryContext: null,
        limit: 10,
        maxSearches: 6,
        client: {
          async search(input) {
            requests.push(input);
            if (input.retrieval_stage === "score_scan")
              return {
                hits: [],
                retrieval: {
                  searchPasses: 1,
                  stages: [
                    {
                      name: "scoped_leaf_search",
                      countAboveThreshold: 1,
                      maxAllowed: 20,
                      parentNodeIds
                    }
                  ]
                }
              };
            expect(input.parent_node_ids).toEqual(parentNodeIds);
            return {
              hits: [
                {
                  sourceType: "memory_node",
                  sourceId: "00000000-0000-4000-8000-000000000003",
                  sourceChunkIndex: 0,
                  parentNodeIds,
                  summaryText: "The approved rollout requires an audit.",
                  score: 0.8
                }
              ],
              retrieval: { searchPasses: 1 }
            };
          },
          async expand() {
            throw new Error("Unexpected expansion");
          }
        }
      });
      expect(result.errors).toEqual([]);
      expect(result.evidence).toHaveLength(1);
      const routed = requests.filter(
        (request) => request.retrieval_stage === "scoped_leaf_search"
      );
      expect(routed.length).toBeGreaterThan(0);
      expect(
        routed.every(
          (request) =>
            JSON.stringify(request.parent_node_ids) ===
            JSON.stringify(parentNodeIds)
        )
      ).toBe(true);
    }
  );

  it("reports missing parent context instead of issuing an unbound child search", async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await runScriptedMemoryAnswerFirstPass({
      query: "release decision",
      retrievalHints: { semantic: ["rollout requirements"] },
      retrievalScope: "personal",
      searchDomain: "global",
      repositoryContext: null,
      limit: 10,
      maxSearches: 6,
      client: {
        async search(input) {
          requests.push(input);
          return {
            hits: [],
            retrieval: {
              searchPasses: 1,
              stages: [
                {
                  name: "scoped_leaf_search",
                  countAboveThreshold: 1,
                  maxAllowed: 20
                }
              ]
            }
          };
        },
        async expand() {
          throw new Error("Unexpected expansion");
        }
      }
    });
    expect(result.evidence).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.stringContaining("requires parent references from its scan")
    );
    expect(
      requests.every((request) => request.retrieval_stage === "score_scan")
    ).toBe(true);
    expect(
      result.searches.reduce(
        (total, search) => total + (search.searchPasses ?? 1),
        0
      )
    ).toBeLessThanOrEqual(6);
  });
});
