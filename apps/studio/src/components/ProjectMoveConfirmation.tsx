"use client";

import { useEffect, useRef, useState } from "react";
import {
  dismissProjectMoveNotice,
  shouldShowProjectMoveInstructionsNotice
} from "@/lib/project-move-preference";

type ProjectMoveConfirmationProps = {
  threadTitle: string;
  projectName: string;
  sourceEditStatus: "changed" | "clean" | "unknown";
  // The caller owns any dismissed-notice intent while a move is pending.
  onMove: (dontShowAgain: boolean) => Promise<"completed" | "pending">;
  onCancel: () => void;
};

export function ProjectMoveConfirmation({
  threadTitle,
  projectName,
  sourceEditStatus,
  onMove,
  onCancel
}: ProjectMoveConfirmationProps) {
  const [showProjectInstructionsNotice] = useState(
    shouldShowProjectMoveInstructionsNotice
  );
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isMoving) {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMoving, onCancel]);

  const confirmMove = async () => {
    if (isMoving) return;

    setIsMoving(true);
    setMoveError(null);
    try {
      const outcome = await onMove(dontShowAgain);
      if (outcome === "completed" && dontShowAgain) dismissProjectMoveNotice();
      onCancel();
    } catch (error) {
      const message =
        error instanceof Error ? error.message.trim().slice(0, 300) : "";
      setMoveError(
        message || "The conversation could not be moved. Try again."
      );
    } finally {
      setIsMoving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={() => {
        if (!isMoving) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-move-title"
        aria-describedby={`project-move-description${sourceEditStatus !== "clean" ? " project-move-source-warning" : ""}`}
        className="w-[400px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 py-4">
          <h2
            id="project-move-title"
            className="text-base font-semibold text-foreground"
          >
            Move to Project?
          </h2>
          <p
            id="project-move-description"
            className="mt-2 text-sm leading-relaxed text-muted"
          >
            Move{" "}
            <span className="font-medium text-foreground-secondary">
              &ldquo;{threadTitle}&rdquo;
            </span>{" "}
            to{" "}
            <span className="font-medium text-foreground-secondary">
              {projectName}
            </span>
            ?{" "}
            {showProjectInstructionsNotice
              ? "Future Agent turns in this conversation will use the Project’s files and instructions."
              : null}
          </p>
          {sourceEditStatus !== "clean" && (
            <p
              id="project-move-source-warning"
              role="note"
              className="mt-3 text-sm leading-relaxed text-foreground-secondary"
            >
              {sourceEditStatus === "changed"
                ? "Uncommitted file edits will stay in the current workspace."
                : "If there are uncommitted file edits, they will stay in the current workspace."}{" "}
              They will not be copied to {projectName}. If Koed cannot safely
              retain that workspace, the Move will fail and this Conversation
              will remain here.
            </p>
          )}
          {showProjectInstructionsNotice ? (
            <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={dontShowAgain}
                disabled={isMoving}
                onChange={(event) => setDontShowAgain(event.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              Don&rsquo;t show the Project instructions notice again
            </label>
          ) : null}
          {moveError && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {moveError}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-background/40 px-5 py-3">
          <button
            ref={cancelButtonRef}
            type="button"
            className="rounded-md px-3.5 py-2 text-sm font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
            onClick={onCancel}
            disabled={isMoving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white disabled:cursor-wait disabled:opacity-50"
            onClick={() => void confirmMove()}
            disabled={isMoving}
          >
            {isMoving ? "Moving…" : "Move"}
          </button>
        </div>
      </div>
    </div>
  );
}
