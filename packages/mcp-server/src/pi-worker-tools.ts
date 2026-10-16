import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AiClientRunConfig } from "./ai-client-runner.js";

/** Private per-worker bridge. Retrieval authority remains in the owning runtime. */
export const startPiWorkerTools = async (config: AiClientRunConfig) => {
  const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
  const tools = (config.dynamicTools ?? []).map((tool) => ({
    ...tool,
    wireName: [tool.namespace, tool.name].filter(Boolean).join("_")
  }));
  const handleRequest = async (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse
  ) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(authorization);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      send(401, { error: "Unauthorized worker request" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/tool") {
      send(404, { error: "Unsupported worker request" });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > 4 * 1024 * 1024) {
          send(413, { error: "Worker request exceeds limit" });
          return;
        }
        chunks.push(bytes);
      }
      config.signal?.throwIfAborted();
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        name?: string;
        value?: unknown;
      };
      if (input.name === "koed_structured_result") {
        // Validation runs before the extension acknowledges or terminates.
        config.validateOutput?.(input.value);
        send(200, { value: input.value });
        return;
      }
      const tool = tools.find((item) => item.wireName === input.name);
      if (!tool || !config.dynamicToolHandler) {
        send(404, { error: "Unsupported worker tool" });
        return;
      }
      const result = await config.dynamicToolHandler({
        threadId: "pi-worker",
        turnId: "pi-worker",
        callId: randomBytes(16).toString("hex"),
        namespace: tool.namespace,
        tool: tool.name,
        arguments: input.value
      });
      send(200, result);
    } catch (error) {
      // Returned only to this authorized worker, never exposed as diagnostics.
      send(422, {
        error:
          error instanceof Error
            ? error.message.slice(0, 4000)
            : "Worker tool validation failed"
      });
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Pi worker bridge did not bind");
  return {
    tools,
    url: `http://127.0.0.1:${address.port}/tool`,
    authorization,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
};
