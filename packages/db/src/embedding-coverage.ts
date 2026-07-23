import { resolveSupportedEmbeddingModelConfig } from "@koed/shared";

export interface CurrentEmbeddingConfig {
  model: string;
  dimensions: number;
  version: string;
  table: string;
}

export const embeddingTableForDimensions = (dimensions: number): string => {
  if (dimensions === 384) return "memory_embeddings_384";
  if (dimensions === 1024) return "memory_embeddings_1024";
  if (dimensions === 1536) return "memory_embeddings_1536";
  if (dimensions === 3072) return "memory_embeddings_3072";
  throw new Error(`Unsupported local embedding dimensions: ${dimensions}`);
};

export const currentEmbeddingConfig = (): CurrentEmbeddingConfig => {
  const config = resolveSupportedEmbeddingModelConfig(
    process.env.EMBEDDING_MODEL
  );
  return {
    model: config.key,
    dimensions: config.dimensions,
    version: config.key,
    table: embeddingTableForDimensions(config.dimensions)
  };
};
