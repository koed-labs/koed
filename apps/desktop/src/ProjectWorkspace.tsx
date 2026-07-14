import { NativeConversationSurface } from "./NativeConversationSurface.js";
import {
  assignmentTargetProjects,
  projectIsActive,
  projectLatestAt,
  relativeTime,
  sessionSelectionId,
  type DesktopProject,
  type DesktopThreadGroup,
  type DesktopView
} from "./project-memory-ui.js";

export type ProjectWorkspaceProps = {
  projects: DesktopProject[];
  view: Exclude<DesktopView, "settings">;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  showInactiveProjects: boolean;
  projectGraphError: string;
  projectAssignmentBusy: boolean;
  projectAssignmentError: string;
  apiBaseUrl: string | null;
  apiToken: string | null;
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

const projectAssignmentLabel = (session: DesktopThreadGroup): string => {
  if (session.projectAssignmentSource === "user_override") return "Manual";
  if (session.projectAssignmentSource === "detected") return "Automatic";
  return "Unassigned";
};

const projectSecondaryLabel = (project: DesktopProject): string =>
  project.remoteDisplay ?? project.path ?? "Project";

type ProjectRowProps = {
  project: DesktopProject;
  selected: boolean;
};

const ProjectRow = ({ project, selected }: ProjectRowProps) => {
  const active = projectIsActive(project);
  const activity = relativeTime(projectLatestAt(project));
  return (
    <button
      type="button"
      className={`project-master-row${selected ? " selected" : ""}`}
      data-project-id={project.id}
      aria-current={selected ? "true" : undefined}
      aria-label={`${project.name}, ${active ? "active" : "inactive"}, ${countLabel(project.threads.length, "Captured Session")}, ${activity}`}
    >
      <span className="project-row-monogram" aria-hidden="true">
        {project.name.slice(0, 1).toUpperCase() || "P"}
      </span>
      <span className="project-master-copy">
        <span className="project-master-title">
          <strong>{project.name || "Untitled Project"}</strong>
          <span
            className={`project-activity-dot ${active ? "active" : "inactive"}`}
          />
        </span>
        <span className="project-master-metrics">
          {countLabel(project.threads.length, "session")} · {project.eventCount}{" "}
          Memory Events · {activity}
        </span>
        <small title={projectSecondaryLabel(project)}>
          {projectSecondaryLabel(project)}
        </small>
      </span>
      <svg className="row-chevron" aria-hidden="true" viewBox="0 0 20 20">
        <path d="m7.5 4.5 5 5-5 5" />
      </svg>
    </button>
  );
};

type ProjectMasterPaneProps = {
  projects: DesktopProject[];
  selectedProjectId: string | null;
  showInactiveProjects: boolean;
  projectGraphError: string;
};

const ProjectMasterPane = ({
  projects,
  selectedProjectId,
  showInactiveProjects,
  projectGraphError
}: ProjectMasterPaneProps) => {
  const activeProjects = projects.filter((project) => projectIsActive(project));
  const inactiveProjects = projects.filter(
    (project) => !projectIsActive(project)
  );
  return (
    <aside className="project-master-pane" aria-label="Projects">
      <header className="project-master-header">
        <div>
          <p className="eyebrow">Memory</p>
          <h1>Projects</h1>
        </div>
        <span
          className="project-total"
          aria-label={`${projects.length} Projects`}
        >
          {projects.length}
        </span>
      </header>
      <div className="project-master-scroll">
        {projectGraphError ? (
          <div className="project-master-error" role="alert">
            <strong>Projects unavailable</strong>
            <p>{projectGraphError}</p>
            <button
              type="button"
              className="secondary-button"
              data-retry-projects
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <section
              className="project-master-section"
              aria-labelledby="active-projects-heading"
            >
              <h2 id="active-projects-heading">
                Active <span>{activeProjects.length}</span>
              </h2>
              {activeProjects.length ? (
                <div className="project-master-list">
                  {activeProjects.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      selected={project.id === selectedProjectId}
                    />
                  ))}
                </div>
              ) : (
                <p className="project-master-empty">
                  Captured Projects will appear here.
                </p>
              )}
            </section>
            {inactiveProjects.length ? (
              <section
                className="project-master-section inactive"
                aria-labelledby="inactive-projects-heading"
              >
                <button
                  type="button"
                  className="inactive-disclosure"
                  data-toggle-inactive
                  aria-expanded={showInactiveProjects}
                >
                  <span id="inactive-projects-heading">Inactive</span>
                  <span>{inactiveProjects.length}</span>
                  <span aria-hidden="true">
                    {showInactiveProjects ? "−" : "+"}
                  </span>
                </button>
                {showInactiveProjects ? (
                  <div className="project-master-list">
                    {inactiveProjects.map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        selected={project.id === selectedProjectId}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
};

const TechnicalProjectDetails = ({ project }: { project: DesktopProject }) => (
  <details className="project-technical-details">
    <summary>Project details</summary>
    <dl>
      <div>
        <dt>Local path</dt>
        <dd>{project.path ?? "Unavailable"}</dd>
      </div>
      {project.remoteDisplay ? (
        <div>
          <dt>Git remote</dt>
          <dd>{project.remoteDisplay}</dd>
        </div>
      ) : null}
      {project.branch ? (
        <div>
          <dt>Branch</dt>
          <dd>{project.branch}</dd>
        </div>
      ) : null}
      <div>
        <dt>Discovery</dt>
        <dd>
          {project.catalogued
            ? "Project metadata discovered"
            : "Captured session metadata"}
        </dd>
      </div>
      {project.isWorktree ? (
        <div>
          <dt>Git layout</dt>
          <dd>Worktree</dd>
        </div>
      ) : null}
    </dl>
  </details>
);

const SessionRow = ({ session }: { session: DesktopThreadGroup }) => {
  const id = sessionSelectionId(session);
  return (
    <button type="button" className="dense-session-row" data-session-id={id}>
      <span className="session-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20">
          <path d="M5 4.5h10v7H9l-4 3v-10Z" />
          <path d="M8 8h4" />
        </svg>
      </span>
      <span className="dense-session-copy">
        <span className="dense-session-heading">
          <strong>{session.name || "Untitled session"}</strong>
          <span>Raw Conversation</span>
        </span>
        <small>{session.sample || "Captured Conversation"}</small>
      </span>
      <span className="dense-session-meta">
        <strong>{countLabel(session.eventCount, "Memory Event")}</strong>
        <small>{relativeTime(session.latestAt)}</small>
      </span>
      <svg className="row-chevron" aria-hidden="true" viewBox="0 0 20 20">
        <path d="m7.5 4.5 5 5-5 5" />
      </svg>
    </button>
  );
};

const ProjectDetailPane = ({ project }: { project: DesktopProject | null }) => {
  if (!project) {
    return (
      <section
        className="project-detail-pane project-detail-empty"
        aria-labelledby="select-project-heading"
      >
        <div>
          <span className="project-empty-icon" aria-hidden="true">
            ◇
          </span>
          <h2 id="select-project-heading">Select a Project</h2>
          <p>
            Choose a Project to inspect its Captured Sessions and raw
            Conversations.
          </p>
        </div>
      </section>
    );
  }
  const sessions = [...project.threads].sort(
    (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
  );
  return (
    <section
      className="project-detail-pane"
      aria-labelledby="selected-project-heading"
    >
      <nav
        className="breadcrumbs project-detail-breadcrumbs"
        aria-label="Breadcrumb"
      >
        <button type="button" data-back-to-projects>
          Projects
        </button>
        <span>›</span>
        <strong>{project.name}</strong>
      </nav>
      <header className="dense-project-header">
        <span className="project-monogram" aria-hidden="true">
          {project.name.slice(0, 1).toUpperCase() || "P"}
        </span>
        <div>
          <p className="eyebrow">Project</p>
          <h2 id="selected-project-heading">{project.name}</h2>
          <p>
            {countLabel(project.threads.length, "Captured Session")} ·{" "}
            {countLabel(project.eventCount, "Memory Event")} ·{" "}
            {relativeTime(projectLatestAt(project))}
          </p>
        </div>
      </header>
      <TechnicalProjectDetails project={project} />
      <section
        className="dense-sessions-pane"
        aria-labelledby="captured-sessions-heading"
      >
        <header>
          <div>
            <p className="eyebrow">Project activity</p>
            <h3 id="captured-sessions-heading">Captured Sessions</h3>
          </div>
          <span>{sessions.length}</span>
        </header>
        {sessions.length ? (
          <div className="dense-session-list">
            {sessions.map((session) => (
              <SessionRow key={sessionSelectionId(session)} session={session} />
            ))}
          </div>
        ) : (
          <div className="dense-session-empty">
            <strong>No Captured Sessions yet</strong>
            <p>
              Sessions appear after the Supported Capture Hook records activity
              in this Project.
            </p>
          </div>
        )}
      </section>
    </section>
  );
};

type ConversationPaneProps = Pick<
  ProjectWorkspaceProps,
  | "projects"
  | "projectAssignmentBusy"
  | "projectAssignmentError"
  | "apiBaseUrl"
  | "apiToken"
> & {
  project: DesktopProject;
  session: DesktopThreadGroup;
};

const ConversationPane = ({
  projects,
  project,
  session,
  projectAssignmentBusy,
  projectAssignmentError,
  apiBaseUrl,
  apiToken
}: ConversationPaneProps) => {
  const targets = assignmentTargetProjects(projects, session.projectId);
  return (
    <section className="conversation-screen master-detail-conversation">
      <nav
        className="breadcrumbs conversation-breadcrumbs"
        aria-label="Breadcrumb"
      >
        <button type="button" data-back-to-projects>
          Projects
        </button>
        <span>›</span>
        <button type="button" data-back-to-project>
          {project.name}
        </button>
        <span>›</span>
        <strong>{session.name || "Untitled session"}</strong>
      </nav>
      <div className="conversation-pane">
        <div className="conversation-toolbar">
          <div>
            <p className="eyebrow">Raw Conversation</p>
            <strong>{session.name || "Untitled session"}</strong>
            <small>
              {countLabel(session.eventCount, "Memory Event")} ·{" "}
              {relativeTime(session.latestAt)} · {project.name}
            </small>
          </div>
        </div>
        <details className="conversation-assignment-details">
          <summary>
            Project assignment
            <span
              className={`assignment-state ${session.projectAssignmentSource ?? "unassigned"}`}
            >
              {projectAssignmentLabel(session)}
            </span>
          </summary>
          <div className="conversation-assignment">
            {session.sessionId ? (
              <form
                className="project-assignment-form"
                data-session-project-form
                aria-busy={projectAssignmentBusy}
              >
                <label>
                  <span>Move to another Project</span>
                  <select
                    data-session-project-target
                    required
                    disabled={projectAssignmentBusy || targets.length === 0}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      {targets.length === 0
                        ? "No other Projects"
                        : "Select destination…"}
                    </option>
                    {targets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className="secondary"
                  disabled={projectAssignmentBusy || targets.length === 0}
                >
                  {projectAssignmentBusy ? "Saving…" : "Move"}
                </button>
                {session.projectAssignmentSource === "user_override" ? (
                  <button
                    type="button"
                    className="secondary"
                    data-reset-session-project
                    disabled={projectAssignmentBusy}
                  >
                    Reset to automatic
                  </button>
                ) : null}
              </form>
            ) : (
              <span className="assignment-state unassigned">
                Session unavailable
              </span>
            )}
            {projectAssignmentError ? (
              <p className="assignment-error" role="alert">
                {projectAssignmentError}
              </p>
            ) : null}
          </div>
        </details>
        <div className="native-conversation-host">
          <NativeConversationSurface
            apiBaseUrl={apiBaseUrl}
            apiToken={apiToken}
            thread={session}
          />
        </div>
      </div>
    </section>
  );
};

export const ProjectWorkspace = ({
  projects,
  view,
  selectedProjectId,
  selectedSessionId,
  showInactiveProjects,
  projectGraphError,
  projectAssignmentBusy,
  projectAssignmentError,
  apiBaseUrl,
  apiToken
}: ProjectWorkspaceProps) => {
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedSession =
    selectedProject?.threads.find(
      (session) => sessionSelectionId(session) === selectedSessionId
    ) ?? null;
  const effectiveView =
    view === "session" && !selectedSession ? "project" : view;
  return (
    <div
      className={`project-workspace route-${effectiveView}`}
      data-view-root
      data-responsive="master-detail-to-drilldown"
      tabIndex={-1}
    >
      <ProjectMasterPane
        projects={projects}
        selectedProjectId={selectedProjectId}
        showInactiveProjects={showInactiveProjects}
        projectGraphError={projectGraphError}
      />
      <div className="project-detail-column">
        {effectiveView === "session" && selectedProject && selectedSession ? (
          <ConversationPane
            projects={projects}
            project={selectedProject}
            session={selectedSession}
            projectAssignmentBusy={projectAssignmentBusy}
            projectAssignmentError={projectAssignmentError}
            apiBaseUrl={apiBaseUrl}
            apiToken={apiToken}
          />
        ) : (
          <ProjectDetailPane project={selectedProject} />
        )}
      </div>
    </div>
  );
};
