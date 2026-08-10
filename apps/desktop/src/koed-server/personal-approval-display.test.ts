import { describe, expect, it } from "vitest";

import { buildPersonalApprovalDisplay } from "./personal-approval-display.js";

describe("Personal Memory Auto Approval display projection", () => {
  it("projects an exact Codex approval decision into bounded semantic fields", () => {
    expect(
      buildPersonalApprovalDisplay({
        actor: "agent",
        metadata: { approvalReview: true },
        content: JSON.stringify({
          risk_level: "medium",
          user_authorization: "high",
          outcome: "allow",
          rationale: "The requested command is bounded and local."
        })
      })
    ).toEqual({
      kind: "auto_approval",
      version: 1,
      riskLevel: "medium",
      userAuthorization: "high",
      outcome: "allow",
      rationale: "The requested command is bounded and local."
    });
  });

  it("supports denied decisions without changing their meaning", () => {
    expect(
      buildPersonalApprovalDisplay({
        actor: "subagent",
        metadata: { approvalReview: true },
        content: JSON.stringify({
          risk_level: "high",
          user_authorization: "low",
          outcome: "deny",
          rationale: "The request exceeds the authorized scope."
        })
      })
    ).toMatchObject({ outcome: "deny", riskLevel: "high" });
  });

  it.each([
    [
      "missing approval-review provenance",
      {
        actor: "agent",
        content: JSON.stringify({
          risk_level: "medium",
          user_authorization: "medium",
          outcome: "allow",
          rationale: "Ordinary assistant JSON."
        })
      }
    ],
    [
      "user actor",
      { actor: "user", content: "{}", metadata: { approvalReview: true } }
    ],
    [
      "ordinary prose",
      {
        actor: "agent",
        content: "Approval allowed",
        metadata: { approvalReview: true }
      }
    ],
    [
      "unknown fields",
      {
        actor: "agent",
        metadata: { approvalReview: true },
        content: JSON.stringify({
          risk_level: "medium",
          user_authorization: "medium",
          outcome: "allow",
          rationale: "Looks safe.",
          secret: "must not cross"
        })
      }
    ],
    [
      "unsupported values",
      {
        actor: "agent",
        metadata: { approvalReview: true },
        content: JSON.stringify({
          risk_level: "critical",
          user_authorization: "medium",
          outcome: "allow",
          rationale: "Looks safe."
        })
      }
    ]
  ])("does not reinterpret %s as an approval decision", (_label, source) => {
    expect(buildPersonalApprovalDisplay(source)).toBeUndefined();
  });
});
