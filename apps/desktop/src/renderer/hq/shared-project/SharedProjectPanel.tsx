import {
  ArrowUpRight,
  Check,
  ChevronDown,
  MoreHorizontal,
  Plus,
  RotateCw
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pixelkin } from "../agents/Pixelkin.js";
import type { Agent } from "@koed/shared/agent-contract";
import type { WorkspaceProjectWorkItem } from "@koed/shared";
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import { dueInfo, dueSoon, parseCanonicalDueDate } from "@koed/shared/due-date";
import {
  parseWorkItemInput,
  viewerTimeZone,
  viewerToday
} from "../project/hq-work-item-model.js";
import {
  SharedProjectStore,
  type SharedProjectIdentity
} from "./shared-project-store.js";
import { SharedProjectExecution } from "./SharedProjectExecution.js";
import "./shared-project.css";

const statusLabel = (status: WorkspaceProjectWorkItem["status"]) =>
  status === "todo"
    ? "To do"
    : status === "doing"
      ? "Working now"
      : status === "review"
        ? "In review"
        : status === "blocked"
          ? "Needs you"
          : "Done";

const safePrUrl = (value: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};

export function SharedProjectPanel({
  store,
  identity,
  refreshSignal,
  agents,
  conversationsApi,
  managedProject,
  panelHost,
  activeMemoryRow,
  onMemoryOpen,
  onMemoryClose,
  onOpenCitationMessage
}: {
  store: SharedProjectStore;
  identity: SharedProjectIdentity;
  refreshSignal: number;
  agents: readonly (Pick<Agent, "id" | "name"> &
    Partial<Pick<Agent, "look">>)[];
  conversationsApi?: ManagedConversationDesktopApi | null;
  managedProject?: ManagedProjectDesktopApi | null;
  panelHost?: HTMLElement | null;
  activeMemoryRow?: string | null;
  onMemoryOpen?: (row: string) => void;
  onMemoryClose?: () => void;
  onOpenCitationMessage?: React.ComponentProps<
    typeof SharedProjectExecution
  >["onOpenMessage"];
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.current,
    store.current
  );
  const [draft, setDraft] = useState("");
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null
  );
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sendFor, setSendFor] = useState<string | null>(null);
  const refreshSeen = useRef(refreshSignal);
  const identityKey = [
    identity.ownerId,
    identity.profileKey,
    identity.personalProjectId,
    identity.workspaceProjectId,
    identity.teamBackendId
  ].join("\u0000");
  useEffect(() => {
    store.setIdentity(identity);
    setDraft("");
    setDraftKey(null);
    setEditing(null);
    setSendFor(null);
    return () => store.setIdentity(null);
  }, [store, identityKey]);
  useEffect(() => {
    if (refreshSeen.current === refreshSignal) return;
    refreshSeen.current = refreshSignal;
    void store.refresh();
  }, [store, refreshSignal]);
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void store.refresh();
    };
    const timer = window.setInterval(refreshVisible, 10_000);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [store, identityKey]);
  useEffect(() => {
    if (!sendFor) return;
    const focusFrame = window.requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          `.hq-shared-project .hq-project-view__send-menu [role="menuitem"]`
        )
        ?.focus()
    );
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".hq-project-view__send-wrap"))
        setSendFor(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      document
        .querySelector<HTMLElement>(`[data-shared-work-send-id="${sendFor}"]`)
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

  const current =
    snapshot.identity?.ownerId === identity.ownerId &&
    snapshot.identity.profileKey === identity.profileKey &&
    snapshot.identity.personalProjectId === identity.personalProjectId &&
    snapshot.identity.workspaceProjectId === identity.workspaceProjectId &&
    snapshot.identity.teamBackendId === identity.teamBackendId
      ? snapshot
      : null;
  const state = current?.state ?? null;
  const dispatchByItem = new Map(
    (current?.dispatches ?? []).map((binding) => [
      binding.teamWorkItemId,
      binding
    ])
  );
  const readOnly = !state || state.readOnly;
  const timeZone = viewerTimeZone();
  const now = new Date();
  const doneToday = (item: WorkspaceProjectWorkItem) =>
    item.status === "done" &&
    item.doneAt !== null &&
    viewerToday(timeZone, new Date(item.doneAt)) === viewerToday(timeZone, now);
  const needs = (item: WorkspaceProjectWorkItem) =>
    item.status === "blocked" ||
    (item.status === "todo" &&
      !item.dispatchKey &&
      dueSoon(parseCanonicalDueDate(item.dueOn), { timeZone, now })) ||
    (item.status === "review" &&
      ["ready_to_merge", "waiting_review"].includes(item.prState ?? ""));
  const rowsFor = (status: "blocked" | "doing" | "todo" | "review" | "done") =>
    (state?.workItems ?? [])
      .filter((item) =>
        status === "blocked"
          ? needs(item)
          : status === "todo"
            ? item.status === "todo" && !needs(item)
            : status === "review"
              ? item.status === "review" && !needs(item)
              : status === "done"
                ? doneToday(item)
                : item.status === "doing"
      )
      .sort((left, right) =>
        status === "done"
          ? (right.doneAt ?? "").localeCompare(left.doneAt ?? "")
          : status === "todo" || status === "blocked"
            ? (left.dueOn ?? "9999-12-31").localeCompare(
                right.dueOn ?? "9999-12-31"
              ) || right.updatedAt.localeCompare(left.updatedAt)
            : right.updatedAt.localeCompare(left.updatedAt)
      );
  const cap: Record<"blocked" | "doing" | "todo" | "review" | "done", number> =
    { blocked: 4, doing: 4, todo: 5, review: 4, done: 3 };
  const saveNew = async () => {
    const parsed = parseWorkItemInput(draft, timeZone, new Date());
    if (!parsed.title || readOnly) return;
    const key = draftKey ?? crypto.randomUUID();
    setDraftKey(key);
    const saved = await store.createWorkItem({
      idempotencyKey: key,
      kind: "todo",
      title: parsed.title,
      goal: parsed.title,
      status: "todo",
      dueOn: parsed.due
    });
    if (saved) {
      setDraft("");
      setDraftKey(null);
    }
  };
  const saveEdit = async (item: WorkspaceProjectWorkItem) => {
    if (!editing || editing.id !== item.id) return;
    const title = editing.text.trim();
    if (!title || readOnly) return;
    const saved = await store.patchWorkItem(item.id, {
      expectedVersion: item.version,
      title
    });
    if (saved) setEditing(null);
  };
  return (
    <div
      className="hq-project-view__work hq-shared-project"
      aria-label="Shared Project state"
    >
      <div className="hq-shared-project__notice">
        {state?.notice || state?.readOnly ? (
          <p role="status">
            {state.notice ?? "This shared Project is read-only."}
          </p>
        ) : null}
        {current?.error ? <p role="alert">{current.error}</p> : null}
        <button
          type="button"
          aria-label="Refresh shared Project"
          onClick={() => void store.refresh()}
        >
          <RotateCw size={14} />
        </button>
      </div>
      {!state && current?.loading ? <p>Loading shared work…</p> : null}
      {!state && !current?.loading ? (
        <p>Shared Project state is unavailable.</p>
      ) : null}
      {state ? (
        <>
          {(["blocked", "doing", "todo", "review", "done"] as const).map(
            (status) => {
              const rows = rowsFor(status);
              return (
                <section
                  key={status}
                  className={`hq-project-view__section hq-project-view__section--${status === "blocked" ? "need" : status}`}
                  aria-label={statusLabel(status)}
                >
                  <button
                    type="button"
                    className="hq-project-view__section-head"
                    aria-expanded={!folded[status]}
                    onClick={() =>
                      setFolded((current) => ({
                        ...current,
                        [status]: !current[status]
                      }))
                    }
                  >
                    <ChevronDown size={14} aria-hidden="true" />
                    <i aria-hidden="true" />
                    {status === "done" ? "Done today" : statusLabel(status)}
                    <span>{rows.length}</span>
                  </button>
                  {!folded[status] ? (
                    <>
                      {status === "todo" ? (
                        <form
                          className="hq-project-view__add"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveNew();
                          }}
                        >
                          <button
                            type="submit"
                            aria-label="Add shared to-do"
                            disabled={
                              readOnly ||
                              !!current?.pendingItemId ||
                              !draft.trim()
                            }
                          >
                            <Plus size={15} />
                          </button>
                          <input
                            aria-label="New shared to-do"
                            placeholder="Add a to-do, then press Enter (add ‘by Friday’ for a due date)"
                            value={draft}
                            disabled={readOnly}
                            onChange={(event) => {
                              setDraft(event.target.value);
                              setDraftKey(null);
                            }}
                          />
                        </form>
                      ) : null}
                      {(expanded[status]
                        ? rows
                        : rows.slice(0, cap[status])
                      ).map((item) => (
                        <div
                          className="hq-project-view__work-item hq-shared-project__row"
                          key={item.id}
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (
                              event.key === "F2" &&
                              !readOnly &&
                              !current?.pendingItemId
                            ) {
                              event.preventDefault();
                              setEditing({ id: item.id, text: item.title });
                            }
                          }}
                          onContextMenu={(event) => {
                            if (readOnly || current?.pendingItemId) return;
                            event.preventDefault();
                            setEditing({ id: item.id, text: item.title });
                          }}
                        >
                          {item.status !== "todo" &&
                          dispatchByItem.has(item.id) &&
                          agents.find(
                            (agent) =>
                              agent.id === dispatchByItem.get(item.id)?.agentId
                          ) ? (
                            <Pixelkin
                              agent={{
                                ...agents.find(
                                  (agent) =>
                                    agent.id ===
                                    dispatchByItem.get(item.id)?.agentId
                                )!,
                                look:
                                  agents.find(
                                    (agent) =>
                                      agent.id ===
                                      dispatchByItem.get(item.id)?.agentId
                                  )?.look ?? {}
                              }}
                              size={26}
                            />
                          ) : null}
                          {item.status === "todo" && editing?.id !== item.id ? (
                            <button
                              type="button"
                              className="hq-project-view__tick"
                              aria-label={`Tick off ${item.title}`}
                              title="Tick off"
                              disabled={readOnly || !!current?.pendingItemId}
                              onClick={() =>
                                void store.patchWorkItem(item.id, {
                                  expectedVersion: item.version,
                                  status: "done"
                                })
                              }
                            >
                              <Check size={13} />
                            </button>
                          ) : null}
                          {editing?.id === item.id ? (
                            <div className="hq-shared-project__edit">
                              {current?.conflictItemId === item.id ? (
                                <small>Latest from Team: {item.title}</small>
                              ) : null}
                              <form
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  void saveEdit(item);
                                }}
                              >
                                <input
                                  aria-label={`Edit ${item.title}`}
                                  value={editing.text}
                                  disabled={readOnly}
                                  onChange={(event) =>
                                    setEditing({
                                      id: item.id,
                                      text: event.target.value
                                    })
                                  }
                                />
                                <button
                                  type="submit"
                                  disabled={
                                    readOnly || !!current?.pendingItemId
                                  }
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditing(null)}
                                >
                                  Cancel
                                </button>
                              </form>
                            </div>
                          ) : (
                            <>
                              {conversationsApi &&
                              dispatchByItem.has(item.id) ? (
                                <SharedProjectExecution
                                  title={
                                    <b>
                                      {item.key ? `${item.key} · ` : ""}
                                      {item.title}
                                    </b>
                                  }
                                  binding={dispatchByItem.get(item.id)!}
                                  item={item}
                                  api={conversationsApi}
                                  managedProject={managedProject}
                                  ownerId={identity.ownerId}
                                  profileKey={identity.profileKey}
                                  projectId={identity.personalProjectId}
                                  panelHost={panelHost}
                                  panelActive={
                                    activeMemoryRow === `shared:${item.id}`
                                  }
                                  onPanelOpen={() =>
                                    onMemoryOpen?.(`shared:${item.id}`)
                                  }
                                  onPanelClose={() => onMemoryClose?.()}
                                  onOpenMessage={onOpenCitationMessage}
                                  onTeamRefresh={() => void store.refresh()}
                                />
                              ) : (
                                <span className="hq-project-view__work-item-text">
                                  <b>
                                    {item.key ? `${item.key} · ` : ""}
                                    {item.title}
                                  </b>
                                  <small>
                                    {item.stepLabel ||
                                      item.assigneeDisplayName ||
                                      (item.dueOn
                                        ? dueInfo(
                                            parseCanonicalDueDate(item.dueOn)!,
                                            { timeZone, now }
                                          )[1]
                                        : statusLabel(item.status))}
                                  </small>
                                </span>
                              )}
                              {safePrUrl(item.prUrl) ? (
                                <a
                                  className="hq-shared-project__pr-link"
                                  href={safePrUrl(item.prUrl)!}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`Open pull request for ${item.title}`}
                                >
                                  Open PR
                                </a>
                              ) : null}
                              <button
                                type="button"
                                className="hq-shared-project__edit-action"
                                aria-label={`Edit ${item.title}`}
                                title="Edit Work Item"
                                disabled={readOnly || !!current?.pendingItemId}
                                onClick={() =>
                                  setEditing({ id: item.id, text: item.title })
                                }
                              >
                                <MoreHorizontal size={16} />
                              </button>
                              {item.status === "todo" ||
                              item.status === "blocked" ? (
                                <span className="hq-project-view__send-wrap">
                                  <button
                                    type="button"
                                    className="hq-project-view__send"
                                    data-shared-work-send-id={item.id}
                                    aria-label={`Send ${item.title} to an Agent`}
                                    aria-expanded={sendFor === item.id}
                                    disabled={
                                      readOnly || !!current?.pendingItemId
                                    }
                                    onClick={() =>
                                      setSendFor(
                                        sendFor === item.id ? null : item.id
                                      )
                                    }
                                  >
                                    <ArrowUpRight size={15} />
                                  </button>
                                  {sendFor === item.id ? (
                                    <span
                                      className="hq-project-view__send-menu"
                                      role="menu"
                                    >
                                      <b>Send to an Agent</b>
                                      {agents.length ? (
                                        agents.map((agent) => (
                                          <button
                                            type="button"
                                            role="menuitem"
                                            key={agent.id}
                                            onClick={() =>
                                              void store
                                                .dispatchWorkItem(
                                                  item,
                                                  agent.id
                                                )
                                                .then((sent) => {
                                                  if (sent) setSendFor(null);
                                                })
                                            }
                                          >
                                            <span
                                              className="hq-project-view__agent-initial"
                                              aria-hidden="true"
                                            >
                                              {agent.name.slice(0, 1)}
                                            </span>
                                            <span className="hq-project-view__agent-name">
                                              {agent.name}
                                            </span>
                                          </button>
                                        ))
                                      ) : (
                                        <small>No available Agents</small>
                                      )}
                                    </span>
                                  ) : null}
                                </span>
                              ) : null}
                              {item.status === "blocked" ? (
                                <span className="hq-project-view__actions">
                                  <button
                                    type="button"
                                    className="hq-project-view__action"
                                    disabled={
                                      readOnly || !!current?.pendingItemId
                                    }
                                    onClick={() =>
                                      void store.patchWorkItem(item.id, {
                                        expectedVersion: item.version,
                                        status: "todo"
                                      })
                                    }
                                  >
                                    Back to To do
                                  </button>
                                  <button
                                    type="button"
                                    className="hq-project-view__action"
                                    disabled={
                                      readOnly || !!current?.pendingItemId
                                    }
                                    onClick={() =>
                                      void store.patchWorkItem(item.id, {
                                        expectedVersion: item.version,
                                        status: "done"
                                      })
                                    }
                                  >
                                    Mark done
                                  </button>
                                </span>
                              ) : null}
                            </>
                          )}
                        </div>
                      ))}
                      {rows.length > cap[status] ? (
                        <button
                          type="button"
                          className="hq-project-view__more"
                          onClick={() =>
                            setExpanded((current) => ({
                              ...current,
                              [status]: !current[status]
                            }))
                          }
                        >
                          {expanded[status]
                            ? "Show less"
                            : `Show ${rows.length - cap[status]} more`}
                        </button>
                      ) : null}
                      {!rows.length ? (
                        <p className="hq-project-view__none">
                          {status === "todo"
                            ? "No to-dos yet."
                            : status === "doing"
                              ? "Nothing running right now."
                              : status === "blocked"
                                ? "All clear. Nothing needs you right now."
                                : status === "review"
                                  ? "No open pull requests."
                                  : "Nothing finished yet today."}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </section>
              );
            }
          )}
        </>
      ) : null}
    </div>
  );
}
