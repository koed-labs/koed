"use client";

import { useTheme, type ThemeName } from "@/components/ThemeProvider";
import { useBuildView } from "@/components/BuildViewProvider";
import type { BuildViewMode } from "@/lib/buildView";

const OPTIONS: { id: ThemeName; label: string; detail: string }[] = [
  { id: "dark", label: "Dark", detail: "Zinc chrome on a near-black canvas." },
  { id: "light", label: "Light", detail: "The same language, inverted for bright rooms." },
];

const BUILD_VIEW_OPTIONS: { id: BuildViewMode; label: string; detail: string }[] = [
  {
    id: "story",
    label: "Story",
    detail: "Plain-language milestones - what got built, not how. The default, built for vibe coders.",
  },
  {
    id: "advanced",
    label: "Advanced",
    detail: "File-level detail: diff stats, git status, branch - the Codex / Claude Code style view.",
  },
];

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { view, setView } = useBuildView();

  return (
    <div className="flex h-full overflow-y-auto bg-background text-foreground drag-region">
      <div className="mx-auto w-full max-w-2xl px-8 py-10 no-drag">
        <h1 className="text-3xl font-semibold">Settings</h1>
        <p className="mt-2 text-sm text-muted">Appearance for this workspace.</p>

        <section className="mt-10">
          <h2 className="text-sm font-medium text-foreground-secondary">Theme</h2>
          <p className="mt-1 text-xs text-subtle">Saved on this device.</p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {OPTIONS.map((option) => {
              const selected = theme === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setTheme(option.id)}
                  className={`rounded-xl border p-4 text-left transition-colors ${
                    selected
                      ? "border-border-strong bg-surface-hover text-foreground"
                      : "border-border bg-surface/50 text-foreground-secondary hover:border-border-strong hover:text-foreground"
                  }`}
                >
                  <p className="text-sm font-medium">{option.label}</p>
                  <p className="mt-1 text-xs text-subtle">{option.detail}</p>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-medium text-foreground-secondary">Build detail</h2>
          <p className="mt-1 text-xs text-subtle">
            How much engineering detail Chat mode shows while an agent builds a project. Saved on this device.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {BUILD_VIEW_OPTIONS.map((option) => {
              const selected = view === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setView(option.id)}
                  className={`rounded-xl border p-4 text-left transition-colors ${
                    selected
                      ? "border-border-strong bg-surface-hover text-foreground"
                      : "border-border bg-surface/50 text-foreground-secondary hover:border-border-strong hover:text-foreground"
                  }`}
                >
                  <p className="text-sm font-medium">{option.label}</p>
                  <p className="mt-1 text-xs text-subtle">{option.detail}</p>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
