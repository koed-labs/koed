import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { watchKoedLocalWork } from "@koed/shared";
import { z } from "zod";
import { startCodexTranscriptWatcher } from "./codex-transcript-watcher.js";
import { startClaudeTranscriptWatcher } from "./claude-transcript-watcher.js";
import { startPiTranscriptWatcher } from "./pi-transcript-watcher.js";
import { startCuratedMemoryReviewService } from "./curated-memory-review-service.js";
import { resolveCuratedMemoryReviewConfig } from "./curated-memory-review-worker.js";
import {
  MemoryApiClient,
  defaultConfig,
  type McpServerConfig
} from "./index.js";
import {
  resolveLcmSummaryServiceConfig,
  startLcmSummaryService
} from "./lcm-summary-service.js";
import { resolveLcmSummaryWorkerConfig } from "./lcm-summary-worker.js";
import {
  LOCAL_AI_RUNTIME_PROTOCOL_VERSION,
  localRuntimeRegistrationPath,
  localRuntimeToolNames,
  resolveKoedHome,
  type LocalRuntimeRegistration,
  type LocalRuntimeToolName
} from "./local-runtime-protocol.js";
import { logger } from "./logger.js";
import { MemoryToolExecutor } from "./memory-tool-executor.js";

export const LOCAL_AI_RUNTIME_MAX_BODY_BYTES = 256 * 1024;
export const LOCAL_AI_RUNTIME_DEFAULT_MAX_ACTIVE_ANSWERS = 2;
export const LOCAL_AI_RUNTIME_DEFAULT_MAX_QUEUED_ANSWERS = 16;

const callerSchema = z
  .object({
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine(path.isAbsolute, "cwd must be absolute"),
    protocolVersion: z.string().max(64).optional(),
    clientInfo: z.record(z.string(), z.unknown()).optional(),
    clientCapabilities: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

const toolRequestSchema = z
  .object({
    input: z.record(z.string(), z.unknown()),
    caller: callerSchema
  })
  .strict();

const positiveInteger = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

class AdmissionGate {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxQueued: number
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Koed memory request was cancelled"));
    }
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(
        Object.assign(new Error("Koed Memory Answer queue is full"), {
          statusCode: 429
        })
      );
    }
    return new Promise((resolve, reject) => {
      const entry: (typeof this.queue)[number] = { resolve, reject, signal };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("Koed memory request was cancelled"));
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  get diagnostics() {
    return { active: this.active, queued: this.queue.length };
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.signal?.removeEventListener("abort", entry.abort!);
      if (entry.signal?.aborted) {
        entry.reject(new Error("Koed memory request was cancelled"));
        continue;
      }
      this.active += 1;
      entry.resolve(this.releaseOnce());
    }
  }
}

