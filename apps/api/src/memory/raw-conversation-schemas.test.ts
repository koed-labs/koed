import { describe, expect, it } from "vitest";
import { createConversationItemsSchema } from "./raw-conversation-schemas.js";

const piItem = {
  sessionId: "12345678-1234-4234-8234-123456789abc",
  sourceKind: "pi",
  sourceAdapterVersion: "pi-session-v1",
  sourceTransport: "transcript",
  sourceRecordType: "message",
  rawJson: {},
  sourceHash: "fixture-hash",
  idempotencyKey: "fixture-item"
};

describe("Pi transcript item ingestion", () => {
  it.each(["call_abc", "call_abc|fc_def", "call_abc|ctc_def"])(
    "preserves tool call ID %s in a transcript batch",
    (toolCallId) => {
      const result = createConversationItemsSchema.parse({
        items: [piItem, { ...piItem, metadata: { toolCallId } }]
      });
      expect(result.items[1]?.metadata.toolCallId).toBe(toolCallId);
    }
  );

  it.each([
    "call_abc||fc_def",
    "call_abc|",
    "call_abc|fc def",
    "a".repeat(513)
  ])("rejects malformed or oversized tool call IDs (%s)", (toolCallId) => {
    expect(
      createConversationItemsSchema.safeParse({
        items: [{ ...piItem, metadata: { toolCallId } }]
      }).success
    ).toBe(false);
  });

  it("does not allow compound IDs in external session identifiers", () => {
    expect(
      createConversationItemsSchema.safeParse({
        items: [{ ...piItem, externalSessionId: "call_abc|fc_def" }]
      }).success
    ).toBe(false);
  });
});
