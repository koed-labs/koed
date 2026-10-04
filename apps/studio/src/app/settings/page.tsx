"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useBuildView } from "@/components/BuildViewProvider";
import { useTheme, type ThemeName } from "@/components/ThemeProvider";
import { StudioSidebar } from "@/components/studio/StudioSidebar";
import type { BuildViewMode } from "@/lib/buildView";
import { BackendConnectionSettings } from "./BackendConnectionSettings";
import { TeamMemorySettings } from "./TeamMemorySettings";
import { StudioAiClientSettings } from "./StudioAiClientSettings";
import { StudioDevicesSettings } from "./StudioDevicesSettings";
import { StudioSetupSettings } from "./StudioSetupSettings";
import { StudioSettingsComputerContext } from "./StudioSettingsComputerContext";
import { StudioNotificationSettings } from "./StudioNotificationSettings";

const THEME_OPTIONS: { id: ThemeName; label: string; detail: string }[] = [
  { id: "dark", label: "Dark", detail: "Zinc chrome on a near-black canvas." },
  {
    id: "light",
    label: "Light",
    detail: "The same language, inverted for bright rooms."
  },
  {
    id: "system",
    label: "System",
    detail: "Match this device's setting and follow it if it changes."
  }
];

const BUILD_VIEW_OPTIONS: {
  id: BuildViewMode;
  label: string;
  detail: string;
}[] = [
  {
    id: "story",
    label: "Story",
    detail: "Plain-language milestones: what got built, not how."
  },
  {
    id: "advanced",
    label: "Advanced",
    detail: "File-level detail: diff stats, Git status, and branch."
  }
];

function PreferenceOption({
  group,
  id,
  label,
  detail,
  selected,
  onSelect
}: {
  group: string;
  id: string;
  label: string;
  detail: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex min-h-24 cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${
        selected
          ? "border-border-strong bg-surface-hover text-foreground"
          : "border-border bg-surface/50 text-foreground-secondary hover:border-border-strong hover:text-foreground"
      }`}
    >
      <input
        type="radio"
        name={group}
        value={id}
        checked={selected}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-subtle">
          {detail}
        </span>
      </span>
    </label>
  );
}

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { view, setView } = useBuildView();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");

  return (
    <div className="flex h-full min-h-0 w-full">
      <StudioSidebar
        projects={[]}
        collapsed={collapsed}
        selectedProject={null}
        onProjectSelect={() => undefined}
        onToggle={() => setCollapsed((value) => !value)}
        onHome={() => router.push("/")}
        onNewChat={() => router.push("/?chat=1")}
        onPullRequests={() => router.push("/pull-requests")}
        onPlugins={() => router.push("/plugins")}
        activeSection="settings"
      />
      <main className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto bg-background text-foreground no-drag">
        <div className="mx-auto w-full max-w-3xl px-5 pt-8 pb-16 sm:px-8 sm:pt-10 sm:pb-20 no-drag">
          <header>
            <h1 className="text-2xl font-semibold">Settings</h1>
            <p className="mt-2 text-sm text-muted">
              Appearance for this workspace.
            </p>
          </header>

          <section
            className="mt-9 border-b border-border pb-8"
            aria-labelledby="theme-heading"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2
                id="theme-heading"
                className="text-sm font-medium text-foreground-secondary"
              >
                Theme
              </h2>
              <p className="text-xs text-subtle">Saved on this device.</p>
            </div>
            <fieldset className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <legend className="sr-only">Choose a theme</legend>
              {THEME_OPTIONS.map((option) => (
                <PreferenceOption
                  key={option.id}
                  group="theme"
                  id={option.id}
                  label={option.label}
                  detail={option.detail}
                  selected={theme === option.id}
                  onSelect={() => setTheme(option.id)}
                />
              ))}
            </fieldset>
          </section>

          <section
            className="mt-8 border-b border-border pb-8"
            aria-labelledby="build-detail-heading"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2
                id="build-detail-heading"
                className="text-sm font-medium text-foreground-secondary"
              >
                Build detail
              </h2>
              <p className="text-xs text-subtle">Saved on this device.</p>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted">
              How much engineering detail Chat mode shows while an agent builds
              a project.
            </p>
            <fieldset className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <legend className="sr-only">Choose the build detail level</legend>
              {BUILD_VIEW_OPTIONS.map((option) => (
                <PreferenceOption
                  key={option.id}
                  group="build-view"
                  id={option.id}
                  label={option.label}
                  detail={option.detail}
                  selected={view === option.id}
                  onSelect={() => setView(option.id)}
                />
              ))}
            </fieldset>
          </section>

          <StudioNotificationSettings />

          <StudioSettingsComputerContext.Provider
            value={{ selectedDeviceId, setSelectedDeviceId }}
          >
            <StudioAiClientSettings />

            <StudioSetupSettings />
          </StudioSettingsComputerContext.Provider>

          <StudioDevicesSettings />

          <BackendConnectionSettings />

          <TeamMemorySettings />
        </div>
      </main>
    </div>
  );
}
