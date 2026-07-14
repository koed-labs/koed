import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CURATED_MEMORY_REVIEW_MAX_EVIDENCE } from "@koed/shared";
import {
  curatedMemoryProposalSchema,
  curatedMemoryReviewResultSchema
} from "./curated-memory-schemas.js";

describe("Curated Memory API contracts", () => {
  const evidenceRevisions = Array.from(
    { length: CURATED_MEMORY_REVIEW_MAX_EVIDENCE + 1 },
    () => ({
      source_type: "conversation_item" as const,
      source_id: randomUUID(),
      source_hash: randomUUID()
    })
  );

  it("rejects proposals whose combined evidence exceeds the review limit", () => {
    expect(() =>
      curatedMemoryProposalSchema.parse({
        proposed_claim: "Bounded evidence",
        evidence_conversation_item_ids: evidenceRevisions
          .slice(0, 7)
          .map((item) => item.source_id),
        evidence_memory_event_ids: evidenceRevisions
          .slice(7)
          .map((item) => item.source_id)
      })
    ).toThrow(`At most ${CURATED_MEMORY_REVIEW_MAX_EVIDENCE} total`);
  });

  it.each(["accepted", "rejected"] as const)(
    "rejects oversized %s review submissions",
    (outcome) => {
      const common = {
        outcome,
        attempt_count: 1,
        evidence_revisions: evidenceRevisions,
        selected_evidence_ids: [],
        candidate_assertion_ids: [],
        decision_reason: "Terminal decision"
      };
      expect(() =>
        curatedMemoryReviewResultSchema.parse(
          outcome === "accepted"
            ? {
                ...common,
                operation: "store",
                assertion_text: "Bounded evidence",
                sensitivity: "normal",
                confidence: 90,
                expires_at: null,
                reviewer_model: "test",
                reviewer_prompt_version: "test"
              }
            : common
        )
      ).toThrow();
    }
  );

  it("requires an exact quote when only a workspace is supplied", () => {
    expect(() =>
      curatedMemoryProposalSchema.parse({
        proposed_claim: "Ambiguous evidence",
        source_workspace_id: "/workspace"
      })
    ).toThrow("exact user quote");
  });
});
