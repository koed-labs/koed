import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import type { WorkspaceProjectLifecycleReview } from "@koed/shared/workspace-project-contract";

export function HqProjectLifecycle({
  project,
  onClose,
  onFinished,
  client,
  ownerId,
  profileKey,
  onLeave,
  onOwnerDelete
}: {
  project: {
    id: string;
    workspaceProjectId: string;
    teamBackendId: string;
    name: string;
  } | null;
  onClose(): void;
  onFinished(): void;
  client: CollaborationRendererClient;
  ownerId: string | null | undefined;
  profileKey: string | null | undefined;
  onLeave?: (review: WorkspaceProjectLifecycleReview) => Promise<void>;
  onOwnerDelete?: (review: WorkspaceProjectLifecycleReview) => Promise<void>;
}) {
  const [review, setReview] = useState<WorkspaceProjectLifecycleReview | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const principalId = client.current()?.navigation.teamPrincipal?.id;
  const identity = `${ownerId ?? ""}|${profileKey ?? ""}|${principalId ?? ""}|${project?.id ?? ""}|${project?.workspaceProjectId ?? ""}|${project?.teamBackendId ?? ""}`;
  useEffect(() => {
    epoch.current++;
    setReview(null);
    setError(null);
    setBusy(false);
    if (!project) return;
    trigger.current = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const current = epoch.current;
    const backend = project.teamBackendId;
    void client
      .reviewProjectLifecycle({ projectId: project.workspaceProjectId })
      .then((value) => {
        if (
          epoch.current === current &&
          client.current()?.connection.backendId === backend &&
          client.current()?.navigation.teamPrincipal?.id === principalId &&
          value.project.id === project.workspaceProjectId
        )
          setReview(value);
      })
      .catch((cause) => {
        if (epoch.current === current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Project review is unavailable."
          );
      });
    return () => {
      epoch.current++;
      trigger.current?.focus();
    };
  }, [identity, client]);
  if (!project) return null;
  const current = (captured: number) =>
    epoch.current === captured &&
    client.current()?.connection.backendId === project.teamBackendId &&
    client.current()?.navigation.teamPrincipal?.id === principalId;
  const run = async (operation: "leave" | "delete") => {
    if (!review || busy || !current(epoch.current)) return;
    const captured = epoch.current;
    setBusy(true);
    setError(null);
    try {
      if (operation === "delete") {
        if (onOwnerDelete) await onOwnerDelete(review);
        else
          await client.deleteSharedProject({
            teamId: review.project.teamId,
            projectId: review.project.id,
            expectedProjectVersion: review.project.version
          });
      } else if (onLeave) await onLeave(review);
      else
        await client.leaveProject({
          teamId: review.project.teamId,
          projectId: review.project.id,
          expectedProjectVersion: review.project.version,
          expectedMemberVersion: review.actorMemberVersion
        });
      if (current(captured)) {
        onFinished();
        onClose();
      }
    } catch (cause) {
      if (current(captured))
        setError(
          cause instanceof Error
            ? cause.message
            : "Project access changed. Review again."
        );
    } finally {
      if (current(captured)) setBusy(false);
    }
  };
  const owner = review?.actorTeamMemberId === review?.project.ownerTeamMemberId;
  const keepFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const buttons = [
      ...(dialog.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)"
      ) ?? [])
    ];
    if (!buttons.length) return;
    const first = buttons[0]!,
      last = buttons[buttons.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="hq-project-modal-backdrop" data-hq-shell="">
      <div
        ref={dialog}
        className="hq-project-modal hq-project-lifecycle"
        role="dialog"
        aria-modal="true"
        aria-label="Project access"
        onKeyDown={(event) => {
          keepFocus(event);
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2>
          {review
            ? owner
              ? `Delete ${project.name}?`
              : `Leave ${project.name}?`
            : "Reviewing Project…"}
        </h2>
        <p>
          {review
            ? owner
              ? "You own this Project. To leave it, delete the shared Project for everyone. Published Team evidence stays frozen; your private chats and Personal memory stay yours."
              : "Leaving closes your access to this shared Project. Its published Team evidence remains with the group; your private chats and Personal memory stay yours. A new invitation is needed to return."
            : "Checking your current Project access."}
        </p>
        {owner && review ? (
          <p>
            Delete has no Undo. Restoring within 30 days restores Project
            metadata and its thread only. It does not restore links, grants,
            members, or content access.
          </p>
        ) : null}
        {error ? (
          <p className="hq-project-modal__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="hq-project-modal__actions">
          <button
            ref={closeButton}
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="hq-project-modal__danger"
            type="button"
            disabled={!review || busy}
            onClick={() => void run(owner ? "delete" : "leave")}
          >
            {busy ? "Working…" : owner ? "Delete project" : "Leave project"}
          </button>
        </div>
      </div>
    </div>
  );
}
