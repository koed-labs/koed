import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { dirname } from "node:path";
import type { WriteStream } from "node:fs";
import type { EmbeddingServiceEnv } from "./env-config.js";
import { extractEmbeddingVectors, normalizeVectors } from "./vectors.js";
import type { EmbeddingLogger } from "./logging.js";
import { errorType, event } from "./logging.js";

export interface TokenPiece {
  tokenId: number;
  text: string;
}

export interface LlamaRerankResult {
  scores: number[];
  measuredTokens: number | null;
}

export interface LlamaServerOptions {
  name: "embedding" | "reranker";
  modelPath: string;
  port: number;
  pooling: "last" | "rank";
  embedding: boolean;
  reranking: boolean;
  nCtx: number;
  nThreads: number;
  nBatch: number;
  nUbatch: number;
  parallel: number;
  promptCacheEnabled: boolean;
}

export class LlamaServerError extends Error {}

type FetchLike = typeof fetch;
type SpawnLike = typeof spawn;
const llamaServerShutdownGraceMs = 2_000;

const waitForChildExit = (
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
};

export const llamaServerEnvironment = (
  llamaServerBinary: string,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const llamaDir = dirname(llamaServerBinary);
  const existing = environment.LD_LIBRARY_PATH?.trim();
  return {
    ...environment,
    LLAMA_ARG_UI: "false",
    LD_LIBRARY_PATH: existing ? `${llamaDir}:${existing}` : llamaDir
  };
};

export const llamaServerArgs = (options: LlamaServerOptions): string[] => {
  const args = [
    "--model",
    options.modelPath,
    "--ctx-size",
    String(options.nCtx),
    "--threads",
    String(options.nThreads),
    "--threads-batch",
    String(options.nThreads),
    "--batch-size",
    String(options.nBatch),
    "--ubatch-size",
    String(options.nUbatch),
    "--parallel",
    String(options.parallel),
    "--poll",
    "0",
    "--poll-batch",
    "0",
    "--n-gpu-layers",
    "0",
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--pooling",
    options.pooling,
    "--log-disable"
  ];
  if (!options.promptCacheEnabled) {
    args.push("--no-cache-prompt", "--cache-ram", "0");
  }
  if (options.embedding) {
    args.push("--embedding");
  }
  if (options.reranking) {
    args.push("--reranking");
  }
  return args;
};

export const tokenPieceText = (piece: unknown): string => {
  if (typeof piece === "string") {
    return piece;
  }
  if (
    Array.isArray(piece) &&
    piece.every((value) => Number.isInteger(value) && value >= 0)
  ) {
    return Buffer.from(piece).toString("utf8");
  }
  return String(piece);
};

export const extractRerankScores = (
  response: Record<string, unknown>,
  documentCount: number
): number[] => {
  if (
    Array.isArray(response.scores) &&
    response.scores.length === documentCount
  ) {
    return response.scores.map(Number);
  }

  const ranked = Array.isArray(response.results)
    ? response.results
    : Array.isArray(response.data)
      ? response.data
      : null;
  if (!ranked) {
    throw new LlamaServerError("llama-server returned invalid rerank payload");
  }

  const scoresByIndex = new Map<number, number>();
  ranked.forEach((item, fallbackIndex) => {
    if (typeof item !== "object" || item === null) {
      return;
    }
    const record = item as Record<string, unknown>;
    const index =
      typeof record.index === "number" && Number.isInteger(record.index)
        ? record.index
        : fallbackIndex;
    const score =
      typeof record.relevance_score === "number"
        ? record.relevance_score
        : typeof record.score === "number"
          ? record.score
          : null;
    if (score !== null) {
      scoresByIndex.set(index, score);
    }
  });

  if (scoresByIndex.size !== documentCount) {
    throw new LlamaServerError(
      "llama-server returned incomplete rerank scores"
    );
  }
  return Array.from({ length: documentCount }, (_, index) => {
    const score = scoresByIndex.get(index);
    if (score === undefined) {
      throw new LlamaServerError(
        "llama-server returned incomplete rerank scores"
      );
    }
    return score;
  });
};

export class LlamaServerClient {
  readonly baseUrl: string;
  readonly logPath: string;
  private process: ChildProcess | null = null;
  private logFile: WriteStream | null = null;

