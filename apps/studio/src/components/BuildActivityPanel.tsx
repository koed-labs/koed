"use client";

import {
  Check,
  CircleAlert,
  ChevronDown,
  FileCode2,
  GitBranch,
  Hammer,
  LoaderCircle,
  Minimize2,
  PanelRightOpen,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  activityStateLabel,
  observedBuildTotals,
  storyEvents,
  technicalEvents,
  type BuildActivity,
  type BuildActivityEvent
} from "@/lib/studio-build-activity";
import type { BuildViewMode } from "@/lib/buildView";
import {
  boundBuildPanelWidth,
  BUILD_PANEL_DIVIDER_WIDTH,
  BUILD_PANEL_MARGIN_RIGHT,
  BUILD_PANEL_WIDTH_STEP,
  MAX_BUILD_PANEL_WIDTH,
  MIN_BUILD_PANEL_WIDTH
} from "./BuildActivityPanel.helpers";

export type BuildPanelMode = "compact" | "expanded" | "hidden";

export type BuildActivityPanelProps = {
  activity?: BuildActivity | null;
  initialMode?: Exclude<BuildPanelMode, "hidden">;
  onModeChange?: (mode: BuildPanelMode) => void;
  className?: string;
  onJobSelect?: (jobId: string) => void;
  onAttention?: (runtimeItemId: string) => void;
};

const STATUS_DOT: Record<BuildActivity["state"], string> = {
  unknown: "bg-subtle",
  idle: "bg-subtle",
  running: "bg-accent",
  completed: "bg-success",
  blocked: "bg-warning",
  failed: "bg-danger"
};

