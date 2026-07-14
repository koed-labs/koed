// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProjectWorkspace,
  type ProjectWorkspaceProps
} from "./ProjectWorkspace.js";
import type { DesktopProject } from "./project-memory-ui.js";

vi.mock("./NativeConversationSurface.js", () => ({
  NativeConversationSurface: ({ thread }: { thread: { id: string } }) => (
    <div data-testid="native-conversation">Conversation {thread.id}</div>
  )
}));

const project = (
  id: string,
  latestAt: string,
  overrides: Partial<DesktopProject> = {}
): DesktopProject => ({
  id,
  name: id === "active" ? "Koed" : "Archived notes",
  path: `/Users/jedd/agents/${id}`,
  eventCount: id === "active" ? 76 : 4,
  threads:
    id === "active"
      ? [
          {
            id: "thread-1",
            name: "Preview auth and avatar rollout",
            sessionId: "session-1",
            sourceAiClient: "codex-cli",
            projectId: id,
            projectName: "Koed",
            projectPath: `/Users/jedd/agents/${id}`,
            projectAssignmentSource: "detected",
            eventCount: 76,
            invalidatedCount: 0,
            latestAt,
            sample:
              "Committed the renderer convergence and verified the selected session."
          }
        ]
      : [],
  catalogued: true,
  discoveredAt: latestAt,
  lastSeenAt: latestAt,
  localProjectId: `local-${id}`,
  branch: id === "active" ? "codex/desktop-memory-ui" : null,
  remoteDisplay: id === "active" ? "github.com/koed-labs/koed" : null,
  isWorktree: id === "active",
  ...overrides
});

const projects = [
  project("active", "2099-07-13T12:00:00.000Z"),
  project("inactive", "2020-01-01T00:00:00.000Z")
];

const defaultProps: ProjectWorkspaceProps = {
  projects,
  view: "project",
  selectedProjectId: "active",
  selectedSessionId: null,
  showInactiveProjects: false,
  projectGraphError: "",
  projectAssignmentBusy: false,
  projectAssignmentError: "",
  apiBaseUrl: "http://127.0.0.1:3300",
  apiToken: "desktop-token"
};

const InactiveCollapseHarness = () => {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    "inactive"
  );
  const [showInactiveProjects, setShowInactiveProjects] = useState(true);
  return (
    <ProjectWorkspace
      {...defaultProps}
      selectedProjectId={selectedProjectId}
      showInactiveProjects={showInactiveProjects}
      onToggleInactive={() => {
        setShowInactiveProjects(false);
        setSelectedProjectId(null);
      }}
    />
  );
};

const WorkspaceSelectionHarness = () => {
  const [view, setView] = useState<ProjectWorkspaceProps["view"]>("projects");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    "active"
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  return (
    <ProjectWorkspace
      {...defaultProps}
      view={view}
      selectedProjectId={selectedProjectId}
      selectedSessionId={selectedSessionId}
      onSelectProject={(projectId) => {
        setSelectedProjectId(projectId);
        setSelectedSessionId(null);
        setView("project");
      }}
      onSelectSession={(sessionId) => {
        setSelectedSessionId(sessionId);
        setView("session");
      }}
    />
  );
};

