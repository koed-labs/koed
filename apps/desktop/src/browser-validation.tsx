import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { ProjectWorkspace } from "./ProjectWorkspace.js";
import type { DesktopProject } from "./project-memory-ui.js";
import "./styles.css";

const longTitle =
  "Captured Session title deliberately long enough to verify single-line overflow and truncation inside master-detail viewport";
const longPreview =
  "Captured Session preview deliberately long enough to verify browser-computed overflow handling without exposing raw capture metadata in Desktop rows.";

const project: DesktopProject = {
  id: "browser-project",
  name: "Koed Desktop browser validation",
  path: "/private/operator/koed",
  eventCount: 7,
  threads: [
    {
      id: "browser-thread",
      name: longTitle,
      sessionId: "4b23de0b-7e46-4d1f-bb36-d9a70afe3b61",
      sourceAiClient: "codex-cli",
      projectId: "browser-project",
      projectName: "Koed Desktop browser validation",
      projectPath: "/private/operator/koed",
      eventCount: 7,
      invalidatedCount: 0,
      latestAt: "2099-01-01T00:00:00.000Z",
      sample: longPreview,
      capturedProjectProvenance: { ignored: "untrusted metadata" }
    }
  ],
  catalogued: true,
  discoveredAt: "2099-01-01T00:00:00.000Z",
  lastSeenAt: "2099-01-01T00:00:00.000Z",
  localProjectId: "browser-project",
  branch: null,
  remoteDisplay: null,
  isWorktree: false
};

const ValidationApp = () => {
  useEffect(() => {
    document.documentElement.dataset.browserValidationReady = "true";
  }, []);
  const [view, setView] = useState<"projects" | "project" | "session">(
    "project"
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    project.id
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  useEffect(() => {
    document.documentElement.dataset.browserValidationReady = "true";
  }, []);

  return (
    <div
      className="koed-memory-shell"
      style={{ display: "block", height: "100vh" }}
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("[data-back-to-projects]")) {
          setSelectedSessionId(null);
          setView("projects");
        }
      }}
    >
      <ProjectWorkspace
        projects={[project]}
        view={view}
        selectedProjectId={selectedProjectId}
        selectedSessionId={selectedSessionId}
        showInactiveProjects={false}
        projectGraphError=""
        projectAssignmentBusy={false}
        projectAssignmentError=""
        apiBaseUrl={null}
        apiToken={null}
        onSelectProject={(id) => {
          setSelectedProjectId(id);
          setSelectedSessionId(null);
          setView("project");
        }}
        onSelectSession={(id) => {
          setSelectedSessionId(id);
          setView("session");
        }}
      />
    </div>
  );
};

createRoot(document.querySelector("#root")!).render(<ValidationApp />);
