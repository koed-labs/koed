import { describe, expect, it } from "vitest";
import {
  evidenceSelectedByAnswer,
  MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
  parseStructuredMemoryAnswer
} from "../src/answer-worker.js";

const summary = {
  sourceType: "memory_node",
  sourceId: "owner-summary",
  nodeId: "owner-summary",
  sourceChunkIndex: 0,
  sourceGeneration: "current-revision",
  visibility: "personal",
  summaryRepresentation: "complete_summary",
  summaryText: "Authorized complete retained body"
};

const answer = (chunk: number) =>
  parseStructuredMemoryAnswer({
    schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
    memory_status: "found",
    relevant_memory_found: true,
    answer_markdown: "Supported decision",
    relevance_explanation: "Evidence supports the decision",
    evidence: [
      {
        source_type: "memory_node",
        source_id: summary.sourceId,
        source_chunk_index: chunk,
        relevance: "direct",
        support: "decision",
        summaryText: "Model supplied replacement body",
        summaryRepresentation: "complete_summary"
      }
    ],
    missing: [],
    missing_evidence: []
  });

describe("summary citation adversarial regressions", () => {
  it("does not resolve stale-generation or different-visibility chunk aliases", () => {
    for (const alias of [
      { ...summary, sourceChunkIndex: 7, sourceGeneration: "retired-revision" },
      { ...summary, sourceChunkIndex: 7, visibility: "team" },
      { ...summary, sourceChunkIndex: 7, sourceId: "unrelated-summary" }
    ]) {
      expect(() =>
        evidenceSelectedByAnswer(
          [{ ...summary, observedReferences: [alias] }],
          answer(7)
        )
      ).toThrow();
    }
  });

  it("resolves only same-generation admitted aliases and never substitutes model bodies", () => {
    const selected = evidenceSelectedByAnswer(
      [
        {
          ...summary,
          observedReferences: [{ ...summary, sourceChunkIndex: 7 }]
        }
      ],
      answer(7)
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      summaryText: summary.summaryText,
      summaryRepresentation: "complete_summary",
      sourceGeneration: "current-revision"
    });
    const filtered = {
      ...summary,
      summaryText: "Selected source outline",
      summaryRepresentation: "filtered_sources"
    };
    expect(evidenceSelectedByAnswer([filtered], answer(0))[0]).toMatchObject({
      summaryText: "Selected source outline",
      summaryRepresentation: "filtered_sources"
    });
  });
});
