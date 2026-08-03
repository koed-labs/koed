import type {
  EmbeddableSourceRecord,
  EmbeddableSourceType,
  MemorySourceRepository
} from "@koed/db";
import { fetchBoundedJsonObject } from "@koed/shared";
import { Agent } from "undici";
import type { WorkerEnvConfig } from "./env-config.js";

export interface EmbeddedChunk {
  inputIndex: number;
  chunkIndex: number;
  chunkCount: number;
  text: string;
  vector: number[];
}

interface EmbeddingResponse {
  model: string;
  dimensions: number;
  vectors: number[][];
  chunks: EmbeddedChunk[];
}

export interface EmbeddingWorkflow {
  embedSource(
    sourceType: EmbeddableSourceType,
    sourceId: string
  ): Promise<
    | { skipped: true; reason: string }
    | { dimensions: number; inserted: boolean; chunks: number }
  >;
  embedSources(
    sources: Array<{ sourceType: EmbeddableSourceType; sourceId: string }>,
    options?: { beforeBatch?: () => Promise<void> }
  ): Promise<void>;
}

interface EmbeddingWorkflowConfig {
  env: WorkerEnvConfig;
  fetchFn?: typeof fetch;
  repository: () => MemorySourceRepository;
}

const EMBEDDING_SOURCE_LOOKUP_CONCURRENCY = 32;
const EMBEDDING_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

interface EmbeddingTransportSegment {
  sourceIndex: number;
  segmentIndex: number;
  text: string;
  characterCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "number" && Number.isFinite(item));

const isVectorArray = (value: unknown): value is number[][] =>
  Array.isArray(value) && value.every(isNumberArray);

const isEmbeddedChunk = (value: unknown): value is EmbeddedChunk => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.inputIndex === "number" &&
    Number.isInteger(value.inputIndex) &&
    typeof value.chunkIndex === "number" &&
    Number.isInteger(value.chunkIndex) &&
    typeof value.chunkCount === "number" &&
    Number.isInteger(value.chunkCount) &&
    typeof value.text === "string" &&
    isNumberArray(value.vector)
  );
};

const parseEmbeddingResponse = (
  payload: unknown,
  preparedTexts: string[],
  expectedDimensions: number,
  expectedModel: string
): EmbeddingResponse => {
  if (!isRecord(payload)) {
    throw new Error(
      `embedding service returned an invalid ${expectedDimensions}-dim response`
    );
  }

  const { model, dimensions, vectors, chunks } = payload;
  const hasChunks = Array.isArray(chunks) && chunks.length > 0;
  if (
    model !== expectedModel ||
    dimensions !== expectedDimensions ||
    !isVectorArray(vectors) ||
    vectors.length === 0 ||
    vectors.some((vector) => vector.length !== expectedDimensions)
  ) {
    throw new Error(
      `embedding service returned an invalid ${expectedDimensions}-dim response`
    );
  }

  const normalizedChunks = hasChunks
    ? (chunks as unknown[])
    : vectors.map((vector, index) => ({
        inputIndex: index,
        chunkIndex: 0,
        chunkCount: 1,
        text: preparedTexts[index] ?? "",
        vector
      }));
  if (
    vectors.length !==
      (hasChunks ? normalizedChunks.length : preparedTexts.length) ||
    !normalizedChunks.every(isEmbeddedChunk) ||
    normalizedChunks.some(
      (chunk) =>
        chunk.inputIndex < 0 ||
        chunk.inputIndex >= preparedTexts.length ||
        chunk.chunkIndex < 0 ||
        chunk.chunkCount < 1 ||
        chunk.chunkIndex >= chunk.chunkCount ||
        chunk.vector.length !== expectedDimensions ||
        chunk.text.trim().length === 0
    )
  ) {
    throw new Error(
      `embedding service returned an invalid ${expectedDimensions}-dim response`
    );
  }
  for (let inputIndex = 0; inputIndex < preparedTexts.length; inputIndex += 1) {
    const inputChunks = normalizedChunks.filter(
      (chunk) => chunk.inputIndex === inputIndex
    );
    const expectedChunkCount = inputChunks[0]?.chunkCount;
    if (
      expectedChunkCount === undefined ||
      inputChunks.length !== expectedChunkCount ||
      inputChunks.some((chunk) => chunk.chunkCount !== expectedChunkCount) ||
      new Set(inputChunks.map((chunk) => chunk.chunkIndex)).size !==
        expectedChunkCount
    ) {
      throw new Error(
        `embedding service returned an invalid ${expectedDimensions}-dim response`
      );
    }
  }

  return {
    model,
    dimensions: expectedDimensions,
    vectors,
    chunks: normalizedChunks
  };
};

