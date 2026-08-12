import type { EmbeddingServiceEnv } from "./env-config.js";
import { HttpError } from "./auth.js";

export interface EmbeddedChunk {
  inputIndex: number;
  chunkIndex: number;
  chunkCount: number;
  tokenCount: number;
  text: string;
  vector: number[];
}

export interface EmbedResponse {
  model: string;
  dimensions: number;
  measuredTokens: number | null;
  vectors: number[][];
  chunks: EmbeddedChunk[];
}

export interface RerankResponse {
  model: string;
  artifact: string;
  artifactRevision: string;
  artifactHash: string;
  latencyMs: number;
  inputTokens: number | null;
  costUsd: 0;
  scores: number[];
}

export const validateTextLimits = (
  config: Pick<
    EmbeddingServiceEnv,
    "embeddingMaxTextChars" | "embeddingMaxRequestChars"
  >,
  values: string[],
  fieldName: string
): void => {
  let totalChars = 0;
  values.forEach((value, index) => {
    const charCount = value.length;
    if (charCount > config.embeddingMaxTextChars) {
      throw new HttpError(
        422,
        `${fieldName}[${index}] exceeds maximum length of ${config.embeddingMaxTextChars} characters`
      );
    }
    totalChars += charCount;
  });
  if (totalChars > config.embeddingMaxRequestChars) {
    throw new HttpError(
      422,
      `${fieldName} exceeds maximum total length of ${config.embeddingMaxRequestChars} characters`
    );
  }
};

const stringArrayField = (
  payload: Record<string, unknown>,
  fieldName: string
): string[] => {
  const value = payload[fieldName];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new HttpError(422, `${fieldName} must be a non-empty string array`);
  }
  if (value.length === 0) {
    throw new HttpError(422, `${fieldName} must contain at least one item`);
  }
  return value;
};

export const validateEmbedRequest = (
  config: Pick<
    EmbeddingServiceEnv,
    "batchLimit" | "embeddingMaxTextChars" | "embeddingMaxRequestChars"
  >,
  payload: unknown
): { texts: string[] } => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new HttpError(422, "request body must be a JSON object");
  }
  const texts = stringArrayField(payload as Record<string, unknown>, "texts");
  if (texts.length > config.batchLimit) {
    throw new HttpError(
      422,
      `too many texts; maximum batch size is ${config.batchLimit}`
    );
  }
  texts.forEach((text, index) => {
    if (!text || !text.trim()) {
      throw new HttpError(422, `texts[${index}] must not be empty`);
    }
  });
  validateTextLimits(config, texts, "texts");
  return { texts };
};

export const validateRerankRequest = (
  config: Pick<
    EmbeddingServiceEnv,
    "rerankerBatchLimit" | "embeddingMaxTextChars" | "embeddingMaxRequestChars"
  >,
  payload: unknown
): { query: string; documents: string[] } => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new HttpError(422, "request body must be a JSON object");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.query !== "string") {
    throw new HttpError(422, "query must be a string");
  }
  if (!record.query.trim()) {
    throw new HttpError(422, "query must not be empty");
  }
  validateTextLimits(config, [record.query], "query");

  const documents = stringArrayField(record, "documents");
  if (documents.length > config.rerankerBatchLimit) {
    throw new HttpError(
      422,
      `too many documents; maximum batch size is ${config.rerankerBatchLimit}`
    );
  }
  documents.forEach((document, index) => {
    if (!document || !document.trim()) {
      throw new HttpError(422, `documents[${index}] must not be empty`);
    }
  });
  validateTextLimits(config, documents, "documents");
  validateTextLimits(config, [record.query, ...documents], "request");
  return { query: record.query, documents };
};
