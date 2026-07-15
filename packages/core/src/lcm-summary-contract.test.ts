import { describe, expect, it } from "vitest";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  normalizeStoredLcmSummary,
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

  it("normalizes outer whitespace in canonical text fields", () => {
    expect(
      structuredLcmSummarySchema.parse({
        schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
        title: "  Projection fix  ",
        summary_text: "  Projection was fixed.  "
      })
    ).toEqual({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Projection fix",
      summary_text: "Projection was fixed."
    });
  });

  it("parses fenced semantic summary output", () => {
    const parsed = parseStructuredLcmSummary(
      `\`\`\`json\n{"schema_version":"${LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION}","title":"Projection fix","summary_text":"Projection was fixed."}\n\`\`\``
    );

    expect(parsed).toEqual({
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Projection fix",
      summary_text: "Projection was fixed."
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
            summary_text: "Projection was fixed."
          })
        )
      ).toThrow();
    }
  );

  it("rejects unknown worker schemas", () => {
    expect(() =>
      parseStructuredLcmSummary(
        '{"schema_version":"unknown-summary-v9","title":"Unknown","summary_text":"Unknown output"}'
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
    "wraps unsupported stored $schema_version summaries without forwarding their JSON",
    (structuredSummary) => {
      expect(
        normalizeStoredLcmSummary({
          summaryText: "Authoritative stored summary.",
          structuredSummary
        })
      ).toEqual({
        schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
        title: "Child memory summary",
        summary_text: "Authoritative stored summary."
      });
    }
  );
});
