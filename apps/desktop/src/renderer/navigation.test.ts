import { describe, expect, it } from "vitest";
import {
  createNavigationState,
  currentNavigationEntry,
  navigationReducer,
  routePath,
  sessionProjectRoute,
  type NavigationEntry
} from "./navigation.js";

const personal: NavigationEntry = {
  route: { kind: "personal-memory-projects" },
  authority: { backendId: null, principalId: "personal-user" }
};

const teamChannel: NavigationEntry = {
  route: {
    kind: "workspace-channel",
    teamId: "team",
    workspaceId: "workspace",
    threadId: "thread"
  },
  authority: {
    backendId: "backend",
    principalId: "remote-user",
    teamId: "team",
    workspaceId: "workspace",
    threadId: "thread"
  }
};

describe("navigationReducer", () => {
  it("maintains bounded back and forward history", () => {
    let state = createNavigationState(personal);
    state = navigationReducer(state, { type: "push", entry: teamChannel });
    expect(currentNavigationEntry(state)).toEqual(teamChannel);

    state = navigationReducer(state, { type: "back" });
    expect(currentNavigationEntry(state)).toEqual(personal);
    state = navigationReducer(state, { type: "back" });
    expect(currentNavigationEntry(state)).toEqual(personal);

    state = navigationReducer(state, { type: "forward" });
    expect(currentNavigationEntry(state)).toEqual(teamChannel);
  });

  it("returns from a Conversation to its filtered Project list", () => {
    const sourceFilter = {
      kind: "folder" as const,
      key: "full-folder-identity",
      gitKey: "anchor-identity"
    };
    expect(
      sessionProjectRoute({
        kind: "personal-memory-session",
        projectId: "git-anchor",
        sessionId: "logical-session",
        sourceFilter
      })
    ).toEqual({
      kind: "personal-memory-project",
      projectId: "git-anchor",
      sourceFilter
    });
    expect(
      sessionProjectRoute({
        kind: "personal-memory-session",
        projectId: "git-anchor",
        sessionId: "logical-session"
      })
    ).toEqual({ kind: "personal-memory-project", projectId: "git-anchor" });
  });

  it("retains an exact nested source filter and context through Conversation back/forward navigation", () => {
    const entry: NavigationEntry = {
      ...personal,
      route: {
        kind: "personal-memory-project",
        projectId: "named-project",

        sourceFilter: {
          kind: "folder",
          key: "full-folder-identity",
          gitKey: "anchor-identity"
        }
      }
    };
    const session: NavigationEntry = {
      ...entry,
      route: {
        ...entry.route,
        kind: "personal-memory-session",
        projectId: "named-project",
        sessionId: "logical-session",

        sourceFilter: {
          kind: "folder",
          key: "full-folder-identity",
          gitKey: "anchor-identity"
        }
      }
    };
    let state = navigationReducer(createNavigationState(entry), {
      type: "push",
      entry: session
    });
    state = navigationReducer(state, { type: "back" });
    expect(currentNavigationEntry(state)).toEqual(entry);
    const query = new URLSearchParams(routePath(entry.route).split("?")[1]);
    expect(JSON.parse(query.get("source")!)).toEqual({
      kind: "folder",
      key: "full-folder-identity",
      gitKey: "anchor-identity"
    });
    state = navigationReducer(state, { type: "forward" });
    expect(currentNavigationEntry(state)).toEqual(session);
  });

  it("drops forward history when a new route is pushed", () => {
    const preferences: NavigationEntry = {
      route: { kind: "preferences", section: "general" },
      authority: personal.authority
    };
    let state = createNavigationState(personal);
    state = navigationReducer(state, { type: "push", entry: teamChannel });
    state = navigationReducer(state, { type: "back" });
    state = navigationReducer(state, { type: "push", entry: preferences });

    expect(state.entries).toEqual([personal, preferences]);
    expect(currentNavigationEntry(state)).toEqual(preferences);
  });

  it("evicts inaccessible Team history without resurrecting stale labels", () => {
    const teamPeople: NavigationEntry = {
      route: { kind: "team-people", teamId: "team" },
      authority: {
        backendId: "backend",
        principalId: "remote-user",
        teamId: "team"
      }
    };
    let state = createNavigationState(personal);
    state = navigationReducer(state, { type: "push", entry: teamPeople });
    state = navigationReducer(state, { type: "push", entry: teamChannel });

    state = navigationReducer(state, {
      type: "reconcile-authority",
      isAuthorized: (entry) => entry.authority.teamId !== "team",
      fallback: personal
    });

    expect(state.entries).toEqual([personal]);
    expect(currentNavigationEntry(state)).toEqual(personal);
  });

  it("retains an authorized current route while pruning unrelated history", () => {
    let state = createNavigationState(teamChannel);
    state = navigationReducer(state, { type: "push", entry: personal });
    state = navigationReducer(state, { type: "back" });
    state = navigationReducer(state, {
      type: "reconcile-authority",
      isAuthorized: (entry) =>
        entry.authority.backendId === "backend" ||
        entry.authority.backendId === null,
      fallback: personal
    });

    expect(currentNavigationEntry(state)).toEqual(teamChannel);
  });
});

describe("routePath", () => {
  it("creates deterministic diagnostic paths without becoming a URL router", () => {
    expect(routePath(teamChannel.route)).toBe(
      "/team/team/ws/workspace/channel/thread"
    );
    expect(
      routePath({
        kind: "personal-memory-session",
        projectId: "Project with spaces",
        sessionId: "session/one"
      })
    ).toBe(
      "/personal/memory/projects/Project%20with%20spaces/session/session%2Fone"
    );
    expect(
      routePath({
        kind: "personal-memory-shares",
        shareKey: "pending:share/one"
      })
    ).toBe("/personal/memory/shares/pending%3Ashare%2Fone");
    expect(
      routePath({
        kind: "personal-memory-ask",
        askThreadId: "ask/thread one"
      })
    ).toBe("/personal/memory/ask/ask%2Fthread%20one");
    expect(
      routePath({
        kind: "personal-memory-notes",
        noteId: "note/one"
      })
    ).toBe("/personal/memory/notes/note%2Fone");
    expect(routePath({ kind: "personal-memory-notes", newNote: true })).toBe(
      "/personal/memory/notes/new"
    );
  });
});
