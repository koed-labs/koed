import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { assertLoopbackUrl } from "./isolation.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_TEXTS = 128;

export interface DeterministicEmbeddingServiceHandle {
  url: string;
  token: string;
  model: string;
  dimensions: number;
  metrics(): { calls: number; texts: number; measuredTokens: number };
  close(): Promise<void>;
}

const tokens = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}_./:-]+/gu) ?? [];

export const deterministicEmbeddingVector = (
  text: string,
  dimensions: number
): number[] => {
  if (!Number.isSafeInteger(dimensions) || dimensions < 8) {
    throw new Error("Deterministic embedding dimensions must be at least 8");
  }
  const vector = Array<number>(dimensions).fill(0);
  for (const token of tokens(text)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    vector[index] = (vector[index] ?? 0) + (digest[4]! & 1 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  if (norm === 0) vector[0] = 1;
  else
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = (vector[index] ?? 0) / norm;
    }
  return vector;
};

const readBody = async (request: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

export const startDeterministicEmbeddingService = async ({
  token,
  model,
  dimensions
}: {
  token: string;
  model: string;
  dimensions: number;
}): Promise<DeterministicEmbeddingServiceHandle> => {
  if (!token || /[\r\n]/u.test(token))
    throw new Error("Deterministic embedding token is invalid");
  if (!model || /[\r\n]/u.test(model))
    throw new Error("Deterministic embedding model is invalid");
  deterministicEmbeddingVector("readiness", dimensions);
  let calls = 0;
  let textCount = 0;
  let measuredTokens = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const json = (status: number, body: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "GET" && request.url === "/health") {
        json(200, { status: "ok", model, dimensions });
        return;
      }
      if (request.method !== "POST" || request.url !== "/embed") {
        json(404, { detail: "not found" });
        return;
      }
      if (request.headers["x-koed-embedding-token"] !== token) {
        json(401, { detail: "invalid embedding token" });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        json(400, { detail: "invalid embedding request" });
        return;
      }
      const texts =
        payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { texts?: unknown }).texts)
          ? (payload as { texts: unknown[] }).texts
          : null;
      if (
        !texts ||
        texts.length < 1 ||
        texts.length > MAX_TEXTS ||
        !texts.every(
          (value) =>
            typeof value === "string" && Buffer.byteLength(value) <= 256 * 1024
        )
      ) {
        json(400, { detail: "invalid embedding texts" });
        return;
      }
      const validatedTexts = texts as string[];
      const counted = validatedTexts.reduce(
        (sum, text) => sum + tokens(text).length,
        0
      );
      calls += 1;
      textCount += validatedTexts.length;
      measuredTokens += counted;
      json(200, {
        model,
        dimensions,
        vectors: validatedTexts.map((text) =>
          deterministicEmbeddingVector(text, dimensions)
        ),
        measuredTokens: counted
      });
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Deterministic embedding service did not bind TCP");
  }
  const url = `http://127.0.0.1:${address.port}`;
  assertLoopbackUrl(url, "Deterministic embedding service");
  let closed: Promise<void> | undefined;
  return {
    url,
    token,
    model,
    dimensions,
    metrics: () => ({ calls, texts: textCount, measuredTokens }),
    close() {
      closed ??= closeServer(server);
      return closed;
    }
  };
};
