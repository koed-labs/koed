import { describe, expect, it } from "vitest";
import {
  approvalConversationItemSql,
  semanticMemoryEventEligibleSql
} from "./approval-activity-sql.js";

describe("Approval Activity SQL policy", () => {
  it("keeps every trusted classifier marker in semantic Memory Event reads", () => {
    const predicate = semanticMemoryEventEligibleSql("me");

    expect(predicate).toContain("me.payload -> 'metadata'");
    expect(predicate).toContain("approvalReview");
    expect(predicate).toContain("approvalActivity");
    expect(predicate).toContain("approvalKind");
    expect(predicate).toContain("providerApprovalKind");
    expect(predicate).toContain("transcriptType");
    expect(predicate).toContain("toolEventKind");
    expect(predicate).toContain("approval_source.memory_event_id = me.id");
  });

  it("uses the same trusted markers for linked Conversation Items", () => {
    const predicate = approvalConversationItemSql("ci");

    expect(predicate).toContain("ci.metadata");
    expect(predicate).toContain("approvalHelperConversation");
    expect(predicate).toContain("approval_specific_tool_result");
  });
});
