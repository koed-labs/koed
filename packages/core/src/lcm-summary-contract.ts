import { z } from "zod";

export const LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION = "lcm-semantic-summary-v1";

export const structuredLcmSummarySchema = z
  .object({
    schema_version: z.literal(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION),
    title: z.string().trim().min(1).max(120),
    summary_text: z.string().trim().min(1)
  })
  .strict();

export type StructuredLcmSummary = z.infer<typeof structuredLcmSummarySchema>;

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
  structuredLcmSummarySchema.parse(JSON.parse(stripJsonFence(text)));

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
  const current = structuredLcmSummarySchema.safeParse(structuredSummary);
  if (current.success) {
    return current.data;
  }

  return structuredLcmSummarySchema.parse({
    schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    title: fallbackTitle,
    summary_text: summaryText
  });
};