const readJsonBody = async (
  request: http.IncomingMessage
): Promise<unknown> => {
  const declaredLength = Number.parseInt(
    request.headers["content-length"] ?? "",
    10
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > LOCAL_AI_RUNTIME_MAX_BODY_BYTES
  ) {
    request.resume();
    throw Object.assign(new Error("Request body is too large"), {
      statusCode: 413
    });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > LOCAL_AI_RUNTIME_MAX_BODY_BYTES) {
      request.resume();
      throw Object.assign(new Error("Request body is too large"), {
        statusCode: 413
      });
    }
    chunks.push(new Uint8Array(buffer));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const json = (
  response: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void => {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(encoded.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(encoded);
};

const authorized = (header: string | undefined, expected: string): boolean => {
  if (!header) return false;
  const actualBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const writeRegistration = (
  registrationPath: string,
  registration: LocalRuntimeRegistration
): void => {
  const registrationDirectory = path.dirname(registrationPath);
  mkdirSync(registrationDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(registrationDirectory, 0o700);
  const temporary = `${registrationPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registration, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporary, registrationPath);
  if (process.platform !== "win32") chmodSync(registrationPath, 0o600);
};

const removeOwnedRegistration = (registrationPath: string): void => {
  try {
    const current = JSON.parse(readFileSync(registrationPath, "utf8")) as {
      pid?: unknown;
    };
    if (current.pid === process.pid) rmSync(registrationPath, { force: true });
  } catch {
    // Another runtime may already have replaced or removed this registration.
  }
};

export interface LocalAiRuntimeHandle {
  url: string;
  close(): Promise<void>;
}

export interface StartLocalAiRuntimeOptions {
  environment?: NodeJS.ProcessEnv;
  config?: McpServerConfig;
  host?: "127.0.0.1";
  port?: number;
  serviceFactory?: LocalAiRuntimeServiceFactory;
}

export interface LocalAiRuntimeToolExecutor {
  capabilities(): Promise<{ curatedMemoryIntakeAvailable: boolean }>;
  execute(
    name: LocalRuntimeToolName,
    input: Record<string, unknown>,
    caller: z.infer<typeof callerSchema>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>>;
}

export interface LocalAiRuntimeServices {
  executor: LocalAiRuntimeToolExecutor;
  close(): Promise<void>;
}

export type LocalAiRuntimeServiceFactory = (options: {
  apiClient: MemoryApiClient;
  environment: NodeJS.ProcessEnv;
  koedHome: string;
}) => Promise<LocalAiRuntimeServices>;

export interface LocalAiRuntimeServiceDependencies {
  startLcmSummaryService: typeof startLcmSummaryService;
  watchKoedLocalWork: typeof watchKoedLocalWork;
  startCuratedMemoryReviewService: typeof startCuratedMemoryReviewService;
  startCodexTranscriptWatcher: typeof startCodexTranscriptWatcher;
  startClaudeTranscriptWatcher: typeof startClaudeTranscriptWatcher;
  startPiTranscriptWatcher?: typeof startPiTranscriptWatcher;
  createExecutor(
    apiClient: MemoryApiClient,
    environment: NodeJS.ProcessEnv,
    services: {
      lcmSummaryService: ReturnType<typeof startLcmSummaryService>;
      curatedMemoryReviewService: ReturnType<
        typeof startCuratedMemoryReviewService
      >;
    }
  ): LocalAiRuntimeToolExecutor;
}

const defaultServiceDependencies: LocalAiRuntimeServiceDependencies = {
  startLcmSummaryService,
  watchKoedLocalWork,
  startCuratedMemoryReviewService,
  startCodexTranscriptWatcher,
  startClaudeTranscriptWatcher,
  startPiTranscriptWatcher,
  createExecutor: (apiClient, environment, services) =>
    new MemoryToolExecutor(apiClient, environment, services)
};

export const startDefaultLocalAiRuntimeServices = async (
  {
    apiClient,
    environment,
    koedHome
  }: Parameters<LocalAiRuntimeServiceFactory>[0],
  dependencies: LocalAiRuntimeServiceDependencies = defaultServiceDependencies
): Promise<LocalAiRuntimeServices> => {
  const lcmSummaryService = dependencies.startLcmSummaryService(apiClient, {
    serviceConfig: resolveLcmSummaryServiceConfig(environment),
    workerConfig: resolveLcmSummaryWorkerConfig(environment)
  });
  let lcmWorkWatcher: Awaited<ReturnType<typeof watchKoedLocalWork>> | null =
    null;
  let curatedMemoryReviewService: ReturnType<
    typeof startCuratedMemoryReviewService
  > | null = null;
  let codexTranscriptWatcher: ReturnType<
    typeof startCodexTranscriptWatcher
  > | null = null;
  let claudeTranscriptWatcher: ReturnType<
    typeof startClaudeTranscriptWatcher
  > | null = null;
  let piTranscriptWatcher: ReturnType<typeof startPiTranscriptWatcher> | null =
    null;
  try {
    lcmWorkWatcher = lcmSummaryService
      ? await dependencies.watchKoedLocalWork(
          koedHome,
          "lcm-summary",
          () => lcmSummaryService.nudge("share_bound_summary_requested"),
          (error) => logger.warn({ err: error }, "local LCM work signal failed")
        )
      : null;
    curatedMemoryReviewService = dependencies.startCuratedMemoryReviewService(
      apiClient,
      {
        workerConfig: resolveCuratedMemoryReviewConfig(environment)
      }
    );
    codexTranscriptWatcher =
      environment.MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED?.trim().toLowerCase() ===
      "false"
        ? null
        : dependencies.startCodexTranscriptWatcher(apiClient);
    claudeTranscriptWatcher =
      environment.MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED?.trim().toLowerCase() ===
      "false"
        ? null
        : dependencies.startClaudeTranscriptWatcher(apiClient, environment);
    piTranscriptWatcher =
      environment.MEMORY_PI_TRANSCRIPT_WATCHER_ENABLED?.trim().toLowerCase() ===
        "false" || !dependencies.startPiTranscriptWatcher
        ? null
        : dependencies.startPiTranscriptWatcher(apiClient, environment);
    const executor = dependencies.createExecutor(apiClient, environment, {
      lcmSummaryService,
      curatedMemoryReviewService
    });
    return {
      executor,
      async close() {
        lcmWorkWatcher?.stop();
        lcmSummaryService?.stop();
        curatedMemoryReviewService?.stop();
        await Promise.all([
          codexTranscriptWatcher?.stop(),
          claudeTranscriptWatcher?.stop(),
          piTranscriptWatcher?.stop()
        ]);
      }
    };
  } catch (error) {
    lcmWorkWatcher?.stop();
    lcmSummaryService?.stop();
    curatedMemoryReviewService?.stop();
    await Promise.all([
      codexTranscriptWatcher?.stop(),
      claudeTranscriptWatcher?.stop(),
      piTranscriptWatcher?.stop()
    ]);
    throw error;
  }
};

export const startLocalAiRuntime = async ({
  environment = process.env,
  config = defaultConfig(environment),
  host = "127.0.0.1",
  port = 0,
  serviceFactory = startDefaultLocalAiRuntimeServices
}: StartLocalAiRuntimeOptions = {}): Promise<LocalAiRuntimeHandle> => {
  const koedHome = resolveKoedHome(environment);
  const registrationPath = localRuntimeRegistrationPath(koedHome);
  const apiClient = new MemoryApiClient(config);
  const services = await serviceFactory({ apiClient, environment, koedHome });
  const executor = services.executor;
  const answerAdmission = new AdmissionGate(
    positiveInteger(
      environment.KOED_LOCAL_AI_RUNTIME_MAX_ACTIVE_ANSWERS,
      LOCAL_AI_RUNTIME_DEFAULT_MAX_ACTIVE_ANSWERS
    ),
    positiveInteger(
      environment.KOED_LOCAL_AI_RUNTIME_MAX_QUEUED_ANSWERS,
      LOCAL_AI_RUNTIME_DEFAULT_MAX_QUEUED_ANSWERS
    )
  );
  const authorization = `Bearer ${randomBytes(32).toString("base64url")}`;
  const activeRequests = new Set<AbortController>();

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!authorized(request.headers.authorization, authorization)) {
        json(response, 401, { error: "Local AI runtime authorization failed" });
        return;
      }
      const requestAbort = new AbortController();
      activeRequests.add(requestAbort);
      request.once("aborted", () => requestAbort.abort());
      response.once("close", () => {
        if (!response.writableEnded) requestAbort.abort();
      });
      try {
        const requestUrl = new URL(request.url ?? "/", `http://${host}`);
        if (request.method === "GET" && requestUrl.pathname === "/ready") {
          json(response, 200, {
            ok: true,
            protocolVersion: LOCAL_AI_RUNTIME_PROTOCOL_VERSION,
            memoryAnswers: answerAdmission.diagnostics
          });
          return;
        }
        if (
          request.method === "GET" &&
          requestUrl.pathname === "/v1/capabilities"
        ) {
          const capabilities = await executor.capabilities();
          json(response, 200, {
            protocolVersion: LOCAL_AI_RUNTIME_PROTOCOL_VERSION,
            curatedMemoryIntakeAvailable:
              capabilities.curatedMemoryIntakeAvailable
          });
          return;
        }
        const toolPrefix = "/v1/tools/";
        if (
          request.method !== "POST" ||
          !requestUrl.pathname.startsWith(toolPrefix)
        ) {
          json(response, 404, { error: "Local AI runtime route not found" });
          return;
        }
        const toolName = decodeURIComponent(
          requestUrl.pathname.slice(toolPrefix.length)
        );
        if (!localRuntimeToolNames.includes(toolName as LocalRuntimeToolName)) {
          json(response, 404, { error: "Unknown Koed memory tool" });
          return;
        }
        const parsed = toolRequestSchema.parse(await readJsonBody(request));
        const release =
          toolName === "memory_answer"
            ? await answerAdmission.acquire(requestAbort.signal)
            : () => undefined;
        try {
          const result = await executor.execute(
            toolName as LocalRuntimeToolName,
            parsed.input,
            parsed.caller,
            requestAbort.signal
          );
          if (!requestAbort.signal.aborted) json(response, 200, result);
        } finally {
          release();
        }
      } catch (error) {
        if (requestAbort.signal.aborted) return;
        const statusCode =
          error &&
          typeof error === "object" &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? 400
              : 500;
        logger.warn(
          { err: error, statusCode },
          "local AI runtime request failed"
        );
        json(response, statusCode, {
          error:
            error instanceof Error ? error.message : "Local AI runtime error"
        });
      } finally {
        activeRequests.delete(requestAbort);
      }
    })();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local AI runtime did not bind a TCP port");
    }
    const url = `http://${host}:${address.port}`;
    writeRegistration(registrationPath, {
      protocolVersion: LOCAL_AI_RUNTIME_PROTOCOL_VERSION,
      url,
      authorization,
      pid: process.pid,
      startedAt: new Date().toISOString()
    });
    logger.info({ url }, "Koed local AI runtime started");

    let closed = false;
    return {
      url,
      async close() {
        if (closed) return;
        closed = true;
        removeOwnedRegistration(registrationPath);
        for (const controller of activeRequests) {
          controller.abort(new Error("Koed local AI runtime is shutting down"));
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await services.close();
      }
    };
  } catch (error) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await services.close();
    throw error;
  }
};
