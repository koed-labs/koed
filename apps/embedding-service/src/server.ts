import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createHash } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import {
  HttpError,
  embeddingTokenAuthStatus,
  requireInternalToken
} from "./auth.js";
import {
  rerankerEnabled,
  rerankerModel,
  type EmbeddingServiceEnv
} from "./env-config.js";
import type { EmbeddingLogger } from "./logging.js";
import {
  errorType,
  event,
  parseTraceparent,
  resolveRequestId
} from "./logging.js";
import { normalizeEmbeddingPriority } from "./priority-scheduler.js";
import type { EmbeddingRuntime } from "./runtime.js";
import type { ResolvedAcceleration } from "./acceleration.js";
import { validateEmbedRequest, validateRerankRequest } from "./schemas.js";

export interface EmbeddingService {
  handle(request: Request): Promise<Response>;
}

const elapsedMs = (started: bigint): number =>
  Number((process.hrtime.bigint() - started) / 1_000_000n);

const jsonResponse = (
  body: unknown,
  status: number,
  requestId: string
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId
    }
  });

const headerValue = (request: Request, name: string): string | null =>
  request.headers.get(name);

const parseJsonBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (!text.trim()) {
    throw new HttpError(422, "request body must be JSON");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(422, "request body must be valid JSON");
  }
};

export const createEmbeddingService = (
  config: EmbeddingServiceEnv,
  runtime: EmbeddingRuntime,
  logger: EmbeddingLogger
): EmbeddingService => ({
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = resolveRequestId(headerValue(request, "x-request-id"));
    const trace = parseTraceparent(headerValue(request, "traceparent"));
    const started = process.hrtime.bigint();
    const response = await logger.withRequestContext(
      {
        request: {
          id: requestId,
          method: request.method,
          path: url.pathname
        },
        ...(trace ? { trace } : {})
      },
      async () => {
        try {
          if (request.method === "GET" && url.pathname === "/health") {
            return handleHealth(config, runtime, request, requestId);
          }
          if (
            request.method === "GET" &&
            url.pathname === "/capacity/identity"
          ) {
            return await handleCapacityIdentity(
              config,
              runtime,
              request,
              requestId
            );
          }
          if (request.method === "POST" && url.pathname === "/embed") {
            return await handleEmbed(
              config,
              runtime,
              logger,
              request,
              requestId,
              started
            );
          }
          if (request.method === "POST" && url.pathname === "/rerank") {
            return await handleRerank(
              config,
              runtime,
              logger,
              request,
              requestId,
              started
            );
          }
          return jsonResponse({ detail: "not found" }, 404, requestId);
        } catch (error) {
          if (error instanceof HttpError) {
            return jsonResponse(
              {
                detail: error.detail,
                ...(error.code ? { code: error.code } : {})
              },
              error.statusCode,
              requestId
            );
          }
          return jsonResponse(
            {
              detail: "embedding service request failed",
              code: "embedding_service_error"
            },
            500,
            requestId
          );
        }
      }
    );
    logger.debug("http request completed", {
      event: event("embedding.http.request_completed"),
      request: {
        id: requestId,
        method: request.method,
        path: url.pathname
      },
      http: {
        status_code: response.status,
        duration_ms: elapsedMs(started)
      }
    });
    return response;
  }
});

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const capacityHardwareIdentity = async (
  acceleration: ResolvedAcceleration
): Promise<{
  hardwareFingerprint: string;
  acceleratorFingerprint: string | null;
}> => {
  const listing = acceleration.deviceListing;
  if (acceleration.backend !== "cpu" && !listing) {
    throw new HttpError(503, "embedding accelerator identity is unavailable");
  }
  const acceleratorFingerprint = listing
    ? stableHash({ backendClass: acceleration.backend, listing })
    : null;
  return {
    acceleratorFingerprint,
    hardwareFingerprint: stableHash({
      platform: platform(),
      release: release(),
      arch: arch(),
      cpuModels: cpus()
        .map((cpu) => cpu.model)
        .sort(),
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      backendClass: acceleration.backend,
      acceleratorFingerprint
    })
  };
};

