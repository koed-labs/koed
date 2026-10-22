import { describe, expect, it } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { ManagedConversationDraft } from "../../state/use-managed-conversation-lifecycle.js";
import type { ManagedConversationRuntimeItem } from "../../../ipc/managed-conversation-protocol.js";
import {
  nowNeedsFromExecutionInventory,
  nowNeedsFromRuntime,
  nowConversationDestination,
  nowNeedsFromApprovals,
  nowInspectableExecutions,
  nowProjectStatus,
  nowPersonalProjectStatus,
  nowProjects,
  nowVisible
} from "./now-model.js";

describe("Now aggregation", () => {
  it("keeps all actionable execution states and marks unfamiliar states incomplete", () => {
    const states = [
      "starting",
      "running",
      "reconciling",
      "quiesce_requested",
      "quiesced",
      "stopping",
      "stopped",
      "failed",
      "fenced",
      "new_future_state"
    ];
    const inventory = states.map((state, index) => ({
      executionId: `e-${index}`,
      projectId: "p",
      sessionId: null,
      threadId: null,
      state
    }));
    expect(nowInspectableExecutions(inventory)).toEqual({
      executions: inventory.slice(0, 5),
      unknownState: true
    });
  });
  it("collects pending questions and approvals from separate executions without including answered items", () => {
    const draft = (id: string) =>
      ({
        conversation: { projectId: id },
        thread: { name: id }
      }) as ManagedConversationDraft;
    const item = (
      id: string,
      state: "pending" | "answered",
      itemKind: ManagedConversationRuntimeItem["itemKind"]
    ) =>
      ({
        id,
        state,
        itemKind,
        createdAt: "2026-10-19T00:00:00Z"
      }) as ManagedConversationRuntimeItem;
    const drafts = new Map([
      ["a", draft("project-a")],
      ["b", draft("project-b")]
    ]);
    const runtime = new Map<string, ManagedConversationRuntimeItem[]>([
      [
        "a",
        [
          item("question", "pending", "user_input"),
          item("old", "answered", "command_approval")
        ]
      ],
      [
        "b",
        [
          item("approval", "pending", "command_approval"),
          item("output", "pending", "transient_output")
        ]
      ]
    ]);
    expect(nowNeedsFromRuntime(drafts, runtime).map(({ id }) => id)).toEqual([
      "runtime:a:question",
      "runtime:b:approval"
    ]);
  });

  it("counts a captured execution once in its exact Personal Project", () => {
    const draft = {
      conversation: {
        projectId: "technical-repository",
        capturedSessionId: "captured-b",
        threadId: "thread-b"
      },
      thread: { name: "Conversation B" }
    } as ManagedConversationDraft;
    const runtime = [
      {
        id: "question",
        state: "pending",
        itemKind: "user_input",
        createdAt: "2026-10-20T00:00:00Z"
      }
    ] as ManagedConversationRuntimeItem[];
    const needs = nowNeedsFromRuntime(
      new Map([["execution-b", draft]]),
      new Map([["execution-b", runtime]])
    );
    const row = (sessionId: string) => ({
      id: sessionId,
      name: sessionId,
      conversations: [
        {
          technicalProjectId: "technical-repository",
          thread: { sessionId, id: `thread-${sessionId}` }
        }
      ]
    });
    expect(needs[0]).toMatchObject({
      sessionId: "captured-b",
      executionId: "execution-b"
    });
    expect(
      nowPersonalProjectStatus(row("captured-a") as never, needs).pending
    ).toBe(0);
    expect(
      nowPersonalProjectStatus(row("captured-b") as never, needs).pending
    ).toBe(1);
  });

  it("uses five-row caps and excludes the Chats container from Project rows", () => {
    const projects = [
      { id: "chats", contextKind: "independent" },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `p${index}`,
        contextKind: "project"
      }))
    ] as DesktopProject[];
    expect(nowVisible(nowProjects(projects), false)).toHaveLength(5);
    expect(nowVisible(nowProjects(projects), true)).toHaveLength(6);
  });
  it("includes pending requests from inventory executions absent from lifecycle drafts", () => {
    const item = {
      id: "wait",
      state: "pending",
      itemKind: "user_input",
      createdAt: "2026-10-19T00:00:00Z"
    } as unknown as ManagedConversationRuntimeItem;
    const inventory = [
      {
        executionId: "older",
        projectId: "p",
        sessionId: "session",
        threadId: "thread",
        state: "running"
      }
    ];
    expect(
      nowNeedsFromExecutionInventory(
        inventory,
        new Map([["older", [item]]]),
        new Map(),
        [{ id: "p", name: "Project P" }] as DesktopProject[]
      )
    ).toMatchObject([
      { id: "runtime:older:wait", context: "Project P", sessionId: "session" }
    ]);
  });
  it("uses real question text and counts pending requests by Project without counting subagents", () => {
    const item = {
      id: "q",
      state: "pending",
      answered: false,
      itemKind: "user_input",
      payload: {
        questions: [
          { header: "Choose a date", question: "When should this run?" }
        ]
      },
      createdAt: "2026-10-19T00:00:00Z"
    } as unknown as ManagedConversationRuntimeItem;
    const inventory = [
      {
        executionId: "e",
        projectId: "p",
        sessionId: "s",
        threadId: "t",
        state: "running"
      }
    ];
    const project = {
      id: "p",
      name: "Project",
      threads: [{ threadKind: "conversation" }, { threadKind: "subagent" }]
    } as DesktopProject;
    const needs = nowNeedsFromExecutionInventory(
      inventory,
      new Map([["e", [item]]]),
      undefined,
      [project]
    );
    expect(needs[0]).toMatchObject({
      title: "Choose a date",
      executionId: "e",
      sessionId: "s",
      threadId: "t"
    });
    expect(nowProjectStatus(project, needs)).toEqual({
      pending: 1,
      conversations: "1 Conversation"
    });
  });
  it("excludes approved, executing, and expired protected operations from Needs you", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const approval = (state: string, expiresAt = future) => ({
      id: state + expiresAt,
      operation: state,
      state,
      expiresAt
    });
    expect(
      nowNeedsFromApprovals([
        approval("awaiting_approval"),
        approval("awaiting_review"),
        approval("approved"),
        approval("executing"),
        approval("awaiting_approval", past)
      ] as never).map(({ title }) => title)
    ).toEqual(["awaiting_approval", "awaiting_review"]);
  });
  it("routes an inventory-only pending request to its exact execution and a captured request to its graph Conversation", () => {
    const need = {
      id: "runtime:e:i",
      kind: "question" as const,
      title: "Review?",
      context: "Project",
      projectId: "p",
      executionId: "e",
      sessionId: "s",
      threadId: "t",
      createdAt: "2026-10-19T00:00:00Z"
    };
    expect(
      nowConversationDestination(need, [
        { id: "p", threads: [] }
      ] as unknown as DesktopProject[])
    ).toEqual({ projectId: "p", routeId: "e", synthetic: true });
    expect(
      nowConversationDestination(need, [
        { id: "p", threads: [{ id: "t", sessionId: "s" }] }
      ] as unknown as DesktopProject[])
    ).toEqual({ projectId: "p", routeId: "s", synthetic: false });
    const sourceWithoutManagedExecution = { ...need, executionId: undefined };
    expect(
      nowConversationDestination(sourceWithoutManagedExecution, [
        { id: "p", threads: [{ id: "t", sessionId: "s" }] }
      ] as unknown as DesktopProject[])
    ).toEqual({ projectId: "p", routeId: "s", synthetic: false });
    expect(
      nowConversationDestination(sourceWithoutManagedExecution, [
        { id: "p", threads: [] }
      ] as unknown as DesktopProject[])
    ).toBeNull();
  });
});
