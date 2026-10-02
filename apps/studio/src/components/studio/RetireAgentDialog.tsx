import { useEffect } from "react";
import type { PersonalAgent } from "@/lib/personal-agents-client";

export function RetireAgentDialog({
  agent,
  error,
  saving,
  onCancel,
  onConfirm
}: {
  agent: PersonalAgent;
  error: string | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (saving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, saving]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/60 p-2 backdrop-blur-sm no-drag sm:p-4"
      onClick={() => !saving && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="retire-agent-title"
        aria-describedby="retire-agent-description"
        className="max-h-[calc(100dvh-1rem)] w-full max-w-[400px] overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="retire-agent-title"
          className="text-base font-semibold text-foreground"
        >
          Retire {agent.name}?
        </h2>
        <p id="retire-agent-description" className="mt-2 text-sm text-muted">
          Retirement prevents new use of this agent. Existing jobs, outputs, and
          history stay preserved.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            autoFocus={!saving}
            className="rounded-lg bg-surface-hover px-3.5 py-2 text-sm font-medium text-foreground-secondary hover:bg-surface-active disabled:opacity-50"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            className="rounded-lg border border-warning/30 bg-warning/15 px-3.5 py-2 text-sm font-medium text-warning hover:bg-warning/25 disabled:opacity-50"
            onClick={onConfirm}
          >
            {saving ? "Retiring…" : "Retire agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
