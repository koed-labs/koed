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
        projectId: "project-1"
      })
    ).toEqual({
      operation: "command_discovery",
      aiClientDriverId: "codex",
      aiClientInstanceId: "codex-default",
      projectId: "project-1"
    });
  });

  it("parses client-global discovery requests without a Project", () => {
    expect(
      parseManagedConversationRequest({
        operation: "command_discovery",
        aiClientDriverId: "codex",
        aiClientInstanceId: "codex-default"
      })
    ).toEqual({
      operation: "command_discovery",
      aiClientDriverId: "codex",
      aiClientInstanceId: "codex-default"
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
            source: "provider",
            scope: "project"
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
          source: "provider",
          scope: "project"
        }
      ]
    });
  });

  it("rejects command discovery instance ids over 128 characters", () => {
    expect(() =>
      parseManagedConversationRequest({
        operation: "command_discovery",
        aiClientDriverId: "codex",
        aiClientInstanceId: `codex-${"a".repeat(123)}`,
        projectId: "project-1"
      })
    ).toThrow("instance id is invalid");
  });

  it("rejects command discovery instance ids outside identifier pattern", () => {
    expect(() =>
      parseManagedConversationRequest({
        operation: "command_discovery",
        aiClientDriverId: "codex",
        aiClientInstanceId: "Codex.Default",
        projectId: "project-1"
      })
    ).toThrow("instance id is invalid");
  });

  it("rejects command discovery project ids over 128 characters", () => {
    expect(() =>
      parseManagedConversationRequest({
        operation: "command_discovery",
        aiClientDriverId: "codex",
        aiClientInstanceId: "codex-default",
        projectId: "p".repeat(129)
      })
    ).toThrow("project id is invalid");
  });

  it("rejects non-ok command discovery results with commands", () => {
    expect(() =>
      parseManagedConversationResult({
        operation: "command_discovery",
        status: "stale",
        commands: [
          {
            name: "review",
            description: "Review current changes",
            kind: "command",
            source: "provider",
            scope: "project"
          }
        ],
        message: "stale"
      })
    ).toThrow("non-ok results must have empty commands array");
  });

  it("rejects messages on ok command discovery results", () => {
    expect(() =>
      parseManagedConversationResult({
        operation: "command_discovery",
        status: "ok",
        commands: [],
        message: "unexpected"
      })
    ).toThrow("unexpected fields");
  });
});
