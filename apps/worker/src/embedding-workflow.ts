import type {
  EmbeddableSourceRecord,
  EmbeddableSourceType,
  MemorySourceRepository
} from "@koed/db";
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
}

interface EmbeddingWorkflowConfig {
  env: WorkerEnvConfig;
  fetchFn?: typeof fetch;
  repository: () => MemorySourceRepository;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === "number");

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
  expectedDimensions: number
): EmbeddingResponse => {
  if (!isRecord(payload)) {
    throw new Error(
      `embedding service returned an invalid ${expectedDimensions}-dim response`
    );
  }

  const { model, dimensions, vectors, chunks } = payload;
  if (
    typeof model !== "string" ||
    dimensions !== expectedDimensions ||
    !isVectorArray(vectors) ||
    !vectors[0]
  ) {
    throw new Error(
      `embedding service returned an invalid ${expectedDimensions}-dim response`
    );
  }

  return {
    model,
    dimensions: expectedDimensions,
    vectors,
    chunks:
      Array.isArray(chunks) && chunks.every(isEmbeddedChunk)
        ? chunks
        : vectors.map((vector, index) => ({
            inputIndex: index,
            chunkIndex: 0,
            chunkCount: 1,
            text: preparedTexts[index] ?? "",
            vector
          }))
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

const embedTexts = async (
  texts: string[],
  config: { env: WorkerEnvConfig; fetchFn: typeof fetch }
): Promise<EmbeddingResponse> => {
  const preparedTexts = texts.map((text) => text.trim()).filter(Boolean);
  if (preparedTexts.length === 0) {
    throw new Error("Embedding text is empty after normalization");
  }

  const response = await config.fetchFn(
    `${config.env.embeddingServiceUrl.replace(/\/+$/, "")}/embed`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...embeddingServiceHeaders(config.env)
      },
      body: JSON.stringify({ texts: preparedTexts })
    }
  );
  const payload: unknown = await response.json().catch(() => ({}));
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
    config.env.embeddingDimensions
  );
};

export const createEmbeddingWorkflow = (
  config: EmbeddingWorkflowConfig
): EmbeddingWorkflow => {
  const fetchFn = config.fetchFn ?? fetch;

  const storeEmbedding = async (source: EmbeddableSourceRecord) => {
    const embedded = await embedTexts([source.text], {
      env: config.env,
      fetchFn
    });
    const chunks = embedded.chunks.filter((chunk) => chunk.inputIndex === 0);
    if (chunks.length === 0) {
      throw new Error("embedding service returned no chunks for source");
    }
    const stored = await Promise.all(
      chunks.map((chunk) =>
        config.repository().upsertSourceEmbedding({
          source,
          model: embedded.model,
          dimensions: embedded.dimensions,
          version: config.env.embeddingVersion,
          vector: chunk.vector,
          chunkIndex: chunk.chunkIndex,
          chunkCount: chunk.chunkCount,
          sourceText: chunk.text
        })
      )
    );
    return {
      inserted: stored.some((result) => result.inserted),
      chunks: stored.length
    };
  };

  return {
    async embedSource(sourceType, sourceId) {
      const source = await config
        .repository()
        .getEmbeddableSource(sourceType, sourceId);
      if (!source) {
        return { skipped: true, reason: "source missing or empty" };
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