const embeddingServiceHeaders = (
  env: WorkerEnvConfig
): Record<string, string> => ({
  ...(env.embeddingServiceToken
    ? { "x-koed-embedding-token": env.embeddingServiceToken }
    : {}),
  "x-koed-embedding-priority": "background"
});

const responseDetail = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  return typeof payload.detail === "string" ? payload.detail : undefined;
};

const splitEmbeddingText = (
  text: string,
  maxCharacters: number
): Array<{ text: string; characterCount: number }> => {
  const normalized = text.trim();
  const segments: Array<{ text: string; characterCount: number }> = [];
  for (let start = 0; start < normalized.length; ) {
    let end = Math.min(start + maxCharacters, normalized.length);
    if (
      end < normalized.length &&
      end > start &&
      normalized.charCodeAt(end - 1) >= 0xd800 &&
      normalized.charCodeAt(end - 1) <= 0xdbff &&
      normalized.charCodeAt(end) >= 0xdc00 &&
      normalized.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    if (end === start) {
      throw new Error(
        "EMBEDDING_MAX_TEXT_CHARS is too small for a Unicode character"
      );
    }
    const prepared = normalized.slice(start, end).trim();
    if (prepared) {
      segments.push({ text: prepared, characterCount: prepared.length });
    }
    start = end;
  }
  if (segments.length === 0) {
    throw new Error("Embedding text is empty after normalization");
  }
  return segments;
};

const embedTexts = async (
  texts: string[],
  config: {
    env: WorkerEnvConfig;
    fetchFn: typeof fetch;
    dispatcher: Agent;
  }
): Promise<EmbeddingResponse> => {
  const preparedTexts = texts.map((text) => text.trim());
  if (preparedTexts.length === 0 || preparedTexts.some((text) => !text)) {
    throw new Error("Embedding text is empty after normalization");
  }

  const requestInit: RequestInit & { dispatcher: Agent } = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...embeddingServiceHeaders(config.env)
    },
    body: JSON.stringify({ texts: preparedTexts }),
    dispatcher: config.dispatcher
  };
  const { response, payload } = await fetchBoundedJsonObject(
    config.fetchFn,
    `${config.env.embeddingServiceUrl.replace(/\/+$/, "")}/embed`,
    requestInit,
    {
      timeoutMs: config.env.embeddingRequestTimeoutMs,
      maxBytes: EMBEDDING_MAX_RESPONSE_BYTES
    }
  );
  if (!response.ok) {
    const transient = response.status === 429 || response.status >= 500;
    throw Object.assign(
      new Error(
        responseDetail(payload) ??
          `embedding service failed with ${response.status}`
      ),
      { transient }
    );
  }

  return parseEmbeddingResponse(
    payload,
    preparedTexts,
    config.env.embeddingDimensions,
    config.env.embeddingVersion
  );
};

