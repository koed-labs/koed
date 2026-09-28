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

describe("Managed Conversation protocol", () => {
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
});