describe("ProjectWorkspace", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderWorkspace(
    overrides: Partial<ProjectWorkspaceProps> = {}
  ) {
    await act(async () => {
      root.render(<ProjectWorkspace {...defaultProps} {...overrides} />);
    });
  }

  it("keeps the Project master list and selected Project detail in one wide-screen composition", async () => {
    await renderWorkspace();

    expect(container.querySelector(".project-master-pane")).not.toBeNull();
    expect(container.querySelector(".project-detail-column")).not.toBeNull();
    expect(
      container
        .querySelector(".project-workspace")
        ?.getAttribute("data-responsive")
    ).toBe("master-detail-to-drilldown");
    expect(
      container
        .querySelector('[data-project-id="active"]')
        ?.getAttribute("aria-current")
    ).toBe("true");
    const projectHeading = container.querySelector("#selected-project-heading");
    expect(projectHeading?.textContent).toBe("Koed");
    expect(document.activeElement).toBe(projectHeading);
  });

  it("transitions through Project and Captured Session selections", async () => {
    await act(async () => root.render(<WorkspaceSelectionHarness />));

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-project-id="active"]')
        ?.click();
    });
    expect(container.querySelector(".project-workspace")?.className).toContain(
      "route-project"
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-session-id="session-1"]')
        ?.click();
    });
    expect(container.querySelector(".project-workspace")?.className).toContain(
      "route-session"
    );
    expect(
      container.querySelector('[data-testid="native-conversation"]')
        ?.textContent
    ).toContain("thread-1");
  });

  it("keeps inactive Projects discoverable behind an explicit disclosure", async () => {
    const onToggleInactive = vi.fn();
    await renderWorkspace({ onToggleInactive });

    const disclosure = container.querySelector<HTMLButtonElement>(
      "[data-toggle-inactive]"
    );
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-project-id="inactive"]')).toBeNull();

    disclosure?.click();
    expect(onToggleInactive).toHaveBeenCalledOnce();

    await renderWorkspace({ showInactiveProjects: true });
    expect(
      container
        .querySelector("[data-toggle-inactive]")
        ?.getAttribute("aria-expanded")
    ).toBe("true");
    expect(
      container.querySelector('[data-project-id="inactive"]')
    ).not.toBeNull();
  });

  it("clears detail after collapsing selected inactive Project", async () => {
    await act(async () => root.render(<InactiveCollapseHarness />));

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-toggle-inactive]")
        ?.click();
    });

    expect(container.querySelector("#selected-project-heading")).toBeNull();
    expect(container.querySelector("#select-project-heading")).not.toBeNull();
    expect(
      container
        .querySelector('[data-project-id="active"]')
        ?.getAttribute("aria-current")
    ).toBeNull();
  });

  it("prioritizes useful Captured Session context and demotes technical Project metadata", async () => {
    await renderWorkspace();

    const sessionRow = container.querySelector('[data-session-id="session-1"]');
    expect(sessionRow?.textContent).toContain(
      "Preview auth and avatar rollout"
    );
    expect(sessionRow?.textContent).toContain("Raw Conversation");
    expect(sessionRow?.textContent).toContain("Codex CLI");
    expect(sessionRow?.textContent).toContain("76 Memory Events");
    expect(sessionRow?.textContent).toContain(
      "Committed the renderer convergence"
    );

    const technicalDetails = container.querySelector<HTMLDetailsElement>(
      ".project-technical-details"
    );
    expect(technicalDetails?.open).toBe(false);
    expect(technicalDetails?.textContent).toContain("codex/desktop-memory-ui");
    expect(technicalDetails?.textContent).toContain("Git remote");
  });

  it("omits source AI Client for non-session graph rows", async () => {
    await renderWorkspace({
      projects: [
        project("active", "2099-07-13T12:00:00.000Z", {
          threads: [
            {
              ...projects[0]!.threads[0]!,
              sessionId: null,
              sourceAiClient: "codex",
              capturedProjectProvenance: { source: "untrusted metadata" }
            }
          ]
        })
      ]
    });

    const row = container.querySelector('[data-session-id="thread-1"]');
    expect(row?.textContent).not.toContain("Codex");
    expect(row?.textContent).not.toContain("untrusted metadata");
  });

  it("opens the raw Conversation with Project context and secondary assignment controls", async () => {
    await renderWorkspace({ view: "session", selectedSessionId: "session-1" });

    expect(
      container
        .querySelector(".project-workspace")
        ?.classList.contains("route-session")
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="native-conversation"]')
        ?.textContent
    ).toContain("thread-1");
    expect(
      container.querySelector(".conversation-toolbar")?.textContent
    ).toContain("Koed");
    const assignment = container.querySelector<HTMLDetailsElement>(
      ".conversation-assignment-details"
    );
    expect(assignment?.open).toBe(false);
    expect(assignment?.textContent).toContain("Automatic");
    const assignmentStatus = assignment?.querySelector('[role="status"]');
    expect(assignmentStatus?.getAttribute("aria-live")).toBe("polite");
    expect(
      assignmentStatus?.querySelector(".assignment-state-announcement")
        ?.textContent
    ).toContain("Automatic · Koed");
  });

  it("preserves selected master-row focus in wide layouts", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(min-width: 1041px)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    await renderWorkspace({ view: "projects" });
    const selectedRow = container.querySelector<HTMLButtonElement>(
      '[data-project-id="active"]'
    );
    selectedRow?.focus();

    await renderWorkspace({ view: "project" });

    expect(document.activeElement).toBe(selectedRow);
  });

  it("falls back to the Project list when detail selection disappears", async () => {
    await renderWorkspace({
      view: "project",
      selectedProjectId: "missing"
    });

    expect(
      container
        .querySelector(".project-workspace")
        ?.classList.contains("route-projects")
    ).toBe(true);
    expect(
      container.querySelector('[data-route-focus="projects"]')
    ).not.toBeNull();
  });

  it("exposes route classes and focus targets for responsive drill-down", async () => {
    await renderWorkspace({ view: "projects" });
    expect(
      container
        .querySelector(".project-workspace")
        ?.classList.contains("route-projects")
    ).toBe(true);

    await renderWorkspace({ view: "project" });
    expect(
      container
        .querySelector(".project-workspace")
        ?.classList.contains("route-project")
    ).toBe(true);
    expect(
      container.querySelector('[data-route-focus="project"]')
    ).not.toBeNull();

    await renderWorkspace({ view: "session", selectedSessionId: "session-1" });
    expect(
      container
        .querySelector(".project-workspace")
        ?.classList.contains("route-session")
    ).toBe(true);
    expect(
      container.querySelector('[data-route-focus="session"]')
    ).not.toBeNull();
  });

  it("does not imply unavailable device or Team Workspace modes", async () => {
    await renderWorkspace();
    expect(
      container.querySelector(".dense-project-header .eyebrow")?.textContent
    ).toBe("Project");

    await renderWorkspace({ view: "session", selectedSessionId: "session-1" });

    expect(container.textContent).not.toContain("On this device");
    expect(container.textContent).not.toContain("Personal Project");
    expect(container.textContent).not.toContain("Team");
  });
});
