"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Folder, Plus } from "lucide-react";
import type { HomeProject } from "@/lib/studio-home";

export function HomeProjectPicker({
  project,
  projects,
  canChooseFolder,
  onSelect,
  onChooseFolder,
  placement = "below",
  disabled = false,
  unavailableReason,
  noFolderUnavailableReason
}: {
  project: HomeProject | null;
  projects: readonly HomeProject[];
  canChooseFolder: boolean;
  onSelect: (project: HomeProject | null) => void;
  onChooseFolder?: () => Promise<HomeProject | null>;
  placement?: "above" | "below";
  disabled?: boolean;
  unavailableReason?: string | null;
  noFolderUnavailableReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    container.current
      ?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]'
      )
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const select = (next: HomeProject | null) => {
    onSelect(next);
    setOpen(false);
    setError(null);
    trigger.current?.focus();
  };
  const chooseFolder = async () => {
    if (busy || disabled || !canChooseFolder || !onChooseFolder) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await onChooseFolder();
      if (!mounted.current) return;
      if (selected) select(selected);
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "The folder could not be selected. Try again."
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const choices = [
    { project: null, label: "No folder" },
    ...projects.map((item) => ({ project: item, label: item.name }))
  ];
  return (
    <div ref={container} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-label={`Select project folder: ${project?.name ?? "No folder"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground disabled:opacity-50"
        title={project?.name ?? "Personal chat without a project folder"}
      >
        <Folder className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <span className="max-w-48 truncate">{project?.name ?? "Personal"}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-subtle" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Project folder"
          className={`absolute left-0 ${placement === "above" ? "bottom-full mb-2" : "top-full mt-2"} z-30 flex max-h-[min(20rem,45vh)] flex-col w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border-strong bg-surface p-1.5 shadow-xl`}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)"
              )
            );
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          {canChooseFolder && onChooseFolder && (
            <button
              type="button"
              role="menuitem"
              disabled={busy || disabled}
              onClick={() => void chooseFolder()}
              className="mb-1 flex w-full items-center gap-2 rounded-md border-b border-border px-2 py-2 text-left text-xs hover:bg-surface-hover disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />{" "}
              {busy ? "Choosing folder…" : "Choose folder…"}
            </button>
          )}
          {error && (
            <p role="alert" className="px-2 py-2 text-xs text-danger">
              {error}
            </p>
          )}
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            {choices.map((choice) => (
              <button
                key={choice.project?.id ?? "no-folder"}
                type="button"
                role="menuitemradio"
                aria-checked={
                  (choice.project?.id ?? null) === (project?.id ?? null)
                }
                disabled={
                  busy ||
                  disabled ||
                  (!choice.project && Boolean(noFolderUnavailableReason))
                }
                title={
                  !choice.project
                    ? (noFolderUnavailableReason ?? undefined)
                    : (unavailableReason ?? undefined)
                }
                onClick={() => select(choice.project)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                {(choice.project?.id ?? null) === (project?.id ?? null) && (
                  <Check className="h-3.5 w-3.5 shrink-0" />
                )}
              </button>
            ))}
          </div>
          {(unavailableReason || noFolderUnavailableReason) && (
            <p role="status" className="px-2 py-2 text-xs text-subtle">
              {unavailableReason || noFolderUnavailableReason}
            </p>
          )}
          {!canChooseFolder && !disabled && (
            <p className="px-2 py-2 text-xs text-subtle">
              Choose a new folder in the Koed desktop app.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
