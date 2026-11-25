import {
  displayConversationTitle,
  type PersonalProjectKin
} from "@koed-labs/shared";
import {
  personalInventoryConversationKey,
  personalInventoryReference
} from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../project-memory-ui.js";
import { sessionSelectionId } from "../../project-memory-ui.js";
import type { V1ConversationIntent } from "../../ipc/v1-state-protocol.js";
import type { ManagedConversationDraft } from "../state/use-managed-conversation-lifecycle.js";

export type ConversationRoute = {
  kind: "conversation";
  conversationKey?: string;
  originGroupId?: string;
  projectId?: string;
  threadId?: string;
  executionId?: string;
  sessionId?: string;
};
export type NavigationRoute =
  | { kind: "home" }
  | { kind: "recall" }
  | ConversationRoute;
export type SidebarConversation = {
  key: string;
  aliases: string[];
  title: string;
  latestAt: string;
  client: "codex" | "claude" | "pi" | null;
  route: ConversationRoute;
  projectName: string;
  sessionId?: string;
  sourceSessionIds?: readonly string[];
  sourceProjectId?: string;
  managementPending?: boolean;
};
/** Captures that belong to no Project or Anchor. Home shows them as floor coins. */
export const NO_PROJECT_ID = "no-project";
export const NO_ANCHOR_ID = "no-anchor";

/** Git Anchor and Folder groups, which the sidebar lists under Anchors. */
export const isAnchorGroup = (project: SidebarProject) =>
  Boolean(project.source) || project.id === NO_ANCHOR_ID;