const handleCapacityIdentity = async (
  config: EmbeddingServiceEnv,
  runtime: EmbeddingRuntime,
  request: Request,
  requestId: string
): Promise<Response> => {
  requireInternalToken(config, headerValue(request, "x-koed-embedding-token"));
  const acceleration = runtime.embeddingAcceleration();
  if (!acceleration) {
    throw new HttpError(503, "embedding runtime identity is unavailable");
  }
  const hardwareIdentity = await capacityHardwareIdentity(acceleration);
  const runtimeSettings = {
    batchLimit: config.batchLimit,
    embeddingMaxTokens: config.embeddingMaxTokens,
    llamaNCtx: config.llamaNCtx,
    llamaNThreads: config.llamaNThreads,
    llamaNBatch: config.llamaNBatch,
    llamaNUbatch: config.llamaNUbatch,
    llamaParallel: config.llamaParallel,
    accelerationBackend: acceleration.backend,
    accelerationDeviceFingerprint: acceleration.device
      ? stableHash(acceleration.device)
      : null,
    gpuLayers: acceleration.gpuLayers,
    gpuIdleUnloadSeconds:
      acceleration.backend === "cpu"
        ? 0
        : runtime.config.embeddingGpuIdleUnloadSeconds
  };
  return jsonResponse(
    {
      schemaVersion: 1,
      modelKey: config.modelKey,
      dimensions: config.expectedDimensions,
      runtimeKind: "llama-server",
      runtimeVersion: config.runtimeVersion,
      backendClass: acceleration.backend,
      ...hardwareIdentity,
      settingsFingerprint: stableHash(runtimeSettings),
      runtimeSettings
    },
    200,
    requestId
  );
};

const handleHealth = (
  config: EmbeddingServiceEnv,
  runtime: EmbeddingRuntime,
  request: Request,
  requestId: string
): Response => {
  const auth = embeddingTokenAuthStatus(
    config,
    headerValue(request, "x-koed-embedding-token")
  );
  const rerankerReady = !rerankerEnabled(config) || runtime.isRerankerLoaded();
  const status = runtime.isModelLoaded() && rerankerReady ? "ok" : "loading";
  const rerankerProvenance = runtime.rerankerProvenance();
  const embeddingAcceleration = runtime.embeddingAcceleration();
  const exposeConfiguredArtifacts = auth.authRequired && auth.authValid;
  return jsonResponse(
    {
      status,
      modelKey: config.modelKey,
      model: config.modelName,
      dimensions: config.expectedDimensions,
      normalized: true,
      batchLimit: config.batchLimit,
      maxTokens: config.embeddingMaxTokens,
      maxTextChars: config.embeddingMaxTextChars,
      maxRequestChars: config.embeddingMaxRequestChars,
      authRequired: auth.authRequired,
      authValid: auth.authValid,
      modelRepo: config.modelRepo,
      modelFile: config.modelFile,
      artifact: exposeConfiguredArtifacts
        ? config.modelArtifact
        : `sha256:${config.modelArtifactSha256}`,
      artifactRevision: config.modelArtifactRevision,
      artifactHash: config.modelArtifactSha256,
      tokenizer: config.modelTokenizer,
      tokenizerRevision: config.modelTokenizerRevision,
      acceleration: runtime.modelAcceleration(),
      ...(exposeConfiguredArtifacts && embeddingAcceleration?.fallbackReason
        ? {
            accelerationFallback: {
              policy: embeddingAcceleration.policy,
              reason: embeddingAcceleration.fallbackReason
            }
          }
        : {}),
      nCtx: config.llamaNCtx,
      queue: runtime.healthQueueSnapshot(),
      ...(exposeConfiguredArtifacts
        ? {
            gpuIdleUnloadSeconds:
              embeddingAcceleration?.backend === "cpu"
                ? 0
                : runtime.config.embeddingGpuIdleUnloadSeconds
          }
        : {}),
      reranker: {
        enabled: rerankerEnabled(config),
        loaded: runtime.isRerankerLoaded(),
        modelKey: config.rerankerKey,
        model: rerankerModel(config),
        artifact: rerankerProvenance
          ? exposeConfiguredArtifacts
            ? rerankerProvenance.artifact
            : `sha256:${rerankerProvenance.artifactHash}`
          : null,
        artifactRevision: rerankerProvenance?.artifactRevision ?? null,
        artifactHash: rerankerProvenance?.artifactHash ?? null,
        batchLimit: config.rerankerBatchLimit,
        acceleration: runtime.rerankerAcceleration()
          ? runtime.rerankerAcceleration()!.backend
          : null,
        ...(exposeConfiguredArtifacts && runtime.rerankerAcceleration()
          ? {
              gpuIdleUnloadSeconds:
                runtime.rerankerAcceleration()!.backend === "cpu"
                  ? 0
                  : runtime.config.rerankerGpuIdleUnloadSeconds
            }
          : {})
      }
    },
    status === "ok" ? 200 : 503,
    requestId
  );
};

