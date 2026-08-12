import { describe, expect, it } from "vitest";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  lcmLexicalAnchorGroundingPayloads,
  normalizeStoredLcmSummary,
  parseStructuredLcmSummary,
  parseStructuredLcmSummaryCandidate,
  structuredLcmSummarySchema,
  validateLcmLexicalAnchors
} from "./lcm-summary-contract.js";

describe("LCM summary contract", () => {
  it("enforces the canonical title limit", () => {
    expect(
      structuredLcmSummarySchema.safeParse({
        schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
        title: "x".repeat(121),
        summary_text: "Summary",
        lexical_anchors: []
      }).success
    ).toBe(false);
  });

  it("normalizes outer whitespace in canonical text fields", () => {
    expect(
      structuredLcmSummarySchema.parse({
        schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
        title: "  Projection fix  ",
        summary_text: "  Projection was fixed.  ",
        lexical_anchors: ["Projection"]
      })
    ).toEqual({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Projection fix",
      summary_text: "Projection was fixed.",
      lexical_anchors: ["Projection"]
    });
  });

  it("parses fenced semantic summary output", () => {
    const parsed = parseStructuredLcmSummary(
      `\`\`\`json\n{"schema_version":"${LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION}","title":"Projection fix","summary_text":"Projection was fixed.","lexical_anchors":["Projection"]}\n\`\`\``
    );

    expect(parsed).toEqual({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Projection fix",
      summary_text: "Projection was fixed.",
      lexical_anchors: ["Projection"]
    });
  });

  it("bounds untrusted anchor candidates above the canonical repair threshold", () => {
    const candidate = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Candidate bounds",
      summary_text: "Candidate bounds are enforced.",
      lexical_anchors: ["x".repeat(121)]
    };

    expect(
      parseStructuredLcmSummaryCandidate(JSON.stringify(candidate))
        .lexical_anchors
    ).toEqual(candidate.lexical_anchors);
    expect(() =>
      parseStructuredLcmSummaryCandidate(
        JSON.stringify({ ...candidate, lexical_anchors: ["x".repeat(2_049)] })
      )
    ).toThrow();
    expect(() =>
      parseStructuredLcmSummaryCandidate(
        JSON.stringify({
          ...candidate,
          lexical_anchors: Array.from({ length: 49 }, (_, index) => `${index}`)
        })
      )
    ).toThrow();
  });

  it("measures lexical-anchor limits in Unicode code points", () => {
    const canonical = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Unicode bounds",
      summary_text: "Astral characters count once.",
      lexical_anchors: ["🧠".repeat(120)]
    };

    expect(structuredLcmSummarySchema.safeParse(canonical).success).toBe(true);
    expect(
      structuredLcmSummarySchema.safeParse({
        ...canonical,
        lexical_anchors: ["🧠".repeat(121)]
      }).success
    ).toBe(false);
    expect(
      parseStructuredLcmSummaryCandidate(
        JSON.stringify({
          ...canonical,
          lexical_anchors: ["🧠".repeat(2_048)]
        })
      ).lexical_anchors
    ).toEqual(["🧠".repeat(2_048)]);
    expect(() =>
      parseStructuredLcmSummaryCandidate(
        JSON.stringify({
          ...canonical,
          lexical_anchors: ["🧠".repeat(2_049)]
        })
      )
    ).toThrow();
  });

  it("deduplicates exact anchors in first-seen order before count enforcement", () => {
    const decomposed = "Cafe\u0301";
    const composed = "Caf\u00e9";
    const parsed = structuredLcmSummarySchema.parse({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Normalized anchors",
      summary_text: "Canonical anchors are deterministic.",
      lexical_anchors: [decomposed, composed, "memory_answer", "memory_answer"]
    });

    expect(parsed.lexical_anchors).toEqual([
      decomposed,
      composed,
      "memory_answer"
    ]);
    expect(
      structuredLcmSummarySchema.safeParse({
        ...parsed,
        lexical_anchors: Array.from(
          { length: 13 },
          (_, index) => `unique-${index}`
        )
      }).success
    ).toBe(false);
    expect(
      structuredLcmSummarySchema.parse({
        ...parsed,
        lexical_anchors: Array.from({ length: 13 }, () => "memory_answer")
      }).lexical_anchors
    ).toEqual(["memory_answer"]);
  });

  it("validates exact contiguous, case-sensitive anchors without Unicode folding", () => {
    const validation = validateLcmLexicalAnchors(
      [
        "Cafe\u0301",
        "Caf\u00e9",
        "memory_answer",
        "Memory_Answer",
        "memory answer"
      ],
      ["The Caf\u00e9 worker invokes memory_answer directly."]
    );

    expect(validation.valid).toEqual(["Caf\u00e9", "memory_answer"]);
    expect(validation.rejected).toEqual([
      { anchor: "Cafe\u0301", reason: "unsupported" },
      { anchor: "Memory_Answer", reason: "unsupported" },
      { anchor: "memory answer", reason: "unsupported" }
    ]);
  });

  it("grounds rollups only in child summary text and validated child anchors", () => {
    const payloads = lcmLexicalAnchorGroundingPayloads([
      {
        kind: "lcm_child",
        text: JSON.stringify({
          schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
          title: "Title must not become source material",
          summary_text: "Child summary carries semantic context.",
          lexical_anchors: ["REQUEST_BODY_LIMIT_BYTES"]
        })
      }
    ]);

    expect(payloads).toEqual([
      "Child summary carries semantic context.",
      "REQUEST_BODY_LIMIT_BYTES"
    ]);
    expect(
      validateLcmLexicalAnchors(
        ["semantic context", "REQUEST_BODY_LIMIT_BYTES", "Title must not"],
        payloads
      )
    ).toEqual({
      valid: ["semantic context", "REQUEST_BODY_LIMIT_BYTES"],
      rejected: [{ anchor: "Title must not", reason: "unsupported" }]
    });
  });

  it.each(["lcm-structured-summary-v1", "lcm-semantic-summary-v2"])(
    "rejects superseded %s worker output",
    (schemaVersion) => {
      expect(() =>
        parseStructuredLcmSummary(
          JSON.stringify({
            schema_version: schemaVersion,
            title: "Projection fix",
            summary_text: "Projection was fixed.",
            lexical_anchors: []
          })
        )
      ).toThrow();
    }
  );

  it("rejects unknown worker schemas", () => {
    expect(() =>
      parseStructuredLcmSummary(
        '{"schema_version":"unknown-summary-v9","title":"Unknown","summary_text":"Unknown output","lexical_anchors":[]}'
      )
    ).toThrow();
  });

  it.each([
    {
      schema_version: "lcm-structured-summary-v1",
      title: "Legacy title",
      summary_text: "Legacy structured text",
      decisions: ["Do not forward this value."]
    },
    {
      schema_version: "lcm-semantic-summary-v2",
      title: "Superseded semantic title",
      summary_text: "Superseded semantic text."
    }
  ])(
    "rejects completed stored $schema_version summaries",
    (structuredSummary) => {
      expect(() =>
        normalizeStoredLcmSummary({
          summaryText: "Authoritative stored summary.",
          structuredSummary,
          pending: false
        })
      ).toThrow(
        "Completed LCM summary does not match the current structured summary schema"
      );
    }
  );

  it("preserves a legitimate pending placeholder without legacy structured JSON", () => {
    expect(
      normalizeStoredLcmSummary({
        summaryText: "Deterministic pending child placeholder.",
        structuredSummary: null,
        pending: true
      })
    ).toEqual({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Child memory summary",
      summary_text: "Deterministic pending child placeholder.",
      lexical_anchors: []
    });
  });
});
