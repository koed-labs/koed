import { describe, expect, it } from "vitest";
import { extractEmbeddingVectors, normalizeVector } from "./vectors.js";

describe("vector helpers", () => {
  it("extracts llama embedding response vectors", () => {
    expect(
      extractEmbeddingVectors({
        data: [{ embedding: [1, 2.5, 3] }, { embedding: [4, 5, 6] }]
      })
    ).toEqual([
      [1, 2.5, 3],
      [4, 5, 6]
    ]);
  });

  it("rejects malformed vectors and zero vectors", () => {
    expect(() =>
      extractEmbeddingVectors({ data: [{ embedding: [[1.0]] }] })
    ).toThrow("invalid embedding");
    expect(() => normalizeVector([0, 0])).toThrow("zero vector");
  });
});
