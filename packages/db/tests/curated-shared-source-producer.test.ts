import { describe, expect, it } from "vitest";

import {
  curatedConversationSourceText,
  curatedDirectSourceRevisionHash
} from "../src/curated-shared-source-producer.js";

describe("Curated canonical Conversation source text", () => {
  it("reads owner-scoped plaintext canonical capture", () => {
    expect(
      curatedConversationSourceText(
        { rawText: "captured source", metadata: {} },
        undefined
      )
    ).toBe("captured source");
  });

  it("requires the encrypted value when canonical metadata marks raw_text encrypted", () => {
    const row = {
      rawText: "[koed encrypted conversation item]",
      metadata: { encryptedConversationItemColumns: ["raw_text"] }
    };
    expect(() => curatedConversationSourceText(row, undefined)).toThrow(
      "Curated Conversation item is unavailable"
    );
    expect(curatedConversationSourceText(row, "decrypted source")).toBe(
      "decrypted source"
    );
  });

  it("rejects an encrypted storage marker without metadata rather than hashing it", () => {
    expect(() =>
      curatedConversationSourceText(
        { rawText: "[koed encrypted conversation item]", metadata: {} },
        undefined
      )
    ).toThrow("Curated Conversation item is unavailable");
  });
});

describe("Curated direct-source revision", () => {
  const base = {
    kind: "conversation_item" as const,
    sourceSessionId: "11111111-1111-4111-8111-111111111111",
    item: {
      itemType: "user_message" as const,
      schemaVersion: 1 as const,
      sourceId: "22222222-2222-4222-8222-222222222222",
      sourceLogicalMemoryId: "33333333-3333-4333-8333-333333333333",
      sourceRevision: 4,
      occurredAt: null,
      content: { text: "unchanged canonical source" }
    }
  };

  it("keeps unchanged direct provenance stable across unrelated session cursors", () => {
    expect(curatedDirectSourceRevisionHash(base)).toBe(
      curatedDirectSourceRevisionHash({
        ...base,
        item: { ...base.item, sourceRevision: 5 }
      })
    );
  });

  it("changes when canonical source content or Session identity changes", () => {
    expect(curatedDirectSourceRevisionHash(base)).not.toBe(
      curatedDirectSourceRevisionHash({
        ...base,
        item: { ...base.item, content: { text: "changed canonical source" } }
      })
    );
    expect(curatedDirectSourceRevisionHash(base)).not.toBe(
      curatedDirectSourceRevisionHash({
        ...base,
        sourceSessionId: "44444444-4444-4444-8444-444444444444"
      })
    );
  });
});
