"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import {
  Archive,
  Award,
  Copy,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Sparkles,
  X
} from "lucide-react";
import type { AgentDefinition, AgentStatus } from "@/lib/collab";
import { relativeTime } from "@/lib/collab";
import { AgentAvatarView } from "@/components/AgentAvatarView";
import { CreateAgentModal } from "@/components/CreateAgentModal";
import { Tooltip } from "@/components/Tooltip";
import { StudioSidebar } from "./StudioSidebar";
import {
  milestonesFor,
  moodExpression,
  relationshipNarrative,
  tenureTitle,
  withMoodExpression
} from "@/lib/agentRelationship";
import {
  agentEditorInitialValues,
  personalAgentsHttpAdapter,
  personalAgentRequestId,
  type PersonalAgent,
  type PersonalAgentJob,
  type PersonalAgentsApi,
  type PersonalAgentDraftScope,
  uniqueAgentCloneName
} from "@/lib/personal-agents-client";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import {
  filterAgentsByLifecycle,
  unknownActivityLabel,
  verifiedAgentWork,
  withoutVerifiedActivity,
  type AgentLifecycleFilter
} from "@/lib/agents-overview";

type ModalState =
  | {
      type: "create";
      initialValues?: ReturnType<typeof agentEditorInitialValues>;
      draftTarget: string;
    }
  | { type: "edit"; agent: PersonalAgent }
  | null;

type AgentCollectionView = "cards" | "list";

type AgentsViewProps = Readonly<{
  api?: PersonalAgentsApi;
  onHome?: () => void;
  onNewChat?: () => void;
  onGiveAJob?: (agent: PersonalAgent) => void;
  onOpenConversation?: (conversationId: string) => void;
  onPullRequests?: () => void;
  onPlugins?: () => void;
}>;

function toDefinition(agent: PersonalAgent): AgentDefinition {
  return {
    id: agent.id,
    ownerId: agent.ownerId,
    name: agent.name,
    role: agent.role,
    identity: agent.soul,
    createdAt: agent.createdAt,
    ...(agent.avatar ? { avatar: agent.avatar } : {})
  };
}

function avatarSpecForAgent(agent: PersonalAgent) {
  const spec = agent.avatar?.spec;
  if (!spec || !agent.activityLoaded || agent.stats?.projects === null)
    return spec;
  const activity: { status: AgentStatus }[] = agent.projects.flatMap(
    (project) =>
      project.status === "waiting" || project.status === "running"
        ? [{ status: project.status }]
        : []
  );
  if (agent.runningNow.length > 0) activity.push({ status: "running" });
  return withMoodExpression(spec, moodExpression(activity));
}

function statusLabel(status: string | null | undefined): string {
  if (status === "running") return "Working";
  if (status === "waiting") return "Waiting on owner";
  if (status === "queued") return "Queued";
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";
  if (status === "interrupted") return "Interrupted";
  if (status === "succeeded") return "Completed";
  return "Unknown";
}

function jobStatusLabel(status: string | null | undefined): string {
  return status === "running" ? "Running (last recorded)" : statusLabel(status);
}

function settingLabel(value: string | null | undefined): string {
  return value?.trim() || "Unknown";
}

function upsertAgent(
  agents: PersonalAgent[],
  next: PersonalAgent
): PersonalAgent[] {
  const index = agents.findIndex((agent) => agent.id === next.id);
  if (index < 0) return [next, ...agents];
  return agents.map((agent) => (agent.id === next.id ? next : agent));
}

function preserveActivity(
  previous: PersonalAgent | null,
  next: PersonalAgent
): PersonalAgent {
  if (!previous || previous.id !== next.id || next.activityLoaded) return next;
  return {
    ...next,
    projects: previous.projects,
    runningNow: previous.runningNow,
    runningJobsVerified: previous.runningJobsVerified,
    jobs: previous.jobs,
    highlights: previous.highlights,
    stats: previous.stats,
    jobsHasMore: previous.jobsHasMore,
    jobsNextCursor: previous.jobsNextCursor,
    activityLoaded: previous.activityLoaded
  };
}

