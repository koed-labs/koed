import { z } from "zod";

import {
  approvalDecisionDisplaySchema,
  approvalReviewTranscriptDisplaySchema
} from "./personal-desktop-contract.js";

export const approvalActivityKindSchema = z.enum([
  "approval_review_envelope",
  "approval_request",
  "approval_decision",
  "automatic_approval_decision",
  "approval_tool_result",
  "approval_helper_conversation",
  "unknown_approval_record"
]);

export const approvalActivityExclusionReasonSchema = z.enum([
  "approval_activity:review_envelope",
  "approval_activity:request",
  "approval_activity:decision",
  "approval_activity:automatic_decision",
  "approval_activity:tool_result",
  "approval_activity:helper_conversation",
  "approval_activity:unknown_trusted_record"
]);

export const approvalActivityDisplaySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("approval_review"),
      label: z.literal("Approval activity"),
      transcript: approvalReviewTranscriptDisplaySchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval_decision"),
      label: z.literal("Approval activity"),
      decision: approvalDecisionDisplaySchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval_status"),
      label: z.literal("Approval activity"),
      status: z.enum([
        "request",
        "decision",
        "tool_result",
        "helper_conversation",
        "incomplete"
      ])
    })
    .strict()
]);

export const approvalActivityClassificationSchema = z
  .object({
    kind: approvalActivityKindSchema,
    exclusionReason: approvalActivityExclusionReasonSchema,
    display: approvalActivityDisplaySchema.optional()
  })
  .strict();

export type ApprovalActivityKind = z.infer<typeof approvalActivityKindSchema>;
export type ApprovalActivityExclusionReason = z.infer<
  typeof approvalActivityExclusionReasonSchema
>;
export type ApprovalActivityDisplay = z.infer<
  typeof approvalActivityDisplaySchema
>;
export type ApprovalActivityClassification = z.infer<
  typeof approvalActivityClassificationSchema
>;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalized = (value: unknown): string | null =>
  typeof value === "string" ? value.trim().toLowerCase() : null;

const trustedKind = (
  metadata: Record<string, unknown>,
  actor?: unknown,
  content?: unknown
): ApprovalActivityKind | null => {
  const explicit = approvalActivityKindSchema.safeParse(
    record(metadata.approvalActivity)?.kind
  );
  if (explicit.success) return explicit.data;

  const transcriptType = normalized(metadata.transcriptType);
  const toolEventKind = normalized(metadata.toolEventKind);
  const providerKind = normalized(
    metadata.approvalKind ?? metadata.providerApprovalKind
  );
  const kind = providerKind ?? transcriptType ?? toolEventKind;
  if (
    kind &&
    [
      "approval_request",
      "request_approval",
      "exec_command_approval_request",
      "apply_patch_approval_request"
    ].includes(kind)
  ) {
    return "approval_request";
  }
  if (
    kind &&
    ["approval_decision", "approval_response", "approval_result"].includes(kind)
  ) {
    return "approval_decision";
  }
  if (
    kind &&
    ["automatic_approval_decision", "auto_approval_decision"].includes(kind)
  ) {
    return "automatic_approval_decision";
  }
  if (
    kind &&
    ["approval_tool_result", "approval_specific_tool_result"].includes(kind)
  ) {
    return "approval_tool_result";
  }
  if (metadata.approvalHelperConversation === true) {
    return "approval_helper_conversation";
  }
  if (metadata.approvalReview === true) {
    if (metadata.approvalReviewTranscriptDisplay !== undefined) {
      return "approval_review_envelope";
    }
    if (
      ["agent", "assistant", "subagent"].includes(String(actor)) &&
      automaticDecision(content)
    ) {
      return "automatic_approval_decision";
    }
    return "approval_helper_conversation";
  }
  if (
    Object.prototype.hasOwnProperty.call(metadata, "approvalActivity") ||
    Object.prototype.hasOwnProperty.call(metadata, "approvalKind") ||
    Object.prototype.hasOwnProperty.call(metadata, "providerApprovalKind") ||
    transcriptType?.startsWith("approval_")
  ) {
    return "unknown_approval_record";
  }
  return null;
};

