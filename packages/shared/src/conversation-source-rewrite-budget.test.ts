import { describe, expect, it } from "vitest";
import {
  CONVERSATION_SOURCE_REWRITE_MAX_PROOF_BYTES,
  conversationSourceRewriteProofWithinLimit
} from "./conversation-source-replication.js";

describe("conversation source rewrite proof budget", () => {
  it("bounds predecessor, prefix and ancestry as one proof", () => {
    expect(conversationSourceRewriteProofWithinLimit([35, 35], 64)).toBe(false);
    expect(conversationSourceRewriteProofWithinLimit([20, 20, 25], 64)).toBe(
      false
    );
    expect(conversationSourceRewriteProofWithinLimit([20, 20, 24], 64)).toBe(
      true
    );
    expect(
      conversationSourceRewriteProofWithinLimit([
        CONVERSATION_SOURCE_REWRITE_MAX_PROOF_BYTES
      ])
    ).toBe(true);
    expect(
      conversationSourceRewriteProofWithinLimit([
        CONVERSATION_SOURCE_REWRITE_MAX_PROOF_BYTES,
        1
      ])
    ).toBe(false);
  });

  it("rejects invalid proof lengths", () => {
    for (const length of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(conversationSourceRewriteProofWithinLimit([length])).toBe(false);
    }
  });
});
