import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { repositoryIdentityMatches } from "@koed/shared/repository-recall";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle
} from "@koed/ui";
import { ArrowLeft, FolderInput } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { repoLabelFromRemoteDisplay } from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import type { SessionProjectAssignment } from "./adapters.js";
import { CreateProjectDialog, type CreateProject } from "./ProjectActions.js";

export function MoveConversationDialog({
  assign,
  onCreateProject,
  onAssigned,
  projects,
  store,
  thread
}: {
  assign?: PersonalDesktopApi["assignSessionProject"];
  onCreateProject?: CreateProject;
  onAssigned?: (input: { projectId: string | null; sessionId: string }) => void;
  projects: readonly PersonalDesktopProject[];
  store: PersonalMemoryStore;
  thread: PersonalDesktopProjectThread;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"move" | "restore">("move");
  const [targetProjectId, setTargetProjectId] = useState("");
  const destinationId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const destinationRef = useRef<HTMLSelectElement>(null);
  const requestRef = useRef(0);
  const targets = projects.filter(
    (project) =>
      project.id !== thread.projectId &&
      project.id !== "unassigned" &&
      project.repository?.kind !== "unresolved" &&
      project.id.trim() &&
      project.name.trim()
  );
  const automatic = thread.repositoryAssignment?.automatic;
  const originalProject =
    automatic && automatic.kind !== "unresolved"
      ? projects.find((project) =>
          repositoryIdentityMatches(project.repository ?? null, automatic)
        )
      : null;
  const originalAssignment =
    automatic && automatic.kind !== "unresolved"
      ? originalProject?.name ||
        (automatic.anchorDisplay
          ? repoLabelFromRemoteDisplay(automatic.anchorDisplay)
          : automatic.root
              ?.replaceAll("\\", "/")
              .split("/")
              .filter(Boolean)
              .pop()) ||
        "Original Project"
      : thread.repositoryAssignment
        ? "Unresolved history"
        : "Recorded assignment";
  const capturedFolder =
    thread.capturedCwd ??
    automatic?.root ??
    (thread.projectAssignmentSource !== "user_override"
      ? thread.projectPath
      : null);

  useEffect(() => {
    requestRef.current += 1;
    setBusy(false);
    setOpen(false);
    setPage("move");
    setError("");
    setTargetProjectId("");
    return () => {
      requestRef.current += 1;
    };
  }, [thread.id, thread.projectId]);

  useEffect(() => {
    if (!open) return;
    if (page === "restore") titleRef.current?.focus();
    else destinationRef.current?.focus();
  }, [open, page]);

  const changeOpen = (next: boolean) => {
    if (busy) return;
    if (next) {
      setPage("move");
      setError("");
      setTargetProjectId("");
    }
    setOpen(next);
  };
  const run = async (input: SessionProjectAssignment) => {
    if (!assign || !thread.sessionId || busy) return;
    const request = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      const result = await assign(input);
      if (request !== requestRef.current) return;
      store.purge(
        ({ thread: cached }) => cached.sessionId === thread.sessionId
      );
      // Navigate before reloading, which can unmount the source Conversation.
      setOpen(false);
      onAssigned?.({
        projectId: result.projectId,
        sessionId: thread.sessionId
      });
      await store.loadProjects();
    } catch (cause) {
      if (request === requestRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };
  if (!assign || !thread.sessionId) return null;
  const canMove = targets.some((target) => target.id === targetProjectId);
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <button
        aria-label="Move Conversation"
        className="personal-session-manage-button"
        onClick={() => changeOpen(true)}
        title="Move Conversation"
        type="button"
      >
        <FolderInput aria-hidden="true" />
        <span>Move</span>
      </button>
      <DialogPopup className="personal-session-assignment-dialog">
        <DialogHeader>
          <div className="personal-assignment-heading">
            {page === "restore" ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Back to Move Conversation"
                disabled={busy}
                onClick={() => {
                  setPage("move");
                  setError("");
                }}
              >
                <ArrowLeft aria-hidden="true" />
              </Button>
            ) : null}
            <DialogTitle ref={titleRef} tabIndex={-1}>
              {page === "restore"
                ? "Restore original assignment"
                : "Move Conversation"}
            </DialogTitle>
          </div>
          <DialogDescription className="personal-assignment-context">
            {page === "restore" ? (
              "Restore the assignment recorded when this Conversation was captured."
            ) : (
              <>
                <span className="personal-assignment-conversation">
                  {thread.name}
                </span>
                <span>
                  Currently in <strong>{thread.projectName}</strong>
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {page === "restore" ? (
          <>
            <div className="personal-assignment-restore-target">
              <span>Restore to</span>
              <strong>{originalAssignment}</strong>
            </div>
            {originalAssignment === "Unresolved history" ? (
              <p className="personal-assignment-note">
                This Conversation has no resolved original Project.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="personal-memory-error">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPage("move");
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run({
                    action: "reset",
                    sessionId: thread.sessionId!,
                    expectedVersion: thread.repositoryAssignment?.version ?? 1
                  })
                }
              >
                {busy ? "Saving…" : "Restore"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              if (!canMove) return;
              void run({
                action: "move",
                sessionId: thread.sessionId!,
                targetProjectId,
                expectedVersion: thread.repositoryAssignment?.version ?? 1
              });
            }}
          >
            <div className="personal-project-destination">
              <label htmlFor={destinationId}>Move to Project</label>
              <div className="personal-project-destination-row">
                <select
                  ref={destinationRef}
                  id={destinationId}
                  value={targetProjectId}
                  onChange={(event) =>
                    setTargetProjectId(event.currentTarget.value)
                  }
                  disabled={busy || !targets.length}
                  name="targetProjectId"
                  required
                >
                  <option disabled value="">
                    {targets.length ? "Select Project…" : "No other Projects"}
                  </option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name}
                    </option>
                  ))}
                </select>
                {onCreateProject ? (
                  <CreateProjectDialog
                    create={onCreateProject}
                    disabled={busy}
                    iconOnly
                    triggerClassName="personal-project-destination-add"
                    onCreated={(project) => {
                      if (
                        project.id !== thread.projectId &&
                        project.id !== "unassigned"
                      )
                        setTargetProjectId(project.id);
                    }}
                  />
                ) : null}
              </div>
            </div>
            <details className="personal-assignment-capture-details">
              <summary>Capture details</summary>
              <dl>
                <dt>Original assignment</dt>
                <dd>{originalAssignment}</dd>
                <dt>Captured folder</dt>
                <dd>{capturedFolder ?? "Not recorded"}</dd>
              </dl>
            </details>
            {error ? (
              <p role="alert" className="personal-memory-error">
                {error}
              </p>
            ) : null}
            <DialogFooter className="personal-session-assignment-actions">
              {thread.projectAssignmentSource === "user_override" ? (
                <Button
                  variant="ghost"
                  className="personal-assignment-restore-action"
                  disabled={busy}
                  onClick={() => {
                    setPage("restore");
                    setError("");
                  }}
                  type="button"
                >
                  Restore original…
                </Button>
              ) : null}
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => changeOpen(false)}
              >
                Cancel
              </Button>
              <Button disabled={busy || !canMove} type="submit">
                {busy ? "Saving…" : "Move"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}
