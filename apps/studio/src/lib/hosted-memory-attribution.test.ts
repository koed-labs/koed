import { describe, expect, it } from "vitest";
import { parseHostedConversationState } from "./hosted-managed-chats";

const executionId = "11111111-1111-4111-8111-111111111111";

describe("hosted Conversation memory attribution", () => {
  it("strips duplicate or malformed attribution footers from final history text", () => {
    const state = parseHostedConversationState(
      {
        executionId,
        executionGeneration: 2,
        executionState: "running",
        messages: [
          {
            id: "assistant-answer",
            role: "assistant",
            content:
              "Answer\n<!-- KOED-MEMORY-ATTRIBUTION:v1:malformed -->\n<!-- koed-memory-attribution:v1:also-malformed -->",
            createdAt: "2026-09-28T18:00:00.000Z",
            memory: {
              used: true,
              status: "available",
              citations: [{ label: "Server-provided source" }]
            }
          },
          {
            id: "assistant-invalid-metadata",
            role: "assistant",
            content: "Still readable",
            createdAt: "2026-09-28T18:00:01.000Z",
            memory: { used: "yes", status: "available", citations: [] }
          },
          {
            id: "assistant-literal-angle",
            role: "assistant",
            content: "Ordinary trailing <",
            createdAt: "2026-09-28T18:00:02.000Z"
          }
        ]
      },
      executionId,
      2
    );

    expect(state.messages[0]).toMatchObject({
      content: "Answer",
      memory: {
        used: true,
        status: "available",
        citations: [{ label: "Server-provided source" }]
      }
    });
    expect(state.messages[1]).toMatchObject({ content: "Still readable" });
    expect(state.messages[1]).not.toHaveProperty("memory");
    expect(state.messages[2]).toMatchObject({ content: "Ordinary trailing <" });
  });
});
