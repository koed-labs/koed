import type {
  CollaborationSelection,
  CollaborationSnapshot
} from "@koed/shared/collaboration";

import type { DesktopRoute } from "./navigation.js";

export type CommandDestination =
  | { kind: "route"; route: DesktopRoute }
  | { kind: "selection"; selection: CollaborationSelection };

export type DesktopCommand = {
  destination: CommandDestination;
  id: string;
  label: string;
  scope: string;
};

const threadLabel = (
  thread: {
    name: string | null;
    participants: readonly { id: string; displayName: string }[];
  },
  currentUserId: string
): string => {
  if (thread.name) return thread.name;
  const names = thread.participants
    .filter(({ id }) => id !== currentUserId)
    .map(({ displayName }) => displayName);
  return names.join(", ") || "Direct message";
};

export const commandEntriesForSnapshot = (
  snapshot: CollaborationSnapshot | null,
  activeTeamId?: string | null
): readonly DesktopCommand[] => {
  const commands: DesktopCommand[] = [
    {
      destination: { kind: "route", route: { kind: "inbox" } },
      id: "route:inbox",
      label: "Inbox",
      scope: "Activity"
    },
    {
      destination: {
        kind: "route",
        route: { kind: "personal-memory-projects" }
      },
      id: "route:personal-memory",
      label: "Personal Memory",
      scope: "Personal"
    },
    {
      destination: {
        kind: "route",
        route: { kind: "preferences", section: "general" }
      },
      id: "route:preferences",
      label: "Preferences",
      scope: "Desktop"
    }
  ];
  if (!snapshot) return commands;

  commands.splice(2, 0, {
    destination: {
      kind: "route",
      route: { kind: "personal-memory-notes" }
    },
    id: "route:personal-memory-notes",
    label: "Notes",
    scope: "Personal"
  });
  for (const thread of snapshot.navigation.personal.channels) {
    if (thread.lifecycle === "purged" || thread.lifecycle === "tombstoned") {
      continue;
    }
    commands.push({
      destination: {
        kind: "selection",
        selection: { kind: "personal_channel", threadId: thread.id }
      },
      id: `selection:personal:${thread.id}`,
      label: `# ${thread.name}`,
      scope:
        thread.lifecycle === "archived" ? "Personal · Archived" : "Personal"
    });
  }

  const principalId = snapshot.navigation.teamPrincipal?.id ?? "";
  for (const team of snapshot.navigation.teams) {
    if (team.lifecycle !== "active") continue;
    commands.push({
      destination: {
        kind: "selection",
        selection: { kind: "team_people", teamId: team.id }
      },
      id: `selection:team:${team.id}:people`,
      label: "People",
      scope: team.name
    });
    if (activeTeamId !== undefined && team.id !== activeTeamId) continue;
    for (const thread of team.directMessages) {
      if (thread.lifecycle !== "active") continue;
      commands.push({
        destination: {
          kind: "selection",
          selection: {
            kind: "team_direct_message",
            teamId: team.id,
            threadId: thread.id
          }
        },
        id: `selection:team:${team.id}:dm:${thread.id}`,
        label: threadLabel(thread, principalId),
        scope: `${team.name} · Direct message`
      });
    }
    for (const workspace of team.workspaces) {
      if (workspace.lifecycle !== "active") continue;
      commands.push({
        destination: {
          kind: "selection",
          selection: {
            kind: "workspace_shared_memory",
            teamId: team.id,
            workspaceId: workspace.id
          }
        },
        id: `selection:team:${team.id}:workspace:${workspace.id}:memory`,
        label: "Shared Memory",
        scope: `${team.name} · ${workspace.name}`
      });
      for (const thread of workspace.channels) {
        if (thread.lifecycle !== "active") continue;
        commands.push({
          destination: {
            kind: "selection",
            selection: {
              kind: "workspace_channel",
              teamId: team.id,
              workspaceId: workspace.id,
              threadId: thread.id
            }
          },
          id: `selection:team:${team.id}:workspace:${workspace.id}:channel:${thread.id}`,
          label: `# ${thread.name}`,
          scope: `${team.name} · ${workspace.name}`
        });
      }
    }
  }
  return commands;
};
