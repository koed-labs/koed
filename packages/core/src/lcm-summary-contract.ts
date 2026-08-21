import { z } from "zod";
import {
  LCM_LEXICAL_ANCHOR_MAX_COUNT,
  LCM_LEXICAL_ANCHOR_MAX_LENGTH
} from "@koed/shared";

export const LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION = "lcm-semantic-summary-v1";
export { LCM_LEXICAL_ANCHOR_MAX_COUNT, LCM_LEXICAL_ANCHOR_MAX_LENGTH };
export const LCM_LEXICAL_ANCHOR_CANDIDATE_MAX_COUNT = 48;
export const LCM_LEXICAL_ANCHOR_CANDIDATE_MAX_LENGTH = 2_048;

const codePointLength = (value: string): number => Array.from(value).length;

const dedupeLexicalAnchors = (values: string[]): string[] => {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const anchor of values) {
    if (!seen.has(anchor)) {
      seen.add(anchor);
      deduped.push(anchor);
    }
  }
  return deduped;
};

const codePointBoundedString = (maximum: number) =>
  z.string().refine((value) => codePointLength(value) <= maximum, {
    message: `String must contain at most ${maximum} Unicode code points`
  });

export const structuredLcmSummaryCandidateSchema = z
  .object({
    schema_version: z.literal(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION),
    title: z.string().trim().min(1).max(120),
    summary_text: z.string().trim().min(1),
    lexical_anchors: z
      .array(codePointBoundedString(LCM_LEXICAL_ANCHOR_CANDIDATE_MAX_LENGTH))
      .max(LCM_LEXICAL_ANCHOR_CANDIDATE_MAX_COUNT)
      .transform(dedupeLexicalAnchors)
  })
  .strict();

export const structuredLcmSummarySchema = z
  .object({
    schema_version: z.literal(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION),
    title: z.string().trim().min(1).max(120),
    summary_text: z.string().trim().min(1),
    lexical_anchors: z
      .array(
        codePointBoundedString(LCM_LEXICAL_ANCHOR_MAX_LENGTH).refine(
          (value) => codePointLength(value) >= 1,
          { message: "String must contain at least 1 Unicode code point" }
        )
      )
      .max(LCM_LEXICAL_ANCHOR_CANDIDATE_MAX_COUNT)
      .transform(dedupeLexicalAnchors)
      .pipe(z.array(z.string()).max(LCM_LEXICAL_ANCHOR_MAX_COUNT))
  })
  .strict();

export type StructuredLcmSummary = z.infer<typeof structuredLcmSummarySchema>;

export interface LcmLexicalAnchorSourceItem {
  kind?: string;
  text?: string;
}

export interface RejectedLcmLexicalAnchor {
  anchor: string;
  reason: "empty" | "too_long" | "unsupported" | "count_limit";
}

export const lcmLexicalAnchorGroundingPayloads = (
  sourceItems: LcmLexicalAnchorSourceItem[]
): string[] =>
  sourceItems.flatMap((item) => {
    const text = item.text ?? "";
    if (item.kind !== "lcm_child") {
      return [text];
    }
    try {
      const parsed = structuredLcmSummarySchema.safeParse(JSON.parse(text));
      return parsed.success
        ? [parsed.data.summary_text, ...parsed.data.lexical_anchors]
        : [text];
    } catch {
      return [text];
    }
  });

export const validateLcmLexicalAnchors = (
  anchors: string[],
  exactSourcePayloads: string[]
): { valid: string[]; rejected: RejectedLcmLexicalAnchor[] } => {
  const valid: string[] = [];
  const rejected: RejectedLcmLexicalAnchor[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    if (seen.has(anchor)) {
      continue;
    }
    seen.add(anchor);
    if (anchor.length === 0) {
      rejected.push({ anchor, reason: "empty" });
    } else if (codePointLength(anchor) > LCM_LEXICAL_ANCHOR_MAX_LENGTH) {
      rejected.push({ anchor, reason: "too_long" });
    } else if (
      !exactSourcePayloads.some((payload) => payload.includes(anchor))
    ) {
      rejected.push({ anchor, reason: "unsupported" });
    } else if (valid.length >= LCM_LEXICAL_ANCHOR_MAX_COUNT) {
      rejected.push({ anchor, reason: "count_limit" });
    } else {
      valid.push(anchor);
    }
  }

  return { valid, rejected };
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
  structuredLcmSummarySchema.parse(JSON.parse(stripJsonFence(text)));

export const parseStructuredLcmSummaryCandidate = (
  text: string
): z.infer<typeof structuredLcmSummaryCandidateSchema> =>
  structuredLcmSummaryCandidateSchema.parse(JSON.parse(stripJsonFence(text)));

export interface StoredLcmSummaryInput {
  summaryText: string;
  structuredSummary?: unknown;
  fallbackTitle?: string;
  pending: boolean;
}

export const normalizeStoredLcmSummary = ({
  summaryText,
  structuredSummary,
  fallbackTitle = "Child memory summary",
  pending
}: StoredLcmSummaryInput): StructuredLcmSummary => {
  const current = structuredLcmSummarySchema.safeParse(structuredSummary);
  if (current.success) {
    return current.data;
  }

  if (
    !pending ||
    (structuredSummary !== undefined && structuredSummary !== null)
  ) {
    throw new Error(
      "Completed LCM summary does not match the current structured summary schema"
    );
  }

  return structuredLcmSummarySchema.parse({
    schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    title: fallbackTitle,
    summary_text: summaryText,
    lexical_anchors: []
  });
};
