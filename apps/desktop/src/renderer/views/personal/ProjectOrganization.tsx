import { useRef, useState } from "react";
import {
  Ellipsis,
  Pencil,
  Plus,
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
import {
  ProjectHeader,
  type ProjectFolderFilterControl
} from "./ProjectHeader.js";
import { NamedProjectActions } from "./ProjectMembershipActions.js";
import { ProjectSyncDetails } from "./ProjectSyncDetails.js";
import { ProjectTransferCard } from "./ProjectTransferCard.js";

export type ProjectNewConversationAction = {
  disabled: boolean;
  onSelect: () => void;
};

type Props = {
  project: DesktopProject;
  folderFilter?: ProjectFolderFilterControl;
  newConversation?: ProjectNewConversationAction;
  projects: readonly DesktopProject[];
  manage: NonNullable<PersonalDesktopApi["manageProject"]>;
  sync?: PersonalDesktopApi["manageMembershipSync"];
  store: PersonalMemoryStore;
  onDeleted: () => void;
  onReviewSharing?: () => void;
};
export function ProjectOrganization({
  project,
  folderFilter,
  newConversation,
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
      <ProjectHeader project={project} folderFilter={folderFilter}>
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
                  aria-label="Manage Project sources"
                  title="Manage Project sources"
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
                    Project sources
                  </DialogTitle>
                )}
                closeControl={
                  <DialogClose
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Close Project sources"
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
              {newConversation ? (
                <DropdownMenuItem
                  disabled={newConversation.disabled}
                  onClick={newConversation.onSelect}
                  title={
                    newConversation.disabled
                      ? "An available local Folder and a ready AI Client are required."
                      : undefined
                  }
                >
                  <Plus aria-hidden="true" />
                  New Conversation
                </DropdownMenuItem>
              ) : null}
              {onReviewSharing ? (
                <DropdownMenuItem onClick={onReviewSharing}>
                  <Share2 aria-hidden="true" />
                  Share
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => setAction("rename")}>
                <Pencil aria-hidden="true" />
                Rename
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
      </ProjectHeader>
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
