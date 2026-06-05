import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMORY_ANSWER_PROMPT_VERSION,
  MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
  answerWithMemoryWorker,
  compactMemoryAnswerPayload,
  resolveMemoryAnswerWorkerConfig,
  type MemoryAnswerPayload,
  type MemoryAnswerRetrievalClient
} from "../src/answer-worker.js";

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
      | "invalidThenValid"
      | "partialStageNotFound"
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
    send({ id: 9001, method: "item/tool/call", params: { threadId, turnId, callId: "call-scan", namespace: "koed_memory", tool: "scan", arguments: { query: "koed docker", search_domain: "project", workspace_id: "workspace-1" } } });
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
      send({ id: 9002, method: "item/tool/call", params: { threadId, turnId, callId: "call-scan-again", namespace: "koed_memory", tool: "scan", arguments: { query: "koed docker again", search_domain: "project", workspace_id: "workspace-1" } } });
      return;
    }
    send({ id: 9002, method: "item/tool/call", params: { threadId, turnId, callId: "call-search", namespace: "koed_memory", tool: "search", arguments: { query: "koed docker", stage: "leaf_search", search_domain: "project", workspace_id: "workspace-1", limit: 1 } } });
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
});
`,
    { mode: 0o600 }
  );
  return scriptPath;
};

describe("memory answer worker", () => {
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

  it("resolves Codex app-server memory-answer config without a mode switch", () => {
    const config = resolveMemoryAnswerWorkerConfig({
      MEMORY_ANSWER_PROVIDER: "codex",
      MEMORY_ANSWER_MODEL: "gpt-5.3-codex-spark",
      MEMORY_ANSWER_REASONING_EFFORT: "low",
      MEMORY_ANSWER_TIMEOUT_MS: "25000",
      MEMORY_ANSWER_MAX_ATTEMPTS: "3",
      MEMORY_ANSWER_MAX_SEARCHES: "4",
      MEMORY_ANSWER_MAX_EXPANSIONS: "2",
      MEMORY_ANSWER_CODEX_BINARY: "/bin/codex"
    });

    expect(config.provider).toBe("codex");
    expect(config.model).toBe("gpt-5.3-codex-spark");
    expect(config.reasoningEffort).toBe("low");
    expect(config.timeoutMs).toBe(25000);
    expect(config.maxAttempts).toBe(3);
    expect(config.maxSearches).toBe(4);
    expect(config.maxExpansions).toBe(2);
  });

  it("sends recency and conflict guidance to the memory-answer worker prompt", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        useTools: false,
        requiredPromptSnippets: [
          "Recency and conflict rules:",
          "If the user asks for current/latest state, prefer newer directly relevant evidence when it appears to supersede older evidence.",
          "If the user asks about history, prior decisions, evolution, or what changed, summarize the timeline instead of collapsing to only the newest fact.",
          "If newer evidence is weak or indirect but older evidence is direct, report the uncertainty instead of treating recency as decisive.",
          "If older and newer evidence conflict, say that the memory appears to have changed over time and explain both sides briefly.",
          "including recency/conflict reasoning when evidence differs over time"
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
        workspaceId: "workspace-1",
        config: resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_CODEX_BINARY: appServerBinary
        })
      });

      expect(response.localMemoryWorker.errorMessage).toBeUndefined();
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.localMemoryWorker.promptVersion).toBe(
        MEMORY_ANSWER_PROMPT_VERSION
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
          workspaceId: "workspace-1",
          responseDetail: "with_evidence",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MODEL: "gpt-5.4-mini",
            MEMORY_ANSWER_REASONING_EFFORT: "medium",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary
          })
        }
      );

      expect(response.markdown).toContain("Koed is running on Docker");
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.localMemoryWorker.searchCount).toBe(2);
      expect(response.localMemoryWorker.appServerThreadId).toBe(
        "thread-dynamic-answer-1"
      );
      expect(response.localMemoryWorker.appServerTurnId).toBe(
        "turn-dynamic-answer-1"
      );
      expect(response.localMemoryWorker.appServerExecutions).toHaveLength(1);
      expect(response.localMemoryWorker.tokenUsage?.last?.totalTokens).toBe(99);
      expect(response.evidence).toHaveLength(1);
      expect(searches.map((search) => search.retrieval_stage)).toEqual([
        "score_scan",
        "leaf_search"
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recreates the app-server session for retry attempts after a timeout", async () => {
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
          workspaceId: "workspace-1",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_TIMEOUT_MS: "25",
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
        response.localMemoryWorker.appServerExecutions?.map(
          (execution) => execution.threadId
        )
      ).toEqual(["thread-dynamic-answer-1", "thread-dynamic-answer-2"]);
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
          workspaceId: "workspace-1",
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
      expect(searches.map((search) => search.retrieval_stage)).toEqual([
        "score_scan",
        "leaf_search",
        "score_scan",
        "leaf_search"
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
          workspaceId: "workspace-1",
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
        "after scan candidates without inspecting evidence"
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
          workspaceId: "workspace-1",
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
          retrievalScope: "personal",
          searchDomain: "project",
          workspaceId: "workspace-1",
          config: resolveMemoryAnswerWorkerConfig({
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_CODEX_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "1"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.localMemoryWorker.memoryStatus).toBe("not_found");
      expect(searches).toHaveLength(1);
      expect(searches[0]?.retrieval_stage).toBe("score_scan");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back when the app-server worker answers without using Koed RAG tools", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        useTools: false
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
          workspaceId: "workspace-1",
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
        "without using Koed RAG tools"
      );
      expect(response.markdown).toBe(
        "Memory answer worker failed before judging retrieved evidence."
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