const handleEmbed = async (
  config: EmbeddingServiceEnv,
  runtime: EmbeddingRuntime,
  logger: EmbeddingLogger,
  request: Request,
  requestId: string,
  started: bigint
): Promise<Response> => {
  requireInternalToken(config, headerValue(request, "x-koed-embedding-token"));
  const payload = validateEmbedRequest(config, await parseJsonBody(request));
  try {
    const result = await runtime.embedText(
      payload.texts,
      headerValue(request, "x-koed-embedding-priority")
    );
    logger.info("embedding request completed", {
      event: event("embedding.embed.completed"),
      http: { status_code: 200, duration_ms: elapsedMs(started) },
      priority: normalizeEmbeddingPriority(
        headerValue(request, "x-koed-embedding-priority")
      ),
      embedding: {
        model: result.model,
        dimensions: result.dimensions,
        input_count: payload.texts.length,
        chunk_count: result.chunks.length,
        vector_count: result.vectors.length,
        measured_tokens: result.measuredTokens
      }
    });
    return jsonResponse(result, 200, requestId);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    logger.info("embedding request failed", {
      event: event("embedding.embed.failed"),
      http: { status_code: statusCode, duration_ms: elapsedMs(started) },
      error: errorType(error)
    });
    throw new HttpError(
      error instanceof HttpError && error.statusCode === 503 ? 503 : 500,
      error instanceof HttpError && error.statusCode === 503
        ? "embedding service is temporarily unavailable"
        : "embedding request failed",
      error instanceof HttpError && error.statusCode === 503
        ? "embedding_unavailable"
        : "embedding_runtime_error"
    );
  }
};

const handleRerank = async (
  config: EmbeddingServiceEnv,
  runtime: EmbeddingRuntime,
  logger: EmbeddingLogger,
  request: Request,
  requestId: string,
  started: bigint
): Promise<Response> => {
  requireInternalToken(config, headerValue(request, "x-koed-embedding-token"));
  const payload = validateRerankRequest(config, await parseJsonBody(request));
  try {
    const result = await runtime.rerankTexts(payload.query, payload.documents);
    logger.info("rerank request completed", {
      event: event("embedding.rerank.completed"),
      http: { status_code: 200, duration_ms: elapsedMs(started) },
      reranker: {
        model: result.model,
        document_count: payload.documents.length,
        score_count: result.scores.length,
        measured_tokens: result.inputTokens,
        latency_ms: result.latencyMs,
        cost_usd: result.costUsd
      }
    });
    return jsonResponse(result, 200, requestId);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    logger.info("rerank request failed", {
      event: event("embedding.rerank.failed"),
      http: { status_code: statusCode, duration_ms: elapsedMs(started) },
      error: errorType(error)
    });
    throw new HttpError(
      error instanceof HttpError && error.statusCode === 503 ? 503 : 500,
      error instanceof HttpError && error.statusCode === 503
        ? "reranking service is temporarily unavailable"
        : "reranking request failed",
      error instanceof HttpError && error.statusCode === 503
        ? "reranking_unavailable"
        : "reranking_runtime_error"
    );
  }
};

const incomingRequestUrl = (request: IncomingMessage): string =>
  `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`;

const incomingRequestBody = async (
  request: IncomingMessage
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export const createNodeHttpServer = (service: EmbeddingService) =>
  createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      const body =
        incoming.method === "GET" || incoming.method === "HEAD"
          ? undefined
          : await incomingRequestBody(incoming);
      const request = new Request(incomingRequestUrl(incoming), {
        method: incoming.method,
        headers: incoming.headers as HeadersInit,
        body: body ? new Uint8Array(body) : undefined
      });
      const response = await service.handle(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      const responseBody = Buffer.from(await response.arrayBuffer());
      outgoing.end(responseBody);
    })().catch(() => {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(
        JSON.stringify({
          detail: "embedding service request failed",
          code: "embedding_service_error"
        })
      );
    });
  });

export const listenNodeHttpServer = (
  server: Server,
  host: string,
  port: number
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error);
    }
  });
