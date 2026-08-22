import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Options,
  Query,
  SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: sdk.query
}));
import {
  MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_LENGTH
} from "@koed/shared";
import {
  MEMORY_ANSWER_PROMPT_VERSION,
  MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
  answerWithMemoryWorker,
  boundMemoryAnswerTrace,
  compactMemoryAnswerPayload,
  evidenceFromExpansion,
  evidenceSelectedByAnswer,
  mergeMemoryAnswerCandidateLists,
  parseStructuredMemoryAnswer,
  resolveMemoryAnswerSearchDomain,
  resolveMemoryAnswerWorkerConfig,
  runScriptedMemoryAnswerFirstPass,
  type MemoryAnswerPayload,
  type MemoryAnswerRetrievalClient,
  type StructuredMemoryAnswer
} from "../src/answer-worker.js";
import { memoryAnswerRetrievalHintsSchema } from "../src/memory-answer-request.js";
import { toolAnswerResponse } from "../src/memory-question-answer-persistence.js";
import { loadPrompt } from "../src/prompt-loader.js";

afterEach(() => {
  sdk.query.mockReset();
});

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
      ? "The selected evidence directly supports the answer."
      : "No supplied candidate directly supports the answer.",
  evidence:
    memory_status === "found"
      ? [
          {
            evidence_index: 0,
            source_id: "event-1",
            visibility: "personal",
            relevance: "direct answer",
            support: "Koed Docker stack"
          }
        ]
      : [],
  missing: memory_status === "found" ? [] : ["relevant memory evidence"],
  missing_evidence: []
});

const payload = {
  markdown: "Evidence bundle returned for Codex synthesis.",
  evidenceBundle: {
    query: "What did we decide about memory costs?",
    instructions: "Use Koed memory RAG tools before answering.",
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

const writeFakeDynamicMemoryAnswerAppServer = (
  directory: string,
  options: {
    useTools?: boolean;
    mode?:
      | "happy"
      | "expandSuccess"
      | "invalidThenValid"
      | "expandBudget"
      | "emptySearchNotFound"
      | "partialStageNotFound"
      | "refineSearch"
      | "scanLoop"
      | "scanOnlyNotFound"
      | "timeoutThenValid";
    answer?: Record<string, unknown>;
    requiredPromptSnippets?: string[];
  } = {}
): string => {
  const modulePath = path.join(directory, "fake-memory-answer-app-server.mjs");
  const scriptPath = path.join(directory, "fake-memory-answer-app-server");
  const attemptFile = path.join(directory, "attempt-count.txt");
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
exec "${process.execPath}" "${modulePath}" "$@"
`,
    { mode: 0o700 }
  );
  fs.writeFileSync(
    modulePath,
    `
import fs from "node:fs";
import readline from "node:readline";

const useTools = ${options.useTools === false ? "false" : "true"};
const mode = ${JSON.stringify(options.mode ?? "happy")};
const requiredPromptSnippets = ${JSON.stringify(options.requiredPromptSnippets ?? [])};
const attemptFile = ${JSON.stringify(attemptFile)};
const answer = ${JSON.stringify(
      options.answer ?? {
        ...answerObject("Koed is running on Docker. [1 personal]"),
        relevant_memory_found: "true"
      }
    )};
const notFoundAnswer = ${JSON.stringify(
      answerObject(
        "No matching relevant memory evidence was found.",
        "not_found"
      )
    )};
const lineReader = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let attempt = 0;
let threadId = "thread-dynamic-answer";
let turnId = "turn-dynamic-answer";

const nextAttempt = () => {
  const current = fs.existsSync(attemptFile)
    ? Number.parseInt(fs.readFileSync(attemptFile, "utf8"), 10) || 0
    : 0;
  attempt = current + 1;
  fs.writeFileSync(attemptFile, String(attempt));
  threadId = "thread-dynamic-answer-" + attempt;
  turnId = "turn-dynamic-answer-" + attempt;
};

const sendFinal = (body) => {
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-final", delta: typeof body === "string" ? body : JSON.stringify(body) } });
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { totalTokens: 99, inputTokens: 80, cachedInputTokens: 10, outputTokens: 19, reasoningOutputTokens: 0 }, last: { totalTokens: 99, inputTokens: 80, cachedInputTokens: 10, outputTokens: 19, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } } });
};

