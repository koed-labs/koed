import http from "node:http";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const answerWithMemoryWorker = vi.fn();
const checkCodexAppServerAvailability = vi.fn();
const listCodexAppServerModels = vi.fn();

vi.mock("../src/answer-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/answer-worker.js")>()),
  answerWithMemoryWorker
}));

vi.mock("../src/codex-app-server-runner.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/codex-app-server-runner.js")
  >()),
  checkCodexAppServerAvailability,
  listCodexAppServerModels
}));

const servers: http.Server[] = [];

type AsyncRequestListener = (
  request: http.IncomingMessage,
  response: http.ServerResponse
) => Promise<void> | void;

const createServer = async (handler: AsyncRequestListener): Promise<string> => {
  return listenServer(
    http.createServer((request, response) => {
      void Promise.resolve(handler(request, response)).catch(
        (error: unknown) => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error)
            })
          );
        }
      );
    })
  );
};

const listenServer = async (server: http.Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
};

const readJson = async (request: http.IncomingMessage) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
    string,
    unknown
  >;
};

const waitForAsyncHandlers = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const expectFetchWithAbortSignal = (
  fetchFn: typeof fetch,
  healthUrl: string
) => {
  const calls = vi.mocked(fetchFn).mock.calls;
  expect(calls).toHaveLength(1);
  const [url, init] = calls[0]!;
  expect(url).toBe(healthUrl);
  expect(init?.signal).toBeInstanceOf(AbortSignal);
};

const json = (
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>
) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

type LocalMemoryAgentSettingsResponse = {
  aiClients: unknown;
  modelOptions: unknown;
  flows: {
    manualMemoryAnswer: Record<string, unknown>;
    mcpMemoryAnswer: Record<string, unknown>;
    lcmSummary: Record<string, unknown>;
    curatedMemoryReview: Record<string, unknown>;
  };
};

const retryableSynthesisFailureMessage =
  "Memory answer synthesis failed. Koed will retry shortly.";

const terminalSynthesisFailureMessage =
  "Memory answer synthesis failed after retries. Please try again.";

const postJson = async <T>(
  url: string,
  body: Record<string, unknown>
): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer cmt_test",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
};

const postRaw = async (
  url: string,
  body: string
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer cmt_test",
      "content-type": "application/json"
    },
    body
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>
  };
};

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  answerWithMemoryWorker.mockReset();
  checkCodexAppServerAvailability.mockReset();
  listCodexAppServerModels.mockReset();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

