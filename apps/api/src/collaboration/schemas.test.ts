import { describe, expect, it } from "vitest";
import { COLLABORATION_HISTORY_PAGE_MAX_ITEMS } from "@koed/shared";

import {
  createCollaborationChannelSchema,
  createCollaborationMessageSchema,
  listCollaborationMessagesQuerySchema,
  listCollaborationThreadsQuerySchema,
  renameCollaborationThreadSchema,
  updateCollaborationTopicSchema
} from "./schemas.js";

describe("collaboration text limits", () => {
  it("normalizes names and enforces the 80 Unicode-code-point boundary", () => {
    expect(
      createCollaborationChannelSchema.parse({ name: `  ${"😀".repeat(80)}  ` })
        .name
    ).toBe("😀".repeat(80));
    expect(() =>
      createCollaborationChannelSchema.parse({ name: "😀".repeat(81) })
    ).toThrow();
    expect(
      renameCollaborationThreadSchema.parse({
        expectedVersion: 1,
        name: "Cafe\u0301"
      }).name
    ).toBe("Café");
  });

  it("enforces topics at 1,024 UTF-8 bytes after NFC normalization", () => {
    expect(
      createCollaborationChannelSchema.parse({
        name: "general",
        topic: "é".repeat(512)
      }).topic
    ).toBe("é".repeat(512));
    expect(() =>
      updateCollaborationTopicSchema.parse({
        expectedVersion: 1,
        topic: "é".repeat(513)
      })
    ).toThrow();
  });

  it("enforces messages at 32,768 UTF-8 bytes", () => {
    expect(
      createCollaborationMessageSchema.parse({ bodyText: "😀".repeat(8_192) })
        .bodyText
    ).toBe("😀".repeat(8_192));
    expect(() =>
      createCollaborationMessageSchema.parse({
        bodyText: "😀".repeat(8_193)
      })
    ).toThrow();
  });

  it("uses the shared 100-item page limit for thread and message history", () => {
    expect(
      listCollaborationThreadsQuerySchema.parse({
        limit: COLLABORATION_HISTORY_PAGE_MAX_ITEMS
      }).limit
    ).toBe(COLLABORATION_HISTORY_PAGE_MAX_ITEMS);
    expect(
      listCollaborationMessagesQuerySchema.parse({
        limit: COLLABORATION_HISTORY_PAGE_MAX_ITEMS
      }).limit
    ).toBe(COLLABORATION_HISTORY_PAGE_MAX_ITEMS);
    expect(() =>
      listCollaborationThreadsQuerySchema.parse({
        limit: COLLABORATION_HISTORY_PAGE_MAX_ITEMS + 1
      })
    ).toThrow();
    expect(() =>
      listCollaborationMessagesQuerySchema.parse({
        limit: COLLABORATION_HISTORY_PAGE_MAX_ITEMS + 1
      })
    ).toThrow();
  });
});
