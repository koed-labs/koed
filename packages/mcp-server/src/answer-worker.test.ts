import { describe, expect, it } from "vitest";
import {
  MEMORY_ANSWER_PROMPT_VERSION,
  MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
  answerWithMemoryWorker,
  buildMemoryAnswerPrompt,
  buildPlannedMemoryAnswerPrompt,
  compactMemoryAnswerPayload,
  resolveMemoryAnswerWorkerConfig,
  type CodexAnswerRunner,
  type MemoryAnswerPayload,
  type MemoryAnswerRetrievalClient
} from "./answer-worker.js";

const answerObject = (
  answer_markdown: string,
  memory_status:
    | "found"
    | "not_found"
    | "insufficient"
    | "pending_summary" = "found"
) => ({
  schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
  memory_status,
  relevant_memory_found: memory_status === "found",
  answer_markdown,
  relevance_explanation:
    memory_status === "found"
      ? "The evidence directly supports the answer."
      : "No supplied candidate directly supports the answer.",
  evidence:
    memory_status === "found"
      ? [
          {
            evidence_index: 0,
            source_id: "node-1",
            visibility: "personal",
            relevance: "directly supports the answer"
          }
        ]
      : [],
  missing: memory_status === "found" ? [] : ["relevant memory evidence"],
  missing_evidence: []
});

const answerJson = (
  answer_markdown: string,
  memory_status:
    | "found"
    | "not_found"
    | "insufficient"
    | "pending_summary" = "found"
) => JSON.stringify(answerObject(answer_markdown, memory_status));

const payload = {
  markdown: "Evidence bundle returned for Codex synthesis.",
  evidenceBundle: {
    query: "What did we decide about memory costs?",
    instructions: "Use only the evidence.",
    evidence: [
      {
        nodeId: "node-1",
        visibility: "personal",
        summaryText:
          "Gemini embeddings are acceptable, but answer synthesis should use the local Codex subscription.",
        citation: {
          nodeId: "node-1",
          visibility: "personal"
        }
      }
    ],
    retrieval: {
      retrievalMode: "semantic_vector"
    }
  },
  citations: [
    {
      nodeId: "node-1",
      visibility: "personal"
    }
  ]
} satisfies MemoryAnswerPayload;