export type SidebarProject = {
  id: string;
  name: string;
  latestAt: string;
  conversations: SidebarConversation[];
  managed?: boolean;
  /** The Project's saved Kin, when it has one; its look is derived otherwise. */
  kin?: PersonalProjectKin;
  // An unnamed group of captures sharing a Git Anchor or Folder.
  source?: "git" | "folder";
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
  // Raw Git/Folder inventory overlaps named Project memberships. Anchors list
  // all their Conversations; No project holds only unassigned captures.
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
    const id = ungrouped ? NO_PROJECT_ID : project.id;
    const group = groups.get(id) ?? {
      id,
      name: ungrouped ? "No project" : project.name,
      latestAt: "",
      conversations: [],
      managed: Boolean(project.namedProject),
      ...(project.namedProject?.kin ? { kin: project.namedProject.kin } : {}),
      ...(!project.namedProject &&
        !ungrouped &&
        (reference.kind === "git" || reference.kind === "folder") && {
          source: reference.kind
        })
    };
    for (const thread of project.threads) {
      if (
        thread.threadKind === "subagent" ||
        (ungrouped && assigned.has(personalInventoryConversationKey(thread)))
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
        title: displayConversationTitle(thread.name) ?? "Conversation",
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
          sessionId: thread.sessionId ?? undefined,
          ...(intent?.executionId ? { executionId: intent.executionId } : {})
        },
        projectName: group.name,
        sessionId: thread.sessionId ?? undefined,
        sourceSessionIds: thread.sourceReferences?.flatMap((ref) =>
          ref.sessionId ? [ref.sessionId] : []
        ),
        sourceProjectId: project.namedProject ? project.id : undefined,
        managementPending: Boolean(
          intent?.presentationProjectId && !intent.projectMembershipConfirmed
        )
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
    if (!draft && !capturedExecutions.has(intent.executionId)) continue;
    const project = projects.find((p) => p.id === intent.presentationProjectId);
    const id = project?.id ?? NO_PROJECT_ID;
    const group = groups.get(id) ?? {
      id,
      name: project?.name ?? "No project",
      latestAt: "",
      conversations: [],
      managed: Boolean(project?.namedProject)
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

/** No anchor is a sidebar view, not a Project or a source context. */
export function sidebarGroups(
  projects: readonly SidebarProject[],
  anchorInventoryReady = true
): SidebarProject[] {
  const anchored = new Set(
    projects
      .filter((group) => group.source)
      .flatMap((group) => group.conversations.flatMap((row) => row.aliases))
  );
  const withoutAnchor: SidebarConversation[] = [];
  const groupName = anchorInventoryReady ? "No anchor" : "Source pending";
  const seen = new Set(anchored);
  const rows = projects
    .flatMap((group) => group.conversations)
    .sort(
      (a, b) =>
        Number(Boolean(b.sessionId)) - Number(Boolean(a.sessionId)) ||
        activityOrder(a, b)
    );
  for (const row of rows) {
    const alreadyListed = row.aliases.some((alias) => seen.has(alias));
    for (const alias of row.aliases) seen.add(alias);
    if (!alreadyListed && (anchorInventoryReady || !row.route.threadId))
      withoutAnchor.push({
        ...row,
        projectName: groupName,
        sourceProjectId: undefined
      });
  }
  const groups = projects.filter((group) => group.id !== NO_PROJECT_ID);
  if (!withoutAnchor.length) return groups;
  withoutAnchor.sort(activityOrder);
  return [
    ...groups,
    {
      id: NO_ANCHOR_ID,
      name: groupName,
      latestAt: withoutAnchor[0]!.latestAt,
      conversations: withoutAnchor
    }
  ];
}

export function namedMemberships(projects: readonly SidebarProject[]) {
  const memberships = new Map<string, Set<string>>();
  for (const project of projects) {
    if (!project.managed) continue;
    for (const row of project.conversations) {
      if (row.managementPending || !row.sessionId) continue;
      for (const alias of row.aliases) {
        const ids = memberships.get(alias) ?? new Set<string>();
        ids.add(project.id);
        memberships.set(alias, ids);
      }
    }
  }
  return memberships;
}

export function openSidebarConversation(
  row: SidebarConversation,
  originGroupId?: string
): ConversationRoute {
  return {
    kind: "conversation",
    conversationKey: row.key,
    executionId: row.route.executionId,
    sessionId: row.sessionId,
    originGroupId
  };
}

export function matchesSidebarConversation(
  route: ConversationRoute,
  row: SidebarConversation
): boolean {
  if (route.conversationKey && row.aliases.includes(route.conversationKey))
    return true;
  if (route.executionId && row.route.executionId === route.executionId)
    return true;
  if (
    route.sessionId &&
    (row.sessionId === route.sessionId ||
      row.sourceSessionIds?.includes(route.sessionId))
  )
    return true;
  return Boolean(
    !route.conversationKey &&
    route.threadId &&
    row.route.threadId === route.threadId &&
    row.route.projectId === route.projectId
  );
}

export function resolveConversationByKey(
  projects: readonly DesktopProject[],
  key: string
) {
  let match:
    | { project: DesktopProject; thread: DesktopProject["threads"][number] }
    | undefined;
  for (const project of projects) {
    const thread = project.threads.find(
      (item) =>
        item.threadKind !== "subagent" &&
        personalInventoryConversationKey(item) === key
    );
    if (!thread) continue;
    // Prefer the source inventory to membership views. Break ties without
    // depending on activity or the clicked group.
    if (
      !match ||
      Number(Boolean(project.namedProject)) <
        Number(Boolean(match.project.namedProject)) ||
      (Boolean(project.namedProject) === Boolean(match.project.namedProject) &&
        project.id < match.project.id)
    )
      match = { project, thread };
  }
  return match;
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

export const projectPinKey = (projectId: string) => `project:${projectId}`;

export type SidebarPin =
  | { kind: "project"; key: string; project: SidebarProject }
  | { kind: "conversation"; key: string; row: SidebarConversation };

export function pinnedSidebarItems(
  projects: readonly SidebarProject[],
  pins: readonly string[]
): SidebarPin[] {
  if (!pins.length) return [];
  const byAlias = new Map<string, SidebarPin>();
  for (const project of projects) {
    if (project.managed) {
      const key = projectPinKey(project.id);
      byAlias.set(key, { kind: "project", key, project });
    }
    for (const row of project.conversations) {
      for (const alias of row.aliases) {
        if (!byAlias.has(alias)) {
          byAlias.set(alias, { kind: "conversation", key: row.key, row });
        }
      }
    }
  }
  const seen = new Set<string>();
  return pins.flatMap((pin) => {
    const item = byAlias.get(pin);
    if (!item || seen.has(item.key)) return [];
    seen.add(item.key);
    return [item];
  });
}

/** A row's place among the pins, or Infinity when it is not pinned. */
function pinRank(pins: readonly string[], keys: readonly string[]) {
  let rank = Infinity;
  for (const key of keys) {
    const index = pins.indexOf(key);
    if (index >= 0 && index < rank) rank = index;
  }
  return rank;
}

function pinnedFirstBy<T>(
  items: readonly T[],
  pins: readonly string[],
  keys: (item: T) => readonly string[]
): T[] {
  return items
    .map((item, index) => ({ item, index, rank: pinRank(pins, keys(item)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Pins work in two places. Pinned Projects lead the Projects list, and within
 * each Project its pinned Conversations come first. Both keep pin order; the
 * rest keep their own order.
 */
export function pinnedFirst(
  projects: readonly SidebarProject[],
  pins: readonly string[]
): SidebarProject[] {
  if (!pins.length) return [...projects];
  return pinnedFirstBy(
    projects.map((project) => ({
      ...project,
      conversations: pinnedFirstBy(
        project.conversations,
        pins,
        (row) => row.aliases
      )
    })),
    pins,
    (project) => (project.managed ? [projectPinKey(project.id)] : [])
  );
}
