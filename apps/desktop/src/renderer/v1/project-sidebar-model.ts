import {
  personalInventoryConversationKey,
  personalInventoryReference
} from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../project-memory-ui.js";
import { sessionSelectionId } from "../../project-memory-ui.js";
import type { V1ConversationIntent } from "../../ipc/v1-state-protocol.js";
import type { ManagedConversationDraft } from "../state/use-managed-conversation-lifecycle.js";

export type ConversationRoute = {
  kind: "conversation";
  projectId?: string;
  threadId?: string;
  executionId?: string;
};
export type NavigationRoute = { kind: "home" } | ConversationRoute;
export type SidebarConversation = {
  key: string;
  aliases: string[];
  title: string;
  latestAt: string;
  client: "codex" | "claude" | "pi" | null;
  route: ConversationRoute;
  projectName: string;
};
export type SidebarProject = {
  id: string;
  name: string;
  latestAt: string;
  conversations: SidebarConversation[];
};
const timestamp = (value: string) => Date.parse(value) || 0;
const activityOrder = <
  T extends { latestAt: string; key?: string; id?: string }
>(
  a: T,
  b: T
) =>
  timestamp(b.latestAt) - timestamp(a.latestAt) ||
  (a.key ?? a.id ?? "").localeCompare(b.key ?? b.id ?? "");

/** Presentation only: the inventory remains authoritative for every membership. */
export function buildProjectSidebar(
  projects: readonly DesktopProject[],
  intents: readonly V1ConversationIntent[],
  drafts: ReadonlyMap<string, ManagedConversationDraft>
): SidebarProject[] {
  const groups = new Map<string, SidebarProject>();
  const capturedExecutions = new Set<string>();
  // Raw Git/Folder inventory overlaps named Project memberships. Keep every
  // named membership, and use source groups only for unassigned captures.
  const assigned = new Set(
    projects
      .filter((project) => project.namedProject)
      .flatMap((project) =>
        project.threads.map(personalInventoryConversationKey)
      )
  );
  for (const project of projects) {
    const reference = personalInventoryReference(project);
    const ungrouped =
      !project.namedProject &&
      (project.contextKind === "independent" ||
        reference.kind === "unresolved");
    const id = ungrouped ? "no-project" : project.id;
    const group = groups.get(id) ?? {
      id,
      name: ungrouped ? "No project" : project.name,
      latestAt: "",
      conversations: []
    };
    for (const thread of project.threads) {
      if (
        thread.threadKind === "subagent" ||
        (!project.namedProject &&
          assigned.has(personalInventoryConversationKey(thread)))
      )
        continue;
      const intent = intents.find(
        (item) =>
          item.executionId &&
          ((item.capturedSessionId &&
            item.capturedSessionId === thread.sessionId) ||
            item.executionId === sessionSelectionId(thread))
      );
      if (intent?.executionId) capturedExecutions.add(intent.executionId);
      const key = personalInventoryConversationKey(thread);
      const row: SidebarConversation = {
        key,
        aliases: intent?.executionId
          ? [key, `execution:${intent.executionId}`]
          : [key],
        title: thread.name || "Conversation",
        latestAt: thread.latestAt ?? "",
        client:
          thread.sourceAiClient === "claude-code"
            ? "claude"
            : thread.sourceAiClient === "pi"
              ? "pi"
              : thread.sourceAiClient === "codex" ||
                  thread.sourceAiClient === "codex-cli"
                ? "codex"
                : (intent?.aiClientDriverId ?? null),
        route: {
          kind: "conversation",
          projectId: project.id,
          threadId: thread.id,
          ...(intent?.executionId ? { executionId: intent.executionId } : {})
        },
        projectName: group.name
      };
      const existing = group.conversations.findIndex(
        (item) => item.key === key
      );
      if (existing < 0) group.conversations.push(row);
      else if (
        timestamp(row.latestAt) >
        timestamp(group.conversations[existing]!.latestAt)
      )
        group.conversations[existing] = row;
    }
    // Named Projects remain available even when they have no conversations.
    if (group.conversations.length || project.namedProject)
      groups.set(id, group);
  }
  for (const intent of intents) {
    if (!intent.executionId) continue;
    // Once membership was confirmed, later rule changes/removals are authoritative.
    if (
      intent.projectMembershipConfirmed &&
      capturedExecutions.has(intent.executionId)
    )
      continue;
    const alreadyShown = intent.presentationProjectId
      ? groups
          .get(intent.presentationProjectId)
          ?.conversations.some(
            (row) => row.route.executionId === intent.executionId
          )
      : capturedExecutions.has(intent.executionId);
    if (alreadyShown) continue;
    const draft = drafts.get(intent.executionId);
    const project = projects.find((p) => p.id === intent.presentationProjectId);
    const id = project?.id ?? "no-project";
    const group = groups.get(id) ?? {
      id,
      name: project?.name ?? "No project",
      latestAt: "",
      conversations: []
    };
    group.conversations.push({
      key: `execution:${intent.executionId}`,
      aliases: [`execution:${intent.executionId}`],
      title: draft?.thread.name || "New Conversation",
      latestAt: draft?.thread.latestAt ?? intent.createdAt,
      client: intent.aiClientDriverId,
      route: { kind: "conversation", executionId: intent.executionId },
      projectName: group.name
    });
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((group) => {
      group.conversations.sort(activityOrder);
      group.latestAt = group.conversations[0]?.latestAt ?? "";
      return group;
    })
    .sort(activityOrder);
}

export function filterSidebar(
  projects: readonly SidebarProject[],
  query: string
): SidebarProject[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [...projects];
  return projects.flatMap((project) => {
    if (project.name.toLocaleLowerCase().includes(term)) return [project];
    const conversations = project.conversations.filter((row) =>
      row.title.toLocaleLowerCase().includes(term)
    );
    return conversations.length ? [{ ...project, conversations }] : [];
  });
}

export function pinnedConversations(
  projects: readonly SidebarProject[],
  pins: readonly string[]
): SidebarConversation[] {
  const rows = projects.flatMap((p) => p.conversations);
  const seen = new Set<string>();
  return pins.flatMap((pin) => {
    const row = rows.find((candidate) => candidate.aliases.includes(pin));
    if (!row || seen.has(row.key)) return [];
    seen.add(row.key);
    return [row];
  });
}
