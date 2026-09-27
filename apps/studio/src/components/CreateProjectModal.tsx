"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronLeft, Folder, Laptop, Users, X } from "lucide-react";

export type ProjectType = "local" | "collaborative";

export type TeamOption = {
  id: string;
  name: string;
};

export type CreatedProject = {
  id: string;
  name: string;
  path: string;
  branch: string;
  gitStatus: "clean";
  threads: [];
  defaultExpanded: true;
  sharedWith: string[];
  githubRepo?: string;
};

const MOCK_FOLDERS = [
  "~/dev/memory-layer",
  "~/dev/frontend-app",
  "~/dev/shared-workspace",
  "~/dev/agent-memory",
];

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "untitled-project";
}

export function CreateProjectModal({
  teams,
  onClose,
  onCreate,
  forceTeamId,
  onBack,
  previewMode = false,
  liveMode = false,
  onChooseFolder,
}: {
  teams: TeamOption[];
  onClose: () => void;
  onCreate: (project: CreatedProject & { selectionId?: string }) => void | Promise<void>;
  forceTeamId?: string;
  onBack?: () => void;
  previewMode?: boolean;
  liveMode?: boolean;
  onChooseFolder?: () => Promise<{ path: string; selectionId: string } | null>;
}) {
  const [projectType, setProjectType] = useState<ProjectType>(forceTeamId ? "collaborative" : "local");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(forceTeamId ? [forceTeamId] : []);
  const [folderIndex, setFolderIndex] = useState(0);
  const [githubRepo, setGithubRepo] = useState("");
  const [selectionId, setSelectionId] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate =
    name.trim().length > 0 &&
    path.trim().length > 0 &&
    (projectType === "local" || selectedTeamIds.length > 0) &&
    (!liveMode || (projectType === "local" && Boolean(selectionId))) &&
    !saving;

  const chooseFolder = async () => {
    if (onChooseFolder) {
      setFolderBusy(true);
      setError(null);
      try {
        const selected = await onChooseFolder();
        if (selected) {
          setPath(selected.path);
          setSelectionId(selected.selectionId);
          if (!name.trim()) setName(selected.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project");
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "The folder picker is unavailable.");
      } finally {
        setFolderBusy(false);
      }
      return;
    }
    const nextPath = name.trim()
      ? `~/dev/${slugify(name)}`
      : MOCK_FOLDERS[folderIndex % MOCK_FOLDERS.length];
    setPath(nextPath);
    setFolderIndex((current) => current + 1);
    if (!name.trim()) {
      const inferredName = nextPath.split("/").pop() ?? "Untitled project";
      setName(inferredName);
    }
  };

  const submit = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        id: `p-${Date.now()}`,
        name: name.trim(),
        path: path.trim(),
        branch: "main",
        gitStatus: "clean",
        threads: [],
        defaultExpanded: true,
        sharedWith: projectType === "collaborative" ? selectedTeamIds : [],
        githubRepo: projectType === "collaborative" ? githubRepo.trim() || undefined : undefined,
        ...(selectionId ? { selectionId } : {}),
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Project registration failed.");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        className="w-[520px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-1.5">
            {onBack && <button type="button" className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary" onClick={onBack} aria-label="Back"><ChevronLeft className="h-4 w-4" /></button>}
            <h2 id="create-project-title" className="text-base font-semibold text-foreground">Create project</h2>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary transition-colors"
            onClick={onClose}
            aria-label="Close"
            disabled={saving}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-5">
          {liveMode && <p className="mb-4 text-xs text-subtle">Choose a local folder to register it as a Koed project. The folder is registered when you press Create.</p>}
          {!forceTeamId && (
          <>
          <p className="mb-3 text-sm text-muted">Project type</p>
          <div className="grid grid-cols-2 gap-3">
            <TypeCard
              selected={projectType === "local"}
              icon={<Laptop className="h-4 w-4" />}
              title="Local"
              description="Edit, run, and test files on your computer"
              onClick={() => setProjectType("local")}
            />
            <TypeCard
              selected={projectType === "collaborative"}
              icon={<Users className="h-4 w-4" />}
              title="Collaborative"
              description={liveMode ? "Team sharing will be connected later" : "Share this project and its memory layer with a team"}
              onClick={() => setProjectType("collaborative")}
              disabled={liveMode}
            />
          </div>
          </>
          )}

          {projectType === "collaborative" && !forceTeamId && (
            <div className="mt-5">
              <p className="mb-2 text-sm text-muted">Share with</p>
              <div className="rounded-xl border border-border bg-background/40 p-1">
                {teams.map((team) => {
                  const isSelected = selectedTeamIds.includes(team.id);
                  return (
                    <button
                      key={team.id}
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-surface-hover transition-colors"
                      onClick={() => {
                        setSelectedTeamIds((current) =>
                          isSelected
                            ? current.filter((id) => id !== team.id)
                            : [...current, team.id]
                        );
                      }}
                    >
                      <span className="text-sm text-foreground-secondary">{team.name}</span>
                      <span
                        className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
                          isSelected
                            ? "border-chip bg-chip text-chip-foreground"
                            : "border-border-strong text-transparent"
                        }`}
                      >
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="mt-5 block">
            <span className="mb-2 block text-sm text-muted">Project name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="Memory Layer Core"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
            />
          </label>

          {projectType === "collaborative" && (
            <label className="mt-4 block">
              <span className="mb-2 block text-sm text-muted">GitHub repository <span className="text-subtle">(optional)</span></span>
              <div className="flex items-center gap-2 rounded-md border border-border bg-background/50 px-3">
                <Folder className="h-4 w-4 flex-shrink-0 text-subtle" />
                <input className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-foreground outline-none placeholder:text-faint" value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} placeholder="owner/repository" aria-describedby={previewMode ? "repo-preview-note" : undefined} />
              </div>
              {previewMode && <span id="repo-preview-note" className="mt-1 block text-xs text-warning">Saved in this browser only. This repository is not connected to GitHub.</span>}
            </label>
          )}

          <div className="mt-4">
            <span className="mb-2 block text-sm text-muted">Folder</span>
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted">
                <Folder className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{path || "No folder selected"}</span>
              </div>
              <button
                type="button"
                className="flex-shrink-0 rounded-lg border border-border bg-surface-hover px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-active transition-colors"
                onClick={() => void chooseFolder()}
                disabled={folderBusy || saving}
              >
                {folderBusy ? "Choosing…" : "Choose folder"}
              </button>
            </div>
          </div>
          {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
        </div>

        <div className="flex justify-end border-t border-border bg-background/40 px-5 py-3">
          <button
            type="button"
            className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-chip"
            disabled={!canCreate}
            onClick={() => void submit()}
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TypeCard({
  selected,
  icon,
  title,
  description,
  onClick,
  disabled = false,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-left transition-colors ${
        selected
          ? "border-accent bg-accent/10"
          : "border-border bg-background/30 hover:border-border-strong"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <div className="mb-6 flex items-start justify-between">
        <span className={selected ? "text-accent" : "text-subtle"}>{icon}</span>
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full border ${
            selected ? "border-accent bg-accent" : "border-border-strong"
          }`}
        >
          {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-subtle">{description}</p>
    </button>
  );
}
