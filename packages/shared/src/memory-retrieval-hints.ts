import { z } from "zod";

export const MEMORY_RETRIEVAL_HINT_MAX_LENGTH = 256 as const;
export const MEMORY_RETRIEVAL_HINT_MAX_COUNT = 8 as const;
export const MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT =
  MEMORY_RETRIEVAL_HINT_MAX_COUNT;
export const MEMORY_RETRIEVAL_SEMANTIC_HINT_MAX_COUNT = 6 as const;

export const memoryRetrievalHintSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_RETRIEVAL_HINT_MAX_LENGTH);

export const memoryRetrievalExactHintsSchema = z
  .array(memoryRetrievalHintSchema)
  .max(MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT);
