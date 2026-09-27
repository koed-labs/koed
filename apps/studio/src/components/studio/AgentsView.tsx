"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Award, Pencil, Plus, Sparkles, X } from "lucide-react";
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
  type PersonalAgentsApi
} from "@/lib/personal-agents-client";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";

type ModalState =
  | { type: "create" }
  | { type: "edit"; agent: PersonalAgent }
  | null;

type AgentsViewProps = Readonly<{
  api?: PersonalAgentsApi;
  onHome?: () => void;
  onNewChat?: () => void;
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
  onPullRequests,
  onPlugins
}: AgentsViewProps) {
  const [agents, setAgents] = useState<PersonalAgent[]>([]);
  const [capabilities, setCapabilities] = useState<AgentModelCapability[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PersonalAgent | null>(
    null
  );
  const [modal, setModal] = useState<ModalState>(null);
  const [retireTarget, setRetireTarget] = useState<PersonalAgent | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const detailSequenceRef = useRef(0);
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

  const closeDetail = useCallback(() => {
    const previousId = selectedId;
    setSelectedId(null);
    if (previousId) {
      window.requestAnimationFrame(() =>
        agentCardRefs.current.get(previousId)?.focus()
      );
    }
  }, [selectedId]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoadState("loading");
      setError(null);
      try {
        const [agentsResult, capabilitiesResult] = await Promise.allSettled([
          api.list(signal),
          api.capabilities(signal)
        ]);
        if (signal.aborted) return;
        if (agentsResult.status === "rejected") throw agentsResult.reason;
        setAgents(agentsResult.value);
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
    [api]
  );

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!selectedId) return;
    const sequence = ++detailSequenceRef.current;
    let requestController: AbortController | null = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailError(null);
    const refresh = async () => {
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      try {
        const detail = await api.get(selectedId, controller.signal);
        if (
          !controller.signal.aborted &&
          sequence === detailSequenceRef.current
        ) {
          setSelectedDetail(detail);
          setAgents((current) => upsertAgent(current, detail));
          setDetailError(null);
        }
      } catch (reason) {
        if (
          !controller.signal.aborted &&
          sequence === detailSequenceRef.current
        ) {
          setDetailError(
            reason instanceof Error
              ? reason.message
              : "Agent activity is unavailable."
          );
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => {
      window.clearInterval(interval);
      requestController?.abort();
    };
  }, [api, selectedId]);

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
    const next =
      modal.type === "edit"
        ? await api.update(modal.agent.id, modal.agent.currentVersion, values, {
            requestId
          })
        : await api.create(values, { requestId });
    setAgents((current) => upsertAgent(current, next));
    setSelectedId(next.id);
    setSelectedDetail((current) => preserveActivity(current, next));
    mutationRequestRef.current = null;
    return { definitionId: next.id };
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
      setRetiring(false);
    }
  };

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
                onClick={() => setModal({ type: "create" })}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface-hover px-3 py-1.5 text-xs font-medium text-foreground-secondary transition-colors hover:bg-surface-active hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Create agent
              </button>
            </div>

            {capabilityError && (
              <p className="mt-4 text-xs text-warning">
                Model capabilities are unavailable. Existing agents remain
                readable, but saving requires a supported model list.
              </p>
            )}

            {agents.length === 0 ? (
              <div className="mt-10 rounded-xl border border-border bg-surface/50 px-6 py-16 text-center">
                <p className="text-sm text-subtle">
                  No agents yet. Create one and it&rsquo;s yours to reuse across
                  your personal work.
                </p>
              </div>
            ) : (
              <div className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-3">
                {agents.map((agent) => {
                  const isSelected = agent.id === selectedId;
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
                        </div>
                      </div>
                      <div className="mt-3 border-t border-border pt-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                          Active in
                        </p>
                        {!agent.activityLoaded ? (
                          <p className="mt-1.5 text-xs text-subtle">
                            Select this agent to load current activity.
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
            )}
          </div>
        </div>

        {selected && (
          <AgentDetailPanel
            agent={selected}
            loading={!selectedDetailForSelection}
            error={detailError}
            onClose={closeDetail}
            onEdit={() => setModal({ type: "edit", agent: selected })}
            onRetire={() => setRetireTarget(selected)}
          />
        )}

        {modal && (
          <CreateAgentModal
            onClose={() => setModal(null)}
            onCreated={() => setModal(null)}
            editDefinition={
              modal.type === "edit" ? toDefinition(modal.agent) : undefined
            }
            initialValues={
              modal.type === "edit"
                ? agentEditorInitialValues(modal.agent)
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
  onEdit,
  onRetire
}: {
  agent: PersonalAgent;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onEdit: () => void;
  onRetire: () => void;
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
          {agent.lifecycle === "active" && (
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
          )}
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
                  <JobCard key={job.id} job={job} />
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
                  <JobCard key={job.id} job={job} detailed />
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
  detailed = false
}: {
  job: PersonalAgentJob;
  detailed?: boolean;
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
      <p className="mt-2 text-[11px] text-subtle">
        {jobStatusLabel(job.state)} · Actual model: {settingLabel(job.model)} ·{" "}
        {settingLabel(job.effort)}
        {job.provider && ` · ${job.provider}`}
      </p>
      {detailed && job.summary && (
        <p className="mt-2 text-xs text-foreground-secondary">{job.summary}</p>
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
