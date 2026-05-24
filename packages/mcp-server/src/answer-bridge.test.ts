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
    const apiUrl = await createServer(async (request, response) => {
      if (request.url === "/v1/access/check") {
        json(response, 200, {
          ok: true,
          canWritePersonal: true,
          canWriteTeam: false
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
      json(response, 404, { error: "not found" });
    });
    vi.stubEnv("MEMORY_API_URL", apiUrl);
    answerWithMemoryWorker.mockResolvedValue({
      markdown: "The answer",
      evidenceBundle: { evidence: [{ id: "evidence-1" }] },
      citations: [{ id: "citation-1" }],
      localMemoryWorker: { status: "ok" }
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

  it("patches the question to error when local synthesis fails", async () => {
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
            status: "error",
            errorMessage: "Codex unavailable"
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
        status: "error",
        attempt_count: 1,
        error_message: "Codex unavailable"
      }
    ]);
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

  it("uses a longer lease for synchronous local answering", async () => {
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
      { question_id: questionId, limit: 1, lease_seconds: 3600 }
    ]);
  });
});
