import { describe, expect, it } from "vitest";
import {
  parseManagedConversationRequest,
  parseManagedConversationResult
} from "./managed-conversation-protocol.js";

describe("managed conversation command discovery protocol", () => {
  it("parses command discovery requests", () => {
    expect(
      parseManagedConversationRequest({
        operation: "command_discovery",
        aiClientDriverId: "codex",
        aiClientInstanceId: "codex-default",
        projectId: "project-1",
        cwd: "/workspace/project"
      })
    ).toEqual({
      operation: "command_discovery",
      aiClientDriverId: "codex",
      aiClientInstanceId: "codex-default",
      projectId: "project-1",
      cwd: "/workspace/project"
    });
  });

  it("parses command discovery results", () => {
    expect(
      parseManagedConversationResult({
        operation: "command_discovery",
        status: "ok",
        commands: [
          {
            name: "review",
            description: "Review current changes",
            argumentHint: "[path]",
            kind: "command",
            source: "provider"
          }
        ]
      })
    ).toEqual({
      operation: "command_discovery",
      status: "ok",
      commands: [
        {
          name: "review",
          description: "Review current changes",
          argumentHint: "[path]",
          kind: "command",
          source: "provider"
        }
      ]
    });
  });
});