export function BuildActivityPanel({
  activity = null,
  initialMode = "compact",
  onModeChange,
  className = "",
  onJobSelect,
  onAttention
}: BuildActivityPanelProps) {
  const [mode, setModeState] = useState<BuildPanelMode>(initialMode);
  const [view, setView] = useState<BuildViewMode>("story");
  const [expandedWidth, setExpandedWidth] = useState(390);
  const [availablePanelWidth, setAvailablePanelWidth] = useState(
    Number.POSITIVE_INFINITY
  );
  const [showCompactCard, setShowCompactCard] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const panelAnchorRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(
    null
  );
  const resolved = activity ?? null;
  const title =
    resolved?.jobs?.find((job) => job.id === resolved.selectedJobId)?.title ??
    resolved?.project?.name ??
    "Build activity";

  const setMode = (next: BuildPanelMode) => {
    setModeState(next);
    onModeChange?.(next);
  };

  const readAvailablePanelWidth = useCallback(() => {
    const parentWidth = panelRef.current?.parentElement?.clientWidth;
    if (parentWidth === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(
      0,
      parentWidth - BUILD_PANEL_DIVIDER_WIDTH - BUILD_PANEL_MARGIN_RIGHT
    );
  }, []);

  const boundedWidth = useCallback(
    (value: number) => {
      return boundBuildPanelWidth(value, availablePanelWidth);
    },
    [availablePanelWidth]
  );

  const renderedExpandedWidth = boundBuildPanelWidth(
    expandedWidth,
    availablePanelWidth
  );
  const maxExpandedWidth = boundBuildPanelWidth(
    MAX_BUILD_PANEL_WIDTH,
    availablePanelWidth
  );

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStartRef.current = {
        pointerX: event.clientX,
        width: panelRef.current?.getBoundingClientRect().width ?? expandedWidth
      };
      setIsResizing(true);
    },
    [expandedWidth]
  );

  const onResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isResizing || !resizeStartRef.current) return;
      setExpandedWidth(
        boundedWidth(
          resizeStartRef.current.width +
            resizeStartRef.current.pointerX -
            event.clientX
        )
      );
    },
    [boundedWidth, isResizing]
  );

  const stopResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      resizeStartRef.current = null;
      setIsResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    []
  );

  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? 1 : -1;
        setExpandedWidth((current) =>
          boundedWidth(current + delta * BUILD_PANEL_WIDTH_STEP)
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        setExpandedWidth(boundedWidth(MIN_BUILD_PANEL_WIDTH));
      } else if (event.key === "End") {
        event.preventDefault();
        setExpandedWidth(boundedWidth(MAX_BUILD_PANEL_WIDTH));
      }
    },
    [boundedWidth]
  );

  useEffect(() => {
    const host = panelAnchorRef.current?.parentElement;
    if (!host) return;
    const syncCompactMode = () =>
      setShowCompactCard(window.innerWidth >= 1280 && host.clientWidth >= 1280);
    syncCompactMode();
    const observer = new ResizeObserver(syncCompactMode);
    observer.observe(host);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    if (mode !== "expanded" || !panelRef.current?.parentElement) return;
    const parent = panelRef.current.parentElement;
    const syncToAvailableWidth = () => {
      const nextAvailableWidth = readAvailablePanelWidth();
      setAvailablePanelWidth((current) =>
        current === nextAvailableWidth ? current : nextAvailableWidth
      );
      setExpandedWidth((current) =>
        boundBuildPanelWidth(current, nextAvailableWidth)
      );
    };
    syncToAvailableWidth();
    const observer = new ResizeObserver(syncToAvailableWidth);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [mode, readAvailablePanelWidth]);

  if (mode === "hidden") {
    return (
      <div className="absolute right-0 top-0 z-30 flex items-start justify-end">
        <button
          type="button"
          onClick={() => setMode("compact")}
          aria-label="Reopen Build activity"
          title="Reopen Build activity"
          className="mt-3 mr-3 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-subtle shadow-lg transition-colors hover:text-foreground-secondary"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (mode === "compact") {
    return (
      <>
        <div
          ref={panelAnchorRef}
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-0 h-px w-px opacity-0"
        />
        <div
          className={`${showCompactCard ? "hidden" : "absolute"} right-0 top-0 z-30 max-w-full p-3`}
        >
          <button
            type="button"
            onClick={() => setMode("expanded")}
            aria-label="Expand Build activity"
            title="Expand Build activity"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-foreground-secondary shadow-lg shadow-black/20 transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <FileCode2 className="h-4 w-4" />
          </button>
        </div>
        <div
          className={`${showCompactCard ? "absolute" : "hidden"} right-0 top-0 z-30 max-w-full p-3`}
        >
          <div className="w-[300px] max-w-full overflow-hidden rounded-xl border border-border bg-surface shadow-lg shadow-black/20">
            <BuildPanelHeader
              title={title}
              activity={resolved}
              view={view}
              setView={setView}
              jobs={resolved?.jobs ?? []}
              selectedJobId={resolved?.selectedJobId}
              onJobSelect={onJobSelect}
              onClose={() => setMode("hidden")}
            />
            <button
              type="button"
              onClick={() => setMode("expanded")}
              aria-label="Expand Build activity"
              className="flex min-h-[92px] w-full items-start gap-3 border-t border-border px-3 py-3 text-left transition-colors hover:bg-surface-hover/60"
            >
              <BuildSummary activity={resolved} view={view} />
              <span className="mt-1 text-xs text-faint">Open</span>
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize Build activity panel"
        aria-orientation="vertical"
        aria-valuemin={MIN_BUILD_PANEL_WIDTH}
        aria-valuemax={maxExpandedWidth}
        aria-valuenow={renderedExpandedWidth}
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onLostPointerCapture={() => {
          resizeStartRef.current = null;
          setIsResizing(false);
        }}
        className={`hidden w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center lg:flex ${isResizing ? "select-none" : ""}`}
      >
        <span className="w-px bg-border transition-colors hover:bg-accent" />
      </div>
      <aside
        ref={panelRef}
        aria-label="Build activity"
        style={{ width: `${renderedExpandedWidth}px` }}
        className={`my-3 mr-3 flex min-h-0 max-w-full shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg shadow-black/20 ${className}`}
      >
        <BuildPanelHeader
          title={title}
          activity={resolved}
          view={view}
          setView={setView}
          jobs={resolved?.jobs ?? []}
          selectedJobId={resolved?.selectedJobId}
          onJobSelect={onJobSelect}
          onMinimize={() => setMode("compact")}
          onClose={() => setMode("hidden")}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <BuildDetails
            activity={resolved}
            view={view}
            onAttention={onAttention}
          />
        </div>
      </aside>
    </>
  );
}

function BuildPanelHeader({
  title,
  activity,
  view,
  setView,
  jobs,
  selectedJobId,
  onJobSelect,
  onMinimize,
  onClose
}: {
  title: string;
  activity: BuildActivity | null;
  view: BuildViewMode;
  setView: (view: BuildViewMode) => void;
  jobs: NonNullable<BuildActivity>["jobs"];
  selectedJobId?: string;
  onJobSelect?: (jobId: string) => void;
  onMinimize?: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2
            className="flex items-center text-foreground"
            aria-label="Build"
            title="Build"
          >
            <Hammer className="h-4 w-4" aria-hidden="true" />
          </h2>
          {activity?.source === "demo" && (
            <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
              Demo
            </span>
          )}
        </div>
        <p className="truncate text-xs text-subtle">{title}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {jobs && jobs.length > 1 && (
          <label className="sr-only" htmlFor="build-job-history">
            Select Job history
          </label>
        )}
        {jobs && jobs.length > 1 && (
          <select
            id="build-job-history"
            aria-label="Select Job history"
            value={selectedJobId ?? jobs[0]?.id ?? ""}
            onChange={(event) => onJobSelect?.(event.currentTarget.value)}
            className="max-w-32 rounded-md border border-border bg-background px-1.5 py-1 text-[10px] text-foreground-secondary"
          >
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
              </option>
            ))}
          </select>
        )}
        <BuildViewToggle view={view} setView={setView} />
        {onMinimize && (
          <button
            type="button"
            onClick={onMinimize}
            aria-label="Minimize Build activity"
            title="Minimize Build activity"
            className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
          >
            <Minimize2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Build activity"
          title="Close Build activity"
          className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function BuildViewToggle({
  view,
  setView
}: {
  view: BuildViewMode;
  setView: (view: BuildViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-border bg-background p-0.5 text-[10px]">
      {(["story", "advanced"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setView(option)}
          aria-pressed={view === option}
          className={`rounded-full px-1.5 py-0.5 font-medium capitalize transition-colors ${
            view === option
              ? "bg-surface-hover text-foreground"
              : "text-subtle hover:text-foreground-secondary"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function BuildSummary({
  activity,
  view
}: {
  activity: BuildActivity | null;
  view: BuildViewMode;
}) {
  const state = activity?.state ?? "unknown";
  const latestStory = storyEvents(activity).at(-1)?.story;
  const latestTechnical = technicalEvents(activity).at(-1)?.technical;
  const totals = observedBuildTotals(activity);
  const advancedSummary = latestTechnical?.branch
    ? latestTechnical.branch
    : latestTechnical?.status
      ? `Status observed: ${latestTechnical.status}`
      : totals.filesChanged !== null
        ? `${totals.filesChanged} files reported`
        : "No technical details reported";
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[state]}`}
        />
        <span className="text-xs font-medium text-foreground-secondary">
          {activityStateLabel(state)}
        </span>
      </div>
      <p className="mt-2 text-sm text-foreground">
        {view === "story"
          ? (latestStory?.title ?? "No build activity reported")
          : (latestTechnical?.branch ?? "Technical activity")}
      </p>
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-subtle">
        {view === "story"
          ? (latestStory?.outcome ??
            latestStory?.detail ??
            emptyActivityCopy(activity))
          : advancedSummary}
      </p>
    </div>
  );
}

function BuildDetails({
  activity,
  view,
  onAttention
}: {
  activity: BuildActivity | null;
  view: BuildViewMode;
  onAttention?: (runtimeItemId: string) => void;
}) {
  return view === "story" ? (
    <StoryDetails activity={activity} onAttention={onAttention} />
  ) : (
    <AdvancedDetails activity={activity} />
  );
}

function ActivityHeader({ activity }: { activity: BuildActivity }) {
  const state = activity.state;
  return (
    <div className="mb-4 space-y-2 border-b border-border pb-3">
      <div className="flex items-center gap-2 text-xs text-foreground-secondary">
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[state]}`} />
        {activityStateLabel(state)}
        {activity.source === "live" && (
          <span className="text-subtle">Live activity</span>
        )}
        {activity.source === "demo" && (
          <span className="text-warning">Local simulation</span>
        )}
      </div>
      {activity.project?.name && (
        <p className="text-xs text-subtle">Project: {activity.project.name}</p>
      )}
    </div>
  );
}

function StoryDetails({
  activity,
  onAttention
}: {
  activity: BuildActivity | null;
  onAttention?: (runtimeItemId: string) => void;
}) {
  if (!activity) return <EmptyActivity />;
  const events = storyEvents(activity);
  const attention = [...events].reverse().find((event) => event.attention);
  return (
    <>
      <ActivityHeader activity={activity} />
      {attention?.attention ? (
        <button
          type="button"
          onClick={() => onAttention?.(attention.attention!.runtimeItemId)}
          className="mb-4 flex w-full items-center justify-between rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-left text-sm font-semibold text-warning"
        >
          <span>Needs your input</span>
          <span className="text-xs font-medium">Open existing request</span>
        </button>
      ) : null}
      {events.length === 0 ? (
        <EmptyActivity />
      ) : (
        <ol className="space-y-4">
          {events.map((event, index) => (
            <StoryEvent
              key={event.id}
              event={event}
              latest={index === events.length - 1}
            />
          ))}
        </ol>
      )}
    </>
  );
}

function StoryEvent({
  event,
  latest
}: {
  event: BuildActivityEvent;
  latest: boolean;
}) {
  const [open, setOpen] = useState(latest);
  const story = event.story;
  if (!story) return null;
  const state =
    event.state ??
    (event.kind === "failed"
      ? "failed"
      : event.kind === "blocked"
        ? "blocked"
        : event.kind === "completed"
          ? "completed"
          : "running");
  const stateClass =
    state === "failed"
      ? "bg-danger/15 text-danger"
      : state === "blocked"
        ? "bg-warning/15 text-warning"
        : state === "running"
          ? "bg-accent/15 text-accent"
          : "bg-success/15 text-success";
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2.5 text-left"
        aria-expanded={open}
      >
        <span
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${stateClass}`}
        >
          {state === "failed" || state === "blocked" ? (
            <CircleAlert className="h-2.5 w-2.5" />
          ) : state === "running" ? (
            <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Check className="h-2.5 w-2.5" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-foreground-secondary">
            {story.title}
          </span>
          {story.outcome && (
            <span
              className={`mt-0.5 block text-xs ${
                state === "failed"
                  ? "text-danger"
                  : state === "blocked"
                    ? "text-warning"
                    : state === "running"
                      ? "text-accent"
                      : "text-success"
              }`}
            >
              {story.outcome}
            </span>
          )}
        </span>
        <ChevronDown
          className={`mt-1 h-3.5 w-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && story.detail && (
        <p className="ml-7 mt-2 rounded-lg bg-surface-hover/60 px-3 py-2.5 text-xs leading-relaxed text-subtle">
          {story.detail}
        </p>
      )}
    </li>
  );
}

function AdvancedDetails({ activity }: { activity: BuildActivity | null }) {
  if (!activity) return <EmptyAdvancedActivity />;
  const events = technicalEvents(activity);
  const totals = observedBuildTotals(activity);
  return (
    <>
      <ActivityHeader activity={activity} />
      <div className="mb-4 space-y-2 text-xs text-foreground-secondary">
        {activity.project?.branch && (
          <div className="flex items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 text-subtle" />
            <span className="font-mono">{activity.project.branch}</span>
          </div>
        )}
        {activity.project?.status && (
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-subtle" />
            <span>Status observed: {activity.project.status}</span>
          </div>
        )}
        {(totals.filesChanged !== null ||
          totals.additions !== null ||
          totals.deletions !== null) && (
          <p className="font-mono text-subtle">
            {totals.filesChanged !== null
              ? `${totals.filesChanged} files reported`
              : "Files reported: unknown"}
            {totals.additions !== null && ` · +${totals.additions}`}
            {totals.deletions !== null && ` · -${totals.deletions}`}
          </p>
        )}
      </div>
      {events.length === 0 ? (
        <EmptyAdvancedActivity />
      ) : (
        <ul className="space-y-2">
          {events.map((event) => (
            <AdvancedEvent key={event.id} event={event} />
          ))}
        </ul>
      )}
    </>
  );
}

function AdvancedEvent({ event }: { event: BuildActivityEvent }) {
  const technical = event.technical;
  if (!technical) return null;
  return (
    <li className="rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-start gap-2">
        <FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
        <div className="min-w-0 flex-1">
          {technical.branch && (
            <p className="font-mono text-[11px] text-subtle">
              {technical.branch}
            </p>
          )}
          {technical.status && (
            <p className="text-xs text-foreground-secondary">
              Status observed: {technical.status}
            </p>
          )}
          {technical.command && (
            <code className="mt-1 block break-all text-[11px] text-muted">
              $ {technical.command}
            </code>
          )}
          {technical.files?.length ? (
            <ul className="mt-2 space-y-1">
              {technical.files.map((file) => (
                <li
                  key={`${event.id}-${file.path}`}
                  className="flex items-center justify-between gap-2 font-mono text-[11px]"
                >
                  <span className="min-w-0 truncate text-foreground-secondary">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-subtle">{file.change}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[11px] text-subtle">
              No file paths reported for this event.
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function EmptyActivity() {
  return (
    <p className="text-sm leading-relaxed text-subtle">
      No build activity has been reported yet.
    </p>
  );
}

function EmptyAdvancedActivity() {
  return (
    <p className="text-sm leading-relaxed text-subtle">
      No verified technical details have been reported yet.
    </p>
  );
}

function emptyActivityCopy(activity: BuildActivity | null) {
  if (!activity) return "This standalone chat has no execution activity yet.";
  if (activity.source === "live")
    return "Waiting for verified execution events.";
  return "This demo has no sample activity for the current chat.";
}
