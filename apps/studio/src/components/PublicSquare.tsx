"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock3,
  LoaderCircle,
  Lock,
  RotateCw,
  Share2,
  Trash2
} from "lucide-react";
import { initialsFor, teamTone } from "@/lib/identity";
import {
  publicSquareBriefEditorValue,
  publicSquareConnectableLocalProjects,
  publicSquareNeedsOwnerDraft,
  publicSquareStatusLabel,
  publicSquareVisibleBrief,
  publicSquareVisibleItems,
  type PublicSquareProject,
  type PublicSquareProjectConnection,
  type PublicSquarePublication
} from "@/lib/public-square";
import { PublicSquareRequestError } from "@/lib/public-square-client";
import { TeamAgentOffers } from "@/components/TeamAgentOffers";
import { PublicSquareView } from "@/components/PublicSquareView";
import { buildPublicSquareModel } from "@/lib/public-square-view";
import type { TeamAgentRequestsClient } from "@/lib/team-agent-requests-client";

type FeedState = "loading" | "ready" | "unavailable" | "access-lost";

export function PublicSquare({
  teamName,
  teamId,
  viewerId,
  focusJobId = null,
  authorityKey,
  agentOfferRevision,
  agentRequestsClient,
  items,
  idleAgents = [],
  projects = [],
  localProjects = [],
  loadingLocalProjects = false,
  ownerBriefDrafts = {},
  connections = {},
  state,
  error,
  serverTime,
  refreshing = false,
  hasMore = false,
  loadingMore = false,
  onRetry,
  onLoadMore,
  onShareBrief,
  onWithdrawBrief,
  onRemoveRetainedBrief,
  onConnectProject,
  canUnshareProjects = false,
  onUnshareProject,
  onRequestBriefDraft,
  onOpenInbox,
  onOpenOwnerConversation
}: {
  teamName: string;
  teamId: string;
  viewerId: string;
  focusJobId?: string | null;
  authorityKey: string;
  agentOfferRevision: number;
  agentRequestsClient: TeamAgentRequestsClient;
  items: PublicSquarePublication[];
  idleAgents?: {
    agentId: string;
    agentName: string;
    ownerId: string;
    ownerName: string;
  }[];
  projects?: PublicSquareProject[];
  localProjects?: PublicSquareProject[];
  loadingLocalProjects?: boolean;
  /** These values come from the owner-only brief-draft endpoint. */
  ownerBriefDrafts?: Record<string, string>;
  connections?: Record<string, PublicSquareProjectConnection>;
  state: FeedState;
  error?: string | null;
  serverTime?: string;
  refreshing?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onRetry?: () => void;
  onLoadMore?: () => void;
  onShareBrief?: (
    publicationId: string,
    brief: string,
    expectedVersion: number
  ) => Promise<void> | void;
  onWithdrawBrief?: (
    publicationId: string,
    expectedVersion: number
  ) => Promise<void> | void;
  onRemoveRetainedBrief?: (
    publicationId: string,
    expectedVersion: number
  ) => Promise<void> | void;
  onConnectProject?: (
    teamProjectId: string,
    localProjectId: string | null,
    expectedVersion: number
  ) => Promise<void> | void;
  canUnshareProjects?: boolean;
  onUnshareProject?: (teamProjectId: string) => Promise<void> | void;
  onRequestBriefDraft?: (publicationId: string) => Promise<void> | void;
  onOpenInbox?: () => void;
  onOpenOwnerConversation?: (item: PublicSquarePublication) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [withdrawnIds, setWithdrawnIds] = useState<Set<string>>(
    () => new Set()
  );
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<
    Record<string, string>
  >({});
  const [unsharedProjectIds, setUnsharedProjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const [verificationPendingIds, setVerificationPendingIds] = useState<
    Set<string>
  >(() => new Set());
  const [rejectedVerificationIds, setRejectedVerificationIds] = useState<
    Set<string>
  >(() => new Set());
  const [offersExpanded, setOffersExpanded] = useState(false);
  const focusLoad = useRef<{ jobId: string | null; pages: number }>({
    jobId: null,
    pages: 0
  });
  const previousServerTime = useRef(serverTime);
  const visibleItems = publicSquareVisibleItems(items, unsharedProjectIds);
  const connectableLocalProjects =
    publicSquareConnectableLocalProjects(localProjects);
  const square = buildPublicSquareModel({
    items: visibleItems,
    projects: projects.filter((project) => !unsharedProjectIds.has(project.id)),
    viewerId
  });

  const reconcileRejectedRead = useCallback(
    (
      verified: ReadonlySet<string>,
      currentItems: PublicSquarePublication[]
    ) => {
      setVerificationPendingIds(
        (current) => new Set([...current].filter((id) => !verified.has(id)))
      );
      setWithdrawnIds((current) => {
        const next = new Set(current);
        for (const item of currentItems)
          if (verified.has(`brief:${item.id}`)) next.delete(item.id);
        return next;
      });
      setUnsharedProjectIds((current) => {
        const next = new Set(current);
        for (const item of currentItems)
          if (verified.has(`project:${item.projectId}`))
            next.delete(item.projectId);
        return next;
      });
      setRejectedVerificationIds(new Set());
    },
    []
  );

  useEffect(() => {
    if (!serverTime || previousServerTime.current === serverTime) return;
    previousServerTime.current = serverTime;
    if (rejectedVerificationIds.size === 0) return;
    // This is the authoritative-read confirmation required before restoring hidden content.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reconcileRejectedRead(rejectedVerificationIds, items);
  }, [items, reconcileRejectedRead, rejectedVerificationIds, serverTime]);

  useEffect(() => {
    if (!focusJobId || state !== "ready") return;
    if (focusLoad.current.jobId !== focusJobId)
      focusLoad.current = { jobId: focusJobId, pages: 0 };
    const publication = visibleItems.find((item) => item.jobId === focusJobId);
    if (!publication) {
      if (
        hasMore &&
        !loadingMore &&
        !error &&
        onLoadMore &&
        focusLoad.current.pages < 10
      ) {
        focusLoad.current.pages += 1;
        onLoadMore();
      }
      return;
    }
    // This follows an explicit focusJobId request after the paginated feed resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedIds((current) =>
      current.has(publication.id)
        ? current
        : new Set(current).add(publication.id)
    );
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(publicSquareJobAnchor(focusJobId))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    error,
    focusJobId,
    hasMore,
    loadingMore,
    onLoadMore,
    state,
    visibleItems
  ]);

  const toggle = (id: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleBrief = (item: PublicSquarePublication) => {
    const opening = !expandedIds.has(item.id);
    toggle(item.id);
    if (
      opening &&
      publicSquareNeedsOwnerDraft(item, ownerBriefDrafts[item.id]) &&
      onRequestBriefDraft
    ) {
      void Promise.resolve(onRequestBriefDraft(item.id)).catch((failure) => {
        setActionError(
          failure instanceof Error
            ? failure.message
            : "The private brief draft could not be loaded."
        );
      });
    }
  };
  const setPending = (id: string, pending: boolean) =>
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  const perform = async (id: string, action: () => Promise<void> | void) => {
    setActionError(null);
    setPending(id, true);
    try {
      await action();
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "The brief could not be updated."
      );
    } finally {
      setPending(id, false);
    }
  };

  const renderPublication = (item: PublicSquarePublication) => {
    const ownerExecutionId =
      (item as PublicSquarePublication & { ownerExecutionId?: string | null })
        .ownerExecutionId ?? null;
    return (
      <div className="space-y-2">
        <PublicationCard
          key={item.id}
          item={item}
          anchorId={publicSquareJobAnchor(item.jobId)}
          brief={publicSquareVisibleBrief(item, withdrawnIds)}
          expanded={expandedIds.has(item.id)}
          draft={publicSquareBriefEditorValue(
            item,
            drafts[item.id],
            ownerBriefDrafts[item.id]
          )}
          pending={pendingIds.has(item.id)}
          onToggle={() => toggleBrief(item)}
          onDraftChange={(value) =>
            setDrafts((current) => ({ ...current, [item.id]: value }))
          }
          onShare={() =>
            perform(item.id, async () => {
              const brief = publicSquareBriefEditorValue(
                item,
                drafts[item.id],
                ownerBriefDrafts[item.id]
              ).trim();
              if (!brief) throw new Error("Add a short brief before sharing.");
              await onShareBrief?.(item.id, brief, item.version);
              setWithdrawnIds((current) => {
                const next = new Set(current);
                next.delete(item.id);
                return next;
              });
            })
          }
          onWithdraw={() => {
            setRejectedVerificationIds((current) => {
              const next = new Set(current);
              next.delete(`brief:${item.id}`);
              return next;
            });
            setWithdrawnIds((current) => new Set(current).add(item.id));
            void perform(item.id, async () => {
              try {
                await onWithdrawBrief?.(item.id, item.version);
              } catch (failure) {
                const key = `brief:${item.id}`;
                setVerificationPendingIds((current) =>
                  new Set(current).add(key)
                );
                if (isExplicitWriteRejection(failure))
                  setRejectedVerificationIds((current) =>
                    new Set(current).add(key)
                  );
                if (
                  !(
                    failure instanceof PublicSquareRequestError &&
                    [401, 403].includes(failure.status)
                  )
                )
                  void onRetry?.();
                throw failure;
              }
              setDrafts((current) => ({ ...current, [item.id]: "" }));
            });
          }}
          onRemoveRetained={() =>
            perform(item.id, async () => {
              try {
                await onRemoveRetainedBrief?.(item.id, item.version);
              } catch (failure) {
                const key = `brief:${item.id}`;
                setVerificationPendingIds((current) =>
                  new Set(current).add(key)
                );
                if (isExplicitWriteRejection(failure))
                  setRejectedVerificationIds((current) =>
                    new Set(current).add(key)
                  );
                if (
                  !(
                    failure instanceof PublicSquareRequestError &&
                    [401, 403].includes(failure.status)
                  )
                )
                  void onRetry?.();
                throw failure;
              }
              setWithdrawnIds((current) => new Set(current).add(item.id));
            })
          }
        />
        {viewerId === item.ownerId &&
          ownerExecutionId &&
          onOpenOwnerConversation && (
            <button
              type="button"
              onClick={() => onOpenOwnerConversation(item)}
              className="rounded-md bg-chip px-3 py-1.5 text-xs font-medium text-chip-foreground hover:bg-chip-hover"
            >
              Open workshop
            </button>
          )}
      </div>
    );
  };

  const renderProjectActions = (project: PublicSquareProject) => (
    <ProjectHeading
      projectId={project.id}
      projectName={project.name}
      count={
        square.jobs.filter((job) => job.publication.projectId === project.id)
          .length
      }
      connection={connections[project.id] ?? null}
      localProjects={connectableLocalProjects}
      loadingLocalProjects={loadingLocalProjects}
      selectedProjectId={
        selectedProjectIds[project.id] ??
        connections[project.id]?.localProjectId ??
        ""
      }
      pending={
        pendingIds.has(`connection:${project.id}`) ||
        pendingIds.has(`unshare:${project.id}`)
      }
      onSelectProject={(localProjectId) =>
        setSelectedProjectIds((current) => ({
          ...current,
          [project.id]: localProjectId
        }))
      }
      onConnect={(localProjectId) =>
        perform(`connection:${project.id}`, async () => {
          await onConnectProject?.(
            project.id,
            localProjectId,
            connections[project.id]?.version ?? 0
          );
        })
      }
      canUnshare={canUnshareProjects}
      onUnshare={() => {
        setRejectedVerificationIds((current) => {
          const next = new Set(current);
          next.delete(`project:${project.id}`);
          return next;
        });
        setUnsharedProjectIds((current) => new Set(current).add(project.id));
        void perform(`unshare:${project.id}`, async () => {
          try {
            await onUnshareProject?.(project.id);
          } catch (failure) {
            const key = `project:${project.id}`;
            setVerificationPendingIds((current) => new Set(current).add(key));
            if (isExplicitWriteRejection(failure))
              setRejectedVerificationIds((current) =>
                new Set(current).add(key)
              );
            if (
              !(
                failure instanceof PublicSquareRequestError &&
                [401, 403].includes(failure.status)
              )
            )
              void onRetry?.();
            throw failure;
          }
        });
      }}
    />
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 pb-8 pt-4 sm:px-6">
      {state === "loading" && (
        <StatusPanel label="Loading Team work…" loading />
      )}
      {state === "access-lost" && (
        <StatusPanel
          label="Team access changed. Refresh to check your access."
          error
          onRetry={onRetry}
        />
      )}
      {state === "unavailable" && (
        <StatusPanel
          label={error || "Public Square is unavailable right now."}
          error
          onRetry={onRetry}
        />
      )}
      {state === "ready" && (
        <>
          <section className="space-y-3">
            <button
              type="button"
              aria-expanded={offersExpanded}
              onClick={() => setOffersExpanded((expanded) => !expanded)}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted transition hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {offersExpanded ? (
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              Make an Agent available
            </button>
            {offersExpanded && (
              <TeamAgentOffers
                teamId={teamId}
                authorityKey={authorityKey}
                refreshRevision={agentOfferRevision}
                client={agentRequestsClient}
              />
            )}
          </section>
          <PublicSquareView
            teamName={teamName}
            viewerId={viewerId}
            jobs={square.jobs}
            rooms={square.rooms}
            idleAgents={idleAgents}
            historicalItems={square.historicalItems}
            serverTime={serverTime}
            focusJobId={focusJobId}
            getVisibleBrief={(item) =>
              publicSquareVisibleBrief(item, withdrawnIds)
            }
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={onLoadMore}
            onOpenInbox={onOpenInbox}
            renderPublication={renderPublication}
            renderProjectActions={renderProjectActions}
          />
          {refreshing && (
            <p role="status" className="text-[11px] text-faint">
              Updating Team work…
            </p>
          )}
          {actionError && (
            <p
              role="alert"
              className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger"
            >
              {actionError}
            </p>
          )}
          {verificationPendingIds.size > 0 && (
            <p role="status" className="text-[11px] text-warning">
              Checking the latest Team state. Hidden details stay closed until
              access is confirmed.
            </p>
          )}
          {hasMore && (
            <div className="flex justify-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={onLoadMore}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-xs font-medium text-subtle transition-colors hover:bg-surface-hover disabled:opacity-60"
              >
                {loadingMore && (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                )}
                {loadingMore ? "Loading history…" : "Load more history"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProjectHeading({
  projectId,
  projectName,
  count,
  connection,
  localProjects,
  loadingLocalProjects,
  selectedProjectId,
  pending,
  canUnshare,
  onSelectProject,
  onConnect,
  onUnshare
}: {
  projectId: string;
  projectName: string;
  count: number;
  connection: PublicSquareProjectConnection;
  localProjects: PublicSquareProject[];
  loadingLocalProjects: boolean;
  selectedProjectId: string;
  pending: boolean;
  canUnshare: boolean;
  onSelectProject: (projectId: string) => void;
  onConnect: (localProjectId: string | null) => void;
  onUnshare: () => void;
}) {
  const tone = teamTone(projectName);
  const connectedProject = connection?.localProjectId
    ? localProjects.find((project) => project.id === connection.localProjectId)
    : null;
  const selectedChanged =
    selectedProjectId !== (connection?.localProjectId ?? "");
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2.5 px-1">
      <span
        className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${tone.solid}`}
      >
        {initialsFor(projectName)}
      </span>
      <h2 className="text-sm font-medium text-foreground">{projectName}</h2>
      <span className="text-[11px] text-faint">
        {count} {count === 1 ? "job" : "jobs"}
      </span>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {connectedProject && !selectedChanged && (
          <span
            className="max-w-40 truncate text-[10px] text-faint"
            title={`Connected to ${connectedProject.name}`}
          >
            Connected: {connectedProject.name}
          </span>
        )}
        {connection?.localProjectId && !connectedProject && (
          <span className="text-[10px] text-warning">
            Connected Project unavailable
          </span>
        )}
        {loadingLocalProjects ? (
          <span className="text-[10px] text-faint">Loading Projects…</span>
        ) : localProjects.length > 0 ? (
          <>
            <label className="sr-only" htmlFor={`connect-project-${projectId}`}>
              Local Project for {projectName}
            </label>
            <select
              id={`connect-project-${projectId}`}
              value={selectedProjectId}
              onChange={(event) => onSelectProject(event.target.value)}
              className="max-w-40 rounded-md border border-border bg-background px-2 py-1.5 text-[10px] text-subtle focus:outline-none focus:ring-1 focus:ring-accent/50"
            >
              <option value="">Choose a local Project</option>
              {localProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={
                pending ||
                (!selectedChanged && Boolean(connection?.localProjectId)) ||
                !selectedProjectId
              }
              onClick={() => onConnect(selectedProjectId || null)}
              className="rounded-md border border-border px-2.5 py-1.5 text-[10px] font-medium text-subtle hover:bg-surface-hover disabled:opacity-45"
            >
              {pending
                ? "Connecting…"
                : connection?.localProjectId
                  ? "Change"
                  : "Connect"}
            </button>
            {connection?.localProjectId && (
              <button
                type="button"
                disabled={pending}
                onClick={() => onConnect(null)}
                className="rounded-md px-2 py-1.5 text-[10px] text-faint hover:bg-surface-hover hover:text-subtle disabled:opacity-45"
              >
                Disconnect
              </button>
            )}
          </>
        ) : (
          <span className="text-[10px] text-faint">
            No registered local Projects
          </span>
        )}
        {canUnshare && (
          <button
            type="button"
            disabled={pending}
            onClick={onUnshare}
            className="rounded-md px-2 py-1.5 text-[10px] text-danger/80 hover:bg-danger/5 hover:text-danger disabled:opacity-45"
          >
            Unshare Project
          </button>
        )}
      </div>
    </div>
  );
}

function PublicationCard({
  item,
  anchorId,
  brief,
  expanded,
  draft,
  pending,
  onToggle,
  onDraftChange,
  onShare,
  onWithdraw,
  onRemoveRetained
}: {
  item: PublicSquarePublication;
  anchorId: string;
  brief: string | null;
  expanded: boolean;
  draft: string;
  pending: boolean;
  onToggle: () => void;
  onDraftChange: (value: string) => void;
  onShare: () => void;
  onWithdraw: () => void;
  onRemoveRetained: () => void;
}) {
  const offline = /^(offline|disconnected)$/i.test(item.status);
  const visibleStatus =
    offline && item.lastKnownStatus ? item.lastKnownStatus : item.status;
  const hasDetails = Boolean(
    brief ||
    item.canEditBrief ||
    (item.ownerLeftTeam && item.canRemoveRetainedBrief)
  );
  const time = item.completedAt
    ? `Completed ${formatTime(item.completedAt)}`
    : item.lastSeenAt
      ? `Last seen ${formatTime(item.lastSeenAt)}`
      : item.startedAt
        ? `Started ${formatTime(item.startedAt)}`
        : `Shared ${formatTime(item.publishedAt)}`;

  return (
    <article
      id={anchorId}
      className={`relative overflow-hidden rounded-xl border p-4 transition-colors ${offline ? "border-border/70 bg-surface/20" : "border-border/80 bg-surface/40 hover:border-border-strong"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {item.agentName}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-faint">
            {item.projectName}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/40 px-2 py-1 text-[10px] text-subtle">
          <span
            className={`h-1.5 w-1.5 rounded-full ${offline ? "bg-faint" : /^(running|working|in_progress)$/i.test(item.status) ? "bg-accent" : /^(waiting|blocked|needs_input)$/i.test(item.status) ? "bg-danger" : "bg-faint"}`}
          />
          {publicSquareStatusLabel(visibleStatus)}
          {offline && " · offline"}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={`inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2 py-1 text-[10px] font-medium ${teamTone(item.ownerId).chip}`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${teamTone(item.ownerId).solid}`}
          />
          <span className="truncate">{item.ownerName}</span>
        </span>
        {item.ownerLeftTeam && (
          <span className="text-[10px] text-faint">former member</span>
        )}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[10px] text-faint">
        <Clock3 className="h-3 w-3 shrink-0" />
        {time}
      </p>
      {!brief && !item.canEditBrief && (
        <p className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-2 text-[11px] text-faint">
          <Lock className="h-3 w-3 shrink-0" />
          Details not shared
        </p>
      )}
      {hasDetails && (
        <div className="mt-3 border-t border-border/60 pt-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-subtle hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {brief
              ? "Shared brief"
              : item.canEditBrief
                ? "Prepare a brief"
                : "Retained brief"}
          </button>
          {expanded && (
            <div className="mt-2 space-y-2">
              {item.canEditBrief ? (
                <>
                  <label className="block">
                    <span className="sr-only">Brief for {item.agentName}</span>
                    <textarea
                      value={draft}
                      onChange={(event) => onDraftChange(event.target.value)}
                      rows={4}
                      maxLength={1000}
                      placeholder="What the work is for, and how the agent should approach it."
                      className="w-full resize-y rounded-lg border border-border bg-background/70 px-3 py-2 text-xs leading-relaxed text-foreground placeholder:text-faint focus:border-accent/50 focus:outline-none"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={pending || !draft.trim()}
                      onClick={onShare}
                      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-[10px] font-medium text-white disabled:opacity-50"
                    >
                      <Share2 className="h-3 w-3" />
                      {brief ? "Update shared brief" : "Share with this Team"}
                    </button>
                    {brief && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={onWithdraw}
                        className="rounded-md border border-border px-2.5 py-1.5 text-[10px] font-medium text-subtle hover:bg-surface-hover disabled:opacity-50"
                      >
                        Withdraw brief
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-faint">
                    Only this Team can see the brief. You control sharing for
                    each Team separately.
                  </p>
                </>
              ) : brief ? (
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-subtle">
                  {brief}
                </p>
              ) : (
                <p className="text-xs text-faint">No brief is shared.</p>
              )}
              {item.ownerLeftTeam && brief && (
                <p className="text-[10px] text-faint">
                  Retained by this Team after the owner left.
                </p>
              )}
              {item.ownerLeftTeam && item.canRemoveRetainedBrief && brief && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={onRemoveRetained}
                  className="inline-flex items-center gap-1.5 rounded-md border border-danger/25 px-2.5 py-1.5 text-[10px] font-medium text-danger hover:bg-danger/5 disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  Remove retained brief
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

const publicSquareJobAnchor = (jobId: string): string =>
  `public-square-job-${jobId}`;

function StatusPanel({
  label,
  loading = false,
  error = false,
  onRetry
}: {
  label: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  return (
    <section
      role={error ? "alert" : "status"}
      className="flex items-center gap-3 rounded-xl border border-border/70 bg-surface/30 px-4 py-4 text-sm text-subtle"
    >
      {loading ? (
        <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
      ) : error ? (
        <AlertCircle className="h-4 w-4 text-danger" />
      ) : null}
      <span className="flex-1">{label}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-surface-hover"
        >
          <RotateCw className="h-3 w-3" />
          Retry
        </button>
      )}
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function isExplicitWriteRejection(failure: unknown): boolean {
  return (
    failure instanceof PublicSquareRequestError &&
    failure.status >= 400 &&
    failure.status < 500 &&
    ![401, 403].includes(failure.status)
  );
}
