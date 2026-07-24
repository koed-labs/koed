import { LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION } from "@koed/core";
import { describe, expect, it } from "vitest";
import { submitLcmSummarySchema } from "./lcm-schemas.js";

const validSubmission = () => ({
  summaryText: "Use scoped device credentials.",
  summaryModel: "codex:test",
  summaryPromptVersion: "lcm-codex-summary-json-v3",
  summaryTokenEstimate: 8,
  summaryStructuredJson: {
    schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    title: "Device credentials",
    summary_text: "Use scoped device credentials."
  },
  summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
});

describe("LCM summary submission schema", () => {
  it("accepts the canonical semantic summary contract", () => {
    expect(submitLcmSummarySchema.parse(validSubmission())).toMatchObject(
      validSubmission()
    );
  });

  it("rejects submissions without structured metadata", () => {
    const { summaryStructuredJson, summaryStructuredSchemaVersion, ...input } =
      validSubmission();
    void summaryStructuredJson;
    void summaryStructuredSchemaVersion;

    expect(() => submitLcmSummarySchema.parse(input)).toThrow(
      /summaryStructuredJson/
    );
  });

  it("rejects unsupported structured summary contracts", () => {
    const input = validSubmission();
    input.summaryStructuredJson.schema_version =
      "lcm-structured-summary-v1" as typeof LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION;

    expect(() => submitLcmSummarySchema.parse(input)).toThrow(/schema_version/);
  });

  it("rejects mismatched structured schema metadata", () => {
    const input = validSubmission();
    input.summaryStructuredSchemaVersion =
      "lcm-semantic-summary-v2" as typeof LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION;

    expect(() => submitLcmSummarySchema.parse(input)).toThrow(
      /summaryStructuredSchemaVersion/
    );
  });

  it("rejects structured text that differs from summaryText", () => {
    const input = validSubmission();
    input.summaryStructuredJson.summary_text = "Different summary.";

    expect(() => submitLcmSummarySchema.parse(input)).toThrow(
      /summaryText must match/
    );
  });
});