  constructor(
    private readonly config: Pick<
      EmbeddingServiceEnv,
      | "llamaServerBinary"
      | "llamaServerStartupTimeoutSeconds"
      | "modelName"
      | "rerankerKey"
    >,
    private readonly logger: EmbeddingLogger,
    private readonly options: LlamaServerOptions,
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly spawner: SpawnLike = spawn
  ) {
    this.baseUrl = `http://127.0.0.1:${options.port}`;
    this.logPath = `/tmp/koed-${options.name}-llama-server.log`;
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    const args = llamaServerArgs(this.options);

    this.logger.info("llama-server process starting", {
      event: event("embedding.llama_server.starting"),
      llama_server: {
        name: this.options.name,
        model_path: this.options.modelPath,
        port: this.options.port,
        pooling: this.options.pooling,
        embedding: this.options.embedding,
        reranking: this.options.reranking,
        n_ctx: this.options.nCtx,
        n_batch: this.options.nBatch,
        n_ubatch: this.options.nUbatch,
        parallel: this.options.parallel,
        threads: this.options.nThreads,
        poll: 0,
        poll_batch: 0,
        prompt_cache_enabled: this.options.promptCacheEnabled
      }
    });

    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      this.logFile = createWriteStream(this.logPath, {
        flags: "a",
        encoding: "utf8"
      });
      this.logFile.write(
        `\n--- starting ${this.options.name} llama-server ---\n`
      );
      const child = this.spawner(this.config.llamaServerBinary, args, {
        env: llamaServerEnvironment(this.config.llamaServerBinary),
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.process = child;
      child.stdout?.pipe(this.logFile, { end: false });
      child.stderr?.pipe(this.logFile, { end: false });
      await this.waitReady(this.config.llamaServerStartupTimeoutSeconds);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  async waitReady(timeoutSeconds: number): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      if (this.process !== null && this.process.exitCode !== null) {
        throw new LlamaServerError(
          `${this.options.name} llama-server exited during startup: ${this.readLogTail()}`
        );
      }
      try {
        await this.get("/health", 2000);
        this.logger.info("llama-server process ready", {
          event: event("embedding.llama_server.ready"),
          llama_server: { name: this.options.name, port: this.options.port }
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new LlamaServerError(
      `${this.options.name} llama-server did not become ready: ${lastError}; ${this.readLogTail()}`
    );
  }

  async stop(): Promise<void> {
    if (this.process === null) {
      return;
    }
    const child = this.process;
    this.process = null;
    this.logFile?.end();
    this.logFile = null;
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const exited = await waitForChildExit(child, llamaServerShutdownGraceMs);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(child, llamaServerShutdownGraceMs);
      }
    }
  }

  async get(path: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return this.openJson(
      path,
      {
        method: "GET"
      },
      timeoutMs
    );
  }

  async post(
    path: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    return this.openJson(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      },
      timeoutMs
    );
  }

  async tokenize(text: string): Promise<TokenPiece[]> {
    const response = await this.post(
      "/tokenize",
      {
        content: text,
        add_special: false,
        parse_special: true,
        with_pieces: true
      },
      60000
    );
    if (!Array.isArray(response.tokens)) {
      throw new LlamaServerError(
        "llama-server returned invalid tokenization payload"
      );
    }
    return response.tokens.map((token, index) => {
      if (typeof token !== "object" || token === null) {
        throw new LlamaServerError(
          "llama-server returned token ids without pieces"
        );
      }
      const record = token as Record<string, unknown>;
      return {
        tokenId:
          typeof record.id === "number" && Number.isInteger(record.id)
            ? record.id
            : index,
        text: tokenPieceText(record.piece)
      };
    });
  }

  async detokenize(tokenIds: number[]): Promise<string> {
    const response = await this.post(
      "/detokenize",
      { tokens: tokenIds },
      60000
    );
    if (typeof response.content === "string") {
      return response.content;
    }
    if (typeof response.text === "string") {
      return response.text;
    }
    throw new LlamaServerError(
      "llama-server returned invalid detokenization payload"
    );
  }

  async embed(texts: string[]): Promise<{
    vectors: number[][];
    measuredTokens: number | null;
  }> {
    const response = await this.post(
      "/v1/embeddings",
      { model: this.config.modelName, input: texts },
      600000
    );
    const usage =
      typeof response.usage === "object" && response.usage !== null
        ? (response.usage as Record<string, unknown>)
        : null;
    return {
      vectors: normalizeVectors(extractEmbeddingVectors(response)),
      measuredTokens:
        typeof usage?.prompt_tokens === "number"
          ? Math.trunc(usage.prompt_tokens)
          : null
    };
  }

  async rerank(query: string, documents: string[]): Promise<LlamaRerankResult> {
    const response = await this.post(
      "/v1/rerank",
      {
        model:
          this.options.name === "reranker"
            ? (this.config.rerankerKey ?? "reranker")
            : this.config.modelName,
        query,
        documents,
        top_n: documents.length
      },
      600000
    );
    const usage =
      typeof response.usage === "object" && response.usage !== null
        ? (response.usage as Record<string, unknown>)
        : null;
    return {
      scores: extractRerankScores(response, documents.length),
      measuredTokens:
        typeof usage?.prompt_tokens === "number" &&
        Number.isFinite(usage.prompt_tokens) &&
        usage.prompt_tokens >= 0
          ? Math.trunc(usage.prompt_tokens)
          : null
    };
  }

  private async openJson(
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new LlamaServerError(
          `${this.options.name} llama-server HTTP ${response.status}: ${text.slice(
            0,
            500
          )}`
        );
      }
      const payload = JSON.parse(text) as unknown;
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new LlamaServerError(
          `${this.options.name} llama-server returned a non-object payload`
        );
      }
      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof LlamaServerError) {
        throw error;
      }
      this.logger.debug("llama-server request failed", {
        event: event("embedding.llama_server.request_failed"),
        llama_server: { name: this.options.name, path },
        error: errorType(error)
      });
      throw new LlamaServerError(
        `${this.options.name} llama-server request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private readLogTail(): string {
    if (!existsSync(this.logPath)) {
      return "llama-server log file was not created";
    }
    const buffer = readFileSync(this.logPath);
    return buffer.subarray(Math.max(0, buffer.length - 4096)).toString("utf8");
  }
}
