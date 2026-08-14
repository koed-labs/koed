import { performance } from "node:perf_hooks";
import { HttpError } from "./auth.js";
import {
  rerankerEnabled,
  rerankerModel,
  verifyRerankerModelArtifact,
  type EmbeddingServiceEnv
} from "./env-config.js";
import {
  LlamaServerClient,
  type LlamaRerankResult,
  type TokenPiece,
  type LlamaServerOptions
} from "./llama-server.js";
import type { EmbeddingLogger } from "./logging.js";
import { errorType, event } from "./logging.js";
import {
  EmbeddingPriorityScheduler,
  normalizeEmbeddingPriority
} from "./priority-scheduler.js";
import type {
  EmbeddedChunk,
  EmbedResponse,
  RerankResponse
} from "./schemas.js";

export interface ChunkCandidate {
  inputIndex: number;
  chunkIndex: number;
  chunkCount: number;
  text: string;
  tokenCount: number;
}

export interface LlamaEmbeddingClient {
  isRunning(): boolean;
  stop(): Promise<void>;
  tokenize(text: string): Promise<TokenPiece[]>;
  detokenize(tokenIds: number[]): Promise<string>;
  embed(texts: string[]): Promise<{
    vectors: number[][];
    measuredTokens: number | null;
  }>;
  rerank(query: string, documents: string[]): Promise<LlamaRerankResult>;
}

export class EmbeddingRuntime {
  readonly scheduler = new EmbeddingPriorityScheduler();
  embeddingServer: LlamaEmbeddingClient | null = null;
  rerankerServer: LlamaEmbeddingClient | null = null;
  private embeddingLoadPromise: Promise<void> | null = null;
  private rerankerLoadPromise: Promise<void> | null = null;
  private loadedRerankerArtifactSha256: string | null = null;

  constructor(
    readonly config: EmbeddingServiceEnv,
    private readonly logger: EmbeddingLogger,
    private readonly createClient: (
      options: LlamaServerOptions
    ) => LlamaEmbeddingClient = (options) =>
      new LlamaServerClient(config, logger, options)
  ) {}

  embeddingBatchTokenLimit(): number {
    const headroom = Math.max(0, this.config.llamaBatchTokenHeadroom);
    return Math.max(1, this.config.llamaNBatch - headroom);
  }

  async loadEmbeddingModel(): Promise<void> {
    if (this.embeddingServer?.isRunning()) {
      return;
    }
    if (this.embeddingLoadPromise) {
      return this.embeddingLoadPromise;
    }
    this.embeddingLoadPromise = this.loadEmbeddingModelOnce().finally(() => {
      this.embeddingLoadPromise = null;
    });
    return this.embeddingLoadPromise;
  }

  async loadRerankerModel(): Promise<void> {
    if (!rerankerEnabled(this.config)) {
      return;
    }
    if (this.rerankerServer?.isRunning()) {
      return;
    }
    if (this.rerankerLoadPromise) {
      return this.rerankerLoadPromise;
    }
    this.rerankerLoadPromise = this.loadRerankerModelOnce().finally(() => {
      this.rerankerLoadPromise = null;
    });
    return this.rerankerLoadPromise;
  }

  async shutdownRuntime(): Promise<void> {
    const rerankerServer = this.rerankerServer;
    this.rerankerServer = null;
    this.loadedRerankerArtifactSha256 = null;
    const embeddingServer = this.embeddingServer;
    this.embeddingServer = null;
    await Promise.all([
      rerankerServer?.stop() ?? Promise.resolve(),
      embeddingServer?.stop() ?? Promise.resolve()
    ]);
  }

  isModelLoaded(): boolean {
    return this.embeddingServer !== null && this.embeddingServer.isRunning();
  }

  isRerankerLoaded(): boolean {
    return this.rerankerServer !== null && this.rerankerServer.isRunning();
  }

  rerankerProvenance(): {
    model: string;
    artifact: string;
    artifactRevision: string;
    artifactHash: string;
  } | null {
    const artifactHash = this.loadedRerankerArtifactSha256;
    if (
      !this.isRerankerLoaded() ||
      !artifactHash ||
      !this.config.rerankerKey ||
      !this.config.rerankerArtifact
    ) {
      return null;
    }
    return {
      model: this.config.rerankerKey,
      artifact: this.config.rerankerArtifact,
      artifactRevision: `sha256:${artifactHash}`,
      artifactHash
    };
  }

  healthQueueSnapshot() {
    return this.scheduler.snapshot();
  }

