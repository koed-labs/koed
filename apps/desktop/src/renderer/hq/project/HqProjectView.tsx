import {
  Check,
  ChevronDown,
  ArrowUpRight,
  Folder,
  ListTodo,
  GitMerge,
  Plus,
  RotateCw,
  Sparkles,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { createPortal } from "react-dom";
import type { Agent } from "@koed/shared/agent-contract";
import { Pixelkin } from "../agents/Pixelkin.js";
import type { AgentsDesktopApi } from "../../../ipc/agents-protocol.js";
import type { Project } from "@koed/shared/project-contract";
import type { WorkItem } from "@koed/shared/work-item-contract";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type {
  CuratedAssertion,
  CuratedMemoryDesktopApi
} from "../../../ipc/curated-memory-protocol.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationListEntry,
  ManagedConversationRuntimeItem
} from "../../../ipc/managed-conversation-protocol.js";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { ManagedConversationLifecycle } from "../../state/use-managed-conversation-lifecycle.js";
import { hqRuntimeItemTitle } from "../conversation/hq-runtime-item-title.js";
import { projectNavigation } from "../project-navigation.js";
import { nowInspectableExecutions, type NowNeed } from "../now/now-model.js";
import { HqProjectSources } from "./HqProjectSources.js";
import { HqLearnedToday } from "./HqLearnedToday.js";
import { HqProjectPullRequests } from "./HqProjectPullRequests.js";
import { WhatKoedKnows } from "../memory/WhatKoedKnows.js";
import { ExecutionMemoryChips } from "../memory/ExecutionMemoryChips.js";
import { latestRuntimeTurn } from "../memory/execution-memory-chips.js";
import { SharedProjectPanel } from "../shared-project/SharedProjectPanel.js";
import { SharedProjectSources } from "../shared-project/SharedProjectSources.js";
import type {
  SharedProjectStore,
  SharedProjectSnapshot
} from "../shared-project/shared-project-store.js";
import {
  parseWorkItemInput,
  projectWorkItemSections,
  safeWorkItemPrUrl,
  viewerTimeZone
} from "./hq-work-item-model.js";
import { HqDueControl } from "../due/HqDueControl.js";
import "./hq-project-view.css";

type HqSummary = Awaited<ReturnType<ProjectsDesktopApi["hq"]>>;
const subscribeNoShared = () => () => {};
const noSharedSnapshot = (): SharedProjectSnapshot | null => null;
type Inventory = {
  projectsApi: ProjectsDesktopApi | null;
  conversationsApi: ManagedConversationDesktopApi | null;
  ownerId: string | null;
  profileKey: string | null;
  projectId: string | null;
  summary: HqSummary | null;
  workItems: WorkItem[];
  workItemsLoaded: boolean;
  hasRepoSource: boolean;
  executions: ManagedConversationListEntry[];
  runtime: Map<string, readonly ManagedConversationRuntimeItem[]>;
  runtimeGenerations: Map<string, number>;
  error: string;
  complete: boolean;
};
const emptyInventory = (): Inventory => ({
  projectsApi: null,
  conversationsApi: null,
  ownerId: null,
  profileKey: null,
  projectId: null,
  summary: null,
  workItems: [],
  workItemsLoaded: false,
  hasRepoSource: false,
  executions: [],
  runtime: new Map(),
  runtimeGenerations: new Map(),
  error: "",
  complete: false
});
const activeStates = new Set([
  "starting",
  "running",
  "reconciling",
  "quiesce_requested",
  "quiesced"
]);
const cap = { need: 4, doing: 4, todo: 5, review: 4, done: 3 } as const;

/** Runtime project IDs are technical IDs; the Project route is a Personal Project ID. */
export function projectHqExecutionBelongsTo(
  execution: ManagedConversationListEntry,
  projectId: string,
  projects: readonly Project[],
  graphProjects: readonly DesktopProject[]
): boolean {
  if (execution.projectId === projectId) return true;
  if (!execution.sessionId) return false;
  return (
    projectNavigation(projects, graphProjects)
      .projects.find((row) => row.id === projectId)
      ?.conversations.some(
        ({ technicalProjectId, thread }) =>
          technicalProjectId === execution.projectId &&
          thread.sessionId === execution.sessionId
      ) ?? false
  );
}

