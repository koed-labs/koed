import type { DesktopProject } from "../../project-memory-ui.js";
import { recallProjectLabel } from "./recall-project-label.js";
import "./recall-execution.css";
import {
  Folder,
  Globe,
  MessageSquare,
  HelpCircle,
  GitBranch
} from "lucide-react";
import type { RecallActivityQuestion } from "@koed-labs/shared/personal-desktop";

export function RecallActivityScope({
  question,
  projects: inventory = [],
  heading = false
}: {
  question: RecallActivityQuestion;
  heading?: boolean;
  projects?: readonly DesktopProject[];
}) {
  const scope = question.scope;
  // Compatibility presentation for an older API; never infer a Project union.
  const kind =
    scope?.kind ??
    (question.searchDomain === "global"
      ? "global"
      : question.searchDomain === "session"
        ? "session"
        : "unknown");
  const Icon =
    kind === "global"
      ? Globe
      : kind === "session"
        ? MessageSquare
        : kind === "repository"
          ? GitBranch
          : kind === "unknown" && !question.projectId
            ? HelpCircle
            : Folder;
  const title = {
    projects: "Project scope",
    global: "Global scope",
    session: "Conversation scope",
    folder: "Folder scope",
    repository: "Repository scope",
    unknown: question.projectId ? "Recorded scope" : "Scope unavailable"
  }[kind];
  const projects = scope?.projects ?? (question.projectId ? [question] : []);
  return (
    <div
      className={heading ? "recall-scope-line" : "recall-scope compact"}
      aria-label="Accepted scope"
    >
      {heading && (
        <h3>
          <Icon />
          {title}
        </h3>
      )}
      <div className="recall-scope">
        {projects.length ? (
          projects.map((project) => (
            <span className="recall-scope-chip" key={project.projectId}>
              <Folder />
              {(kind === "projects"
                ? project.projectName
                : // Other kinds carry a recorded legacy name, not an API verdict.
                  recallProjectLabel(
                    {
                      projectId: project.projectId,
                      projectName: project.projectName ?? undefined
                    },
                    inventory
                  )) ??
                (kind === "folder"
                  ? "Folder unavailable"
                  : kind === "repository"
                    ? "Repository unavailable"
                    : "Project unavailable")}
            </span>
          ))
        ) : kind === "global" ? (
          <span className="recall-scope-chip">
            <Globe />
            All Personal Memory
          </span>
        ) : kind === "session" ? (
          <span className="recall-scope-chip">
            <MessageSquare />
            {question.sessionId ?? "Conversation"}
          </span>
        ) : !heading || kind === "unknown" ? (
          <span className="recall-scope-unknown">
            <Icon />
            {title}
          </span>
        ) : null}
      </div>
    </div>
  );
}
