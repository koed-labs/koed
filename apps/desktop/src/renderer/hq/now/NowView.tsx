import {
  ChevronDown,
  CircleHelp,
  Folder,
  RotateCw,
  ShieldAlert
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationRuntimeItem,
  ManagedConversationListEntry
} from "../../../ipc/managed-conversation-protocol.js";
import type { CollaborationActionGrantProjection } from "../../../collaboration/renderer-client.js";
import type { ManagedConversationLifecycle } from "../../state/use-managed-conversation-lifecycle.js";
import {
  nowNeedsFromApprovals,
  nowNeedsFromRuntime,
  nowInspectableExecutions,
  nowProjectStatus,
  nowNeedsFromExecutionInventory,
  nowProjects,
  nowVisible
} from "./now-model.js";
import type { NowNeed } from "./now-model.js";
import { readNowPreferences, writeNowPreferences } from "./now-preferences.js";
import "./now.css";

export function NowView({
  projects,
  api,
  lifecycle,
  approvals,
  projectsReady = false,
  projectsLoading = false,
  projectsError = false,
  onSelectProject,
  onSelectConversation
}: {
  projects: readonly DesktopProject[];
  api?: ManagedConversationDesktopApi | null;
  lifecycle?: ManagedConversationLifecycle;
  approvals: readonly CollaborationActionGrantProjection[];
  projectsReady?: boolean;
  projectsLoading?: boolean;
  projectsError?: boolean;
  onSelectProject: (id: string) => void;
  onSelectConversation: (need: NowNeed) => void;
}) {
  const [preferences, setPreferences] = useState(readNowPreferences);
  const [moreNeeds, setMoreNeeds] = useState(false);
  const [moreProjects, setMoreProjects] = useState(false);
  const [runtimeItems, setRuntimeItems] = useState<
    ReadonlyMap<string, readonly ManagedConversationRuntimeItem[]>
  >(new Map());
  const [executions, setExecutions] = useState<
    readonly ManagedConversationListEntry[]
  >([]);
  const [complete, setComplete] = useState(false);
  const [inventoryTruncated, setInventoryTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [sourceApi, setSourceApi] =
    useState<ManagedConversationDesktopApi | null>(null);
  const [approvalClock, setApprovalClock] = useState(0);
  const drafts = lifecycle?.drafts;
  const draftIdentityKey = [...(drafts?.keys() ?? [])].sort().join("\u0000");
  useEffect(() => {
    const nextExpiry = approvals
      .filter(
        ({ state }) =>
          state === "awaiting_approval" || state === "awaiting_review"
      )
      .map(({ expiresAt }) => Date.parse(expiresAt))
      .filter((value) => Number.isFinite(value) && value > Date.now())
      .sort((a, b) => a - b)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setApprovalClock((value) => value + 1),
      Math.max(1, nextExpiry - Date.now() + 1)
    );
    return () => window.clearTimeout(timer);
  }, [approvals, approvalClock]);
  useEffect(() => {
    const list = api?.list;
    if (!api || !list) {
      setExecutions([]);
      setRuntimeItems(new Map());
      setComplete(false);
      setInventoryTruncated(false);
      setSourceApi(null);
      setLoading(false);
      setRuntimeError("Managed Conversations are unavailable.");
      return;
    }
    let active = true;
    setLoading(true);
    setRuntimeError("");
    void (async () => {
      try {
        const listed = await list();
        if (!active) return;
        const inspectable = nowInspectableExecutions(listed.executions);
        const ids = inspectable.executions.map(
          ({ executionId }) => executionId
        );
        const next = new Map<
          string,
          readonly ManagedConversationRuntimeItem[]
        >();
        let failed = false;
        for (let offset = 0; offset < ids.length; offset += 8) {
          if (!active) return;
          const batch = ids.slice(offset, offset + 8);
          const results = await Promise.allSettled(
            batch.map((id) => api.runtime(id))
          );
          if (!active) return;
          results.forEach((result, index) => {
            if (result.status === "fulfilled")
              next.set(batch[index]!, result.value.items);
            else failed = true;
          });
        }
        if (!active) return;
        setExecutions(inspectable.executions);
        setSourceApi(api);
        setComplete(listed.complete && !failed && !inspectable.unknownState);
        setInventoryTruncated(!listed.complete);
        setRuntimeItems(next);
        setRuntimeError(
          failed
            ? "Some Conversation requests could not be loaded."
            : inspectable.unknownState
              ? "Some Conversation states could not be inspected."
              : ""
        );
      } catch {
        if (!active) return;
        setExecutions([]);
        setSourceApi(api);
        setComplete(false);
        setInventoryTruncated(false);
        setRuntimeItems(new Map());
        setRuntimeError("Needs you could not load. Try refreshing.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api, draftIdentityKey, refreshKey]);
  const sourceCurrent = sourceApi === api;
  const visibleRuntime = sourceCurrent
    ? runtimeItems
    : new Map<string, readonly ManagedConversationRuntimeItem[]>();
  const visibleExecutions = sourceCurrent ? executions : [];
  const scopedDrafts = new Map(
    [...(drafts ?? new Map())].filter(([id]) =>
      visibleExecutions.some(({ executionId }) => executionId === id)
    )
  );
  const needs = useMemo(
    () =>
      [
        ...nowNeedsFromRuntime(scopedDrafts, visibleRuntime),
        ...nowNeedsFromExecutionInventory(
          visibleExecutions,
          visibleRuntime,
          scopedDrafts,
          projects
        ),
        ...nowNeedsFromApprovals(approvals)
      ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [
      scopedDrafts,
      visibleRuntime,
      visibleExecutions,
      approvals,
      projects,
      approvalClock
    ]
  );
  const projectRows = useMemo(() => nowProjects(projects), [projects]);
  const setFold = (section: "needsFolded" | "projectsFolded") => {
    const next = { ...preferences, [section]: !preferences[section] };
    setPreferences(next);
    writeNowPreferences(next);
  };
  return (
    <div className="hq-now" aria-label="Now">
      <div className="hq-now__content">
        <section
          className="hq-now__section"
          aria-label="Needs you"
          data-has-items={needs.length > 0}
        >
          <header className="hq-now__section-header">
            <button
              type="button"
              aria-expanded={!preferences.needsFolded}
              onClick={() => setFold("needsFolded")}
            >
              <ChevronDown aria-hidden="true" />
              <i className="hq-now__section-dot" aria-hidden="true" />
              Needs you <span>{needs.length}</span>
            </button>
            <button
              type="button"
              className="hq-now__refresh"
              aria-label="Refresh Needs you"
              disabled={loading}
              onClick={() => setRefreshKey((value) => value + 1)}
            >
              <RotateCw aria-hidden="true" />
            </button>
          </header>
          {!preferences.needsFolded ? (
            <div className="hq-now__rows">
              {runtimeError && (sourceCurrent || !api?.list) ? (
                <p role="alert">{runtimeError}</p>
              ) : null}
              {loading || !sourceCurrent ? (
                <p role="status">Checking Conversations…</p>
              ) : null}
              {!loading && sourceCurrent && inventoryTruncated ? (
                <p role="status">
                  Showing recent Conversations. Older activity may be missing.
                </p>
              ) : null}
              {!loading && sourceCurrent && complete && needs.length === 0 ? (
                <p className="hq-now__empty">Nothing needs you right now.</p>
              ) : null}
              {nowVisible(needs, moreNeeds).map((item) =>
                projects.some(({ id }) => id === item.projectId) &&
                item.executionId &&
                item.projectId &&
                item.sessionId &&
                item.threadId ? (
                  <button
                    key={item.id}
                    type="button"
                    className="hq-now__row"
                    onClick={() => onSelectConversation(item)}
                  >
                    <span className="hq-now__need-icon" aria-hidden="true">
                      {item.kind === "question" ? (
                        <CircleHelp />
                      ) : (
                        <ShieldAlert />
                      )}
                    </span>
                    <span className="hq-now__row-copy">
                      <strong>{item.title}</strong>
                      <small>{item.context}</small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                ) : (
                  <div key={item.id} className="hq-now__row">
                    <span className="hq-now__need-icon" aria-hidden="true">
                      {item.kind === "question" ? (
                        <CircleHelp />
                      ) : (
                        <ShieldAlert />
                      )}
                    </span>
                    <span className="hq-now__row-copy">
                      <strong>{item.title}</strong>
                      <small>{item.context}</small>
                    </span>
                  </div>
                )
              )}
              {needs.length > 5 ? (
                <button
                  type="button"
                  className="hq-now__more"
                  onClick={() => setMoreNeeds((value) => !value)}
                >
                  {moreNeeds ? "Show less" : `Show ${needs.length - 5} more`}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
        <section className="hq-now__section" aria-label="Projects">
          <header className="hq-now__section-header">
            <button
              type="button"
              aria-expanded={!preferences.projectsFolded}
              onClick={() => setFold("projectsFolded")}
            >
              <ChevronDown aria-hidden="true" />
              <i className="hq-now__section-dot" aria-hidden="true" />
              Projects <span>{projectRows.length}</span>
            </button>
          </header>
          {!preferences.projectsFolded ? (
            <div className="hq-now__rows">
              {projectsError ? (
                <p role="alert">
                  Projects could not load. Retry from the sidebar.
                </p>
              ) : null}
              {projectsLoading && !projectRows.length ? (
                <p role="status">Loading Projects…</p>
              ) : null}
              {projectsReady && projectRows.length === 0 ? (
                <p className="hq-now__empty">No Projects yet.</p>
              ) : null}
              {nowVisible(projectRows, moreProjects).map((project) => {
                const status = nowProjectStatus(project, needs);
                return (
                  <button
                    key={project.id}
                    type="button"
                    className="hq-now__row"
                    onClick={() => onSelectProject(project.id)}
                  >
                    <span className="hq-now__project-icon">
                      <Folder aria-hidden="true" />
                    </span>
                    <span className="hq-now__row-copy">
                      <strong>{project.name}</strong>
                      <small>
                        {status.pending > 0 ? (
                          <>
                            <span className="hq-now__pending-count">
                              {status.pending} need you
                            </span>{" "}
                            ·{" "}
                          </>
                        ) : null}
                        {status.conversations}
                      </small>
                    </span>
                    <span
                      className="hq-now__sparkline"
                      aria-label="Activity preview unavailable"
                      title="Activity preview unavailable"
                    />
                  </button>
                );
              })}
              {projectRows.length > 5 ? (
                <button
                  type="button"
                  className="hq-now__more"
                  onClick={() => setMoreProjects((value) => !value)}
                >
                  {moreProjects
                    ? "Show less"
                    : `Show ${projectRows.length - 5} more`}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