export const createEmbeddingWorkflow = (
  config: EmbeddingWorkflowConfig
): EmbeddingWorkflow => {
  const fetchFn = config.fetchFn ?? fetch;
  const dispatcher = new Agent({
    connectTimeout: 10_000,
    headersTimeout: config.env.embeddingRequestTimeoutMs,
    bodyTimeout: config.env.embeddingRequestTimeoutMs
  });

  const storeEmbeddings = async (sources: EmbeddableSourceRecord[]) => {
    const maxSegmentCharacters = Math.min(
      config.env.embeddingMaxTextChars,
      config.env.embeddingMaxRequestChars
    );
    const transportSegments = sources.flatMap((source, sourceIndex) =>
      splitEmbeddingText(source.text, maxSegmentCharacters).map(
        (segment, segmentIndex): EmbeddingTransportSegment => ({
          sourceIndex,
          segmentIndex,
          ...segment
        })
      )
    );
    const embeddedBySource = new Map<
      number,
      Array<EmbeddedChunk & { segmentIndex: number }>
    >();
    for (let offset = 0; offset < transportSegments.length; ) {
      const requestSegments: EmbeddingTransportSegment[] = [];
      let requestCharacters = 0;
      while (
        offset < transportSegments.length &&
        requestSegments.length < config.env.embeddingBatchLimit
      ) {
        const candidate = transportSegments[offset]!;
        if (
          requestSegments.length > 0 &&
          requestCharacters + candidate.characterCount >
            config.env.embeddingMaxRequestChars
        ) {
          break;
        }
        requestSegments.push(candidate);
        requestCharacters += candidate.characterCount;
        offset += 1;
      }
      const embedded = await embedTexts(
        requestSegments.map((segment) => segment.text),
        {
          env: config.env,
          fetchFn,
          dispatcher
        }
      );
      for (const chunk of embedded.chunks) {
        const segment = requestSegments[chunk.inputIndex];
        if (!segment) {
          throw new Error("embedding service returned an invalid input index");
        }
        const sourceChunks = embeddedBySource.get(segment.sourceIndex) ?? [];
        sourceChunks.push({ ...chunk, segmentIndex: segment.segmentIndex });
        embeddedBySource.set(segment.sourceIndex, sourceChunks);
      }
    }
    const storedBySource = await Promise.all(
      sources.map(async (source, sourceIndex) => {
        const chunks = (embeddedBySource.get(sourceIndex) ?? []).sort(
          (left, right) =>
            left.segmentIndex - right.segmentIndex ||
            left.chunkIndex - right.chunkIndex
        );
        if (chunks.length === 0) {
          throw new Error("embedding service returned no chunks for source");
        }
        const stored = await config.repository().replaceSourceEmbeddings({
          source,
          model: config.env.embeddingVersion,
          modelArtifactHash: config.env.embeddingModelArtifactHash,
          dimensions: config.env.embeddingDimensions,
          version: config.env.embeddingVersion,
          tokenizer: config.env.embeddingTokenizer,
          inputTransform: config.env.embeddingInputTransform,
          pooling: config.env.embeddingPooling,
          normalization: config.env.embeddingNormalization,
          chunks: chunks.map((chunk, chunkIndex) => ({
            vector: chunk.vector,
            chunkIndex,
            chunkCount: chunks.length,
            sourceText: chunk.text
          }))
        });
        return {
          inserted: stored.inserted,
          chunks: stored.ids.length
        };
      })
    );
    return storedBySource;
  };

  const getMissingSource = async (
    sourceType: EmbeddableSourceType,
    sourceId: string
  ): Promise<EmbeddableSourceRecord | null> => {
    const source = await config
      .repository()
      .getEmbeddableSource(sourceType, sourceId);
    if (!source) {
      return null;
    }
    const currentChunkCount = await config
      .repository()
      .getCurrentSourceEmbeddingChunkCount({
        source,
        model: config.env.embeddingVersion,
        dimensions: config.env.embeddingDimensions,
        version: config.env.embeddingVersion
      });
    return currentChunkCount === null ? source : null;
  };

  const storeEmbedding = async (source: EmbeddableSourceRecord) => {
    const [stored] = await storeEmbeddings([source]);
    if (!stored) {
      throw new Error("embedding service returned no chunks for source");
    }
    return stored;
  };

  return {
    async embedSources(sources, options) {
      const missingSources: EmbeddableSourceRecord[] = [];
      for (
        let offset = 0;
        offset < sources.length;
        offset += EMBEDDING_SOURCE_LOOKUP_CONCURRENCY
      ) {
        const lookupBatch = sources.slice(
          offset,
          offset + EMBEDDING_SOURCE_LOOKUP_CONCURRENCY
        );
        const missingBatch = (
          await Promise.all(
            lookupBatch.map(({ sourceType, sourceId }) =>
              getMissingSource(sourceType, sourceId)
            )
          )
        ).filter((source): source is EmbeddableSourceRecord => source !== null);
        missingSources.push(...missingBatch);
      }
      for (let offset = 0; offset < missingSources.length; ) {
        const first = missingSources[offset]!;
        const batchLimit =
          first.sourceType === "memory_node"
            ? 1
            : config.env.embeddingBatchLimit;
        const batch: EmbeddableSourceRecord[] = [];
        let batchCharacters = 0;
        for (
          let index = offset;
          index < missingSources.length && batch.length < batchLimit;
          index += 1
        ) {
          const candidate = missingSources[index]!;
          if (candidate.sourceType !== first.sourceType) break;
          if (
            batch.length > 0 &&
            batchCharacters + candidate.text.length >
              config.env.embeddingMaxRequestChars
          ) {
            break;
          }
          batch.push(candidate);
          batchCharacters += candidate.text.length;
        }
        await options?.beforeBatch?.();
        await storeEmbeddings(batch);
        offset += batch.length;
      }
    },
    async embedSource(sourceType, sourceId) {
      const source = await config
        .repository()
        .getEmbeddableSource(sourceType, sourceId);
      if (!source) {
        return { skipped: true, reason: "source missing or empty" };
      }
      const currentChunkCount = await config
        .repository()
        .getCurrentSourceEmbeddingChunkCount({
          source,
          model: config.env.embeddingVersion,
          dimensions: config.env.embeddingDimensions,
          version: config.env.embeddingVersion
        });
      if (currentChunkCount !== null) {
        return {
          dimensions: config.env.embeddingDimensions,
          inserted: false,
          chunks: currentChunkCount
        };
      }
      const stored = await storeEmbedding(source);
      return {
        dimensions: config.env.embeddingDimensions,
        inserted: stored.inserted,
        chunks: stored.chunks
      };
    }
  };
};
