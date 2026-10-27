import { Button } from "@koed/ui";
import {
  ArrowUpRight,
  ChevronRight,
  Folder,
  GitBranch,
  Laptop,
  ListChecks,
  type LucideIcon
} from "lucide-react";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { ProjectAssociationPanel } from "./ProjectAssociationPanel.js";
import { ProjectRepo } from "./ProjectRepo.js";
import {
  RepositoryAnchorPanel,
  type ProjectRepositoryActions
} from "./RepositoryAnchorPanel.js";
import { RepositoryReviewPanel } from "./RepositoryReviewPanel.js";

export type ProjectFolderPage = "folder" | "anchor" | "review" | "sharing";
export const folderPageTitle = {
  anchor: "Repository anchor",
  review: "Review previous assignments",
  sharing: "Share anchor across devices"
};
export const folderName = (path: string) =>
  path
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop() || path;

function FolderAction({
  icon: Icon,
  title,
  description,
  onClick
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="personal-project-folder-action"
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
      <span>
        <span>{title}</span>
        <small>{description}</small>
      </span>
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

export function ProjectFolderDetails({
  project,
  page,
  onNavigate,
  onOpenRepository,
  onRevealLocalProject,
  ...actions
}: {
  project: DesktopProject;
  page: ProjectFolderPage;
  onNavigate: (page: ProjectFolderPage) => void;
  onOpenRepository?: (url: string) => void;
  onRevealLocalProject?: (localProjectId: string) => void;
} & ProjectRepositoryActions) {
  const { localProjectId, repository } = project;
  if (page !== "folder")
    return (
      <>
        <div className="personal-project-folder-context">
          <span>Folder</span>
          <Folder aria-hidden="true" />
          <span>{folderName(project.path ?? "")}</span>
        </div>
        {page === "anchor" ? (
          <RepositoryAnchorPanel
            project={project}
            onSetAnchor={actions.onSetAnchor}
            onChanged={actions.onChanged}
          />
        ) : null}
        {page === "review" && localProjectId && actions.onReview ? (
          <RepositoryReviewPanel
            localProjectId={localProjectId}
            onReview={actions.onReview}
            onChanged={actions.onChanged}
          />
        ) : null}
        {page === "sharing" && localProjectId && actions.onAssociation ? (
          <ProjectAssociationPanel
            localProjectId={localProjectId}
            onAssociation={actions.onAssociation}
            onChanged={actions.onChanged}
          />
        ) : null}
      </>
    );
  const canConfigure = Boolean(localProjectId && repository?.checkoutId);
  const showAdvanced =
    canConfigure &&
    (actions.onSetAnchor || actions.onReview || actions.onAssociation);
  return (
    <>
      <div className="personal-project-folder-location">
        {repository?.anchorDisplay ? (
          <ProjectRepo
            remoteDisplay={repository.anchorDisplay}
            onOpenRepository={onOpenRepository}
          />
        ) : null}
        <div className="personal-project-folder-path">
          <Folder aria-hidden="true" />
          <span>{project.path}</span>
          {localProjectId && onRevealLocalProject ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Reveal ${project.path} in file browser`}
              title="Reveal in file browser"
              onClick={() => onRevealLocalProject(localProjectId)}
            >
              <ArrowUpRight aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {showAdvanced ? (
        <section
          aria-label="Advanced"
          className="personal-project-folder-advanced"
        >
          <h3>Advanced</h3>
          {actions.onSetAnchor ? (
            <FolderAction
              icon={GitBranch}
              title={folderPageTitle.anchor}
              description="Choose the repository for new Conversations."
              onClick={() => onNavigate("anchor")}
            />
          ) : null}
          {actions.onReview ? (
            <FolderAction
              icon={ListChecks}
              title={folderPageTitle.review}
              description="Inspect older Conversations without changing their source context."
              onClick={() => onNavigate("review")}
            />
          ) : null}
          {actions.onAssociation ? (
            <FolderAction
              icon={Laptop}
              title={folderPageTitle.sharing}
              description="Use the same repository choice on linked Personal devices."
              onClick={() => onNavigate("sharing")}
            />
          ) : null}
        </section>
      ) : null}
    </>
  );
}
