import { describe, expect, it } from "vitest";
import { resolveMcpConversationBinding } from "../src/conversation-binding.js";

describe("per-call Conversation identity", () => {
  it("keeps overlapping native Conversations independent", () => {
    const bind = (threadId: string) =>
      resolveMcpConversationBinding({
        clientName: "codex-mcp-client",
        metadata: { threadId, sessionId: "unrelated-transport-session" }
      });
    expect(bind("first")).toEqual({
      externalSessionId: "first",
      sourceRuntime: "codex-cli"
    });
    expect(bind("second")).toEqual({
      externalSessionId: "second",
      sourceRuntime: "codex-cli"
    });
    expect(bind("first")).toEqual({
      externalSessionId: "first",
      sourceRuntime: "codex-cli"
    });
  });

  it("accepts matching hook metadata and trusted native context", () => {
    const binding = {
      externalSessionId: "native",
      sourceRuntime: "codex-cli" as const
    };
    expect(
      resolveMcpConversationBinding({
        conversationId: "native",
        conversationSource: "codex-cli",
        clientName: "codex",
        metadata: { threadId: "native" },
        trustedConversation: binding
      })
    ).toEqual(binding);
  });

  it.each([
    { conversationId: "native" },
    { conversationSource: "pi" },
    { conversationId: "", conversationSource: "codex-cli" },
    { conversationId: "native", conversationSource: "unknown" },
    { clientName: "codex", metadata: { threadId: 123 } }
  ])("rejects malformed native context %j", (input) => {
    expect(() => resolveMcpConversationBinding(input)).toThrow(
      "valid native Conversation"
    );
  });

  it("rejects conflicting context instead of selecting a different Conversation", () => {
    expect(() =>
      resolveMcpConversationBinding({
        conversationId: "hook",
        conversationSource: "codex-cli",
        clientName: "codex",
        metadata: { threadId: "native" }
      })
    ).toThrow("conflicting Conversation");
    expect(() =>
      resolveMcpConversationBinding({
        conversationId: "model",
        conversationSource: "pi",
        trustedConversation: {
          externalSessionId: "trusted",
          sourceRuntime: "pi"
        }
      })
    ).toThrow("conflicting Conversation");
  });

  it("allows trusted captured IDs but never treats a transport session as identity", () => {
    const conversation = { sessionId: "e19cf47b-a553-4043-9bb5-c02134392c4a" };
    expect(
      resolveMcpConversationBinding({ trustedConversation: conversation })
    ).toEqual(conversation);
    expect(
      resolveMcpConversationBinding({ metadata: { sessionId: "transport" } })
    ).toBeUndefined();
    expect(
      resolveMcpConversationBinding({ clientName: "codex", metadata: {} })
    ).toBeUndefined();
  });
});
