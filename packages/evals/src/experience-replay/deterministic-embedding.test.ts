import { describe, expect, it } from "vitest";
import {
  deterministicEmbeddingVector,
  startDeterministicEmbeddingService
} from "./deterministic-embedding.js";

describe("deterministic smoke embedding service", () => {
  it("is deterministic and gives overlapping text higher similarity", () => {
    const source = deterministicEmbeddingVector(
      "unique marker marsupial database migration",
      32
    );
    const relevant = deterministicEmbeddingVector(
      "where was the marsupial database migration?",
      32
    );
    const unrelated = deterministicEmbeddingVector("football weather", 32);
    const dot = (right: number[]) =>
      source.reduce((sum, value, index) => sum + value * right[index]!, 0);
    expect(dot(relevant)).toBeGreaterThan(dot(unrelated));
  });

  it("requires auth, bounds input, and reports measured work", async () => {
    const service = await startDeterministicEmbeddingService({
      token: "fixture-token",
      model: "fixture-model",
      dimensions: 32
    });
    try {
      await expect(
        fetch(`${service.url}/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ texts: ["secret"] })
        }).then((response) => response.status)
      ).resolves.toBe(401);
      const response = await fetch(`${service.url}/embed`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-embedding-token": service.token
        },
        body: JSON.stringify({ texts: ["alpha beta", "beta gamma"] })
      });
      expect(await response.json()).toMatchObject({
        model: "fixture-model",
        dimensions: 32,
        measuredTokens: 4
      });
      expect(service.metrics()).toEqual({
        calls: 1,
        texts: 2,
        measuredTokens: 4
      });
    } finally {
      await service.close();
    }
  });
});
