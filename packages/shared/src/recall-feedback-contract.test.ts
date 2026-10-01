import { describe, expect, it } from "vitest";
import {
  putRecallFeedbackInputSchema,
  recallFeedbackMessageIdSchema,
  recallFeedbackResponseSchema
} from "./recall-feedback-contract.js";

const id = "11111111-1111-4111-8111-111111111111";

describe("recall feedback contract", () => {
  it("accepts exact managed answer identities and independent field updates", () => {
    expect(recallFeedbackMessageIdSchema.parse(`provider:${id}`)).toBe(
      `provider:${id}`
    );
    expect(recallFeedbackMessageIdSchema.parse(`agent:${id}`)).toBe(
      `agent:${id}`
    );
    expect(putRecallFeedbackInputSchema.parse({ rating: "up" })).toEqual({
      rating: "up"
    });
    expect(putRecallFeedbackInputSchema.parse({ comment: "Helpful" })).toEqual({
      comment: "Helpful"
    });
  });

  it("rejects unknown fields, empty updates, malformed IDs, and oversized comments", () => {
    expect(putRecallFeedbackInputSchema.safeParse({}).success).toBe(false);
    expect(
      putRecallFeedbackInputSchema.safeParse({ rating: "up", extra: true })
        .success
    ).toBe(false);
    expect(recallFeedbackMessageIdSchema.safeParse(`other:${id}`).success).toBe(
      false
    );
    expect(
      putRecallFeedbackInputSchema.safeParse({ comment: "x".repeat(4_001) })
        .success
    ).toBe(false);
    expect(
      putRecallFeedbackInputSchema.safeParse({ comment: "é".repeat(8_193) })
        .success
    ).toBe(false);
    expect(
      putRecallFeedbackInputSchema.safeParse({ comment: "😀".repeat(2_000) })
        .success
    ).toBe(true);
    expect(
      // 2,001 Unicode code points but 4,002 UTF-16 code units, matching Studio.
      putRecallFeedbackInputSchema.safeParse({ comment: "😀".repeat(2_001) })
        .success
    ).toBe(false);
  });

  it("validates the response without source citations or answer content", () => {
    expect(
      recallFeedbackResponseSchema.parse({
        feedback: {
          rating: "down",
          comment: "Missing context",
          updatedAt: "2026-09-10T12:00:00.000Z"
        }
      })
    ).toMatchObject({ feedback: { rating: "down" } });
    expect(
      recallFeedbackResponseSchema.safeParse({
        feedback: null,
        citations: []
      }).success
    ).toBe(false);
  });
});