const reasonForKind = (
  kind: ApprovalActivityKind
): ApprovalActivityExclusionReason => {
  switch (kind) {
    case "approval_review_envelope":
      return "approval_activity:review_envelope";
    case "approval_request":
      return "approval_activity:request";
    case "approval_decision":
      return "approval_activity:decision";
    case "automatic_approval_decision":
      return "approval_activity:automatic_decision";
    case "approval_tool_result":
      return "approval_activity:tool_result";
    case "approval_helper_conversation":
      return "approval_activity:helper_conversation";
    case "unknown_approval_record":
      return "approval_activity:unknown_trusted_record";
  }
};

const displayFor = (
  kind: ApprovalActivityKind,
  metadata: Record<string, unknown>,
  actor?: unknown,
  content?: unknown
): ApprovalActivityDisplay => {
  const trustedDisplay = approvalActivityDisplaySchema.safeParse(
    record(metadata.approvalActivity)?.display
  );
  if (trustedDisplay.success) return trustedDisplay.data;

  const transcript = approvalReviewTranscriptDisplaySchema.safeParse(
    metadata.approvalReviewTranscriptDisplay
  );
  if (kind === "approval_review_envelope" && transcript.success) {
    return {
      kind: "approval_review",
      label: "Approval activity",
      transcript: transcript.data
    };
  }
  const decision = automaticDecision(content);
  if (
    kind === "automatic_approval_decision" &&
    ["agent", "assistant", "subagent"].includes(String(actor)) &&
    decision
  ) {
    return {
      kind: "approval_decision",
      label: "Approval activity",
      decision
    };
  }
  return {
    kind: "approval_status",
    label: "Approval activity",
    status:
      kind === "approval_request"
        ? "request"
        : kind === "approval_decision" || kind === "automatic_approval_decision"
          ? "decision"
          : kind === "approval_tool_result"
            ? "tool_result"
            : kind === "approval_helper_conversation"
              ? "helper_conversation"
              : "incomplete"
  };
};

/**
 * Classifies only records carrying trusted adapter/provider structure. Text is
 * deliberately not inspected: quoting approval language is ordinary content.
 */
export const classifyApprovalActivity = (input: {
  metadata?: unknown;
  actor?: unknown;
  content?: unknown;
}): ApprovalActivityClassification | null => {
  const metadata = record(input.metadata) ?? {};
  const kind = trustedKind(metadata, input.actor, input.content);
  if (!kind) return null;
  return approvalActivityClassificationSchema.parse({
    kind,
    exclusionReason: reasonForKind(kind),
    display: displayFor(kind, metadata, input.actor, input.content)
  });
};

export const approvalActivityMetadata = (input: {
  metadata?: unknown;
  actor?: unknown;
  content?: unknown;
}): Record<string, unknown> => {
  const metadata = record(input.metadata) ?? {};
  const classification = classifyApprovalActivity({ ...input, metadata });
  return classification
    ? {
        ...metadata,
        approvalActivity: classification
      }
    : metadata;
};

const automaticDecision = (value: unknown) => {
  if (typeof value !== "string" || value.length > 16_384) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }
  const candidate = record(decoded);
  if (
    !candidate ||
    Object.keys(candidate).sort().join("\u0000") !==
      ["outcome", "rationale", "risk_level", "user_authorization"]
        .sort()
        .join("\u0000")
  ) {
    return null;
  }
  return approvalDecisionDisplaySchema.safeParse({
    kind: "auto_approval",
    version: 1,
    riskLevel: candidate.risk_level,
    userAuthorization: candidate.user_authorization,
    outcome: candidate.outcome,
    rationale: candidate.rationale
  }).data;
};
