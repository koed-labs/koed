"use client";

import { Trash2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";

export type PersonalRemovalKind = "project" | "conversation";

/** Shared confirmation used wherever Personal browsing rows can be removed. */
export function PersonalRemovalControl({
  kind,
  name,
  disabled = false,
  onRemove
}: {
  kind: PersonalRemovalKind;
  name: string;
  disabled?: boolean;
  onRemove: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const pendingRef = useRef(false);
  const safeName =
    name.trim() || (kind === "project" ? "Project" : "Conversation");
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  const confirm = async () => {
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await onRemove();
      setOpen(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Studio could not update this list. Try again."
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
          setError(null);
        }}
        aria-label={`Remove ${safeName} from Studio`}
        title="Remove from Studio"
        className="shrink-0 rounded-md p-1.5 text-faint opacity-100 transition-opacity hover:bg-surface-hover hover:text-foreground-secondary focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !pending)
                  setOpen(false);
              }}
            >
              <section
                ref={dialogRef}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <h2
                  id={titleId}
                  className="text-base font-semibold text-foreground"
                >
                  Remove “{safeName}” from Studio?
                </h2>
                <p className="mt-3 text-sm leading-5 text-muted">
                  {kind === "project"
                    ? "This Project and its conversations will be hidden from Studio browsing."
                    : "This Conversation will be hidden from Studio browsing."}
                </p>
                <p className="mt-2 text-sm leading-5 text-muted">
                  Local files, chat history, captured memories, activity, and
                  Team sharing stay available. Active Agent work will continue
                  running.
                </p>
                {error ? (
                  <p role="alert" className="mt-3 text-sm text-danger">
                    {error}
                  </p>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setOpen(false)}
                    className="rounded-md px-3 py-2 text-sm text-muted hover:bg-surface-hover disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={pending || disabled}
                    onClick={() => void confirm()}
                    className="rounded-md bg-danger px-3 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
                  >
                    {pending ? "Removing…" : "Remove from Studio"}
                  </button>
                </div>
              </section>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
