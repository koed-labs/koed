import { describe, expect, it } from "vitest";

import {
  approvalActivityMetadata,
  classifyApprovalActivity
} from "./approval-activity.js";

describe("Approval Activity classification", () => {
  it("classifies a trusted approval-review envelope without inspecting prose", () => {
    const transcript = {
      kind: "approval_review" as const,
      version: 1 as const,
      truncated: false,
      segments: [
        {
          kind: "message" as const,
          sequence: 1,
          actor: "user" as const,
          content: "Run the checks."
        }
      ]
    };
    expect(
      classifyApprovalActivity({
        metadata: {
          approvalReview: true,
          approvalReviewTranscriptDisplay: transcript
        }
      })
    ).toEqual({
      kind: "approval_review_envelope",
      exclusionReason: "approval_activity:review_envelope",
      display: {
        kind: "approval_review",
        label: "Approval activity",
        transcript
      }
    });
  });

  it("classifies an exact automatic decision only inside trusted provenance", () => {
    const content = JSON.stringify({
      risk_level: "medium",
      user_authorization: "high",
      outcome: "allow",
      rationale: "The operation is bounded."
    });
    expect(
      approvalActivityMetadata({
        actor: "agent",
        content,
        metadata: { approvalReview: true }
      })
    ).toMatchObject({
      approvalActivity: {
        kind: "automatic_approval_decision",
        exclusionReason: "approval_activity:automatic_decision",
        display: {
          kind: "approval_decision",
          decision: { outcome: "allow" }
        }
      }
    });
    expect(
      classifyApprovalActivity({ actor: "agent", content, metadata: {} })
    ).toBeNull();
  });

  it("does not classify ordinary text that discusses approvals", () => {
    expect(
      classifyApprovalActivity({
        actor: "user",
        content: "Please explain approval requests and automatic decisions.",
        metadata: { transcriptType: "user_message" }
      })
    ).toBeNull();
  });

  it("fails closed for an incomplete trusted helper record", () => {
    expect(
      classifyApprovalActivity({
        metadata: { approvalReview: true, threadKind: "subagent" }
      })
    ).toMatchObject({
      kind: "approval_helper_conversation",
      exclusionReason: "approval_activity:helper_conversation",
      display: { kind: "approval_status", status: "helper_conversation" }
    });
  });

  it.each([
    ["approval_request", "approval_request", "approval_activity:request"],
    ["approval_decision", "approval_decision", "approval_activity:decision"],
    [
      "automatic_approval_decision",
      "automatic_approval_decision",
      "approval_activity:automatic_decision"
    ],
    [
      "approval_specific_tool_result",
      "approval_tool_result",
      "approval_activity:tool_result"
    ]
  ] as const)(
    "classifies trusted provider kind %s",
    (providerApprovalKind, kind, exclusionReason) => {
      expect(
        classifyApprovalActivity({ metadata: { providerApprovalKind } })
      ).toMatchObject({ kind, exclusionReason });
    }
  );

  it("marks an unknown trusted provider record as ambiguous and bounded", () => {
    expect(
      classifyApprovalActivity({
        metadata: { providerApprovalKind: "approval_future_kind" },
        content: "raw provider prompt that must not become ordinary content"
      })
    ).toEqual({
      kind: "unknown_approval_record",
      exclusionReason: "approval_activity:unknown_trusted_record",
      display: {
        kind: "approval_status",
        label: "Approval activity",
        status: "incomplete"
      }
    });
  });
});
