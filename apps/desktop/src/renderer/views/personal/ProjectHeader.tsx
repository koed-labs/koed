import { Button, Popover } from "@koed/ui";
import {
  ArrowLeft,
  BookText,
  Brain,
  ChevronDown,
  ChevronRight,
  Folder,
  GitFork,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  repoLabelFromRemoteDisplay,
  type DesktopProject
} from "../../../project-memory-ui.js";
import { ProjectRepo } from "./ProjectRepo.js";
import type { ProjectRepositoryActions } from "./RepositoryAnchorPanel.js";
import {
  ProjectFolderDetails,
  folderName,
  folderPageTitle,
  type ProjectFolderPage
} from "./ProjectFolderDetails.js";

type ProjectHeaderProps = ProjectRepositoryActions & {
  project: DesktopProject;
  children: ReactNode;
  onOpenRepository?: (url: string) => void;
  onRevealLocalProject?: (localProjectId: string) => void;
};

export function ProjectHeader({
  project,
  children,
  onOpenRepository,
  onRevealLocalProject,
  ...repositoryActions
}: ProjectHeaderProps) {
  const [page, setPage] = useState<ProjectFolderPage | "overview">("overview");
  const [folderKey, setFolderKey] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [page, folderKey]);
  const folders = project.checkouts?.length
    ? project.checkouts
    : project.path
      ? [
          {
            localProjectId: project.localProjectId,
            path: project.path,
            repository: project.repository,
            repositoryRemotes: project.repositoryRemotes
          }
        ]
      : [];
  const remote = project.remoteDisplay ?? project.repository?.anchorDisplay;
  const folder = folders.find(
    (entry) => (entry.localProjectId ?? entry.path) === folderKey
  );
  const selectedProject = folder
    ? {
        ...project,
        localProjectId: folder.localProjectId,
        path: folder.path,
        repository: folder.repository,
        repositoryRemotes: folder.repositoryRemotes,
        checkouts: undefined
      }
    : null;
  const currentPage = selectedProject ? page : "overview";
  const title =
    currentPage === "overview"
      ? project.name
      : currentPage === "folder"
        ? folderName(folder!.path)
        : folderPageTitle[currentPage];
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) {
          setPage("overview");
          setFolderKey(null);
        }
      }}
    >
      <header className="personal-project-header">
        <span className="personal-project-monogram" aria-hidden="true">
          {Array.from(project.name)[0]?.toLocaleUpperCase() ?? "P"}
        </span>
        <div className="personal-project-detail-heading">
          <h2 data-personal-route-focus="project" tabIndex={-1}>
            <Popover.Trigger
              className="personal-project-details-trigger"
              aria-label={`Details for ${project.name}`}
              title={project.name}
            >
              <span>{project.name}</span>
              <ChevronDown aria-hidden="true" />
            </Popover.Trigger>
          </h2>
          <div className="personal-project-header-meta">
            {remote ? (
              <>
                <Popover.Trigger
                  className="personal-project-repository-trigger"
                  aria-label="Repository and folder details"
                  title={remote}
                >
                  <GitFork aria-hidden="true" />
                  <span>{repoLabelFromRemoteDisplay(remote)}</span>
                </Popover.Trigger>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span
              className="personal-project-overview"
              aria-label={`${project.threads.length} Conversations · ${project.eventCount} Memory Events`}
            >
              <span>
                <BookText aria-hidden="true" />
                {project.threads.length}
              </span>
              <span>
                <Brain aria-hidden="true" />
                {project.eventCount}
              </span>
            </span>
          </div>
        </div>
        {children}
      </header>
      <Popover.Portal>
        <Popover.Positioner
          className="personal-project-details-positioner"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <Popover.Popup className="personal-project-details-card">
            <div className="personal-project-details-card-heading">
              <div className="personal-project-card-title">
                {currentPage !== "overview" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      currentPage === "folder"
                        ? "Back to Project details"
                        : "Back to folder details"
                    }
                    onClick={() =>
                      setPage(currentPage === "folder" ? "overview" : "folder")
                    }
                  >
                    <ArrowLeft aria-hidden="true" />
                  </Button>
                ) : null}
                <Popover.Title ref={heading} tabIndex={-1}>
                  {title}
                </Popover.Title>
              </div>
              <Popover.Close
                aria-label="Close Project details"
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <X aria-hidden="true" />
              </Popover.Close>
            </div>
            {currentPage !== "overview" && selectedProject ? (
              <ProjectFolderDetails
                key={`${folderKey}:${folder?.repository?.checkoutId ?? ""}`}
                project={selectedProject}
                page={currentPage}
                onNavigate={setPage}
                onOpenRepository={onOpenRepository}
                onRevealLocalProject={onRevealLocalProject}
                {...repositoryActions}
              />
            ) : (
              <>
                {remote ? (
                  <section aria-label="Repository">
                    <h3>Repository</h3>
                    <ProjectRepo
                      remoteDisplay={remote}
                      onOpenRepository={onOpenRepository}
                    />
                  </section>
                ) : null}
                {folders.length ? (
                  <section aria-label="Project folders">
                    <h3>Folders</h3>
                    <ul>
                      {folders.map((entry) => (
                        <li key={entry.localProjectId ?? entry.path}>
                          <button
                            type="button"
                            className="personal-project-details-folder"
                            aria-label={`Open ${entry.path} details`}
                            onClick={() => {
                              setFolderKey(entry.localProjectId ?? entry.path);
                              setPage("folder");
                            }}
                          >
                            <Folder aria-hidden="true" />
                            <span>
                              <span>{folderName(entry.path)}</span>
                              <small>{entry.path}</small>
                            </span>
                            <ChevronRight aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : (
                  <p className="personal-project-details-description">
                    {project.repository?.kind === "local_project"
                      ? "Named Project. No folder is required."
                      : "No folder recorded."}
                  </p>
                )}
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
