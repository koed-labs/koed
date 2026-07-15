import { describe, expect, it } from "vitest";
import { pdsConversationItemsForClosure } from "./local-source.js";

const source = {
  groupDbId: "group-db",
  groupId: "opaque-group",
  sessionId: "session",
  externalSessionId: "source-session",
  sourceAdapter: "codex",
  sourceAdapterVersion: "v1",
  sourceCreatedAt: "2026-07-15T00:00:00.000Z",
  items: [
    {
      id: "item",
      externalItemId: "source-item",
      sourceSequence: 0,
      eventTime: "2026-07-15T00:00:01.000Z",
      observedAt: "2026-07-15T00:00:02.000Z",
      rawJson: { content: "captured source" },
      rawText: "captured source",
      sourceKind: "codex",
      sourceRecordType: "message",
      sourceEventType: null,
      metadata: { sourceRole: "user", ignored: "not exported" }
    }
  ]
};

describe("PDS source closure sanitizer", () => {
  it("keeps only immutable source profile fields", () => {
    expect(pdsConversationItemsForClosure(source)).toEqual([
      expect.objectContaining({
        sourceNativeItemId: "source-item",
        sequence: "0",
        content: "captured source",
        metadata: { sourceRole: "user" }
      })
    ]);
  });

  it.each([
    { apiToken: "secret" },
    { API_TOKEN: "secret" },
    { nested: { credential: "secret" } },
    { params: { item: { path: "/secret" } } },
    { Team: { name: "derived" } },
    { derivedMemory: true }
  ])("rejects sensitive nested source field %#", (rawJson) => {
    expect(() =>
      pdsConversationItemsForClosure({
        ...source,
        items: [{ ...source.items[0]!, rawJson }]
      })
    ).toThrow("PDS source contains forbidden field");
  });

  it("never serializes arbitrary raw JSON when raw text is unavailable", () => {
    expect(() =>
      pdsConversationItemsForClosure({
        ...source,
        items: [{ ...source.items[0]!, rawText: null, rawJson: { other: "x" } }]
      })
    ).toThrow("PDS source adapter payload is not exportable");
  });
});
