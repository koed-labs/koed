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
  sessionPreview,
  sessionSelectionId,
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

  it("keeps catalogued Projects visible before they have captured sessions", () => {
    const [project] = mergeProjectSources([], [metadata()]);

    expect(project).toMatchObject({
      id: "lp_koed",
      eventCount: 0,
      threads: [],
      localProjectId: "lp_koed"
    });
  });

  it("uses the newest catalogue or session activity for active state", () => {
    const project = mergeProjectSources([graphProject()], [metadata()])[0]!;
    const now = Date.parse("2026-07-10T12:00:00.000Z");

    expect(projectLatestAt(project)).toBe("2026-07-09T12:00:00.000Z");
    expect(projectIsActive(project, now)).toBe(true);
    expect(
      projectIsActive(
        { ...project, lastSeenAt: "2026-05-01T00:00:00.000Z", threads: [] },
        now
      )
    ).toBe(false);
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
    const active = mergeProjectSources([graphProject()], [metadata()]);

    expect(reconcileSelectedProjectId(active, null, true)).toBeNull();
    expect(reconcileSelectedProjectId(active, "deleted-project", false)).toBe(
      "graph-koed"
    );
  });

  it("rejects stale Project graph responses", () => {
    const gate = new LatestRequestGate();
    const firstRequest = gate.begin();
    const secondRequest = gate.begin();

    expect(gate.isCurrent(firstRequest)).toBe(false);
    expect(gate.isCurrent(secondRequest)).toBe(true);
  });
});
