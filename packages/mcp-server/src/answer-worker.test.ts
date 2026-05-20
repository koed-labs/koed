import { describe, expect, it } from "vitest";
import {
  MEMORY_ANSWER_PROMPT_VERSION,
  answerWithMemoryWorker,
  buildMemoryAnswerPrompt,
  buildPlannedMemoryAnswerPrompt,
  compactMemoryAnswerPayload,
  resolveMemoryAnswerWorkerConfig,
  type CodexAnswerRunner,
  type MemoryAnswerPayload,
  type MemoryAnswerRetrievalClient
} from "./answer-worker.js";

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
    expect(prompt).toContain("memoryStatus=not_found");
  });

  it("uses the configured Codex runner by default", async () => {
    const calls: number[] = [];
    const runner: CodexAnswerRunner = async (_prompt, config, timeoutMs) => {
      calls.push(timeoutMs);
      return {
        text: "Use Gemini only for embeddings; answer synthesis uses local Codex. [1 personal]",
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
          memoryStatus: "found",
          markdown:
            "We decided embeddings can use Gemini, while answer synthesis should stay on the user's local Codex subscription. [personal]"
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
      limit: 10
    });

    expect(searches).toEqual([
      {
        query: "memory cost decision local Codex Gemini embeddings",
        retrieval_scope: "personal",
        search_domain: "project",
        workspace_id: undefined,
        session_id: undefined,
        limit: 5
      }
    ]);
    expect(result.markdown).toContain("local Codex subscription");
    expect(result.evidence).toHaveLength(2);
    expect(result.localMemoryWorker).toMatchObject({
      planningMode: "planned",
      searchCount: 1,
      expandCount: 0,
      memoryStatus: "found",
      usedFallback: false
    });
  });

  it("keeps default memory_answer output compact while preserving explicit detail data", async () => {
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text: JSON.stringify({
        action: "answer",
        memoryStatus: "found",
        markdown:
          "The supported flow is capture hook, local LCM summary, then memory_answer recall. [personal]"
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

    const compact = compactMemoryAnswerPayload(result);
    expect(compact.markdown).toContain("memory_answer recall");
    expect(compact.retrieval.evidenceCount).toBe(1);
    expect(compact).not.toHaveProperty("evidence");
    expect(compact).not.toHaveProperty("evidenceBundle");
    expect(result.evidenceBundle?.evidence).toHaveLength(1);
  });

  it("can report that no matching memory evidence was found", async () => {
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text: JSON.stringify({
        action: "answer",
        memoryStatus: "not_found",
        markdown: "No matching memory evidence found for Aston Villa."
      }),
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
      searchCount: 0,
      usedFallback: false
    });
  });

  it("can be disabled to return the backend evidence bundle unchanged", async () => {
    const result = await answerWithMemoryWorker(payload, {
      config: resolveMemoryAnswerWorkerConfig({
        MEMORY_ANSWER_PROVIDER: "evidence"
      })
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
