import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { ManagedConversationDraft } from "../../state/use-managed-conversation-lifecycle.js";
import { withPendingHqConversations } from "./hq-conversation-threads.js";

const thread = {
  id: "canonical-thread",
  sessionId: "canonical-session",
  projectId: "project-1"
};
const draft = {
  thread,
  conversation: {
    executionId: "execution-1",
    capturedSessionId: "canonical-session",
    threadId: "canonical-thread"
  }
} as ManagedConversationDraft;

describe("HQ Conversation sidebar overlay", () => {
  it("shows a provisional draft until the canonical captured thread arrives", () => {
    const empty = { id: "project-1", threads: [] } as unknown as DesktopProject;
    const drafts = new Map([["execution-1", draft]]);
    expect(withPendingHqConversations([empty], drafts)[0]?.threads).toEqual([
      thread
    ]);
    const captured = { ...empty, threads: [thread] } as DesktopProject;
    expect(withPendingHqConversations([captured], drafts)[0]?.threads).toEqual([
      thread
    ]);
  });
});
