import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMemoryAnswerDetailModes,
  parseToolJson
} from "./personal-joined-smoke-lib.mjs";

const base = (marker) => ({
  markdown: `The durable fact is ${marker}.`,
  localMemoryWorker: { memoryStatus: "found" },
  retrieval: { evidenceCount: 1 }
});

test("validates all memory_answer response detail modes", () => {
  const marker = "joined-marker";
  const summary = assertMemoryAnswerDetailModes(
    {
      answer_only: base(marker),
      with_citations: { ...base(marker), citations: [{ sourceId: "source" }] },
      with_evidence: {
        ...base(marker),
        citations: [{ sourceId: "source" }],
        evidence: [{ sourceId: "source", summaryText: marker }]
      }
    },
    marker
  );
  assert.equal(summary.citationCount, 1);
  assert.equal(summary.evidenceCount, 1);
});

test("rejects evidence in answer_only", () => {
  const marker = "joined-marker";
  assert.throws(
    () =>
      assertMemoryAnswerDetailModes(
        {
          answer_only: { ...base(marker), evidence: [] },
          with_citations: { ...base(marker), citations: [] },
          with_evidence: { ...base(marker), evidence: [{ text: marker }] }
        },
        marker
      ),
    /answer_only leaked/
  );
});

test("parses MCP text content as JSON", () => {
  assert.deepEqual(
    parseToolJson(
      { content: [{ type: "text", text: '{"ok":true}' }] },
      "answer_only"
    ),
    { ok: true }
  );
});