export function AgentsView({
  api = personalAgentsHttpAdapter,
  onHome,
  onNewChat,
  onGiveAJob,
  onOpenConversation,
  onPullRequests,
  onPlugins
}: AgentsViewProps) {
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [capabilities, setCapabilities] = useState<AgentModelCapability[]>([]);
  const [draftScope, setDraftScope] = useState<PersonalAgentDraftScope | null>(
    null
  );
  const draftScopeRef = useRef<PersonalAgentDraftScope | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PersonalAgent | null>(
    null
  );
  const [modal, setModal] = useState<ModalState>(null);
  const [retireTarget, setRetireTarget] = useState<PersonalAgent | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [cloneLoadingId, setCloneLoadingId] = useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [collectionView, setCollectionView] =
    useState<AgentCollectionView>("cards");
  const [lifecycleFilter, setLifecycleFilter] =
    useState<AgentLifecycleFilter>("active");
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [activityErrors, setActivityErrors] = useState<Set<string>>(
    () => new Set()
  );
  const [clockNow, setClockNow] = useState(() => Date.now());
  const detailSequenceRef = useRef(0);
  const activityReadSequenceRef = useRef(new Map<string, number>());
  const collectionRevisionRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const agentCardRefs = useRef(new Map<string, HTMLButtonElement>());
  const mutationRequestRef = useRef<{ key: string; id: string } | null>(null);
  const retireRequestRef = useRef<{ id: string; requestId: string } | null>(
    null
  );

  const selectedDetailForSelection =
    selectedDetail?.id === selectedId ? selectedDetail : null;
  const selected =
    selectedDetailForSelection ??
    agents.find((agent) => agent.id === selectedId) ??
    null;
  const agentsRef = useRef(agents);
  const selectedIdRef = useRef(selectedId);
  useLayoutEffect(() => {
    agentsRef.current = agents;
    selectedIdRef.current = selectedId;
  }, [agents, selectedId]);

  useEffect(() => {
    if (!selected?.jobs.some((job) => job.state === "running" && job.startedAt))
      return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.jobs]);

  const closeDetail = useCallback(() => {
    const previousId = selectedId;
    setSelectedId(null);
    if (previousId) {
      window.requestAnimationFrame(() =>
        agentCardRefs.current.get(previousId)?.focus()
      );
    }
  }, [selectedId]);

  const markCollectionChanged = useCallback(() => {
    collectionRevisionRef.current += 1;
    setCollectionRevision(collectionRevisionRef.current);
  }, []);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoadState("loading");
      setError(null);
      try {
        const [agentsResult, capabilitiesResult, scopeResult] =
          await Promise.allSettled([
            api.list(signal),
            api.capabilities(signal),
            api.draftScope?.(signal) ??
              Promise.reject(new Error("Draft scope is unavailable."))
          ]);
        if (signal.aborted) return;
        if (agentsResult.status === "rejected") throw agentsResult.reason;
        markCollectionChanged();
        setAgents(agentsResult.value);
        if (scopeResult.status === "fulfilled") {
          const nextScope = scopeResult.value;
          const previousScope = draftScopeRef.current;
          if (
            previousScope &&
            (previousScope.ownerId !== nextScope.ownerId ||
              previousScope.backendId !== nextScope.backendId)
          ) {
            setModal(null);
            setRetireTarget(null);
            setSelectedId(null);
            setSelectedDetail(null);
          }
          draftScopeRef.current = nextScope;
          setDraftScope(nextScope);
        }
        if (capabilitiesResult.status === "fulfilled") {
          setCapabilities(capabilitiesResult.value);
          setCapabilityError(null);
        } else {
          setCapabilities([]);
          setCapabilityError(
            capabilitiesResult.reason instanceof Error
              ? capabilitiesResult.reason.message
              : "Model capabilities are unavailable."
          );
        }
        setLoadState("ready");
        setSelectedId((current) =>
          current && agentsResult.value.some((agent) => agent.id === current)
            ? current
            : null
        );
      } catch (reason) {
        if (signal.aborted) return;
        setError(
          reason instanceof Error ? reason.message : "Agents are unavailable."
        );
        setLoadState("error");
      }
    },
    [api, markCollectionChanged]
  );

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  useEffect(() => {
    if (loadState !== "ready") return;
    const controller = new AbortController();
    const revision = collectionRevisionRef.current;
    const ids = agentsRef.current
      .filter((agent) => agent.lifecycle === "active")
      .map((agent) => agent.id);
    let nextRefresh: number | undefined;

    const scan = async () => {
      for (let index = 0; index < ids.length; index += 1) {
        if (index > 0)
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        if (
          controller.signal.aborted ||
          revision !== collectionRevisionRef.current ||
          mutationInFlightRef.current
        )
          return;
        const id = ids[index];
        if (!id) continue;
        if (selectedIdRef.current === id) continue;
        const readSequence = (activityReadSequenceRef.current.get(id) ?? 0) + 1;
        activityReadSequenceRef.current.set(id, readSequence);
        try {
          const activity = await api.get(id, controller.signal);
          if (
            controller.signal.aborted ||
            revision !== collectionRevisionRef.current ||
            mutationInFlightRef.current
          )
            return;
          if (activityReadSequenceRef.current.get(id) !== readSequence)
            continue;
          setAgents((current) =>
            current.map((agent) => (agent.id === id ? activity : agent))
          );
          setSelectedDetail((current) =>
            current?.id === id ? activity : current
          );
          setActivityErrors((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
          if (selectedIdRef.current === id) setDetailError(null);
        } catch (reason) {
          if (controller.signal.aborted) return;
          if (revision !== collectionRevisionRef.current) return;
          if (activityReadSequenceRef.current.get(id) !== readSequence)
            continue;
          setAgents((current) =>
            current.map((agent) =>
              agent.id === id ? withoutVerifiedActivity(agent) : agent
            )
          );
          setSelectedDetail((current) =>
            current?.id === id ? withoutVerifiedActivity(current) : current
          );
          setActivityErrors((current) => new Set(current).add(id));
          if (selectedIdRef.current === id) {
            setDetailError(
              reason instanceof Error
                ? reason.message
                : "Agent activity is unavailable."
            );
          }
        }
      }
      if (!controller.signal.aborted) {
        nextRefresh = window.setTimeout(
          () => setActivityRefreshKey((value) => value + 1),
          Math.max(60_000, ids.length * 1_200)
        );
      }
    };
    void scan();
    return () => {
      if (nextRefresh !== undefined) window.clearTimeout(nextRefresh);
      controller.abort();
    };
  }, [api, activityRefreshKey, collectionRevision, loadState]);

  useEffect(() => {
    if (!selectedId) return;
    const agent = agentsRef.current.find(
      (candidate) => candidate.id === selectedId
    );
    if (!agent) return;
    const sequence = ++detailSequenceRef.current;
    const controller = new AbortController();
    const revision = collectionRevisionRef.current;
    let requestInFlight = false;
    const refresh = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      const readSequence =
        (activityReadSequenceRef.current.get(selectedId) ?? 0) + 1;
      activityReadSequenceRef.current.set(selectedId, readSequence);
      try {
        const detail = await api.get(selectedId, controller.signal);
        if (
          !controller.signal.aborted &&
          sequence === detailSequenceRef.current &&
          activityReadSequenceRef.current.get(selectedId) === readSequence &&
          revision === collectionRevisionRef.current &&
          !mutationInFlightRef.current
        ) {
          setSelectedDetail(detail);
          setAgents((current) =>
            current.map((candidate) =>
              candidate.id === selectedId ? detail : candidate
            )
          );
          setActivityErrors((current) => {
            const next = new Set(current);
            next.delete(selectedId);
            return next;
          });
          setDetailError(null);
        }
      } catch (reason) {
        if (
          !controller.signal.aborted &&
          sequence === detailSequenceRef.current &&
          activityReadSequenceRef.current.get(selectedId) === readSequence &&
          revision === collectionRevisionRef.current &&
          !mutationInFlightRef.current
        ) {
          setSelectedDetail((current) =>
            current?.id === selectedId
              ? withoutVerifiedActivity(current)
              : current
          );
          setAgents((current) =>
            current.map((candidate) =>
              candidate.id === selectedId
                ? withoutVerifiedActivity(candidate)
                : candidate
            )
          );
          setActivityErrors((current) => new Set(current).add(selectedId));
          setDetailError(
            reason instanceof Error
              ? reason.message
              : "Agent activity is unavailable."
          );
        }
      } finally {
        requestInFlight = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      detailSequenceRef.current += 1;
      window.clearInterval(interval);
      controller.abort();
    };
  }, [api, selectedId, collectionRevision, activityRefreshKey]);

  useEffect(() => {
    if (!selectedId || modal || retireTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDetail, modal, retireTarget, selectedId]);

  const saveAgent = async (
    values: Parameters<
      NonNullable<React.ComponentProps<typeof CreateAgentModal>["onSubmit"]>
    >[0]
  ) => {
    if (!modal) throw new Error("The agent editor is no longer open.");
    const key = modal.type === "edit" ? `edit:${modal.agent.id}` : "create";
    if (!mutationRequestRef.current || mutationRequestRef.current.key !== key) {
      mutationRequestRef.current = { key, id: personalAgentRequestId() };
    }
    const requestId = mutationRequestRef.current.id;
    mutationInFlightRef.current = true;
    try {
      const next =
        modal.type === "edit"
          ? await api.update(
              modal.agent.id,
              modal.agent.currentVersion,
              values,
              { requestId }
            )
          : await api.create(values, { requestId });
      setAgents((current) => upsertAgent(current, next));
      setSelectedId(next.id);
      setSelectedDetail((current) => preserveActivity(current, next));
      mutationRequestRef.current = null;
      return { definitionId: next.id };
    } finally {
      mutationInFlightRef.current = false;
      markCollectionChanged();
    }
  };

  const retireAgent = async () => {
    if (!retireTarget) return;
    setRetiring(true);
    setRetireError(null);
    if (
      !retireRequestRef.current ||
      retireRequestRef.current.id !== retireTarget.id
    ) {
      retireRequestRef.current = {
        id: retireTarget.id,
        requestId: personalAgentRequestId()
      };
    }
    try {
      mutationInFlightRef.current = true;
      const next = await api.retire(
        retireTarget.id,
        retireTarget.currentVersion,
        { requestId: retireRequestRef.current.requestId }
      );
      setAgents((current) => upsertAgent(current, next));
      setSelectedDetail((current) => preserveActivity(current, next));
      retireRequestRef.current = null;
      setRetireTarget(null);
    } catch (reason) {
      setRetireError(
        reason instanceof Error
          ? reason.message
          : "The agent could not be retired."
      );
    } finally {
      mutationInFlightRef.current = false;
      markCollectionChanged();
      setRetiring(false);
    }
  };

  const restoreAgent = async (agent: PersonalAgent) => {
    setRestoringId(agent.id);
    setLifecycleError(null);
    try {
      mutationInFlightRef.current = true;
      const restored = await api.restore(agent.id, agent.currentVersion, {
        requestId: personalAgentRequestId()
      });
      setAgents((current) => upsertAgent(current, restored));
      setSelectedDetail((current) => preserveActivity(current, restored));
    } catch (reason) {
      setLifecycleError(
        reason instanceof Error
          ? reason.message
          : "The agent could not be restored."
      );
    } finally {
      mutationInFlightRef.current = false;
      markCollectionChanged();
      setRestoringId(null);
    }
  };

  const cloneAgent = async (agent: PersonalAgent) => {
    setCloneLoadingId(agent.id);
    setLifecycleError(null);
    try {
      const latest = await api.get(agent.id);
      const initialValues = agentEditorInitialValues(latest);
      setModal({
        type: "create",
        initialValues: {
          ...initialValues,
          name: uniqueAgentCloneName(
            latest.name,
            agents.map((candidate) => candidate.name)
          )
        },
        draftTarget: `clone:${latest.id}`
      });
    } catch (reason) {
      setLifecycleError(
        reason instanceof Error
          ? reason.message
          : "The latest agent profile is unavailable."
      );
    } finally {
      setCloneLoadingId(null);
    }
  };

  const visibleAgents = filterAgentsByLifecycle(agents, lifecycleFilter);
  const activityOverviewAgents = agents.filter(
    (agent) => agent.lifecycle === "active"
  );
  const workingAgents = activityOverviewAgents
    .map((agent) => ({ agent, work: verifiedAgentWork(agent) }))
    .filter(({ work }) => work.status === "working");
  const unknownActivityAgents = activityOverviewAgents.filter(
    (agent) => verifiedAgentWork(agent).status === "unknown"
  );
  const unavailableActivityCount = unknownActivityAgents.filter(
    (agent) =>
      unknownActivityLabel(agent, activityErrors.has(agent.id)) ===
      "unavailable"
  ).length;
  const checkingActivityCount =
    unknownActivityAgents.length - unavailableActivityCount;

  if (loadState === "loading") {
    return (
      <AgentsShell
        onHome={onHome}
        onNewChat={onNewChat}
        onPullRequests={onPullRequests}
        onPlugins={onPlugins}
      >
        <PageState
          title="Loading agents"
          detail="Checking your personal agent library."
        />
      </AgentsShell>
    );
  }

  if (loadState === "error") {
    return (
      <AgentsShell
        onHome={onHome}
        onNewChat={onNewChat}
        onPullRequests={onPullRequests}
        onPlugins={onPlugins}
      >
        <PageState
          title="Agents are unavailable"
          detail={error ?? "The personal agent service did not respond."}
          action={
            <button
              type="button"
              className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground"
              onClick={() => setRefreshKey((value) => value + 1)}
            >
              Retry
            </button>
          }
        />
      </AgentsShell>
    );
  }

  return (
    <AgentsShell
      onHome={onHome}
      onNewChat={onNewChat}
      onPullRequests={onPullRequests}
      onPlugins={onPlugins}
    >
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground drag-region md:flex-row">
        <div
          className={`min-h-0 min-w-0 flex-1 overflow-y-auto no-drag ${selected ? "hidden md:block" : ""}`}
        >
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-3xl font-semibold">Agents</h1>
              <button
                type="button"
                onClick={() =>
                  setModal({ type: "create", draftTarget: "create" })
                }
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface-hover px-3 py-1.5 text-xs font-medium text-foreground-secondary transition-colors hover:bg-surface-active hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Create agent
              </button>
            </div>

            {capabilityError && (
              <p className="mt-4 text-xs text-warning">
                Model capabilities are unavailable. Existing agents remain
                readable, and you can still save a profile without a default
                model. Choose an available model before starting a Job.
              </p>
            )}
            {lifecycleError && (
              <p role="alert" className="mt-4 text-xs text-danger">
                {lifecycleError}
              </p>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <div
                className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1"
                role="group"
                aria-label="Filter agents by lifecycle"
              >
                {(["active", "retired", "all"] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    aria-pressed={lifecycleFilter === filter}
                    onClick={() => setLifecycleFilter(filter)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition-colors ${lifecycleFilter === filter ? "bg-surface-active text-foreground" : "text-subtle hover:bg-surface-hover hover:text-foreground-secondary"}`}
                  >
                    {filter === "all"
                      ? "All"
                      : filter === "active"
                        ? "Active"
                        : "Retired"}
                  </button>
                ))}
              </div>
              <div
                className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1"
                role="group"
                aria-label="Agent collection view"
              >
                <button
                  type="button"
                  aria-label="Cards"
                  aria-pressed={collectionView === "cards"}
                  onClick={() => setCollectionView("cards")}
                  className={`rounded-md p-1.5 ${collectionView === "cards" ? "bg-surface-active text-foreground" : "text-subtle hover:bg-surface-hover"}`}
                >
                  <LayoutGrid className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="List"
                  aria-pressed={collectionView === "list"}
                  onClick={() => setCollectionView("list")}
                  className={`rounded-md p-1.5 ${collectionView === "list" ? "bg-surface-active text-foreground" : "text-subtle hover:bg-surface-hover"}`}
                >
                  <List className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            <section className="mt-8" aria-labelledby="agents-working-now">
              <div className="flex items-center justify-between gap-3">
                <h2
                  id="agents-working-now"
                  className="text-sm font-semibold text-foreground"
                >
                  Working now
                </h2>
                <button
                  type="button"
                  onClick={() => setActivityRefreshKey((value) => value + 1)}
                  className="text-xs text-subtle underline-offset-2 hover:text-foreground hover:underline"
                >
                  Refresh activity
                </button>
              </div>
              <p className="mt-1 text-xs text-subtle">Active agents</p>
              {(workingAgents.length > 0 ||
                unknownActivityAgents.length > 0) && (
                <div className="mt-2 space-y-2">
                  {workingAgents.map(({ agent, work }) => (
                    <div
                      key={agent.id}
                      className="rounded-lg border border-border bg-surface px-3 py-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="truncate text-sm font-medium text-foreground">
                          {agent.name}
                        </p>
                        <span className="flex-shrink-0 text-xs text-subtle">
                          Working · {work.count}{" "}
                          {work.count === 1 ? "job" : "jobs"}
                        </span>
                      </div>
                      {work.jobs.length === 0 ? (
                        <p className="mt-1 text-xs text-subtle">
                          Job details are unavailable.
                        </p>
                      ) : (
                        <div className="mt-1.5 space-y-1.5">
                          {work.jobs.map((job) => {
                            const projectName =
                              job.projectName ??
                              agent.projects.find(
                                (project) => project.id === job.projectId
                              )?.name;
                            return (
                              <div
                                key={job.id}
                                className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-1.5"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-medium text-foreground-secondary">
                                    {job.title}
                                  </p>
                                  {projectName && (
                                    <p className="truncate text-[11px] text-subtle">
                                      {projectName}
                                    </p>
                                  )}
                                </div>
                                {job.conversationId && onOpenConversation && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onOpenConversation(job.conversationId!)
                                    }
                                    className="flex-shrink-0 text-xs text-subtle underline-offset-2 hover:text-foreground hover:underline"
                                  >
                                    Open conversation
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {unavailableActivityCount > 0 && (
                <p className="mt-2 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm text-subtle">
                  Activity unavailable for {unavailableActivityCount} active{" "}
                  {unavailableActivityCount === 1 ? "agent" : "agents"}.
                </p>
              )}
              {checkingActivityCount > 0 && (
                <p className="mt-2 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm text-subtle">
                  Checking activity for {checkingActivityCount} active{" "}
                  {checkingActivityCount === 1 ? "agent" : "agents"}.
                </p>
              )}
              {workingAgents.length === 0 &&
                unknownActivityAgents.length === 0 && (
                  <p className="mt-2 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm text-subtle">
                    No verified jobs are running now.
                  </p>
                )}
            </section>

            <section className="mt-8" aria-label="Agent collection">
              {visibleAgents.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface/50 px-6 py-12 text-center">
                  <p className="text-sm text-subtle">
                    {agents.length === 0
                      ? "No agents yet. Create one and it’s yours to reuse across your personal work."
                      : `No ${lifecycleFilter === "all" ? "" : `${lifecycleFilter} `}agents in this collection.`}
                  </p>
                </div>
              ) : collectionView === "cards" ? (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-3">
                  {visibleAgents.map((agent) => {
                    const isSelected = agent.id === selectedId;
                    const work = verifiedAgentWork(agent);
                    return (
                      <button
                        key={agent.id}
                        ref={(node) => {
                          if (node) agentCardRefs.current.set(agent.id, node);
                          else agentCardRefs.current.delete(agent.id);
                        }}
                        type="button"
                        onClick={() => setSelectedId(agent.id)}
                        aria-pressed={isSelected}
                        className={`rounded-xl border p-4 text-left transition-colors ${isSelected ? "border-border-strong bg-surface-hover" : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover/60"}`}
                      >
                        <div className="flex items-center gap-4">
                          <AgentAvatarView
                            image={agent.avatar?.image}
                            spec={avatarSpecForAgent(agent)}
                            name={agent.name}
                            size="xl"
                            className="ring-1 ring-border-strong"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-lg font-semibold text-foreground">
                                {agent.name}
                              </p>
                              {agent.lifecycle === "retired" && (
                                <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-subtle">
                                  Retired
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-sm text-subtle">
                              {agent.role}
                            </p>
                            <p className="mt-1 text-xs text-subtle">
                              {work.status === "working"
                                ? `Working · ${work.count} ${work.count === 1 ? "job" : "jobs"}`
                                : work.status === "idle"
                                  ? "No verified job running"
                                  : unknownActivityLabel(
                                        agent,
                                        activityErrors.has(agent.id)
                                      ) === "unavailable"
                                    ? "Activity unavailable"
                                    : agent.lifecycle === "retired" &&
                                        selectedId !== agent.id
                                      ? "Select to load activity"
                                      : "Checking activity…"}
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 border-t border-border pt-3">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                            Active in
                          </p>
                          {!agent.activityLoaded ? (
                            <p className="mt-1.5 text-xs text-subtle">
                              {activityErrors.has(agent.id)
                                ? "Project activity is unavailable."
                                : agent.lifecycle === "retired" &&
                                    selectedId !== agent.id
                                  ? "Select to load project activity."
                                  : "Project activity is being checked."}
                            </p>
                          ) : agent.stats?.projects === null ? (
                            <p className="mt-1.5 text-xs text-subtle">
                              Project engagements are unavailable.
                            </p>
                          ) : agent.projects.length === 0 ? (
                            <p className="mt-1.5 text-xs text-subtle">
                              No active project engagements.
                            </p>
                          ) : (
                            <div className="mt-1.5 space-y-1.5">
                              {agent.projects.map((project) => (
                                <div
                                  key={project.id}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-hover/50 px-2.5 py-1.5"
                                >
                                  <span className="truncate text-xs font-medium text-foreground-secondary">
                                    {project.name}
                                  </span>
                                  <span className="flex-shrink-0 truncate text-[11px] text-subtle">
                                    {settingLabel(project.model)} ·{" "}
                                    {settingLabel(project.effort)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-surface">
                  {visibleAgents.map((agent) => {
                    const isSelected = agent.id === selectedId;
                    const work = verifiedAgentWork(agent);
                    return (
                      <button
                        key={agent.id}
                        ref={(node) => {
                          if (node) agentCardRefs.current.set(agent.id, node);
                          else agentCardRefs.current.delete(agent.id);
                        }}
                        type="button"
                        onClick={() => setSelectedId(agent.id)}
                        aria-pressed={isSelected}
                        className={`flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 ${isSelected ? "bg-surface-hover" : "hover:bg-surface-hover/60"}`}
                      >
                        <AgentAvatarView
                          image={agent.avatar?.image}
                          spec={avatarSpecForAgent(agent)}
                          name={agent.name}
                          size="md"
                          className="ring-1 ring-border-strong"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {agent.name}
                            </span>
                            {agent.lifecycle === "retired" && (
                              <span className="text-[10px] uppercase tracking-wide text-subtle">
                                Retired
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-xs text-subtle">
                            {agent.role}
                          </span>
                        </span>
                        <span className="hidden flex-shrink-0 text-xs text-subtle sm:block">
                          {work.status === "working"
                            ? `Working · ${work.count} ${work.count === 1 ? "job" : "jobs"}`
                            : work.status === "idle"
                              ? "No verified job running"
                              : unknownActivityLabel(
                                    agent,
                                    activityErrors.has(agent.id)
                                  ) === "unavailable"
                                ? "Activity unavailable"
                                : agent.lifecycle === "retired" &&
                                    selectedId !== agent.id
                                  ? "Select to load activity"
                                  : "Checking activity…"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>

        {selected && (
          <AgentDetailPanel
            agent={selected}
            loading={!selectedDetailForSelection}
            error={detailError}
            onClose={closeDetail}
            onEdit={() => setModal({ type: "edit", agent: selected })}
            onGiveAJob={() => onGiveAJob?.(selected)}
            onOpenConversation={onOpenConversation}
            clockNow={clockNow}
            onRetire={() => setRetireTarget(selected)}
            onClone={() => void cloneAgent(selected)}
            onRestore={() => void restoreAgent(selected)}
            cloneLoading={cloneLoadingId === selected.id}
            restoring={restoringId === selected.id}
            lifecycleError={lifecycleError}
          />
        )}

        {modal && (
          <CreateAgentModal
            key={`${draftScope?.backendId ?? "unverified"}:${draftScope?.ownerId ?? "unverified"}:${modal.type === "create" ? modal.draftTarget : `edit:${modal.agent.id}`}`}
            onClose={() => setModal(null)}
            onCreated={() => setModal(null)}
            editDefinition={
              modal.type === "edit" ? toDefinition(modal.agent) : undefined
            }
            initialValues={
              modal.type === "edit"
                ? agentEditorInitialValues(modal.agent)
                : modal.initialValues
            }
            draftIdentity={
              draftScope
                ? {
                    scope: draftScope,
                    target:
                      modal.type === "create"
                        ? modal.draftTarget
                        : `edit:${modal.agent.id}`
                  }
                : undefined
            }
            capabilities={capabilities}
            onSubmit={saveAgent}
          />
        )}

        {retireTarget && (
          <RetireAgentDialog
            agent={retireTarget}
            error={retireError}
            saving={retiring}
            onCancel={() => setRetireTarget(null)}
            onConfirm={() => void retireAgent()}
          />
        )}
      </div>
    </AgentsShell>
  );
}

function AgentsShell({
  children,
  onHome,
  onNewChat,
  onPullRequests,
  onPlugins
}: {
  children: React.ReactNode;
  onHome?: () => void;
  onNewChat?: () => void;
  onPullRequests?: () => void;
  onPlugins?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="flex h-full min-h-0 w-full">
      <StudioSidebar
        projects={[]}
        collapsed={collapsed}
        selectedProject={null}
        onProjectSelect={() => {}}
        onToggle={() => setCollapsed((value) => !value)}
        onHome={onHome}
        onNewChat={onNewChat}
        onPullRequests={onPullRequests}
        onPlugins={onPlugins}
        activeSection="agents"
      />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

function AgentDetailPanel({
  agent,
  loading,
  error,
  onClose,
  onGiveAJob,
  onOpenConversation,
  clockNow,
  onEdit,
  onRetire,
  onClone,
  onRestore,
  cloneLoading,
  restoring,
  lifecycleError
}: {
  agent: PersonalAgent;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onGiveAJob?: () => void;
  onOpenConversation?: (conversationId: string) => void;
  clockNow: number;
  onEdit: () => void;
  onRetire: () => void;
  onClone: () => void;
  onRestore: () => void;
  cloneLoading: boolean;
  restoring: boolean;
  lifecycleError: string | null;
}) {
  const [soulOpen, setSoulOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const completedJobs = agent.jobs.filter((job) => job.state === "succeeded");
  const runningNow = agent.stats
    ? agent.stats.runningNow
    : agent.runningNow.length;
  const projectCount = agent.stats
    ? agent.stats.projects
    : agent.projects.length;
  const jobsLogged = agent.stats ? agent.stats.jobsLogged : agent.jobs.length;
  const jobHistoryComplete = !agent.jobsHasMore;
  const personalDefaults = [
    agent.defaultProvider && agent.defaultModel
      ? `${agent.defaultProvider} · ${agent.defaultModel}`
      : null,
    agent.defaultReasoningEffort
  ].filter((value): value is string => Boolean(value));
  const canSummarizeRelationship =
    !loading &&
    agent.activityLoaded &&
    jobHistoryComplete &&
    projectCount !== null;
  const relationshipTitle = canSummarizeRelationship
    ? tenureTitle(completedJobs.length, agent.createdAt)
    : null;
  const narrative = canSummarizeRelationship
    ? relationshipNarrative(
        agent.name,
        completedJobs.length,
        projectCount ?? agent.projects.length,
        agent.createdAt
      )
    : null;
  const milestones =
    canSummarizeRelationship && projectCount !== null
      ? milestonesFor({
          shippedCount: completedJobs.length,
          projectCount: projectCount ?? agent.projects.length,
          createdAt: agent.createdAt
        })
      : [];
  const moodSpec = avatarSpecForAgent(agent);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, [agent.id]);

  return (
    <aside
      aria-label={`${agent.name} details`}
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto border-t border-border bg-background no-drag md:w-[380px] md:flex-none md:border-l md:border-t-0"
    >
      <div className="flex items-start justify-between gap-2 px-5 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatarView
            image={agent.avatar?.image}
            spec={moodSpec}
            name={agent.name}
            size="xl"
            className="ring-1 ring-border-strong"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-lg font-semibold text-foreground">
                {agent.name}
              </p>
              {agent.lifecycle === "retired" && (
                <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">
                  Retired
                </span>
              )}
            </div>
            <p className="truncate text-sm text-subtle">{agent.role}</p>
            <p className="mt-0.5 truncate text-[11px] text-faint">
              Created {relativeTime(agent.createdAt)}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-faint">
              {personalDefaults.length > 0
                ? `Personal defaults · ${personalDefaults.join(" · ")}`
                : "No personal model defaults"}
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {agent.lifecycle === "active" ? (
            <>
              <Tooltip content="Edit agent">
                <button
                  type="button"
                  className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
                  onClick={onEdit}
                  aria-label="Edit agent"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <Tooltip content="Retire agent">
                <button
                  type="button"
                  className="rounded-md p-1.5 text-subtle hover:bg-warning/10 hover:text-warning"
                  onClick={onRetire}
                  aria-label="Retire agent"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip content="Restore this agent">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[11px] font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                onClick={onRestore}
                disabled={restoring}
              >
                {restoring ? "Restoring…" : "Restore"}
              </button>
            </Tooltip>
          )}
          <Tooltip content="Clone this profile">
            <button
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary disabled:opacity-50"
              onClick={onClone}
              aria-label="Clone agent"
              disabled={cloneLoading}
            >
              {cloneLoading ? (
                <span className="px-1 text-[10px]">…</span>
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
          <Tooltip content="Close">
            <button
              ref={closeButtonRef}
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {agent.lifecycle === "active" && onGiveAJob && (
        <div className="mt-4 px-5">
          <button
            type="button"
            onClick={onGiveAJob}
            disabled={loading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            Give a job
          </button>
        </div>
      )}

      {lifecycleError && (
        <p role="alert" className="mt-3 px-5 text-xs text-danger">
          {lifecycleError}
        </p>
      )}

      <div className="mt-4 px-5">
        <span className="rounded-full bg-chip px-2.5 py-1 text-[11px] font-medium text-chip-foreground">
          {relationshipTitle ??
            (completedJobs.length && jobHistoryComplete
              ? "Working relationship"
              : "New recruit")}
        </span>
        <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
          {narrative ??
            (completedJobs.length && jobHistoryComplete
              ? `You and ${agent.name} have completed ${completedJobs.length} ${completedJobs.length === 1 ? "job" : "jobs"} together.`
              : agent.jobsHasMore
                ? `Recent jobs are recorded for ${agent.name}; older history is available from the service.`
                : `${agent.name} has no completed jobs recorded yet.`)}
        </p>
        {milestones.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {milestones.map((milestone) => (
              <span
                key={milestone}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-1 text-[11px] font-medium text-foreground-secondary"
              >
                <Award className="h-3 w-3 text-subtle" />
                {milestone}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 px-5">
        <StatTile
          label="Projects"
          value={loading || !agent.activityLoaded ? "—" : (projectCount ?? "—")}
        />
        <StatTile
          label="Running now"
          value={loading || !agent.activityLoaded ? "—" : (runningNow ?? "—")}
        />
        <StatTile
          label="Jobs logged"
          value={loading || !agent.activityLoaded ? "—" : (jobsLogged ?? "—")}
        />
      </div>

      {loading ? (
        error ? (
          <p className="mt-6 px-5 text-sm text-danger">{error}</p>
        ) : (
          <p className="mt-6 px-5 text-sm text-subtle">
            Loading verified activity…
          </p>
        )
      ) : !agent.activityLoaded ? (
        <p className="mt-6 px-5 text-sm text-danger">
          {error ??
            "Activity history is unavailable. No local activity has been substituted."}
        </p>
      ) : (
        <>
          {error && (
            <p className="mt-4 px-5 text-xs text-warning">
              Live refresh unavailable. Showing the last verified activity.
            </p>
          )}
          <section className="mt-6 px-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              Active in{" "}
              {projectCount !== null && projectCount > 0 && `(${projectCount})`}
            </p>
            {projectCount === null ? (
              <p className="mt-2 text-sm text-subtle">
                Project engagements are unavailable from the service.
              </p>
            ) : agent.projects.length === 0 ? (
              <p className="mt-2 text-sm text-subtle">
                Not active in any project.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {agent.projects.map((project) => (
                  <div
                    key={project.id}
                    className="rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-foreground">
                        {project.name}
                      </p>
                      <span className="flex-shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-muted">
                        {statusLabel(project.status)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-subtle">
                      {project.focus || "No active focus recorded."}
                    </p>
                    <p className="mt-2 text-[11px] text-subtle">
                      {settingLabel(project.model)} ·{" "}
                      {settingLabel(project.effort)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-6 px-5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              <Sparkles className="h-3 w-3" /> Running Now
            </p>
            {runningNow === null ? (
              <p className="mt-2 text-sm text-subtle">
                Current running activity is unavailable from the service.
              </p>
            ) : agent.runningNow.length === 0 ? (
              <p className="mt-2 text-sm text-subtle">
                No verified jobs running now.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {agent.runningNow.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    detailed
                    now={clockNow}
                    onOpenConversation={onOpenConversation}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="mt-6 px-5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              <Award className="h-3 w-3" /> Highlights
            </p>
            {agent.highlights.length === 0 ? (
              <p className="mt-2 text-sm text-subtle">
                No verified completed highlights yet.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {agent.highlights.map((highlight) => (
                  <div
                    key={highlight.id}
                    className="rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-foreground">
                        {highlight.title}
                      </p>
                      <span className="flex-shrink-0 text-[11px] text-subtle">
                        {relativeTime(highlight.at)}
                      </span>
                    </div>
                    {highlight.projectName && (
                      <p className="mt-0.5 text-[11px] text-subtle">
                        {highlight.projectName}
                      </p>
                    )}
                    {highlight.summary && (
                      <p className="mt-2 text-xs text-foreground-secondary">
                        {highlight.summary}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-6 px-5 pb-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              Job history
            </p>
            {agent.jobsHasMore && (
              <p className="mt-2 text-xs text-warning">
                Showing the latest recorded jobs. More history is available from
                the service.
              </p>
            )}
            {jobsLogged === null ? (
              <p className="mt-2 text-sm text-subtle">
                Job history is unavailable from the service.
              </p>
            ) : agent.jobs.length === 0 ? (
              <p className="mt-2 text-sm text-subtle">No jobs recorded yet.</p>
            ) : (
              <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
                {agent.jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    detailed
                    now={clockNow}
                    onOpenConversation={onOpenConversation}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
      <div className="mt-6 px-5 pb-5">
        <button
          type="button"
          aria-expanded={soulOpen}
          aria-controls="agent-soul-preview"
          className="flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-subtle hover:text-foreground-secondary"
          onClick={() => setSoulOpen((open) => !open)}
        >
          soul.md · identity
          <span className="text-foreground-secondary">
            {soulOpen ? "Hide" : "Show"}
          </span>
        </button>
        {soulOpen && (
          <pre
            id="agent-soul-preview"
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 text-[11px] leading-relaxed text-muted"
          >
            {agent.soul || "No soul instructions were returned by the service."}
          </pre>
        )}
      </div>
    </aside>
  );
}

function JobCard({
  job,
  detailed = false,
  now,
  onOpenConversation
}: {
  job: PersonalAgentJob;
  detailed?: boolean;
  now: number;
  onOpenConversation?: (conversationId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-foreground">
          {job.title}
        </p>
        <span className="flex-shrink-0 text-[11px] text-subtle">
          {relativeTime(job.completedAt ?? job.startedAt ?? job.createdAt)}
        </span>
      </div>
      {job.projectName && (
        <p className="mt-0.5 text-[11px] text-subtle">{job.projectName}</p>
      )}
      {job.agentName && (
        <p className="mt-0.5 text-[11px] text-subtle">
          Agent profile · {job.agentName}
          {job.agentVersion !== null && job.agentVersion !== undefined
            ? ` · v${job.agentVersion}`
            : ""}
        </p>
      )}
      <p className="mt-2 text-[11px] text-subtle">
        {jobStatusLabel(job.state)} · Actual model: {settingLabel(job.model)} ·{" "}
        {settingLabel(job.effort)}
        {job.provider && ` · ${job.provider}`}
      </p>
      {detailed && job.summary && (
        <p className="mt-2 text-xs text-foreground-secondary">{job.summary}</p>
      )}
      {detailed && job.goal && (
        <div className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
            Job goal
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground-secondary">
            {job.goal}
          </p>
        </div>
      )}
      {detailed && job.state === "running" && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-subtle">
            {job.startedAt
              ? `Elapsed ${elapsedLabel(job.startedAt, now)}`
              : "Elapsed time unavailable"}
          </p>
          {job.conversationId && onOpenConversation ? (
            <button
              type="button"
              onClick={() => onOpenConversation(job.conversationId!)}
              className="text-[11px] font-medium text-accent underline underline-offset-2"
            >
              Open running Conversation
            </button>
          ) : null}
        </div>
      )}
      {job.attempts.length > 0 && (
        <details className="mt-3 border-t border-border pt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-subtle hover:text-foreground-secondary">
            Attempts ({job.attempts.length})
          </summary>
          <div className="mt-2 space-y-2">
            {job.attempts.map((attempt) => (
              <div key={attempt.id} className="rounded-md bg-background/60 p-2">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium text-foreground-secondary">
                    Attempt {attempt.attemptNumber}
                  </span>
                  <span className="text-subtle">
                    {jobStatusLabel(attempt.status)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-subtle">
                  {settingLabel(attempt.provider)} ·{" "}
                  {settingLabel(attempt.model)} · {settingLabel(attempt.effort)}
                  {attempt.instanceId && ` · ${attempt.instanceId}`}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function elapsedLabel(startedAt: number, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2 py-2 text-center">
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-subtle">
        {label}
      </p>
    </div>
  );
}

function PageState({
  title,
  detail,
  action
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background px-6 text-center">
      <div className="max-w-md">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-subtle">{detail}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

function RetireAgentDialog({
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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={() => !saving && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="retire-agent-title"
        aria-describedby="retire-agent-description"
        className="w-[400px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface p-5 shadow-2xl"
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
