import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const answerWithMemoryWorker = vi.fn();

vi.mock("./answer-worker.js", () => ({
  answerWithMemoryWorker
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

const json = (
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>
) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
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
              workspaceId: "project-1",
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
      evidenceBundle: { evidence: [{ id: "evidence-1" }] },
      citations: [{ id: "citation-1" }],
      localMemoryWorker: {
        status: "ok",
        appServerThreadId: "thread-question-test",
        appServerTurnId: "turn-question-test",
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
                modelContextWindow: 32000,
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
        tokenUsage: {
          modelContextWindow: 32000,
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
    const { createAnswerBridgeServer } = await import("./answer-bridge.js");
    const bridgeUrl = await listenServer(createAnswerBridgeServer());

    const result = await postJson<{ ok: boolean; question: { id: string } }>(
      `${bridgeUrl}/v1/memory/answer-local`,
      {
        question_id: questionId,
        query: "What did we decide?",
        search_domain: "project",
        workspace_id: "project-1"
      }
    );

    expect(result).toMatchObject({ ok: true, question: { id: questionId } });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      status: "answered",
      attempt_count: 1,
      answer_markdown: "The answer",
      local_memory_worker: { status: "ok" }
    });
    expect(
      (patches[0]?.local_memory_worker as { appServerEvents?: unknown })
        .appServerEvents
    ).toBeUndefined();
    expect(
      (
        (
          patches[0]?.response as {
            localMemoryWorker?: { appServerEvents?: unknown };
          }
        ).localMemoryWorker ?? {}
      ).appServerEvents
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
      questionId
    });
    expect(tokenUsageRequests).toEqual([
      expect.objectContaining({
        workflowType: "memory_question",
        workflowId: questionId,
        conversationItemId: tokenConversationItemId,
        idempotencyKey: `token:${tokenConversationItemId}:last`
      })
    ]);
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
    const { createAnswerBridgeServer } = await import("./answer-bridge.js");
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
    const { createAnswerBridgeServer } = await import("./answer-bridge.js");
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
        evidence: [{ id: "evidence-1" }],
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
    const { createAnswerBridgeServer } = await import("./answer-bridge.js");
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
    expect(patches[0]?.last_error_message).not.toContain("Evidence bundle");
    expect(patches[0]).not.toHaveProperty("answer_markdown");
    expect(patches[0]).not.toHaveProperty("evidence");
    expect(patches[0]).not.toHaveProperty("citations");
  });

  it("marks retry-exhausted fallback evidence as an explicit error", async () => {
    const questionId = randomUUID();
    const patches: Record<string, unknown>[] = [];
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
        evidence: [{ id: "evidence-1" }],
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
    const { createAnswerBridgeServer } = await import("./answer-bridge.js");
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
    const { createAnswerBridgeServer } = await import("./answer-bridge.js");
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
    const { createAnswerBridgeServer } = await import("./answer-bridge.js");
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
    const { MemoryApiClient, defaultConfig } = await import("./index.js");
    const { startPendingQuestionAnswerService } =
      await import("./answer-bridge.js");
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
    expect(claims).toEqual([{ limit: 1, lease_seconds: 180 }]);
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
    const { MemoryApiClient, defaultConfig } = await import("./index.js");
    const { startPendingQuestionAnswerService } =
      await import("./answer-bridge.js");
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
      { limit: 1, lease_seconds: 180 },
      { limit: 1, lease_seconds: 180 }
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
    const { createAnswerBridgeServer } = await import("./answer-bridge.js");
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
});
