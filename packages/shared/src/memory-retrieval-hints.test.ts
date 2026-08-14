import { describe, expect, it } from "vitest";
import {
  MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_LENGTH,
  memoryRetrievalExactHintsSchema,
  memoryRetrievalHintSchema
} from "./memory-retrieval-hints.js";

describe("memory retrieval hint contract", () => {
  it("accepts the maximum hint length and rejects one character more", () => {
    expect(
      memoryRetrievalHintSchema.safeParse(
        "x".repeat(MEMORY_RETRIEVAL_HINT_MAX_LENGTH)
      ).success
    ).toBe(true);
    expect(
      memoryRetrievalHintSchema.safeParse(
        "x".repeat(MEMORY_RETRIEVAL_HINT_MAX_LENGTH + 1)
      ).success
    ).toBe(false);
  });

  it("accepts the maximum exact-hint count and rejects one more", () => {
    expect(
      memoryRetrievalExactHintsSchema.safeParse(
        Array.from(
          { length: MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT },
          (_, index) => `hint-${index}`
        )
      ).success
    ).toBe(true);
    expect(
      memoryRetrievalExactHintsSchema.safeParse(
        Array.from(
          { length: MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT + 1 },
          (_, index) => `hint-${index}`
        )
      ).success
    ).toBe(false);
  });
});