  async requireEmbeddingServer(): Promise<LlamaEmbeddingClient> {
    try {
      await this.loadEmbeddingModel();
    } catch {
      throw new HttpError(503, "embedding model is still loading");
    }
    if (!this.embeddingServer?.isRunning()) {
      throw new HttpError(503, "embedding model is still loading");
    }
    return this.embeddingServer;
  }

  async splitTextByEmbeddingTokens(
    text: string,
    inputIndex: number
  ): Promise<ChunkCandidate[]> {
    const server = await this.requireEmbeddingServer();
    const stripped = text.trim();
    const maxTokens = Math.max(
      1,
      Math.min(
        this.config.embeddingMaxTokens,
        this.config.llamaNCtx,
        this.embeddingBatchTokenLimit()
      )
    );
    const pieces = await server.tokenize(stripped);
    let chunks: ChunkCandidate[];
    if (pieces.length <= maxTokens) {
      chunks = [
        {
          inputIndex,
          chunkIndex: 0,
          chunkCount: 1,
          text: stripped,
          tokenCount: pieces.length
        }
      ];
    } else {
      const chunkTexts: Array<{ text: string; tokenCount: number }> = [];
      for (let start = 0; start < pieces.length; start += maxTokens) {
        const chunkPieces = pieces.slice(start, start + maxTokens);
        const tokenIds = chunkPieces.map((piece) => piece.tokenId);
        const chunk = (await server.detokenize(tokenIds)).trim();
        if (chunk) {
          chunkTexts.push({ text: chunk, tokenCount: chunkPieces.length });
        }
      }
      chunks = chunkTexts.map((chunk, index) => ({
        inputIndex,
        chunkIndex: index,
        chunkCount: chunkTexts.length,
        text: chunk.text,
        tokenCount: chunk.tokenCount
      }));
    }

    this.logger.debug("embedding text chunked", {
      event: event("embedding.text.chunked"),
      embedding: {
        input_index: inputIndex,
        chunk_count: chunks.length,
        token_count: pieces.length,
        max_tokens: maxTokens,
        n_batch: this.config.llamaNBatch,
        batch_token_headroom: this.config.llamaBatchTokenHeadroom,
        batch_token_limit: this.embeddingBatchTokenLimit()
      }
    });
    return chunks;
  }

