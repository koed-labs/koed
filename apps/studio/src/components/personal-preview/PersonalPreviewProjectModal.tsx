"use client";

import { useEffect, useState } from "react";
import { Check, Folder, Laptop, Users, X } from "lucide-react";
import { SiGithub } from "react-icons/si";

type TeamOption = { id: string; name: string };

export function PersonalPreviewProjectModal({
  teams,
  onClose,
  onCreate,
}: {
  teams: TeamOption[];
  onClose: () => void;
  onCreate: (input: { name: string; path: string; githubRepo?: string; sharedWith: string[] }) => void;
}) {
  const [name, setName] = useState("");
  const [collaborative, setCollaborative] = useState(false);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const canCreate = Boolean(name.trim() && path) && (!collaborative || selectedTeamIds.length > 0);
  const chooseFolder = () => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-project";
    setPath(`~/preview/${slug}`);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm no-drag" onClick={onClose}>
      <div className="w-[520px] max-w-full overflow-hidden rounded-xl border border-border bg-surface shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="preview-project-title" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4">
          <h2 id="preview-project-title" className="text-base font-semibold text-foreground">New project</h2>
          <button type="button" className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-4 px-5 pb-5">
          <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-warning">
            Preview only. Project details are stored in this browser. The folder chooser is simulated; it does not create or read files. GitHub is not connected.
          </p>
          <label className="block">
            <span className="mb-2 block text-sm text-muted">Project name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="My project" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong" />
          </label>
          <div>
            <p className="mb-2 text-sm text-muted">Project type</p>
            <div className="grid grid-cols-2 gap-3">
              <ProjectTypeButton selected={!collaborative} onClick={() => setCollaborative(false)} icon={<Laptop className="h-4 w-4" />} label="Local" description="Preview project details in this browser" />
              <ProjectTypeButton selected={collaborative} onClick={() => setCollaborative(true)} icon={<Users className="h-4 w-4" />} label="Collaborative" description="Preview sharing with a team" />
            </div>
          </div>
          {collaborative && <div>
            <p className="mb-2 text-sm text-muted">Share with</p>
            <div className="rounded-md border border-border bg-background/40 p-1">{teams.map((team) => {
            const selected = selectedTeamIds.includes(team.id);
            return <button key={team.id} type="button" onClick={() => setSelectedTeamIds((current) => selected ? current.filter((id) => id !== team.id) : [...current, team.id])} className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-foreground-secondary hover:bg-surface-hover"><span>{team.name}</span><span className={`flex h-4 w-4 items-center justify-center rounded-sm border ${selected ? "border-chip bg-chip text-chip-foreground" : "border-border-strong text-transparent"}`}><Check className="h-3 w-3" strokeWidth={3} /></span></button>;
          })}</div>
          </div>}
          {collaborative && <label className="block">
            <span className="mb-2 block text-sm text-muted">GitHub repo (preview only)</span>
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
              <SiGithub className="h-4 w-4 flex-shrink-0 text-subtle" />
              <input value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} placeholder="org/repo" className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint" />
            </div>
            <span className="mt-1 block text-xs text-subtle">Saved as browser-local metadata only. It does not connect to GitHub.</span>
          </label>}
          <div>
            <span className="mb-2 block text-sm text-muted">Folder</span>
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted">
                <Folder className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{path || "No preview folder selected"}</span>
              </div>
              <button type="button" onClick={chooseFolder} className="flex-shrink-0 rounded-md border border-border bg-surface-hover px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-active">Choose folder</button>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover">Cancel</button>
            <button type="button" disabled={!canCreate} onClick={() => onCreate({ name: name.trim(), path, githubRepo: collaborative ? githubRepo.trim() || undefined : undefined, sharedWith: collaborative ? selectedTeamIds : [] })} className="rounded-md bg-chip px-3 py-2 text-xs font-medium text-chip-foreground disabled:cursor-not-allowed disabled:opacity-50">Create preview project</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectTypeButton({ selected, onClick, icon, label, description }: { selected: boolean; onClick: () => void; icon: React.ReactNode; label: string; description: string }) {
  return <button type="button" onClick={onClick} className={`flex min-h-[74px] flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors ${selected ? "border-border-strong bg-surface-hover text-foreground" : "border-border bg-background/40 text-foreground-secondary hover:bg-surface-hover/60"}`}><span className="flex items-center gap-2 text-sm">{icon}{label}</span><span className="text-xs leading-relaxed text-subtle">{description}</span></button>;
}