describe("local memory answer bridge", () => {
  it("updates an existing pending question with a local worker answer", async () => {
    const questionId = randomUUID();
    const patches: Record<string, unknown>[] = [];
    const rawItemRequests: Record<string, unknown>[] = [];
    const tokenUsageRequests: Record<string, unknown>[] = [];
    const operations: string[] = [];
    const tokenConversationItemId = randomUUID();
    const largeEvidenceText = "large evidence payload ".repeat(20_000);
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, {
          ok: true,
          canWritePersonal: true
        });
        return;
      }
      if (request.url === "/v1/memory/answer") {
        json(response, 200, {
          evidence: [{ id: "evidence-1" }],
          evidenceBundle: { retrieval: { searchDomain: "project" } },
          citations: [{ id: "citation-1" }]
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: 1,
              query: "What did we decide?",
              retrievalScope: "personal",
              searchDomain: "project",
              projectId: "project-1",
              localMemoryWorkerConfig: {
                provider: "codex",
                model: "gpt-5.4",
                reasoningEffort: "medium",
                timeoutMs: 90000,
                maxAttempts: 4
              },
              status: "pending"
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        operations.push("patch");
        patches.push(await readJson(request));
        json(response, 200, {
          question: {
            id: questionId,
            query: "What did we decide?",
            status: "answered",
            answerMarkdown: "The answer"
          }
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/conversation-items"
      ) {
        operations.push("raw");
        const body = await readJson(request);
        rawItemRequests.push(body);
        const items = (body.items as Array<{ sourceEventType?: string }>).map(
          (item) => ({
            id:
              item.sourceEventType === "thread/tokenUsage/updated"
                ? tokenConversationItemId
                : randomUUID(),
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: item.sourceEventType ?? "turn/completed",
            idempotencyKey: "raw-question-test",
            createdAt: new Date().toISOString()
          })
        );
        json(response, 200, {
          items
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/token-usage"
      ) {
        operations.push("token");
        tokenUsageRequests.push(await readJson(request));
        json(response, 200, { tokenUsage: { id: randomUUID() } });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/conversation-items/project"
      ) {
        operations.push("project");
        await readJson(request);
        json(response, 200, {
          projection: {
            rawItemsScanned: 1,
            rawItemsProjected: 1,
            messagesCreated: 0,
            toolEventsCreated: 0,
            memoryEventsCreated: 0,
            tokenUsageRowsCreated: 0
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    answerWithMemoryWorker.mockResolvedValue({
      markdown: "The answer",
      evidenceBundle: {
        evidence: [{ id: "evidence-1", summaryText: largeEvidenceText }],
        retrieval: { mode: "leaf_search" }
      },
      citations: [{ id: "citation-1" }],
      localMemoryWorker: {
        status: "ok",
        appServerThreadId: "thread-question-test",
        appServerTurnId: "final-question-test",
        appServerEvents: [
          {
            method: "turn/completed",
            observedAt: "2026-05-27T00:00:00.000Z",
            params: { threadId: "thread-question-test" }
          },
          {
            method: "thread/tokenUsage/updated",
            observedAt: "2026-05-27T00:00:01.000Z",
            params: {
              threadId: "thread-question-test",
              turnId: "turn-question-test",
              tokenUsage: {
                modelContextWindow: 32768,
                last: {
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 3,
                  reasoningOutputTokens: 1,
                  totalTokens: 13
                }
              }
            }
          }
        ],
        appServerExecutions: [
          {
            answerJobId: "answer-job-test",
            model: "codex-app-server:test",
            primaryThreadId: "thread-question-test",
            threadId: "thread-question-test",
            turnId: "turn-question-test",
            tokenUsage: {
              modelContextWindow: 32768,
              last: {
                inputTokens: 10,
                cachedInputTokens: 2,
                outputTokens: 3,
                reasoningOutputTokens: 1,
                totalTokens: 13
              },
              total: {
                inputTokens: 10,
                cachedInputTokens: 2,
                outputTokens: 3,
                reasoningOutputTokens: 1,
                totalTokens: 13
              }
            },
            rawEvents: [
              {
                method: "turn/completed",
                observedAt: "2026-05-27T00:00:00.000Z",
                params: { threadId: "thread-question-test" }
              },
              {
                method: "thread/tokenUsage/updated",
                observedAt: "2026-05-27T00:00:01.000Z",
                params: {
                  threadId: "thread-question-test",
                  turnId: "turn-question-test",
                  tokenUsage: {
                    modelContextWindow: 32768,
                    last: {
                      inputTokens: 10,
                      cachedInputTokens: 2,
                      outputTokens: 3,
                      reasoningOutputTokens: 1,
                      totalTokens: 13
                    }
                  }
                }
              }
            ]
          }
        ],
        tokenUsage: {
          modelContextWindow: 32768,
          last: {
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 3,
            reasoningOutputTokens: 1,
            totalTokens: 13
          },
          total: {
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 3,
            reasoningOutputTokens: 1,
            totalTokens: 13
          }
        },
        model: "codex-app-server:test"
      }
    });
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const result = await postJson<{
      ok: boolean;
      question: { id: string };
      answer?: {
        evidenceBundle?: { evidence?: unknown[] };
        localMemoryWorker?: {
          appServerEvents?: unknown;
          appServerExecutions?: Array<{ rawEvents?: unknown }>;
        };
      };
    }>(`${bridgeUrl}/v1/memory/answer-local`, {
      question_id: questionId,
      query: "What did we decide?",
      search_domain: "project",
      project_id: "project-1"
    });

    expect(result).toMatchObject({ ok: true, question: { id: questionId } });
    expect(result.answer?.evidenceBundle?.evidence).toEqual([
      { id: "evidence-1", summaryText: largeEvidenceText }
    ]);
    expect(result.answer?.localMemoryWorker?.appServerEvents).toBeUndefined();
    expect(
      result.answer?.localMemoryWorker?.appServerExecutions?.[0]?.rawEvents
    ).toBeUndefined();
    expect(answerWithMemoryWorker.mock.calls[0]?.[1]).toMatchObject({
      config: {
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        timeoutMs: 90000,
        maxAttempts: 4
      }
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      status: "answered",
      attempt_count: 1,
      answer_markdown: "The answer",
      local_memory_worker: { status: "ok" }
    });
    expect(patches[0]?.evidence).toEqual([
      { id: "evidence-1", summaryText: largeEvidenceText }
    ]);
    expect(JSON.stringify(patches[0]?.response)).not.toContain(
      largeEvidenceText
    );
    expect(patches[0]?.response).not.toHaveProperty("evidenceBundle");
    expect(patches[0]?.response).not.toHaveProperty("evidence");
    expect(
      (patches[0]?.local_memory_worker as { appServerEvents?: unknown })
        .appServerEvents
    ).toBeUndefined();
    expect(
      (
        patches[0]?.local_memory_worker as {
          appServerExecutions?: Array<{ rawEvents?: unknown }>;
        }
      ).appServerExecutions?.[0]?.rawEvents
    ).toBeUndefined();
    expect(
      (
        (
          patches[0]?.response as {
            localMemoryWorker?: {
              appServerEvents?: unknown;
              appServerExecutions?: Array<{ rawEvents?: unknown }>;
            };
          }
        ).localMemoryWorker ?? {}
      ).appServerEvents
    ).toBeUndefined();
    expect(
      (
        (
          patches[0]?.response as {
            localMemoryWorker?: {
              appServerExecutions?: Array<{ rawEvents?: unknown }>;
            };
          }
        ).localMemoryWorker ?? {}
      ).appServerExecutions?.[0]?.rawEvents
    ).toBeUndefined();
    expect(rawItemRequests).toHaveLength(1);
    expect(rawItemRequests[0]).toMatchObject({
      items: [
        expect.objectContaining({
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          sourceTransport: "app_server",
          externalThreadId: "thread-question-test",
          externalTurnId: "turn-question-test",
          sourceEventType: "turn/completed"
        }),
        expect.objectContaining({
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          sourceTransport: "app_server",
          externalThreadId: "thread-question-test",
          externalTurnId: "turn-question-test",
          sourceEventType: "thread/tokenUsage/updated"
        })
      ]
    });
    const firstRawItem = (
      rawItemRequests[0] as { items?: Array<{ metadata?: unknown }> }
    ).items?.[0];
    expect(firstRawItem?.metadata).toMatchObject({
      workflow: "memory_question",
      questionId,
      answerJobId: "answer-job-test",
      primaryAppServerThreadId: "thread-question-test"
    });
    expect(tokenUsageRequests).toHaveLength(1);
    expect(tokenUsageRequests[0]).toMatchObject({
      workflowType: "memory_question",
      workflowId: questionId,
      conversationItemId: tokenConversationItemId,
      idempotencyKey: `token:${tokenConversationItemId}:last`
    });
    expect(tokenUsageRequests[0]?.metadata).toMatchObject({
      answerJobId: "answer-job-test",
      appServerTurnId: "turn-question-test",
      primaryAppServerThreadId: "thread-question-test",
      executionThreadId: "thread-question-test",
      executionTurnId: "turn-question-test"
    });
    expect(operations).toEqual(["raw", "token", "project", "patch"]);
  });

  it("returns 400 for local bridge validation errors", async () => {
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const missingQuery = await postRaw(
      `${bridgeUrl}/v1/memory/answer-local`,
      JSON.stringify({ search_domain: "global" })
    );
    const malformedJson = await postRaw(
      `${bridgeUrl}/v1/memory/answer-local`,
      "{"
    );

    expect(missingQuery.status).toBe(400);
    expect(missingQuery.body.error).toContain("query");
    expect(malformedJson.status).toBe(400);
  });

  it("reports effective local agent settings and Codex availability", async () => {
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      if (request.url?.startsWith("/v1/memory/local-agent-settings")) {
        json(response, 200, {
          settings: [
            {
              flowKey: "mcp_memory_answer",
              provider: "codex",
              model: "gpt-5.4",
              reasoningEffort: "high",
              timeoutMs: 180000,
              maxAttempts: 3
            },
            {
              flowKey: "lcm_summary",
              provider: "codex",
              model: "gpt-5.4-mini-lcm",
              reasoningEffort: "low",
              timeoutMs: 90000,
              maxAttempts: 4
            }
          ]
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    vi.stubEnv("MEMORY_ANSWER_MODEL", "gpt-5.4-mini");
    vi.stubEnv("MEMORY_MANUAL_ANSWER_MODEL", "gpt-5.4");
    vi.stubEnv("MEMORY_MANUAL_ANSWER_REASONING_EFFORT", "medium");
    vi.stubEnv("MEMORY_LCM_SUMMARY_MODEL", "gpt-5.4-mini-lcm");
    vi.stubEnv("MEMORY_CURATED_REVIEW_MODEL", "gpt-5.4-mini-curated");
    checkCodexAppServerAvailability.mockResolvedValue({ available: true });
    listCodexAppServerModels.mockResolvedValue([
      {
        id: "gpt-5.4",
        model: "gpt-5.4",
        label: "gpt-5.4",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "minimal", description: "Minimal" },
          { reasoningEffort: "high", description: "High" }
        ]
      },
      {
        id: "gpt-5.4-mini",
        model: "gpt-5.4-mini",
        label: "gpt-5.4-mini",
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Medium" }
        ]
      }
    ]);
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const response = await fetch(
      `${bridgeUrl}/v1/memory/local-agent-settings`,
      {
        headers: { authorization: "Bearer cmt_test" }
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as LocalMemoryAgentSettingsResponse;
    expect(body.aiClients).toEqual([
      { id: "codex", label: "Codex", status: "ready", error: null }
    ]);
    expect(body.modelOptions).toEqual([
      expect.objectContaining({
        model: "gpt-5.4",
        label: "gpt-5.4",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "minimal", description: "Minimal" },
          { reasoningEffort: "high", description: "High" }
        ]
      }),
      expect.objectContaining({
        model: "gpt-5.4-mini",
        label: "gpt-5.4-mini",
        defaultReasoningEffort: "medium"
      })
    ]);
    expect(body.flows.manualMemoryAnswer).toMatchObject({
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "medium"
    });
    expect(body.flows.mcpMemoryAnswer).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
      timeoutMs: 180000,
      maxAttempts: 3,
      source: "db"
    });
    expect(body.flows.lcmSummary).toMatchObject({
      model: "gpt-5.4-mini-lcm",
      reasoningEffort: "low",
      timeoutMs: 90000,
      maxAttempts: 4,
      source: "db"
    });
    expect(body.flows.curatedMemoryReview).toMatchObject({
      model: "gpt-5.4-mini-curated",
      reasoningEffort: "medium",
      timeoutMs: 90000,
      maxAttempts: 2,
      source: "env"
    });
  });

  it("allows credentialed browser preflight for local agent settings", async () => {
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(
      createAnswerBridgeServer({ startBackgroundService: false })
    );

    const response = await fetch(
      `${bridgeUrl}/v1/memory/local-agent-settings/mcp_memory_answer`,
      {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5174",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "authorization, content-type"
        }
      }
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5174"
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true"
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PUT"
    );
  });

  it("persists local agent settings through the bridge", async () => {
    const updates: Record<string, unknown>[] = [];
    const apiUrl = await createServer(async (request, response) => {
      if (
        request.method === "PUT" &&
        request.url === "/v1/memory/local-agent-settings/curated_memory_review"
      ) {
        expect(request.headers.authorization).toBe("Bearer cmt_test");
        updates.push(await readJson(request));
        json(response, 200, {
          setting: {
            flowKey: "curated_memory_review",
            provider: "codex",
            model: "gpt-5.4",
            reasoningEffort: "xhigh",
            timeoutMs: 150000,
            maxAttempts: 5
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(
      createAnswerBridgeServer({ startBackgroundService: false })
    );

    const response = await fetch(
      `${bridgeUrl}/v1/memory/local-agent-settings/curated_memory_review`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer cmt_test",
          "content-type": "application/json",
          origin: "http://localhost:5174"
        },
        body: JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
          reasoning_effort: "xhigh",
          timeout_ms: 150000,
          max_attempts: 5
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5174"
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true"
    );
    expect(await response.json()).toEqual({
      ok: true,
      setting: {
        flowKey: "curated_memory_review",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        timeoutMs: 150000,
        maxAttempts: 5
      }
    });
    expect(updates).toEqual([
      {
        provider: "codex",
        model: "gpt-5.4",
        reasoning_effort: "xhigh",
        timeout_ms: 150000,
        max_attempts: 5
      }
    ]);
  });

  it("persists per-question worker settings when the bridge creates the question", async () => {
    const questionId = randomUUID();
    const createdQuestions: Record<string, unknown>[] = [];
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/memory/questions") {
        createdQuestions.push(await readJson(request));
        json(response, 200, { question: { id: questionId } });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        json(response, 200, { questions: [] });
        return;
      }
      if (
        request.method === "GET" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        json(response, 200, {
          question: {
            id: questionId,
            query: "What did we decide?",
            status: "pending"
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    await fetch(`${bridgeUrl}/v1/memory/answer-local`, {
      method: "POST",
      headers: {
        authorization: "Bearer cmt_test",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: "What did we decide?",
        search_domain: "global",
        local_memory_worker_config: {
          provider: "codex",
          model: "gpt-5.4",
          reasoning_effort: "xhigh",
          timeout_ms: 150000,
          max_attempts: 5
        }
      })
    });

    expect(createdQuestions).toEqual([
      expect.objectContaining({
        query: "What did we decide?",
        local_memory_worker_config: {
          provider: "codex",
          model: "gpt-5.4",
          reasoning_effort: "xhigh",
          timeout_ms: 150000,
          max_attempts: 5
        }
      })
    ]);
  });

  it("releases the question for retry when local synthesis throws", async () => {
    const questionId = randomUUID();
    const patches: Record<string, unknown>[] = [];
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      if (request.url === "/v1/memory/answer") {
        json(response, 200, { evidence: [], citations: [] });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: 1,
              query: "What did we decide?",
              retrievalScope: "personal",
              searchDomain: "global",
              status: "pending",
              localMemoryWorkerConfig: {
                provider: "codex",
                model: "gpt-5.4",
                reasoning_effort: "high",
                timeout_ms: 150000,
                max_attempts: 1
              }
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        patches.push(await readJson(request));
        json(response, 200, {
          question: {
            id: questionId,
            query: "What did we decide?",
            status: "pending",
            lastErrorMessage: "Codex unavailable"
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    answerWithMemoryWorker.mockRejectedValue(new Error("Codex unavailable"));
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const result = await postJson<{
      ok: boolean;
      error: string;
      question: { id: string };
    }>(`${bridgeUrl}/v1/memory/answer-local`, {
      question_id: questionId,
      query: "What did we decide?",
      search_domain: "global"
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Codex unavailable",
      question: { id: questionId }
    });
    expect(patches).toEqual([
      {
        status: "pending",
        attempt_count: 1,
        last_error_message: "Codex unavailable"
      }
    ]);
  });

  it("does not persist Codex fallback evidence as an answered question", async () => {
    const questionId = randomUUID();
    const patches: Record<string, unknown>[] = [];
    const largeEvidenceText = "retry evidence payload ".repeat(20_000);
    const fallbackMarkdown =
      "Evidence bundle returned for Codex synthesis, but Codex failed.";
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      if (request.url === "/v1/memory/answer") {
        json(response, 200, {
          evidence: [{ id: "evidence-1" }],
          evidenceBundle: { retrieval: { mode: "leaf_search" } },
          citations: [{ id: "citation-1" }]
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: 1,
              query: "What did we decide?",
              retrievalScope: "personal",
              searchDomain: "global",
              status: "pending"
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        const patch = await readJson(request);
        patches.push(patch);
        json(response, 200, {
          question: {
            id: questionId,
            query: "What did we decide?",
            status: "pending",
            lastErrorMessage: patch.last_error_message ?? null
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    answerWithMemoryWorker.mockResolvedValue({
      markdown: fallbackMarkdown,
      evidenceBundle: {
        evidence: [{ id: "evidence-1", summaryText: largeEvidenceText }],
        retrieval: { mode: "leaf_search" }
      },
      citations: [{ id: "citation-1" }],
      retrieval: { evidenceCount: 1 },
      localMemoryWorker: {
        provider: "codex",
        promptVersion: "test",
        model: null,
        usedFallback: true,
        skippedReason: "codex_failed"
      }
    });
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const result = await postJson<{
      ok: boolean;
      error: string;
      question: { id: string; status: string };
    }>(`${bridgeUrl}/v1/memory/answer-local`, {
      question_id: questionId,
      query: "What did we decide?",
      search_domain: "global"
    });

    expect(result).toMatchObject({
      ok: false,
      error: retryableSynthesisFailureMessage,
      question: { id: questionId, status: "pending" }
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      status: "pending",
      attempt_count: 1,
      last_error_message: retryableSynthesisFailureMessage,
      local_memory_worker: {
        usedFallback: true,
        skippedReason: "codex_failed"
      },
      retrieval: { mode: "leaf_search" }
    });
    expect(JSON.stringify(patches[0]?.response)).not.toContain(
      largeEvidenceText
    );
    expect(patches[0]?.response).not.toHaveProperty("evidenceBundle");
    expect(patches[0]?.response).not.toHaveProperty("evidence");
    expect(patches[0]?.last_error_message).not.toContain("Evidence bundle");
    expect(patches[0]).not.toHaveProperty("answer_markdown");
    expect(patches[0]).not.toHaveProperty("evidence");
    expect(patches[0]).not.toHaveProperty("citations");
  });

  it("marks retry-exhausted fallback evidence as an explicit error", async () => {
    const questionId = randomUUID();
    const patches: Record<string, unknown>[] = [];
    const largeEvidenceText = "terminal evidence payload ".repeat(20_000);
    const fallbackMarkdown =
      "Evidence bundle returned for Codex synthesis, but Codex failed.";
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      if (request.url === "/v1/memory/answer") {
        json(response, 200, {
          evidence: [{ id: "evidence-1" }],
          evidenceBundle: { retrieval: { mode: "leaf_search" } }
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: 1,
              query: "What did we decide?",
              retrievalScope: "personal",
              searchDomain: "global",
              status: "pending"
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        const patch = await readJson(request);
        patches.push(patch);
        json(response, 200, {
          question: {
            id: questionId,
            query: "What did we decide?",
            status: "error",
            errorMessage: patch.error_message ?? null
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    vi.stubEnv("MEMORY_QUESTION_ANSWER_MAX_ATTEMPTS", "1");
    answerWithMemoryWorker.mockResolvedValue({
      markdown: fallbackMarkdown,
      evidenceBundle: {
        evidence: [{ id: "evidence-1", summaryText: largeEvidenceText }],
        retrieval: { mode: "leaf_search" }
      },
      citations: [],
      retrieval: { evidenceCount: 1 },
      localMemoryWorker: {
        provider: "codex",
        promptVersion: "test",
        model: null,
        usedFallback: true,
        skippedReason: "codex_failed"
      }
    });
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const result = await postJson<{
      ok: boolean;
      error: string;
      question: { id: string; status: string; errorMessage: string };
    }>(`${bridgeUrl}/v1/memory/answer-local`, {
      question_id: questionId,
      query: "What did we decide?",
      search_domain: "global"
    });

    expect(result).toMatchObject({
      ok: false,
      error: terminalSynthesisFailureMessage,
      question: {
        id: questionId,
        status: "error",
        errorMessage: terminalSynthesisFailureMessage
      }
    });
    expect(patches[0]).toMatchObject({
      status: "error",
      attempt_count: 1,
      error_message: terminalSynthesisFailureMessage,
      local_memory_worker: {
        usedFallback: true,
        skippedReason: "codex_failed"
      }
    });
    expect(JSON.stringify(patches[0]?.response)).not.toContain(
      largeEvidenceText
    );
    expect(patches[0]?.response).not.toHaveProperty("evidenceBundle");
    expect(patches[0]?.response).not.toHaveProperty("evidence");
    expect(patches[0]?.error_message).not.toContain("Evidence bundle");
    expect(patches[0]).not.toHaveProperty("answer_markdown");
  });

  it("marks non-retryable API failures as explicit question errors", async () => {
    const questionId = randomUUID();
    const patches: Record<string, unknown>[] = [];
    answerWithMemoryWorker.mockRejectedValue(
      Object.assign(new Error("Unsupported question shape"), { status: 400 })
    );
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: 1,
              query: "What should fail permanently?",
              retrievalScope: "personal",
              searchDomain: "global",
              status: "pending"
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        patches.push(await readJson(request));
        json(response, 200, {
          question: {
            id: questionId,
            query: "What should fail permanently?",
            status: "error",
            errorMessage: "Unsupported question shape"
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const result = await postJson<{
      ok: boolean;
      question: { id: string; status: string };
    }>(`${bridgeUrl}/v1/memory/answer-local`, {
      question_id: questionId,
      query: "What should fail permanently?",
      search_domain: "global"
    });

    expect(result).toMatchObject({
      ok: false,
      question: { id: questionId, status: "error" }
    });
    expect(patches[0]).toMatchObject({
      status: "error",
      attempt_count: 1
    });
    expect(String(patches[0]?.error_message)).toContain(
      "Unsupported question shape"
    );
  });

  it("stores a deliberate no-evidence answer as final", async () => {
    const questionId = randomUUID();
    const patches: Record<string, unknown>[] = [];
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      if (request.url === "/v1/memory/answer") {
        json(response, 200, { evidence: [], citations: [] });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: 1,
              query: "What is absent?",
              retrievalScope: "personal",
              searchDomain: "global",
              status: "pending"
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        patches.push(await readJson(request));
        json(response, 200, {
          question: {
            id: questionId,
            query: "What is absent?",
            status: "answered",
            answerMarkdown: "No matching memory evidence found."
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    answerWithMemoryWorker.mockResolvedValue({
      markdown: "No matching memory evidence found.",
      evidenceBundle: { evidence: [] },
      citations: [],
      localMemoryWorker: {
        provider: "codex",
        promptVersion: "test",
        model: null,
        usedFallback: true,
        skippedReason: "no_evidence"
      }
    });
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const result = await postJson<{ ok: boolean }>(
      `${bridgeUrl}/v1/memory/answer-local`,
      {
        question_id: questionId,
        query: "What is absent?",
        search_domain: "global"
      }
    );

    expect(result).toMatchObject({ ok: true });
    expect(patches[0]).toMatchObject({
      status: "answered",
      attempt_count: 1,
      answer_markdown: "No matching memory evidence found.",
      local_memory_worker: {
        usedFallback: true,
        skippedReason: "no_evidence"
      }
    });
  });

  it("claims pending questions in the local background service", async () => {
    const questionId = randomUUID();
    const claims: Record<string, unknown>[] = [];
    const patches: Record<string, unknown>[] = [];
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/memory/answer") {
        json(response, 200, { evidence: [{ id: "evidence-1" }] });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        claims.push(await readJson(request));
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: 1,
              query: "What is pending?",
              retrievalScope: "personal",
              searchDomain: "global",
              status: "pending"
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        patches.push(await readJson(request));
        json(response, 200, {
          question: {
            id: questionId,
            query: "What is pending?",
            status: "answered",
            answerMarkdown: "Background answer"
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    vi.stubEnv("MEMORY_API_TOKEN", "cmt_test");
    answerWithMemoryWorker.mockResolvedValue({
      markdown: "Background answer",
      evidenceBundle: { evidence: [{ id: "evidence-1" }] },
      citations: [],
      localMemoryWorker: { status: "ok" }
    });
    const { MemoryApiClient, defaultConfig } = await import("../src/index.js");
    const { startPendingQuestionAnswerService } =
      await import("../src/answer-bridge.js");
    const service = startPendingQuestionAnswerService(
      new MemoryApiClient(defaultConfig()),
      {
        serviceConfig: {
          initialDelayMs: 60_000,
          intervalMs: 60_000,
          batchLimit: 1,
          leaseSeconds: 180,
          answerLimit: 10
        }
      }
    );

    const result = await service.trigger("test");
    service.stop();

    expect(result).toMatchObject({ ran: true, processed: 1 });
    expect(claims).toEqual([
      { origin: "explorer", limit: 1, lease_seconds: 180 }
    ]);
    expect(patches[0]).toMatchObject({
      status: "answered",
      attempt_count: 1,
      answer_markdown: "Background answer"
    });
  });

  it("catches up a retryable synthesis fallback on a later background run", async () => {
    const questionId = randomUUID();
    const claims: Record<string, unknown>[] = [];
    const patches: Record<string, unknown>[] = [];
    const fallbackMarkdown =
      "Memory answer worker failed before judging retrieved evidence.";
    let claimAttempt = 0;
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/memory/answer") {
        json(response, 200, { evidence: [{ id: "evidence-1" }] });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        claims.push(await readJson(request));
        claimAttempt += 1;
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: claimAttempt,
              query: "What should be retried?",
              retrievalScope: "personal",
              searchDomain: "global",
              status: "pending"
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        const patch = await readJson(request);
        patches.push(patch);
        json(response, 200, {
          question: {
            id: questionId,
            query: "What should be retried?",
            status: patch.status,
            answerMarkdown: patch.answer_markdown ?? null,
            lastErrorMessage: patch.last_error_message ?? null
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    vi.stubEnv("MEMORY_API_TOKEN", "cmt_test");
    answerWithMemoryWorker
      .mockResolvedValueOnce({
        markdown: fallbackMarkdown,
        evidenceBundle: { evidence: [{ id: "evidence-1" }] },
        citations: [],
        localMemoryWorker: {
          provider: "codex",
          promptVersion: "test",
          model: null,
          usedFallback: true,
          skippedReason: "codex_failed"
        }
      })
      .mockResolvedValueOnce({
        markdown: "Recovered answer",
        evidenceBundle: { evidence: [{ id: "evidence-1" }] },
        citations: [],
        localMemoryWorker: {
          provider: "codex",
          promptVersion: "test",
          model: "gpt-test",
          usedFallback: false
        }
      });
    const { MemoryApiClient, defaultConfig } = await import("../src/index.js");
    const { startPendingQuestionAnswerService } =
      await import("../src/answer-bridge.js");
    const service = startPendingQuestionAnswerService(
      new MemoryApiClient(defaultConfig()),
      {
        serviceConfig: {
          initialDelayMs: 60_000,
          intervalMs: 60_000,
          batchLimit: 1,
          leaseSeconds: 180,
          answerLimit: 10
        }
      }
    );

    const firstRun = await service.trigger("first");
    const secondRun = await service.trigger("second");
    service.stop();

    expect(firstRun).toMatchObject({ ran: true, processed: 1 });
    expect(secondRun).toMatchObject({ ran: true, processed: 1 });
    expect(claims).toEqual([
      { origin: "explorer", limit: 1, lease_seconds: 180 },
      { origin: "explorer", limit: 1, lease_seconds: 180 }
    ]);
    expect(patches[0]).toMatchObject({
      status: "pending",
      attempt_count: 1,
      last_error_message: retryableSynthesisFailureMessage,
      local_memory_worker: {
        usedFallback: true,
        skippedReason: "codex_failed"
      }
    });
    expect(patches[0]).not.toHaveProperty("answer_markdown");
    expect(patches[1]).toMatchObject({
      status: "answered",
      attempt_count: 2,
      answer_markdown: "Recovered answer",
      local_memory_worker: { usedFallback: false }
    });
  });

  it("uses a bounded lease for synchronous local answering", async () => {
    const questionId = randomUUID();
    const claims: Record<string, unknown>[] = [];
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, { ok: true, canWritePersonal: true });
        return;
      }
      if (request.url === "/v1/memory/answer") {
        json(response, 200, { evidence: [] });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/questions/claim-pending"
      ) {
        claims.push(await readJson(request));
        json(response, 200, {
          questions: [
            {
              id: questionId,
              attemptCount: 1,
              query: "What is slow?",
              retrievalScope: "personal",
              searchDomain: "global",
              status: "pending"
            }
          ]
        });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        json(response, 200, {
          question: {
            id: questionId,
            query: "What is slow?",
            status: "answered",
            answerMarkdown: "Slow answer"
          }
        });
        return;
      }
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    answerWithMemoryWorker.mockResolvedValue({
      markdown: "Slow answer",
      evidenceBundle: { evidence: [] },
      citations: [],
      localMemoryWorker: { status: "ok" }
    });
    const { createAnswerBridgeServer } =
      await import("../src/answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    await postJson(`${bridgeUrl}/v1/memory/answer-local`, {
      question_id: questionId,
      query: "What is slow?",
      search_domain: "global"
    });

    expect(claims).toEqual([
      { question_id: questionId, limit: 1, lease_seconds: 300 }
    ]);
  });

  it("exits successfully when standalone startup finds an existing Koed bridge", async () => {
    const server = Object.assign(new EventEmitter(), {
      listen: vi.fn(),
      close: vi.fn()
    }) as unknown as http.Server & EventEmitter;
    const exit = vi.fn();
    const log = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      level: "info",
      trace: vi.fn(),
      warn: vi.fn()
    };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        service: "koed-memory-answer-bridge",
        apiUrl: "http://localhost:3300"
      })
    })) as unknown as typeof fetch;
    const { startStandaloneAnswerBridge } =
      await import("../src/answer-bridge.js");

    startStandaloneAnswerBridge({
      createServer: () => server,
      exit,
      fetchFn,
      host: "0.0.0.0",
      installShutdownHandlers: vi.fn(),
      log: log as never,
      port: 3210
    });
    server.emit(
      "error",
      Object.assign(new Error("busy"), { code: "EADDRINUSE" })
    );
    await waitForAsyncHandlers();

    expect(server.listen).toHaveBeenCalledWith(
      3210,
      "0.0.0.0",
      expect.any(Function)
    );
    expectFetchWithAbortSignal(fetchFn, "http://127.0.0.1:3210/health");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        healthUrl: "http://127.0.0.1:3210/health",
        apiUrl: "http://localhost:3300"
      }),
      "memory answer bridge already running; using existing service"
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("fails standalone startup when the occupied port is not a Koed bridge", async () => {
    const server = Object.assign(new EventEmitter(), {
      listen: vi.fn(),
      close: vi.fn()
    }) as unknown as http.Server & EventEmitter;
    const exit = vi.fn();
    const log = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      level: "info",
      trace: vi.fn(),
      warn: vi.fn()
    };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        service: "something-else"
      })
    })) as unknown as typeof fetch;
    const { startStandaloneAnswerBridge } =
      await import("../src/answer-bridge.js");

    startStandaloneAnswerBridge({
      createServer: () => server,
      exit,
      fetchFn,
      host: "127.0.0.1",
      installShutdownHandlers: vi.fn(),
      log: log as never,
      port: 3211
    });
    server.emit(
      "error",
      Object.assign(new Error("busy"), { code: "EADDRINUSE" })
    );
    await waitForAsyncHandlers();

    expectFetchWithAbortSignal(fetchFn, "http://127.0.0.1:3211/health");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        healthUrl: "http://127.0.0.1:3211/health",
        existingService: "something-else"
      }),
      "memory answer bridge port already in use by an incompatible service"
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("bounds the existing bridge health probe with a timeout", async () => {
    const fetchFn = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal | null }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("probe timed out"));
          });
        })
    ) as unknown as typeof fetch;
    const { probeExistingAnswerBridge } =
      await import("../src/answer-bridge.js");

    const result = await probeExistingAnswerBridge(
      "127.0.0.1",
      3212,
      fetchFn,
      1
    );

    expect(result).toEqual({
      ok: false,
      healthUrl: "http://127.0.0.1:3212/health",
      error: "probe timed out"
    });
  });

  it("forwards injected shutdown options during standalone startup", async () => {
    const server = Object.assign(new EventEmitter(), {
      listen: vi.fn(),
      close: vi.fn()
    }) as unknown as http.Server & EventEmitter;
    const exit = vi.fn();
    const installShutdownHandlers = vi.fn();
    const log = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      level: "info",
      trace: vi.fn(),
      warn: vi.fn()
    };
    const { startStandaloneAnswerBridge } =
      await import("../src/answer-bridge.js");

    startStandaloneAnswerBridge({
      createServer: () => server,
      exit,
      installShutdownHandlers,
      log: log as never,
      port: 3210
    });

    expect(installShutdownHandlers).toHaveBeenCalledWith(server, {
      exit,
      log
    });
  });

  it("closes the standalone bridge cleanly on SIGINT", async () => {
    const listeners = new Map<string, () => void>();
    const processLike = {
      once: vi.fn((signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(signal, listener);
      })
    };
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback()),
      closeAllConnections: vi.fn(),
      closeIdleConnections: vi.fn()
    };
    const log = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      level: "info",
      trace: vi.fn(),
      warn: vi.fn()
    };
    const exit = vi.fn();
    const clearTimeoutFn = vi.fn();
    const setTimeoutFn = vi.fn(() => timer) as unknown as typeof setTimeout;
    const { installAnswerBridgeShutdownHandlers } =
      await import("../src/answer-bridge.js");

    installAnswerBridgeShutdownHandlers(server as unknown as http.Server, {
      clearTimeoutFn,
      exit,
      forceCloseDelayMs: 25,
      log: log as never,
      processLike,
      setTimeoutFn
    });

    listeners.get("SIGINT")?.();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    expect(clearTimeoutFn).toHaveBeenCalledWith(timer);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("forces the standalone bridge closed on a repeated shutdown signal", async () => {
    const listeners = new Map<string, () => void>();
    const processLike = {
      once: vi.fn((signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(signal, listener);
      })
    };
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const server = {
      close: vi.fn(),
      closeAllConnections: vi.fn(),
      closeIdleConnections: vi.fn()
    };
    const log = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      level: "info",
      trace: vi.fn(),
      warn: vi.fn()
    };
    const exit = vi.fn();
    const { installAnswerBridgeShutdownHandlers } =
      await import("../src/answer-bridge.js");

    installAnswerBridgeShutdownHandlers(server as unknown as http.Server, {
      exit,
      forceCloseDelayMs: 25,
      log: log as never,
      processLike,
      setTimeoutFn: vi.fn(() => timer) as unknown as typeof setTimeout
    });

    listeners.get("SIGTERM")?.();
    listeners.get("SIGTERM")?.();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });
});