describe("memory answer worker", () => {
  it("builds a cited local-worker prompt from the evidence bundle", () => {
    const prompt = buildMemoryAnswerPrompt(payload);

    expect(prompt).toContain("private local memory-answer worker");
    expect(prompt).toContain("What did we decide about memory costs?");
    expect(prompt).toContain("local Codex subscription");
    expect(prompt).toContain("personal");
    expect(prompt).toContain("Required JSON shape");
    expect(prompt).toContain(MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION);
  });

  it("tells the planner that vector hits are only relevance candidates", () => {
    const prompt = buildPlannedMemoryAnswerPrompt(
      {
        query: "Have we discussed Aston Villa?",
        retrievalScope: "personal",
        searchDomain: "global",
        limit: 10,
        evidence: [
          {
            summaryText:
              "Unrelated memory about local Codex subscription costs."
          }
        ],
        citations: [],
        retrievals: [],
        searches: [],
        expansions: [],
        errors: []
      },
      resolveMemoryAnswerWorkerConfig({
        MEMORY_ANSWER_PROVIDER: "codex"
      })
    );

    expect(prompt).toContain("candidates, not proof of relevance");
    expect(prompt).toContain("clearly off-topic");
    expect(prompt).toContain("memory_status=not_found");
    expect(prompt).toContain(
      "Honor the requested default search domain (global)"
    );
    expect(prompt).toContain('"search_domain":"global"');
    expect(prompt).toContain("Start with scan");
    expect(prompt).toContain("lexical_search");
    expect(prompt).toContain("countAboveThreshold");
  });

  it("keeps large inspected evidence bodies visible in the planner prompt", () => {
    const marker = "KOE165SERAPHINA_VISIBLE_TAIL";
    const largeEvidence = `${"archive corridor ".repeat(3000)}${marker}`;
    const prompt = buildPlannedMemoryAnswerPrompt(
      {
        query: `Who was named ${marker}?`,
        retrievalScope: "personal",
        searchDomain: "project",
        workspaceId: "workspace-large-evidence",
        limit: 10,
        evidence: [
          {
            nodeId: "event-1",
            sourceType: "memory_event",
            retrievalStage: "lexical_search",
            summaryText: largeEvidence
          }
        ],
        citations: [],
        retrievals: [],
        searches: [],
        expansions: [],
        errors: []
      },
      resolveMemoryAnswerWorkerConfig({ MEMORY_ANSWER_PROVIDER: "codex" })
    );

    expect(prompt).toContain(marker);
    expect(prompt).not.toContain('"truncated": true');
  });

  it("plans scan, stage search, and returns only curated evidence", async () => {
    const outputs = [
      JSON.stringify({ action: "lookup", query: "Aston Villa" }),
      JSON.stringify({ action: "scan", query: "Aston Villa" }),
      JSON.stringify({
        action: "answer",
        answer: answerObject(
          "I should not answer before inspecting evidence.",
          "insufficient"
        )
      }),
      JSON.stringify({
        action: "search",
        stage: "lexical_search",
        query: "Aston Villa",
        limit: 1
      }),
      JSON.stringify({
        action: "answer",
        answer: answerObject(
          "Yes, you discussed Aston Villa. [1 personal]",
          "found"
        )
      })
    ];
    const runner: CodexAnswerRunner = async () => ({
      text:
        outputs.shift() ??
        answerJson("No matching memory evidence found.", "not_found"),
      model: "codex:test"
    });
    const searches: Record<string, unknown>[] = [];
    const client: MemoryAnswerRetrievalClient = {
      async search(input) {
        searches.push(input);
        if (input.retrieval_stage === "score_scan") {
          return {
            hits: [],
            retrieval: {
              stages: [
                {
                  name: "lexical_search",
                  topScore: 1,
                  countAboveThreshold: 1,
                  maxAllowed: 10
                },
                {
                  name: "rollup_search",
                  topScore: 0,
                  countAboveThreshold: 0,
                  maxAllowed: 10
                }
              ]
            }
          };
        }
        return {
          hits: [
            {
              nodeId: "event-1",
              sourceType: "memory_event",
              sourceId: "event-1",
              retrievalStage: "lexical_search",
              visibility: "personal",
              summaryText: "The user discussed Aston Villa.",
              citation: {
                nodeId: "event-1",
                sourceType: "memory_event",
                sourceId: "event-1",
                retrievalStage: "lexical_search",
                visibility: "personal"
              }
            },
            {
              nodeId: "event-2",
              sourceType: "memory_event",
              sourceId: "event-2",
              retrievalStage: "lexical_search",
              visibility: "personal",
              summaryText: "Unrelated football memory.",
              citation: {
                nodeId: "event-2",
                sourceType: "memory_event",
                sourceId: "event-2",
                retrievalStage: "lexical_search",
                visibility: "personal"
              }
            }
          ],
          retrieval: { retrievalMode: "semantic_vector" }
        };
      },
      async expand() {
        throw new Error("expand should not be called");
      }
    };

    const result = await answerWithMemoryWorker(
      {
        evidenceBundle: {
          query: "Have we talked about Aston Villa before?",
          evidence: [],
          retrieval: { mode: "planner_controlled_initial" }
        },
        citations: []
      },
      {
        config: {
          ...resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_TIMEOUT_MS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          }),
          cwd: "/tmp"
        },
        runner,
        client,
        retrievalScope: "personal",
        searchDomain: "global",
        limit: 10,
        responseDetail: "with_evidence"
      }
    );

    expect(searches.map((search) => search.retrieval_stage)).toEqual([
      "score_scan",
      "lexical_search"
    ]);
    expect(searches[1]).toMatchObject({
      strict_limit: true,
      limit: 1
    });
    expect(result.markdown).toContain("Aston Villa");
    expect(result.evidence).toHaveLength(1);
    expect(JSON.stringify(result.evidence)).toContain("Aston Villa");
    expect(JSON.stringify(result.evidence)).not.toContain(
      "Unrelated football memory"
    );
  });

  it("curates selected evidence by source identity when no evidence index is returned", async () => {
    const outputs = [
      JSON.stringify({ action: "scan", query: "lighthouse story" }),
      JSON.stringify({
        action: "search",
        stage: "leaf_search",
        query: "lighthouse story",
        limit: 2
      }),
      JSON.stringify({
        action: "answer",
        answer: {
          ...answerObject("The relevant source says the old lady was Elara."),
          evidence: [
            {
              node_id: "leaf-relevant",
              source_id: "leaf-relevant",
              source_type: "memory_node",
              visibility: "personal",
              relevance: "directly supports the answer"
            }
          ]
        }
      })
    ];
    const runner: CodexAnswerRunner = async () => ({
      text:
        outputs.shift() ??
        answerJson("No matching memory evidence found.", "not_found"),
      model: "codex:test"
    });
    const client: MemoryAnswerRetrievalClient = {
      async search(input) {
        if (input.retrieval_stage === "score_scan") {
          return {
            hits: [],
            retrieval: {
              stages: [
                {
                  name: "leaf_search",
                  topScore: 0.8,
                  countAboveThreshold: 2,
                  maxAllowed: 10
                }
              ]
            }
          };
        }
        return {
          hits: [
            {
              nodeId: "leaf-noise",
              sourceType: "memory_node",
              sourceId: "leaf-noise",
              retrievalStage: "leaf_search",
              visibility: "personal",
              summaryText: "Unrelated candidate text.",
              citation: {
                nodeId: "leaf-noise",
                sourceType: "memory_node",
                sourceId: "leaf-noise",
                retrievalStage: "leaf_search",
                visibility: "personal"
              }
            },
            {
              nodeId: "leaf-relevant",
              sourceType: "memory_node",
              sourceId: "leaf-relevant",
              retrievalStage: "leaf_search",
              visibility: "personal",
              summaryText: "The old lady in the lighthouse story was Elara.",
              citation: {
                nodeId: "leaf-relevant",
                sourceType: "memory_node",
                sourceId: "leaf-relevant",
                retrievalStage: "leaf_search",
                visibility: "personal"
              }
            }
          ],
          retrieval: { retrievalMode: "semantic_vector" }
        };
      },
      async expand() {
        throw new Error("expand should not be called");
      }
    };

    const result = await answerWithMemoryWorker(
      {
        evidenceBundle: {
          query: "What was the name of the old lady?",
          evidence: [],
          retrieval: { mode: "planner_controlled_initial" }
        },
        citations: []
      },
      {
        config: {
          ...resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_TIMEOUT_MS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          }),
          cwd: "/tmp"
        },
        runner,
        client,
        retrievalScope: "personal",
        searchDomain: "global",
        limit: 10,
        responseDetail: "with_evidence"
      }
    );

    expect(result.evidence).toHaveLength(1);
    expect(JSON.stringify(result.evidence)).toContain("Elara");
    expect(JSON.stringify(result.evidence)).not.toContain("Unrelated");
  });

  it("rejects found answers that do not select resolvable evidence", async () => {
    const outputs = [
      JSON.stringify({ action: "scan", query: "lighthouse story" }),
      JSON.stringify({
        action: "search",
        stage: "leaf_search",
        query: "lighthouse story",
        limit: 1
      }),
      JSON.stringify({
        action: "answer",
        answer: {
          ...answerObject("Unsupported answer."),
          evidence: [
            {
              node_id: "missing-node",
              source_id: "missing-source",
              relevance: "does not match inspected evidence"
            }
          ]
        }
      }),
      JSON.stringify({
        action: "answer",
        answer: answerObject(
          "Insufficient matching memory evidence found.",
          "insufficient"
        )
      })
    ];
    const runner: CodexAnswerRunner = async () => ({
      text:
        outputs.shift() ??
        answerJson("No matching memory evidence found.", "not_found"),
      model: "codex:test"
    });
    const client: MemoryAnswerRetrievalClient = {
      async search(input) {
        if (input.retrieval_stage === "score_scan") {
          return {
            hits: [],
            retrieval: {
              stages: [
                {
                  name: "leaf_search",
                  topScore: 0.8,
                  countAboveThreshold: 1,
                  maxAllowed: 10
                }
              ]
            }
          };
        }
        return {
          hits: [
            {
              nodeId: "leaf-real",
              sourceType: "memory_node",
              sourceId: "leaf-real",
              retrievalStage: "leaf_search",
              visibility: "personal",
              summaryText: "A real inspected candidate.",
              citation: {
                nodeId: "leaf-real",
                sourceType: "memory_node",
                sourceId: "leaf-real",
                retrievalStage: "leaf_search",
                visibility: "personal"
              }
            }
          ],
          retrieval: { retrievalMode: "semantic_vector" }
        };
      },
      async expand() {
        throw new Error("expand should not be called");
      }
    };

    const result = await answerWithMemoryWorker(
      {
        evidenceBundle: {
          query: "What was the lighthouse story answer?",
          evidence: [],
          retrieval: { mode: "planner_controlled_initial" }
        },
        citations: []
      },
      {
        config: {
          ...resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_TIMEOUT_MS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "3"
          }),
          cwd: "/tmp"
        },
        runner,
        client,
        retrievalScope: "personal",
        searchDomain: "global",
        limit: 10,
        responseDetail: "with_evidence"
      }
    );

    expect(result.localMemoryWorker.memoryStatus).toBe("insufficient");
    expect(result.evidence).toHaveLength(0);
    expect(result.markdown).toContain("Insufficient");
  });

  it("requires a semantic search before lexical fallback when semantic candidates are available", async () => {
    const outputs = [
      JSON.stringify({ action: "scan", query: "keeper of the lamp" }),
      JSON.stringify({
        action: "search",
        stage: "lexical_search",
        query: "keeper of the lamp",
        limit: 1
      }),
      JSON.stringify({
        action: "search",
        stage: "leaf_search",
        query: "keeper of the lamp",
        limit: 1
      }),
      JSON.stringify({
        action: "answer",
        answer: answerObject("The relevant memory says Mara. [1 personal]")
      })
    ];
    const runner: CodexAnswerRunner = async () => ({
      text:
        outputs.shift() ??
        answerJson("No matching memory evidence found.", "not_found"),
      model: "codex:test"
    });
    const searches: Record<string, unknown>[] = [];
    const client: MemoryAnswerRetrievalClient = {
      async search(input) {
        searches.push(input);
        if (input.retrieval_stage === "score_scan") {
          return {
            hits: [],
            retrieval: {
              stages: [
                {
                  name: "leaf_search",
                  topScore: 0.71,
                  countAboveThreshold: 1,
                  maxAllowed: 10
                },
                {
                  name: "lexical_search",
                  topScore: 1,
                  countAboveThreshold: 1,
                  maxAllowed: 10
                }
              ]
            }
          };
        }
        return {
          hits: [
            {
              nodeId: "leaf-1",
              sourceType: "memory_node",
              sourceId: "leaf-1",
              retrievalStage: "leaf_search",
              visibility: "personal",
              summaryText: "The keeper of the lamp was Mara.",
              citation: {
                nodeId: "leaf-1",
                sourceType: "memory_node",
                sourceId: "leaf-1",
                retrievalStage: "leaf_search",
                visibility: "personal"
              }
            }
          ],
          retrieval: { retrievalMode: "semantic_vector" }
        };
      },
      async expand() {
        throw new Error("expand should not be called");
      }
    };

    const result = await answerWithMemoryWorker(
      {
        evidenceBundle: {
          query: "What was the name of the keeper of the lamp?",
          evidence: [],
          retrieval: { mode: "planner_controlled_initial" }
        },
        citations: []
      },
      {
        config: {
          ...resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_TIMEOUT_MS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          }),
          cwd: "/tmp"
        },
        runner,
        client,
        retrievalScope: "personal",
        searchDomain: "global",
        limit: 10,
        responseDetail: "with_evidence"
      }
    );

    expect(searches.map((search) => search.retrieval_stage)).toEqual([
      "score_scan",
      "leaf_search"
    ]);
    expect(result.markdown).toContain("Mara");
  });

  it("uses the configured Codex runner by default", async () => {
    const calls: number[] = [];
    const runner: CodexAnswerRunner = async (_prompt, config, timeoutMs) => {
      calls.push(timeoutMs);
      return {
        text: answerJson(
          "Use Gemini only for embeddings; answer synthesis uses local Codex. [1 personal]"
        ),
        model: `codex:${config.model}:${config.reasoningEffort}`
      };
    };

    const result = await answerWithMemoryWorker(payload, {
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_MODEL: "gpt-5.4-mini",
          MEMORY_ANSWER_REASONING_EFFORT: "high",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "2"
        }),
        cwd: "/tmp"
      },
      runner
    });

    expect(calls).toEqual([1000]);
    expect(result.markdown).toContain("local Codex");
    expect(result.localMemoryWorker).toMatchObject({
      provider: "codex",
      promptVersion: MEMORY_ANSWER_PROMPT_VERSION,
      model: "codex:gpt-5.4-mini:high",
      tokenizerEncoding: "o200k_base",
      tokenizerModelMatched: true,
      usedFallback: false
    });
    expect(result.localMemoryWorker.promptTokenEstimate).toBeGreaterThan(0);
  });

  it("returns compact answer-only output by default", async () => {
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text: answerJson(
        "Use Gemini only for embeddings; answer synthesis uses local Codex. [personal]"
      ),
      model: `codex:${config.model}:${config.reasoningEffort}`
    });

    const result = await answerWithMemoryWorker(payload, {
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "1"
        }),
        cwd: "/tmp"
      },
      runner
    });

    expect(result.markdown).toContain("local Codex");
    expect(result.localMemoryWorker.usedFallback).toBe(false);
    expect(result).not.toHaveProperty("evidence");
    expect(result).not.toHaveProperty("evidenceBundle");
    expect(result).not.toHaveProperty("citations");
  });

  it("can return citations without the full evidence bundle", async () => {
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text: answerJson(
        "Use Gemini only for embeddings; answer synthesis uses local Codex. [personal]"
      ),
      model: `codex:${config.model}:${config.reasoningEffort}`
    });

    const result = await answerWithMemoryWorker(
      {
        ...payload,
        rawHitsCount: 1,
        lcmHitsCount: 1,
        expandedNodeIds: ["node-1"],
        visibilityLabels: ["personal"]
      },
      {
        config: {
          ...resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_TIMEOUT_MS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          }),
          cwd: "/tmp"
        },
        runner,
        responseDetail: "with_citations"
      }
    );

    expect(result.citations).toEqual(payload.citations);
    expect(result.rawHitsCount).toBe(1);
    expect(result.visibilityLabels).toEqual(["personal"]);
    expect(result).not.toHaveProperty("evidence");
    expect(result).not.toHaveProperty("evidenceBundle");
  });

  it("can return the full evidence bundle when requested", async () => {
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text: answerJson(
        "Use Gemini only for embeddings; answer synthesis uses local Codex. [personal]"
      ),
      model: `codex:${config.model}:${config.reasoningEffort}`
    });

    const result = await answerWithMemoryWorker(payload, {
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "1"
        }),
        cwd: "/tmp"
      },
      runner,
      responseDetail: "with_evidence"
    });

    expect(result.evidenceBundle).toBe(payload.evidenceBundle);
    expect(result.citations).toEqual(payload.citations);
  });

  it("lets the local worker plan follow-up searches before answering", async () => {
    const prompts: string[] = [];
    const searches: Record<string, unknown>[] = [];
    const runner: CodexAnswerRunner = async (prompt, config) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          text: JSON.stringify({
            action: "search",
            query: "memory cost decision local Codex Gemini embeddings",
            limit: 5
          }),
          model: `codex:${config.model}:${config.reasoningEffort}`
        };
      }
      return {
        text: JSON.stringify({
          action: "answer",
          answer: answerObject(
            "We decided embeddings can use Gemini, while answer synthesis should stay on the user's local Codex subscription. [personal]"
          )
        }),
        model: `codex:${config.model}:${config.reasoningEffort}`
      };
    };
    const client: MemoryAnswerRetrievalClient = {
      async search(input) {
        searches.push(input);
        return {
          hits: [
            {
              nodeId: "node-2",
              visibility: "personal",
              summaryText:
                "The backend should avoid LLM spend; local Codex should synthesize answers.",
              citation: { nodeId: "node-2", visibility: "personal" }
            }
          ],
          retrieval: {
            retrievalMode: "semantic_vector",
            vectorHitsCount: 1,
            textHitsCount: 0
          }
        };
      },
      async expand() {
        throw new Error("expand should not be called");
      }
    };

    const result = await answerWithMemoryWorker(payload, {
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_MODEL: "gpt-5.4-mini",
          MEMORY_ANSWER_REASONING_EFFORT: "high",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "1",
          MEMORY_ANSWER_MAX_SEARCHES: "2"
        }),
        cwd: "/tmp"
      },
      runner,
      client,
      retrievalScope: "personal",
      limit: 10,
      responseDetail: "with_evidence"
    });

    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({
      query: "memory cost decision local Codex Gemini embeddings",
      retrieval_scope: "personal",
      search_domain: "project",
      workspace_id: undefined,
      session_id: undefined,
      limit: 5
    });
    expect(result.markdown).toContain("local Codex subscription");
    expect(result.evidence).toHaveLength(1);
    expect(result.citations).toEqual([
      { nodeId: "node-1", visibility: "personal" }
    ]);
    expect(result.localMemoryWorker).toMatchObject({
      planningMode: "planned",
      searchCount: 1,
      expandCount: 0,
      memoryStatus: "found",
      usedFallback: false
    });
  });

  it("does not narrow a global planner follow-up to project without a workspace", async () => {
    const searches: Record<string, unknown>[] = [];
    const runner: CodexAnswerRunner = async (prompt, config) => {
      if (searches.length === 0 && prompt.includes('"evidence": []')) {
        return {
          text: JSON.stringify({
            action: "search",
            query: "cross project memory decision",
            search_domain: "project"
          }),
          model: `codex:${config.model}:${config.reasoningEffort}`
        };
      }
      return {
        text: JSON.stringify({
          action: "answer",
          answer: answerObject(
            "We found the cross-project decision in global memory."
          )
        }),
        model: `codex:${config.model}:${config.reasoningEffort}`
      };
    };
    const client: MemoryAnswerRetrievalClient = {
      async search(input) {
        searches.push(input);
        return {
          hits: [
            {
              nodeId: "node-global",
              visibility: "personal",
              summaryText: "Cross-project decision.",
              citation: { nodeId: "node-global", visibility: "personal" }
            }
          ],
          retrieval: { retrievalMode: "semantic_vector" }
        };
      },
      async expand() {
        throw new Error("expand should not be called");
      }
    };

    await answerWithMemoryWorker(
      {
        markdown: "No matching memory found.",
        evidenceBundle: {
          query: "What was the cross-project decision?",
          evidence: [],
          retrieval: { retrievalMode: "semantic_vector" }
        },
        citations: []
      },
      {
        config: {
          ...resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_TIMEOUT_MS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "2"
          }),
          cwd: "/tmp"
        },
        runner,
        client,
        retrievalScope: "personal",
        searchDomain: "global",
        limit: 10
      }
    );

    expect(searches[0]).toMatchObject({
      query: "cross project memory decision",
      retrieval_scope: "personal",
      search_domain: "global"
    });
    expect(searches[0]?.workspace_id).toBeUndefined();
  });

  it("preserves caller time bounds on planned follow-up searches", async () => {
    const searches: Record<string, unknown>[] = [];
    const runner: CodexAnswerRunner = async (_prompt, config) => {
      if (searches.length === 0) {
        return {
          text: JSON.stringify({
            action: "search",
            query: "recent deployment discussion",
            limit: 3
          }),
          model: `codex:${config.model}:${config.reasoningEffort}`
        };
      }
      return {
        text: JSON.stringify({
          action: "answer",
          answer: answerObject("The recent deployment discussion was found.")
        }),
        model: `codex:${config.model}:${config.reasoningEffort}`
      };
    };
    const client: MemoryAnswerRetrievalClient = {
      async search(input) {
        searches.push(input);
        return {
          hits: [
            {
              nodeId: "node-recent",
              visibility: "personal",
              summaryText: "Recent deployment discussion.",
              citation: { nodeId: "node-recent", visibility: "personal" }
            }
          ],
          retrieval: { retrievalMode: "semantic_vector" }
        };
      },
      async expand() {
        throw new Error("expand should not be called");
      }
    };

    await answerWithMemoryWorker(
      {
        markdown: "No matching memory found.",
        evidenceBundle: {
          query: "What did we decide about deployment recently?",
          evidence: [],
          retrieval: { retrievalMode: "semantic_vector" }
        },
        citations: []
      },
      {
        config: {
          ...resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_TIMEOUT_MS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "2"
          }),
          cwd: "/tmp"
        },
        runner,
        client,
        retrievalScope: "personal",
        searchDomain: "project",
        workspaceId: "/repo/koed",
        recentDays: 14,
        limit: 10
      }
    );

    expect(searches[0]).toMatchObject({
      query: "recent deployment discussion",
      retrieval_scope: "personal",
      search_domain: "project",
      workspace_id: "/repo/koed",
      recent_days: 14,
      limit: 3
    });
    expect(searches[0]?.source_after).toBeUndefined();
    expect(searches[0]?.source_before).toBeUndefined();
  });

  it("accepts planner evidence entries that only include copied source fields", async () => {
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text: JSON.stringify({
        action: "answer",
        answer: {
          ...answerObject("The fourth item was **amber**."),
          evidence: [
            {
              nodeId: "node-1",
              sourceType: "memory_event",
              sourceId: "event-1",
              visibility: "personal",
              summaryText: "Round 4 sequence: lantern, river, compass, amber."
            }
          ]
        }
      }),
      model: `codex:${config.model}:${config.reasoningEffort}`
    });

    const result = await answerWithMemoryWorker(payload, {
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "1"
        }),
        cwd: "/tmp"
      },
      runner,
      client: {
        async search() {
          return { hits: [], retrieval: { retrievalMode: "semantic_vector" } };
        },
        async expand() {
          throw new Error("expand should not be called");
        }
      },
      retrievalScope: "personal",
      limit: 10
    });

    expect(result.markdown).toBe("The fourth item was **amber**.");
    expect(result.localMemoryWorker).toMatchObject({
      planningMode: "planned",
      memoryStatus: "found",
      usedFallback: false
    });
  });

  it("can compact explicit detail data without losing the source response", async () => {
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text: JSON.stringify({
        action: "answer",
        answer: answerObject(
          "The supported flow is capture hook, local LCM summary, then memory_answer recall. [personal]"
        )
      }),
      model: `codex:${config.model}:${config.reasoningEffort}`
    });
    const result = await answerWithMemoryWorker(payload, {
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "1"
        }),
        cwd: "/tmp"
      },
      runner,
      client: {
        async search() {
          return { hits: [], retrieval: { retrievalMode: "semantic_vector" } };
        },
        async expand() {
          throw new Error("expand should not be called");
        }
      },
      retrievalScope: "personal",
      limit: 10,
      responseDetail: "with_evidence"
    });

    const compact = compactMemoryAnswerPayload(result);
    expect(compact.markdown).toContain("memory_answer recall");
    expect(compact.retrieval.evidenceCount).toBe(1);
    expect(compact).not.toHaveProperty("evidence");
    expect(compact).not.toHaveProperty("evidenceBundle");
    expect(result.evidenceBundle?.evidence).toHaveLength(1);
  });

  it("can report that no matching memory evidence was found", async () => {
    const outputs = [
      JSON.stringify({ action: "scan", query: "Aston Villa" }),
      JSON.stringify({
        action: "answer",
        answer: answerObject(
          "No matching memory evidence found for Aston Villa.",
          "not_found"
        )
      })
    ];
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text:
        outputs.shift() ??
        answerJson("No matching memory evidence found.", "not_found"),
      model: `codex:${config.model}:${config.reasoningEffort}`
    });
    const client: MemoryAnswerRetrievalClient = {
      async search() {
        return { hits: [], retrieval: { retrievalMode: "semantic_vector" } };
      },
      async expand() {
        throw new Error("expand should not be called");
      }
    };
    const emptyPayload = {
      markdown: "HOST_FALLBACK_SHOULD_NOT_BE_USED",
      evidenceBundle: {
        query: "Have we discussed Aston Villa?",
        evidence: [],
        retrieval: { retrievalMode: "semantic_vector" }
      },
      citations: []
    } satisfies MemoryAnswerPayload;

    const result = await answerWithMemoryWorker(emptyPayload, {
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "1"
        }),
        cwd: "/tmp"
      },
      runner,
      client,
      retrievalScope: "personal",
      limit: 10
    });

    expect(result.markdown).toBe(
      "No matching memory evidence found for Aston Villa."
    );
    expect(result.markdown).not.toContain("HOST_FALLBACK_SHOULD_NOT_BE_USED");
    expect(result.localMemoryWorker).toMatchObject({
      planningMode: "planned",
      memoryStatus: "not_found",
      searchCount: 1,
      usedFallback: false
    });
  });

  it("can be disabled to return the backend evidence bundle unchanged when requested", async () => {
    const result = await answerWithMemoryWorker(payload, {
      config: resolveMemoryAnswerWorkerConfig({
        MEMORY_ANSWER_PROVIDER: "evidence"
      }),
      responseDetail: "with_evidence"
    });

    expect(result.markdown).toBe(payload.markdown);
    expect(result.localMemoryWorker).toMatchObject({
      provider: "evidence",
      promptVersion: MEMORY_ANSWER_PROMPT_VERSION,
      model: null,
      usedFallback: true,
      skippedReason: "disabled"
    });
  });

  it("preserves backend retrieval before single-pass answer synthesis", async () => {
    let answerCalls = 0;
    const retrievedPayload = {
      ...payload,
      markdown: "Retrieved evidence fallback.",
      evidenceBundle: {
        ...payload.evidenceBundle,
        query: "What did we decide about memory costs?"
      }
    } satisfies MemoryAnswerPayload;
    const client: MemoryAnswerRetrievalClient = {
      async answer(input) {
        answerCalls += 1;
        expect(input).toMatchObject({
          query: "What did we decide about memory costs?",
          retrieval_scope: "personal",
          search_domain: "project",
          workspace_id: "/repo/koed",
          limit: 7
        });
        return retrievedPayload;
      },
      async search() {
        throw new Error("single-pass mode should not use planner search");
      },
      async expand() {
        throw new Error("single-pass mode should not use planner expand");
      }
    };
    const runner: CodexAnswerRunner = async (prompt, config) => {
      expect(prompt).toContain("Gemini embeddings are acceptable");
      return {
        text: answerJson(
          "Single-pass synthesis used the retrieved evidence. [personal]"
        ),
        model: `codex:${config.model}:${config.reasoningEffort}`
      };
    };

    const result = await answerWithMemoryWorker(
      {
        markdown: "",
        evidenceBundle: {
          query: "What did we decide about memory costs?",
          evidence: [],
          retrieval: { mode: "planner_controlled_initial" }
        }
      },
      {
        client,
        runner,
        retrievalScope: "personal",
        searchDomain: "project",
        workspaceId: "/repo/koed",
        limit: 7,
        config: {
          ...resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_PLANNING_MODE: "single_pass",
            MEMORY_ANSWER_TIMEOUT_MS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          }),
          cwd: "/tmp"
        }
      }
    );

    expect(answerCalls).toBe(1);
    expect(result.markdown).toBe(
      "Single-pass synthesis used the retrieved evidence. [personal]"
    );
    expect(result.retrieval.evidenceCount).toBe(1);
    expect(result.localMemoryWorker).toMatchObject({
      planningMode: "single_pass",
      usedFallback: false
    });
  });

  it("falls back to evidence if Codex worker attempts fail", async () => {
    const runner: CodexAnswerRunner = async () => {
      throw new Error("codex unavailable");
    };

    const result = await answerWithMemoryWorker(payload, {
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "2"
        }),
        cwd: "/tmp"
      },
      runner
    });

    expect(result.markdown).toBe(payload.markdown);
    expect(result.localMemoryWorker).toMatchObject({
      provider: "codex",
      tokenizerEncoding: "o200k_base",
      tokenizerModelMatched: true,
      usedFallback: true,
      skippedReason: "codex_failed"
    });
    expect(result.localMemoryWorker.promptTokenEstimate).toBeGreaterThan(0);
  });
});
