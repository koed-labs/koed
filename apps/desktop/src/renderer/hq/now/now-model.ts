import {
  sessionSelectionId,
  type DesktopProject
} from "../../../project-memory-ui.js";
import type { ManagedConversationRuntimeItem } from "../../../ipc/managed-conversation-protocol.js";
import type { ManagedConversationListEntry } from "../../../ipc/managed-conversation-protocol.js";
import type { CollaborationActionGrantProjection } from "../../../collaboration/renderer-client.js";
import type { ManagedConversationDraft } from "../../state/use-managed-conversation-lifecycle.js";
import { hqRuntimeItemTitle } from "../conversation/hq-runtime-item-title.js";
import type { ProjectNavigationRow } from "../project-navigation.js";

export type NowNeed = {
  id: string;
  kind: "question" | "approval" | "protected";
  title: string;
  context: string;
  projectId?: string;
  sessionId?: string;
  executionId?: string;
  runtimeItemId?: string;
  threadId?: string;
  createdAt: string;
};

// Mirrors the execution states in managed-conversation-repository. Terminal
// and stopping executions cannot have actionable runtime prompts.
const inspectableExecutionStates = new Set([
  "starting",
  "running",
  "reconciling",
  "quiesce_requested",
  "quiesced"
]);
const inactiveExecutionStates = new Set([
  "stopping",
  "stopped",
  "failed",
  "fenced"
]);

export function nowInspectableExecutions(
  executions: readonly ManagedConversationListEntry[]
): { executions: ManagedConversationListEntry[]; unknownState: boolean } {
  return {
    executions: executions.filter(({ state }) =>
      inspectableExecutionStates.has(state)
    ),
    unknownState: executions.some(
      ({ state }) =>
        !inspectableExecutionStates.has(state) &&
        !inactiveExecutionStates.has(state)
    )
  };
}

export function nowNeedsFromRuntime(
  drafts: ReadonlyMap<string, ManagedConversationDraft>,
  items: ReadonlyMap<string, readonly ManagedConversationRuntimeItem[]>
): NowNeed[] {
  const needs: NowNeed[] = [];
  for (const [executionId, draft] of drafts) {
    for (const item of items.get(executionId) ?? []) {
      if (
        item.state !== "pending" ||
        item.answered ||
        item.itemKind === "transient_output"
      )
        continue;
      needs.push({
        id: `runtime:${executionId}:${item.id}`,
        kind: item.itemKind === "user_input" ? "question" : "approval",
        title: hqRuntimeItemTitle(item),
        context: draft.thread.name || "Conversation",
        projectId: draft.conversation.projectId,
        sessionId: draft.conversation.capturedSessionId ?? executionId,
        executionId,
        runtimeItemId: item.id,
        threadId: draft.conversation.threadId,
        createdAt: item.createdAt
      });
    }
  }
  return needs;
}

export function nowNeedsFromExecutionInventory(
  executions: readonly ManagedConversationListEntry[],
  runtimeItems: ReadonlyMap<string, readonly ManagedConversationRuntimeItem[]>,
  drafts: ReadonlyMap<string, ManagedConversationDraft> | undefined,
  projects: readonly DesktopProject[]
): NowNeed[] {
  return executions
    .filter(({ executionId }) => !drafts?.has(executionId))
    .flatMap((execution) =>
      (runtimeItems.get(execution.executionId) ?? [])
        .filter(
          (item) =>
            item.state === "pending" &&
            !item.answered &&
            item.itemKind !== "transient_output"
        )
        .map((item) => ({
          id: `runtime:${execution.executionId}:${item.id}`,
          kind: item.itemKind === "user_input" ? "question" : "approval",
          title: hqRuntimeItemTitle(item),
          context:
            projects.find(({ id }) => id === execution.projectId)?.name ??
            "Conversation",
          projectId: execution.projectId,
          sessionId: execution.sessionId ?? undefined,
          executionId: execution.executionId,
          runtimeItemId: item.id,
          threadId: execution.threadId ?? undefined,
          createdAt: item.createdAt
        }))
    );
}

export function nowNeedsFromApprovals(
  approvals: readonly CollaborationActionGrantProjection[]
): NowNeed[] {
  return approvals
    .filter(
      ({ state, expiresAt }) =>
        (state === "awaiting_approval" || state === "awaiting_review") &&
        Date.parse(expiresAt) > Date.now()
    )
    .map((grant) => ({
      id: `approval:${grant.id}`,
      kind: "protected" as const,
      title: grant.operation,
      context: "Protected operation",
      createdAt: grant.expiresAt
    }));
}

export function nowProjects(
  projects: readonly DesktopProject[]
): DesktopProject[] {
  return projects.filter((project) => project.contextKind !== "independent");
}

export function nowProjectStatus(
  project: DesktopProject,
  needs: readonly NowNeed[]
): { pending: number; conversations: string } {
  const pending = needs.filter((need) => need.projectId === project.id).length;
  const conversations = project.threads.filter(
    (thread) => thread.threadKind !== "subagent"
  ).length;
  const conversationLabel = `${conversations} ${conversations === 1 ? "Conversation" : "Conversations"}`;
  return { pending, conversations: conversationLabel };
}

export function nowPersonalProjectStatus(
  project: ProjectNavigationRow,
  needs: readonly NowNeed[]
): { pending: number; conversations: string } {
  const pending = needs.filter((need) =>
    project.conversations.some(
      ({ technicalProjectId, thread }) =>
        technicalProjectId === need.projectId &&
        (thread.sessionId === need.sessionId ||
          sessionSelectionId(thread) === need.sessionId)
    )
  ).length;
  const conversations = project.conversations.filter(
    ({ thread }) => thread.threadKind !== "subagent"
  ).length;
  return {
    pending,
    conversations: `${conversations} ${conversations === 1 ? "Conversation" : "Conversations"}`
  };
}

export function nowConversationDestination(
  need: NowNeed,
  projects: readonly DesktopProject[]
): { projectId: string; routeId: string; synthetic: boolean } | null {
  if (!need.projectId || !need.sessionId || !need.threadId) return null;
  const project = projects.find(({ id }) => id === need.projectId);
  if (!project) return null;
  const thread = project.threads.find(
    (candidate) =>
      sessionSelectionId(candidate) === need.sessionId ||
      candidate.id === need.threadId
  );
  if (!thread && !need.executionId) return null;
  return {
    projectId: project.id,
    routeId: thread ? sessionSelectionId(thread) : need.executionId!,
    synthetic: !thread
  };
}

export const nowVisible = <T>(
  items: readonly T[],
  expanded: boolean
): readonly T[] => (expanded ? items : items.slice(0, 5));
