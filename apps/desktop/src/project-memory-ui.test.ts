import { describe, expect, it } from "vitest";
import {
  assignmentTargetProjects,
  LatestRequestGate,
  mergeProjectSources,
  projectIdForSession,
  projectIsActive,
  projectLatestAt,
  reconcileSelectedProjectId,
  relativeTime,
  repositoryPresentationFromRemoteDisplay,
  repoLabelFromRemoteDisplay,
  repoUrlFromRemoteDisplay,
  sessionPreview,
  sessionSelectionId,
  sortProjects,
  type DesktopProjectGroup,
  type DesktopProjectMetadata
} from "./project-memory-ui.js";

const metadata = (
  overrides: Partial<DesktopProjectMetadata> = {}
): DesktopProjectMetadata => ({
  schemaVersion: 1,
  discoveredAt: "2026-06-01T00:00:00.000Z",
  lastSeenAt: "2026-07-09T12:00:00.000Z",
  localProjectId: "lp_koed",
  displayName: "koed",
  path: {
    cwd: "/Users/jedd/agents/koed",
    projectRoot: "/Users/jedd/agents/koed",
    basename: "koed",
    localPathHash: "hmac_sha256:local"
  },
  git: {
    branch: "codex/project-ui",
    isWorktree: true,
    remotes: [{ display: "github.com/koed-labs/koed" }]
  },
  ...overrides
});

const graphProject = (
  overrides: Partial<DesktopProjectGroup> = {}
): DesktopProjectGroup => ({
  id: "graph-koed",
  name: "Koed capture",
  path: "/Users/jedd/agents/koed",
  eventCount: 12,
  threads: [
    {
      id: "thread-1",
      name: "Design the desktop",
      sessionId: "session-1",
      projectId: "graph-koed",
      projectName: "Koed capture",
      projectPath: "/Users/jedd/agents/koed",
      eventCount: 12,
      invalidatedCount: 0,
      latestAt: "2026-07-08T10:00:00.000Z",
      sample: "Create a project-first UI"
    }
  ],
  ...overrides
});

describe("repoUrlFromRemoteDisplay", () => {
  it("presents standalone conversations as one Chats project while preserving their identity", () => {
    const standaloneMetadata = metadata({
      displayName: "Independent",
      contextKind: "independent",
      localProjectId: "lp_chats",
      path: { cwd: "/tmp/koed/projects/Independent", projectRoot: null }
    });
    const standalone = graphProject({
      id: "lp_chats",
      name: "Independent",
      path: standaloneMetadata.path.cwd
    });
    const projects = mergeProjectSources([standalone], [standaloneMetadata]);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: "lp_chats",
      name: "Chats",
      contextKind: "independent",
      threads: standalone.threads
    });
  });

  it("keeps Chats identity when capture reports a private runtime directory", () => {
    const root = metadata({
      localProjectId: "lp_chats",
      displayName: "Independent",
      contextKind: "independent",
      path: { cwd: "/tmp/koed/projects/Independent", projectRoot: null }
    });
    const runtimePath =
      "/tmp/koed/managed-conversations/independent/6749259b-8f10-4b53-92d8-66e7f87a8663";
    const captured = graphProject({
      id: "lp_chats",
      name: "6749259b-8f10-4b53-92d8-66e7f87a8663",
      path: runtimePath
    });
    const runtimeMetadata = metadata({
      localProjectId: "lp_runtime",
      displayName: captured.name,
      path: { cwd: runtimePath, projectRoot: null }
    });
    const projects = mergeProjectSources([captured], [root, runtimeMetadata]);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: "lp_chats",
      name: "Chats",
      contextKind: "independent",
      path: root.path.cwd,
      threads: captured.threads
    });
    expect(projectIdForSession(projects, "session-1")).toBe("lp_chats");
  });

  it.each([
    "/tmp/koed",
    "C:\\Users\\Operator\\koed",
    "\\\\server\\share\\koed"
  ])(
    "merges legacy standalone runtime Projects into Chats under %s",
    (home) => {
      const root = metadata({
        localProjectId: "lp_chats",
        displayName: "Independent",
        contextKind: "independent",
        path: { cwd: `${home}/projects/Independent`, projectRoot: null }
      });
      const path = `${home}/managed-conversations/independent/6749259b-8f10-4b53-92d8-66e7f87a8663`;
      const captured = graphProject({ id: "lp_runtime", path });
      const projects = mergeProjectSources([captured], [root]);
      expect(projects).toHaveLength(1);
      expect(projects[0]?.threads).toEqual(captured.threads);
      expect(projects[0]?.id).toBe("lp_chats");
    }
  );

  it("keeps user Projects named Independent, including lookalike paths, available as Projects", () => {
    const ordinary = metadata({
      displayName: "Independent",
      path: { cwd: "/work/projects/Independent", projectRoot: null }
    });
    expect(mergeProjectSources([], [ordinary])[0]).toMatchObject({
      name: "Independent",
      contextKind: "project"
    });
    expect(
      mergeProjectSources([graphProject({ name: "Independent" })], [])[0]
    ).toMatchObject({
      name: "Independent",
      contextKind: "project"
    });
  });

  it("prefixes a normalized remote display with https://", () => {
    expect(repoUrlFromRemoteDisplay("github.com/koed-labs/koed")).toBe(
      "https://github.com/koed-labs/koed"
    );
  });
});

