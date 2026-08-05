import {
  approvalDecisionDisplaySchema,
  type ApprovalDecisionDisplay
} from "@koed/shared";

type ApprovalEventSource = {
  actor?: unknown;
  content?: unknown;
};

const sourceKeys = [
  "outcome",
  "rationale",
  "risk_level",
  "user_authorization"
] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const buildPersonalApprovalDisplay = (
  source: ApprovalEventSource
): ApprovalDecisionDisplay | undefined => {
  if (
    !["agent", "assistant", "subagent"].includes(String(source.actor)) ||
    typeof source.content !== "string" ||
    source.content.length > 16_384
  ) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source.content);
  } catch {
    return undefined;
  }
  const value = record(decoded);
  if (
    !value ||
    Object.keys(value).sort().join("\u0000") !==
      [...sourceKeys].sort().join("\u0000")
  ) {
    return undefined;
  }
  return approvalDecisionDisplaySchema.safeParse({
    kind: "auto_approval",
    version: 1,
    riskLevel: value.risk_level,
    userAuthorization: value.user_authorization,
    outcome: value.outcome,
    rationale: value.rationale
  }).data;
};
