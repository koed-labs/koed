"use client";

import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  GitPullRequest,
  Hammer,
  History,
  Layers,
  Minimize2,
  PanelRightOpen,
  Users,
  X,
} from "lucide-react";
import { relativeTime } from "@/lib/collab";
import { buildMilestonesForThread, gitStatusStory, totalsFor, type BuildMilestone } from "@/lib/buildProgress";
import type { Project, SuggestedAction, SuggestionReason } from "@/lib/workspace";
import { useBuildView } from "./BuildViewProvider";
import { useSidePanel, type SidePanelSection } from "./SidePanelContext";
import { useWorkspace } from "./WorkspaceProvider";
import type { BuildViewMode } from "@/lib/buildView";
import { Tooltip } from "./Tooltip";

const GIT_DOT: Record<Project["gitStatus"], string> = {
  clean: "bg-success",
  dirty: "bg-warning",
  syncing: "bg-accent",
};

// The one right-hand panel for the whole app. It always has something to
// show (Build), and takes on a second job (Reasons) only while a
// suggestion's provenance is being looked at - one shell, two contents,
// never two panels fighting for the same strip of screen. Three sizes:
// hidden, a small floating peek (the default), and the full resizable
// sidebar, opened on request.
export function SidePanel({ localPreview = false }: { localPreview?: boolean }) {
  const { activeProject, activeThread } = useWorkspace();
  const { view, setView } = useBuildView();
  const { mode, setMode, section, setSection, reasons, width, isResizing, startResizing } = useSidePanel();
  const milestones = useMemo(() => buildMilestonesForThread(activeThread), [activeThread]);
  const totals = useMemo(() => totalsFor(milestones), [milestones]);

  if (mode === "hidden") {
    return (
      <button
        type="button"
        onClick={() => setMode("peek")}
        aria-label="Show panel"
        className="fixed right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-subtle shadow-lg shadow-black/10 transition-colors hover:text-foreground-secondary no-drag"
      >
        <PanelRightOpen className="h-4 w-4" />
      </button>
    );
  }

  if (mode === "peek") {
    return (
      <>
      <button
        type="button"
        onClick={() => setMode("full")}
        aria-label={section === "reasons" ? "Open reasons panel" : "Open Build panel"}
        className="fixed right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-subtle shadow-lg shadow-black/10 md:hidden no-drag"
      >
        {section === "reasons" ? <Layers className="h-4 w-4" /> : <Hammer className="h-4 w-4" />}
      </button>
      <div className="fixed right-4 top-4 z-40 hidden w-[300px] md:block no-drag">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-lg shadow-black/10">
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              {section === "reasons" ? <p className="text-sm font-medium text-foreground">Reasons</p> : <Tooltip content="Build" side="bottom"><span className="inline-flex w-fit items-center text-foreground"><Hammer className="h-4 w-4" aria-label="Build" /></span></Tooltip>}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1">
              {section === "build" && <BuildViewToggle view={view} setView={setView} />}
              <button
                type="button"
                onClick={() => setMode("hidden")}
                aria-label="Hide panel"
                className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMode("full")}
            className="flex w-full items-start gap-2 border-t border-border px-4 py-3 text-left transition-colors hover:bg-surface-hover"
          >
            <div className="min-w-0 flex-1">
              {section === "reasons" && reasons ? (
                <ReasonsPeekPreview suggestion={reasons} />
              ) : (
                <BuildPeekPreview project={activeProject} milestones={milestones} totals={totals} view={view} />
              )}
            </div>
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-faint" />
          </button>
        </div>
      </div>
      </>
    );
  }

  return (
    <div style={{ "--panel-width": `${width}px` } as React.CSSProperties} className="fixed inset-y-0 right-0 left-[72px] z-50 p-2 no-drag md:relative md:left-auto md:z-auto md:h-full md:w-[var(--panel-width)] md:flex-shrink-0 md:p-3">
      <button
        type="button"
        onMouseDown={startResizing}
        aria-label="Resize panel"
        className="group absolute inset-y-0 left-0 z-10 hidden w-3 cursor-col-resize touch-none md:block"
      >
        <span
          className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors ${
            isResizing ? "bg-accent" : "bg-border group-hover:bg-border-strong"
          }`}
        />
      </button>
      <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-lg shadow-black/5">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3.5">
          <div className="min-w-0">
            {section === "reasons" ? <h2 className="text-sm font-medium text-foreground">Reasons</h2> : <Tooltip content="Build" side="bottom"><h2 className="flex w-fit items-center text-foreground"><Hammer className="h-4 w-4" aria-label="Build" /></h2></Tooltip>}
            <p className="truncate text-xs text-subtle">
              {section === "reasons" ? `“${reasons?.label ?? ""}”` : activeProject ? activeProject.name : "No active project"}
            </p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
            <SectionTabs section={section} setSection={setSection} hasReasons={reasons !== null} />
            {section === "build" && <BuildViewToggle view={view} setView={setView} />}
            <button
              type="button"
              onClick={() => setMode("peek")}
              aria-label="Collapse to peek"
              className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setMode("hidden")}
              aria-label="Hide panel"
              className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {localPreview && <p className="mb-3 rounded-md border border-warning/25 bg-warning/5 px-2.5 py-2 text-xs leading-relaxed text-warning">Illustrative preview only. Build details are inferred from local chat text, not repository activity.</p>}
          {section === "reasons" && reasons ? (
            <ReasonsBody suggestion={reasons} />
          ) : activeProject ? (
            <BuildPanelBody project={activeProject} milestones={milestones} totals={totals} view={view} />
          ) : (
            <p className="text-sm leading-relaxed text-subtle">
              Open a project chat and this panel will start tracking what gets built, in as much or as little
              engineering detail as you want.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTabs({
  section,
  setSection,
  hasReasons,
}: {
  section: SidePanelSection;
  setSection: (section: SidePanelSection) => void;
  hasReasons: boolean;
}) {
  if (!hasReasons) return null;
  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 rounded-full border border-border bg-background p-0.5 text-[11px]">
      <button
        type="button"
        onClick={() => setSection("build")}
        className={`rounded-full px-2 py-0.5 font-medium transition-colors ${
          section === "build" ? "bg-surface-hover text-foreground" : "text-subtle hover:text-foreground-secondary"
        }`}
      >
        Build
      </button>
      <button
        type="button"
        onClick={() => setSection("reasons")}
        className={`rounded-full px-2 py-0.5 font-medium transition-colors ${
          section === "reasons" ? "bg-surface-hover text-foreground" : "text-subtle hover:text-foreground-secondary"
        }`}
      >
        Reasons
      </button>
    </div>
  );
}

function BuildViewToggle({ view, setView }: { view: BuildViewMode; setView: (view: BuildViewMode) => void }) {
  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 rounded-full border border-border bg-background p-0.5 text-[11px]">
      <button
        type="button"
        onClick={() => setView("story")}
        className={`rounded-full px-2 py-0.5 font-medium transition-colors ${
          view === "story" ? "bg-surface-hover text-foreground" : "text-subtle hover:text-foreground-secondary"
        }`}
      >
        Story
      </button>
      <button
        type="button"
        onClick={() => setView("advanced")}
        className={`rounded-full px-2 py-0.5 font-medium transition-colors ${
          view === "advanced" ? "bg-surface-hover text-foreground" : "text-subtle hover:text-foreground-secondary"
        }`}
      >
        Advanced
      </button>
    </div>
  );
}

// --- Build section ------------------------------------------------------

function BuildStatusRows({
  project,
  milestones,
  totals,
  view,
}: {
  project: Project;
  milestones: BuildMilestone[];
  totals: { filesChanged: number; linesAdded: number; linesRemoved: number };
  view: BuildViewMode;
}) {
  const hasMilestones = milestones.length > 0;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground-secondary">
          {view === "advanced" ? project.branch : `Working in ${project.branch}`}
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${GIT_DOT[project.gitStatus]}`} />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground-secondary">
          {view === "advanced" ? project.gitStatus : gitStatusStory(project.gitStatus)}
        </span>
      </div>
      {hasMilestones && (
        <div className="flex items-center gap-2.5">
          <Check className="h-3.5 w-3.5 flex-shrink-0 text-success" />
          {view === "advanced" ? (
            <span className="min-w-0 flex-1 text-sm text-foreground-secondary">
              {totals.filesChanged} files changed · <span className="text-success">+{totals.linesAdded}</span>{" "}
              <span className="text-danger">−{totals.linesRemoved}</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 text-sm text-foreground-secondary">
              {milestones.length} {milestones.length === 1 ? "thing" : "things"} built so far
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function BuildPeekPreview({
  project,
  milestones,
  totals,
  view,
}: {
  project: Project | null;
  milestones: BuildMilestone[];
  totals: { filesChanged: number; linesAdded: number; linesRemoved: number };
  view: BuildViewMode;
}) {
  if (!project) {
    return (
      <p className="text-xs leading-relaxed text-subtle">
        No active project. Open a project chat to start tracking what gets built.
      </p>
    );
  }
  return <BuildStatusRows project={project} milestones={milestones} totals={totals} view={view} />;
}

function BuildPanelBody({
  project,
  milestones,
  totals,
  view,
}: {
  project: Project;
  milestones: BuildMilestone[];
  totals: { filesChanged: number; linesAdded: number; linesRemoved: number };
  view: BuildViewMode;
}) {
  const hasMilestones = milestones.length > 0;
  return (
    <>
      <div className="border-b border-border pb-4">
        <BuildStatusRows project={project} milestones={milestones} totals={totals} view={view} />
      </div>
      {hasMilestones ? (
        <div className="mt-4">
          {view === "advanced" ? (
            <AdvancedMilestoneList milestones={milestones} />
          ) : (
            <StoryMilestoneList milestones={milestones} />
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-subtle">Nothing built yet in {project.name}. Ask Koed to get started.</p>
      )}
    </>
  );
}

function StoryMilestoneList({ milestones }: { milestones: BuildMilestone[] }) {
  return (
    <ul className="space-y-4">
      {milestones.map((milestone, index) => (
        <StoryMilestoneItem key={milestone.id} milestone={milestone} isLatest={index === milestones.length - 1} />
      ))}
    </ul>
  );
}

function StoryMilestoneItem({ milestone, isLatest }: { milestone: BuildMilestone; isLatest: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-start gap-2.5 text-left">
        <span
          className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ${
            isLatest ? "bg-accent/15 text-accent" : "bg-success/15 text-success"
          }`}
        >
          <Check className="h-2.5 w-2.5" />
        </span>
        <span className="min-w-0 flex-1">
          <p className="text-sm text-foreground-secondary">{milestone.label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-subtle">{milestone.summary}</p>
          <p className="mt-1 text-[11px] text-faint">{relativeTime(milestone.at)}</p>
        </span>
        <ChevronDown
          className={`mt-1 h-3.5 w-3.5 flex-shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <p className="ml-7 mt-2 rounded-lg bg-surface-hover/60 px-3 py-2.5 text-xs leading-relaxed text-subtle">
          {milestone.detail}
        </p>
      )}
    </li>
  );
}

function AdvancedMilestoneList({ milestones }: { milestones: BuildMilestone[] }) {
  return (
    <ul className="space-y-2">
      {milestones.map((milestone) => (
        <AdvancedMilestoneItem key={milestone.id} milestone={milestone} />
      ))}
    </ul>
  );
}

function AdvancedMilestoneItem({ milestone }: { milestone: BuildMilestone }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-border">
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <span className="flex-shrink-0 font-mono text-[11px] text-faint">{relativeTime(milestone.at)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground-secondary">{milestone.file}</span>
        <span className="flex-shrink-0 font-mono text-[11px] text-subtle">
          <span className="text-success">+{milestone.linesAdded}</span> <span className="text-danger">−{milestone.linesRemoved}</span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 flex-shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5">
          <p className="font-mono text-xs text-foreground-secondary">{milestone.label}</p>
          <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-subtle">{milestone.detail}</p>
          <p className="mt-1.5 font-mono text-[11px] text-faint">{milestone.filesChanged} files touched in this change</p>
        </div>
      )}
    </li>
  );
}

// --- Reasons section ------------------------------------------------------

const CATEGORY_LABEL: Record<SuggestionReason["category"], string> = {
  provenance: "Provenance",
  project: "Project",
  activity: "Recent activity",
  "pull-request": "Pull requests",
  team: "Team",
};

function ReasonIcon({ category }: { category: SuggestionReason["category"] }) {
  const className = "h-3.5 w-3.5 text-subtle";
  switch (category) {
    case "provenance":
      return <Layers className={className} />;
    case "project":
      return <Folder className={className} />;
    case "activity":
      return <History className={className} />;
    case "pull-request":
      return <GitPullRequest className={className} />;
    case "team":
      return <Users className={className} />;
  }
}

function ReasonsPeekPreview({ suggestion }: { suggestion: SuggestedAction }) {
  const first = suggestion.reasons[0];
  return (
    <div className="space-y-1">
      <p className="text-sm text-foreground-secondary">Why Koed suggested “{suggestion.label}”</p>
      {first && <p className="line-clamp-2 text-xs leading-relaxed text-subtle">{first.detail}</p>}
    </div>
  );
}

function ReasonsBody({ suggestion }: { suggestion: SuggestedAction }) {
  const grouped = suggestion.reasons.reduce<Record<string, SuggestionReason[]>>((groups, reason) => {
    const key = reason.category;
    groups[key] = [...(groups[key] ?? []), reason];
    return groups;
  }, {});

  const categoryOrder: SuggestionReason["category"][] = [
    "provenance",
    "project",
    "activity",
    "pull-request",
    "team",
  ];

  return (
    <>
      <p className="text-xs leading-relaxed text-subtle">Why Koed suggested “{suggestion.label}”.</p>
      <div className="mt-4 space-y-6">
        {categoryOrder.map((category) => {
          const reasons = grouped[category];
          if (!reasons?.length) return null;
          return (
            <section key={category}>
              <h3 className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-subtle">
                {CATEGORY_LABEL[category]}
              </h3>
              <div className="space-y-1">
                {reasons.map((reason) => (
                  <div key={reason.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2">
                    <span className="mt-0.5 flex-shrink-0">
                      <ReasonIcon category={reason.category} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm text-foreground-secondary">{reason.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-subtle">{reason.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        <section>
          <h3 className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-subtle">Sources</h3>
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-foreground-secondary">
            <Layers className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
            Koed Memory
          </div>
        </section>
      </div>
    </>
  );
}
