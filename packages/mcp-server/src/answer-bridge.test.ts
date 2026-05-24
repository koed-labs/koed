import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const answerWithMemoryWorker = vi.fn();

vi.mock("./answer-worker.js", () => ({
  answerWithMemoryWorker
}));

const servers: http.Server[] = [];

const createServer = async (handler: http.RequestListener): Promise<string> => {
  return listenServer(http.createServer(handler));
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
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        patches.push(await readJson(request));
        json(response, 200, {
          question: {
            id: questionId,
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
      answer_markdown: "The answer",
      local_memory_worker: { status: "ok" }
    });
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
        request.method === "PATCH" &&
        request.url === `/v1/memory/questions/${questionId}`
      ) {
        patches.push(await readJson(request));
        json(response, 200, {
          question: {
            id: questionId,
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
        error_message: "Codex unavailable"
      }
    ]);
  });
});
