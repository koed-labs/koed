import { useRef, useState } from "react";
import {
  Ellipsis,
  Pencil,
  RefreshCw,
  Share2,
  SlidersHorizontal,
  X
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuTrigger
} from "@koed/ui";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import { NamedProjectActions } from "./ProjectMembershipActions.js";
import { ProjectSyncDetails } from "./ProjectSyncDetails.js";
import { ProjectTransferCard } from "./ProjectTransferCard.js";

type Props = {
  project: DesktopProject;
  projects: readonly DesktopProject[];
  manage: NonNullable<PersonalDesktopApi["manageProject"]>;
  sync?: PersonalDesktopApi["manageMembershipSync"];
  store: PersonalMemoryStore;
  onDeleted: () => void;
  onReviewSharing?: () => void;
};
export function ProjectOrganization({
  project,
  projects,
  manage,
  sync,
  store,
  onDeleted,
  onReviewSharing
}: Props) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [action, setAction] = useState<"rename" | "sync" | null>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <header className="personal-project-header personal-named-project-header">
        <span className="personal-project-monogram" aria-hidden="true">
          {Array.from(project.name)[0]?.toLocaleUpperCase() ?? "P"}
        </span>
        <div className="personal-project-detail-heading">
          <h2 data-personal-route-focus="project" tabIndex={-1}>
            {project.name}
          </h2>
          <div className="personal-project-header-meta">
            <span>{project.threads.length} Conversations</span>
          </div>
        </div>
        <div className="personal-named-project-actions">
          <Dialog
            open={setupOpen}
            onOpenChange={(open) => {
              if (!setupBusy) setSetupOpen(open);
            }}
          >
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Set up Project"
                  title="Set up Project"
                />
              }
            >
              <SlidersHorizontal aria-hidden="true" />
            </DialogTrigger>
            <DialogPopup
              className="personal-project-setup-dialog"
              showCloseButton={false}
            >
              <DialogDescription className="personal-transfer-sr">
                Choose Git Anchors, exact Folders, or Conversations to include
                in {project.name}.
              </DialogDescription>
              <ProjectTransferCard
                project={project}
                projects={projects}
                manage={manage}
                store={store}
                onBusyChange={setSetupBusy}
                onCancel={() => setSetupOpen(false)}
                onConfirmed={() => setSetupOpen(false)}
                heading={(id) => (
                  <DialogTitle id={id} className="personal-transfer-sr">
                    Set up Project
                  </DialogTitle>
                )}
                closeControl={
                  <DialogClose
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Close Project setup"
                        disabled={setupBusy}
                      />
                    }
                  >
                    <X aria-hidden="true" />
                  </DialogClose>
                }
              />
            </DialogPopup>
          </Dialog>
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={menuTrigger}
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Project actions"
                  title="Project actions"
                />
              }
            >
              <Ellipsis aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuPopup align="end" aria-label="Project actions">
              {onReviewSharing ? (
                <DropdownMenuItem onClick={onReviewSharing}>
                  <Share2 aria-hidden="true" />
                  Share
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => setAction("rename")}>
                <Pencil aria-hidden="true" />
                Edit
              </DropdownMenuItem>
              {sync ? (
                <DropdownMenuItem onClick={() => setAction("sync")}>
                  <RefreshCw aria-hidden="true" />
                  Sync
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuPopup>
          </DropdownMenu>
        </div>
      </header>
      <NamedProjectActions
        project={project}
        manage={manage}
        store={store}
        onDeleted={onDeleted}
        open={action === "rename"}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        returnFocus={menuTrigger}
      />
      {sync ? (
        <ProjectSyncDetails
          project={project}
          projects={projects}
          manage={sync}
          store={store}
          onDeleted={onDeleted}
          open={action === "sync"}
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
          returnFocus={menuTrigger}
        />
      ) : null}
    </>
  );
}
