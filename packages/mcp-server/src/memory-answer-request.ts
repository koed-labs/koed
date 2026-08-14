import {
  MEMORY_RETRIEVAL_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_SEMANTIC_HINT_MAX_COUNT,
  memoryRetrievalExactHintsSchema,
  memoryRetrievalHintSchema
} from "@koed/shared";
import { z } from "zod";

const boundedHintListSchema = z
  .array(memoryRetrievalHintSchema)
  .max(MEMORY_RETRIEVAL_HINT_MAX_COUNT)
  .optional();

export const memoryAnswerRetrievalHintsSchema = z
  .object({
    lexical: boundedHintListSchema.describe(
      "Words or phrases to use as focused semantic retrieval suggestions."
    ),
    exact: memoryRetrievalExactHintsSchema
      .optional()
      .describe(
        "Exact quoted text or identifiers to check within retrieved candidates."
      ),
    semantic: z
      .array(memoryRetrievalHintSchema)
      .max(MEMORY_RETRIEVAL_SEMANTIC_HINT_MAX_COUNT)
      .optional()
      .describe("Alternative semantic reformulations of the question."),
    entities: boundedHintListSchema.describe(
      "Entity names or aliases relevant to the question."
    ),
    temporal_intent: memoryRetrievalHintSchema
      .optional()
      .describe("Temporal interpretation such as current state or history.")
  })
  .strict()
  .optional();
