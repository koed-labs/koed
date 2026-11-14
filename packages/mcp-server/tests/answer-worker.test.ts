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
import { countTokensForModel } from "@koed-labs/core";
import {
  MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_LENGTH
} from "@koed-labs/shared";
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
import {
  toolAnswerResponse,
  persistedAnswerResponse
} from "../src/memory-question-answer-persistence.js";
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
      | "admissionRecovery"
      | "expandResult"
      | "expandThenSearch"
      | "invalidThenValid"
      | "expandBudget"
      | "emptySearchNotFound"
      | "partialStageNotFound"
      | "refineSearch"
      | "scanLoop"
      | "scanOnlyNotFound"
      | "eventWindowBudget"
      | "repeatSummary"
      | "timeoutThenValid";
    answer?: Record<string, unknown>;
    capturePromptsPath?: string;
    captureToolResponsesPath?: string;
    requiredPromptSnippets?: string[];
    retryPromptSnippets?: string[];
    searchArguments?: Record<string, unknown>;
    expandArguments?: Record<string, unknown>;
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
const retryPromptSnippets = ${JSON.stringify(options.retryPromptSnippets ?? [])};
const capturePromptsPath = ${JSON.stringify(options.capturePromptsPath ?? null)};
const captureToolResponsesPath = ${JSON.stringify(options.captureToolResponsesPath ?? null)};
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
    if (capturePromptsPath) fs.appendFileSync(capturePromptsPath, JSON.stringify(promptText) + "\\n");
    for (const snippet of [...requiredPromptSnippets, ...(attempt > 1 ? retryPromptSnippets : [])]) {
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
      sendFinal(mode === "invalidThenValid" && attempt === 1 ? { ...answer, relevant_memory_found: false } : answer);
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
    if (["expandBudget", "expandSuccess", "expandThenSearch", "admissionRecovery", "expandResult"].includes(mode)) {
      send({ id: 9003, method: "item/tool/call", params: { threadId, turnId, callId: "call-expand", namespace: "koed_memory", tool: "expand", arguments: { node_id: "node-1", ...${JSON.stringify(options.expandArguments ?? {})} } } });
      return;
    }
    if (mode === "refineSearch") {
      send({ id: 9002, method: "item/tool/call", params: { threadId, turnId, callId: "call-refined-search", namespace: "koed_memory", tool: "search", arguments: { query: "deployment sentinel configuration", stage: "leaf_search", search_domain: "project", project_id: "workspace-1", exact_hints: ["DEPLOYMENT_MODE", "DEPLOYMENT_MODE"], limit: 50 } } });
      return;
    }
    send({ id: 9002, method: "item/tool/call", params: { threadId, turnId, callId: "call-search", namespace: "koed_memory", tool: "search", arguments: { query: "koed docker", stage: "leaf_search", search_domain: "project", project_id: "workspace-1", limit: 1, ...${JSON.stringify(options.searchArguments ?? {})} } } });
    return;
  }
  if (message.id === 9002) {
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (captureToolResponsesPath) fs.appendFileSync(captureToolResponsesPath, text + "\\n");
    if (mode === "eventWindowBudget") {
      const observation = JSON.parse(text);
      if (!text.includes("budget_exhausted") && !(observation.hits?.length === 0 && observation.state?.omittedSources?.length > 0)) process.exit(73);
      sendFinal(notFoundAnswer);
      return;
    }
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
    if (mode === "repeatSummary") {
      send({ id: 9004, method: "item/tool/call", params: { threadId, turnId, callId: "repeat-summary", namespace: "koed_memory", tool: "search", arguments: { query: "summary followup", stage: "leaf_search", limit: 1, summaryRepresentation: "complete_summary" } } });
      return;
    }
    if (!text.includes("KOE144_DYNAMIC_TOOL_EVIDENCE")) {
      console.error("expected search evidence in tool response, got " + text.slice(0, 200));
      process.exit(64);
    }
    if (mode === "invalidThenValid" && attempt === 1) {
      sendFinal({ ...answer, relevant_memory_found: false });
      return;
    }
    sendFinal(answer);
    return;
  }
  if (message.id === 9003) {
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (captureToolResponsesPath) fs.appendFileSync(captureToolResponsesPath, text + "\\n");
    if (mode === "admissionRecovery") {
      const observation = JSON.parse(text);
      const omitted = observation.state?.omittedSources?.find(entry => entry.source.source_id === "head-event");
      if (!omitted || observation.expandedEvidence?.some(entry => entry.item.sourceId === "head-event")) process.exit(75);
      send({ id: 9005, method: "item/tool/call", params: { threadId, turnId, callId: "recover-source", namespace: "koed_memory", tool: "expand", arguments: { nodeId: omitted.nodeId, sources: [omitted.source] } } });
      return;
    }
    if (mode === "expandResult") { sendFinal(answer); return; }
    if (mode === "expandThenSearch") {
      if (!text.includes("GROUNDED_CHILD_EVIDENCE")) process.exit(70);
      send({ id: 9004, method: "item/tool/call", params: { threadId, turnId, callId: "later-search", namespace: "koed_memory", tool: "search", arguments: { query: "later search", stage: "leaf_search", limit: 1 } } });
      return;
    }
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
  if (message.id === 9005) {
    const text = message.result?.contentItems?.[0]?.text ?? "";
    if (captureToolResponsesPath) fs.appendFileSync(captureToolResponsesPath, text + "\\n");
    const observation = JSON.parse(text);
    const entry = observation.expandedEvidence?.find(entry => entry.item.sourceId === "head-event");
    if (!entry || entry.item.sourcePosition !== 2 || !entry.item.summaryText.endsWith("HEAD_END")) process.exit(76);
    sendFinal({ ...answer, evidence: [...answer.evidence, { evidence_index: entry.evidence_index, source_type: "memory_event", source_id: "head-event", source_chunk_index: 0, visibility: "personal", relevance: "requested source", support: "HEAD_END" }] });
    return;
  }
  if (message.id === 9004) {
    if (mode === "repeatSummary") {
      const text = message.result?.contentItems?.[0]?.text ?? "";
      if (captureToolResponsesPath) fs.appendFileSync(captureToolResponsesPath, text + "\\n");
      const observation = JSON.parse(text);
      if (observation.hits?.[0]?.evidence_index !== 0) process.exit(74);
      sendFinal(answer);
      return;
    }
    const observation = JSON.parse(message.result?.contentItems?.[0]?.text ?? "{}");
    if (observation.hits?.[0]?.evidence_index !== 1 || observation.hits?.[0]?.item?.sourceId !== "later-event") process.exit(72);
    sendFinal(answer);
    return;
  }
});
`,
    { mode: 0o600 }
  );
  return scriptPath;
};

const resolveMemoryAnswerWorkerTestConfig = (
  directory: string,
  env: NodeJS.ProcessEnv
) =>
  resolveMemoryAnswerWorkerConfig({
    ...env,
    KOED_HOME: path.join(directory, "koed-home"),
    CODEX_HOME: path.join(directory, "codex-home")
  });

const promptBudgetRegressionModel = "gpt-5.6-luna";

interface AdmissionTestObservation {
  kind: string;
  expandedEvidence: Array<{
    evidence_index: number;
    item: Record<string, unknown>;
  }>;
  reservedPromptTokens: number;
  state: {
    evidenceCount: number;
    omittedSources: unknown[];
    remainingBudgets: { promptTokens: number };
  };
}

const parseAdmissionTestObservation = (
  text: string
): AdmissionTestObservation => JSON.parse(text) as AdmissionTestObservation;

const createPromptBudgetRegressionClient = (): MemoryAnswerRetrievalClient => ({
  async search(input) {
    if (input.retrieval_stage === "score_scan") {
      return {
        retrieval: {
          stages: [
            { name: "leaf_search", countAboveThreshold: 2, maxAllowed: 2 }
          ]
        }
      };
    }
    return {
      hits: ["A", "B"].map((id) => ({
        nodeId: `node-${id}`,
        sourceId: `event-${id}`,
        visibility: "personal",
        summaryText: `KOE144_DYNAMIC_TOOL_EVIDENCE PROMPT_BUDGET_EVIDENCE_${id} ${"deployment evidence ".repeat(100)}`,
        citation: { nodeId: `node-${id}`, visibility: "personal" }
      })),
      retrieval: { stage: input.retrieval_stage }
    };
  },
  async expand() {
    throw new Error("expand should not be required for direct evidence");
  }
});

const runPromptBudgetRegression = (
  directory: string,
  maxPromptTokens: number,
  capturePromptsPath: string,
  useTools = true
) =>
  answerWithMemoryWorker(
    {
      evidenceBundle: {
        query: "What deployment did we choose?",
        evidence: [],
        retrieval: { mode: "app_server_dynamic_tools" }
      }
    },
    {
      client: createPromptBudgetRegressionClient(),
      retrievalScope: "personal",
      searchDomain: "project",
      projectId: "workspace-1",
      responseDetail: "internal",
      config: resolveMemoryAnswerWorkerTestConfig(directory, {
        MEMORY_ANSWER_PROVIDER: "codex",
        MEMORY_ANSWER_MODEL: promptBudgetRegressionModel,
        MEMORY_ANSWER_MAX_ATTEMPTS: "2",
        MEMORY_ANSWER_MAX_PROMPT_TOKENS: String(maxPromptTokens),
        MEMORY_CODEX_APP_SERVER_BINARY: writeFakeDynamicMemoryAnswerAppServer(
          directory,
          {
            mode: "invalidThenValid",
            useTools,
            answer: {
              ...answerObject(
                "Available evidence suggests Docker, but does not confirm the final deployment choice.",
                "insufficient"
              ),
              relevant_memory_found: true,
              evidence: [
                {
                  evidence_index: useTools ? 0 : 1,
                  relevance: "partial deployment evidence",
                  support: "KOE144_DYNAMIC_TOOL_EVIDENCE"
                }
              ],
              missing_evidence: ["confirmation of the final deployment choice"]
            },
            capturePromptsPath,
            retryPromptSnippets: [
              "The previous answer failed validation. Correct this before finishing:"
            ]
          }
        )
      })
    }
  );

describe("memory answer worker", () => {
  const eventWindow = (matched = "event-b") => ({
    sourceType: "memory_event",
    sourceId: matched,
    sourceChunkIndex: 0,
    nodeId: `hit-${matched}`,
    visibility: "personal",
    sourceItems: ["event-a", "event-b", "event-c"].map(
      (sourceId, position) => ({
        kind: "memory_event",
        sourceTable: "memory_events",
        sourceId,
        position,
        visibility: "personal",
        actor: position === 1 ? "assistant" : "user",
        text: `${sourceId} ${"full canonical event ".repeat(350)} EXACT_EVENT_END_${sourceId}`,
        provenance: {
          contextRole:
            sourceId === matched
              ? "matched"
              : position === 0
                ? "preceding"
                : "following",
          matchedSourceIds: [matched]
        }
      })
    )
  });

  const completeSummary = (chunk = 0, generation = "summary-revision-1") => ({
    sourceType: "memory_node",
    sourceId: "complete-summary",
    nodeId: "complete-summary",
    sourceChunkIndex: chunk,
    sourceGeneration: generation,
    visibility: "personal",
    summaryRepresentation: "complete_summary",
    summaryText: `KOE144_DYNAMIC_TOOL_EVIDENCE ${"Complete summary retained context. ".repeat(350)}EXACT_SUMMARY_END`,
    citation: {
      sourceType: "memory_node",
      sourceId: "complete-summary",
      nodeId: "complete-summary",
      sourceChunkIndex: chunk,
      sourceGeneration: generation,
      visibility: "personal"
    }
  });

  it("groups full summaries by revision and retains chunk aliases", () => {
    const first = completeSummary();
    const second = completeSummary(1);
    const candidates = mergeMemoryAnswerCandidateLists(
      [first],
      [{ query: "followup", stage: "leaf_search", hits: [second] }]
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      summaryText: first.summaryText,
      observedReferences: expect.arrayContaining([
        first.citation,
        second.citation
      ]) as unknown
    });
    const selected = evidenceSelectedByAnswer(
      candidates,
      parseStructuredMemoryAnswer({
        ...answerObject("Summary supports the decision."),
        evidence: [
          {
            source_type: "memory_node",
            source_id: first.sourceId,
            source_chunk_index: 0
          }
        ]
      })
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      summaryText: first.summaryText,
      observedReferences: expect.arrayContaining([
        first.citation,
        second.citation
      ]) as unknown
    });
    const distinct = mergeMemoryAnswerCandidateLists(candidates, [
      {
        query: "other",
        stage: "leaf_search",
        hits: [
          {
            ...first,
            sourceId: "unrelated-summary",
            nodeId: "unrelated-summary"
          },
          completeSummary(0, "summary-revision-2"),
          { ...first, visibility: "team" },
          { ...first, summaryRepresentation: "filtered_sources" }
        ]
      }
    ]);
    expect(distinct).toHaveLength(5);
    expect(
      mergeMemoryAnswerCandidateLists(
        [],
        [
          {
            query: "unknown revision",
            stage: "leaf_search",
            hits: [
              { ...first, sourceGeneration: undefined },
              { ...second, sourceGeneration: undefined }
            ]
          }
        ]
      )
    ).toHaveLength(2);
  });

  it("delivers full summaries once per observation and output, charging complete prompt tokens across searches", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-complete-summary-")
    );
    try {
      const promptCapture = path.join(directory, "prompts.jsonl");
      const toolCapture = path.join(directory, "observations.jsonl");
      let searches = 1;
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What was decided?",
            evidence: [completeSummary(0), completeSummary(1)]
          }
        },
        {
          evaluationController: { scriptedFirstPass: false },
          responseDetail: "internal",
          client: {
            async search(input) {
              return input.retrieval_stage === "score_scan"
                ? {
                    retrieval: {
                      stages: [
                        {
                          name: "leaf_search",
                          countAboveThreshold: 1,
                          maxAllowed: 1
                        }
                      ]
                    }
                  }
                : { hits: [completeSummary(++searches)] };
            },
            async expand() {
              return {};
            }
          },
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MODEL: promptBudgetRegressionModel,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_CANDIDATES: "1",
            MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "1",
            MEMORY_ANSWER_MAX_PROMPT_TOKENS: "60000",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                mode: "repeatSummary",
                capturePromptsPath: promptCapture,
                captureToolResponsesPath: toolCapture,
                requiredPromptSnippets: [completeSummary().summaryText],
                answer: answerObject("Full summary supports the decision.")
              })
          })
        }
      );
      expect(
        response.localMemoryWorker.usedFallback,
        response.localMemoryWorker.errorMessage
      ).toBe(false);
      expect(response.localMemoryWorker.candidateCount).toBe(1);
      const prompt = JSON.parse(
        fs.readFileSync(promptCapture, "utf8").trim()
      ) as string;
      expect(prompt.split("EXACT_SUMMARY_END")).toHaveLength(2);
      const observations = fs
        .readFileSync(toolCapture, "utf8")
        .trim()
        .split("\n");
      expect(observations).toHaveLength(2);
      for (const observation of observations) {
        const parsed = JSON.parse(observation) as {
          hits: Array<{
            evidence_index: number;
            item: { summaryText: string };
          }>;
        };
        expect(parsed.hits).toHaveLength(1);
        expect(parsed.hits[0]?.evidence_index).toBe(0);
        expect(parsed.hits[0]?.item.summaryText).toBe(
          completeSummary().summaryText
        );
        expect(observation.split("EXACT_SUMMARY_END")).toHaveLength(2);
      }
      const evidence = response.evidenceBundle?.evidence;
      expect(evidence).toHaveLength(1);
      expect(evidence?.[0]).toMatchObject({
        summaryText: completeSummary().summaryText
      });
      const refs = (
        evidence?.[0] as
          | {
              observedReferences?: Array<{ sourceChunkIndex: number }>;
            }
          | undefined
      )?.observedReferences;
      expect(new Set(refs?.map((ref) => ref.sourceChunkIndex))).toEqual(
        new Set([0, 1, 2, 3])
      );
      const consumed = (
        response.evidenceBundle?.retrieval as
          | {
              trace?: {
                budgets?: {
                  consumed?: { promptTokens: number; evidenceTokens: number };
                };
              };
            }
          | undefined
      )?.trace?.budgets?.consumed;
      expect(consumed?.promptTokens).toBe(
        [prompt, ...observations].reduce(
          (sum, text) =>
            sum +
            countTokensForModel(text, { model: promptBudgetRegressionModel })
              .tokens,
          0
        )
      );
      expect(consumed?.evidenceTokens).toBe(
        countTokensForModel(JSON.stringify(evidence?.[0]), {
          model: promptBudgetRegressionModel
        }).tokens
      );
      expect(toolAnswerResponse(response, "with_evidence").evidence).toEqual(
        evidence
      );
      const tightDirectory = path.join(directory, "tight-prompt");
      fs.mkdirSync(tightDirectory);
      const tight = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What was decided?",
            evidence: [completeSummary(0), completeSummary(1)]
          }
        },
        {
          evaluationController: { scriptedFirstPass: false },
          responseDetail: "internal",
          client: {
            async search() {
              return { hits: [] };
            },
            async expand() {
              return {};
            }
          },
          config: resolveMemoryAnswerWorkerTestConfig(tightDirectory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MODEL: promptBudgetRegressionModel,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_CANDIDATES: "1",
            MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "1",
            MEMORY_ANSWER_MAX_PROMPT_TOKENS: String(
              countTokensForModel(prompt, {
                model: promptBudgetRegressionModel
              }).tokens - 1
            ),
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(tightDirectory, {
                useTools: false
              })
          })
        }
      );
      expect(tight.localMemoryWorker.usedFallback).toBe(true);
      expect(tight.localMemoryWorker.errorMessage).toContain("LCM Summary");
      expect(tight.evidenceBundle?.evidence).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "1000" },
    { MEMORY_ANSWER_MAX_PROMPT_TOKENS: "512" }
  ])(
    "explicitly rejects complete summaries that cannot fit: %j",
    async (budget) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-complete-summary-budget-")
      );
      try {
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: {
              query: "What was decided?",
              evidence: [completeSummary()]
            }
          },
          {
            evaluationController: { scriptedFirstPass: false },
            responseDetail: "internal",
            client: {
              async search() {
                return { hits: [] };
              },
              async expand() {
                return {};
              }
            },
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              ...budget,
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  useTools: false
                })
            })
          }
        );
        expect(response.localMemoryWorker.usedFallback).toBe(true);
        expect(response.localMemoryWorker.errorMessage).toContain(
          "LCM Summary"
        );
        expect(response.evidenceBundle?.evidence).toEqual([]);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("does not let model arguments promote filtered source evidence to a complete summary", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-filtered-summary-")
    );
    try {
      const filtered = {
        ...completeSummary(),
        summaryRepresentation: "filtered_sources"
      };
      const capture = path.join(directory, "observations.jsonl");
      const search = vi.fn(async (input: Record<string, unknown>) =>
        input.retrieval_stage === "score_scan"
          ? {
              retrieval: {
                stages: [
                  { name: "leaf_search", countAboveThreshold: 1, maxAllowed: 1 }
                ]
              }
            }
          : { hits: [filtered] }
      );
      const response = await answerWithMemoryWorker(
        { evidenceBundle: { query: "What was decided?", evidence: [] } },
        {
          evaluationController: { scriptedFirstPass: false },
          responseDetail: "internal",
          client: {
            search,
            async expand() {
              return {};
            }
          },
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                captureToolResponsesPath: capture,
                searchArguments: {
                  summaryRepresentation: "complete_summary",
                  fullCanonicalEvent: true
                },
                answer: {
                  ...answerObject("Filtered sources support the answer."),
                  evidence: [
                    {
                      evidence_index: 0,
                      summaryRepresentation: "complete_summary",
                      summaryText: "FORGED_SUMMARY_BODY"
                    }
                  ]
                }
              })
          })
        }
      );
      expect(
        response.localMemoryWorker.usedFallback,
        response.localMemoryWorker.errorMessage
      ).toBe(false);
      expect(
        search.mock.calls.every(
          ([input]) =>
            input.summaryRepresentation === undefined &&
            input.fullCanonicalEvent === undefined
        )
      ).toBe(true);
      const observation = JSON.parse(
        fs.readFileSync(capture, "utf8").trim()
      ) as {
        hits: Array<{
          item: { summaryRepresentation: string; summaryText: string };
        }>;
      };
      expect(observation.hits[0]?.item.summaryRepresentation).toBe(
        "filtered_sources"
      );
      expect(observation.hits[0]?.item.summaryText).toBe(
        filtered.summaryText.slice(0, 4096)
      );
      expect(response.evidenceBundle?.evidence).toEqual([
        expect.objectContaining({
          summaryRepresentation: "filtered_sources",
          summaryText: filtered.summaryText.slice(0, 4096)
        })
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a complete follow-up summary that cannot fit the remaining prompt budget", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-summary-followup-budget-")
    );
    try {
      const capture = path.join(directory, "observations.jsonl");
      const response = await answerWithMemoryWorker(
        { evidenceBundle: { query: "What was decided?", evidence: [] } },
        {
          evaluationController: { scriptedFirstPass: false },
          responseDetail: "internal",
          client: {
            async search(input) {
              return input.retrieval_stage === "score_scan"
                ? {
                    retrieval: {
                      stages: [
                        {
                          name: "leaf_search",
                          countAboveThreshold: 1,
                          maxAllowed: 1
                        }
                      ]
                    }
                  }
                : { hits: [completeSummary()] };
            },
            async expand() {
              return {};
            }
          },
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_PROMPT_TOKENS: "3500",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                mode: "eventWindowBudget",
                captureToolResponsesPath: capture
              })
          })
        }
      );
      const observation = JSON.parse(
        fs.readFileSync(capture, "utf8").trim()
      ) as {
        kind: string;
        hits: unknown[];
        state: { omittedSources: unknown[] };
      };
      expect(observation.kind).toBe("search_result");
      expect(observation.hits).toEqual([]);
      expect(observation.state.omittedSources).toContainEqual(
        expect.objectContaining({
          reason: "prompt_tokens",
          source: expect.objectContaining({
            source_id: "complete-summary"
          }) as unknown
        })
      );
      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.evidenceBundle?.evidence).toEqual([]);
      const retrieval = response.evidenceBundle?.retrieval as
        | { trace?: { budgets?: { exhausted?: string[] } } }
        | undefined;
      expect(retrieval?.trace?.budgets?.exhausted).toContain("prompt_tokens");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([5, 60])(
    "uses an LCM node summary with %i contextual source events as one summary candidate",
    async (count) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-node-summary-context-")
      );
      try {
        const summary =
          "LCM_SUMMARY_DECISION: deploy the scoped device credentials.";
        const node = {
          sourceType: "memory_node",
          sourceId: "summary-node",
          sourceChunkIndex: 0,
          nodeId: "summary-node",
          visibility: "personal",
          summaryText: summary,
          citation: {
            sourceType: "memory_node",
            sourceId: "summary-node",
            sourceChunkIndex: 0,
            nodeId: "summary-node",
            visibility: "personal"
          },
          sourceItems: Array.from({ length: count }, (_, index) => ({
            ...eventWindow().sourceItems[0],
            sourceId: `context-${index}`,
            text: `CONTEXT_EVENT_ONLY_${index} ${"large event content ".repeat(500)}`
          }))
        };
        const capture = path.join(directory, "prompts.jsonl");
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: {
              query: "What should we deploy?",
              evidence: [node]
            }
          },
          {
            client: {
              async search() {
                return { hits: [] };
              },
              async expand() {
                throw new Error(
                  "The node summary answers the question without expansion."
                );
              }
            },
            responseDetail: "internal",
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  useTools: false,
                  capturePromptsPath: capture,
                  requiredPromptSnippets: [summary],
                  answer: answerObject("Deploy the scoped device credentials.")
                })
            })
          }
        );
        expect(response.localMemoryWorker.usedFallback).toBe(false);
        expect(response.localMemoryWorker.memoryStatus).toBe("found");
        expect(response.localMemoryWorker.candidateCount).toBe(1);
        expect(response.evidenceBundle?.evidence).toEqual([
          expect.objectContaining({
            sourceType: "memory_node",
            sourceId: "summary-node",
            summaryText: summary
          })
        ]);
        expect(
          JSON.parse(fs.readFileSync(capture, "utf8").trim()) as string
        ).not.toContain("CONTEXT_EVENT_ONLY");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("reports count admission limits when an oversized event window is skipped beside useful summary evidence", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-window-cap-diagnostic-")
    );
    try {
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What was decided?",
            evidence: [
              {
                sourceType: "memory_node",
                sourceId: "summary",
                sourceChunkIndex: 0,
                summaryText: "Useful retained summary."
              },
              eventWindow()
            ]
          }
        },
        {
          client: {
            async search() {
              return { hits: [] };
            },
            async expand() {
              return {};
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_CANDIDATES: "3",
            MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "2",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false
              })
          })
        }
      );
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      const retrieval = response.evidenceBundle?.retrieval as {
        trace?: { budgets?: { exhausted?: string[] } };
      };
      expect(retrieval.trace?.budgets?.exhausted).toEqual(
        expect.arrayContaining(["candidates", "evidence_items"])
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates complete overlapping event windows with canonical neighbor citations and stable handles", async () => {
    const search = vi.fn(async () => ({
      hits: [eventWindow(), eventWindow("event-a")]
    }));
    const result = await runScriptedMemoryAnswerFirstPass({
      client: {
        search,
        async expand() {
          return {};
        }
      },
      query: "What was decided?",
      retrievalScope: "personal",
      searchDomain: "all",
      limit: 10,
      maxSearches: 1
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ include_event_context: true })
    );
    expect(result.evidence).toHaveLength(3);
    for (const item of result.evidence as Array<Record<string, unknown>>) {
      expect(item.summaryText).toBe(
        eventWindow().sourceItems.find(
          (source) => source.sourceId === item.sourceId
        )!.text
      );
      expect(item.citation).toMatchObject({
        sourceType: "memory_event",
        sourceId: item.sourceId,
        sourceChunkIndex: 0
      });
      expect(item.actor).toBeDefined();
    }
    expect(
      result.evidence.find(
        (item) => (item as { sourceId: string }).sourceId === "event-a"
      )
    ).toMatchObject({
      provenance: {
        contextRole: "matched",
        matchedSourceIds: ["event-b", "event-a"]
      }
    });
    const selection = parseStructuredMemoryAnswer({
      ...answerObject("The matched event supplies support."),
      evidence: [{ evidence_index: 1 }]
    });
    const selected = evidenceSelectedByAnswer(result.evidence, selection);
    expect(
      evidenceSelectedByAnswer(
        [
          ...result.evidence,
          {
            sourceType: "memory_event",
            sourceId: "later-event",
            sourceChunkIndex: 0
          }
        ],
        selection
      )
    ).toEqual(selected);
    expect(selected).toEqual([
      expect.objectContaining({ sourceId: "event-b" })
    ]);
  });

  it("presents whole initial canonical events beyond both legacy string limits", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-whole-events-")
    );
    try {
      const window = eventWindow();
      const response = await answerWithMemoryWorker(
        { evidenceBundle: { query: "What was decided?", evidence: [window] } },
        {
          client: {
            async search() {
              return { hits: [] };
            },
            async expand() {
              return {};
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false,
                requiredPromptSnippets: window.sourceItems.map(
                  (item) => item.text
                ),
                answer: answerObject("The preceding event supplies the answer.")
              })
          })
        }
      );
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.evidenceBundle?.evidence).toEqual([
        expect.objectContaining({
          sourceId: "event-a",
          summaryText: window.sourceItems[0]!.text
        })
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("admits the first complete overlapping window when the event budget cannot fit their union", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-overlapping-window-budget-")
    );
    try {
      const first = eventWindow();
      const second = {
        ...eventWindow("event-d"),
        sourceItems: [
          first.sourceItems[2]!,
          ...eventWindow("event-d")
            .sourceItems.slice(1)
            .map((item, index) => ({
              ...item,
              sourceId: `event-${index === 0 ? "d" : "e"}`,
              text: `SECOND_WINDOW_ONLY_${index}`
            }))
        ]
      };
      const capture = path.join(directory, "prompts.jsonl");
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What was decided?",
            evidence: [first, second]
          }
        },
        {
          client: {
            async search() {
              return { hits: [] };
            },
            async expand() {
              return {};
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "3",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false,
                capturePromptsPath: capture,
                requiredPromptSnippets: first.sourceItems.map(
                  (item) => item.text
                ),
                answer: {
                  ...answerObject("The shared neighbor supplies support."),
                  evidence: [{ evidence_index: 2, support: "event-c" }]
                }
              })
          })
        }
      );
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      const prompt = JSON.parse(
        fs.readFileSync(capture, "utf8").trim()
      ) as string;
      expect(prompt).not.toContain("SECOND_WINDOW_ONLY");
      expect(response.evidenceBundle?.evidence).toEqual([
        expect.objectContaining({
          sourceId: "event-c",
          sourceChunkIndex: 0,
          eventContextWindowIds: [expect.any(String)],
          citation: {
            sourceType: "memory_event",
            sourceId: "event-c",
            sourceChunkIndex: 0,
            visibility: "personal",
            provenance: {
              contextRole: "following",
              matchedSourceIds: ["event-b"]
            }
          }
        })
      ]);
      const promptDirectory = path.join(directory, "prompt-trimming");
      fs.mkdirSync(promptDirectory);
      const promptCapture = path.join(promptDirectory, "prompts.jsonl");
      const trimmedResponse = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What was decided?",
            evidence: [first, second]
          }
        },
        {
          client: {
            async search() {
              return { hits: [] };
            },
            async expand() {
              return {};
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(promptDirectory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_PROMPT_TOKENS: String(
              countTokensForModel(prompt, { model: "gpt-5.6-luna" }).tokens +
                100
            ),
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(promptDirectory, {
                useTools: false,
                capturePromptsPath: promptCapture,
                requiredPromptSnippets: first.sourceItems.map(
                  (item) => item.text
                ),
                answer: {
                  ...answerObject("The shared neighbor remains available."),
                  evidence: [{ evidence_index: 2, support: "event-c" }]
                }
              })
          })
        }
      );
      expect(
        trimmedResponse.localMemoryWorker.usedFallback,
        trimmedResponse.localMemoryWorker.errorMessage
      ).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(promptCapture, "utf8").trim()) as string
      ).not.toContain("SECOND_WINDOW_ONLY");
      expect(trimmedResponse.evidenceBundle?.evidence).toEqual([
        expect.objectContaining({
          sourceId: "event-c",
          eventContextWindowIds: [expect.any(String)]
        })
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { MEMORY_ANSWER_MAX_CANDIDATES: "2" },
    { MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "2" },
    { MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "256" },
    { MEMORY_ANSWER_MAX_PROMPT_TOKENS: "512" }
  ])(
    "explicitly rejects a window that cannot fit atomically: %j",
    async (budget) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-whole-event-budget-")
      );
      try {
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: {
              query: "What was decided?",
              evidence: [eventWindow()]
            }
          },
          {
            client: {
              async search() {
                return { hits: [] };
              },
              async expand() {
                return {};
              }
            },
            responseDetail: "internal",
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  useTools: false
                }),
              ...budget
            })
          }
        );
        expect(response.localMemoryWorker.usedFallback).toBe(true);
        expect(response.localMemoryWorker.errorMessage).toContain(
          "complete event context window"
        );
        expect(response.evidenceBundle?.evidence).toEqual([]);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("presents complete follow-up event windows without truncating the tool observation", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-event-tool-")
    );
    try {
      const capture = path.join(directory, "observations.jsonl");
      const window = eventWindow();
      window.sourceItems[0]!.text += " KOE144_DYNAMIC_TOOL_EVIDENCE";
      const search = vi.fn(async (input: Record<string, unknown>) =>
        input.retrieval_stage === "score_scan"
          ? { retrieval: { stages: [{ stage: "leaf_search", count: 1 }] } }
          : { hits: [window] }
      );
      const response = await answerWithMemoryWorker(
        { evidenceBundle: { query: "What was decided?", evidence: [] } },
        {
          client: {
            search,
            async expand() {
              return {};
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                captureToolResponsesPath: capture
              })
          })
        }
      );
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      const observation = JSON.parse(
        fs.readFileSync(capture, "utf8").trim()
      ) as { hits: Array<{ item: { summaryText: string } }> };
      expect(observation.hits).toHaveLength(3);
      for (const [index, item] of window.sourceItems.entries())
        expect(observation.hits[index]!.item.summaryText).toBe(item.text);
      expect(
        search.mock.calls.every(
          ([input]) => input.include_event_context === true
        )
      ).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves exact canonical expansion text and the same event identity used by search", () => {
    const text = `  ${"canonical event bytes ".repeat(500)}\nFINAL_EVENT_BYTES  `;
    const [event] = evidenceFromExpansion({
      nodeId: "leaf",
      sourceItems: [
        {
          kind: "memory_event",
          sourceId: "event-a",
          actor: "user",
          position: 17,
          text
        }
      ]
    });
    expect(event).toMatchObject({
      sourceType: "memory_event",
      sourceId: "event-a",
      sourceChunkIndex: 0,
      summaryText: text,
      actor: "user",
      fullCanonicalEvent: true
    });
  });

  it("rejects a whole follow-up observation when the remaining prompt budget cannot admit it", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-event-tool-budget-")
    );
    try {
      const capture = path.join(directory, "observations.jsonl");
      const window = eventWindow();
      const response = await answerWithMemoryWorker(
        { evidenceBundle: { query: "What was decided?", evidence: [] } },
        {
          client: {
            async search(input) {
              return input.retrieval_stage === "score_scan"
                ? {
                    retrieval: { stages: [{ stage: "leaf_search", count: 1 }] }
                  }
                : { hits: [window] };
            },
            async expand() {
              return {};
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_PROMPT_TOKENS: "3700",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                mode: "eventWindowBudget",
                captureToolResponsesPath: capture
              })
          })
        }
      );
      const observation = JSON.parse(
        fs.readFileSync(capture, "utf8").trim()
      ) as {
        kind: string;
        hits: unknown[];
        state: { omittedSources: unknown[] };
      };
      expect(observation.kind).toBe("search_result");
      expect(observation.hits).toEqual([]);
      expect(observation.state.omittedSources).toHaveLength(3);
      expect(response.evidenceBundle?.evidence).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "OAuth refresh failed (401): invalid_refresh_token",
      "provider_authentication_failure",
      1
    ],
    ["Connection error", "provider_execution_failure", 2]
  ] as const)(
    "preserves safe Pi provider diagnostics and retry policy (%s)",
    async (nativeError, expectedCode, expectedAttempts) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-pi-worker-error-")
      );
      try {
        const executable = path.join(directory, "pi");
        const attemptsPath = path.join(directory, "attempts");
        const koedHome = path.join(directory, "koed-home");
        const bridgeDir = path.join(
          koedHome,
          "integrations",
          "pi",
          "extensions"
        );
        fs.mkdirSync(bridgeDir, { recursive: true });
        fs.writeFileSync(
          path.join(bridgeDir, "structured-result.mjs"),
          "export default () => {};\n"
        );
        fs.writeFileSync(
          executable,
          `#!/usr/bin/env node
