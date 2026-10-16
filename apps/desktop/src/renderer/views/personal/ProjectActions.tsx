import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle
} from "@koed/ui";
import { FolderInput, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";

export type CreateProject = (name: string) => Promise<DesktopProject | null>;

export function CreateProjectDialog({
  create,
  onCreated,
  disabled,
  iconOnly = false,
  triggerClassName = ""
}: {
  create: CreateProject;
  onCreated: (project: DesktopProject) => void;
  disabled?: boolean;
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
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <button
        aria-label={iconOnly ? "Create Project" : undefined}
        className={
          (iconOnly
            ? "personal-project-create-button"
            : "personal-create-project-link") + ` ${triggerClassName}`
        }
        disabled={disabled}
        title={iconOnly ? "Create Project" : undefined}
        onClick={() => {
          setName("");
          setError("");
          setOpen(true);
        }}
        type="button"
      >
        {iconOnly ? <Plus aria-hidden="true" /> : "Create Project…"}
      </button>
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

export function MoveProjectDialog({
  project,
  projects,
  move,
  create,
  store,
  onMoved
}: {
  project: DesktopProject;
  projects: readonly DesktopProject[];
  move: NonNullable<PersonalDesktopApi["moveProject"]>;
  create?: CreateProject;
  store: PersonalMemoryStore;
  onMoved: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const destinationId = useId();
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );
  const targets = projects.filter(
    (target) =>
      target.id !== project.id &&
      target.id !== "unassigned" &&
      target.repository?.kind !== "unresolved"
  );
  const submit = async () => {
    const request = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      const result = await move({
        sourceProjectId: project.id,
        targetProjectId: targetId
      });
      if (request !== requestRef.current) return;
      store.purge(({ thread }) => thread.projectId === project.id);
      setOpen(false);
      onMoved(result.projectId);
      await store.loadProjects();
    } catch (cause) {
      if (request === requestRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <button
        className="personal-session-manage-button"
        aria-label="Move Project"
        title="Move Project"
        disabled={!project.threads.length}
        onClick={() => {
          setTargetId("");
          setError("");
          setOpen(true);
        }}
        type="button"
      >
        <FolderInput aria-hidden="true" />
        <span>Move</span>
      </button>
      <DialogPopup className="personal-project-move-dialog">
        <DialogHeader>
          <DialogTitle>Move Project</DialogTitle>
          <DialogDescription>
            Move all existing Conversations in “{project.name}” to another
            Project.{" "}
            {project.id === "unassigned"
              ? "Unresolved history is not used to route new captures."
              : "Future captures from this source will also use the destination Project."}
          </DialogDescription>
        </DialogHeader>
        <form
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="personal-project-destination">
            <label htmlFor={destinationId}>Move to Project</label>
            <div className="personal-project-destination-row">
              <select
                id={destinationId}
                name="targetProjectId"
                value={targetId}
                onChange={(event) => setTargetId(event.currentTarget.value)}
                required
                disabled={busy || !targets.length}
              >
                <option value="" disabled>
                  {targets.length ? "Select destination…" : "No other Projects"}
                </option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </select>
              {create ? (
                <CreateProjectDialog
                  create={create}
                  disabled={busy}
                  iconOnly
                  triggerClassName="personal-project-destination-add"
                  onCreated={(target) => {
                    if (target.id !== project.id) setTargetId(target.id);
                  }}
                />
              ) : null}
            </div>
          </div>
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
            <Button type="submit" disabled={busy || !targetId}>
              {busy ? "Moving…" : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
