import { describe, expect, it } from "vitest";
import type { PersonalAgentChatConversationSummary } from "@koed/shared/personal-agent-chat-contract";
import type { HomeItem, HomeSnapshot } from "@koed/shared/home";
import {
  nativeRecentActivityInOngoing,
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

  it("keeps the newest native Agent attribution and status while opening the root once", () => {
    const delivery = (
      id: string,
      title: string,
      updatedAt: string
    ): HomeItem => ({
      sourceEventId: `delivery:${id}`,
      source: "native_agent_activity",
      sourceId: id,
      sourceRevision: "n0123456789abcdef",
      kind: "agent_work",
      state: "ongoing",
      title,
      summary: "Running on Codex",
      updatedAt,
      destination: { kind: "execution", executionId: root.conversationId }
    });
    const olderChild = {
      sourceEventId: "execution:child-1",
      source: "managed_execution",
      sourceId: "child-1",
      sourceRevision: "1",
      kind: "intervention",
      state: "ongoing",
      title: "Legacy child execution",
      summary: "Running",
      updatedAt: "2026-10-06T00:00:00.000Z",
      destination: { kind: "execution", executionId: "child-1" }
    } as unknown as HomeItem;
    const newerDelivery = delivery(
      "native-2",
      "Ada · Build the fix",
      "2026-10-07T00:00:00.000Z"
    );
    const snapshot = {
      schemaVersion: "koed.home-feed/v1",
      accountScope: "owner",
      generatedAt: "2026-10-07T00:00:00.000Z",
      coverage: [],
      needsYou: [],
      cleared: [],
      ongoing: [olderChild, newerDelivery],
      recent: [],
      badgeCount: 0
    } as unknown as HomeSnapshot;

    const collapsed = rootPersonalConversationOngoingItems(snapshot, [root])!;
    expect(collapsed.ongoing).toEqual([
      {
        ...newerDelivery,
        destination: { kind: "execution", executionId: root.conversationId }
      }
    ]);
  });

  it("folds completed native Agent activity into Ongoing when there is no ongoing row", () => {
    const completed: HomeItem = {
      sourceEventId: "delivery:completed-1",
      source: "native_agent_activity",
      sourceId: "completed-1",
      sourceRevision: "n0123456789abcdef",
      kind: "agent_work",
      state: "recent",
      title: "Ada · Finished the plan",
      summary: "Completed on Codex",
      updatedAt: "2026-10-07T00:00:00.000Z",
      destination: { kind: "execution", executionId: root.conversationId }
    };
    const snapshot = {
      schemaVersion: "koed.home-feed/v1",
      accountScope: "owner",
      generatedAt: "2026-10-07T00:00:00.000Z",
      coverage: [],
      needsYou: [],
      cleared: [],
      ongoing: [],
      recent: [completed],
      badgeCount: 0
    } as unknown as HomeSnapshot;

    const collapsed = rootPersonalConversationOngoingItems(snapshot, [])!;
    expect(collapsed.ongoing).toEqual([completed]);
    expect(collapsed.recent).toEqual([completed]);
  });

  it("prefers ongoing child work over a completed native row for the same root", () => {
    const ongoingChild: HomeItem = {
      sourceEventId: "execution:child-2",
      source: "managed_execution",
      sourceId: "child-2",
      sourceRevision: "1",
      kind: "intervention",
      state: "ongoing",
      title: "Child execution",
      summary: "Still running",
      updatedAt: "2026-10-07T00:00:00.000Z",
      destination: { kind: "execution", executionId: "child-2" }
    };
    const completedNative: HomeItem = {
      sourceEventId: "delivery:completed-2",
      source: "native_agent_activity",
      sourceId: "completed-2",
      sourceRevision: "n0123456789abcdef",
      kind: "agent_work",
      state: "recent",
      title: "Ada · Finished the earlier step",
      summary: "Completed on Codex",
      updatedAt: "2026-10-07T00:00:01.000Z",
      destination: { kind: "execution", executionId: root.conversationId }
    };
    const needsYou: HomeItem = {
      ...ongoingChild,
      sourceEventId: "runtime:needs-you",
      state: "blocked",
      title: "Needs a decision"
    };
    const snapshot = {
      schemaVersion: "koed.home-feed/v1",
      accountScope: "owner",
      generatedAt: "2026-10-07T00:00:00.000Z",
      coverage: [],
      needsYou: [needsYou],
      cleared: [],
      ongoing: [ongoingChild],
      recent: [completedNative],
      badgeCount: 1
    } as unknown as HomeSnapshot;

    const collapsed = rootPersonalConversationOngoingItems(snapshot, [root])!;
    expect(collapsed.ongoing).toEqual([
      {
        ...ongoingChild,
        title: "Planning",
        summary: "Agent work is continuing in this chat.",
        destination: { kind: "execution", executionId: root.conversationId }
      }
    ]);
    expect(collapsed.needsYou).toEqual([needsYou]);
  });

  it("deduplicates native recent and ongoing deliveries by their canonical destination", () => {
    const completed = (id: string, updatedAt: string): HomeItem => ({
      sourceEventId: `delivery:${id}`,
      source: "native_agent_activity",
      sourceId: id,
      sourceRevision: "n0123456789abcdef",
      kind: "agent_work",
      state: "recent",
      title: `Ada · ${id}`,
      summary: "Completed on Codex",
      updatedAt,
      destination: { kind: "execution", executionId: root.conversationId }
    });
    const ongoing = {
      ...completed("ongoing-1", "2026-10-07T00:00:00.000Z"),
      state: "ongoing" as const,
      summary: "Running on Codex"
    };
    const newestCompleted = completed(
      "completed-2",
      "2026-10-07T00:00:02.000Z"
    );
    const displayed = nativeRecentActivityInOngoing(
      [ongoing],
      [completed("completed-1", "2026-10-07T00:00:01.000Z"), newestCompleted]
    );

    expect(displayed).toEqual([ongoing]);
  });
});