  embeddingGroups(chunks: ChunkCandidate[]): ChunkCandidate[][] {
    const groups: ChunkCandidate[][] = [];
    let current: ChunkCandidate[] = [];
    let currentTokens = 0;
    const batchTokenLimit = this.embeddingBatchTokenLimit();
    for (const chunk of chunks) {
      if (chunk.tokenCount > batchTokenLimit) {
        if (current.length > 0) {
          groups.push(current);
          current = [];
          currentTokens = 0;
        }
        groups.push([chunk]);
        continue;
      }
      if (
        current.length > 0 &&
        currentTokens + chunk.tokenCount > batchTokenLimit
      ) {
        groups.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(chunk);
      currentTokens += chunk.tokenCount;
    }
    if (current.length > 0) {
      groups.push(current);
    }
    return groups;
  }

  async embedText(
    texts: string[],
    requestedPriority: string | null
  ): Promise<EmbedResponse> {
    await this.requireEmbeddingServer();
    const priority = normalizeEmbeddingPriority(requestedPriority);
    const chunks: ChunkCandidate[] = [];
    for (const [inputIndex, text] of texts.entries()) {
      chunks.push(
        ...(await this.scheduledTextChunks(text, inputIndex, priority))
      );
    }
    const { vectors, measuredTokens } = await this.scheduledEmbeddings(
      chunks,
      priority
    );
    const dimensions = vectors[0]?.length ?? 0;
    if (dimensions !== this.config.expectedDimensions) {
      throw new Error(
        `model returned ${dimensions} dimensions; expected ${this.config.expectedDimensions}`
      );
    }
    const embeddedChunks: EmbeddedChunk[] = chunks.map((chunk, index) => ({
      inputIndex: chunk.inputIndex,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      tokenCount: chunk.tokenCount,
      text: chunk.text,
      vector: vectors[index] ?? []
    }));
    return {
      model: this.config.modelName,
      dimensions,
      measuredTokens,
      vectors,
      chunks: embeddedChunks
    };
  }

  async rerankTexts(
    query: string,
    documents: string[]
  ): Promise<RerankResponse> {
    const localReranker = await this.getReranker();
    this.logger.debug("reranker scoring started", {
      event: event("embedding.reranker.scoring_started"),
      reranker: {
        model_key: this.config.rerankerKey,
        document_count: documents.length
      }
    });
    const started = performance.now();
    const result = await localReranker.rerank(query, documents);
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    this.logger.debug("reranker scoring completed", {
      event: event("embedding.reranker.scoring_completed"),
      reranker: {
        model_key: this.config.rerankerKey,
        document_count: documents.length,
        score_count: result.scores.length,
        measured_tokens: result.measuredTokens,
        latency_ms: latencyMs
      }
    });
    const provenance = this.rerankerProvenance();
    if (!provenance) {
      throw new Error("loaded reranker provenance is unavailable");
    }
    return {
      ...provenance,
      latencyMs,
      inputTokens: result.measuredTokens,
      costUsd: 0,
      scores: result.scores.map(Number)
    };
  }

  private async scheduledTextChunks(
    text: string,
    inputIndex: number,
    priority: string
  ): Promise<ChunkCandidate[]> {
    this.logger.debug("embedding scheduler waiting for tokenization", {
      event: event("embedding.scheduler.waiting"),
      priority,
      queue: this.scheduler.snapshot()
    });
    return this.scheduler.slot(priority, async () => {
      this.logger.debug("embedding scheduler acquired tokenization slot", {
        event: event("embedding.scheduler.acquired"),
        priority,
        queue: this.scheduler.snapshot()
      });
      const chunks = await this.splitTextByEmbeddingTokens(text, inputIndex);
      this.logger.debug("embedding scheduler released tokenization slot", {
        event: event("embedding.scheduler.released"),
        priority,
        queue: this.scheduler.snapshot()
      });
      return chunks;
    });
  }

  private async embedGroup(group: ChunkCandidate[]): Promise<{
    vectors: number[][];
    measuredTokens: number | null;
  }> {
    const server = await this.requireEmbeddingServer();
    const texts = group.map((chunk) => chunk.text);
    const batchTokenLimit = this.embeddingBatchTokenLimit();
    if (
      group.length === 1 &&
      group[0] &&
      group[0].tokenCount > batchTokenLimit
    ) {
      this.logger.debug("embedding batch fell back to single long chunk", {
        event: event("embedding.batch.fallback_single"),
        embedding: {
          chunk_count: 1,
          token_count: group[0].tokenCount,
          n_batch: this.config.llamaNBatch,
          batch_token_limit: batchTokenLimit
        }
      });
    } else {
      this.logger.debug("embedding batch started", {
        event: event("embedding.batch.started"),
        embedding: {
          chunk_count: group.length,
          token_count: group.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
          n_batch: this.config.llamaNBatch,
          batch_token_limit: batchTokenLimit
        }
      });
    }
    const result = await server.embed(texts);
    this.logger.debug("embedding batch completed", {
      event: event("embedding.batch.completed"),
      embedding: {
        chunk_count: group.length,
        measured_tokens: result.measuredTokens
      }
    });
    if (result.vectors.length !== group.length) {
      throw new Error("model returned an unexpected embedding count");
    }
    return result;
  }

  private async scheduledEmbeddings(
    chunks: ChunkCandidate[],
    priority: string
  ): Promise<{ vectors: number[][]; measuredTokens: number | null }> {
    const vectors: number[][] = [];
    let measuredTokenTotal = 0;
    let measuredTokenCount = 0;
    for (const group of this.embeddingGroups(chunks)) {
      this.logger.debug("embedding scheduler waiting for model slot", {
        event: event("embedding.scheduler.waiting"),
        priority,
        queue: this.scheduler.snapshot()
      });
      await this.scheduler.slot(priority, async () => {
        this.logger.debug("embedding scheduler acquired model slot", {
          event: event("embedding.scheduler.acquired"),
          priority,
          queue: this.scheduler.snapshot()
        });
        const result = await this.embedGroup(group);
        vectors.push(...result.vectors);
        if (result.measuredTokens !== null) {
          measuredTokenTotal += result.measuredTokens;
          measuredTokenCount += 1;
        }
        this.logger.debug("embedding scheduler released model slot", {
          event: event("embedding.scheduler.released"),
          priority,
          queue: this.scheduler.snapshot()
        });
      });
    }
    return {
      vectors,
      measuredTokens: measuredTokenCount > 0 ? measuredTokenTotal : null
    };
  }

  private async getReranker(): Promise<LlamaEmbeddingClient> {
    if (!rerankerEnabled(this.config)) {
      throw new HttpError(404, "reranker is disabled");
    }
    await this.loadRerankerModel();
    if (!this.rerankerServer?.isRunning()) {
      throw new HttpError(503, "reranker model is still loading");
    }
    return this.rerankerServer;
  }

  private async loadEmbeddingModelOnce(): Promise<void> {
    if (this.embeddingServer !== null) {
      await this.embeddingServer.stop();
      this.embeddingServer = null;
    }
    this.logger.info("embedding model load started", {
      event: event("embedding.model.load_started"),
      model: {
        key: this.config.modelKey,
        repo: this.config.modelRepo,
        file: this.config.modelFile
      },
      runtime: {
        server: "llama-server",
        n_ctx: this.config.llamaNCtx,
        n_batch: this.config.llamaNBatch,
        batch_token_headroom: this.config.llamaBatchTokenHeadroom,
        batch_token_limit: this.embeddingBatchTokenLimit(),
        n_ubatch: this.config.llamaNUbatch,
        n_threads: this.config.llamaNThreads
      }
    });
    try {
      const modelPath = this.resolveEmbeddingModelPath();
      this.embeddingServer = this.createClient({
        name: "embedding",
        modelPath,
        port: this.config.embeddingServerPort,
        pooling: "last",
        embedding: true,
        reranking: false,
        nCtx: this.config.llamaNCtx,
        nThreads: this.config.llamaNThreads,
        nBatch: this.config.llamaNBatch,
        nUbatch: this.config.llamaNUbatch,
        parallel: this.config.llamaParallel,
        promptCacheEnabled: false
      });
      await this.startClient(this.embeddingServer);
    } catch (error) {
      this.logger.error("embedding model load failed", {
        event: event("embedding.model.load_failed"),
        model: { key: this.config.modelKey },
        error: errorType(error)
      });
      this.embeddingServer = null;
      throw error;
    }
    this.logger.info("embedding model load completed", {
      event: event("embedding.model.load_completed"),
      model: {
        key: this.config.modelKey,
        dimensions: this.config.expectedDimensions
      },
      runtime: { server: "llama-server" }
    });
  }

  private async loadRerankerModelOnce(): Promise<void> {
    this.logger.info("reranker load started", {
      event: event("embedding.reranker.load_started"),
      reranker: {
        model_key: this.config.rerankerKey,
        runtime: "llama-server"
      }
    });
    try {
      const modelPath = this.resolveRerankerModelPath();
      this.loadedRerankerArtifactSha256 = await verifyRerankerModelArtifact(
        this.config
      );
      this.rerankerServer = this.createClient({
        name: "reranker",
        modelPath,
        port: this.config.rerankerServerPort,
        pooling: "rank",
        embedding: true,
        reranking: true,
        nCtx: this.config.rerankerNCtx,
        nThreads: this.config.rerankerNThreads,
        nBatch: this.config.rerankerNBatch,
        nUbatch: this.config.rerankerNUbatch,
        parallel: this.config.rerankerParallel,
        promptCacheEnabled: this.config.rerankerPromptCacheEnabled
      });
      await this.startClient(this.rerankerServer);
    } catch (error) {
      this.logger.error("reranker load failed", {
        event: event("embedding.reranker.load_failed"),
        reranker: { model_key: this.config.rerankerKey },
        error: errorType(error)
      });
      this.rerankerServer = null;
      this.loadedRerankerArtifactSha256 = null;
      throw error;
    }
    this.logger.info("reranker load completed", {
      event: event("embedding.reranker.load_completed"),
      reranker: {
        model_key: this.config.rerankerKey,
        runtime: "llama-server"
      }
    });
  }

  private resolveEmbeddingModelPath(): string {
    if (this.config.modelPath) {
      return this.config.modelPath;
    }
    return `/models/${this.config.modelFile}`;
  }

  private resolveRerankerModelPath(): string {
    if (this.config.rerankerModelPath) {
      return this.config.rerankerModelPath;
    }
    if (
      this.config.rerankerRepo === null ||
      this.config.rerankerFile === null
    ) {
      throw new HttpError(404, "reranker is disabled");
    }
    throw new Error(
      "RERANKER_MODEL_PATH is required for the TypeScript Embedding Service"
    );
  }

  private async startClient(client: LlamaEmbeddingClient): Promise<void> {
    const maybeStart = client as LlamaEmbeddingClient & {
      start?: () => Promise<void> | void;
    };
    await maybeStart.start?.();
  }
}

export { rerankerEnabled, rerankerModel };
