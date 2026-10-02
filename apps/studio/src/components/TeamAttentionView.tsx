"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  RefreshCw,
  RotateCcw
} from "lucide-react";
import type {
  TeamOverviewItem,
  TeamOverviewSnapshot
} from "@koed/shared/team-overview";
import type { TeamOverviewState } from "@/lib/use-team-overview";

export function TeamAttentionView({
  state,
  snapshot,
  refreshing,
  mutationError,
  pendingItemIds,
  selectedTeamId,
  onTeamChange,
  onRefresh,
  onOpen,
  onClear,
  onSeen,
  onLoadMore
}: {
  state: TeamOverviewState;
  snapshot: TeamOverviewSnapshot | null;
  refreshing: boolean;
  mutationError: string | null;
  pendingItemIds: ReadonlySet<string>;
  selectedTeamId: string;
  onTeamChange: (teamId: string) => void;
  onRefresh: () => void;
  onOpen: (item: TeamOverviewItem) => void;
  onClear: (item: TeamOverviewItem, cleared: boolean) => void;
  onSeen: (item: TeamOverviewItem) => boolean | Promise<boolean>;
  onLoadMore: () => void;
}) {
  const [seenThisVisit, setSeenThisVisit] = useState<{
    scope: string;
    items: Map<string, TeamOverviewItem>;
  } | null>(null);
  const offline = state === "offline";
  const teams = snapshot?.teams ?? [];
  const visitScope = snapshot
    ? `${snapshot.access.accountScope}:${snapshot.access.backendId ?? ""}:${teams
        .map((team) => team.teamId)
        .sort()
        .join(",")}`
    : "";
  const authorizedOutcomeRefs = useMemo(
    () => new Set(snapshot?.currentJobOutcomes.map(outcomeRefKey) ?? []),
    [snapshot?.currentJobOutcomes]
  );
  useEffect(() => {
    if (!seenThisVisit || seenThisVisit.scope === visitScope) return;
    // Forget cached summaries when account, backend, or Team authority changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeenThisVisit(null);
  }, [seenThisVisit, visitScope]);
  useEffect(() => {
    if (!snapshot || !seenThisVisit || seenThisVisit.scope !== visitScope)
      return;
    const retained = new Map(
      Array.from(seenThisVisit.items).filter(([, item]) =>
        authorizedOutcomeRefs.has(outcomeRefKey(item))
      )
    );
    if (retained.size !== seenThisVisit.items.size) {
      // Purge remembered summaries as soon as source authorization disappears.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSeenThisVisit({ ...seenThisVisit, items: retained });
    }
  }, [authorizedOutcomeRefs, seenThisVisit, snapshot, visitScope]);
  const matchesTeam = (item: TeamOverviewItem) =>
    effectiveTeamId === "all" || item.teamId === effectiveTeamId;
  const effectiveTeamId = teams.some((team) => team.teamId === selectedTeamId)
    ? selectedTeamId
    : "all";
  const attention = snapshot?.attention.filter(matchesTeam) ?? [];
  const snapshotCatchUp = snapshot?.catchUp ?? [];
  const catchUpById = new Map(
    snapshotCatchUp.map((item) => [item.sourceEventId, item])
  );
  for (const [id, item] of seenThisVisit?.scope === visitScope
    ? seenThisVisit.items
    : []) {
    if (
      !teams.some((team) => team.teamId === item.teamId) ||
      !authorizedOutcomeRefs.has(outcomeRefKey(item))
    )
      continue;
    if (!catchUpById.has(id)) catchUpById.set(id, item);
  }
  const catchUp = Array.from(catchUpById.values()).filter(matchesTeam);
  const cleared = snapshot?.cleared.filter(matchesTeam) ?? [];
  const blockers = attention.filter((item) => item.priority === "blocker");
  const waiting = attention.filter((item) => item.priority !== "blocker");
  const selectedBadgeCount =
    effectiveTeamId === "all"
      ? (snapshot?.badgeCount ?? 0)
      : (teams.find((team) => team.teamId === effectiveTeamId)?.badgeCount ??
        0);
  const catchUpGroups = groupCatchUp(catchUp);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 overflow-y-auto px-5 pb-12 pt-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight text-foreground">
            For you
          </h1>
          <p className="mt-1 text-sm text-subtle">
            Shared Team work that needs your attention.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-subtle hover:bg-surface-hover disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </header>

      {offline && snapshot && (
        <p
          role="status"
          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          Offline · may be out of date
        </p>
      )}
      {state === "unauthorized" && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" /> Team access changed.
          Refresh to check your access.
        </div>
      )}
      {state === "offline" && !snapshot && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-3 text-sm text-subtle"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" /> Team activity could not
          be reached.
        </div>
      )}
      {state === "loading" && !snapshot && (
        <p role="status" className="text-sm text-subtle">
          Loading Team activity…
        </p>
      )}
      {mutationError && (
        <p role="alert" className="text-sm text-danger">
          {mutationError}
        </p>
      )}

      {snapshot && (
        <>
          {teams.length > 1 && (
            <nav aria-label="Filter by Team" className="flex flex-wrap gap-1.5">
              <FilterChip
                active={effectiveTeamId === "all"}
                onClick={() => onTeamChange("all")}
              >
                All teams{" "}
                <span className="text-faint">{snapshot.badgeCount}</span>
              </FilterChip>
              {teams.map((team) => (
                <FilterChip
                  key={team.teamId}
                  active={effectiveTeamId === team.teamId}
                  onClick={() => onTeamChange(team.teamId)}
                >
                  {team.name}{" "}
                  <span className="text-faint">{team.badgeCount}</span>
                </FilterChip>
              ))}
            </nav>
          )}

          <p className="text-sm text-muted" aria-live="polite">
            {selectedBadgeCount === 0
              ? "Nothing is waiting on you."
              : selectedBadgeCount === 1
                ? "1 grouped item needs you."
                : `${selectedBadgeCount} grouped items need you.`}
          </p>

          {blockers.length > 0 && (
            <ItemSection
              title="Blocking work"
              items={blockers}
              emptyLabel="No blockers."
              pendingItemIds={pendingItemIds}
              canAct={state === "ready"}
              onOpen={onOpen}
              onClear={onClear}
            />
          )}
          {waiting.length > 0 && (
            <ItemSection
              title="Needs your attention"
              items={waiting}
              emptyLabel="Nothing else is waiting."
              pendingItemIds={pendingItemIds}
              canAct={state === "ready"}
              onOpen={onOpen}
              onClear={onClear}
            />
          )}
          {attention.length === 0 && selectedBadgeCount === 0 && (
            <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-border px-4 py-6 text-sm text-subtle">
              <Check className="h-4 w-4 shrink-0 text-success" /> You’re all
              caught up{effectiveTeamId === "all" ? " across your Teams" : ""}.
            </div>
          )}
          {attention.length === 0 &&
            selectedBadgeCount > 0 &&
            snapshot.nextCursor && (
              <p className="rounded-xl border border-border px-4 py-4 text-sm text-subtle">
                More items are available below. Load more to continue.
              </p>
            )}

          {catchUp.length > 0 && (
            <section aria-label="A few useful updates" className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-subtle">
                A few useful updates
              </h2>
              {catchUpGroups.map((group) => (
                <div key={group.key} className="space-y-1.5">
                  <h3 className="px-1 text-xs text-subtle">
                    {group.label}{" "}
                    <span className="text-faint">{group.items.length}</span>
                  </h3>
                  <div className="overflow-hidden rounded-xl border border-border/70">
                    <ItemRows
                      items={group.items}
                      pendingItemIds={pendingItemIds}
                      canAct={state === "ready"}
                      onOpen={onOpen}
                      onClear={onClear}
                      allowClear={false}
                      onSeen={
                        state === "ready"
                          ? (item) =>
                              Promise.resolve(onSeen(item)).then((accepted) => {
                                if (
                                  accepted &&
                                  authorizedOutcomeRefs.has(outcomeRefKey(item))
                                ) {
                                  setSeenThisVisit((current) => ({
                                    scope: visitScope,
                                    items: new Map(
                                      current?.scope === visitScope
                                        ? current.items
                                        : []
                                    ).set(item.sourceEventId, item)
                                  }));
                                }
                                return accepted;
                              })
                          : undefined
                      }
                      compact
                    />
                  </div>
                </div>
              ))}
            </section>
          )}

          {cleared.length > 0 && (
            <details className="rounded-xl border border-border/70">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm text-subtle">
                Cleared reminders{" "}
                <span className="ml-1 text-faint">{cleared.length}</span>
              </summary>
              <div className="border-t border-border/70 px-3">
                <ItemRows
                  items={cleared}
                  pendingItemIds={pendingItemIds}
                  canAct={state === "ready"}
                  onOpen={onOpen}
                  onClear={onClear}
                  cleared
                />
              </div>
            </details>
          )}
          {snapshot.nextCursor && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={refreshing || state !== "ready"}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm text-subtle hover:border-border-strong hover:text-foreground disabled:opacity-50"
            >
              {refreshing ? "Loading…" : "Load more Team activity"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function groupCatchUp(items: TeamOverviewItem[]) {
  const groups = new Map<
    string,
    { key: string; label: string; items: TeamOverviewItem[] }
  >();
  for (const item of items) {
    const destination = item.destination;
    const key =
      destination.kind === "team_job"
        ? `${item.teamId}:project:${destination.teamProjectId}`
        : destination.kind === "thread"
          ? `${item.teamId}:thread:${destination.threadId}`
          : `${item.teamId}:${destination.kind}:${item.sourceId}`;
    const label =
      destination.kind === "team_job"
        ? `${item.teamName} · Project updates`
        : destination.kind === "thread"
          ? `${item.teamName} · Conversation updates`
          : `${item.teamName} · ${typeLabel(item)} updates`;
    const current = groups.get(key);
    if (current) current.items.push(item);
    else groups.set(key, { key, label, items: [item] });
  }
  return Array.from(groups.values());
}

function ItemSection({
  title,
  items,
  emptyLabel,
  pendingItemIds,
  canAct,
  onOpen,
  onClear,
  onSeen,
  allowClear = true,
  compact = false
}: {
  title: string;
  items: TeamOverviewItem[];
  emptyLabel: string;
  pendingItemIds: ReadonlySet<string>;
  canAct: boolean;
  onOpen: (item: TeamOverviewItem) => void;
  onClear: (item: TeamOverviewItem, cleared: boolean) => void;
  onSeen?: (item: TeamOverviewItem) => boolean | Promise<boolean>;
  allowClear?: boolean;
  compact?: boolean;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-subtle">
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-faint">{emptyLabel}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/70">
          <ItemRows
            items={items}
            pendingItemIds={pendingItemIds}
            canAct={canAct}
            onOpen={onOpen}
            onClear={onClear}
            onSeen={onSeen}
            allowClear={allowClear}
            compact={compact}
          />
        </div>
      )}
    </section>
  );
}

function ItemRows({
  items,
  pendingItemIds,
  canAct,
  onOpen,
  onClear,
  onSeen,
  allowClear = true,
  cleared = false,
  compact = false
}: {
  items: TeamOverviewItem[];
  pendingItemIds: ReadonlySet<string>;
  canAct: boolean;
  onOpen: (item: TeamOverviewItem) => void;
  onClear: (item: TeamOverviewItem, cleared: boolean) => void;
  onSeen?: (item: TeamOverviewItem) => boolean | Promise<boolean>;
  allowClear?: boolean;
  cleared?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="divide-y divide-border/70">
      {items.map((item) => (
        <AttentionRow
          key={`${item.sourceEventId}:${item.sourceRevision}`}
          item={item}
          pending={pendingItemIds.has(item.sourceEventId)}
          canAct={canAct}
          cleared={cleared}
          compact={compact}
          onOpen={() => onOpen(item)}
          onClear={(next) => onClear(item, next)}
          onSeen={onSeen ? () => onSeen(item) : undefined}
          allowClear={allowClear}
        />
      ))}
    </div>
  );
}

function AttentionRow({
  item,
  pending,
  canAct,
  cleared,
  compact,
  onOpen,
  onClear,
  onSeen,
  allowClear
}: {
  item: TeamOverviewItem;
  pending: boolean;
  canAct: boolean;
  cleared: boolean;
  compact: boolean;
  onOpen: () => void;
  onClear: (cleared: boolean) => void;
  onSeen?: () => void | boolean | Promise<boolean>;
  allowClear: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const onSeenRef = useRef(onSeen);
  const intersectionRatio = useRef(0);
  const canObserve = Boolean(onSeen);
  useEffect(() => {
    onSeenRef.current = onSeen;
  }, [onSeen]);
  useEffect(() => {
    if (
      !canObserve ||
      !onSeenRef.current ||
      item.kind !== "job_outcome" ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let reported = false;
    let inFlight = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersectionRatio.current = entry?.isIntersecting
          ? entry.intersectionRatio
          : 0;
        maybeReport();
      },
      { threshold: [0.6] }
    );
    const maybeReport = () => {
      if (
        reported ||
        inFlight ||
        document.visibilityState !== "visible" ||
        intersectionRatio.current < 0.6
      )
        return;
      inFlight = true;
      Promise.resolve(onSeenRef.current?.()).then(
        (accepted) => {
          inFlight = false;
          if (accepted) {
            reported = true;
            observer.disconnect();
          }
        },
        () => {
          inFlight = false;
        }
      );
    };
    if (rowRef.current) observer.observe(rowRef.current);
    document.addEventListener("visibilitychange", maybeReport);
    window.addEventListener("focus", maybeReport);
    window.addEventListener("online", maybeReport);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", maybeReport);
      window.removeEventListener("focus", maybeReport);
      window.removeEventListener("online", maybeReport);
    };
  }, [canObserve, item.kind, item.sourceEventId, item.sourceRevision]);

  return (
    <div
      ref={rowRef}
      data-team-overview-event={item.sourceEventId}
      className={`flex items-start gap-3 px-4 ${compact ? "py-2.5" : "py-3.5"}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-faint">
          {item.teamName} · {typeLabel(item)}
        </p>
        <p className="mt-0.5 text-sm font-medium text-foreground">
          {item.title}
        </p>
        {item.summary && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-subtle">
            {item.summary}
          </p>
        )}
        {item.kind === "message" && (item.unreadCount ?? 0) > 0 && (
          <p className="mt-1 text-[11px] text-subtle">
            {item.unreadCount} unread{" "}
            {item.unreadCount === 1 ? "message" : "messages"} in this thread
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={!canAct}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
      >
        Open <ChevronRight className="h-3 w-3" />
      </button>
      {allowClear && (
        <button
          type="button"
          onClick={() => onClear(!cleared)}
          disabled={!canAct || pending}
          className="shrink-0 rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          aria-label={cleared ? "Restore reminder" : "Clear reminder"}
          title={cleared ? "Restore reminder" : "Clear reminder"}
        >
          {cleared ? (
            <RotateCcw className="h-3.5 w-3.5" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${active ? "border-border-strong bg-surface-hover text-foreground" : "border-border text-subtle hover:border-border-strong hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function typeLabel(item: TeamOverviewItem) {
  if (item.kind === "message") return "message thread";
  if (item.kind === "agent_request") return "Agent request";
  if (item.kind === "job_action") return "Agent job";
  if (item.kind === "job_outcome") return "Job outcome";
  return "Pull request";
}

function outcomeRefKey(ref: {
  teamId: string;
  sourceEventId: string;
  sourceRevision: string;
}) {
  return `${ref.teamId}:${ref.sourceEventId}:${ref.sourceRevision}`;
}
