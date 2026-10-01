"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { LayoutGrid, List, Plus } from "lucide-react";
import type { AgentDefinition } from "@/lib/collab";
import { AgentAvatarView } from "@/components/AgentAvatarView";
import { CreateAgentModal } from "@/components/CreateAgentModal";
import { StudioSidebar } from "./StudioSidebar";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { RetireAgentDialog } from "./RetireAgentDialog";
import { WorkingAgentCard } from "./WorkingAgentCard";
import { avatarSpecForAgent, settingLabel } from "./agents-presentation-utils";
import {
  agentEditorInitialValues,
  personalAgentsHttpAdapter,
  personalAgentRequestId,
  type PersonalAgent,
  type PersonalAgentActivity,
  type PersonalAgentsApi,
  type PersonalAgentDraftScope,
  uniqueAgentCloneName
} from "@/lib/personal-agents-client";
import type { AgentModelCapability } from "@/lib/agentIdentityEditor";
import {
  activityForRequestedAgents,
  mergePersonalAgentJobPage,
  mergePersonalAgentRefresh,
  personalAgentReadIsCurrent,
  samePersonalAgentScope,
  unavailablePersonalAgentActivity,
  withPersonalAgentActivitySummary,
  type PersonalAgentReadIdentity
} from "@/lib/personal-agent-activity";
import {
  filterAgentsByLifecycle,
  PERSONAL_AGENT_ACTIVITY_LEASE_MS,
  unknownActivityLabel,
  projectEngagementsForCard,
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

function upsertAgent(
  agents: PersonalAgent[],
  next: PersonalAgent
): PersonalAgent[] {
  const index = agents.findIndex((agent) => agent.id === next.id);
  if (index < 0) return [next, ...agents];
  const previous = agents[index];
  if (!previous) return [next, ...agents];
  const merged = mergePersonalAgentRefresh(previous, next);
  return agents.map((agent) => (agent.id === next.id ? merged : agent));
}

function isVerifiedActivity(activity: PersonalAgentActivity): boolean {
  const now = Date.now();
  return (
    activity.status !== "unknown" &&
    activity.availability === "available" &&
    activity.freshness === "fresh" &&
    activity.runningAttempts !== null &&
    activity.observedAt !== null &&
    activity.observedAt <= now &&
    now - activity.observedAt <= PERSONAL_AGENT_ACTIVITY_LEASE_MS &&
    (activity.status === "running"
      ? activity.runningAttempts > 0
      : activity.runningAttempts === 0)
  );
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
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const detailSequenceRef = useRef(0);
  const activityReadSequenceRef = useRef(new Map<string, number>());
  const jobsReadSequenceRef = useRef(0);
  const jobsAbortControllerRef = useRef<AbortController | null>(null);
  const jobsLoadingRef = useRef(false);
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
  const selectedAgentRef = useRef(selected);
  useLayoutEffect(() => {
    agentsRef.current = agents;
    selectedIdRef.current = selectedId;
    selectedAgentRef.current = selected;
  }, [agents, selected, selectedId]);

  useEffect(() => {
    const selectedJobNeedsClock = selected?.jobs.some(
      (job) => job.state === "running" && job.startedAt
    );
    const now = Date.now();
    const overviewNeedsClock = agents.some((agent) => {
      const summary = agent.activitySummary;
      return Boolean(
        summary?.freshness === "fresh" &&
        summary.observedAt !== null &&
        summary.observedAt <= now &&
        now - summary.observedAt <= PERSONAL_AGENT_ACTIVITY_LEASE_MS
      );
    });
    if (!selectedJobNeedsClock && !overviewNeedsClock) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [agents, selected?.id, selected?.jobs]);

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
        const previousScope = draftScopeRef.current;
        const nextScope =
          scopeResult.status === "fulfilled" ? scopeResult.value : null;
        const scopeUnchanged =
          scopeResult.status === "fulfilled" &&
          samePersonalAgentScope(previousScope, nextScope);
        markCollectionChanged();
        setAgents((current) =>
          signal.aborted
            ? current
            : agentsResult.value.map((nextAgent) => {
                const previous = current.find(
                  (agent) => agent.id === nextAgent.id
                );
                return scopeUnchanged && previous
                  ? mergePersonalAgentRefresh(previous, nextAgent)
                  : nextAgent;
              })
        );
        if (!scopeUnchanged) {
          setModal(null);
          setRetireTarget(null);
          setSelectedId(null);
          setSelectedDetail(null);
        }
        draftScopeRef.current = nextScope;
        setDraftScope(nextScope);
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
    const scope = draftScopeRef.current;
    const ids = agentsRef.current
      .filter((agent) => agent.lifecycle === "active")
      .filter((agent) => agent.id !== selectedIdRef.current)
      .map((agent) => agent.id);
    let nextRefresh: number | undefined;

    const scan = async () => {
      for (let index = 0; index < ids.length; index += 100) {
        const batch = ids.slice(index, index + 100);
        if (
          controller.signal.aborted ||
          revision !== collectionRevisionRef.current ||
          !samePersonalAgentScope(scope, draftScopeRef.current) ||
          mutationInFlightRef.current
        )
          return;
        const reads = new Map<string, PersonalAgentReadIdentity>();
        for (const id of batch) {
          const sequence = (activityReadSequenceRef.current.get(id) ?? 0) + 1;
          activityReadSequenceRef.current.set(id, sequence);
          reads.set(id, {
            agentId: id,
            sequence,
            collectionRevision: revision,
            scope
          });
        }
        try {
          const activity = await api.activity(batch, controller.signal);
          if (
            controller.signal.aborted ||
            revision !== collectionRevisionRef.current ||
            !samePersonalAgentScope(scope, draftScopeRef.current) ||
            mutationInFlightRef.current
          )
            return;
          const byAgentId = new Map(
            activityForRequestedAgents(batch, activity).map((summary) => [
              summary.agentId,
              summary
            ])
          );
          const updates = batch.flatMap((id) => {
            const read = reads.get(id);
            const current: PersonalAgentReadIdentity = {
              agentId: id,
              sequence: activityReadSequenceRef.current.get(id) ?? 0,
              collectionRevision: collectionRevisionRef.current,
              scope: draftScopeRef.current
            };
            if (
              !read ||
              !personalAgentReadIsCurrent(read, current) ||
              selectedIdRef.current === id
            ) {
              return [];
            }
            const summary =
              byAgentId.get(id) ?? unavailablePersonalAgentActivity(id);
            return [{ id, summary, verified: isVerifiedActivity(summary) }];
          });
          if (updates.length === 0) continue;
          setAgents((current) => {
            if (
              controller.signal.aborted ||
              revision !== collectionRevisionRef.current ||
              !samePersonalAgentScope(scope, draftScopeRef.current) ||
              mutationInFlightRef.current
            ) {
              return current;
            }
            return current.map((agent) => {
              const update = updates.find((item) => item.id === agent.id);
              const read = reads.get(agent.id);
              const currentRead: PersonalAgentReadIdentity = {
                agentId: agent.id,
                sequence: activityReadSequenceRef.current.get(agent.id) ?? 0,
                collectionRevision: collectionRevisionRef.current,
                scope: draftScopeRef.current
              };
              return update &&
                read &&
                personalAgentReadIsCurrent(read, currentRead) &&
                selectedIdRef.current !== agent.id
                ? withPersonalAgentActivitySummary(agent, update.summary)
                : agent;
            });
          });
          setActivityErrors((current) => {
            if (
              controller.signal.aborted ||
              revision !== collectionRevisionRef.current ||
              !samePersonalAgentScope(scope, draftScopeRef.current) ||
              mutationInFlightRef.current
            ) {
              return current;
            }
            const next = new Set(current);
            for (const update of updates) {
              if (update.verified) next.delete(update.id);
              else next.add(update.id);
            }
            return next;
          });
        } catch {
          if (controller.signal.aborted) return;
          if (
            revision !== collectionRevisionRef.current ||
            !samePersonalAgentScope(scope, draftScopeRef.current)
          )
            return;
          const updates = batch.filter((id) => {
            const read = reads.get(id);
            if (!read) return false;
            const current: PersonalAgentReadIdentity = {
              agentId: id,
              sequence: activityReadSequenceRef.current.get(id) ?? 0,
              collectionRevision: collectionRevisionRef.current,
              scope: draftScopeRef.current
            };
            return (
              personalAgentReadIsCurrent(read, current) &&
              selectedIdRef.current !== id
            );
          });
          setAgents((current) => {
            if (
              controller.signal.aborted ||
              revision !== collectionRevisionRef.current ||
              !samePersonalAgentScope(scope, draftScopeRef.current) ||
              mutationInFlightRef.current
            ) {
              return current;
            }
            return current.map((agent) => {
              const read = reads.get(agent.id);
              const currentRead: PersonalAgentReadIdentity = {
                agentId: agent.id,
                sequence: activityReadSequenceRef.current.get(agent.id) ?? 0,
                collectionRevision: collectionRevisionRef.current,
                scope: draftScopeRef.current
              };
              return updates.includes(agent.id) &&
                read &&
                personalAgentReadIsCurrent(read, currentRead) &&
                selectedIdRef.current !== agent.id
                ? withPersonalAgentActivitySummary(
                    agent,
                    unavailablePersonalAgentActivity(agent.id)
                  )
                : agent;
            });
          });
          setActivityErrors((current) => {
            if (
              controller.signal.aborted ||
              revision !== collectionRevisionRef.current ||
              !samePersonalAgentScope(scope, draftScopeRef.current) ||
              mutationInFlightRef.current
            ) {
              return current;
            }
            const next = new Set(current);
            for (const id of updates) next.add(id);
            return next;
          });
        }
      }
      if (!controller.signal.aborted) {
        nextRefresh = window.setTimeout(
          () => setActivityRefreshKey((value) => value + 1),
          60_000
        );
      }
    };
    void scan();
    return () => {
      if (nextRefresh !== undefined) window.clearTimeout(nextRefresh);
      controller.abort();
    };
  }, [api, activityRefreshKey, collectionRevision, loadState, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const agent = agentsRef.current.find(
      (candidate) => candidate.id === selectedId
    );
    if (!agent) return;
    const sequence = ++detailSequenceRef.current;
    const controller = new AbortController();
    const revision = collectionRevisionRef.current;
    const scope = draftScopeRef.current;
    let requestInFlight = false;
    const refresh = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      const readSequence =
        (activityReadSequenceRef.current.get(selectedId) ?? 0) + 1;
      activityReadSequenceRef.current.set(selectedId, readSequence);
      const read: PersonalAgentReadIdentity = {
        agentId: selectedId,
        sequence: readSequence,
        collectionRevision: revision,
        scope
      };
      try {
        const detail = await api.get(selectedId, controller.signal);
        if (
          !controller.signal.aborted &&
          sequence === detailSequenceRef.current &&
          personalAgentReadIsCurrent(read, {
            agentId: selectedId,
            sequence: activityReadSequenceRef.current.get(selectedId) ?? 0,
            collectionRevision: collectionRevisionRef.current,
            scope: draftScopeRef.current
          }) &&
          !mutationInFlightRef.current
        ) {
          setSelectedDetail((current) =>
            sequence === detailSequenceRef.current &&
            selectedIdRef.current === selectedId &&
            personalAgentReadIsCurrent(read, {
              agentId: selectedId,
              sequence: activityReadSequenceRef.current.get(selectedId) ?? 0,
              collectionRevision: collectionRevisionRef.current,
              scope: draftScopeRef.current
            })
              ? mergePersonalAgentRefresh(
                  current?.id === selectedId ? current : agent,
                  detail
                )
              : current
          );
          setAgents((current) => {
            if (
              sequence !== detailSequenceRef.current ||
              selectedIdRef.current !== selectedId ||
              !personalAgentReadIsCurrent(read, {
                agentId: selectedId,
                sequence: activityReadSequenceRef.current.get(selectedId) ?? 0,
                collectionRevision: collectionRevisionRef.current,
                scope: draftScopeRef.current
              })
            ) {
              return current;
            }
            return current.map((candidate) =>
              candidate.id === selectedId
                ? mergePersonalAgentRefresh(candidate, detail)
                : candidate
            );
          });
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
          personalAgentReadIsCurrent(read, {
            agentId: selectedId,
            sequence: activityReadSequenceRef.current.get(selectedId) ?? 0,
            collectionRevision: collectionRevisionRef.current,
            scope: draftScopeRef.current
          }) &&
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
    jobsReadSequenceRef.current += 1;
    jobsAbortControllerRef.current?.abort();
    jobsAbortControllerRef.current = null;
    jobsLoadingRef.current = false;
    // Reset status owned by the previous selected Agent and auth scope.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setJobsLoading(false);
    setJobsError(null);
    return () => {
      jobsReadSequenceRef.current += 1;
      jobsAbortControllerRef.current?.abort();
      jobsAbortControllerRef.current = null;
      jobsLoadingRef.current = false;
    };
  }, [selectedId, collectionRevision]);

  const loadMoreJobs = useCallback(async () => {
    const agent = selected;
    const id = selectedId;
    const before = agent?.jobsNextCursor;
    if (!agent || !id || agent.id !== id || !before || jobsLoadingRef.current)
      return;

    const controller = new AbortController();
    jobsAbortControllerRef.current?.abort();
    jobsAbortControllerRef.current = controller;
    jobsLoadingRef.current = true;
    const sequence = ++jobsReadSequenceRef.current;
    const revision = collectionRevisionRef.current;
    const scope = draftScopeRef.current;
    const read: PersonalAgentReadIdentity = {
      agentId: id,
      sequence,
      collectionRevision: revision,
      scope
    };
    setJobsLoading(true);
    setJobsError(null);

    const isCurrent = () =>
      !controller.signal.aborted &&
      selectedIdRef.current === id &&
      selectedAgentRef.current?.jobsNextCursor === before &&
      !mutationInFlightRef.current &&
      personalAgentReadIsCurrent(read, {
        agentId: id,
        sequence: jobsReadSequenceRef.current,
        collectionRevision: collectionRevisionRef.current,
        scope: draftScopeRef.current
      });

    try {
      const page = await api.getJobs(id, before, controller.signal);
      if (page.hasMore && (!page.nextCursor || page.nextCursor === before)) {
        throw new Error(
          "The agent service returned invalid job history paging."
        );
      }
      if (!isCurrent()) return;
      setSelectedDetail((current) =>
        isCurrent() && current?.id === id && current.jobsNextCursor === before
          ? mergePersonalAgentJobPage(current, page)
          : current
      );
      setAgents((current) => {
        if (!isCurrent()) return current;
        return current.map((candidate) =>
          candidate.id === id && candidate.jobsNextCursor === before
            ? mergePersonalAgentJobPage(candidate, page)
            : candidate
        );
      });
    } catch (reason) {
      if (isCurrent()) {
        setJobsError(
          reason instanceof Error
            ? reason.message
            : "Older Job history is unavailable."
        );
      }
    } finally {
      if (jobsAbortControllerRef.current === controller) {
        jobsAbortControllerRef.current = null;
        jobsLoadingRef.current = false;
        if (isCurrent()) setJobsLoading(false);
      }
    }
  }, [api, selected, selectedId]);

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
      setSelectedDetail((current) => mergePersonalAgentRefresh(current, next));
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
      setSelectedDetail((current) => mergePersonalAgentRefresh(current, next));
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
      setSelectedDetail((current) =>
        mergePersonalAgentRefresh(current, restored)
      );
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
    .map((agent) => ({ agent, work: verifiedAgentWork(agent, clockNow) }))
    .filter(({ work }) => work.status === "working");
  const unknownActivityAgents = activityOverviewAgents.filter(
    (agent) => verifiedAgentWork(agent, clockNow).status === "unknown"
  );
  const unavailableActivityCount = unknownActivityAgents.filter(
    (agent) =>
      unknownActivityLabel(agent, activityErrors.has(agent.id), clockNow) ===
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
                <div
                  className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label="Agents currently working"
                  tabIndex={0}
                >
                  {workingAgents.map(({ agent, work }) => (
                    <WorkingAgentCard
                      key={agent.id}
                      agent={agent}
                      jobs={work.jobs}
                      jobCount={work.count ?? 0}
                      liveJobs={work.liveJobs ?? undefined}
                      liveJobsCount={work.liveJobsCount}
                      liveJobsTruncated={work.liveJobsTruncated}
                      onOpenProfile={() => setSelectedId(agent.id)}
                      onOpenConversation={onOpenConversation}
                    />
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
                    const projectEngagements = projectEngagementsForCard(
                      agent,
                      activityErrors.has(agent.id)
                    );
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
                          {projectEngagements.state === "checking" ? (
                            <p className="mt-1.5 text-xs text-subtle">
                              {agent.lifecycle === "retired" &&
                              selectedId !== agent.id
                                ? "Select to load Project engagements."
                                : "Project activity is being checked."}
                            </p>
                          ) : projectEngagements.state === "unknown" ? (
                            <p className="mt-1.5 text-xs text-subtle">
                              Select to load Project engagements.
                            </p>
                          ) : projectEngagements.state === "unavailable" ? (
                            <p className="mt-1.5 text-xs text-subtle">
                              {projectEngagements.source === "detail"
                                ? "Project engagements are unavailable."
                                : "Project activity is unavailable."}
                            </p>
                          ) : projectEngagements.state === "empty" ? (
                            <p className="mt-1.5 text-xs text-subtle">
                              No active project engagements.
                            </p>
                          ) : (
                            <div className="mt-1.5 space-y-1.5">
                              {projectEngagements.projects.map((project) => (
                                <div
                                  key={project.id}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-hover/50 px-2.5 py-1.5"
                                >
                                  <span className="truncate text-xs font-medium text-foreground-secondary">
                                    {project.name}
                                  </span>
                                  <span className="flex-shrink-0 truncate text-[11px] text-subtle">
                                    {projectEngagements.source === "detail"
                                      ? `${settingLabel(project.model)} · ${settingLabel(project.effort)}`
                                      : settingLabel(project.status)}
                                  </span>
                                </div>
                              ))}
                              {projectEngagements.hasMore && (
                                <p className="px-1 text-[11px] text-subtle">
                                  Open profile to view Project engagements.
                                </p>
                              )}
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
            jobsLoading={jobsLoading}
            jobsError={jobsError}
            onLoadMoreJobs={loadMoreJobs}
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
