import {
  Check,
  ChevronDown,
  Folder,
  Plus,
  RotateCw,
  Sparkles
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@koed/shared/project-contract";
import type { WorkItem } from "@koed/shared/work-item-contract";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationListEntry,
  ManagedConversationRuntimeItem
} from "../../../ipc/managed-conversation-protocol.js";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import type { ManagedConversationLifecycle } from "../../state/use-managed-conversation-lifecycle.js";
import { hqRuntimeItemTitle } from "../conversation/hq-runtime-item-title.js";
import { projectNavigation } from "../project-navigation.js";
import { nowInspectableExecutions, type NowNeed } from "../now/now-model.js";
import { HqProjectSources } from "./HqProjectSources.js";
import {
  parseWorkItemInput,
  projectWorkItemSections,
  safeWorkItemPrUrl,
  viewerTimeZone,
  workItemDueLabel
} from "./hq-work-item-model.js";
import "./hq-project-view.css";

type HqSummary = Awaited<ReturnType<ProjectsDesktopApi["hq"]>>;
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
  conversationsApi,
  lifecycle,
  ownerId,
  profileKey,
  panelHost,
  onSourcesOpenChange,
  onContextChange,
  closeSignal,
  onSelectConversation,
  onOpenPrivateHq,
  blockedConversationSessions
}: {
  project: Project;
  personalProjects: readonly Project[];
  graphProjects: readonly DesktopProject[];
  projectsApi: ProjectsDesktopApi;
  conversationsApi?: ManagedConversationDesktopApi | null;
  lifecycle?: ManagedConversationLifecycle;
  ownerId?: string | null;
  profileKey?: string | null;
  panelHost?: HTMLElement | null;
  onSourcesOpenChange?: (open: boolean) => void;
  onContextChange?: (label: string | null) => void;
  closeSignal?: number;
  onSelectConversation: (need: NowNeed) => void;
  onOpenPrivateHq?: () => void;
  blockedConversationSessions?: ReadonlySet<string>;
}) {
  const [inventory, setInventory] = useState<Inventory>(emptyInventory);
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
  const intent = useRef({
    projectId: project.id,
    ownerId,
    profileKey,
    api: projectsApi,
    generation: 0
  });
  if (
    intent.current.projectId !== project.id ||
    intent.current.ownerId !== ownerId ||
    intent.current.profileKey !== profileKey ||
    intent.current.api !== projectsApi
  ) {
    intent.current = {
      projectId: project.id,
      ownerId,
      profileKey,
      api: projectsApi,
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
  useEffect(() => {
    setDraft("");
    setWorkError("");
    setWorkPending(false);
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
  }, [project.id, ownerId, profileKey, projectsApi]);
  const draftIds = [...(lifecycle?.drafts.keys() ?? [])].sort().join("\u0000");
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
          projectsApi.workItemList?.(project.id) ??
            Promise.reject(new Error("Work Items unavailable")),
          projectsApi.sourceList(project.id)
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
      let runtimeFailed = false;
      for (let offset = 0; offset < executions.length; offset += 8) {
        const batch = executions.slice(offset, offset + 8);
        const results = await Promise.allSettled(
          batch.map((entry) => conversationsApi!.runtime(entry.executionId))
        );
        if (!live || intent.current.generation !== generation) return;
        results.forEach((result, index) => {
          if (result.status === "fulfilled")
            runtime.set(batch[index]!.executionId, result.value.items);
          else runtimeFailed = true;
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
                createdAt: item.createdAt
              })
            )
        )
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [visibleInventory]
  );
  const activity = visibleInventory.summary?.activity?.lastSevenDays;
  const outcomes = activity?.outcomes;
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
        <span
          className="hq-project-view__shared"
          title="Project sharing is not available yet"
        >
          Just me
        </span>
      </header>
      <div className="hq-project-view__keys">
        <HqProjectSources
          projectId={project.id}
          projectName={project.name}
          api={projectsApi}
          visibilityOwnerId={ownerId}
          visibilityProfileKey={profileKey}
          panelHost={panelHost}
          onOpenChange={onSourcesOpenChange}
          onContextChange={onContextChange}
          closeSignal={closeSignal}
        />
        <span
          className="hq-project-view__memory"
          title="Project memory list is not available yet"
        >
          <Sparkles size={14} /> Memory unavailable
        </span>
      </div>
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
      <div className="hq-project-view__work">
        {(["need", "doing"] as const).map((kind) => {
          const workRows = kind === "need" ? work.needs : work.doing;
          const boundExecutions = new Set(
            work.doing.map((item) => item.executionId).filter(Boolean)
          );
          const items =
            kind === "doing"
              ? rows.doing.filter(
                  (item) => !boundExecutions.has(item.executionId)
                )
              : rows.need;
          const total = workRows.length + items.length;
          const workVisible = workRows.slice(
            0,
            expanded[kind] ? undefined : cap[kind]
          );
          const runtimeVisible = items.slice(
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
                        >
                          <span className="hq-project-view__avatar">!</span>
                          <span className="hq-project-view__work-item-text">
                            <b>{item.title}</b>
                            <small>
                              {item.status === "blocked"
                                ? item.blockedReason || "Work is blocked"
                                : item.status === "todo"
                                  ? workItemDueLabel(item, timeZone, now)
                                  : item.prState === "ready_to_merge"
                                    ? "PR ready to merge"
                                    : "PR waiting for review"}
                            </small>
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
                            <a
                              href={safeWorkItemPrUrl(item) ?? undefined}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open on {item.prProvider || "provider"}
                            </a>
                          ) : null}
                        </div>
                      ))
                    : workVisible.map((item) => (
                        <div
                          className="hq-project-view__work-item"
                          key={item.id}
                        >
                          <span className="hq-project-view__avatar">
                            <Folder size={15} />
                          </span>
                          <span className="hq-project-view__work-item-text">
                            <b>{item.title}</b>
                            <small>
                              {item.executionId
                                ? "Agent working"
                                : "In progress"}
                            </small>
                          </span>
                        </div>
                      ))}
                  {runtimeVisible.map((item) =>
                    kind === "need" ? (
                      <button
                        type="button"
                        className="hq-project-view__row"
                        key={(item as NowNeed).id}
                        disabled={!canOpen(item)}
                        onClick={() => open(item as NowNeed)}
                      >
                        <span className="hq-project-view__avatar">!</span>
                        <span>
                          <b>{(item as NowNeed).title}</b>
                          <small>
                            {(item as NowNeed).kind === "question"
                              ? "Question"
                              : "Approval"}{" "}
                            · Open Conversation to respond
                          </small>
                        </span>
                        <em>Review</em>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="hq-project-view__row"
                        key={(item as ManagedConversationListEntry).executionId}
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
                              (item as ManagedConversationListEntry).threadId ??
                              undefined,
                            executionId: (item as ManagedConversationListEntry)
                              .executionId,
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
                              : (item as ManagedConversationListEntry).state ===
                                  "starting"
                                ? "Conversation starting"
                                : "Conversation in progress"}
                          </b>
                          <small>
                            {(
                              item as ManagedConversationListEntry
                            ).state.replaceAll("_", " ")}
                          </small>
                        </span>
                        <span
                          className="hq-project-view__running"
                          aria-label="Active"
                        />
                      </button>
                    )
                  )}
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
                  <div className="hq-project-view__work-item" key={item.id}>
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
                      {workItemDueLabel(item, timeZone, now) ? (
                        <small>{workItemDueLabel(item, timeZone, now)}</small>
                      ) : null}
                    </span>
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
            {sectionHead("review", "In review", work.review.length)}
            {!folded.review ? (
              <>
                {(expanded.review
                  ? work.review
                  : work.review.slice(0, cap.review)
                ).map((item) => (
                  <div className="hq-project-view__work-item" key={item.id}>
                    <span className="hq-project-view__work-item-text">
                      <b>{item.title}</b>
                      <small>
                        {item.prNumber
                          ? `PR #${item.prNumber} · ${item.prState ?? "open"}`
                          : "In review"}
                      </small>
                    </span>
                    {safeWorkItemPrUrl(item) ? (
                      <a
                        href={safeWorkItemPrUrl(item) ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open on {item.prProvider || "provider"}
                      </a>
                    ) : null}
                  </div>
                ))}
                {work.review.length > cap.review ? (
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
                      : `Show ${work.review.length - cap.review} more`}
                  </button>
                ) : null}
                {!work.review.length ? (
                  <p className="hq-project-view__none">
                    No open pull requests.
                  </p>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
        <section
          className="hq-project-view__section hq-project-view__section--done"
          aria-label="Done today"
        >
          {sectionHead("done", "Done today", work.doneToday.length)}
          {!folded.done ? (
            <>
              {(expanded.done
                ? work.doneToday
                : work.doneToday.slice(0, cap.done)
              ).map((item) => (
                <div className="hq-project-view__work-item" key={item.id}>
                  <span className="hq-project-view__work-item-text">
                    <b>{item.title}</b>
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
              {!work.doneToday.length ? (
                <p className="hq-project-view__none">
                  Nothing finished yet today.
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