export function HqProjectView({
  project,
  personalProjects,
  graphProjects,
  projectsApi,
  focusWorkItemId,
  onFocusWorkItemHandled,
  curatedMemoryApi,
  agentsApi,
  conversationsApi,
  managedProject,
  lifecycle,
  ownerId,
  profileKey,
  ownedAgents,
  panelHost,
  onSourcesOpenChange,
  onContextChange,
  onMakeWorkItems,
  chiefName,
  closeSignal,
  onSelectConversation,
  onOpenPrivateHq,
  onOpenCitationMessage,
  blockedConversationSessions,
  onConversationAgentsChange,
  sharedProjectStore,
  deleteSharedProjectSource,
  onShareProject,
  sharedRefreshSignal = 0
}: {
  project: Project;
  personalProjects: readonly Project[];
  graphProjects: readonly DesktopProject[];
  projectsApi: ProjectsDesktopApi;
  focusWorkItemId?: string | null;
  onFocusWorkItemHandled?: () => void;
  curatedMemoryApi?: CuratedMemoryDesktopApi | null;
  agentsApi?: AgentsDesktopApi | null;
  conversationsApi?: ManagedConversationDesktopApi | null;
  managedProject?: ManagedProjectDesktopApi | null;
  lifecycle?: ManagedConversationLifecycle;
  ownerId?: string | null;
  profileKey?: string | null;
  ownedAgents?: readonly { id: string; name: string }[];
  panelHost?: HTMLElement | null;
  onSourcesOpenChange?: (open: boolean) => void;
  onContextChange?: (label: string | null) => void;
  onMakeWorkItems?: (
    source: { id: string; name: string },
    kind: "tickets" | "to-dos"
  ) => void;
  chiefName?: string;
  closeSignal?: number;
  onSelectConversation: (need: NowNeed) => void;
  onOpenPrivateHq?: () => void;
  onOpenCitationMessage?: (
    target: NonNullable<
      import("../../../ipc/managed-conversation-protocol.js").ManagedConversationTurnCitation["messageTarget"]
    >
  ) => Promise<boolean>;
  blockedConversationSessions?: ReadonlySet<string>;
  onConversationAgentsChange?: (
    projectId: string,
    bySession: Readonly<Record<string, string>>
  ) => void;
  sharedProjectStore?: SharedProjectStore | null;
  deleteSharedProjectSource?: CollaborationRendererClient["deleteWorkspaceProjectSource"];
  onShareProject?: () => void;
  sharedRefreshSignal?: number;
}) {
  const linked = Boolean(project.workspaceProjectId);
  const sharedIdentity =
    ownerId && profileKey && project.workspaceProjectId && project.teamBackendId
      ? {
          ownerId,
          profileKey,
          personalProjectId: project.id,
          workspaceProjectId: project.workspaceProjectId,
          teamBackendId: project.teamBackendId
        }
      : null;
  const [inventory, setInventory] = useState<Inventory>(emptyInventory);
  const [mergeRequestedItemId, setMergeRequestedItemId] = useState<
    string | null
  >(null);
  const [needsPrCount, setNeedsPrCount] = useState(0);
  const [reviewCountState, setReviewCountState] = useState({
    identity: "",
    count: 0
  });
  const reviewIdentity = `${ownerId ?? ""}:${profileKey ?? ""}:${project.id}`;
  const reviewPrCount =
    reviewCountState.identity === reviewIdentity ? reviewCountState.count : 0;
  const [coveredReviewState, setCoveredReviewState] = useState<{
    identity: string;
    ids: readonly string[];
  }>({ identity: "", ids: [] });
  const onCoveredReviewItems = useCallback(
    (ids: readonly string[]) =>
      setCoveredReviewState((previous) =>
        previous.identity === reviewIdentity &&
        previous.ids.join(",") === ids.join(",")
          ? previous
          : { identity: reviewIdentity, ids }
      ),
    [reviewIdentity]
  );
  const onReviewCount = useCallback(
    (count: number) =>
      setReviewCountState((previous) =>
        previous.identity === reviewIdentity && previous.count === count
          ? previous
          : { identity: reviewIdentity, count }
      ),
    [reviewIdentity]
  );
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [sourceCloseSignal, setSourceCloseSignal] = useState(0);
  const [memoryCountState, setMemoryCountState] = useState<{
    key: number;
    count: string | null;
  }>({ key: -1, count: null });
  const [memoryRevision, setMemoryRevision] = useState(0);
  const [memorySelection, setMemorySelection] = useState<{
    key: number;
    id: number;
    item: CuratedAssertion;
  } | null>(null);
  const memorySelectionId = useRef(0);
  const [learnedState, setLearnedState] = useState<{
    key: number;
    count: number | null;
  }>({ key: -1, count: null });
  const memoryIdentity = useRef({
    api: curatedMemoryApi,
    ownerId,
    profileKey,
    projectId: project.id,
    key: 0
  });
  const previousMemoryIdentity = memoryIdentity.current;
  if (
    previousMemoryIdentity.api !== curatedMemoryApi ||
    previousMemoryIdentity.ownerId !== ownerId ||
    previousMemoryIdentity.profileKey !== profileKey ||
    previousMemoryIdentity.projectId !== project.id
  ) {
    memoryIdentity.current = {
      api: curatedMemoryApi,
      ownerId,
      profileKey,
      projectId: project.id,
      key: previousMemoryIdentity.key + 1
    };
  }
  const memoryKey = memoryIdentity.current.key;
  const memoryCount =
    memoryCountState.key === memoryKey ? memoryCountState.count : null;
  useEffect(() => {
    if (!curatedMemoryApi) return;
    let current = true;
    setMemoryCountState({ key: memoryKey, count: null });
    void curatedMemoryApi
      .page("project", project.id)
      .then((page) => {
        if (current && memoryIdentity.current.key === memoryKey)
          setMemoryCountState({
            key: memoryKey,
            count: `${page.assertions.length}${page.nextCursor ? "+" : ""}`
          });
      })
      .catch(() => {
        if (current && memoryIdentity.current.key === memoryKey)
          setMemoryCountState({ key: memoryKey, count: null });
      });
    return () => {
      current = false;
    };
  }, [
    curatedMemoryApi,
    project.id,
    ownerId,
    profileKey,
    memoryRevision,
    memoryKey
  ]);
  useEffect(() => {
    if (closeSignal) setMemoryOpen(false);
  }, [closeSignal]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [folded, setFolded] = useState({
    need: false,
    doing: false,
    todo: false,
    review: false,
    done: false
  });
  const [expanded, setExpanded] = useState({
    need: false,
    doing: false,
    todo: false,
    review: false,
    done: false
  });
  const [draft, setDraft] = useState("");
  const [workError, setWorkError] = useState("");
  const [workPending, setWorkPending] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [delegationState, setDelegationState] = useState<{
    identity: string;
    items: Awaited<ReturnType<AgentsDesktopApi["delegations"]>>;
  }>({ identity: "", items: [] });
  const delegationIdentity = `${ownerId ?? ""}:${profileKey ?? ""}:${project.id}`;
  const delegations =
    delegationState.identity === delegationIdentity
      ? delegationState.items
      : [];
  const [sendFor, setSendFor] = useState<string | null>(null);
  const [dueFor, setDueFor] = useState<string | null>(null);
  const [briefFor, setBriefFor] = useState<string | null>(null);
  const [memoryPanelRow, setMemoryPanelRow] = useState<string | null>(null);
  const intent = useRef({
    projectId: project.id,
    ownerId,
    profileKey,
    api: projectsApi,
    agentsApi,
    conversationsApi,
    generation: 0
  });
  if (
    intent.current.projectId !== project.id ||
    intent.current.ownerId !== ownerId ||
    intent.current.profileKey !== profileKey ||
    intent.current.api !== projectsApi ||
    intent.current.agentsApi !== agentsApi ||
    intent.current.conversationsApi !== conversationsApi
  ) {
    intent.current = {
      projectId: project.id,
      ownerId,
      profileKey,
      api: projectsApi,
      agentsApi,
      conversationsApi,
      generation: intent.current.generation + 1
    };
  }
  const idempotency = useRef<{
    generation: number;
    draft: string;
    key: string;
    title: string;
    dueOn: string | null;
  } | null>(null);
  useEffect(
    () => () => {
      intent.current.generation += 1;
    },
    []
  );
  useEffect(() => {
    setBriefFor(null);
    setSendFor(null);
    setDueFor(null);
    setMemoryPanelRow(null);
  }, [closeSignal]);
  useEffect(() => {
    setDraft("");
    setWorkError("");
    setWorkPending(false);
    setAgents([]);
    setDelegationState({ identity: "", items: [] });
    setSendFor(null);
    setDueFor(null);
    setBriefFor(null);
    setMemoryPanelRow(null);
    setFolded({
      need: false,
      doing: false,
      todo: false,
      review: false,
      done: false
    });
    setExpanded({
      need: false,
      doing: false,
      todo: false,
      review: false,
      done: false
    });
    idempotency.current = null;
  }, [
    project.id,
    ownerId,
    profileKey,
    projectsApi,
    agentsApi,
    conversationsApi
  ]);
  const draftIds = [...(lifecycle?.drafts.keys() ?? [])].sort().join("\u0000");
  useEffect(() => {
    let live = true;
    if (!agentsApi) return;
    void agentsApi
      .list()
      .then((rows) => {
        if (live) setAgents(rows);
      })
      .catch(() => {
        if (live) setAgents([]);
      });
    return () => {
      live = false;
    };
  }, [agentsApi, project.id, ownerId, profileKey]);
  useEffect(() => {
    if (!agentsApi || !ownerId || !profileKey) return;
    let live = true;
    const load = () =>
      void agentsApi
        .delegations(project.id)
        .then((items) => {
          if (
            live &&
            intent.current.ownerId === ownerId &&
            intent.current.profileKey === profileKey &&
            intent.current.projectId === project.id
          )
            setDelegationState({ identity: delegationIdentity, items });
        })
        .catch(() => {
          if (live)
            setDelegationState({ identity: delegationIdentity, items: [] });
        });
    load();
    const notified = (event: Event) => {
      if (
        (event as CustomEvent<{ projectId: string }>).detail?.projectId ===
        project.id
      ) {
        load();
        setRefresh((value) => value + 1);
      }
    };
    window.addEventListener("hq-agent-delegated", notified);
    const timer = window.setInterval(load, 10_000);
    return () => {
      live = false;
      window.removeEventListener("hq-agent-delegated", notified);
      window.clearInterval(timer);
    };
  }, [agentsApi, project.id, ownerId, profileKey, delegationIdentity]);
  useEffect(() => {
    if (!sendFor) return;
    const focusFrame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `.hq-project-view__send-wrap:has([data-work-send-id="${sendFor}"]) [role="menuitem"]`
        )
        ?.focus();
    });
    const dismiss = (event: MouseEvent) => {
      if (!(event.target as Element).closest(".hq-project-view__send-wrap"))
        setSendFor(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      document
        .querySelector<HTMLElement>(`[data-work-send-id="${sendFor}"]`)
        ?.focus();
      setSendFor(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [sendFor]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setRefresh((value) => value + 1);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    const generation = intent.current.generation;
    setLoading(true);
    void (async () => {
      const [hq, listed, workItemsResult, sourcesResult] =
        await Promise.allSettled([
          projectsApi.hq(project.id),
          conversationsApi?.list?.() ?? Promise.resolve(null),
          linked
            ? Promise.resolve([] as WorkItem[])
            : (projectsApi.workItemList?.(project.id) ??
              Promise.reject(new Error("Work Items unavailable"))),
          linked ? Promise.resolve([]) : projectsApi.sourceList(project.id)
        ]);
      if (!live || intent.current.generation !== generation) return;
      const summary =
        hq.status === "fulfilled" && hq.value.project.id === project.id
          ? hq.value
          : null;
      const inspected =
        listed.status === "fulfilled" && listed.value
          ? nowInspectableExecutions(listed.value.executions)
          : null;
      const executions = inspected
        ? inspected.executions.filter(
            (entry) =>
              activeStates.has(entry.state) &&
              !blockedConversationSessions?.has(
                `${entry.projectId}\u0000${entry.sessionId ?? ""}`
              ) &&
              projectHqExecutionBelongsTo(
                entry,
                project.id,
                personalProjects,
                graphProjects
              )
          )
        : [];
      const runtime = new Map<
        string,
        readonly ManagedConversationRuntimeItem[]
      >();
      const runtimeGenerations = new Map<string, number>();
      let runtimeFailed = false;
      for (let offset = 0; offset < executions.length; offset += 8) {
        const batch = executions.slice(offset, offset + 8);
        const results = await Promise.allSettled(
          batch.map((entry) => conversationsApi!.runtime(entry.executionId))
        );
        if (!live || intent.current.generation !== generation) return;
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            runtime.set(batch[index]!.executionId, result.value.items);
            runtimeGenerations.set(
              batch[index]!.executionId,
              result.value.executionGeneration
            );
          } else runtimeFailed = true;
        });
      }
      if (!live || intent.current.generation !== generation) return;
      setInventory({
        projectsApi,
        conversationsApi: conversationsApi ?? null,
        ownerId: ownerId ?? null,
        profileKey: profileKey ?? null,
        projectId: project.id,
        summary,
        workItems:
          workItemsResult.status === "fulfilled" ? workItemsResult.value : [],
        workItemsLoaded: workItemsResult.status === "fulfilled",
        hasRepoSource:
          sourcesResult.status === "fulfilled" &&
          sourcesResult.value.some((source) => source.kind === "repo"),
        executions,
        runtime,
        runtimeGenerations,
        complete: Boolean(
          listed.status === "fulfilled" &&
          listed.value?.complete &&
          !inspected?.unknownState &&
          !runtimeFailed
        ),
        error:
          workItemsResult.status === "rejected"
            ? "Work Items could not be loaded."
            : hq.status === "rejected" || !summary
              ? "Project activity could not be loaded."
              : listed.status === "rejected" ||
                  runtimeFailed ||
                  inspected?.unknownState
                ? "Some active Conversations could not be loaded."
                : listed.value && !listed.value.complete
                  ? "Recent Conversation inventory may be incomplete."
                  : ""
      });
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [
    projectsApi,
    conversationsApi,
    project.id,
    linked,
    ownerId,
    profileKey,
    refresh,
    draftIds,
    blockedConversationSessions,
    personalProjects,
    graphProjects
  ]);

  const visibleInventory =
    inventory.projectsApi === projectsApi &&
    inventory.conversationsApi === (conversationsApi ?? null) &&
    inventory.ownerId === (ownerId ?? null) &&
    inventory.profileKey === (profileKey ?? null) &&
    inventory.projectId === project.id
      ? inventory
      : emptyInventory();

  const needs = useMemo(
    () =>
      visibleInventory.executions
        .flatMap((execution) =>
          (visibleInventory.runtime.get(execution.executionId) ?? [])
            .filter(
              (item) =>
                item.state === "pending" &&
                !item.answered &&
                item.itemKind !== "transient_output"
            )
            .map(
              (item): NowNeed => ({
                id: `runtime:${execution.executionId}:${item.id}`,
                kind: item.itemKind === "user_input" ? "question" : "approval",
                title: hqRuntimeItemTitle(item),
                context: "Conversation",
                projectId: execution.projectId,
                sessionId: execution.sessionId ?? undefined,
                threadId: execution.threadId ?? undefined,
                executionId: execution.executionId,
                runtimeItemId: item.id,
                createdAt: item.createdAt
              })
            )
        )
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [visibleInventory]
  );
  const sharedSnapshot = useSyncExternalStore(
    sharedProjectStore?.subscribe ?? subscribeNoShared,
    sharedProjectStore?.current ?? noSharedSnapshot
  );
  const sharedActivity =
    linked &&
    sharedIdentity &&
    sharedSnapshot?.identity?.ownerId === sharedIdentity.ownerId &&
    sharedSnapshot.identity.profileKey === sharedIdentity.profileKey &&
    sharedSnapshot.identity.workspaceProjectId ===
      sharedIdentity.workspaceProjectId &&
    sharedSnapshot.identity.teamBackendId === sharedIdentity.teamBackendId
      ? sharedSnapshot.state?.activity
      : null;
  const activity = visibleInventory.summary?.activity?.lastSevenDays;
  const outcomes = linked ? sharedActivity : activity?.outcomes;
  const max = Math.max(1, ...(outcomes?.days.map(({ count }) => count) ?? [0]));
  const rows = {
    need: needs,
    doing: visibleInventory.executions
  };
  const timeZone = viewerTimeZone();
  const now = new Date();
  const work = projectWorkItemSections(
    visibleInventory.workItems,
    timeZone,
    now
  );
  const coveredReviewIds = new Set(
    coveredReviewState.identity === reviewIdentity ? coveredReviewState.ids : []
  );
  const fallbackReview = work.review.filter(
    (item) => !coveredReviewIds.has(item.id)
  );
  const totalReviewCount = reviewPrCount + fallbackReview.length;
  useEffect(() => {
    if (!onConversationAgentsChange) return;
    const bySession: Record<string, string> = {};
    for (const item of visibleInventory.workItems) {
      if (!item.executionId || !item.assigneeAgentId) continue;
      const execution = visibleInventory.executions.find(
        (entry) => entry.executionId === item.executionId
      );
      if (
        execution?.sessionId &&
        agents.some((agent) => agent.id === item.assigneeAgentId)
      )
        bySession[execution.sessionId] = item.assigneeAgentId;
    }
    if (
      linked &&
      sharedIdentity &&
      sharedSnapshot?.identity?.ownerId === sharedIdentity.ownerId &&
      sharedSnapshot.identity.profileKey === sharedIdentity.profileKey &&
      sharedSnapshot.identity.personalProjectId ===
        sharedIdentity.personalProjectId &&
      sharedSnapshot.identity.workspaceProjectId ===
        sharedIdentity.workspaceProjectId &&
      sharedSnapshot.identity.teamBackendId === sharedIdentity.teamBackendId
    ) {
      for (const binding of sharedSnapshot.dispatches) {
        const execution = visibleInventory.executions.find(
          (row) => row.executionId === binding.executionId
        );
        if (
          execution?.sessionId &&
          agents.some((agent) => agent.id === binding.agentId)
        )
          bySession[execution.sessionId] = binding.agentId;
      }
    }
    onConversationAgentsChange(project.id, bySession);
  }, [
    onConversationAgentsChange,
    project.id,
    visibleInventory,
    agents,
    linked,
    sharedIdentity?.ownerId,
    sharedIdentity?.profileKey,
    sharedIdentity?.personalProjectId,
    sharedIdentity?.workspaceProjectId,
    sharedIdentity?.teamBackendId,
    sharedSnapshot
  ]);
  const createTodo = async () => {
    const parsed = parseWorkItemInput(draft, timeZone, new Date());
    if (!parsed.title || workPending) return;
    const generation = intent.current.generation;
    const active = () => intent.current.generation === generation;
    if (
      !idempotency.current ||
      idempotency.current.generation !== generation ||
      idempotency.current.draft !== draft
    )
      idempotency.current = {
        generation,
        draft,
        key: crypto.randomUUID(),
        title: parsed.title,
        dueOn: parsed.due
      };
    const creation = idempotency.current;
    setWorkPending(true);
    setWorkError("");
    try {
      const created = await projectsApi.workItemCreate!(project.id, {
        kind: "todo",
        title: creation.title,
        goal: creation.title,
        origin: "manual",
        dueOn: creation.dueOn,
        idempotencyKey: creation.key
      });
      if (!active()) return;
      setInventory((current) =>
        current.projectId === project.id &&
        current.ownerId === (ownerId ?? null) &&
        current.profileKey === (profileKey ?? null) &&
        current.projectsApi === projectsApi
          ? {
              ...current,
              workItems: [
                created,
                ...current.workItems.filter((row) => row.id !== created.id)
              ]
            }
          : current
      );
      setDraft("");
      idempotency.current = null;
      setRefresh((value) => value + 1);
    } catch {
      if (active())
        setWorkError(
          "Could not add the to-do. Retry after checking Project access."
        );
    } finally {
      if (active()) setWorkPending(false);
    }
  };
  const markDone = async (item: WorkItem) => {
    if (workPending) return;
    const generation = intent.current.generation;
    const active = () => intent.current.generation === generation;
    setWorkPending(true);
    setWorkError("");
    try {
      const updated = await projectsApi.workItemPatch!(project.id, item.id, {
        version: item.version,
        action: "mark_done"
      });
      if (!active()) return;
      setInventory((current) =>
        current.projectId === project.id &&
        current.ownerId === (ownerId ?? null) &&
        current.profileKey === (profileKey ?? null) &&
        current.projectsApi === projectsApi
          ? {
              ...current,
              workItems: current.workItems.map((row) =>
                row.id === updated.id ? updated : row
              )
            }
          : current
      );
      setRefresh((value) => value + 1);
    } catch {
      if (active()) {
        setWorkError(
          "To-do changed before it could be ticked off. The list is refreshing."
        );
        setRefresh((value) => value + 1);
      }
    } finally {
      if (active()) setWorkPending(false);
    }
  };
  const setDue = async (item: WorkItem, dueOn: string | null) => {
    if (workPending || item.dueOn === dueOn || !projectsApi.workItemPatch)
      return;
    const generation = intent.current.generation;
    const active = () => intent.current.generation === generation;
    setWorkPending(true);
    setWorkError("");
    try {
      const updated = await projectsApi.workItemPatch(project.id, item.id, {
        version: item.version,
        dueOn
      });
      if (!active()) return;
      setInventory((current) =>
        current.projectId === project.id &&
        current.ownerId === (ownerId ?? null) &&
        current.profileKey === (profileKey ?? null) &&
        current.projectsApi === projectsApi
          ? {
              ...current,
              workItems: current.workItems.map((row) =>
                row.id === updated.id ? updated : row
              )
            }
          : current
      );
      setRefresh((value) => value + 1);
    } catch {
      if (active()) {
        setWorkError(
          "Due date changed before it could be saved. The list is refreshing."
        );
        setRefresh((value) => value + 1);
      }
    } finally {
      if (active()) setWorkPending(false);
    }
  };
  const backToTodo = async (item: WorkItem) => {
    if (workPending) return;
    const generation = intent.current.generation;
    const active = () => intent.current.generation === generation;
    setWorkPending(true);
    setWorkError("");
    try {
      const updated = await projectsApi.workItemPatch!(project.id, item.id, {
        version: item.version,
        action: "back_to_todo"
      });
      if (!active()) return;
      setInventory((current) =>
        current.projectId === project.id &&
        current.ownerId === (ownerId ?? null) &&
        current.profileKey === (profileKey ?? null) &&
        current.projectsApi === projectsApi
          ? {
              ...current,
              workItems: current.workItems.map((row) =>
                row.id === updated.id ? updated : row
              )
            }
          : current
      );
      setRefresh((value) => value + 1);
    } catch {
      if (active()) {
        setWorkError(
          "Work Item changed before it could be moved. The list is refreshing."
        );
        setRefresh((value) => value + 1);
      }
    } finally {
      if (active()) setWorkPending(false);
    }
  };
  const sendToAgent = async (item: WorkItem, agent: Agent) => {
    if (!projectsApi.workItemDispatch || workPending) return;
    const generation = intent.current.generation;
    const active = () => intent.current.generation === generation;
    setWorkPending(true);
    setWorkError("");
    setSendFor(null);
    try {
      const result = await projectsApi.workItemDispatch(
        project.id,
        item.id,
        agent.id,
        item.version,
        Boolean(
          item.executionId &&
          (item.status === "doing" || item.status === "review")
        )
      );
      if (!active()) return;
      setInventory((current) =>
        current.projectId === project.id &&
        current.ownerId === (ownerId ?? null) &&
        current.profileKey === (profileKey ?? null) &&
        current.projectsApi === projectsApi
          ? {
              ...current,
              workItems: current.workItems.map((row) =>
                row.id === item.id && row.version <= result.item.version
                  ? result.item
                  : row
              )
            }
          : current
      );
      if (result.stopPending)
        setWorkError(
          "Stopping the previous Agent. Send again after this Work Item shows as blocked."
        );
      else {
        if (
          result.reused &&
          (item.status === "doing" || item.status === "review")
        )
          openWorkItem(result.item);
        else {
          setMemoryOpen(false);
          setSourceCloseSignal((value) => value + 1);
          setBriefFor(item.id);
          onSourcesOpenChange?.(true);
        }
      }
      setRefresh((value) => value + 1);
    } catch (error) {
      if (active()) {
        setWorkError(
          error instanceof Error
            ? error.message
            : "Work Item could not be sent."
        );
        setRefresh((value) => value + 1);
      }
    } finally {
      if (active()) setWorkPending(false);
    }
  };
  const canOpen = (entry: {
    projectId?: string | null;
    sessionId?: string | null;
    threadId?: string | null;
  }) =>
    entry.projectId === project.id ||
    Boolean(
      entry.projectId &&
      entry.sessionId &&
      entry.threadId &&
      graphProjects.some(({ id }) => id === entry.projectId)
    );
  const open = (entry: NowNeed) => {
    if (entry.projectId === project.id) onOpenPrivateHq?.();
    else if (canOpen(entry)) onSelectConversation(entry);
  };
  const sendControl = (item: WorkItem) => (
    <span className="hq-project-view__send-wrap">
      <button
        type="button"
        className="hq-project-view__send"
        data-work-send-id={item.id}
        aria-label={`Send ${item.title} to an Agent`}
        aria-expanded={sendFor === item.id}
        disabled={workPending || !agentsApi}
        onClick={() => setSendFor(sendFor === item.id ? null : item.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setSendFor(item.id);
        }}
      >
        <ArrowUpRight size={15} />
      </button>
      {sendFor === item.id ? (
        <span className="hq-project-view__send-menu" role="menu">
          <b>
            {item.status === "blocked"
              ? "Retry or send to someone else"
              : item.executionId
                ? "Send to someone else"
                : "Send to an Agent"}
          </b>
          {agents.length ? (
            agents.map((agent) => (
              <button
                type="button"
                role="menuitem"
                key={agent.id}
                onClick={() => void sendToAgent(item, agent)}
              >
                <Pixelkin
                  agent={agent}
                  size={25}
                  className="hq-project-view__agent-initial"
                />
                <span className="hq-project-view__agent-name">
                  {agent.name}
                </span>
                <small>
                  {item.status === "blocked" &&
                  item.assigneeAgentId === agent.id
                    ? "Retry"
                    : agent.role || "Agent"}
                </small>
              </button>
            ))
          ) : (
            <small>No available Agents</small>
          )}
        </span>
      ) : null}
    </span>
  );
  const dueContext = (item: WorkItem) => ({
    tabIndex: 0,
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      setSendFor(null);
      setDueFor(item.id);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (
        event.key !== "ContextMenu" &&
        !(event.shiftKey && event.key === "F10")
      )
        return;
      event.preventDefault();
      setSendFor(null);
      setDueFor(item.id);
    }
  });
  const dueControl = (item: WorkItem, onSend?: () => void) => (
    <HqDueControl
      title={item.title}
      dueOn={item.dueOn}
      timeZone={timeZone}
      now={now}
      open={dueFor === item.id}
      onOpenChange={(open) => setDueFor(open ? item.id : null)}
      onSelect={(dueOn) => setDue(item, dueOn)}
      onSend={onSend}
      disabled={
        workPending ||
        !visibleInventory.workItemsLoaded ||
        item.status === "done"
      }
    />
  );
  const openWorkItem = (item: WorkItem) => {
    setMemoryPanelRow(null);
    setMemoryOpen(false);
    setSourceCloseSignal((value) => value + 1);
    setBriefFor(item.id);
    onSourcesOpenChange?.(true);
    const execution = visibleInventory.executions.find(
      (row) => row.executionId === item.executionId
    );
    if (!execution?.sessionId || !execution.threadId) return;
    const graphProject = graphProjects.find((candidate) =>
      candidate.threads.some((thread) => thread.id === execution.threadId)
    );
    if (!graphProject) return;
    onSelectConversation({
      id: `work-item:${item.id}`,
      kind: "question",
      title: item.title,
      context: project.name,
      projectId: graphProject.id,
      sessionId: execution.sessionId,
      threadId: execution.threadId,
      executionId: execution.executionId,
      createdAt: item.updatedAt
    });
  };
  useEffect(() => {
    if (linked) return;
    if (!focusWorkItemId || !visibleInventory.workItemsLoaded) return;
    const item = visibleInventory.workItems.find(
      (row) => row.id === focusWorkItemId
    );
    if (!item) return;
    openWorkItem(item);
    onFocusWorkItemHandled?.();
  }, [focusWorkItemId, visibleInventory, linked]);
  const openMemoryPanel = (rowKey: string) => {
    setMemoryPanelRow(rowKey);
    setMemoryOpen(false);
    setBriefFor(null);
    setSourceCloseSignal((value) => value + 1);
    onSourcesOpenChange?.(true);
    onContextChange?.("Memory sources");
  };
  const closeMemoryPanel = () => {
    setMemoryPanelRow(null);
    onSourcesOpenChange?.(false);
    onContextChange?.(null);
  };
  const selectedBrief =
    visibleInventory.workItems.find((item) => item.id === briefFor) ?? null;
  const sectionHead = (
    kind: keyof typeof cap,
    label: string,
    count: number
  ) => (
    <button
      type="button"
      className="hq-project-view__section-head"
      aria-expanded={!folded[kind]}
      onClick={() => setFolded((value) => ({ ...value, [kind]: !value[kind] }))}
    >
      <ChevronDown size={14} aria-hidden="true" />
      <i aria-hidden="true" />
      {label}
      <span>{count}</span>
    </button>
  );
  return (
    <div className="hq-project-view" aria-label={`${project.name} HQ`}>
      <header className="hq-project-view__header">
        <div className="hq-project-view__identity">
          <h1>{project.name}</h1>
          {project.folderPath ? (
            <span title={project.folderPath}>{project.folderPath}</span>
          ) : null}
        </div>
        {outcomes ? (
          <div
            className="hq-project-view__activity"
            title="Work Items completed and pull requests merged each day, last seven UTC days"
          >
            <span className="hq-project-view__spark" aria-hidden="true">
              {outcomes.days.map(({ date, count }) => (
                <i
                  key={date}
                  style={{
                    height: `${Math.max(3, Math.round((count / max) * 21))}px`
                  }}
                />
              ))}
            </span>
            <span>
              <b>{outcomes.done}</b> done this week · <b>{outcomes.merged}</b>{" "}
              merged
            </span>
          </div>
        ) : (
          <span className="hq-project-view__unavailable">
            Done and merged unavailable
          </span>
        )}
        <button
          type="button"
          className="hq-project-view__shared"
          onClick={onShareProject}
          disabled={!onShareProject}
          aria-label={
            linked ? "View who is in this shared Project" : "Share Project"
          }
        >
          {linked ? "HQ Shared" : "Share"}
        </button>
      </header>
      <div className="hq-project-view__keys">
        {linked && sharedIdentity && sharedProjectStore ? (
          <SharedProjectSources
            store={sharedProjectStore}
            identity={sharedIdentity}
            deleteSource={deleteSharedProjectSource}
            panelHost={panelHost}
            onOpenChange={(value) => {
              if (value) {
                setMemoryPanelRow(null);
                setMemoryOpen(false);
                setBriefFor(null);
                onSourcesOpenChange?.(true);
              } else if (!memoryOpen && !briefFor && !memoryPanelRow) {
                onSourcesOpenChange?.(false);
              }
            }}
            onContextChange={(label) => {
              if (!memoryOpen) onContextChange?.(label);
            }}
            closeSignal={(closeSignal ?? 0) + sourceCloseSignal}
          />
        ) : !linked ? (
          <HqProjectSources
            projectId={project.id}
            projectName={project.name}
            api={projectsApi}
            visibilityOwnerId={ownerId}
            visibilityProfileKey={profileKey}
            panelHost={panelHost}
            onOpenChange={(value) => {
              if (value) {
                setMemoryPanelRow(null);
                setMemoryOpen(false);
                setBriefFor(null);
                onSourcesOpenChange?.(true);
              } else if (!memoryOpen && !briefFor && !memoryPanelRow) {
                onSourcesOpenChange?.(false);
              }
            }}
            onContextChange={(label) => {
              if (!memoryOpen) onContextChange?.(label);
            }}
            onMakeWorkItems={onMakeWorkItems}
            chiefName={chiefName}
            closeSignal={(closeSignal ?? 0) + sourceCloseSignal}
          />
        ) : null}
        {curatedMemoryApi ? (
          <button
            type="button"
            className="hq-project-view__memory"
            aria-label="What Koed knows"
            onClick={() => {
              setMemorySelection(null);
              setSourceCloseSignal((value) => value + 1);
              setMemoryOpen(true);
              setMemoryPanelRow(null);
              setBriefFor(null);
              onSourcesOpenChange?.(true);
              onContextChange?.("What Koed knows");
            }}
          >
            <Sparkles size={14} />{" "}
            {memoryCount === null ? "Memory" : `${memoryCount} in memory`}
          </button>
        ) : (
          <span className="hq-project-view__memory">Memory unavailable</span>
        )}
      </div>
      {curatedMemoryApi && (
        <WhatKoedKnows
          api={curatedMemoryApi}
          project={project}
          projects={personalProjects}
          ownerId={ownerId ?? null}
          profileKey={profileKey ?? null}
          ownedAgents={ownedAgents}
          panelHost={panelHost}
          open={memoryOpen}
          openRequest={
            memorySelection?.key === memoryKey ? memorySelection : null
          }
          onChanged={() => setMemoryRevision((value) => value + 1)}
          onClose={() => {
            setMemoryOpen(false);
            setMemorySelection(null);
            onSourcesOpenChange?.(false);
            onContextChange?.(null);
          }}
        />
      )}
      {visibleInventory.error ? (
        <p className="hq-project-view__error" role="alert">
          {visibleInventory.error}{" "}
          <button
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RotateCw size={13} /> Retry
          </button>
        </p>
      ) : null}
      {linked && sharedIdentity && sharedProjectStore ? (
        <SharedProjectPanel
          store={sharedProjectStore}
          identity={sharedIdentity}
          refreshSignal={sharedRefreshSignal}
          agents={agents}
          conversationsApi={conversationsApi}
          managedProject={managedProject}
          panelHost={panelHost}
          activeMemoryRow={memoryPanelRow}
          onMemoryOpen={openMemoryPanel}
          onMemoryClose={closeMemoryPanel}
          onOpenCitationMessage={onOpenCitationMessage}
          focusWorkItemId={focusWorkItemId}
          onFocusWorkItemHandled={onFocusWorkItemHandled}
        />
      ) : linked ? (
        <p role="status">Shared Project state is unavailable.</p>
      ) : null}
      <div className="hq-project-view__work" hidden={linked}>
        {(["need", "doing"] as const).map((kind) => {
          const workRows = kind === "need" ? work.needs : work.doing;
          const boundExecutions = new Set(
            work.doing.map((item) => item.executionId).filter(Boolean)
          );
          const delegated =
            kind === "doing"
              ? delegations.filter(
                  (delegation) =>
                    activeStates.has(delegation.childState) &&
                    !work.doing.some(
                      (item) => item.executionId === delegation.childExecutionId
                    )
                )
              : [];
          const delegatedIds = new Set(
            delegated.map((row) => row.childExecutionId)
          );
          const items =
            kind === "doing"
              ? rows.doing.filter(
                  (item) =>
                    !boundExecutions.has(item.executionId) &&
                    !delegatedIds.has(item.executionId ?? "")
                )
              : rows.need;
          const total =
            workRows.length +
            delegated.length +
            items.length +
            (kind === "need" ? needsPrCount : 0);
          const workVisible = workRows.slice(
            0,
            expanded[kind] ? undefined : cap[kind]
          );
          const runtimeVisible = items.slice(
            0,
            expanded[kind]
              ? undefined
              : Math.max(0, cap[kind] - workVisible.length - delegated.length)
          );
          const delegatedVisible = delegated.slice(
            0,
            expanded[kind]
              ? undefined
              : Math.max(0, cap[kind] - workVisible.length)
          );
          const label = kind === "need" ? "Needs you" : "Working now";
          return (
            <section
              key={kind}
              className={`hq-project-view__section hq-project-view__section--${kind}`}
              aria-label={label}
            >
              {sectionHead(kind, label, total)}
              {!folded[kind] ? (
                <>
                  {kind === "need"
                    ? workVisible.map((item) => (
                        <div
                          className="hq-project-view__work-item"
                          key={item.id}
                          {...dueContext(item)}
                        >
                          <span className="hq-project-view__avatar">!</span>
                          <span className="hq-project-view__work-item-text">
                            <b>{item.title}</b>
                            <span className="hq-project-view__work-item-meta">
                              {dueControl(
                                item,
                                item.status === "todo" ||
                                  item.status === "blocked"
                                  ? () => setSendFor(item.id)
                                  : undefined
                              )}
                              <small>
                                {item.status === "blocked"
                                  ? item.blockedReason || "Work is blocked"
                                  : item.status === "review"
                                    ? item.prState === "ready_to_merge"
                                      ? "PR ready to merge"
                                      : "PR waiting for review"
                                    : "To do"}
                              </small>
                            </span>
                          </span>
                          {item.status === "blocked" ? (
                            <span className="hq-project-view__actions">
                              <button
                                type="button"
                                className="hq-project-view__action"
                                disabled={workPending}
                                onClick={() => void backToTodo(item)}
                              >
                                Back to To do
                              </button>
                              <button
                                type="button"
                                className="hq-project-view__action"
                                disabled={workPending}
                                onClick={() => void markDone(item)}
                              >
                                Mark done
                              </button>
                            </span>
                          ) : item.status === "todo" ? (
                            <button
                              type="button"
                              className="hq-project-view__action"
                              disabled={workPending}
                              onClick={() => void markDone(item)}
                            >
                              Tick off
                            </button>
                          ) : safeWorkItemPrUrl(item) ? (
                            <span className="hq-project-view__actions">
                              {item.prState === "ready_to_merge" ? (
                                <button
                                  type="button"
                                  className="hq-project-view__action hq-project-view__merge"
                                  onClick={() =>
                                    setMergeRequestedItemId(item.id)
                                  }
                                >
                                  <GitMerge size={13} aria-hidden="true" />{" "}
                                  Merge
                                </button>
                              ) : null}
                              <a
                                href={safeWorkItemPrUrl(item) ?? undefined}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open on{" "}
                                {{
                                  github: "GitHub",
                                  "github.com": "GitHub",
                                  gitlab: "GitLab",
                                  "gitlab.com": "GitLab",
                                  bitbucket: "Bitbucket",
                                  azure_devops: "Azure DevOps"
                                }[item.prProvider ?? ""] ??
                                  item.prProvider ??
                                  "provider"}
                              </a>
                            </span>
                          ) : null}
                          {item.status === "todo" || item.status === "blocked"
                            ? sendControl(item)
                            : null}
                        </div>
                      ))
                    : workVisible.map((item) => (
                        <div
                          className="hq-project-view__work-item"
                          key={item.id}
                          {...dueContext(item)}
                        >
                          <span className="hq-project-view__avatar">
                            {agents.find(
                              (agent) => agent.id === item.assigneeAgentId
                            ) ? (
                              <Pixelkin
                                agent={
                                  agents.find(
                                    (agent) => agent.id === item.assigneeAgentId
                                  )!
                                }
                                size={28}
                              />
                            ) : (
                              <Folder size={15} />
                            )}
                          </span>
                          <span className="hq-project-view__work-item-text">
                            <button
                              type="button"
                              className="hq-project-view__brief-trigger"
                              onClick={() => openWorkItem(item)}
                            >
                              <b>{item.title}</b>
                            </button>
                            <span className="hq-execution-memory__secondary">
                              {dueControl(item)}
                              {item.executionId ? (
                                <ExecutionMemoryChips
                                  api={conversationsApi}
                                  ownerId={ownerId}
                                  profileKey={profileKey}
                                  projectId={project.id}
                                  executionId={item.executionId}
                                  executionGeneration={visibleInventory.runtimeGenerations.get(
                                    item.executionId
                                  )}
                                  providerTurnId={latestRuntimeTurn(
                                    visibleInventory.runtime.get(
                                      item.executionId
                                    ) ?? [],
                                    undefined,
                                    visibleInventory.runtimeGenerations.get(
                                      item.executionId
                                    )
                                  )}
                                  variant="count"
                                  panelHost={panelHost}
                                  panelActive={
                                    memoryPanelRow === `work:${item.id}`
                                  }
                                  onPanelOpen={() =>
                                    openMemoryPanel(`work:${item.id}`)
                                  }
                                  onPanelClose={closeMemoryPanel}
                                  onOpenMessage={onOpenCitationMessage}
                                />
                              ) : null}
                              <small>
                                {item.executionId
                                  ? "Agent working"
                                  : "In progress"}
                              </small>
                            </span>
                          </span>
                          {sendControl(item)}
                        </div>
                      ))}
                  {delegatedVisible.map((delegation) => {
                    const agent = agents.find(
                      (candidate) => candidate.id === delegation.agentId
                    );
                    const captured = visibleInventory.executions.find(
                      (execution) =>
                        execution.executionId === delegation.childExecutionId &&
                        execution.sessionId === delegation.childSessionId &&
                        Boolean(execution.threadId)
                    );
                    const graphProject =
                      captured &&
                      graphProjects.find(
                        (candidate) =>
                          candidate.id === captured.projectId ||
                          candidate.threads.some(
                            (thread) =>
                              thread.id === captured.threadId &&
                              thread.sessionId === captured.sessionId
                          )
                      );
                    const target =
                      captured?.sessionId && captured.threadId && graphProject
                        ? {
                            id: delegation.childExecutionId,
                            kind: "question" as const,
                            title: delegation.taskLabel,
                            context: project.name,
                            projectId: graphProject.id,
                            sessionId: captured.sessionId,
                            threadId: captured.threadId,
                            executionId: delegation.childExecutionId,
                            createdAt: new Date().toISOString()
                          }
                        : null;
                    return (
                      <div
                        className="hq-project-view__work-item"
                        key={`delegated:${delegation.childExecutionId}`}
                      >
                        <span className="hq-project-view__avatar">
                          {agent ? (
                            <Pixelkin agent={agent} size={28} />
                          ) : (
                            <Folder size={15} />
                          )}
                        </span>
                        <span className="hq-project-view__work-item-text">
                          <button
                            type="button"
                            className="hq-project-view__row"
                            aria-label={`Open ${agent?.name ?? "Agent"} task: ${delegation.taskLabel}`}
                            disabled={!target}
                            onClick={() => {
                              if (target) onSelectConversation(target);
                            }}
                          >
                            <b>{delegation.taskLabel}</b>
                            <small>
                              {agent?.name ?? "Agent"}{" "}
                              {target ? "working" : "starting"}
                            </small>
                          </button>
                        </span>
                      </div>
                    );
                  })}
                  {runtimeVisible.map((item) =>
                    kind === "need" ? (
                      <div
                        className="hq-project-view__memory-row"
                        key={(item as NowNeed).id}
                      >
                        <button
                          type="button"
                          className="hq-project-view__row"
                          disabled={!canOpen(item)}
                          onClick={() => open(item as NowNeed)}
                        >
                          <span className="hq-project-view__avatar">!</span>
                          <span>
                            <b>{(item as NowNeed).title}</b>
                          </span>
                          <em>Review</em>
                        </button>
                        <div className="hq-execution-memory__secondary">
                          {(item as NowNeed).kind === "question" &&
                          (item as NowNeed).executionId ? (
                            <ExecutionMemoryChips
                              api={conversationsApi}
                              ownerId={ownerId}
                              profileKey={profileKey}
                              projectId={project.id}
                              executionId={(item as NowNeed).executionId!}
                              executionGeneration={visibleInventory.runtimeGenerations.get(
                                (item as NowNeed).executionId!
                              )}
                              providerTurnId={latestRuntimeTurn(
                                visibleInventory.runtime.get(
                                  (item as NowNeed).executionId!
                                ) ?? [],
                                (item as NowNeed).runtimeItemId,
                                visibleInventory.runtimeGenerations.get(
                                  (item as NowNeed).executionId!
                                )
                              )}
                              variant="why"
                              panelHost={panelHost}
                              panelActive={
                                memoryPanelRow === (item as NowNeed).id
                              }
                              onPanelOpen={() =>
                                openMemoryPanel((item as NowNeed).id)
                              }
                              onPanelClose={closeMemoryPanel}
                              onOpenMessage={onOpenCitationMessage}
                            />
                          ) : null}
                          <small>
                            {(item as NowNeed).kind === "question"
                              ? "Question"
                              : "Approval"}{" "}
                            · Open Conversation to respond
                          </small>
                        </div>
                      </div>
                    ) : (
                      <div
                        className="hq-project-view__memory-row"
                        key={(item as ManagedConversationListEntry).executionId}
                      >
                        <button
                          type="button"
                          className="hq-project-view__row"
                          disabled={!canOpen(item)}
                          onClick={() =>
                            open({
                              id: `execution:${(item as ManagedConversationListEntry).executionId}`,
                              kind: "question",
                              title: "Active Conversation",
                              context: project.name,
                              projectId: (item as ManagedConversationListEntry)
                                .projectId,
                              sessionId:
                                (item as ManagedConversationListEntry)
                                  .sessionId ?? undefined,
                              threadId:
                                (item as ManagedConversationListEntry)
                                  .threadId ?? undefined,
                              executionId: (
                                item as ManagedConversationListEntry
                              ).executionId,
                              createdAt: ""
                            })
                          }
                        >
                          <span className="hq-project-view__avatar">
                            <Folder size={15} />
                          </span>
                          <span>
                            <b>
                              {(item as ManagedConversationListEntry).sessionId
                                ? graphProjects
                                    .flatMap((entry) => entry.threads)
                                    .find(
                                      (thread) =>
                                        thread.sessionId ===
                                        (item as ManagedConversationListEntry)
                                          .sessionId
                                    )?.name || "Conversation in progress"
                                : (item as ManagedConversationListEntry)
                                      .state === "starting"
                                  ? "Conversation starting"
                                  : "Conversation in progress"}
                            </b>
                          </span>
                          <span
                            className="hq-project-view__running"
                            aria-label="Active"
                          />
                        </button>
                        <div className="hq-execution-memory__secondary">
                          <ExecutionMemoryChips
                            api={conversationsApi}
                            ownerId={ownerId}
                            profileKey={profileKey}
                            projectId={project.id}
                            executionId={
                              (item as ManagedConversationListEntry).executionId
                            }
                            executionGeneration={visibleInventory.runtimeGenerations.get(
                              (item as ManagedConversationListEntry).executionId
                            )}
                            providerTurnId={latestRuntimeTurn(
                              visibleInventory.runtime.get(
                                (item as ManagedConversationListEntry)
                                  .executionId
                              ) ?? [],
                              undefined,
                              visibleInventory.runtimeGenerations.get(
                                (item as ManagedConversationListEntry)
                                  .executionId
                              )
                            )}
                            variant="count"
                            panelHost={panelHost}
                            panelActive={
                              memoryPanelRow ===
                              `execution:${(item as ManagedConversationListEntry).executionId}`
                            }
                            onPanelOpen={() =>
                              openMemoryPanel(
                                `execution:${(item as ManagedConversationListEntry).executionId}`
                              )
                            }
                            onPanelClose={closeMemoryPanel}
                            onOpenMessage={onOpenCitationMessage}
                          />
                          <small>
                            {(
                              item as ManagedConversationListEntry
                            ).state.replaceAll("_", " ")}
                          </small>
                        </div>
                      </div>
                    )
                  )}
                  {kind === "need" &&
                  (visibleInventory.hasRepoSource ||
                    visibleInventory.workItems.some(
                      (item) => item.prNumber
                    )) ? (
                    <HqProjectPullRequests
                      key={`${ownerId ?? ""}:${profileKey ?? ""}:${project.id}:need`}
                      mode="need"
                      project={project}
                      personalProjects={personalProjects}
                      graphProjects={graphProjects}
                      workItems={visibleInventory.workItems}
                      api={managedProject ?? null}
                      conversations={conversationsApi ?? null}
                      projectsApi={projectsApi}
                      onWorkItemsChanged={() =>
                        setRefresh((value) => value + 1)
                      }
                      mergeRequestedItemId={mergeRequestedItemId}
                      onMergeRequestHandled={() =>
                        setMergeRequestedItemId(null)
                      }
                      onNeedsCount={setNeedsPrCount}
                      ownerId={ownerId ?? null}
                      profileKey={profileKey ?? null}
                    />
                  ) : null}
                  {!total ? (
                    <p className="hq-project-view__none">
                      {loading
                        ? "Loading Project activity…"
                        : !visibleInventory.complete
                          ? "Current activity is unavailable."
                          : kind === "need"
                            ? "All clear. Nothing needs you right now."
                            : "Nothing running right now."}
                    </p>
                  ) : null}
                  {total > cap[kind] ? (
                    <button
                      type="button"
                      className="hq-project-view__more"
                      onClick={() =>
                        setExpanded((value) => ({
                          ...value,
                          [kind]: !value[kind]
                        }))
                      }
                    >
                      {expanded[kind]
                        ? "Show less"
                        : `Show ${total - cap[kind]} more`}
                    </button>
                  ) : null}
                </>
              ) : null}
            </section>
          );
        })}
        {workError ? (
          <p className="hq-project-view__error" role="alert">
            {workError}
          </p>
        ) : null}
        <section
          className="hq-project-view__section hq-project-view__section--todo"
          aria-label="To do"
        >
          {sectionHead("todo", "To do", work.todos.length)}
          {!folded.todo ? (
            <>
              <form
                className="hq-project-view__add"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createTodo();
                }}
              >
                <button
                  type="submit"
                  aria-label="Add to-do"
                  disabled={
                    workPending ||
                    !draft.trim() ||
                    !visibleInventory.workItemsLoaded
                  }
                >
                  <Plus size={15} />
                </button>
                <input
                  aria-label="Add a to-do"
                  placeholder="Add a to-do, then press Enter (add ‘by Friday’ for a due date)"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={workPending || !visibleInventory.workItemsLoaded}
                />
              </form>
              {(expanded.todo ? work.todos : work.todos.slice(0, cap.todo)).map(
                (item) => (
                  <div
                    className="hq-project-view__work-item"
                    key={item.id}
                    {...dueContext(item)}
                  >
                    <button
                      type="button"
                      className="hq-project-view__tick"
                      aria-label={`Tick off ${item.title}`}
                      title="Tick off"
                      disabled={workPending}
                      onClick={() => void markDone(item)}
                    >
                      <Check size={13} />
                    </button>
                    <span className="hq-project-view__work-item-text">
                      <b>
                        {item.key ? `${item.key} · ` : ""}
                        {item.title}
                      </b>
                      <span className="hq-project-view__work-item-meta">
                        {dueControl(item, () => setSendFor(item.id))}
                      </span>
                    </span>
                    {sendControl(item)}
                  </div>
                )
              )}
              {work.todos.length > cap.todo ? (
                <button
                  className="hq-project-view__more"
                  type="button"
                  onClick={() =>
                    setExpanded((value) => ({ ...value, todo: !value.todo }))
                  }
                >
                  {expanded.todo
                    ? "Show less"
                    : `Show ${work.todos.length - cap.todo} more`}
                </button>
              ) : null}
              {!work.todos.length ? (
                <p className="hq-project-view__none">
                  {visibleInventory.workItemsLoaded
                    ? "No to-dos yet."
                    : "To-dos unavailable."}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
        {visibleInventory.hasRepoSource ||
        visibleInventory.workItems.some(
          (item) => item.prUrl || item.prNumber
        ) ? (
          <section
            className="hq-project-view__section hq-project-view__section--review"
            aria-label="In review"
          >
            {sectionHead("review", "In review", totalReviewCount)}
            <div hidden={folded.review}>
              <HqProjectPullRequests
                key={`${ownerId ?? ""}:${profileKey ?? ""}:${project.id}:review`}
                mode="review"
                project={project}
                personalProjects={personalProjects}
                graphProjects={graphProjects}
                workItems={visibleInventory.workItems}
                api={managedProject ?? null}
                conversations={conversationsApi ?? null}
                projectsApi={projectsApi}
                onWorkItemsChanged={() => setRefresh((value) => value + 1)}
                onVisibleCount={onReviewCount}
                onCoveredWorkItemIds={onCoveredReviewItems}
                showEmpty={fallbackReview.length === 0}
                limit={expanded.review ? undefined : cap.review}
                ownerId={ownerId ?? null}
                profileKey={profileKey ?? null}
              />
              {(expanded.review
                ? fallbackReview
                : fallbackReview.slice(
                    0,
                    Math.max(0, cap.review - reviewPrCount)
                  )
              ).map((item) => (
                <div
                  className="hq-project-view__work-item"
                  key={item.id}
                  {...dueContext(item)}
                >
                  <span className="hq-project-view__work-item-text">
                    <b>{item.title}</b>
                    <span className="hq-project-view__work-item-meta">
                      {dueControl(item)}
                      <small>
                        {item.prNumber
                          ? `PR #${item.prNumber} · ${item.prState ?? "open"}`
                          : "In review"}
                      </small>
                    </span>
                  </span>
                  {safeWorkItemPrUrl(item) ? (
                    <a
                      href={safeWorkItemPrUrl(item) ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open on{" "}
                      {(
                        {
                          github: "GitHub",
                          gitlab: "GitLab",
                          bitbucket: "Bitbucket",
                          azure_devops: "Azure DevOps"
                        } as Record<string, string>
                      )[item.prProvider ?? ""] ?? "provider"}
                    </a>
                  ) : null}
                  {sendControl(item)}
                </div>
              ))}
              {totalReviewCount > cap.review ? (
                <button
                  className="hq-project-view__more"
                  type="button"
                  onClick={() =>
                    setExpanded((value) => ({
                      ...value,
                      review: !value.review
                    }))
                  }
                >
                  {expanded.review
                    ? "Show less"
                    : `Show ${totalReviewCount - cap.review} more`}
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
        <section
          className="hq-project-view__section hq-project-view__section--done"
          aria-label="Done today"
        >
          {sectionHead("done", "Done today", work.doneToday.length)}
          {!folded.done ? (
            <>
              {curatedMemoryApi ? (
                <HqLearnedToday
                  key={memoryKey}
                  api={curatedMemoryApi}
                  projectId={project.id}
                  ownerId={ownerId ?? null}
                  onChanged={() => setMemoryRevision((value) => value + 1)}
                  memoryRevision={memoryRevision}
                  ownedAgents={ownedAgents}
                  onOpenItem={(item) => {
                    setMemorySelection({
                      key: memoryKey,
                      id: ++memorySelectionId.current,
                      item
                    });
                    setSourceCloseSignal((value) => value + 1);
                    setMemoryOpen(true);
                    setBriefFor(null);
                    onSourcesOpenChange?.(true);
                    onContextChange?.("What Koed knows");
                  }}
                  onCount={(count) =>
                    setLearnedState((state) =>
                      state.key === memoryKey && state.count === count
                        ? state
                        : { key: memoryKey, count }
                    )
                  }
                />
              ) : null}
              {(expanded.done
                ? work.doneToday
                : work.doneToday.slice(0, cap.done)
              ).map((item) => (
                <div className="hq-project-view__work-item" key={item.id}>
                  <span className="hq-project-view__work-item-text">
                    <b>{item.title}</b>
                    {item.dueOn ? (
                      <span className="hq-project-view__work-item-meta">
                        {dueControl(item)}
                      </span>
                    ) : null}
                  </span>
                  <Check size={15} aria-label="Done" />
                </div>
              ))}
              {work.doneToday.length > cap.done ? (
                <button
                  className="hq-project-view__more"
                  type="button"
                  onClick={() =>
                    setExpanded((value) => ({ ...value, done: !value.done }))
                  }
                >
                  {expanded.done
                    ? "Show less"
                    : `Show ${work.doneToday.length - cap.done} more`}
                </button>
              ) : null}
              {!work.doneToday.length &&
              (!curatedMemoryApi ||
                (learnedState.key === memoryKey &&
                  learnedState.count === 0)) ? (
                <p className="hq-project-view__none">
                  Nothing finished yet today.
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
      {selectedBrief && panelHost
        ? createPortal(
            <aside className="hq-project-view__brief" aria-label="Work brief">
              <div className="hq-project-view__brief-head">
                <span>
                  <ListTodo size={13} aria-hidden="true" />
                  {selectedBrief.key || `TO-DO ${selectedBrief.id.slice(0, 8)}`}
                </span>
                <button
                  type="button"
                  className="hq-project-view__brief-close"
                  aria-label="Close work brief"
                  onClick={() => {
                    setBriefFor(null);
                    onSourcesOpenChange?.(false);
                  }}
                >
                  <X size={15} />
                </button>
              </div>
              <span className="hq-project-view__brief-origin">
                {selectedBrief.originRef
                  ? `From ${selectedBrief.originRef}`
                  : "Added by you"}
              </span>
              <h2>{selectedBrief.title}</h2>
              <div className="hq-project-view__brief-state">
                <i aria-hidden="true" />
                {selectedBrief.status === "doing"
                  ? "Working now"
                  : selectedBrief.status === "review"
                    ? "In review"
                    : selectedBrief.status === "blocked"
                      ? "Needs you"
                      : selectedBrief.status === "done"
                        ? "Done"
                        : "To do"}
                {selectedBrief.assigneeAgentId
                  ? ` · ${agents.find((agent) => agent.id === selectedBrief.assigneeAgentId)?.name ?? "Agent"}`
                  : null}
              </div>
              <span className="hq-project-view__brief-label">Goal</span>
              <p className="hq-project-view__brief-goal">
                {selectedBrief.goal || selectedBrief.title}
              </p>
              <span className="hq-project-view__brief-label hq-project-view__brief-live-label">
                {selectedBrief.assigneeAgentId &&
                agents.find(
                  (agent) => agent.id === selectedBrief.assigneeAgentId
                )
                  ? `Live · ${agents.find((agent) => agent.id === selectedBrief.assigneeAgentId)!.name}`
                  : "Live updates"}
              </span>
              {selectedBrief.executionId ? (
                (visibleInventory.runtime.get(selectedBrief.executionId) ?? [])
                  .length ? (
                  <ol className="hq-project-view__brief-log">
                    {(
                      visibleInventory.runtime.get(selectedBrief.executionId) ??
                      []
                    ).map((event) => (
                      <li key={event.id}>{hqRuntimeItemTitle(event)}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="hq-project-view__brief-empty">
                    No updates yet.
                  </p>
                )
              ) : (
                <p className="hq-project-view__brief-empty">
                  Waiting to start.
                </p>
              )}
            </aside>,
            panelHost
          )
        : null}
    </div>
  );
}
