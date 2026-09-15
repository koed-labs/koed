import { describe, expect, it } from "vitest";
import { pdsConversationItemsForClosure } from "./local-source.js";

const source = {
  groupDbId: "group-db",
  groupId: "opaque-group",
  sessionId: "session",
  logicalSessionId: "logical-session",
  externalSessionId: "source-session",
  forkedFromExternalThreadId: null,
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
      sourceEventType: "user_message",
      metadata: {
        canonicalConversationItemActor: "user",
        sourceRole: "agent",
        ignored: "not exported"
      }
    }
  ]
};

describe("PDS source closure sanitizer", () => {
  it("keeps only immutable source profile fields", () => {
    expect(pdsConversationItemsForClosure(source)).toEqual([
      expect.objectContaining({
        sourceNativeItemId: "source-item",
        sequence: "0",
        actor: "user",
        type: "user_message",
        content: "captured source",
        metadata: { sourceRole: "user" }
      })
    ]);
  });

  it("does not serialize ignored raw or canonical metadata fields", () => {
    const [item] = pdsConversationItemsForClosure({
      ...source,
      items: [
        {
          ...source.items[0]!,
          rawJson: {
            content: "captured source",
            apiToken: "must-not-cross-the-wire",
            nested: { credential: "must-not-cross-the-wire" }
          },
          metadata: {
            ...source.items[0]!.metadata,
            projectId: "private-project",
            cwd: "/private/path",
            derivedMemory: { embedding: [1, 2, 3] }
          }
        }
      ]
    });

    expect(item).toEqual(
      expect.objectContaining({
        content: "captured source",
        metadata: { sourceRole: "user" }
      })
    );
    expect(JSON.stringify(item)).not.toContain("must-not-cross-the-wire");
    expect(JSON.stringify(item)).not.toContain("private-project");
    expect(JSON.stringify(item)).not.toContain("/private/path");
    expect(JSON.stringify(item)).not.toContain("embedding");
  });

  it("preserves known contentless lifecycle controls without exporting raw payloads", () => {
    const [item] = pdsConversationItemsForClosure({
      ...source,
      items: [
        {
          ...source.items[0]!,
          rawText: null,
          rawJson: {
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: "private-provider-turn-id"
            }
          },
          sourceRecordType: "event_msg",
          sourceEventType: "task_complete",
          metadata: {
            sourceRole: "system",
            semanticControl: "turn_completed"
          }
        }
      ]
    });

    expect(item).toEqual(
      expect.objectContaining({
        actor: "system",
        type: "task_complete",
        content: "",
        metadata: { sourceRole: "system" }
      })
    );
    expect(JSON.stringify(item)).not.toContain("private-provider-turn-id");
  });

  it("never serializes arbitrary raw JSON when raw text is unavailable", () => {
    expect(() =>
      pdsConversationItemsForClosure({
        ...source,
        items: [{ ...source.items[0]!, rawText: null, rawJson: { other: "x" } }]
      })
    ).toThrow("PDS source adapter payload is not exportable");
  });

  it("preserves Claude source-set component identity", () => {
    const items = pdsConversationItemsForClosure({
      ...source,
      sourceAdapter: "claude-code",
      sourceAdapterVersion: "claude-code-transcript-v1",
      items: [
        {
          ...source.items[0]!,
          sourceKind: "claude-code",
          metadata: {
            canonicalConversationItemActor: "user",
            sourceComponentId: "main",
            sourceComponentRole: "primary"
          }
        },
        {
          ...source.items[0]!,
          externalItemId: "subagent-item",
          sourceKind: "claude-code",
          metadata: {
            canonicalConversationItemActor: "subagent",
            sourceComponentId: "subagent.researcher",
            sourceComponentRole: "auxiliary",
            parentSourceComponentId: "main"
          }
        }
      ]
    });

    expect(items.map((item) => item.metadata)).toEqual([
      {
        sourceRole: "user",
        sourceComponentId: "main",
        sourceComponentRole: "primary"
      },
      {
        sourceRole: "subagent",
        sourceComponentId: "subagent.researcher",
        sourceComponentRole: "auxiliary",
        parentSourceComponentId: "main"
      }
    ]);
  });

  it("derives missing Claude component relationships from the stable component id", () => {
    const [item] = pdsConversationItemsForClosure({
      ...source,
      sourceAdapter: "claude-code",
      items: [
        {
          ...source.items[0]!,
          sourceKind: "claude-code",
          metadata: {
            canonicalConversationItemActor: "subagent",
            sourceComponentId: "subagent.researcher"
          }
        }
      ]
    });

    expect(item?.metadata).toEqual({
      sourceRole: "subagent",
      sourceComponentId: "subagent.researcher",
      sourceComponentRole: "auxiliary",
      parentSourceComponentId: "main"
    });
  });

  it("extracts Pi text from the adapter record and keeps known journal controls empty", () => {
    const items = pdsConversationItemsForClosure({
      ...source,
      sourceRuntime: "pi",
      sourceAdapter: "pi",
      sourceAdapterVersion: "pi-session-v1",
      items: [
        {
          ...source.items[0]!,
          rawText: null,
          sourceKind: "pi",
          sourceRecordType: "message",
          sourceEventType: "agent_message",
          rawJson: {
            type: "pi_session_record",
            sourceRecord: {
              type: "message",
              id: "answer",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: [{ type: "text", text: "Pi answer" }]
              }
            },
            contentBlock: { type: "text", text: "Pi answer" }
          },
          metadata: { canonicalConversationItemActor: "assistant" }
        },
        {
          ...source.items[0]!,
          externalItemId: "compaction",
          rawText: null,
          sourceKind: "pi",
          sourceRecordType: "compaction",
          sourceEventType: "compaction",
          rawJson: {
            type: "pi_session_record",
            sourceRecord: { type: "compaction", summary: "private summary" },
            contentBlock: { type: "compaction", summary: "private summary" }
          },
          metadata: {}
        },
        {
          ...source.items[0]!,
          externalItemId: "unknown-control",
          rawText: null,
          sourceKind: "pi",
          sourceRecordType: "thinking_level",
          sourceEventType: "unknown",
          rawJson: {
            type: "pi_session_record",
            sourceRecord: { type: "thinking_level", level: "xhigh" },
            contentBlock: { type: "thinking_level", level: "xhigh" }
          },
          metadata: {}
        }
      ]
    });

    expect(items.map((item) => item.content)).toEqual(["Pi answer", "", ""]);
    expect(JSON.stringify(items)).not.toContain("private summary");
  });

  it("exports a Claude completion control as contentless provenance", () => {
    const [item] = pdsConversationItemsForClosure({
      ...source,
      sourceRuntime: "claude-code",
      sourceAdapter: "claude-code",
      sourceAdapterVersion: "claude-code-transcript-v1",
      items: [
        {
          ...source.items[0]!,
          rawText: null,
          sourceKind: "claude-code",
          sourceRecordType: "hook_signal",
          sourceEventType: "turn_completed",
          rawJson: {
            type: "hook_signal",
            payload: {
              type: "turn_completed",
              sourceFrontierOffset: 42,
              sourceFrontierLine: 3
            }
          },
          metadata: {
            sourceRuntime: "claude-code",
            semanticControl: "turn_completed"
          }
        }
      ]
    });

    expect(item?.content).toBe("");
    expect(item?.metadata).toEqual({ sourceRole: "system" });
  });

  it("uses the captured runtime when sourceKind is the generic Codex adapter", () => {
    const [item] = pdsConversationItemsForClosure({
      ...source,
      sourceRuntime: "codex-cli",
      sourceAdapter: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      items: [
        {
          ...source.items[0]!,
          rawText: null,
          sourceKind: "codex",
          rawJson: {
            type: "response_item",
            params: {
              item: { type: "message", content: [{ text: "CLI answer" }] }
            }
          },
          metadata: {}
        }
      ]
    });

    expect(item?.content).toBe("CLI answer");
  });
});
