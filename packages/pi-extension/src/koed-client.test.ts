import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { KoedApiClient } from "./koed-client.js";

const servers: http.Server[] = [];

const createApi = async (handler: http.RequestListener): Promise<string> => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

describe("KoedApiClient LCM helpers", () => {
  it("sends worker-bound pending and submit requests", async () => {
    const apiUrl = await createApi((request, response) => {
      response.setHeader("content-type", "application/json");
      if (
        request.method === "GET" &&
        request.url === "/v1/memory/lcm/summaries/pending?limit=2&workerId=worker-1"
      ) {
        expect(request.headers.authorization).toBe("Bearer cmt_test");
        response.end(JSON.stringify({ nodes: [] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/memory/lcm/summaries/node-1") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          expect(JSON.parse(body)).toEqual({
            workerId: "worker-1",
            summaryText: "summary"
          });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });

    const client = new KoedApiClient({ apiUrl, apiToken: "cmt_test" });

    await expect(
      client.listPendingLcmSummaries({ limit: 2, workerId: "worker-1" })
    ).resolves.toEqual({ nodes: [] });
    await expect(
      client.submitLcmSummary("node-1", {
        workerId: "worker-1",
        summaryText: "summary"
      })
    ).resolves.toEqual({ ok: true });
  });
});
