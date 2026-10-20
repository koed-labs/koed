import { ChevronDown, Folder, RotateCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Project } from "@koed/shared";
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
import "./hq-project-view.css";

type HqSummary = Awaited<ReturnType<ProjectsDesktopApi["hq"]>>;
type Inventory = {
  projectsApi: ProjectsDesktopApi | null;
  conversationsApi: ManagedConversationDesktopApi | null;
  ownerId: string | null;
  profileKey: string | null;
  projectId: string | null;
  summary: HqSummary | null;
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
const cap = { need: 4, doing: 4 } as const;

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
  const [folded, setFolded] = useState({ need: false, doing: false });
  const [expanded, setExpanded] = useState({ need: false, doing: false });
  const draftIds = [...(lifecycle?.drafts.keys() ?? [])].sort().join("\u0000");
  useEffect(() => {
    if (!conversationsApi?.list) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setRefresh((value) => value + 1);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [conversationsApi]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void (async () => {
      const [hq, listed] = await Promise.allSettled([
        projectsApi.hq(project.id),
        conversationsApi?.list?.() ?? Promise.resolve(null)
      ]);
      if (!live) return;
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
        if (!live) return;
        results.forEach((result, index) => {
          if (result.status === "fulfilled")
            runtime.set(batch[index]!.executionId, result.value.items);
          else runtimeFailed = true;
        });
      }
      if (!live) return;
      setInventory({
        projectsApi,
        conversationsApi: conversationsApi ?? null,
        ownerId: ownerId ?? null,
        profileKey: profileKey ?? null,
        projectId: project.id,
        summary,
        executions,
        runtime,
        complete: Boolean(
          listed.status === "fulfilled" &&
          listed.value?.complete &&
          !inspected?.unknownState &&
          !runtimeFailed
        ),
        error:
          hq.status === "rejected" || !summary
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
          const items = rows[kind];
          const label = kind === "need" ? "Needs you" : "Working now";
          return (
            <section
              key={kind}
              className={`hq-project-view__section hq-project-view__section--${kind}`}
              aria-label={label}
            >
              <button
                type="button"
                className="hq-project-view__section-head"
                aria-expanded={!folded[kind]}
                onClick={() =>
                  setFolded((value) => ({ ...value, [kind]: !value[kind] }))
                }
              >
                <ChevronDown size={14} aria-hidden="true" />
                <i aria-hidden="true" />
                {label}
                <span>{items.length}</span>
              </button>
              {!folded[kind] ? (
                <>
                  {items
                    .slice(0, expanded[kind] ? undefined : cap[kind])
                    .map((item) =>
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
                          key={
                            (item as ManagedConversationListEntry).executionId
                          }
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
                  {!items.length ? (
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
                  {items.length > cap[kind] ? (
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
                        : `Show ${items.length - cap[kind]} more`}
                    </button>
                  ) : null}
                </>
              ) : null}
            </section>
          );
        })}
        <section className="hq-project-view__future">
          <h2>To do</h2>
          <p>Work Items are not available in this Project yet.</p>
        </section>
        <section className="hq-project-view__future">
          <h2>In review</h2>
          <p>Review status is not available yet.</p>
        </section>
        <section className="hq-project-view__future">
          <h2>Done today</h2>
          <p>Completed Work Items are not available yet.</p>
        </section>
      </div>
    </div>
  );
}