const fs = require("node:fs");
process.stdin.once("data", () => {
  fs.appendFileSync(${JSON.stringify(attemptsPath)}, "attempt\\n");
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", usage: { input: 10, cacheRead: 20, cacheWrite: 5, output: 7, totalTokens: 42 }, errorMessage: ${JSON.stringify(`${nativeError}; synthetic-private-provider-secret`)} } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  setInterval(() => {}, 1000);
});
`
        );
        fs.chmodSync(executable, 0o700);
        const response = await answerWithMemoryWorker(
          { evidenceBundle: { query: "Synthetic decision?", evidence: [] } },
          {
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              PATH: process.env.PATH,
              MEMORY_ANSWER_PROVIDER: "pi",
              MEMORY_ANSWER_MODEL: "test/model",
              KOED_PI_EXECUTABLE: executable,
              MEMORY_ANSWER_MAX_ATTEMPTS: "2"
            }),
            client: {
              async search() {
                return { hits: [] };
              },
              async expand() {
                return { sourceItems: [] };
              }
            },
            searchDomain: "global",
            retrievalScope: "personal",
            responseDetail: "internal"
          }
        );
        expect(response.localMemoryWorker).toMatchObject({
          provider: "pi",
          usedFallback: true,
          skippedReason: expectedCode
        });
        expect(
          fs.readFileSync(attemptsPath, "utf8").trim().split("\n")
        ).toHaveLength(expectedAttempts);
        expect(response.localMemoryWorker.appServerExecutions).toHaveLength(
          expectedAttempts
        );
        for (const execution of response.localMemoryWorker
          .appServerExecutions ?? [])
          expect(execution).toMatchObject({
            provider: "pi",
            status: "failed",
            tokenUsage: {
              last: { inputTokens: 35, outputTokens: 7, totalTokens: 42 }
            }
          });
        const publicResponse = compactMemoryAnswerPayload(
          response,
          "answer_only"
        );
        expect(publicResponse.localMemoryWorker.skippedReason).toBe(
          expectedCode
        );
        if (expectedCode === "provider_authentication_failure")
          expect(publicResponse.localMemoryWorker.displayMessage).toContain(
            "Sign in again to Pi"
          );
        expect(JSON.stringify(response)).not.toContain(
          "synthetic-private-provider-secret"
        );
        expect(JSON.stringify(publicResponse)).not.toContain(
          "synthetic-private-provider-secret"
        );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("reports the configured Claude instance and Agent SDK transport", async () => {
    const config = {
      ...resolveMemoryAnswerWorkerConfig({
        MEMORY_ANSWER_CODEX_BINARY: process.execPath
      }),
      provider: "claude" as const,
      aiClientInstanceId: "claude.work",
      executablePath: process.execPath
    };
    const response = await answerWithMemoryWorker(payload, {
      config,
      responseDetail: "internal"
    });

    expect(response.localMemoryWorker).toMatchObject({
      provider: "claude",
      aiClientInstanceId: "claude.work",
      transport: "agent_sdk",
      skippedReason: "missing_retrieval_client"
    });
  });

  it.each([
    "error_result",
    "throw_after_result",
    "cancel_after_input"
  ] as const)("preserves observed Claude usage on %s", async (scenario) => {
    const caller = new AbortController();
    const query = async function* () {
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "first",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 1
          }
        }
      } as SDKMessage;
      if (scenario === "cancel_after_input") {
        caller.abort();
        throw new Error("cancelled by fixture");
      }
      yield {
        type: "result",
        subtype: "error_max_turns",
        modelUsage: {
          model: {
            inputTokens: 10,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
            outputTokens: 7,
            contextWindow: 1000
          }
        }
      } as unknown as SDKMessage;
      if (scenario === "throw_after_result")
        throw new Error("SDK result failure");
    };
    sdk.query.mockImplementation(() =>
      Object.assign(query(), { close: vi.fn() })
    );
    const response = await answerWithMemoryWorker(payload, {
      responseDetail: "internal",
      signal: caller.signal,
      client: {
        search: async () => ({ hits: [] }),
        expand: async () => ({ sourceItems: [] })
      },
      config: {
        ...resolveMemoryAnswerWorkerConfig({}),
        provider: "claude",
        executablePath: process.execPath,
        maxAttempts: 1
      }
    });
    expect(response.localMemoryWorker.usedFallback).toBe(true);
    expect(response.localMemoryWorker.appServerExecutions).toHaveLength(1);
    expect(response.localMemoryWorker.appServerExecutions?.[0]).toMatchObject({
      status: "failed",
      provider: "claude",
      tokenUsage: { last: { inputTokens: 35, cachedInputTokens: 20 } }
    });
    expect(
      response.localMemoryWorker.appServerExecutions?.[0]?.tokenUsage?.last
        ?.totalTokens
    ).toBe(scenario === "cancel_after_input" ? undefined : 42);
    expect(sdk.query).toHaveBeenCalledOnce();
  });

  it("aborts and closes the active Claude query when the caller cancels", async () => {
    const caller = new AbortController();
    const removeEventListener = vi.spyOn(caller.signal, "removeEventListener");
    const close = vi.fn();
    let sdkSignal: AbortSignal | undefined;
    const onProgress = vi.fn();
    sdk.query.mockImplementation(({ options }: { options?: Options }) => {
      sdkSignal = options?.abortController?.signal;
      async function* hang(): AsyncGenerator<SDKMessage, void> {
        yield { type: "stream_event" } as SDKMessage;
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
      responseDetail: "internal",
      client: {
        async search() {
          throw new Error("search must not run after cancellation");
        },
        async expand() {
          throw new Error("expand must not run after cancellation");
        }
      },
      signal: caller.signal,
      onProgress,
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
    await vi.waitFor(() =>
      expect(onProgress).toHaveBeenCalledWith("Claude provider activity")
    );

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
      responseDetail: "internal",
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

  it.each([
    ["answer_only", ["localMemoryWorker", "markdown", "retrieval"]],
    [
      "with_citations",
      ["citations", "localMemoryWorker", "markdown", "retrieval"]
    ],
    [
      "with_evidence",
      [
        "citations",
        "evidence",
        "localMemoryWorker",
        "markdown",
        "retrieval",
        "structuredAnswer"
      ]
    ]
  ] as const)(
    "preserves the synchronous %s response contract",
    (responseDetail, expectedKeys) => {
      const response = compactMemoryAnswerPayload(
        {
          ...payload,
          localMemoryWorker: {
            provider: "codex",
            promptVersion: MEMORY_ANSWER_PROMPT_VERSION,
            jobId: "contract-job",
            model: "gpt-5.4-mini",
            usedFallback: false
          }
        },
        responseDetail
      );

      expect(Object.keys(response).sort()).toEqual([...expectedKeys]);
      expect(response.markdown).toBe(payload.markdown);
      expect(response.retrieval).toEqual({
        evidenceCount: 1,
        retrievalMode: "semantic_vector"
      });
    }
  );

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

  it.each(["answer_only", "with_citations", "with_evidence"] as const)(
    "keeps internal diagnostics out of %s while retaining them internally",
    (responseDetail) => {
      const internal = {
        ...payload,
        retrieval: {
          evidenceCount: 1,
          retrievalMode: "semantic_vector",
          trace: { query: "PRIVATE RETRIEVAL TRACE" }
        },
        localMemoryWorker: {
          provider: "codex",
          promptVersion: MEMORY_ANSWER_PROMPT_VERSION,
          jobId: "job-private",
          model: "fixture-model",
          usedFallback: true,
          memoryStatus: "insufficient" as const,
          displayMessage: "Some memory could not be verified.",
          errorMessage: "PRIVATE WORKER ERROR",
          searchCount: 4,
          tokenUsage: { last: { totalTokens: 1234 } },
          appServerThreadId: "PRIVATE THREAD",
          appServerExecutions: [
            { model: "fixture-model", threadId: "PRIVATE THREAD" }
          ]
        }
      };
      const publicResult = compactMemoryAnswerPayload(internal, responseDetail);

      expect(publicResult.localMemoryWorker).toMatchObject({
        usedFallback: true,
        memoryStatus: "insufficient",
        displayMessage: "Some memory could not be verified."
      });
      expect(publicResult.localMemoryWorker).not.toHaveProperty("tokenUsage");
      expect(publicResult.localMemoryWorker).not.toHaveProperty("searchCount");
      expect(publicResult.localMemoryWorker).not.toHaveProperty(
        "appServerExecutions"
      );
      expect(publicResult.retrieval).toEqual({
        evidenceCount: 1,
        retrievalMode: "semantic_vector"
      });
      expect(publicResult).not.toHaveProperty("evidenceBundle");
      expect(JSON.stringify(publicResult)).not.toContain("PRIVATE");
      expect(
        compactMemoryAnswerPayload(internal, "internal").localMemoryWorker
      ).toEqual(internal.localMemoryWorker);
      expect(
        compactMemoryAnswerPayload(internal, "internal").evidenceBundle
      ).toEqual(payload.evidenceBundle);
      expect(
        compactMemoryAnswerPayload(internal, "internal").retrieval
      ).toEqual(internal.retrieval);
    }
  );

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

  it("preserves relevant partial evidence in insufficient answers", () => {
    const answer = {
      ...answerObject("A partial supported answer", "found"),
      memory_status: "insufficient",
      missing: ["the remaining decision"]
    };
    expect(parseStructuredMemoryAnswer(answer)).toMatchObject({
      memory_status: "insufficient",
      relevant_memory_found: true,
      evidence: [{ evidence_index: 0 }]
    });
    expect(() =>
      parseStructuredMemoryAnswer({ ...answer, evidence: [] })
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
      MEMORY_ANSWER_HARD_TIMEOUT_MS: "25000",
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
        config: resolveMemoryAnswerWorkerTestConfig(directory, {
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_ANSWER_MODEL: "gpt-5.4-mini",
            MEMORY_ANSWER_REASONING_EFFORT: "medium",
            MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "128",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary
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

  it("keeps evidence in the prompt when scan diagnostics contain many candidate IDs", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const candidateIds = Array.from(
        { length: 50 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
      );
      const stages = [
        "leaf_search",
        "fresh_pending_search",
        "raw_fallback_search"
      ].map((name) => ({
        name,
        candidateCount: 50,
        countAboveThreshold: 50,
        maxAllowed: 50,
        candidateIds
      }));
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: { query: "What did we decide?", evidence: [] }
        },
        {
          client: {
            async search(input) {
              return {
                hits:
                  input.retrieval_stage === "score_scan"
                    ? []
                    : [
                        {
                          nodeId: "node-1",
                          sourceId: "event-1",
                          visibility: "personal",
                          summaryText:
                            "KOE144_DYNAMIC_TOOL_EVIDENCE: Koed is running on Docker."
                        }
                      ],
                retrieval: { stages }
              };
            },
            async expand() {
              throw new Error("not needed");
            }
          },
          retrievalScope: "personal",
          searchDomain: "global",
          retrievalHints: {
            semantic: ["deployment choice"],
            lexical: ["Docker"]
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_MAX_PROMPT_TOKENS: "6000",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false,
                requiredPromptSnippets: ["KOE144_DYNAMIC_TOOL_EVIDENCE"]
              })
          })
        }
      );
      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.evidence).toHaveLength(1);
      expect(JSON.stringify(response.evidenceBundle?.retrieval)).toContain(
        candidateIds[0]
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "recovers an omitted complete source and preserves observed parent support (crowded default-budget working set: %s)",
    async (crowded) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-admission-recovery-")
      );
      try {
        const capture = path.join(directory, "tools.jsonl");
        const parent = {
          sourceType: "memory_node",
          sourceId: "node-1",
          nodeId: "node-1",
          sourceChunkIndex: 0,
          visibility: "personal",
          summaryRepresentation: "complete_summary",
          sourceGeneration: "one",
          summaryText: `Parent explains the decision. ${crowded ? "Initial summarized decision. ".repeat(180) : ""}`
        };
        const initialEvidence = crowded
          ? Array.from({ length: 10 }, (_, index) => ({
              ...parent,
              sourceId: index === 0 ? "node-1" : `parent-${index}`,
              nodeId: index === 0 ? "node-1" : `parent-${index}`
            }))
          : [parent];
        const sourceItems = [
          "tail-event",
          "middle-event",
          "head-event",
          ...(crowded
            ? Array.from({ length: 5 }, (_, index) => `other-${index}`)
            : [])
        ].map((sourceId) => ({
          kind: "memory_event",
          sourceId,
          text: `${"Complete implementation statement. ".repeat(crowded ? 1100 : 160)}${sourceId === "head-event" ? "HEAD_END" : "SOURCE_END"}`,
          actor: "assistant",
          createdAt: "2026-01-01T00:00:00Z",
          supportingContext: [{ boundary: "complete turn" }]
        }));
        const expand = vi.fn(async (nodeId: string) => ({
          expanded: { nodeId, visibility: "personal", sourceItems }
        }));
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: {
              query: "What is the implementation?",
              evidence: initialEvidence
            }
          },
          {
            evaluationController: { scriptedFirstPass: false },
            responseDetail: "internal",
            client: {
              async search() {
                return { hits: [] };
              },
              expand
            },
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              ...(crowded ? {} : { MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "1600" }),
              MEMORY_ANSWER_MODEL: promptBudgetRegressionModel,
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  mode: "admissionRecovery",
                  capturePromptsPath: path.join(directory, "prompts.jsonl"),
                  captureToolResponsesPath: capture,
                  answer: {
                    ...answerObject(
                      "Parent and implementation. [1 personal] [2 personal]"
                    ),
                    evidence: [
                      {
                        evidence_index: 0,
                        source_type: "memory_node",
                        source_id: "node-1",
                        source_chunk_index: 0,
                        visibility: "personal",
                        support: "Parent explains"
                      }
                    ]
                  }
                })
            })
          }
        );
        expect(
          response.localMemoryWorker.usedFallback,
          response.localMemoryWorker.errorMessage
        ).toBe(false);
        expect(expand).toHaveBeenCalledTimes(2);
        const observations = fs
          .readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .map(parseAdmissionTestObservation);
        const [firstObservation, secondObservation] = observations;
        if (!firstObservation || !secondObservation)
          throw new Error("Expected both expansion observations");
        const firstCount = firstObservation.expandedEvidence.length;
        if (!crowded) expect(firstCount).toBe(2);
        else {
          expect(firstCount).toBeLessThan(2);
          expect(firstObservation.reservedPromptTokens).toBeGreaterThan(4000);
          expect(firstObservation.state.omittedSources).toContainEqual(
            expect.objectContaining({ reason: "recovery_reserve" })
          );
          const prompt = JSON.parse(
            fs
              .readFileSync(path.join(directory, "prompts.jsonl"), "utf8")
              .trim()
          ) as string;
          const initialTokens = countTokensForModel(prompt, {
            model: promptBudgetRegressionModel
          }).tokens;
          expect(initialTokens).toBeGreaterThan(9000);
          const emittedTokens = observations.reduce<number>(
            (total, observation) =>
              total +
              countTokensForModel(JSON.stringify(observation), {
                model: promptBudgetRegressionModel
              }).tokens,
            initialTokens
          );
          expect(emittedTokens).toBeLessThanOrEqual(24000);
          expect(firstObservation.reservedPromptTokens).toBeLessThanOrEqual(
            firstObservation.state.remainingBudgets.promptTokens
          );
        }
        expect(firstObservation.state.omittedSources).toContainEqual(
          expect.objectContaining({
            source: {
              source_type: "memory_event",
              source_id: "head-event",
              source_chunk_index: 0
            },
            nodeId: "node-1",
            reason: "evidence_tokens",
            requiredTokens: expect.any(Number) as unknown
          })
        );
        expect(secondObservation.expandedEvidence).toEqual([
          expect.objectContaining({
            evidence_index: initialEvidence.length + firstCount,
            item: expect.objectContaining({
              sourcePosition: 2,
              expandedFromNodeId: "node-1",
              parentNodeIds: ["node-1"],
              actor: "assistant",
              summaryText: sourceItems[2]!.text,
              supportingContext: [{ boundary: "complete turn" }]
            }) as unknown
          })
        ]);
        expect(response.evidenceBundle?.evidence).toHaveLength(2);
        expect(response.evidenceBundle?.retrieval).toMatchObject({
          expansions: [
            {
              sourceItemCount: firstCount,
              omittedSourceCount: sourceItems.length - firstCount
            },
            { sourceItemCount: 1, omittedSourceCount: 0 }
          ]
        });
        expect(
          secondObservation.state.remainingBudgets.promptTokens
        ).toBeGreaterThan(0);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(
    [
      [],
      [
        {
          source_type: "memory_event",
          source_id: "foreign",
          source_chunk_index: 0
        }
      ],
      [
        {
          source_type: "memory_event",
          source_id: "event",
          source_chunk_index: 0
        },
        {
          source_type: "memory_event",
          source_id: "event",
          source_chunk_index: 0
        }
      ]
    ].map((sources) => ({ sources }))
  )(
    "rejects invalid or unauthorized exact expansion selectors without exposing bodies: %j",
    async ({ sources }) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-admission-selector-")
      );
      try {
        const capture = path.join(directory, "tools.jsonl");
        const expand = vi.fn(async () => ({
          expanded: {
            nodeId: "node-1",
            visibility: "personal",
            sourceItems: [
              {
                kind: "memory_event",
                sourceId: "event",
                text: "PRIVATE_AUTHORIZED_BODY"
              }
            ]
          }
        }));
        await answerWithMemoryWorker(
          { evidenceBundle: { query: "What is missing?", evidence: [] } },
          {
            evaluationController: { scriptedFirstPass: false },
            responseDetail: "internal",
            client: {
              async search() {
                return { hits: [] };
              },
              expand
            },
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  mode: "expandResult",
                  expandArguments: { sources },
                  captureToolResponsesPath: capture,
                  answer: {
                    ...answerObject(
                      "Cannot inspect this selection.",
                      "insufficient"
                    ),
                    missing_evidence: ["authorized source selection"],
                    evidence: []
                  }
                })
            })
          }
        );
        const observation: unknown = JSON.parse(
          fs.readFileSync(capture, "utf8").trim()
        );
        expect(observation).toMatchObject({
          kind: "validation_error",
          message: "Invalid expansion sources."
        });
        expect(JSON.stringify(observation)).not.toContain(
          "PRIVATE_AUTHORIZED_BODY"
        );
        expect(expand).toHaveBeenCalledTimes(sources.length === 1 ? 1 : 0);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("starts with navigation-only omissions when a complete initial summary cannot fit and reports honest insufficiency", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-admission-navigation-")
    );
    try {
      const capture = path.join(directory, "prompts.jsonl");
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What was decided?",
            evidence: [completeSummary()]
          }
        },
        {
          evaluationController: { scriptedFirstPass: false },
          responseDetail: "internal",
          client: {
            async search() {
              return { hits: [] };
            },
            async expand() {
              return {};
            }
          },
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "1000",
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false,
                capturePromptsPath: capture,
                answer: {
                  ...answerObject(
                    "The complete source cannot fit; more focused source evidence is required.",
                    "insufficient"
                  ),
                  evidence: [],
                  missing_evidence: [
                    "A complete source within the configured evidence budget"
                  ]
                }
              })
          })
        }
      );
      expect(
        response.localMemoryWorker.usedFallback,
        response.localMemoryWorker.errorMessage
      ).toBe(false);
      const prompt = JSON.parse(
        fs.readFileSync(capture, "utf8").trim()
      ) as string;
      expect(prompt).toContain('"source_id": "complete-summary"');
      expect(prompt).toContain('"reason": "evidence_tokens"');
      expect(prompt).not.toContain("EXACT_SUMMARY_END");
      expect(response.evidenceBundle?.evidence).toEqual([]);
      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["unobserved", "rich_final_cap"])(
    "rejects unsupported final evidence selection despite a navigation or compact view: %s",
    async (mode) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-admission-final-")
      );
      try {
        const capture = path.join(directory, "prompts.jsonl");
        const summary = completeSummary();
        const evidence =
          mode === "unobserved"
            ? summary
            : {
                ...summary,
                summaryText: "Short complete summary.",
                citation: {
                  ...summary.citation,
                  duplicatedMetadata: "Rich provenance detail. ".repeat(1000)
                }
              };
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: { query: "What was decided?", evidence: [evidence] }
          },
          {
            evaluationController: { scriptedFirstPass: false },
            responseDetail: "internal",
            client: {
              async search() {
                return { hits: [] };
              },
              async expand() {
                return {};
              }
            },
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "1000",
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  useTools: false,
                  capturePromptsPath: capture,
                  answer: {
                    ...answerObject("The claimed decision. [1 personal]"),
                    evidence: [
                      {
                        source_type: "memory_node",
                        source_id: "complete-summary",
                        source_chunk_index: 0,
                        visibility: "personal",
                        support:
                          mode === "unobserved"
                            ? "EXACT_SUMMARY_END"
                            : "Short complete summary"
                      }
                    ]
                  }
                })
            })
          }
        );
        expect(response.localMemoryWorker.usedFallback).toBe(true);
        expect(response.evidenceBundle?.evidence).toEqual([]);
        const prompt = JSON.parse(
          fs.readFileSync(capture, "utf8").trim()
        ) as string;
        if (mode === "unobserved")
          expect(prompt).not.toContain("EXACT_SUMMARY_END");
        else {
          expect(prompt).toContain('"finalEvidenceTokens":');
          expect(prompt).toContain("Short complete summary.");
          expect(response.localMemoryWorker.errorMessage).toContain(
            "evidence_tokens"
          );
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([24000, 6500])(
    "reports total omitted expansion sources and only feasible recovery reserves with bounded navigation (prompt limit: %s)",
    async (promptLimit) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-admission-many-")
      );
      try {
        const capture = path.join(directory, "tools.jsonl");
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: { query: "Which source is relevant?", evidence: [] }
          },
          {
            evaluationController: { scriptedFirstPass: false },
            responseDetail: "internal",
            client: {
              async search() {
                return { hits: [] };
              },
              async expand() {
                return {
                  expanded: {
                    nodeId: "node-1",
                    visibility: "personal",
                    sourceItems: Array.from({ length: 60 }, (_, index) => ({
                      kind: "memory_event",
                      sourceId: `event-${index}`,
                      text: `Complete source ${index}.`
                    }))
                  }
                };
              }
            },
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_MAX_PROMPT_TOKENS: String(promptLimit),
              MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "1",
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  mode: "expandResult",
                  captureToolResponsesPath: capture,
                  answer: {
                    ...answerObject(
                      "Additional complete sources require inspection.",
                      "insufficient"
                    ),
                    evidence: [],
                    missing_evidence: ["Relevant complete source"]
                  }
                })
            })
          }
        );
        expect(
          response.localMemoryWorker.usedFallback,
          response.localMemoryWorker.errorMessage
        ).toBe(false);
        const observation = parseAdmissionTestObservation(
          fs.readFileSync(capture, "utf8").trim()
        );
        expect(observation.state.omittedSources).toHaveLength(50);
        expect(observation.state).toMatchObject({
          omittedSourceCount: 59,
          omittedSourcesTruncated: true
        });
        expect(observation.reservedPromptTokens).toBeLessThanOrEqual(
          observation.state.remainingBudgets.promptTokens
        );
        if (promptLimit === 6500)
          expect(observation.reservedPromptTokens).toBe(0);
        expect(response.evidenceBundle?.retrieval).toMatchObject({
          expansions: [{ sourceItemCount: 1, omittedSourceCount: 59 }]
        });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("retires an intersected raw context window when an independent complete source is expanded", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-admission-window-")
    );
    try {
      const capture = path.join(directory, "tools.jsonl");
      const text =
        "GROUNDED_CHILD_EVIDENCE: independently authorized complete source.";
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "What is the complete source?",
            evidence: [eventWindow()]
          }
        },
        {
          evaluationController: { scriptedFirstPass: false },
          responseDetail: "internal",
          client: {
            async search() {
              return { hits: [] };
            },
            async expand(nodeId) {
              return {
                expanded: {
                  nodeId,
                  visibility: "personal",
                  sourceItems: [
                    { kind: "memory_event", sourceId: "event-b", text }
                  ]
                }
              };
            }
          },
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                mode: "expandSuccess",
                captureToolResponsesPath: capture,
                answer: {
                  ...answerObject(
                    "The complete independently observed source. [1 personal]"
                  ),
                  evidence: [
                    {
                      evidence_index: 3,
                      source_type: "memory_event",
                      source_id: "event-b",
                      source_chunk_index: 0,
                      visibility: "personal",
                      support: "GROUNDED_CHILD_EVIDENCE"
                    }
                  ]
                }
              })
          })
        }
      );
      expect(
        response.localMemoryWorker.usedFallback,
        response.localMemoryWorker.errorMessage
      ).toBe(false);
      const observation = parseAdmissionTestObservation(
        fs.readFileSync(capture, "utf8").trim()
      );
      expect(observation.state.evidenceCount).toBe(1);
      expect(observation.expandedEvidence).toEqual([
        expect.objectContaining({
          evidence_index: 3,
          item: expect.objectContaining({
            sourceId: "event-b",
            summaryText: text
          }) as unknown
        })
      ]);
      expect(response.evidenceBundle?.evidence).toEqual([
        expect.objectContaining({ sourceId: "event-b", summaryText: text })
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["pseudonymous-team-source", "owner-private-source"])(
    "matches expansion selectors against authorized Team identities only: %s",
    async (sourceId) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-admission-team-")
      );
      try {
        const capture = path.join(directory, "tools.jsonl");
        const expand = vi.fn(async () => ({
          expanded: {
            nodeId: "node-1",
            visibility: "team",
            sourceItems: [
              {
                kind: "memory_event",
                sourceId: "owner-private-source",
                canonicalSourceIdentity: {
                  sourceType: "memory_event",
                  sourceId: "pseudonymous-team-source",
                  sourceChunkIndex: 0
                },
                text: "AUTHORIZED_TEAM_BODY"
              }
            ]
          }
        }));
        await answerWithMemoryWorker(
          { evidenceBundle: { query: "Which Team source?", evidence: [] } },
          {
            evaluationController: { scriptedFirstPass: false },
            responseDetail: "internal",
            retrievalScope: "team",
            searchDomain: "global",
            teamWorkspaceId: "workspace-1",
            client: {
              async search() {
                return { hits: [] };
              },
              expand
            },
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  mode: "expandResult",
                  captureToolResponsesPath: capture,
                  expandArguments: {
                    sources: [
                      {
                        source_type: "memory_event",
                        source_id: sourceId,
                        source_chunk_index: 0
                      }
                    ]
                  },
                  answer: {
                    ...answerObject(
                      "Further context is needed.",
                      "insufficient"
                    ),
                    evidence: [],
                    missing_evidence: ["Additional context"]
                  }
                })
            })
          }
        );
        expect(expand).toHaveBeenCalledWith(
          "node-1",
          expect.objectContaining({ teamWorkspaceId: "workspace-1" })
        );
        const observation = parseAdmissionTestObservation(
          fs.readFileSync(capture, "utf8").trim()
        );
        if (sourceId === "pseudonymous-team-source")
          expect(observation.expandedEvidence).toEqual([
            expect.objectContaining({
              item: expect.objectContaining({
                sourceId,
                visibility: "team",
                summaryText: "AUTHORIZED_TEAM_BODY"
              }) as unknown
            })
          ]);
        else {
          expect(observation).toMatchObject({
            kind: "validation_error",
            message: "Invalid expansion sources."
          });
          expect(JSON.stringify(observation)).not.toContain(
            "AUTHORIZED_TEAM_BODY"
          );
        }
        expect(JSON.stringify(observation)).not.toContain(
          "owner-private-source"
        );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
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

  it("retains selected rollout facts and resolves a deduplicated expansion in the final bundle", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "expandSuccess",
        answer: {
          ...answerObject(
            "Restore backup; replay exactly 120 items with zero missing IDs within 90 seconds; confirm persisted byte cursor equals final source byte offset; obtain Store owner and Capture owner approval; then move traffic."
          ),
          evidence: [
            {
              source_type: "memory_node",
              source_id: "summary-parent-1",
              source_chunk_index: 0,
              node_id: "node-1",
              visibility: "personal"
            },
            {
              source_type: "memory_event",
              source_id: "event-child-1",
              source_chunk_index: 4,
              node_id: "node-1:source:event-child-1:4",
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
                citation: {
                  nodeId: "node-1",
                  sourceType: "memory_node",
                  sourceId: "summary-parent-1",
                  sourceChunkIndex: 0,
                  visibility: "personal"
                },
                sourceChunkIndex: 0,
                visibility: "personal",
                summaryText:
                  "Restore backup; replay exactly 120 items with zero missing IDs within 90 seconds; confirm persisted byte cursor equals final source byte offset; obtain Store owner and Capture owner approval; then move traffic."
              },
              {
                nodeId: "searched-event-child-1",
                sourceType: "memory_event",
                sourceId: "event-child-1",
                sourceChunkIndex: 4,
                visibility: "personal",
                summaryText:
                  "GROUNDED_CHILD_EVIDENCE: restore backup and replay 120 items with zero missing IDs.",
                citation: {
                  nodeId: "searched-event-child-1",
                  sourceType: "memory_event",
                  sourceId: "event-child-1",
                  sourceChunkIndex: 4,
                  visibility: "personal"
                }
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
                  text: "GROUNDED_CHILD_EVIDENCE: restore backup and replay 120 items with zero missing IDs."
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_SEARCHES: "3",
            MEMORY_ANSWER_MAX_EXPANSIONS: "1"
          })
        }
      );

      expect(expansions).toEqual(["node-1"]);
      expect(response.markdown).toContain("90 seconds");
      expect(response.localMemoryWorker).toMatchObject({
        usedFallback: false,
        memoryStatus: "found",
        expandCount: 1
      });
      expect(response.evidence).toHaveLength(2);
      expect(response.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: "summary-parent-1",
            summaryText:
              "Restore backup; replay exactly 120 items with zero missing IDs within 90 seconds; confirm persisted byte cursor equals final source byte offset; obtain Store owner and Capture owner approval; then move traffic."
          }),
          expect.objectContaining({
            sourceId: "event-child-1",
            sourceChunkIndex: 4,
            parentNodeIds: ["node-1"]
          })
        ])
      );
      expect(response.citations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceId: "summary-parent-1" }),
          expect.objectContaining({
            sourceId: "event-child-1",
            sourceChunkIndex: 4,
            nodeId: "searched-event-child-1"
          })
        ])
      );
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        expansions: [{ nodeId: "node-1" }],
        trace: {
          budgets: { consumed: { expansions: 1 } }
        }
      });
      expect(response.evidence?.[0]).not.toHaveProperty("observedReferences");
      expect(response.citations?.[1]).not.toHaveProperty("observedReferences");

      const capped = await answerWithMemoryWorker(
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
          limit: 1,
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "3",
            MEMORY_ANSWER_MAX_EXPANSIONS: "1"
          })
        }
      );
      expect(capped.localMemoryWorker.memoryStatus).toBe("insufficient");
      expect(capped.localMemoryWorker.errorMessage).toContain(
        "Memory answer budget exhausted: evidence_items"
      );
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_SEARCHES: "3",
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
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "2",
            MEMORY_ANSWER_MAX_SEARCHES: "3"
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_HARD_TIMEOUT_MS: "25",
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

  it("retries semantically invalid Codex output with validation feedback", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "invalidThenValid",
        retryPromptSnippets: [
          "The previous answer failed validation. Correct this before finishing:"
        ]
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "2"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.localMemoryWorker.appServerExecutions).toHaveLength(2);
      expect(
        response.localMemoryWorker.appServerExecutions?.[0]?.errorMessage
      ).toContain("relevant_memory_found");
      expect(
        response.localMemoryWorker.appServerExecutions?.map(
          (execution) => execution.status
        )
      ).toEqual(["failed", "succeeded"]);
      expect(
        response.localMemoryWorker.appServerExecutions?.[0]?.errorMessage
      ).toContain("relevant_memory_found");
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
      )?.trace;
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

  it.each([true, false])(
    "preserves support while shrinking retry context (follow-up retrieval: %s)",
    async (useTools) => {
      const calibrationDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-answer-budget-calibration-")
      );
      const constrainedDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-answer-budget-constrained-")
      );
      try {
        const calibrationPath = path.join(
          calibrationDirectory,
          "prompts.jsonl"
        );
        const calibration = await runPromptBudgetRegression(
          calibrationDirectory,
          24_000,
          calibrationPath,
          useTools
        );
        expect(calibration.localMemoryWorker.usedFallback).toBe(false);
        const calibrationPrompts = fs
          .readFileSync(calibrationPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string);
        expect(calibrationPrompts).toHaveLength(2);

        const retryPrompt = calibrationPrompts[1] ?? "";
        const feedbackMarker =
          "\nThe previous answer failed validation. Correct this before finishing:\n";
        const feedbackOffset = retryPrompt.indexOf(feedbackMarker);
        expect(feedbackOffset).toBeGreaterThan(0);
        const baseRetryPrompt = retryPrompt.slice(0, feedbackOffset);
        const firstPromptTokens = countTokensForModel(
          calibrationPrompts[0] ?? "",
          { model: promptBudgetRegressionModel }
        ).tokens;
        const retryTokens = countTokensForModel(retryPrompt, {
          model: promptBudgetRegressionModel
        }).tokens;
        const constrainedBudget = firstPromptTokens + retryTokens - 5;
        const constrainedPath = path.join(
          constrainedDirectory,
          "prompts.jsonl"
        );
        const constrained = await runPromptBudgetRegression(
          constrainedDirectory,
          constrainedBudget,
          constrainedPath,
          useTools
        );

        const constrainedPrompts = fs
          .readFileSync(constrainedPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string);
        const constrainedPromptTokenCounts = constrainedPrompts.map(
          (prompt) =>
            countTokensForModel(prompt, { model: promptBudgetRegressionModel })
              .tokens
        );
        expect(
          constrained.localMemoryWorker.usedFallback,
          `Worker failure: ${constrained.localMemoryWorker.errorMessage}; prompt token counts: ${constrainedPromptTokenCounts.join(", ")}`
        ).toBe(false);
        expect(constrainedPrompts).toHaveLength(2);
        const remainingPromptTokens =
          constrainedBudget - (constrainedPromptTokenCounts[0] ?? 0);
        expect(remainingPromptTokens).toBeLessThan(retryTokens);
        expect(constrainedPromptTokenCounts[1] ?? 0).toBeLessThanOrEqual(
          remainingPromptTokens
        );
        const constrainedRetry = constrainedPrompts[1] ?? "";
        const retainedA = constrainedRetry.includes("PROMPT_BUDGET_EVIDENCE_A");
        const retainedB = constrainedRetry.includes("PROMPT_BUDGET_EVIDENCE_B");
        expect(retainedA).not.toBe(retainedB);
        expect(constrainedRetry).toContain(feedbackMarker.trim());
        expect(baseRetryPrompt).toContain("PROMPT_BUDGET_EVIDENCE_A");
        expect(baseRetryPrompt).toContain("PROMPT_BUDGET_EVIDENCE_B");
        if (!useTools) {
          expect(constrained.evidence).toEqual([
            expect.objectContaining({ sourceId: "event-B" })
          ]);
        }
      } finally {
        fs.rmSync(calibrationDirectory, { recursive: true, force: true });
        fs.rmSync(constrainedDirectory, { recursive: true, force: true });
      }
    }
  );

  it("retries semantically invalid Claude output with shared validation feedback", async () => {
    const prompts: string[] = [];
    let attempt = 0;
    sdk.query.mockImplementation(({ prompt }: { prompt?: string }) => {
      prompts.push(typeof prompt === "string" ? prompt : "");
      attempt += 1;
      const structuredOutput =
        attempt === 1
          ? {
              ...answerObject("Unsupported answer"),
              relevant_memory_found: false
            }
          : {
              ...answerObject(
                "No complete evidence is available.",
                "pending_summary"
              ),
              missing: ["a completed summary"]
            };
      async function* resultStream(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: "result",
          subtype: "success",
          structured_output: structuredOutput,
          result: JSON.stringify(structuredOutput),
          modelUsage: {},
          usage: {}
        } as SDKMessage;
      }
      return resultStream() as Query;
    });

    const response = await answerWithMemoryWorker(
      { evidenceBundle: { query: "What is available?", evidence: [] } },
      {
        client: {
          async search() {
            throw new Error("pending summary should not retrieve");
          },
          async expand() {
            throw new Error("pending summary should not expand");
          }
        },
        responseDetail: "internal",
        config: {
          ...resolveMemoryAnswerWorkerConfig({}),
          provider: "claude",
          aiClientInstanceId: "claude.work",
          executablePath: process.execPath,
          maxAttempts: 2
        }
      }
    );

    expect(response.localMemoryWorker.usedFallback).toBe(false);
    expect(response.localMemoryWorker.memoryStatus).toBe("pending_summary");
    expect(attempt).toBe(2);
    expect(response.localMemoryWorker.appServerExecutions).toHaveLength(2);
    expect(
      response.localMemoryWorker.appServerExecutions?.[0]?.errorMessage
    ).toContain("relevant_memory_found");
    expect(prompts[1]).toContain(
      "The previous answer failed validation. Correct this before finishing:"
    );
    expect(prompts[1]).toContain("relevant_memory_found");
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false
              }),
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

  it.each([
    {
      reference: "original source identity",
      selection: {
        source_type: "memory_event",
        source_id: "original-event",
        source_chunk_index: 0,
        visibility: "personal"
      },
      expected: "original-event"
    },
    {
      reference: "original stable index",
      selection: { evidence_index: 0 },
      expected: "original-event"
    },
    {
      reference: "new stable index",
      selection: { evidence_index: 1 },
      expected: "later-event"
    },
    {
      reference: "unknown index",
      selection: { evidence_index: 2 },
      expected: null
    },
    {
      reference: "conflicting visibility",
      selection: {
        source_type: "memory_event",
        source_id: "original-event",
        source_chunk_index: 0,
        visibility: "team"
      },
      expected: null
    }
  ])(
    "validates $reference after a later search fills the candidate budget",
    async ({ selection, expected }) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-answer-stable-reference-")
      );
      try {
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: {
              query: "Which saved decision applies?",
              evidence: []
            }
          },
          {
            client: {
              async search(input) {
                return input.query === "later search"
                  ? {
                      hits: [
                        {
                          sourceType: "memory_event",
                          sourceId: "later-event",
                          sourceChunkIndex: 0,
                          visibility: "personal",
                          summaryText: "Later candidate"
                        }
                      ]
                    }
                  : { retrieval: { stages: [] } };
              },
              async expand(nodeId) {
                return {
                  expanded: {
                    nodeId,
                    visibility: "personal",
                    sourceItems: [
                      {
                        sourceId: "original-event",
                        sourceChunkIndex: 0,
                        text: "GROUNDED_CHILD_EVIDENCE: the saved decision."
                      }
                    ]
                  }
                };
              }
            },
            responseDetail: "internal",
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  mode: "expandThenSearch",
                  answer: {
                    ...answerObject("The saved decision applies."),
                    evidence: [
                      {
                        ...selection,
                        relevance: "saved decision",
                        support: "the saved decision"
                      }
                    ]
                  }
                }),
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_ANSWER_MAX_CANDIDATES: "1",
              MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "1"
            })
          }
        );
        if (expected) {
          expect(
            response.localMemoryWorker.usedFallback,
            response.localMemoryWorker.errorMessage
          ).toBe(false);
          expect(response.evidence).toEqual([
            expect.objectContaining({ sourceId: expected })
          ]);
          expect(response.localMemoryWorker.candidateCount).toBe(1);
        } else {
          expect(response.localMemoryWorker.usedFallback).toBe(true);
          expect(response.localMemoryWorker.errorMessage).toContain(
            "without resolvable supporting evidence"
          );
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("enforces the final evidence-token budget across earlier observations", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-answer-observed-budget-")
    );
    try {
      const response = await answerWithMemoryWorker(
        {
          evidenceBundle: {
            query: "Which saved decisions apply?",
            evidence: []
          }
        },
        {
          client: {
            async search(input) {
              return input.query === "later search"
                ? {
                    hits: [
                      {
                        sourceType: "memory_event",
                        sourceId: "later-event",
                        sourceChunkIndex: 0,
                        visibility: "personal",
                        summaryText: "beta ".repeat(160)
                      }
                    ]
                  }
                : { retrieval: { stages: [] } };
            },
            async expand(nodeId) {
              return {
                expanded: {
                  nodeId,
                  visibility: "personal",
                  sourceItems: [
                    {
                      sourceId: "original-event",
                      sourceChunkIndex: 0,
                      text: `GROUNDED_CHILD_EVIDENCE ${"alpha ".repeat(160)}`
                    }
                  ]
                }
              };
            }
          },
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                mode: "expandThenSearch",
                answer: {
                  ...answerObject("Both decisions apply."),
                  evidence: [0, 1].map((evidence_index) => ({
                    evidence_index,
                    relevance: "saved decision",
                    support: "the saved decision"
                  }))
                }
              }),
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_CANDIDATES: "2",
            MEMORY_ANSWER_MAX_EVIDENCE_ITEMS: "2",
            MEMORY_ANSWER_MAX_EVIDENCE_TOKENS: "256"
          })
        }
      );
      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.errorMessage).toContain(
        "budget exhausted: evidence_tokens"
      );
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false
              }),
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
      )?.trace?.budgets?.exhausted;
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
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  useTools: false
                }),
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
        )?.trace?.budgets?.exhausted;
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false,
                answer: answerObject(
                  "No matching relevant memory evidence was found.",
                  "not_found"
                )
              }),
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

  it.each(["internal", "with_evidence"] as const)(
    "keeps malformed worker failure diagnostics consistent (%s)",
    async (responseDetail) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
      try {
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: {
              query: "What dinner did the Team share?",
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
            responseDetail,
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  useTools: false,
                  answer: {
                    ...answerObject("Partial evidence", "insufficient"),
                    relevant_memory_found: true
                  }
                }),
              MEMORY_ANSWER_MAX_ATTEMPTS: "1"
            })
          }
        );
        expect(response.localMemoryWorker.usedFallback).toBe(true);
        if (responseDetail === "internal") {
          expect(response.localMemoryWorker.errorMessage).toContain(
            "insufficient requires relevant_memory_found to match selected partial evidence"
          );
        }
        expect(response.markdown).toBe(
          "The Codex worker returned an answer that Koed could not safely verify. Try again."
        );
        expect(response.structuredAnswer).toMatchObject({
          memory_status: "insufficient",
          answer_markdown: response.markdown,
          relevance_explanation:
            "The Memory Answer worker output did not satisfy the required answer format.",
          missing: ["valid structured worker output"],
          missing_evidence: []
        });
        expect(persistedAnswerResponse(response).structuredAnswer).toEqual(
          response.structuredAnswer
        );
        expect(JSON.stringify(response.structuredAnswer)).not.toMatch(
          /exhausted|failed retrieval stages|unexhausted/
        );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("accepts insufficient answers that identify missing evidence after clean retrieval", async () => {
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false,
                answer: answerObject(
                  "There is not enough evidence to answer.",
                  "insufficient"
                )
              }),
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.structuredAnswer?.memory_status).toBe("insufficient");
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                mode: "expandBudget"
              }),
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
      )?.trace?.budgets?.exhausted;
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY:
              writeFakeDynamicMemoryAnswerAppServer(directory, {
                useTools: false
              }),
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
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
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
          responseDetail: "internal",
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "1"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
      expect(response.localMemoryWorker.errorMessage).toContain(
        "not_found after scan candidates without inspecting evidence"
      );
      expect(response.markdown).toBe(
        "The Codex worker reached its search limit before it could verify an answer. Try a narrower question."
      );
      const exhausted = (
        response.evidenceBundle?.retrieval as {
          trace?: { budgets?: { exhausted?: unknown[] } };
        }
      )?.trace?.budgets?.exhausted;
      expect(exhausted).toContain("searches");
      expect(exhausted).toContain("attempts");
      expect(searches).toHaveLength(1);
      expect(searches[0]?.retrieval_stage).toBe("score_scan");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps not_found when only the search budget ran out after complete retrieval", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        mode: "scanLoop"
      });
      const searches: Record<string, unknown>[] = [];
      const client: MemoryAnswerRetrievalClient = {
        async search(input) {
          searches.push(input);
          return { retrieval: { stages: [] } };
        },
        async expand() {
          throw new Error("expand should not run without candidates");
        }
      };

      const response = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "What retry backoff did we choose for the sync worker?",
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1",
            MEMORY_ANSWER_MAX_SEARCHES: "1"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(false);
      expect(response.localMemoryWorker.memoryStatus).toBe("not_found");
      expect(response.markdown).toBe(
        "No matching relevant memory evidence was found."
      );
      const exhausted = (
        response.evidenceBundle?.retrieval as {
          trace?: { budgets?: { exhausted?: unknown[] } };
        }
      )?.trace?.budgets?.exhausted;
      expect(exhausted).toEqual(["searches"]);
      expect(searches).toHaveLength(1);
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
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
        "The Codex worker could not complete the Personal Memory search needed to answer reliably. Try again."
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
      )?.trace;
      expect(typeof trace?.attempts?.[0]?.model).toBe("string");
      expect(typeof trace?.modelMetadata?.configuredModel).toBe("string");
      expect(typeof trace?.modelMetadata?.promptTokenEstimate).toBe("number");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a worker failure, not a retrieval failure, when retrieval completed", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-answer-"));
    try {
      const appServerBinary = writeFakeDynamicMemoryAnswerAppServer(directory, {
        useTools: false
      });
      const client: MemoryAnswerRetrievalClient = {
        async search() {
          return { retrieval: { stages: [] } };
        },
        async expand() {
          throw new Error("expand should not run without candidates");
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
          config: resolveMemoryAnswerWorkerTestConfig(directory, {
            MEMORY_ANSWER_PROVIDER: "codex",
            MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
            MEMORY_ANSWER_MAX_ATTEMPTS: "1"
          })
        }
      );

      expect(response.localMemoryWorker.usedFallback).toBe(true);
      expect(response.localMemoryWorker.errorMessage).toContain(
        "without resolvable supporting evidence"
      );
      expect(response.markdown).toBe(
        "The Codex worker could not verify its answer against enough supporting Personal Memory evidence."
      );
      expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
      expect(response.structuredAnswer).toMatchObject({
        memory_status: "insufficient",
        relevant_memory_found: false,
        relevance_explanation:
          "The Memory Answer worker used every allowed attempt without producing an answer Koed could verify.",
        evidence: [],
        missing: ["verified worker answer"],
        missing_evidence: []
      });
      expect(response.evidenceBundle?.retrieval).toMatchObject({
        trace: {
          orderedErrors: [],
          budgets: { exhausted: ["attempts"] }
        }
      });
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

  it("resolves observed searched and expanded identities after canonical merging", () => {
    const searched = {
      nodeId: "searched-child",
      sourceType: "memory_node",
      sourceId: "child",
      sourceChunkIndex: 7,
      visibility: "personal",
      summaryText: "Selected child",
      citation: {
        nodeId: "searched-child",
        sourceType: "memory_node",
        sourceId: "child",
        sourceChunkIndex: 7
      }
    };
    const [expanded] = evidenceFromExpansion({
      expanded: {
        nodeId: "parent",
        visibility: "personal",
        sourceItems: [
          {
            kind: "lcm_child",
            sourceId: "child",
            position: 7,
            canonicalSourceIdentity: {
              sourceType: "memory_node",
              sourceId: "child",
              sourceChunkIndex: 7
            },
            text: "Selected child"
          }
        ]
      }
    });
    const merged = mergeMemoryAnswerCandidateLists(
      [searched],
      [{ query: "child", stage: "expanded_source", hits: [expanded] }]
    );
    for (const node_id of [
      searched.nodeId,
      (expanded as { nodeId: string }).nodeId
    ]) {
      const selected = evidenceSelectedByAnswer(merged, {
        ...answerObject("Selected child"),
        evidence: [
          {
            source_type: "memory_node",
            source_id: "child",
            source_chunk_index: 7,
            node_id,
            visibility: "personal"
          }
        ]
      } as StructuredMemoryAnswer);
      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject({
        sourceId: "child",
        sourceChunkIndex: 7
      });
    }
  });

  it("rejects ambiguous and conflicting observed references", () => {
    const searched = {
      nodeId: "searched",
      sourceType: "memory_node",
      sourceId: "child",
      sourceChunkIndex: 7,
      visibility: "personal"
    };
    const expanded = {
      ...searched,
      nodeId: "expanded",
      parentNodeIds: ["parent"]
    };
    const merged = mergeMemoryAnswerCandidateLists(
      [searched],
      [{ query: "q", stage: "expanded_source", hits: [expanded] }]
    );
    const selection = {
      source_type: "memory_node",
      source_id: "child",
      source_chunk_index: 7,
      node_id: "searched",
      visibility: "personal"
    };
    for (const change of [
      { source_chunk_index: 0 },
      { source_id: "unauthorized" },
      { node_id: "unobserved" },
      { node_id: "parent" },
      { visibility: "team" }
    ]) {
      expect(() =>
        evidenceSelectedByAnswer(merged, {
          ...answerObject("child"),
          evidence: [{ ...selection, ...change }]
        } as StructuredMemoryAnswer)
      ).toThrow("without resolvable supporting evidence");
    }
    expect(
      evidenceSelectedByAnswer([searched, { ...searched }], {
        ...answerObject("child"),
        evidence: [
          {
            source_type: "memory_node",
            source_id: "child",
            source_chunk_index: 7
          }
        ]
      } as StructuredMemoryAnswer)
    ).toEqual([searched]);
    expect(() =>
      evidenceSelectedByAnswer(
        [searched, { ...searched, visibility: "team" }],
        {
          ...answerObject("child"),
          evidence: [
            {
              source_type: "memory_node",
              source_id: "child",
              source_chunk_index: 7
            }
          ]
        } as StructuredMemoryAnswer
      )
    ).toThrow("without resolvable supporting evidence");
  });

  it("keeps a complete selected rollout parent alongside partial children", () => {
    const summaryText =
      "Restore backup; replay 120 items with zero missing IDs within 90 seconds; persisted byte cursor equals final source offset; Store owner and Capture owner approve; then move traffic.";
    const parent = {
      nodeId: "rollout",
      sourceType: "memory_node",
      sourceId: "rollout",
      sourceChunkIndex: 0,
      summaryText,
      visibility: "personal",
      corroborationGroupId: "rollout"
    };
    const children = evidenceFromExpansion({
      expanded: {
        nodeId: "rollout",
        visibility: "personal",
        sourceItems: [
          {
            sourceId: "restore",
            position: 4,
            text: "Restore backup and replay 120 items with zero missing IDs."
          },
          {
            sourceId: "traffic",
            position: 8,
            text: "Move traffic after approvals."
          }
        ]
      }
    });
    const evidence = [parent, ...children];
    const selected = evidenceSelectedByAnswer(evidence, {
      ...answerObject(summaryText),
      evidence: [
        { evidence_index: 0 },
        { evidence_index: 1 },
        { evidence_index: 2 },
        { evidence_index: 0 }
      ]
    } as StructuredMemoryAnswer);
    expect(selected).toEqual(evidence);
    expect(selected[0]).toMatchObject({ summaryText });
    expect(children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentNodeIds: ["rollout"],
          corroborationGroupId: "rollout"
        })
      ])
    );
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

  describe("consistent source selection", () => {
    const original = {
      sourceType: "memory_event",
      sourceId: "generated-original-note",
      sourceChunkIndex: 0,
      visibility: "personal",
      summaryText: "My favourite colour is yellow."
    };
    const replay = {
      ...original,
      sourceId: "generated-replayed-answer",
      summaryText: "Earlier recall reported yellow, quoting the original note."
    };
    const candidates = [replay, original, { ...original, sourceChunkIndex: 1 }];
    const selection = {
      source_type: original.sourceType,
      source_id: original.sourceId,
      source_chunk_index: original.sourceChunkIndex
    };
    const answer = (evidence: StructuredMemoryAnswer["evidence"]) =>
      ({ ...answerObject("Yellow"), evidence }) as StructuredMemoryAnswer;

    it.each([0, 1, 99])(
      "resolves the original source instead of trusting index %s",
      (evidence_index) => {
        expect(
          evidenceSelectedByAnswer(
            candidates,
            answer([{ ...selection, evidence_index }])
          )
        ).toEqual([original]);
      }
    );

    it("selects the indexed snapshot when the same source is observed again", () => {
      const updated = { ...original, summaryText: "Updated source content" };
      for (const evidence_index of [0, 1]) {
        const observations = [original, updated];
        expect(
          evidenceSelectedByAnswer(
            observations,
            answer([{ ...selection, evidence_index }])
          )
        ).toEqual([observations[evidence_index]]);
      }
    });

    it("preserves index-only selection and checks supplied partial identity", () => {
      expect(
        evidenceSelectedByAnswer(candidates, answer([{ evidence_index: 0 }]))
      ).toEqual([replay]);
      expect(
        evidenceSelectedByAnswer(
          candidates,
          answer([{ evidence_index: 1, source_id: original.sourceId }])
        )
      ).toEqual([original]);
      expect(() =>
        evidenceSelectedByAnswer(
          candidates,
          answer([{ evidence_index: 0, source_id: original.sourceId }])
        )
      ).toThrow("without resolvable supporting evidence");
    });

    it.each([
      { ...selection, source_id: "missing-source", evidence_index: 0 },
      { ...selection, source_type: "memory_node", evidence_index: 0 },
      { ...selection, source_chunk_index: 9, evidence_index: 1 },
      { ...selection, node_id: "wrong-node", evidence_index: 1 },
      { ...selection, visibility: "team", evidence_index: 1 },
      { evidence_index: 99 },
      { evidence_index: -1 },
      { evidence_index: 0.5 }
    ])("rejects unresolved or conflicting references %#", (reference) => {
      expect(() =>
        evidenceSelectedByAnswer(candidates, answer([reference]))
      ).toThrow("without resolvable supporting evidence");
    });

    it("checks partial chunk/node references and explicit missing visibility", () => {
      for (const reference of [
        { evidence_index: 1, source_chunk_index: 1 },
        { evidence_index: 1, node_id: "different-node" }
      ]) {
        expect(() =>
          evidenceSelectedByAnswer(candidates, answer([reference]))
        ).toThrow("without resolvable supporting evidence");
      }
      const withoutVisibility = { ...original, visibility: undefined };
      expect(() =>
        evidenceSelectedByAnswer(
          [withoutVisibility],
          answer([{ ...selection, visibility: "personal" }])
        )
      ).toThrow("without resolvable supporting evidence");
    });

    it("rejects a dangling citation even alongside a valid selection", () => {
      expect(() =>
        evidenceSelectedByAnswer(
          candidates,
          answer([selection, { ...selection, source_id: "missing-source" }])
        )
      ).toThrow("without resolvable supporting evidence");
    });

    it("selects exact chunks and deduplicates repeated references", () => {
      expect(
        evidenceSelectedByAnswer(
          candidates,
          answer([
            { ...selection, evidence_index: 0 },
            selection,
            { ...selection, source_chunk_index: 1, evidence_index: 1 }
          ])
        )
      ).toEqual([original, candidates[2]]);
    });
  });

  it.each([false, true])(
    "validates worker source identity across stale indexes (missing=%s)",
    async (missing) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-answer-selection-")
      );
      const original = {
        sourceType: "memory_event",
        sourceId: "generated-original",
        citation: { sourceId: "generated-original" },
        sourceChunkIndex: 0,
        visibility: "personal",
        summaryText: "My favourite colour is yellow."
      };
      const replay = {
        ...original,
        sourceId: "generated-replay",
        citation: { sourceId: "generated-replay" },
        summaryText: "Previous recall said yellow."
      };
      try {
        const response = await answerWithMemoryWorker(
          {
            evidenceBundle: {
              query: "What is my favourite colour?",
              evidence: [replay, original],
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
            config: resolveMemoryAnswerWorkerTestConfig(directory, {
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_CODEX_APP_SERVER_BINARY:
                writeFakeDynamicMemoryAnswerAppServer(directory, {
                  useTools: false,
                  answer: {
                    ...answerObject("Yellow"),
                    evidence: [
                      {
                        evidence_index: 0,
                        source_type: "memory_event",
                        source_id: missing
                          ? "generated-missing"
                          : original.sourceId,
                        source_chunk_index: 0
                      }
                    ]
                  }
                }),
              MEMORY_ANSWER_MAX_ATTEMPTS: "1"
            })
          }
        );
        if (missing) {
          expect(response.localMemoryWorker.usedFallback).toBe(true);
          expect(response.localMemoryWorker.memoryStatus).toBe("insufficient");
          expect(response.localMemoryWorker.errorMessage).toContain(
            "without resolvable supporting evidence"
          );
        } else {
          expect(response.localMemoryWorker.usedFallback).toBe(false);
          expect(response.evidence).toMatchObject([
            { sourceId: original.sourceId, sourceChunkIndex: 0 }
          ]);
          expect(response.citations).toMatchObject([
            { sourceId: original.sourceId }
          ]);
          expect(response.structuredAnswer?.evidence).toMatchObject([
            { source_id: original.sourceId }
          ]);
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["personal", "team"])(
    "charges both %s Global pools to the search budget and forwards pinned provenance",
    async (retrievalScope) => {
      const context = {
        kind: "portable_repository" as const,
        key: "gr_current",
        root: "/current",
        branch: "main",
        reason: "origin" as const,
        checkoutId: "checkout_current",
        originatingDeviceId: "fixture_device",
        selectedRemote: "origin",
        anchorDisplay: "example.test/team/current"
      };
      const requests: Record<string, unknown>[] = [];
      const result = await runScriptedMemoryAnswerFirstPass({
        client: {
          async search(input) {
            requests.push(input);
            return {
              hits: [
                {
                  sourceType: "memory_event",
                  sourceId: "global-source",
                  sourceChunkIndex: 0,
                  sourceChunkCount: 2,
                  summaryText: "Release checklist decision",
                  provenance: {
                    project: {
                      classification: "other",
                      label: "Other Project"
                    },
                    lineageSessionIds: ["shared-history"]
                  },
                  observedReferences: [
                    {
                      nodeId: "global-source",
                      sourceType: "memory_event",
                      sourceId: "global-source",
                      sourceChunkIndex: 0,
                      sourceChunkCount: 2,
                      visibility: retrievalScope,
                      sourceGeneration: 7,
                      retrievalStage: "raw_fallback_search",
                      parentNodeIds: ["parent-summary"]
                    }
                  ]
                }
              ],
              retrieval: { searchPasses: 2 }
            };
          },
          async expand() {
            throw new Error("unused");
          }
        },
        query: "release decisions",
        retrievalScope,
        searchDomain: "global",
        repositoryContext: context,
        limit: 10,
        maxSearches: 3
      });
      expect(result.evidence[0]).toMatchObject({
        observedReferences: [
          expect.objectContaining({
            sourceChunkIndex: 0,
            sourceChunkCount: 2,
            sourceGeneration: 7,
            retrievalStage: "raw_fallback_search",
            parentNodeIds: ["parent-summary"]
          })
        ]
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        repository_context: context,
        max_search_passes: 2
      });
      expect(result.searches[0]).toMatchObject({ searchPasses: 2 });
      expect(result.evidence[0]).toMatchObject({
        sourceChunkCount: 2,
        provenance: {
          project: { classification: "other", label: "Other Project" }
        }
      });
    }
  );

  it.each(["personal", "team"])(
    "budgets one-pass scans separately from contextual %s retrieval",
    async (retrievalScope) => {
      const requests: Record<string, unknown>[] = [];
      const result = await runScriptedMemoryAnswerFirstPass({
        query: "release guidance",
        retrievalHints: {
          semantic: ["shipping decision"],
          lexical: ["rollout"]
        },
        retrievalScope,
        searchDomain: "global",
        limit: 10,
        maxSearches: 6,
        repositoryContext: {
          kind: "portable_repository",
          key: "gr_current",
          root: "/current",
          branch: "main",
          reason: "origin",
          checkoutId: "checkout_current",
          originatingDeviceId: "device_current",
          selectedRemote: "origin",
          anchorDisplay: null
        },
        client: {
          async search(input) {
            requests.push(input);
            return {
              hits: [],
              retrieval: {
                searchPasses: input.retrieval_stage === "score_scan" ? 1 : 2,
                stages: [
                  {
                    name: "rollup_search",
                    countAboveThreshold: 3,
                    maxAllowed: 10
                  }
                ]
              }
            };
          },
          async expand() {
            throw new Error("unused");
          }
        }
      });
      expect(
        requests.filter((request) => request.retrieval_stage === "score_scan")
      ).toHaveLength(2);
      expect(
        requests
          .filter((request) => request.retrieval_stage === "score_scan")
          .every((request) => request.max_search_passes === 1)
      ).toBe(true);
      expect(
        requests.some((request) => request.query === "shipping decision")
      ).toBe(true);
      expect(
        result.searches.reduce(
          (sum, search) => sum + (search.searchPasses ?? 1),
          0
        )
      ).toBe(4);
      expect(result.skippedQueries).toHaveLength(1);
    }
  );

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
