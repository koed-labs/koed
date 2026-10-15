import { describe, expect, it } from "vitest";

import {
  parseManagedConversationIdentity,
  parseManagedConversationRequest,
  parseManagedConversationResult
} from "./managed-conversation-protocol.js";

const identity = {
  executionId: "execution-1",
  projectId: null,
  capturedSessionId: "captured-1",
  threadId: "thread-1",
  executionOwner: {
    driverId: "codex",
    instanceId: "codex.default"
  }
};

const parseRuntimeResult = (latestCommand: Record<string, unknown>) => {
  const result = parseManagedConversationResult({
    operation: "runtime",
    executionId: "execution-1",
    executionGeneration: 1,
    executionStateVersion: 1,
    executionState: "running",
    executionLastErrorCode: null,
    vcsDriver: null,
    latestCommand: {
      id: "command-1",
      sequence: 1,
      executionGeneration: 1,
      commandKind: "prompt",
      clientUserMessageId: "message-1",
      state: "queued",
      lastErrorCode: null,
      updatedAt: "2026-09-28T12:00:00.000Z",
      ...latestCommand
    },
    items: []
  });
  if (result.operation !== "runtime") {
    throw new Error("Expected a runtime result.");
  }
  return result;
};

describe("Managed Conversation protocol", () => {
  it("accepts opaque Skill IDs and exact Client scope while refusing paths, duplicates and unscoped selections", () => {
    const send = {
      operation: "send",
      executionId: "execution-1",
      capturedSessionId: "session-1",
      threadId: "thread-1",
      idempotencyKey: "skill-turn",
      clientUserMessageId: "12345678-1234-4234-8234-123456789012",
      prompt: "Review this",
      fileMentionCommandIds: [],
      terminalContextReferences: [],
      selectedResourceIds: [`res_${"a".repeat(64)}`],
      selectedResourceHostedInstanceId: "codex.default"
    };
    expect(parseManagedConversationRequest(send)).toMatchObject({
      selectedResourceIds: send.selectedResourceIds,
      selectedResourceHostedInstanceId: "codex.default"
    });
    expect(() =>
      parseManagedConversationRequest({
        ...send,
        selectedResourceIds: ["/private/SKILL.md"]
      })
    ).toThrow();
    expect(() =>
      parseManagedConversationRequest({
        ...send,
        selectedResourceIds: [
          ...send.selectedResourceIds,
          ...send.selectedResourceIds
        ]
      })
    ).toThrow();
    const unscoped: Partial<typeof send> = { ...send };
    delete unscoped.selectedResourceHostedInstanceId;
    expect(() => parseManagedConversationRequest(unscoped)).toThrow();
    expect(
      parseManagedConversationRequest({
        operation: "resources",
        aiClientInstanceId: "codex.default",
        projectId: null
      })
    ).toMatchObject({ operation: "resources", projectId: null });
    expect(() =>
      parseManagedConversationRequest({
        operation: "resources",
        aiClientInstanceId: "codex.default",
        projectId: null,
        path: "/private/project"
      })
    ).toThrow();
  });
  it("preserves projectless identities and start results", () => {
    expect(parseManagedConversationIdentity(identity)).toEqual(identity);
    expect(
      parseManagedConversationResult({
        operation: "start",
        status: "ready",
        executionId: identity.executionId,
        conversation: identity
      })
    ).toEqual({
      operation: "start",
      status: "ready",
      executionId: identity.executionId,
      conversation: identity
    });
  });

  it("keeps Project identities unchanged and rejects malformed Project ids", () => {
    expect(
      parseManagedConversationIdentity({ ...identity, projectId: "project-1" })
    ).toMatchObject({ projectId: "project-1" });
    for (const projectId of [undefined, "", " project-1", 1]) {
      expect(() =>
        parseManagedConversationIdentity({ ...identity, projectId })
      ).toThrow("Project id is invalid.");
    }
  });

  it("allows nullable Project scope for draft and resume requests", () => {
    expect(
      parseManagedConversationRequest({
        operation: "draft_read",
        projectId: null,
        capturedSessionId: "captured-1",
        threadId: "thread-1"
      })
    ).toEqual({
      operation: "draft_read",
      projectId: null,
      capturedSessionId: "captured-1",
      threadId: "thread-1"
    });
    expect(
      parseManagedConversationRequest({
        operation: "resume",
        projectId: null,
        capturedSessionId: "captured-1",
        threadId: "thread-1"
      })
    ).toEqual({
      operation: "resume",
      projectId: null,
      capturedSessionId: "captured-1",
      threadId: "thread-1"
    });
  });

  it("normalizes the optional pre-claim cancel flag and preserves true", () => {
    expect(parseRuntimeResult({}).latestCommand).toMatchObject({
      canCancelBeforeClaim: false
    });
    expect(
      parseRuntimeResult({ canCancelBeforeClaim: true }).latestCommand
    ).toMatchObject({ canCancelBeforeClaim: true });
    expect(
      parseRuntimeResult({ canCancelBeforeClaim: false }).latestCommand
    ).toMatchObject({ canCancelBeforeClaim: false });
  });

  it("rejects malformed optional cancel flags and unknown command fields", () => {
    for (const canCancelBeforeClaim of [null, "true", 1]) {
      expect(() => parseRuntimeResult({ canCancelBeforeClaim })).toThrow(
        "Managed runtime latest command is invalid."
      );
    }
    expect(() => parseRuntimeResult({ unexpected: true })).toThrow(
      "Managed runtime latest command has unexpected fields."
    );
  });
});
