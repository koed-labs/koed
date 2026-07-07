import { describe, expect, it } from "vitest";
import {
  extractRerankScores,
  llamaServerEnvironment,
  tokenPieceText
} from "./llama-server.js";

describe("llama-server adapter helpers", () => {
  it("decodes token pieces with Python parity", () => {
    expect(tokenPieceText("hello")).toBe("hello");
    expect(tokenPieceText([99, 97, 102, 195, 169])).toBe("café");
    expect(tokenPieceText({ value: "x" })).toBe("[object Object]");
  });

  it("derives llama-server library path from configured binary", () => {
    expect(
      llamaServerEnvironment("/runtime/llama.cpp/llama-server", {})
        .LD_LIBRARY_PATH
    ).toBe("/runtime/llama.cpp");
    expect(
      llamaServerEnvironment("/runtime/llama.cpp/llama-server", {
        LD_LIBRARY_PATH: "/existing"
      }).LD_LIBRARY_PATH
    ).toBe("/runtime/llama.cpp:/existing");
  });

  it("extracts rerank scores in original document order", () => {
    expect(
      extractRerankScores(
        {
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.2 }
          ]
        },
        2
      )
    ).toEqual([0.2, 0.9]);

    expect(extractRerankScores({ scores: [0.1, 0.3] }, 2)).toEqual([0.1, 0.3]);
  });

  it("rejects incomplete rerank payloads", () => {
    expect(() =>
      extractRerankScores({ results: [{ index: 1, score: 0.5 }] }, 2)
    ).toThrow("incomplete rerank scores");
  });
});