describe("repositoryPresentationFromRemoteDisplay", () => {
  it("shortens GitHub remotes with GitHub presentation", () => {
    expect(
      repositoryPresentationFromRemoteDisplay("github.com/koed-labs/koed")
    ).toEqual({
      host: "github.com",
      label: "koed-labs/koed",
      provider: "github",
      url: "https://github.com/koed-labs/koed"
    });
    expect(repoLabelFromRemoteDisplay("github.com/koed-labs/koed")).toBe(
      "koed-labs/koed"
    );
  });

  it("retains the host and generic Git presentation for other remotes", () => {
    expect(
      repositoryPresentationFromRemoteDisplay("gitlab.example/koed/koed")
    ).toEqual({
      host: "gitlab.example",
      label: "gitlab.example/koed/koed",
      provider: "git",
      url: "https://gitlab.example/koed/koed"
    });
    expect(repoLabelFromRemoteDisplay("gitlab.example/koed/koed")).toBe(
      "gitlab.example/koed/koed"
    );
  });
});

describe("project memory UI view model", () => {
  it("merges persisted identity metadata into captured Project activity", () => {
    const [project] = mergeProjectSources([graphProject()], [metadata()]);

    expect(project).toMatchObject({
      id: "graph-koed",
      name: "koed",
      eventCount: 12,
      localProjectId: "lp_koed",
      branch: "codex/project-ui",
      remoteDisplay: "github.com/koed-labs/koed",
      catalogued: true
    });
  });

  it("consolidates captured Project identities that resolve to the same path", () => {
    const projects = mergeProjectSources(
      [
        graphProject({
          id: "legacy-koed",
          eventCount: 5,
          threads: [
            {
              ...graphProject().threads[0]!,
              id: "legacy-thread",
              projectId: "legacy-koed",
              eventCount: 5,
              latestAt: "2026-07-09T10:00:00.000Z"
            }
          ]
        }),
        graphProject({
          id: "lp_koed",
          path: "/Users/jedd/agents/koed/",
          eventCount: 7,
          threads: [
            {
              ...graphProject().threads[0]!,
              id: "current-thread",
              projectId: "lp_koed",
              eventCount: 7,
              latestAt: "2026-07-10T10:00:00.000Z"
            }
          ]
        })
      ],
      [metadata()]
    );

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: "lp_koed",
      path: "/Users/jedd/agents/koed/",
      eventCount: 12,
      localProjectId: "lp_koed"
    });
    expect(projects[0]?.threads.map(({ id }) => id)).toEqual([
      "current-thread",
      "legacy-thread"
    ]);
    expect(projects[0]?.threads.map(({ projectId }) => projectId)).toEqual([
      "lp_koed",
      "legacy-koed"
    ]);
  });

  it("keeps different checkout paths as separate Projects", () => {
    const projects = mergeProjectSources(
      [
        graphProject(),
        graphProject({
          id: "graph-koed-worktree",
          path: "/Users/jedd/agents/koed-feature",
          threads: []
        })
      ],
      [metadata()]
    );

    expect(projects).toHaveLength(2);
  });

  it("keeps catalogued Projects visible before they have captured sessions", () => {
    const [project] = mergeProjectSources([], [metadata()]);

    expect(project).toMatchObject({
      id: "lp_koed",
      eventCount: 0,
      threads: [],
      localProjectId: "lp_koed"
    });
  });

  it("uses conversation activity rather than catalogue refresh time for active state", () => {
    const project = mergeProjectSources([graphProject()], [metadata()])[0]!;
    const now = Date.parse("2026-07-10T12:00:00.000Z");

    expect(projectLatestAt(project)).toBe("2026-07-08T10:00:00.000Z");
    expect(projectIsActive(project, now)).toBe(true);
    expect(
      projectIsActive(
        { ...project, lastSeenAt: "2026-05-01T00:00:00.000Z", threads: [] },
        now
      )
    ).toBe(false);
  });

  it("orders Projects by conversations even when an older Project was just rediscovered", () => {
    const base = mergeProjectSources([graphProject()], [metadata()])[0]!;
    const old = {
      ...base,
      id: "old",
      lastSeenAt: "2026-09-10T09:00:00Z",
      threads: [{ ...base.threads[0]!, latestAt: "2026-09-03T09:00:00Z" }]
    };
    const recent = {
      ...base,
      id: "recent",
      lastSeenAt: "2026-09-01T09:00:00Z",
      threads: [{ ...base.threads[0]!, latestAt: "2026-09-10T08:00:00Z" }]
    };
    const empty = {
      ...base,
      id: "empty",
      lastSeenAt: "2026-09-10T09:00:00Z",
      threads: []
    };
    expect(
      sortProjects([old, empty, recent]).map((project) => project.id)
    ).toEqual(["recent", "old", "empty"]);
    expect(
      relativeTime(projectLatestAt(old), Date.parse("2026-09-10T09:00:00Z"))
    ).toBe("7d ago");
    expect(projectIsActive(old, Date.parse("2026-10-10T09:00:00Z"))).toBe(
      false
    );
    expect(projectLatestAt(empty)).toBeNull();
    expect(projectIsActive(empty)).toBe(false);
  });

  it("formats activity and prefers a captured session id", () => {
    const project = graphProject();
    const thread = project.threads[0]!;
    expect(
      relativeTime(thread.latestAt, Date.parse("2026-07-10T10:00:00Z"))
    ).toBe("2d ago");
    expect(sessionSelectionId(thread)).toBe("session-1");
    expect(projectIdForSession([project], "session-1")).toBe("graph-koed");
    expect(projectIdForSession([project], "missing-session")).toBeNull();
  });

  it("keeps tool payloads out of Captured Session previews", () => {
    expect(
      sessionPreview({
        name: "Open a focused PR",
        sample: "Tool call: exec Status: completed Input: { cmd: 'git push' }"
      })
    ).toBe("Open the Conversation to review this Captured Session.");
    expect(
      sessionPreview({
        name: "Open a focused PR",
        sample: "Tool output: exec\n\nsecret-looking tool payload"
      })
    ).toBe("Open the Conversation to review this Captured Session.");
    expect(
      sessionPreview({
        name: "Refine Desktop",
        sample: "  The Desktop layout now keeps Project context visible.  "
      })
    ).toBe("The Desktop layout now keeps Project context visible.");
  });

  it("excludes Unassigned from manual move targets", () => {
    const projects = mergeProjectSources(
      [
        graphProject(),
        graphProject({
          id: "unassigned",
          name: "Unassigned",
          path: null,
          threads: []
        })
      ],
      [metadata()]
    );

    expect(
      assignmentTargetProjects(projects).map((project) => project.id)
    ).toEqual(["graph-koed"]);
    expect(assignmentTargetProjects(projects, "graph-koed")).toEqual([]);
  });

  it("preserves deliberate inactive-collapse clearing but reconciles missing Projects", () => {
    const active = mergeProjectSources(
      [graphProject()],
      [metadata({ lastSeenAt: new Date().toISOString() })]
    );

    expect(reconcileSelectedProjectId(active, null, true)).toBeNull();
    expect(
      reconcileSelectedProjectId(
        active,
        "deleted-project",
        false,
        Date.parse("2026-07-10T00:00:00.000Z")
      )
    ).toBe("graph-koed");
  });

  it("rejects stale Project graph responses", () => {
    const gate = new LatestRequestGate();
    const firstRequest = gate.begin();
    const secondRequest = gate.begin();

    expect(gate.isCurrent(firstRequest)).toBe(false);
    expect(gate.isCurrent(secondRequest)).toBe(true);
  });
});
