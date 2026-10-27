import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Button,
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@koed/ui";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";

type Manage = NonNullable<PersonalDesktopApi["manageProject"]>;

export { ConversationProjectsDialog } from "./ConversationProjectsDialog.js";

export function NamedProjectActions({
  project,
  manage,
  store,
  onDeleted,
  open: controlledOpen,
  onOpenChange,
  returnFocus
}: {
  project: DesktopProject;
  manage: Manage;
  store: PersonalMemoryStore;
  onDeleted: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const [localOpen, setLocalOpen] = useState(false),
    [name, setName] = useState(project.name),
    [expectedVersion, setExpectedVersion] = useState(
      project.namedProject?.version ?? 1
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setName(project.name);
      setExpectedVersion(project.namedProject?.version ?? 1);
      setError("");
    }
    wasOpen.current = open;
  }, [open, project.name, project.namedProject?.version]);
  if (!project.namedProject) return null;
  const save = async (action: "rename" | "delete") => {
    setBusy(true);
    setError("");
    try {
      await manage(
        action === "rename"
          ? {
              action,
              projectId: project.id,
              expectedVersion,
              name: name.trim()
            }
          : {
              action,
              projectId: project.id,
              expectedVersion
            }
      );
      const result = await store.loadProjects({ silent: true });
      if (result.error) throw new Error(result.error);
      setOpen(false);
      if (action === "delete") onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await store.loadProjects({ silent: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      {controlledOpen === undefined ? (
        <Button
          variant="outline"
          onClick={() => {
            setName(project.name);
            setError("");
            setOpen(true);
          }}
        >
          Edit Project
        </Button>
      ) : null}
      <DialogPopup
        className="personal-project-create-dialog"
        finalFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle>Edit Project</DialogTitle>
          <DialogDescription>
            Change the Project name or remove the Project. Removing it keeps its
            Conversations and Memory.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save("rename");
          }}
        >
          <label>
            Name
            <input
              value={name}
              disabled={busy}
              maxLength={160}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void save("delete")}
            >
              Remove Project
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