lineReader.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    nextAttempt();
    const toolNames = (message.params.dynamicTools ?? []).map((tool) => tool.namespace + "." + tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(["koed_memory.expand", "koed_memory.scan", "koed_memory.search"])) {
      console.error("expected Koed memory dynamic tools, got " + JSON.stringify(toolNames));
      process.exit(61);
    }
    if ((message.params.developerInstructions ?? "").includes("Do not run tools")) {
      console.error("memory answer developer instructions must allow Koed RAG tools");
      process.exit(62);
    }
    send({ id: message.id, result: { thread: { id: threadId }, model: message.params.model, modelProvider: "openai", serviceTier: null, cwd: message.params.cwd, runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null, reasoningEffort: null } });
    return;
  }
  if (message.method === "turn/start") {
    const promptText = message.params?.input?.[0]?.text ?? "";
    for (const snippet of requiredPromptSnippets) {
      if (!promptText.includes(snippet)) {
        console.error("missing prompt snippet: " + snippet);
        process.exit(67);
      }
    }
    send({ id: message.id, result: { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } } });
    if (mode === "timeoutThenValid" && attempt === 1) {
      return;
    }
    if (!useTools) {
      sendFinal(answer);
      return;
    }
    send({ id: 9001, method: "item/tool/call", params: { threadId, turnId, callId: "call-scan", namespace: "koed_memory", tool: "scan", arguments: { query: "koed docker", search_domain: "project", project_id: "workspace-1" } } });
    return;
  }
  if (message.id === 9001) {
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (!text.includes("scan_result")) {
      console.error("expected scan_result tool response, got " + text.slice(0, 200));
      process.exit(63);
    }
    if (mode === "scanOnlyNotFound") {
      sendFinal(notFoundAnswer);
      return;
    }
    if (mode === "scanLoop") {
      send({ id: 9002, method: "item/tool/call", params: { threadId, turnId, callId: "call-scan-again", namespace: "koed_memory", tool: "scan", arguments: { query: "koed docker again", search_domain: "project", project_id: "workspace-1" } } });
      return;
    }
    if (mode === "expandBudget" || mode === "expandSuccess") {
      send({ id: 9003, method: "item/tool/call", params: { threadId, turnId, callId: "call-expand", namespace: "koed_memory", tool: "expand", arguments: { node_id: "node-1" } } });
      return;
    }
    if (mode === "refineSearch") {
      send({ id: 9002, method: "item/tool/call", params: { threadId, turnId, callId: "call-refined-search", namespace: "koed_memory", tool: "search", arguments: { query: "deployment sentinel configuration", stage: "leaf_search", search_domain: "project", project_id: "workspace-1", exact_hints: ["DEPLOYMENT_MODE", "DEPLOYMENT_MODE"], limit: 50 } } });
      return;
    }
    send({ id: 9002, method: "item/tool/call", params: { threadId, turnId, callId: "call-search", namespace: "koed_memory", tool: "search", arguments: { query: "koed docker", stage: "leaf_search", search_domain: "project", project_id: "workspace-1", limit: 1 } } });
    return;
  }
  if (message.id === 9002) {
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (mode === "scanLoop") {
      if (!text.includes("validation_error")) {
        console.error("expected scan budget validation error, got " + text.slice(0, 200));
        process.exit(65);
      }
      sendFinal(notFoundAnswer);
      return;
    }
    if (mode === "partialStageNotFound") {
      if (!text.includes("search_result")) {
        console.error("expected search_result tool response, got " + text.slice(0, 200));
        process.exit(66);
      }
      sendFinal(notFoundAnswer);
      return;
    }
    if (mode === "refineSearch") {
      if (!text.includes("REFINED_DEPLOYMENT_EVIDENCE")) {
        console.error("expected refined search evidence, got " + text.slice(0, 200));
        process.exit(69);
      }
      sendFinal(answer);
      return;
    }
    if (mode === "emptySearchNotFound") {
      if (!text.includes("search_result")) {
        console.error("expected empty search result, got " + text.slice(0, 200));
        process.exit(71);
      }
      sendFinal(notFoundAnswer);
      return;
    }
    if (!text.includes("KOE144_DYNAMIC_TOOL_EVIDENCE")) {
      console.error("expected search evidence in tool response, got " + text.slice(0, 200));
      process.exit(64);
    }
    if (mode === "invalidThenValid" && attempt === 1) {
      sendFinal("This is not JSON");
      return;
    }
    sendFinal(answer);
    return;
  }
  if (message.id === 9003) {
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (mode === "expandSuccess") {
      if (!text.includes("GROUNDED_CHILD_EVIDENCE")) {
        console.error("expected grounded expanded child, got " + text.slice(0, 200));
        process.exit(70);
      }
      sendFinal(answer);
      return;
    }
    if (!text.includes("validation_error")) {
      console.error("expected expansion budget validation error, got " + text.slice(0, 200));
      process.exit(68);
    }
    sendFinal(notFoundAnswer);
    return;
  }
});
`,
    { mode: 0o600 }
  );
  return scriptPath;
};

describe("memory answer worker", () => {
  it("reports the configured Claude instance and Agent SDK transport", async () => {
    const config = {
      ...resolveMemoryAnswerWorkerConfig({
        MEMORY_ANSWER_CODEX_BINARY: process.execPath
      }),
      provider: "claude" as const,
      aiClientInstanceId: "claude.work",
      executablePath: process.execPath
    };
    const response = await answerWithMemoryWorker(payload, { config });

    expect(response.localMemoryWorker).toMatchObject({
      provider: "claude",
      aiClientInstanceId: "claude.work",
      transport: "agent_sdk",
      skippedReason: "missing_retrieval_client"
    });
  });

  it("aborts and closes the active Claude query when the caller cancels", async () => {
    const caller = new AbortController();
    const removeEventListener = vi.spyOn(caller.signal, "removeEventListener");
    const close = vi.fn();
    let sdkSignal: AbortSignal | undefined;
    sdk.query.mockImplementation(({ options }: { options?: Options }) => {
      sdkSignal = options?.abortController?.signal;
      async function* hang(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>((_resolve, reject) => {
          if (sdkSignal?.aborted) {
            reject(new Error("aborted before iteration"));
            return;
          }
          sdkSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted by test")),
            { once: true }
          );
        });
        yield undefined as never;
      }
      const stream = hang() as Query;
      stream.close = close;
      return stream;
    });
    const responsePromise = answerWithMemoryWorker(payload, {
      client: {
        async search() {
          throw new Error("search must not run after cancellation");
        },
        async expand() {
          throw new Error("expand must not run after cancellation");
        }
      },
      signal: caller.signal,
      config: {
        ...resolveMemoryAnswerWorkerConfig({}),
        provider: "claude",
        aiClientInstanceId: "claude.work",
        executablePath: process.execPath,
        timeoutMs: 5_000,
        maxAttempts: 2
      }
    });
    await vi.waitFor(() => expect(sdkSignal).toBeDefined());

    caller.abort();

    const response = await responsePromise;
    expect(sdkSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(sdk.query).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function)
    );
    expect(response.localMemoryWorker.errorMessage).toContain("cancelled");
    expect(response.localMemoryWorker.errorMessage).not.toContain("timed out");
  });

  it("preserves Claude timeout errors independently of caller cancellation", async () => {
    let sdkSignal: AbortSignal | undefined;
    sdk.query.mockImplementation(({ options }: { options?: Options }) => {
      sdkSignal = options?.abortController?.signal;
      async function* hang(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>((_resolve, reject) => {
          sdkSignal?.addEventListener(
            "abort",
            () => reject(new Error("timed out by test")),
            { once: true }
          );
        });
        yield undefined as never;
      }
      return hang() as Query;
    });

    const response = await answerWithMemoryWorker(payload, {
      client: {
        async search() {
          throw new Error("search must not run after timeout");
        },
        async expand() {
          throw new Error("expand must not run after timeout");
        }
      },
      config: {
        ...resolveMemoryAnswerWorkerConfig({}),
        provider: "claude",
        aiClientInstanceId: "claude.work",
        executablePath: process.execPath,
        timeoutMs: 100,
        maxAttempts: 1
      }
    });

    expect(sdkSignal?.aborted).toBe(true);
    const errorMessage = response.localMemoryWorker.errorMessage ?? "";
    const timeout = errorMessage.match(
      /Claude Agent SDK timed out after (\d+)ms/
    );
    expect(timeout).not.toBeNull();
    expect(Number(timeout?.[1])).toBeGreaterThan(0);
    expect(Number(timeout?.[1])).toBeLessThanOrEqual(100);
    expect(errorMessage).not.toContain("cancelled");
  });

  it("compacts answer payloads by default without losing worker status", () => {
    const compact = compactMemoryAnswerPayload({
      ...payload,
      markdown: "Answer",
      localMemoryWorker: {
        provider: "codex",
        promptVersion: MEMORY_ANSWER_PROMPT_VERSION,
        jobId: "job-1",
        model: "gpt-5.4-mini",
        usedFallback: false
      }
    });

    expect(compact.markdown).toBe("Answer");
    expect(compact.localMemoryWorker.jobId).toBe("job-1");
    expect(compact.evidence).toBeUndefined();
    expect(compact.retrieval.evidenceCount).toBe(1);
  });

  it("returns only selected evidence, citations, and public status with evidence", () => {
    const response = compactMemoryAnswerPayload(
      {
        ...payload,
        evidence: [{ sourceId: "selected", summaryText: "selected body" }],
        citations: [{ sourceId: "selected" }],
        evidenceBundle: {
          query: "SECRET INTERNAL QUERY",
          evidence: [{ sourceId: "selected", summaryText: "selected body" }],
          retrieval: {
            searches: [{ query: "SECRET INTERNAL QUERY" }],
            trace: {
              retrievalHints: { exact: ["SECRET CALLER HINT"] },
              errors: ["SECRET ERROR"]
            }
          }
        },
        localMemoryWorker: {
          provider: "codex",
          promptVersion: MEMORY_ANSWER_PROMPT_VERSION,
          jobId: "job-public",
          model: "gpt-5.4-mini",
          usedFallback: false,
          searchCount: 4,
          displayMessage: "The worker could not verify this answer.",
          errorMessage: "SECRET WORKER ERROR",
          appServerEvents: []
        }
      },
      "with_evidence"
    );

    expect(response.evidence).toEqual([
      { sourceId: "selected", summaryText: "selected body" }
    ]);
    expect(response.citations).toEqual([{ sourceId: "selected" }]);
    expect(response.evidenceBundle).toBeUndefined();
    expect(response.localMemoryWorker.searchCount).toBeUndefined();
    expect(response.localMemoryWorker.displayMessage).toBe(
      "The worker could not verify this answer."
    );
    expect(JSON.stringify(response)).not.toMatch(
      /SECRET INTERNAL QUERY|SECRET CALLER HINT|SECRET ERROR|SECRET WORKER ERROR/
    );
  });

  it("rejects contradictory worker status, relevance, and evidence invariants", () => {
    const found = answerObject("supported", "found");
    expect(() =>
      parseStructuredMemoryAnswer({
        ...found,
        relevant_memory_found: false
      })
    ).toThrow(/found requires/);
    const notFound = answerObject("absent", "not_found");
    expect(() =>
      parseStructuredMemoryAnswer({
        ...notFound,
        relevant_memory_found: true,
        evidence: [{ evidence_index: 0 }]
      })
    ).toThrow(/not_found requires/);
    const insufficient = answerObject("incomplete", "insufficient");
    expect(() =>
      parseStructuredMemoryAnswer({
        ...insufficient,
        evidence: [{ evidence_index: 0 }]
      })
    ).toThrow(/insufficient requires/);
  });

  it("strips app-server raw events from MCP tool responses", () => {
    const response = toolAnswerResponse(
      {
        ...payload,
        markdown: "Answer",
        retrieval: {
          evidenceCount: 1
        },
        localMemoryWorker: {
          provider: "codex",
          promptVersion: MEMORY_ANSWER_PROMPT_VERSION,
          jobId: "job-1",
          model: "gpt-5.4-mini",
          usedFallback: false,
          appServerEvents: [
            {
              sequence: 1,
              method: "item/tool/call",
              observedAt: "2026-06-01T12:00:00.000Z"
            }
          ],
          appServerExecutions: [
            {
              model: "gpt-5.4-mini",
              tokenUsage: {
                last: { totalTokens: 10 },
                total: { totalTokens: 10 }
              },
              rawEvents: [
                {
                  sequence: 2,
                  method: "item/tool/call/response",
                  observedAt: "2026-06-01T12:00:01.000Z"
                }
              ]
            }
          ]
        }
      },
      "with_citations"
    );

    const worker = response.localMemoryWorker as unknown as Record<
      string,
      unknown
    >;
    expect(worker.appServerEvents).toBeUndefined();
    expect(
      ((worker.appServerExecutions as Array<Record<string, unknown>>) ?? [])[0]
        ?.rawEvents
    ).toBeUndefined();
  });

  it("resolves Codex app-server memory-answer config without a mode switch", () => {
    const config = resolveMemoryAnswerWorkerConfig({
      MEMORY_ANSWER_PROVIDER: "codex",
      MEMORY_ANSWER_MODEL: "gpt-5.3-codex-spark",
      MEMORY_ANSWER_REASONING_EFFORT: "low",
      MEMORY_ANSWER_TIMEOUT_MS: "25000",
      MEMORY_ANSWER_MAX_ATTEMPTS: "3",
      MEMORY_ANSWER_MAX_SEARCHES: "4",
      MEMORY_ANSWER_MAX_EXPANSIONS: "2",
      MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "7",
      MEMORY_ANSWER_CODEX_BINARY: "/bin/codex"
    });

    expect(config.provider).toBe("codex");
    expect(config.model).toBe("gpt-5.3-codex-spark");
    expect(config.reasoningEffort).toBe("low");
    expect(config.timeoutMs).toBe(25000);
    expect(config.maxAttempts).toBe(3);
    expect(config.maxSearches).toBe(4);
    expect(config.maxExpansions).toBe(2);
    expect(config.maxEvidenceItems).toBe(7);
  });

  it("uses the efficient GPT-5.6 defaults for memory answers", () => {
    expect(resolveMemoryAnswerWorkerConfig({})).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "low"
    });
  });

  it("sends recency and conflict guidance to the memory-answer worker prompt", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const bundledPrompt = loadPrompt("memory-answer-worker");
      fs.writeFileSync(
        path.join(directory, "memory-answer-worker.md"),
        fs
          .readFileSync(bundledPrompt.sourcePath, "utf8")
          .replace(
            `version: ${MEMORY_ANSWER_PROMPT_VERSION}`,
            "version: operator-memory-answer-v9"
          )
      );
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        useTools: false,
        requiredPromptSnippets: [
          "Recency and conflict rules:",
          "If the user asks for current/latest state, prefer newer directly relevant evidence when it appears to supersede older evidence.",
          "Do not repeat the old value even to say that it was superseded.",
          "If the user asks about history, prior decisions, evolution, or what changed, summarize the timeline instead of collapsing to only the newest fact.",
          "If newer evidence is weak or indirect but older evidence is direct, report the uncertainty instead of treating recency as decisive.",
          "If the user asks for history, or older and newer evidence leave the current state genuinely ambiguous",
          "including recency/conflict reasoning when evidence differs over time",
          '"searchHistory"',
          '"retrievalCoverage"',
          '"remainingBudgets"',
          '"conversationContext"',
          "We chose the Personal route.",
          "What did we choose?"
        ]
      });

      const response = await answerWithMemoryWorker(payload, {
        client: {
          async search() {
            throw new Error(
              "search should not be needed for prompt assertions"
            );
          },
          async expand() {
            throw new Error(
              "expand should not be needed for prompt assertions"
            );
          }
        },
        retrievalScope: "personal",
        searchDomain: "project",
        projectId: "workspace-1",
        conversationContext: [
          {
            answer: "We chose the Personal route.",
            question: "What did we choose?"
          }
        ],
        config: resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
          KOED_PROMPT_DIR: directory
        })
      });

      expect(response.localMemoryWorker.errorMessage).toBeUndefined();
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.localMemoryWorker.promptVersion).toBe(
        "operator-memory-answer-v9"
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("runs one app-server worker turn with dynamic Koed RAG tools", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory);
      const searches: Record<string, unknown>[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          searches.push(input);
          if (input.retrieval_stage === "score_scan") {
            return {
              retrieval: {
                stages: [
                  {
                    name: "leaf_search",
                    countAboveThreshold: 1,
                    maxAllowed: 1
                  }
                ]
              }
            };
          }
          return {
            hits: [
              {
                nodeId: "node-1",
                sourceId: "event-1",
                visibility: "personal",
                summaryText:
                  "KOE144_DYNAMIC_TOOL_EVIDENCE: Koed is running on Docker.",
                citation: { nodeId: "node-1", visibility: "personal" },
                operatorDiagnostic: "non-evidence-metadata ".repeat(100)
              }
            ],
            retrieval: {
              stage: input.retrieval_stage,
              teamWorkspaceId: "canonical-team-workspace-id",
              hits: [
                {
                  summaryText: "UNSELECTED_RETRIEVAL_DIAGNOSTIC_BODY"
                }
              ]
            }
          };
        },
        async expand() {
          throw new Error("expand should not be required for direct evidence");
        }
      };

      const response = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "Are we running koed on docker?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          retrievalHints: {
            exact: ["KOE144_DYNAMIC_TOOL_EVIDENCE"],
            semantic: ["container deployment choice"]
          },
          captureProcessMetrics: true,
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MODEL: "gpt-5.4-mini",
            MEMORY_ANSWER_REASONING_EFFORT: "medium",
            MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "128",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary
          })
        }
      );

      expect(response.markdown).toContain("Koed is running on Docker");
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.localMemoryWorker.searchCount).toBe(6);
      expect(response.localMemoryWorker.appServerThreadId).toBe(
        "thread-dynamic-answer-1"
      );
      expect(response.localMemoryWorker.appServerTurnId).toBe(
        "turn-dynamic-answer-1"
      );
      expect(response.localMemoryWorker.appServerExecutions).toHaveLength(1);
      const processMetrics =
        response.localMemoryWorker.appServerExecutions?.[0]?.processMetrics;
      expect(typeof processMetrics?.pid).toBe("number");
      expect(typeof processMetrics?.peakRssBytes).toBe("number");
      expect(typeof processMetrics?.sampleCount).toBe("number");
      expect(response.localMemoryWorker.tokenUsage?.last?.totalTokens).toBe(99);
      expect(response.evidence).toHaveLength(1);
      const serializedRetrieval = JSON.stringify(
        response.evidenceBundle?.retrieval
      );
      expect(serializedRetrieval).not.toContain(
        "UNSELECTED_RETRIEVAL_DIAGNOSTIC_BODY"
      );
      expect(serializedRetrieval).not.toContain("canonical-team-workspace-id");
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        mode: "scripted_first_pass_with_worker_follow_up",
        trace: {
          version: 2,
          retrievalHints: {
            exact: ["KOE144_DYNAMIC_TOOL_EVIDENCE"],
            semantic: ["container deployment choice"]
          },
          effectiveBoundary: {
            retrievalScope: "personal",
            searchDomain: "project",
            projectId: "workspace-1"
          }
        }
      });
      expect(searches.map((search) => search.retrieval_stage)).toEqual([
        "score_scan",
        "score_scan",
        "score_scan",
        "leaf_search",
        "leaf_search",
        "leaf_search"
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns grounded child evidence selected from a worker-expanded parent", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "expandSuccess",
        answer: {
          ...answerObject(
            "The deployment sentinel is enabled by DEPLOYMENT_MODE. [1 personal]"
          ),
          evidence: [
            {
              source_type: "memory_event",
              source_id: "event-child-1",
              source_chunk_index: 4,
              visibility: "personal",
              relevance: "grounded expanded source",
              support: "GROUNDED_CHILD_EVIDENCE"
            }
          ]
        }
      });
      const expansions: string[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          if (input.retrieval_stage === "score_scan") {
            return {
              retrieval: {
                stages: [
                  {
                    name: "leaf_search",
                    countAboveThreshold: 1,
                    maxAllowed: 1
                  }
                ]
              }
            };
          }
          return {
            hits: [
              {
                nodeId: "node-1",
                sourceType: "memory_node",
                sourceId: "summary-parent-1",
                sourceChunkIndex: 0,
                visibility: "personal",
                summaryText:
                  "A deployment setting was chosen; expand for the exact source."
              }
            ],
            retrieval: { stage: input.retrieval_stage }
          };
        },
        async expand(nodeId) {
          expansions.push(nodeId);
          return {
            expanded: {
              nodeId,
              visibility: "personal",
              sourceItems: [
                {
                  sourceId: "event-child-1",
                  sourceChunkIndex: 4,
                  text: "GROUNDED_CHILD_EVIDENCE: DEPLOYMENT_MODE enables the deployment sentinel."
                }
              ]
            }
          };
        }
      };

      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What enables the deployment sentinel?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_SEARCHES: "3",
            MEMORY_ANSWER_MAX_EXPANSIONS: "1"
          })
        }
      );

      expect(expansions).toEqual(["node-1"]);
      expect(response.markdown).toContain("DEPLOYMENT_MODE");
      expect(response.localMemoryWorker).toMatchObject({
        usedFallback: false,
        memoryStatus: "found",
        expandCount: 1
      });
      expect(response.evidence).toEqual([
        expect.objectContaining({
          sourceId: "event-child-1",
          sourceChunkIndex: 4,
          expandedFromNodeId: "node-1"
        })
      ]);
      const expandedEvidence = response.evidence as Array<{
        summaryText?: string;
      }>;
      expect(expandedEvidence[0]?.summaryText).toContain(
        "GROUNDED_CHILD_EVIDENCE"
      );
      expect(response.citations).toEqual([
        expect.objectContaining({
          sourceId: "event-child-1",
          sourceChunkIndex: 4,
          expandedFromNodeId: "node-1"
        })
      ]);
      expect(JSON.stringify(response.evidence)).not.toContain(
        "summary-parent-1"
      );
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        expansions: [{ nodeId: "node-1" }],
        trace: {
          budgets: { consumed: { expansions: 1 } }
        }
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds a worker-refined semantic search and narrows exact anchors", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "refineSearch",
        answer: {
          ...answerObject(
            "DEPLOYMENT_MODE is the exact deployment sentinel setting. [1 personal]"
          ),
          evidence: [
            {
              source_type: "memory_event",
              source_id: "event-refined-1",
              source_chunk_index: 2,
              visibility: "personal",
              relevance: "refined semantic and exact-anchor match",
              support: "REFINED_DEPLOYMENT_EVIDENCE"
            }
          ]
        }
      });
      const searches: Record<string, unknown>[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          searches.push(input);
          if (input.retrieval_stage === "score_scan") {
            return {
              retrieval: {
                stages: [
                  {
                    name: "leaf_search",
                    countAboveThreshold: 1,
                    maxAllowed: 10
                  }
                ]
              }
            };
          }
          if (input.query === "deployment sentinel configuration") {
            const refined = {
              nodeId: "refined-node-1",
              sourceType: "memory_event",
              sourceId: "event-refined-1",
              sourceChunkIndex: 2,
              visibility: "personal",
              summaryText:
                "REFINED_DEPLOYMENT_EVIDENCE: DEPLOYMENT_MODE controls the deployment sentinel."
            };
            return {
              hits: [refined, { ...refined }],
              retrieval: { stage: input.retrieval_stage }
            };
          }
          return {
            hits: [
              {
                nodeId: "broad-node-1",
                sourceType: "memory_node",
                sourceId: "broad-parent-1",
                sourceChunkIndex: 0,
                visibility: "personal",
                summaryText: "A broad deployment summary."
              }
            ],
            retrieval: { stage: input.retrieval_stage }
          };
        },
        async expand() {
          throw new Error("refined direct evidence should not need expansion");
        }
      };

      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "Which configuration controls our deployment behavior?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          limit: 2,
          retrievalHints: {
            exact: ["BROAD_DEPLOYMENT", "DEPLOYMENT_MODE", "LEGACY_MODE"]
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_SEARCHES: "3",
            KOED_HOME: directory,
            MEMORY_ANSWER_MAX_CANDIDATES: "2"
          })
        }
      );

      const refinedSearch = searches.find(
        (search) => search.query === "deployment sentinel configuration"
      );
      expect(refinedSearch).toMatchObject({
        query: "deployment sentinel configuration",
        retrieval_stage: "leaf_search",
        exact_hints: ["DEPLOYMENT_MODE"],
        limit: 50
      });
      expect(refinedSearch).not.toHaveProperty("strict_limit");
      expect(response.localMemoryWorker).toMatchObject({
        usedFallback: false,
        memoryStatus: "found",
        searchCount: 3,
        candidateCount: 2
      });
      expect(response.evidence).toEqual([
        expect.objectContaining({
          sourceId: "event-refined-1",
          sourceChunkIndex: 2
        })
      ]);
      const refinedEvidence = response.evidence as Array<{
        summaryText?: string;
      }>;
      expect(refinedEvidence[0]?.summaryText).toContain(
        "REFINED_DEPLOYMENT_EVIDENCE"
      );
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        trace: {
          budgets: {
            configured: { searches: 3, candidates: 2 },
            consumed: { searches: 3 }
          }
        }
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts an empty worker-refined search as a valid not-found result", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "emptySearchNotFound"
      });
      const searches: Record<string, unknown>[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          searches.push(input);
          if (input.retrieval_stage === "score_scan") {
            return { retrieval: { stages: [] } };
          }
          expect(input).not.toHaveProperty("strict_limit");
          return {
            hits: [],
            retrieval: { stage: input.retrieval_stage }
          };
        },
        async expand() {
          throw new Error("empty search should not require expansion");
        }
      };

      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What is my nickname?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "global",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "2",
            MEMORY_ANSWER_MAX_SEARCHES: "3",
            KOED_HOME: directory
          })
        }
      );

      const workerSearch = searches.find(
        (search) =>
          search.query === "koed docker" &&
          search.retrieval_stage === "leaf_search"
      );
      expect(workerSearch).toBeDefined();
      expect(workerSearch).not.toHaveProperty("strict_limit");
      expect(response.localMemoryWorker).toMatchObject({
        usedFallback: false,
        memoryStatus: "not_found",
        searchCount: 3
      });
      expect(response.localMemoryWorker.errorMessage).toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces one request-wide wall-time budget across retry attempts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "timeoutThenValid"
      });
      const searches: Record<string, unknown>[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          searches.push(input);
          if (input.retrieval_stage === "score_scan") {
            return {
              retrieval: {
                stages: [
                  {
                    name: "leaf_search",
                    countAboveThreshold: 1,
                    maxAllowed: 1
                  }
                ]
              }
            };
          }
          return {
            hits: [
              {
                nodeId: "node-1",
                sourceId: "event-1",
                visibility: "personal",
                summaryText:
                  "KOE144_DYNAMIC_TOOL_EVIDENCE: Koed is running on Docker.",
                citation: { nodeId: "node-1", visibility: "personal" }
              }
            ],
            retrieval: { stage: input.retrieval_stage }
          };
        },
        async expand() {
          throw new Error("expand should not be required for direct evidence");
        }
      };

      const response = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "Are we running koed on docker?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          captureProcessMetrics: true,
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_TIMEOUT_MS: "25",
            MEMORY_ANSWER_MAX_ATTEMPTS: "2"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
      expect(response.structuredAnswer).toMatchObject({
        memory_status: "insufficient"
      });
      expect(response.markdown).toBe(
        "The Codex worker did not finish the Personal Memory search in time. Try again."
      );
      expect(response.localMemoryWorker.appServerExecutions).toHaveLength(1);
      expect(
        response.localMemoryWorker.appServerExecutions?.map(
          (execution) => execution.status
        )
      ).toEqual(["failed"]);
      expect(
        response.localMemoryWorker.appServerExecutions?.[0]?.processMetrics
          ?.peakRssBytes
      ).toBeGreaterThan(0);
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        mode: "scripted_first_pass_with_worker_follow_up_failed",
        trace: {
          version: 2,
          budgets: {
            configured: { wallTimeMs: 1000 },
            consumed: { searches: 2 },
            exhausted: ["wall_time"]
          }
        }
      });
      expect(searches.map((search) => search.retrieval_stage)).toEqual([
        "score_scan",
        "leaf_search"
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries malformed structured worker output before falling back", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "invalidThenValid"
      });
      const searches: Record<string, unknown>[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          searches.push(input);
          if (input.retrieval_stage === "score_scan") {
            return {
              retrieval: {
                stages: [
                  {
                    name: "leaf_search",
                    countAboveThreshold: 1,
                    maxAllowed: 1
                  }
                ]
              }
            };
          }
          return {
            hits: [
              {
                nodeId: "node-1",
                sourceId: "event-1",
                visibility: "personal",
                summaryText:
                  "KOE144_DYNAMIC_TOOL_EVIDENCE: Koed is running on Docker.",
                citation: { nodeId: "node-1", visibility: "personal" }
              }
            ],
            retrieval: { stage: input.retrieval_stage }
          };
        },
        async expand() {
          throw new Error("expand should not be required for direct evidence");
        }
      };

      const response = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "Are we running koed on docker?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "2"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.localMemoryWorker.appServerExecutions).toHaveLength(2);
      expect(
        response.localMemoryWorker.appServerExecutions?.map(
          (execution) => execution.status
        )
      ).toEqual(["failed", "succeeded"]);
      expect(
        response.localMemoryWorker.appServerExecutions?.[0]?.errorMessage
      ).toContain("JSON");
      const retryTrace = (
        response.evidenceBundle?.retrieval as {
          trace?: {
            budgets?: {
              configured?: { promptTokens?: number };
              consumed?: { promptTokens?: number };
              remaining?: { promptTokens?: number };
              exhausted?: string[];
            };
          };
        }
      ).trace;
      expect(retryTrace?.budgets?.consumed?.promptTokens).toBeGreaterThan(
        response.localMemoryWorker.promptTokenEstimate ?? 0
      );
      expect(retryTrace?.budgets?.remaining?.promptTokens).toBe(
        (retryTrace?.budgets?.configured?.promptTokens ?? 0) -
          (retryTrace?.budgets?.consumed?.promptTokens ?? 0)
      );
      expect(retryTrace?.budgets?.exhausted).toEqual([]);
      expect(searches.map((search) => search.retrieval_stage)).toEqual([
        "score_scan",
        "leaf_search",
        "leaf_search",
        "leaf_search"
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns insufficient when the request-wide prompt-token budget cannot start an attempt", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What did we decide about the prompt budget?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client: {
            async search() {
              return { retrieval: { stages: [] } };
            },
            async expand() {
              throw new Error("expand should not run");
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: writeFakeDynamicMemoryAnswerAppServer(
              directory,
              {
                useTools: false
              }
            ),
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_PROMPT_TOKENS: "512"
          })
        }
      );

      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
      expect(response.structuredAnswer).toMatchObject({
        memory_status: "insufficient"
      });
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        trace: {
          budgets: {
            consumed: { promptTokens: 0, attempts: 0 },
            exhausted: ["prompt_tokens"],
            remaining: { promptTokens: 512 }
          }
        }
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows a grounded positive answer from candidates admitted within the request budget", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "Which candidate is safe to use?",
            evidence: [
              {
                sourceType: "memory_event",
                sourceId: "event-1",
                sourceChunkIndex: 0,
                summaryText: "First candidate"
              },
              {
                sourceType: "memory_event",
                sourceId: "event-2",
                sourceChunkIndex: 0,
                summaryText: "Second candidate"
              }
            ],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client: {
            async search() {
              return { retrieval: { stages: [] } };
            },
            async expand() {
              throw new Error("expand should not run");
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: writeFakeDynamicMemoryAnswerAppServer(
              directory,
              {
                useTools: false
              }
            ),
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_CANDIDATES: "1"
          })
        }
      );

      expect(response.localMemoryWorker.memoryStatus).toBe("found");
      expect(response.evidenceBundle?.evidence).toHaveLength(1);
      const exhausted = (
        response.evidenceBundle?.retrieval as {
          trace?: { budgets?: { exhausted?: unknown[] } };
        }
      ).trace?.budgets?.exhausted;
      expect(exhausted).toContain("candidates");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes bounded evidence truncation from an empty admitted set", async () => {
    const cases = [
      {
        name: "evidence_items",
        env: { MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "1" },
        evidence: [
          {
            sourceType: "memory_event",
            sourceId: "event-1",
            sourceChunkIndex: 0,
            summaryText: "First candidate"
          },
          {
            sourceType: "memory_event",
            sourceId: "event-2",
            sourceChunkIndex: 0,
            summaryText: "Second candidate"
          }
        ]
      },
      {
        name: "evidence_tokens",
        env: { MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "256" },
        evidence: [
          {
            sourceType: "memory_event",
            sourceId: "event-large",
            sourceChunkIndex: 0,
            summaryText: "large-evidence ".repeat(2_000)
          }
        ]
      }
    ] as const;

    for (const testCase of cases) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
      try {
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: {
              query: `Exercise ${testCase.name}`,
              evidence: [...testCase.evidence],
              retrieval: { mode: "app_server_dynamic_tools" }
            }
          },
          {
            client: {
              async search() {
                return { retrieval: { stages: [] } };
              },
              async expand() {
                throw new Error("expand should not run");
              }
            },
            responseDetail: "internal",
            config: resolveMemoryAnswerWorkerConfig({
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_ANSWER_CODEX_BINARY: writeFakeDynamicMemoryAnswerAppServer(
                directory,
                { useTools: false }
              ),
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_ANSWER_MAX_CANDIDATES: "10",
              ...testCase.env
            })
          }
        );

        expect(response.localMemoryWorker.memoryStatus).toBe(
          testCase.name === "evidence_items" ? "found" : "insufficient"
        );
        const exhausted = (
          response.evidenceBundle?.retrieval as {
            trace?: { budgets?: { exhausted?: unknown[] } };
          }
        ).trace?.budgets?.exhausted;
        expect(exhausted).toContain(testCase.name);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects a not-found claim when evidence admission was truncated", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "Is there a recorded decision?",
            evidence: [
              {
                sourceType: "memory_event",
                sourceId: "event-1",
                sourceChunkIndex: 0,
                summaryText: "First candidate"
              },
              {
                sourceType: "memory_event",
                sourceId: "event-2",
                sourceChunkIndex: 0,
                summaryText: "Second candidate"
              }
            ],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client: {
            async search() {
              return { retrieval: { stages: [] } };
            },
            async expand() {
              throw new Error("expand should not run");
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: writeFakeDynamicMemoryAnswerAppServer(
              directory,
              {
                useTools: false,
                answer: answerObject(
                  "No matching relevant memory evidence was found.",
                  "not_found"
                )
              }
            ),
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "1"
          })
        }
      );

      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
      expect(response.localMemoryWorker.errorMessage).toContain(
        "Memory answer budget exhausted: evidence_items"
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects clean insufficient answers without selected partial evidence", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "Which Redis cluster was approved for Mars?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client: {
            async search() {
              return { hits: [], retrieval: { stages: [] } };
            },
            async expand() {
              throw new Error("expand should not run");
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: writeFakeDynamicMemoryAnswerAppServer(
              directory,
              {
                useTools: false,
                answer: answerObject(
                  "There is not enough evidence to answer.",
                  "insufficient"
                )
              }
            ),
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.errorMessage).toContain(
        "returned insufficient after complete retrieval without selected partial evidence"
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns insufficient when a worker expansion exceeds its budget", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "Expand the supporting summary",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client: {
            async search() {
              return { retrieval: { stages: [] } };
            },
            async expand() {
              throw new Error("expand should be rejected before API call");
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: writeFakeDynamicMemoryAnswerAppServer(
              directory,
              { mode: "expandBudget" }
            ),
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_EXPANSIONS: "0"
          })
        }
      );

      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
      const exhausted = (
        response.evidenceBundle?.retrieval as {
          trace?: { budgets?: { exhausted?: unknown[] } };
        }
      ).trace?.budgets?.exhausted;
      expect(exhausted).toContain("expansions");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs a direct-call single-shot evaluation without hidden retrieval", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    let searchCalls = 0;
    try {
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What is the isolated dense result?",
            evidence: [
              {
                sourceType: "memory_event",
                sourceId: "dense-1",
                sourceChunkIndex: 0,
                summaryText: "The isolated dense result is Osprey."
              }
            ],
            retrieval: {
              mode: "retrieval_arena_dense_single_shot",
              provider: "koed-embedding-service",
              model: "qwen3-0.6b",
              dimensions: 1024,
              queryTransform: "none",
              embeddingQueryTransform: "qwen3-retrieval-query-v1",
              embeddingDocumentTransform: "qwen3-retrieval-document-v1"
            }
          }
        },
        {
          client: {
            async search() {
              searchCalls += 1;
              throw new Error("evaluation must not perform retrieval");
            },
            async expand() {
              throw new Error("evaluation must not expand");
            }
          },
          responseDetail: "internal",
          evaluationController: {
            scriptedFirstPass: false,
            exactAnchorChecks: false,
            lcmExpansion: false,
            followUpSearch: false,
            fusion: false,
            retrievalVariant: "qwen_dense_single_shot"
          },
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: writeFakeDynamicMemoryAnswerAppServer(
              directory,
              { useTools: false }
            ),
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          })
        }
      );

      expect(searchCalls).toBe(0);
      expect(response.localMemoryWorker.searchCount).toBe(0);
      expect(response.localMemoryWorker.expandCount).toBe(0);
      expect(response.localMemoryWorker.memoryStatus).toBe("found");
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        trace: {
          evaluationController: {
            scriptedFirstPass: false,
            exactAnchorChecks: false,
            lcmExpansion: false,
            followUpSearch: false,
            fusion: false,
            retrievalVariant: "qwen_dense_single_shot"
          }
        }
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects descriptive-only evaluation variants without matching pre-retrieval artifacts", async () => {
    await expect(
      answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "Invalid dense label",
            evidence: [],
            retrieval: { mode: "production" }
          }
        },
        {
          evaluationController: {
            scriptedFirstPass: false,
            lcmExpansion: false,
            followUpSearch: false,
            fusion: false,
            retrievalVariant: "qwen_dense_single_shot"
          }
        }
      )
    ).rejects.toThrow(/requires a service-verified qwen3-0.6b\/1024 dense/);

    await expect(
      answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "Invalid no-anchor composition",
            evidence: [
              {
                sourceType: "memory_node",
                sourceId: "node-1",
                sourceChunkIndex: 0,
                lexicalAnchors: ["still embedded"]
              }
            ],
            retrieval: {
              evaluationComposition:
                "valid_structured_summaries_empty_lexical_anchors"
            }
          }
        },
        {
          evaluationController: {
            retrievalVariant: "empty_lexical_anchors"
          }
        }
      )
    ).rejects.toThrow(/evidence containing lexical anchors/);
  });

  it("rejects scan-only not_found answers when scan candidates remain uninspected", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "scanOnlyNotFound"
      });
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          expect(input.retrieval_stage).toBe("score_scan");
          return {
            retrieval: {
              stages: [
                {
                  name: "leaf_search",
                  countAboveThreshold: 2,
                  maxAllowed: 2
                }
              ]
            }
          };
        },
        async expand() {
          throw new Error("expand should not be required for scan-only answer");
        }
      };

      const response = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "Are we running koed on docker?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "3"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.errorMessage).toContain(
        "retrieval failures"
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects not_found answers while scan-positive stages remain uninspected", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "partialStageNotFound"
      });
      const searches: Record<string, unknown>[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          searches.push(input);
          if (input.retrieval_stage === "score_scan") {
            return {
              retrieval: {
                stages: [
                  {
                    name: "leaf_search",
                    countAboveThreshold: 1,
                    maxAllowed: 1
                  },
                  {
                    name: "raw_fallback_search",
                    countAboveThreshold: 1,
                    maxAllowed: 1
                  }
                ]
              }
            };
          }
          return {
            hits: [],
            retrieval: { stage: input.retrieval_stage }
          };
        },
        async expand() {
          throw new Error(
            "expand should not be required for partial-stage not_found answer"
          );
        }
      };

      const response = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "Are we running koed on docker?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "3"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.errorMessage).toContain(
        "before inspecting scan-positive stages"
      );
      expect(response.localMemoryWorker.errorMessage).toContain(
        "raw_fallback_search"
      );
      expect(searches.map((search) => search.retrieval_stage)).toEqual([
        "score_scan",
        "leaf_search",
        "leaf_search"
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caps score-scan calls with the configured search budget", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "scanLoop"
      });
      const searches: Record<string, unknown>[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          searches.push(input);
          return {
            retrieval: {
              stages: [
                {
                  name: "leaf_search",
                  countAboveThreshold: 1,
                  maxAllowed: 1
                }
              ]
            }
          };
        },
        async expand() {
          throw new Error("expand should not be required for scan-loop answer");
        }
      };

      const response = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "Are we running koed on docker?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          responseDetail: "internal",
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "1"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
      expect(response.localMemoryWorker.errorMessage).toContain(
        "Memory answer budget exhausted: searches"
      );
      const exhausted = (
        response.evidenceBundle?.retrieval as {
          trace?: { budgets?: { exhausted?: unknown[] } };
        }
      ).trace?.budgets?.exhausted;
      expect(exhausted).toContain("searches");
      expect(exhausted).toContain("attempts");
      expect(searches).toHaveLength(1);
      expect(searches[0]?.retrieval_stage).toBe("score_scan");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back when first-pass retrieval fails and the worker claims unsupported evidence", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        useTools: false,
        requiredPromptSnippets: ["First-pass scan failed"]
      });
      const client: MemoryAnswerRetrievalClient = {
        async search() {
          throw new Error(
            "search should not be called by this fake app-server"
          );
        },
        async expand() {
          throw new Error(
            "expand should not be called by this fake app-server"
          );
        }
      };

      const response = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "Are we running koed on docker?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client,
          retrievalScope: "personal",
          searchDomain: "project",
          projectId: "workspace-1",
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.skippedReason).toBe("codex_failed");
      expect(response.localMemoryWorker.errorMessage).toContain(
        "without resolvable supporting evidence"
      );
      expect(response.markdown).toBe(
        "The Codex worker reached the Memory Answer resource limit before it could produce a reliable answer. Try a narrower question."
      );
      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
      expect(response.structuredAnswer).toMatchObject({
        memory_status: "insufficient",
        relevant_memory_found: false,
        evidence: []
      });
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        mode: "scripted_first_pass_with_worker_follow_up_failed",
        trace: {
          version: 2,
          orderedErrors: [
            {
              phase: "first_pass",
              operation: "search",
              errorClass: "Error"
            }
          ],
          attempts: [
            {
              attemptIndex: 1,
              status: "failed"
            }
          ],
          budgets: {
            consumed: { attempts: 1, searches: 1 },
            remaining: { attempts: 0, searches: 5 }
          },
          modelMetadata: {}
        }
      });
      const trace = (
        response.evidenceBundle?.retrieval as {
          trace?: {
            attempts?: Array<{ model?: unknown }>;
            modelMetadata?: {
              configuredModel?: unknown;
              promptTokenEstimate?: unknown;
            };
          };
        }
      ).trace;
      expect(typeof trace?.attempts?.[0]?.model).toBe("string");
      expect(typeof trace?.modelMetadata?.configuredModel).toBe("string");
      expect(typeof trace?.modelMetadata?.promptTokenEstimate).toBe("number");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds retrieval hints at the request schema", () => {
    expect(
      memoryAnswerRetrievalHintsSchema.safeParse({
        lexical: Array.from(
          { length: MEMORY_RETRIEVAL_HINT_MAX_COUNT + 1 },
          (_, index) => `term-${index}`
        )
      }).success
    ).toBe(false);
    expect(
      memoryAnswerRetrievalHintsSchema.parse({
        exact: ["REQUEST_BODY_LIMIT_BYTES"],
        semantic: ["request payload size configuration"],
        temporal_intent: "current state"
      })
    ).toMatchObject({ temporal_intent: "current state" });
    expect(
      memoryAnswerRetrievalHintsSchema.safeParse({
        exact: ["x".repeat(MEMORY_RETRIEVAL_HINT_MAX_LENGTH)]
      }).success
    ).toBe(true);
    expect(
      memoryAnswerRetrievalHintsSchema.safeParse({
        exact: ["x".repeat(MEMORY_RETRIEVAL_HINT_MAX_LENGTH + 1)]
      }).success
    ).toBe(false);
    expect(
      memoryAnswerRetrievalHintsSchema.safeParse({
        exact: Array.from(
          { length: MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT },
          (_, index) => `hint-${index}`
        )
      }).success
    ).toBe(true);
    expect(
      memoryAnswerRetrievalHintsSchema.safeParse({
        exact: Array.from(
          { length: MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT + 1 },
          (_, index) => `hint-${index}`
        )
      }).success
    ).toBe(false);
  });

  it("never lets worker-selected domains broaden the effective boundary", () => {
    expect(
      resolveMemoryAnswerSearchDomain(
        "global",
        { project_id: "/other" },
        { searchDomain: "project", projectId: "/repo/koed" }
      )
    ).toEqual({ searchDomain: "project", projectId: "/repo/koed" });
    expect(
      resolveMemoryAnswerSearchDomain(
        "session",
        { session_id: "unverified-session" },
        {
          searchDomain: "project",
          sessionId: "unverified-session",
          projectId: "/repo/koed"
        }
      )
    ).toEqual({ searchDomain: "project", projectId: "/repo/koed" });
    expect(
      resolveMemoryAnswerSearchDomain(
        "project",
        { project_id: "/other" },
        {
          searchDomain: "session",
          sessionId: "session-1",
          projectId: "/repo/koed"
        }
      )
    ).toEqual({ searchDomain: "session", sessionId: "session-1" });
  });

  it("deduplicates candidates by source chunk and retains RRF contributions", () => {
    const fused = mergeMemoryAnswerCandidateLists(
      [],
      [
        {
          query: "first",
          stage: "leaf_search",
          hits: [
            {
              sourceType: "memory_event",
              sourceId: "event-1",
              sourceChunkIndex: 0
            },
            {
              sourceType: "memory_event",
              sourceId: "event-1",
              sourceChunkIndex: 1
            }
          ]
        },
        {
          query: "second",
          stage: "raw_fallback_search",
          hits: [
            {
              sourceType: "memory_event",
              sourceId: "event-1",
              sourceChunkIndex: 0
            }
          ]
        }
      ]
    );

    expect(fused).toHaveLength(2);
    expect(fused[0]).toMatchObject({
      sourceChunkIndex: 0,
      retrievalContributions: [{ query: "first" }, { query: "second" }]
    });
  });

  it("gives expanded source chunks stable distinct identities and one corroboration group", () => {
    const evidence = evidenceFromExpansion({
      expanded: {
        nodeId: "parent-node",
        visibility: "personal",
        sourceItems: [
          {
            sourceId: "pseudonymous-source-1",
            position: 7,
            text: "First source chunk",
            createdAt: "2026-08-01T10:00:00.000Z",
            occurredAt: "2026-07-31T09:00:00.000Z",
            payload: {
              sourceRevision: 12,
              sourceGenerationId: "pseudonymous-generation-3",
              freshness: "current",
              representation: "memory_events"
            },
            provenance: {
              line: 10,
              text: "plaintext provenance must not escape",
              teamWorkspaceId: "canonical-team-workspace-id"
            },
            grantProvenance: {
              policyRevision: 4,
              shareGrantId: "canonical-share-grant-id"
            }
          },
          {
            text: "Second source chunk",
            createdAt: "2026-07-30T08:00:00.000Z",
            provenance: { line: 20 }
          }
        ]
      }
    }) as Array<Record<string, unknown>>;

    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      sourceId: "pseudonymous-source-1",
      sourceChunkIndex: 7,
      sourcePosition: 0,
      expandedFromNodeId: "parent-node",
      corroborationGroupId: "parent-node",
      createdAt: "2026-08-01T10:00:00.000Z",
      occurredAt: "2026-07-31T09:00:00.000Z",
      sourceRevision: 12,
      sourceGeneration: "pseudonymous-generation-3",
      freshness: "current",
      representation: "memory_events",
      provenance: { line: 10 },
      grantProvenance: { policyRevision: 4 },
      citation: {
        sourceId: "pseudonymous-source-1",
        sourceChunkIndex: 7,
        sourceRevision: 12,
        sourceGeneration: "pseudonymous-generation-3",
        freshness: "current",
        representation: "memory_events",
        provenance: { line: 10 },
        grantProvenance: { policyRevision: 4 }
      }
    });
    expect(evidence[1]).toMatchObject({
      sourceChunkIndex: 1,
      sourcePosition: 1,
      expandedFromNodeId: "parent-node",
      corroborationGroupId: "parent-node",
      occurredAt: "2026-07-30T08:00:00.000Z",
      provenance: { line: 20 }
    });
    expect(evidence[0]?.sourceId).not.toBe(evidence[1]?.sourceId);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("plaintext provenance must not escape");
    expect(serialized).not.toContain("canonical-team-workspace-id");
    expect(serialized).not.toContain("canonical-share-grant-id");
  });

  it("deduplicates an expanded Team item against its searched canonical source", () => {
    const canonicalSourceIdentity = {
      sourceType: "memory_node",
      sourceId: "pseudonymous-source-1",
      sourceChunkIndex: 7
    };
    const [expanded] = evidenceFromExpansion({
      expanded: {
        nodeId: "candidate-1",
        visibility: "team",
        sourceItems: [
          {
            kind: "lcm_child",
            sourceId: "pseudonymous-source-1",
            position: 7,
            canonicalSourceIdentity,
            text: "Expanded source"
          }
        ]
      }
    });
    const merged = mergeMemoryAnswerCandidateLists(
      [
        {
          nodeId: "candidate-1",
          sourceType: "memory_node",
          sourceId: "pseudonymous-source-1",
          sourceChunkIndex: 7,
          canonicalSourceIdentity,
          summaryText: "Search hit"
        }
      ],
      [{ query: "q", stage: "expanded_source", hits: [expanded] }]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ canonicalSourceIdentity });
  });

  it("bounds an adversarial retrieval trace to 32 KiB deterministically", () => {
    const longIdentity = "identity-".repeat(10_000);
    const trace = {
      version: 2,
      retrievalHints: {
        exact: Array.from(
          { length: 100 },
          (_, index) => `${index}:${longIdentity}`
        )
      },
      effectiveBoundary: {
        searchDomain: "project",
        projectId: longIdentity,
        teamWorkspaceId: "canonical-team-workspace-id"
      },
      orderedErrors: Array.from({ length: 100 }, (_, index) => ({
        operation: `${index}:${longIdentity}`,
        errorClass: longIdentity
      })),
      attempts: Array.from({ length: 100 }, (_, index) => ({
        attemptIndex: index,
        status: longIdentity,
        model: longIdentity
      })),
      selectedIdentities: Array.from({ length: 100 }, (_, index) => ({
        sourceType: longIdentity,
        sourceId: `${index}:${longIdentity}`,
        nodeId: longIdentity,
        shareGrantId: "canonical-share-grant-id"
      })),
      candidateIdentities: Array.from({ length: 100 }, (_, index) => ({
        sourceType: longIdentity,
        sourceId: `${index}:${longIdentity}`,
        nodeId: longIdentity,
        provenance: { label: longIdentity, rawBody: longIdentity }
      })),
      budgets: { configured: { promptTokens: 24_000 } },
      modelMetadata: { configuredModel: longIdentity }
    };

    const first = boundMemoryAnswerTrace(trace);
    const second = boundMemoryAnswerTrace(trace);
    const serialized = JSON.stringify(first);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(32_768);
    expect(second).toEqual(first);
    expect(serialized).not.toContain("canonical-team-workspace-id");
    expect(serialized).not.toContain("canonical-share-grant-id");
    expect(serialized).not.toContain(longIdentity);
  });

  it("resolves structured evidence selection to one exact source chunk", () => {
    const candidates = [
      {
        sourceType: "memory_event",
        sourceId: "event-1",
        sourceChunkIndex: 0,
        summaryText: "Unselected chunk"
      },
      {
        sourceType: "memory_event",
        sourceId: "event-1",
        sourceChunkIndex: 1,
        summaryText: "Selected chunk"
      }
    ];
    const structuredAnswer: StructuredMemoryAnswer = {
      schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
      memory_status: "found",
      relevant_memory_found: true,
      answer_markdown: "Selected chunk",
      relevance_explanation: "The second chunk supports the answer.",
      evidence: [
        {
          source_type: "memory_event",
          source_id: "event-1",
          source_chunk_index: 1
        }
      ],
      missing: [],
      missing_evidence: []
    };

    expect(evidenceSelectedByAnswer(candidates, structuredAnswer)).toEqual([
      candidates[1]
    ]);
  });

  it("runs independent first-pass semantic searches concurrently and checks exact anchors", async () => {
    let active = 0;
    let maximumActive = 0;
    const requests: Record<string, unknown>[] = [];
    const result = await runScriptedMemoryAnswerFirstPass({
      client: {
        async search(input) {
          requests.push(input);
          if (input.retrieval_stage === "score_scan") {
            const stageNames =
              input.query === "request payload size setting"
                ? ["raw_fallback_search"]
                : ["leaf_search"];
            const retrieval = {
              stages: stageNames.map((name) => ({
                name,
                countAboveThreshold: 2,
                maxAllowed: 2
              })),
              databaseReads: 5,
              hydrationCount: 2,
              decryptCount: 0,
              embeddingCalls: 1,
              embeddingTokens: 17
            };
            return input.query === "request payload size setting"
              ? { evidenceBundle: { retrieval } }
              : { retrieval };
          }
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          const evidence = [
            {
              sourceType: "memory_event",
              sourceId: "event-1",
              sourceChunkIndex: input.retrieval_stage === "leaf_search" ? 0 : 1,
              summaryText: "Use REQUEST_BODY_LIMIT_BYTES for this limit.",
              ...(input.retrieval_stage === "leaf_search"
                ? { lexicalAnchors: ["REQUEST_BODY_LIMIT_BYTES"] }
                : { lexical_anchors: ["REQUEST_BODY_LIMIT_BYTES"] })
            }
          ];
          return {
            ...(input.retrieval_stage === "leaf_search"
              ? { evidence }
              : { hits: evidence }),
            retrieval: { stage: input.retrieval_stage }
          };
        },
        async expand() {
          throw new Error("not used");
        }
      },
      query: "What controls request size?",
      retrievalHints: {
        exact: ["REQUEST_BODY_LIMIT_BYTES"],
        lexical: ["request limit"],
        semantic: ["request payload size setting"]
      },
      retrievalScope: "personal",
      searchDomain: "project",
      projectId: "/repo/koed",
      limit: 10,
      maxSearches: 6
    });

    expect(maximumActive).toBeGreaterThan(1);
    expect(result.searches).toHaveLength(5);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({
      exactAnchorMatches: ["REQUEST_BODY_LIMIT_BYTES"]
    });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceChunkIndex: 1,
          lexical_anchors: ["REQUEST_BODY_LIMIT_BYTES"],
          exactAnchorMatches: ["REQUEST_BODY_LIMIT_BYTES"]
        })
      ])
    );
    expect(
      requests.every((request) => request.search_domain === "project")
    ).toBe(true);
    expect(
      requests.every((request) => request.project_id === "/repo/koed")
    ).toBe(true);
    expect(
      requests.some((request) => request.retrieval_stage === "lexical_search")
    ).toBe(false);
    expect(
      requests.every(
        (request) =>
          JSON.stringify(request.exact_hints) ===
          JSON.stringify(["REQUEST_BODY_LIMIT_BYTES", "request limit"])
      )
    ).toBe(true);
    expect(requests).toContainEqual(
      expect.objectContaining({
        query: "request payload size setting",
        retrieval_stage: "raw_fallback_search"
      })
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        query: "REQUEST_BODY_LIMIT_BYTES",
        retrieval_stage: "score_scan"
      })
    );
    expect(result.skippedQueries).toEqual([
      {
        query: "request limit",
        hintClass: "lexical_exact_seed",
        reason: "search_budget"
      }
    ]);
    expect(result.errors).toEqual([]);
    expect(result.retrievals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          databaseReads: 5,
          embeddingCalls: 1,
          embeddingTokens: 17
        })
      ])
    );
  });

  it("fairly schedules all first-pass hint classes at the default budget and reports overflow", async () => {
    const hasQuery = (
      input: Record<string, unknown>
    ): input is Record<string, unknown> & { query: string } =>
      typeof input.query === "string";
    const requests: Array<Record<string, unknown> & { query: string }> = [];
    const result = await runScriptedMemoryAnswerFirstPass({
      client: {
        async search(input) {
          if (!hasQuery(input)) {
            throw new Error(
              "expected scripted search request to include query"
            );
          }
          requests.push(input);
          return {
            hits: [],
            retrieval: {
              stages:
                input.retrieval_stage === "score_scan"
                  ? [
                      {
                        name: "leaf_search",
                        countAboveThreshold: 1,
                        maxAllowed: 1
                      }
                    ]
                  : []
            }
          };
        },
        async expand() {
          throw new Error("not used");
        }
      },
      query: "caller question",
      retrievalHints: {
        semantic: ["semantic one", "semantic two"],
        exact: ["EXACT_ONE", "EXACT_TWO"],
        lexical: ["lexical one", "lexical two"]
      },
      retrievalScope: "personal",
      searchDomain: "global",
      limit: 10,
      maxSearches: 6
    });

    expect(requests.slice(0, 3)).toEqual([
      expect.objectContaining({
        query: "caller question",
        retrieval_stage: "score_scan"
      }),
      expect.objectContaining({
        query: "semantic one",
        retrieval_stage: "score_scan"
      }),
      expect.objectContaining({
        query: "EXACT_ONE",
        retrieval_stage: "score_scan"
      })
    ]);
    expect(result.searches).toHaveLength(5);
    expect(result.skippedQueries).toEqual([
      {
        query: "semantic two",
        hintClass: "semantic_reformulation",
        reason: "search_budget"
      },
      {
        query: "EXACT_TWO",
        hintClass: "lexical_exact_seed",
        reason: "search_budget"
      },
      {
        query: "lexical one",
        hintClass: "lexical_exact_seed",
        reason: "search_budget"
      },
      {
        query: "lexical two",
        hintClass: "lexical_exact_seed",
        reason: "search_budget"
      }
    ]);
  });

  it("covers distinct scan-positive stages before repeating a stage for another query", async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await runScriptedMemoryAnswerFirstPass({
      client: {
        async search(input) {
          requests.push(input);
          if (input.retrieval_stage === "score_scan") {
            return {
              hits: [],
              retrieval: {
                stages: [
                  {
                    name: "leaf_search",
                    countAboveThreshold: 1,
                    maxAllowed: 1
                  },
                  {
                    name: "raw_fallback_search",
                    countAboveThreshold: 1,
                    maxAllowed: 1
                  }
                ]
              }
            };
          }
          return { hits: [], retrieval: { stage: input.retrieval_stage } };
        },
        async expand() {
          throw new Error("not used");
        }
      },
      query: "Which Redis cluster was approved for Mars?",
      retrievalHints: { semantic: ["Mars Redis deployment decision"] },
      retrievalScope: "personal",
      searchDomain: "project",
      projectId: "retrieval-arena-redis-mars",
      limit: 8,
      maxSearches: 5
    });

    expect(result.searches).toHaveLength(4);
    expect(
      requests
        .filter((request) => request.retrieval_stage !== "score_scan")
        .map((request) => request.retrieval_stage)
    ).toEqual(["leaf_search", "raw_fallback_search"]);
  });

  it("uses production Team score-scan hits directly when stages are absent", async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await runScriptedMemoryAnswerFirstPass({
      client: {
        async search(input) {
          requests.push(input);
          return {
            hits: [
              {
                sourceType: "shared_memory_event",
                sourceId: "pseudonymous-team-source",
                sourceChunkIndex: 2,
                summaryText: "The rollout codename is Osprey.",
                lexicalAnchors: ["Osprey"],
                representation: "memory_events",
                sourceRevision: 9,
                freshness: "current",
                sourceTime: "2026-08-01T08:30:00.000Z",
                visibilityProvenance: {
                  shareGrantId: "canonical-share-grant-id",
                  representationId: "canonical-representation-id",
                  representation: "memory_events",
                  provenanceHash: "opaque-team-provenance"
                },
                generation: {
                  representationPolicyRevision: 4,
                  contentPolicyVersion: 3,
                  embeddingVersion: "team-embedding-v2"
                },
                citation: {
                  sourceType: "shared_memory_event",
                  sourceId: "pseudonymous-team-source",
                  sourceChunkIndex: 2,
                  visibility: "team"
                }
              }
            ],
            retrieval: {
              retrievalMode: "semantic_vector",
              requestedStage: "score_scan"
            }
          };
        },
        async expand() {
          throw new Error("not used");
        }
      },
      query: "What is the rollout codename?",
      retrievalHints: { exact: ["Osprey"] },
      retrievalScope: "team",
      searchDomain: "project",
      projectId: "/repo/koed",
      teamWorkspaceId: "local-edge-workspace",
      limit: 10,
      maxSearches: 2
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      retrieval_stage: "score_scan",
      retrieval_scope: "team",
      exact_hints: ["Osprey"],
      limit: 10
    });
    expect(result.searches).toEqual([
      expect.objectContaining({
        retrievalStage: "score_scan",
        hitCount: 1
      })
    ]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        sourceId: "pseudonymous-team-source",
        sourceChunkIndex: 2,
        representation: "memory_events",
        sourceRevision: 9,
        freshness: "current",
        occurredAt: "2026-08-01T08:30:00.000Z",
        visibilityProvenance: {
          representation: "memory_events",
          provenanceHash: "opaque-team-provenance"
        },
        generationProvenance: {
          representationPolicyRevision: 4,
          contentPolicyVersion: 3,
          embeddingVersion: "team-embedding-v2"
        },
        exactAnchorMatches: ["Osprey"]
      })
    ]);
    expect(result.citations).toEqual([
      expect.objectContaining({
        sourceId: "pseudonymous-team-source",
        sourceRevision: 9,
        occurredAt: "2026-08-01T08:30:00.000Z",
        visibilityProvenance: {
          representation: "memory_events",
          provenanceHash: "opaque-team-provenance"
        }
      })
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("canonical-share-grant-id");
    expect(serialized).not.toContain("canonical-representation-id");
  });

  it("propagates semantic-stage incompleteness instead of treating it as absence", async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await runScriptedMemoryAnswerFirstPass({
      client: {
        async search(input) {
          requests.push(input);
          return {
            hits: [],
            retrieval: {
              retrievalMode: "embedding_unavailable",
              semanticRetrievalComplete: false,
              semanticRetrievalError: "embedding service offline"
            }
          };
        },
        async expand() {
          throw new Error("not used");
        }
      },
      query: "What did memory say?",
      retrievalScope: "personal",
      searchDomain: "global",
      limit: 10,
      maxSearches: 2
    });

    expect(result.evidence).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("retrieval_stage");
    expect(result.searches).toEqual([
      expect.objectContaining({ retrievalStage: "all_stages" })
    ]);
    expect(result.errors).toEqual([
      expect.stringMatching(/semantic retrieval incomplete.*offline/i)
    ]);
  });

  it("keeps default first-pass behavior and applies exact-check/fusion ablations before selection", async () => {
    const requests: Record<string, unknown>[] = [];
    const run = (overrides?: {
      exactAnchorChecks?: boolean;
      fusion?: boolean;
    }) =>
      runScriptedMemoryAnswerFirstPass({
        client: {
          async search(input) {
            requests.push(input);
            return {
              hits: [
                {
                  sourceType: "memory_event",
                  sourceId: "event-1",
                  sourceChunkIndex: 0,
                  summaryText: "ANCHOR supports this result.",
                  lexicalAnchors: ["ANCHOR"]
                }
              ],
              retrieval: { retrievalMode: "semantic_vector" }
            };
          },
          async expand() {
            throw new Error("not used");
          }
        },
        query: "original query",
        retrievalHints: { semantic: ["alternate query"], exact: ["ANCHOR"] },
        retrievalScope: "personal",
        searchDomain: "project",
        projectId: "/repo/koed",
        limit: 10,
        maxSearches: 5,
        ...overrides
      });

    const implicitDefault = await run();
    const explicitDefault = await run({
      exactAnchorChecks: true,
      fusion: true
    });
    expect(explicitDefault.evidence).toEqual(implicitDefault.evidence);
    expect(implicitDefault.evidence).toHaveLength(1);
    expect(implicitDefault.evidence[0]).toMatchObject({
      exactAnchorMatches: ["ANCHOR"]
    });
    expect(
      Array.isArray(
        (implicitDefault.evidence[0] as Record<string, unknown>)
          .retrievalContributions
      )
    ).toBe(true);

    requests.length = 0;
    const ablated = await run({ exactAnchorChecks: false, fusion: false });
    expect(ablated.evidence).toHaveLength(2);
    expect(
      ablated.evidence.every(
        (item) =>
          !("exactAnchorMatches" in (item as Record<string, unknown>)) &&
          !("retrievalContributions" in (item as Record<string, unknown>))
      )
    ).toBe(true);
    expect(requests.every((request) => request.exact_hints === undefined)).toBe(
      true
    );
  });
});
