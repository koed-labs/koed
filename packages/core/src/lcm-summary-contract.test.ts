import { describe, expect, it } from "vitest";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  normalizeStoredLcmSummary,
  normalizeStructuredLcmSummary,
  parseStructuredLcmSummary,
  structuredLcmSummarySchema
} from "./lcm-summary-contract.js";

describe("LCM summary contract", () => {
  it("enforces the canonical title limit", () => {
    expect(
      structuredLcmSummarySchema.safeParse({
        schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
        title: "x".repeat(121),
        summary_text: "Summary"
      }).success
    ).toBe(false);
  });

  it("normalizes known legacy fields into canonical summary text", () => {
    expect(
      normalizeStructuredLcmSummary({
        schema_version: "lcm-structured-summary-v1",
        title: "Credential policy",
        summary_text: "Use scoped device credentials.",
        decisions: ["Use scoped device credentials."],
        unresolved_questions: ["Determine the revocation TTL."],
        arbitrary_field: ["Do not forward this value."]
      })
    ).toEqual({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Credential policy",
      summary_text:
        "Use scoped device credentials.\nDetermine the revocation TTL."
    });
  });

  it("parses fenced legacy worker output into the canonical contract", () => {
    const parsed = parseStructuredLcmSummary(
      '```json\n{"schema_version":"lcm-structured-summary-v1","title":"Projection fix","summary_text":"Projection was fixed.","tool_outcomes":["Tests passed."]}\n```'
    );

    expect(parsed).toEqual({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Projection fix",
      summary_text: "Projection was fixed.\nTests passed."
    });
  });

  it("rejects unknown worker schemas", () => {
    expect(() =>
      normalizeStructuredLcmSummary({
        schema_version: "unknown-summary-v9",
        title: "Unknown",
        summary_text: "Unknown output"
      })
    ).toThrow();
  });

  it("wraps unstructured stored summaries without forwarding unknown JSON", () => {
    expect(
      normalizeStoredLcmSummary({
        summaryText: "Authoritative stored summary.",
        structuredSummary: {
          schema_version: "unknown-summary-v9",
          title: "Untrusted title",
          summary_text: "Untrusted structured text",
          secret: "do not forward"
        }
      })
    ).toEqual({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Child memory summary",
      summary_text: "Authoritative stored summary."
    });
  });
});
