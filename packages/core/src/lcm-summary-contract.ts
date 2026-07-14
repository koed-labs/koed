import { z } from "zod";

export const LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION = "lcm-semantic-summary-v2";
export const LEGACY_LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION =
  "lcm-structured-summary-v1";

const legacySemanticFields = [
  "user_requests",
  "decisions",
  "facts",
  "files",
  "commands",
  "model_names",
  "tool_outcomes",
  "errors",
  "unresolved_questions",
  "provenance_hints"
] as const;

export const structuredLcmSummarySchema = z
  .object({
    schema_version: z.literal(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION),
    title: z.string().min(1).max(120),
    summary_text: z.string().min(1)
  })
  .strict();

const legacyStructuredLcmSummarySchema = z
  .object({
    schema_version: z.literal(LEGACY_LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION),
    title: z.string().min(1).max(120),
    summary_text: z.string().min(1),
    user_requests: z.array(z.string()).default([]),
    decisions: z.array(z.string()).default([]),
    facts: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    model_names: z.array(z.string()).default([]),
    tool_outcomes: z.array(z.string()).default([]),
    errors: z.array(z.string()).default([]),
    unresolved_questions: z.array(z.string()).default([]),
    provenance_hints: z.array(z.string()).default([])
  })
  .passthrough();

export type StructuredLcmSummary = z.infer<typeof structuredLcmSummarySchema>;

const semanticParts = (values: string[]): string[] => {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    parts.push(normalized);
  }
  return parts;
};

type LegacyStructuredLcmSummary = z.infer<
  typeof legacyStructuredLcmSummarySchema
>;

const canonicalFromLegacy = (
  legacy: LegacyStructuredLcmSummary
): StructuredLcmSummary => ({
  schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  title: legacy.title,
  summary_text: semanticParts([
    legacy.summary_text,
    ...legacySemanticFields.flatMap((field) => legacy[field])
  ]).join("\n")
});

export const normalizeStructuredLcmSummary = (
  value: unknown
): StructuredLcmSummary => {
  const schemaVersion =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "schema_version" in value
      ? value.schema_version
      : undefined;
  if (schemaVersion === LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION) {
    return structuredLcmSummarySchema.parse(value);
  }
  if (schemaVersion === LEGACY_LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION) {
    return canonicalFromLegacy(legacyStructuredLcmSummarySchema.parse(value));
  }
  return structuredLcmSummarySchema.parse(value);
};

const stripJsonFence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const unfenced = fenced ? (fenced[1] ?? "").trim() : trimmed;
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  return firstBrace >= 0 && lastBrace > firstBrace
    ? unfenced.slice(firstBrace, lastBrace + 1)
    : unfenced;
};

export const parseStructuredLcmSummary = (text: string): StructuredLcmSummary =>
  normalizeStructuredLcmSummary(JSON.parse(stripJsonFence(text)));

export interface StoredLcmSummaryInput {
  summaryText: string;
  structuredSummary?: unknown;
  fallbackTitle?: string;
}

export const normalizeStoredLcmSummary = ({
  summaryText,
  structuredSummary,
  fallbackTitle = "Child memory summary"
}: StoredLcmSummaryInput): StructuredLcmSummary => {
  if (structuredSummary !== null && structuredSummary !== undefined) {
    const current = structuredLcmSummarySchema.safeParse(structuredSummary);
    if (current.success) {
      return current.data;
    }
    const legacy =
      legacyStructuredLcmSummarySchema.safeParse(structuredSummary);
    if (legacy.success) {
      return canonicalFromLegacy(legacy.data);
    }
  }

  return structuredLcmSummarySchema.parse({
    schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    title: fallbackTitle,
    summary_text: summaryText
  });
};
