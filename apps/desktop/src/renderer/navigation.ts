export type PersonalRoute =
  | { kind: "personal-memory-projects" }
  | { kind: "personal-memory-shares"; shareKey?: string }
  | { kind: "personal-memory-project"; projectId: string }
  | {
      kind: "personal-memory-session";
      projectId: string;
      sessionId: string;
    }
  | { kind: "personal-chat"; threadId: string };

export type TeamRoute =
  | { kind: "team-people"; teamId: string }
  | { kind: "team-direct-message"; teamId: string; threadId: string }
  | {
      kind: "workspace-channel";
      teamId: string;
      workspaceId: string;
      threadId: string;
    }
  | {
      kind: "workspace-shared-memory";
      teamId: string;
      workspaceId: string;
    }
  | {
      kind: "shared-session";
      teamId: string;
      workspaceId: string;
      sharedSessionId: string;
    };

export type DesktopRoute =
  | { kind: "inbox" }
  | PersonalRoute
  | TeamRoute
  | {
      kind: "preferences";
      section:
        | "general"
        | "capture"
        | "ai-clients"
        | "team-connection"
        | "about"
        | "advanced";
    }
  | { kind: "onboarding" };

export type RouteAuthority = {
  backendId: string | null;
  principalId: string;
  teamId?: string;
  workspaceId?: string;
  threadId?: string;
  sharedSessionId?: string;
};

export type NavigationEntry = {
  route: DesktopRoute;
  authority: RouteAuthority;
};

export type NavigationState = {
  entries: NavigationEntry[];
  index: number;
};

export type NavigationAction =
  | { type: "push"; entry: NavigationEntry }
  | { type: "replace"; entry: NavigationEntry }
  | { type: "back" }
  | { type: "forward" }
  | {
      type: "reconcile-authority";
      isAuthorized: (entry: NavigationEntry) => boolean;
      fallback: NavigationEntry;
    };

export const createNavigationState = (
  initial: NavigationEntry
): NavigationState => ({
  entries: [initial],
  index: 0
});

export const currentNavigationEntry = (
  state: NavigationState
): NavigationEntry => state.entries[state.index]!;

const entriesEqual = (left: NavigationEntry, right: NavigationEntry): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const navigationReducer = (
  state: NavigationState,
  action: NavigationAction
): NavigationState => {
  switch (action.type) {
    case "push": {
      const current = currentNavigationEntry(state);
      if (entriesEqual(current, action.entry)) return state;
      return {
        entries: [...state.entries.slice(0, state.index + 1), action.entry],
        index: state.index + 1
      };
    }
    case "replace": {
      const entries = [...state.entries];
      entries[state.index] = action.entry;
      return { entries, index: state.index };
    }
    case "back":
      return { ...state, index: Math.max(0, state.index - 1) };
    case "forward":
      return {
        ...state,
        index: Math.min(state.entries.length - 1, state.index + 1)
      };
    case "reconcile-authority": {
      const entries = state.entries.filter(action.isAuthorized);
      if (entries.length === 0) return createNavigationState(action.fallback);

      const current = currentNavigationEntry(state);
      const currentIndex = entries.findIndex((entry) =>
        entriesEqual(entry, current)
      );
      if (currentIndex >= 0) return { entries, index: currentIndex };

      const previousAuthorized = state.entries
        .slice(0, state.index)
        .reverse()
        .find(action.isAuthorized);
      if (previousAuthorized) {
        return {
          entries,
          index: entries.findIndex((entry) =>
            entriesEqual(entry, previousAuthorized)
          )
        };
      }

      return {
        entries: [...entries, action.fallback],
        index: entries.length
      };
    }
  }
};

export const routePath = (route: DesktopRoute): string => {
  switch (route.kind) {
    case "inbox":
      return "/inbox";
    case "personal-memory-projects":
      return "/personal/memory/projects";
    case "personal-memory-shares":
      return route.shareKey
        ? `/personal/memory/shares/${encodeURIComponent(route.shareKey)}`
        : "/personal/memory/shares";
    case "personal-memory-project":
      return `/personal/memory/projects/${encodeURIComponent(route.projectId)}`;
    case "personal-memory-session":
      return `/personal/memory/projects/${encodeURIComponent(route.projectId)}/session/${encodeURIComponent(route.sessionId)}`;
    case "personal-chat":
      return `/personal/chat/${encodeURIComponent(route.threadId)}`;
    case "team-people":
      return `/team/${encodeURIComponent(route.teamId)}/people`;
    case "team-direct-message":
      return `/team/${encodeURIComponent(route.teamId)}/dm/${encodeURIComponent(route.threadId)}`;
    case "workspace-channel":
      return `/team/${encodeURIComponent(route.teamId)}/ws/${encodeURIComponent(route.workspaceId)}/channel/${encodeURIComponent(route.threadId)}`;
    case "workspace-shared-memory":
      return `/team/${encodeURIComponent(route.teamId)}/ws/${encodeURIComponent(route.workspaceId)}/memory`;
    case "shared-session":
      return `/team/${encodeURIComponent(route.teamId)}/ws/${encodeURIComponent(route.workspaceId)}/memory/${encodeURIComponent(route.sharedSessionId)}`;
    case "preferences":
      return `/preferences/${route.section}`;
    case "onboarding":
      return "/onboarding";
  }
};
