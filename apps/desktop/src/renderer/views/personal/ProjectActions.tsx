import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle
} from "@koed/ui";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopProject } from "../../../project-memory-ui.js";

export type CreateProject = (name: string) => Promise<DesktopProject | null>;

export function CreateProjectDialog({
  create,
  onCreated,
  disabled,
  buttonTrigger = false,
  iconOnly = false,
  triggerClassName = ""
}: {
  create: CreateProject;
  onCreated: (project: DesktopProject) => void;
  disabled?: boolean;
  buttonTrigger?: boolean;
  iconOnly?: boolean;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );
  const submit = async () => {
    const request = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      const project = await create(name.trim());
      if (request !== requestRef.current) return;
      if (project) {
        onCreated(project);
        setOpen(false);
      }
    } catch (cause) {
      if (request === requestRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };
  const openDialog = () => {
    setName("");
    setError("");
    setOpen(true);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      {buttonTrigger ? (
        <Button
          variant="outline"
          className={triggerClassName}
          disabled={disabled}
          onClick={openDialog}
        >
          <Plus aria-hidden="true" />
          Create Project…
        </Button>
      ) : (
        <button
          aria-label={iconOnly ? "Create Project" : undefined}
          className={
            (iconOnly
              ? "personal-project-create-button"
              : "personal-create-project-link") + ` ${triggerClassName}`
          }
          disabled={disabled}
          title={iconOnly ? "Create Project" : undefined}
          onClick={openDialog}
          type="button"
        >
          {iconOnly ? <Plus aria-hidden="true" /> : "Create Project…"}
        </button>
      )}
      <DialogPopup className="personal-project-create-dialog">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>
            Give this Project a name. You can move existing Conversations into
            it.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void submit();
          }}
        >
          <label>
            Project name
            <input
              name="projectName"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              maxLength={160}
              required
              disabled={busy}
              autoFocus
            />
          </label>
          {error ? (
            <p className="personal-memory-error" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
