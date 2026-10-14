import { describe, expect, it } from "vitest";
import type { PersonalAgentChatConversationSummary } from "@koed/shared/personal-agent-chat-contract";
import type { HomeItem, HomeSnapshot } from "@koed/shared/home";
import {
  personalConversationForExecution,
  rootPersonalConversationOngoingItems
} from "./personal-conversation-routing";

const root = {
  conversationId: "root-1",
  title: "Planning",
  projectId: "project-1",
  contextKind: "project",
  activeAgentId: "agent-2",
  activeExecutionId: "child-2",
  activeProvider: "codex",
  status: "idle",
  updatedAt: "2026-10-07T00:00:00.000Z",
  sourceExecutionIds: ["source-1"],
  childExecutionIds: ["child-1", "child-2"],
  capturedSessionIds: ["session-1"],
  participantCount: 2,
  latestAgentId: "agent-2",
  latestAgentName: "Ada"
} as PersonalAgentChatConversationSummary;

describe("personalConversationForExecution", () => {
  it.each(["root-1", "source-1", "child-2", "session-1"])(
    "resolves %s through the root summary",
    (id) => {
      expect(personalConversationForExecution([root], id)).toBe(root);
    }
  );

  it("leaves unrelated executions on the legacy route", () => {
    expect(personalConversationForExecution([root], "standalone-1")).toBe(
      undefined
    );
    expect(personalConversationForExecution([root], undefined)).toBe(undefined);
  });

  it("collapses ongoing child rows to one root link and preserves per-Agent needs-you rows", () => {
    const item = (sourceEventId: string, executionId: string): HomeItem => ({
      sourceEventId,
      source: "managed_execution",
      sourceId: executionId,
      sourceRevision: "1",
      kind: "intervention",
      state: "ongoing",
      title: `Child ${executionId}`,
      summary: "Running",
      updatedAt: "2026-10-07T00:00:00.000Z",
      destination: { kind: "execution", executionId }
    });
    const pending = {
      ...item("needs-you", "child-1"),
      state: "blocked" as const
    };
    const snapshot = {
      schemaVersion: "koed.home-feed/v1",
      accountScope: "owner",
      generatedAt: "2026-10-07T00:00:00.000Z",
      coverage: [],
      needsYou: [pending],
      cleared: [],
      ongoing: [item("ongoing-1", "child-1"), item("ongoing-2", "child-2")],
      recent: [],
      badgeCount: 1
    } as unknown as HomeSnapshot;

    const collapsed = rootPersonalConversationOngoingItems(snapshot, [root])!;
    expect(collapsed.ongoing).toHaveLength(1);
    expect(collapsed.ongoing[0]).toMatchObject({
      title: "Planning",
      destination: { kind: "execution", executionId: "root-1" }
    });
    expect(collapsed.needsYou).toEqual([pending]);
  });
});
