import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  FileText,
  RotateCw,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import type { Project } from "@koed/shared/project-contract";
import type {
  CuratedAssertion,
  CuratedMemoryDesktopApi,
  CuratedMemoryPage,
  MemoryCursor
} from "../../../ipc/curated-memory-protocol.js";
import "./what-koed-knows.css";

const groups = [
  ["decision", "Decisions"],
  ["fact", "Facts"],
  ["learning", "Learned"],
  ["preference", "Preferences"],
  ["legacy", "Earlier memory"]
] as const;
const kindLabel = (kind: CuratedAssertion["kind"]) =>
  groups.find(([value]) => value === kind)?.[1].replace(/s$/, "") ??
  "Earlier memory";
const date = (value: string) =>
  Number.isNaN(Date.parse(value))
    ? "Unknown date"
    : new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric"
      }).format(new Date(value));
export const sourceLabel = (assertion: CuratedAssertion) => {
  const source = assertion.sources[0];
  const title = source?.metadata?.title;
  if (typeof title === "string" && title.trim()) return title;
  return source?.sourceType?.replaceAll("_", " ") ?? "Koed memory";
};
const owned = (assertion: CuratedAssertion, ownerId: string | null) =>
  assertion.ownerUserId === ownerId && assertion.visibility === "personal";
export const who = (
  assertion: CuratedAssertion,
  ownerId: string | null,
  agents: readonly { id: string; name: string }[]
) =>
  !owned(assertion, ownerId)
    ? `Shared by ${assertion.sharedBy?.trim() || "a teammate"}`
    : assertion.authorKind === "agent"
      ? (agents.find((agent) => agent.id === assertion.authorRef)?.name ??
        "Your agent")
      : assertion.authorKind === "user"
        ? "You"
        : "Koed";
const askName = (assertion: CuratedAssertion) =>
  assertion.sharedBy?.trim() || "the owner";

export function WhatKoedKnows({
  api,
  project,
  projects,
  ownerId,
  profileKey,
  ownedAgents = [],
  panelHost,
  open,
  onClose,
  onChanged,
  openRequest
}: {
  api: CuratedMemoryDesktopApi;
  project: Project;
  projects: readonly Project[];
  ownerId: string | null;
  profileKey: string | null;
  ownedAgents?: readonly { id: string; name: string }[];
  panelHost?: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
  openRequest?: { id: number; item: CuratedAssertion } | null;
}) {
  const [tab, setTab] = useState<"project" | "me" | "unscoped">("project");
  const [rowState, setRowState] = useState<{
    key: number;
    items: CuratedAssertion[];
    cursor: MemoryCursor | null;
  }>({ key: -1, items: [], cursor: null });
  const [detailState, setDetailState] = useState<{
    key: number;
    item: CuratedAssertion;
  } | null>(null);
  const [busyState, setBusyState] = useState<{ key: number; busy: boolean }>({
    key: -1,
    busy: false
  });
  const [errorState, setErrorState] = useState<{
    key: number;
    message: string;
  }>({ key: -1, message: "" });
  const [undoState, setUndoState] = useState<{
    key: number;
    id: string;
    token: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const actionRef = useRef<number | null>(null);
  const externalOpenRef = useRef<{ id: number; done: boolean } | null>(null);
  const [countState, setCountState] = useState<{
    key: number;
    values: Record<"project" | "me" | "unscoped", string>;
  }>({ key: -1, values: { project: "", me: "", unscoped: "" } });
  const identityRef = useRef({
    api,
    ownerId,
    profileKey,
    projectId: project.id,
    open,
    tab,
    key: 0
  });
  const old = identityRef.current;
  if (
    old.api !== api ||
    old.ownerId !== ownerId ||
    old.profileKey !== profileKey ||
    old.projectId !== project.id ||
    old.open !== open ||
    old.tab !== tab
  ) {
    identityRef.current = {
      api,
      ownerId,
      profileKey,
      projectId: project.id,
      open,
      tab,
      key: old.key + 1
    };
  }
  const key = identityRef.current.key;
  const baseRef = useRef({
    api,
    ownerId,
    profileKey,
    projectId: project.id,
    open,
    key: 0
  });
  const base = baseRef.current;
  if (
    base.api !== api ||
    base.ownerId !== ownerId ||
    base.profileKey !== profileKey ||
    base.projectId !== project.id ||
    base.open !== open
  ) {
    baseRef.current = {
      api,
      ownerId,
      profileKey,
      projectId: project.id,
      open,
      key: base.key + 1
    };
  }
  const baseKey = baseRef.current.key;
  type Scope = "project" | "me" | "unscoped";
  const pageCache = useRef({
    baseKey,
    refresh,
    pages: new Map<Scope, Promise<CuratedMemoryPage>>()
  });
  if (
    pageCache.current.baseKey !== baseKey ||
    pageCache.current.refresh !== refresh
  ) {
    pageCache.current = {
      baseKey,
      refresh,
      pages: new Map<Scope, Promise<CuratedMemoryPage>>()
    };
  }
  const verifyPage = (
    page: CuratedMemoryPage,
    scope: "project" | "me" | "unscoped"
  ) => {
    if (
      page.assertions.some(
        (item) =>
          item.status !== "current" ||
          item.scope !== scope ||
          (scope !== "project" && item.visibility !== "personal") ||
          item.projectId !== (scope === "project" ? project.id : null) ||
          (item.visibility === "personal" && item.ownerUserId !== ownerId)
      )
    )
      throw new Error("Memory page crossed owner or scope.");
    return page;
  };
  const firstPage = (scope: "project" | "me" | "unscoped") => {
    const pages = pageCache.current.pages;
    let promise = pages.get(scope);
    if (!promise) {
      promise = api
        .page(scope, scope === "project" ? project.id : undefined)
        .then((page) => verifyPage(page, scope));
      pages.set(scope, promise);
      void promise.catch(() => {
        if (pages.get(scope) === promise) pages.delete(scope);
      });
    }
    return promise;
  };
  const rows = rowState.key === key ? rowState.items : [];
  const cursor = rowState.key === key ? rowState.cursor : null;
  const detail = detailState?.key === key ? detailState.item : null;
  const busy = busyState.key === key && busyState.busy;
  const error = errorState.key === key ? errorState.message : "";
  const undo = undoState?.key === key ? undoState : null;
  const counts =
    countState.key === baseKey
      ? countState.values
      : { project: "", me: "", unscoped: "" };
  const setError = (message: string) => setErrorState({ key, message });
  const setDetail = (item: CuratedAssertion | null) =>
    setDetailState(item ? { key, item } : null);
  const setUndo = (value: { id: string; token: string } | null) =>
    setUndoState(value ? { key, ...value } : null);
  const setBusy = (value: boolean) => setBusyState({ key, busy: value });
  useEffect(() => {
    setTab("project");
    setDetail(null);
    setUndo(null);
  }, [project.id, ownerId, profileKey]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    setBusy(true);
    firstPage(tab)
      .then((page) => {
        if (active && identityRef.current.key === key)
          setRowState({ key, items: page.assertions, cursor: page.nextCursor });
      })
      .catch((cause) => {
        if (active && identityRef.current.key === key)
          setError(
            cause instanceof Error
              ? cause.message
              : "Memory could not be loaded."
          );
      })
      .finally(() => {
        if (active && identityRef.current.key === key) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, open, tab, project.id, ownerId, profileKey, refresh, key]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.all([
      firstPage("project"),
      firstPage("me"),
      firstPage("unscoped")
    ])
      .then(([projectPage, mePage, otherPage]) => {
        if (active && baseRef.current.key === baseKey)
          setCountState({
            key: baseKey,
            values: {
              project: `${projectPage.assertions.length}${projectPage.nextCursor ? "+" : ""}`,
              me: `${mePage.assertions.length}${mePage.nextCursor ? "+" : ""}`,
              unscoped: `${otherPage.assertions.length}${otherPage.nextCursor ? "+" : ""}`
            }
          });
      })
      .catch(() => {
        if (active && baseRef.current.key === baseKey)
          setCountState({
            key: baseKey,
            values: { project: "", me: "", unscoped: "" }
          });
      });
    return () => {
      active = false;
    };
  }, [api, open, project.id, ownerId, profileKey, refresh, baseKey]);
  useEffect(() => {
    if (!open) {
      setDetail(null);
      setUndo(null);
    }
  }, [open]);
  const act = async (job: (current: () => boolean) => Promise<void>) => {
    if (actionRef.current === key) return;
    actionRef.current = key;
    const started = key;
    const current = () => identityRef.current.key === started;
    setBusy(true);
    setError("");
    try {
      await job(current);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error ? cause.message : "Memory action failed."
        );
    } finally {
      if (actionRef.current === started) actionRef.current = null;
      if (current()) setBusy(false);
    }
  };
  const openDetail = (listed: CuratedAssertion) =>
    void act(async (current) => {
      const item = await api.detail(listed.id);
      if (
        current() &&
        item.id === listed.id &&
        item.ownerUserId === listed.ownerUserId &&
        item.visibility === listed.visibility &&
        item.scope === tab &&
        (tab !== "project" || item.projectId === project.id)
      )
        setDetail(item);
    });
  useEffect(() => {
    if (!open || !openRequest) return;
    if (externalOpenRef.current?.id !== openRequest.id)
      externalOpenRef.current = { id: openRequest.id, done: false };
    if (externalOpenRef.current.done) return;
    if (tab !== openRequest.item.scope) {
      setTab(openRequest.item.scope);
      return;
    }
    externalOpenRef.current.done = true;
    openDetail(openRequest.item);
  }, [open, openRequest?.id, tab, key]);
  const forget = (assertion: CuratedAssertion) =>
    void act(async (current) => {
      if (!owned(assertion, ownerId)) return;
      const updated = await api.forget(assertion.id);
      if (!current()) return;
      if (!updated.suppressionToken)
        throw new Error("Undo token is unavailable.");
      setUndo({ id: assertion.id, token: updated.suppressionToken });
      setRowState((state) =>
        state.key === key
          ? {
              ...state,
              items: state.items.filter((item) => item.id !== assertion.id)
            }
          : state
      );
      setDetail(null);
      setRefresh((value) => value + 1);
      onChanged?.();
    });
  const undoForget = () =>
    void act(async (current) => {
      if (!undo) return;
      await api.undo(undo.id, undo.token);
      if (!current()) return;
      setUndo(null);
      setRefresh((value) => value + 1);
      onChanged?.();
    });
  const move = (
    assertion: CuratedAssertion,
    scope: "project" | "me",
    projectId?: string
  ) =>
    void act(async (current) => {
      if (assertion.scope !== "unscoped" || !owned(assertion, ownerId)) return;
      const result = await api.move(
        assertion.id,
        scope,
        assertion.classificationVersion,
        projectId
      );
      if (!current()) return;
      if (result.pending) {
        setError(
          "Move is pending while shared copies are withdrawn. Try again after synchronization."
        );
        return;
      }
      setDetail(null);
      setRefresh((value) => value + 1);
      onChanged?.();
    });
  if (!open) return null;
  const panel = (
    <aside className="hq-knows" aria-label="What Koed knows">
      <header className="hq-knows__header">
        <span className="hq-knows__mark">
          <Sparkles size={16} />
        </span>
        <strong>{detail ? kindLabel(detail.kind) : "What Koed knows"}</strong>
        <button type="button" onClick={onClose} aria-label="Close memory panel">
          <X size={17} />
        </button>
      </header>
      <p className="hq-knows__context">
        {detail
          ? `${detail.scope === "project" ? `In ${project.name}` : detail.scope === "me" ? "About you" : "Other"} · ${who(detail, ownerId, ownedAgents)} · ${date(detail.observedAt)}`
          : tab === "project"
            ? `${project.name} · used by every agent in it`
            : tab === "me"
              ? "About you · used in every project, by your agents only"
              : "Other things Koed knows · choose where they belong"}
      </p>
      <div className="hq-knows__body">
        {detail ? (
          <>
            <button
              type="button"
              className="hq-knows__back"
              onClick={() => setDetail(null)}
            >
              <ArrowLeft size={14} /> All memory
            </button>
            <h2>{detail.assertionText}</h2>
            <section className="hq-knows__origin">
              <h3>Where it came from</h3>
              <div>
                <span className="hq-knows__source-icon">
                  <FileText size={14} />
                </span>
                <span>
                  <strong>{sourceLabel(detail)}</strong>
                  <small>
                    {who(detail, ownerId, ownedAgents)} ·{" "}
                    {date(detail.sources[0]?.createdAt ?? detail.observedAt)}
                  </small>
                </span>
              </div>
            </section>
            {detail.replaces.length > 0 && (
              <section className="hq-knows__replaces">
                <h3>Replaces</h3>
                {detail.replaces.map((item) => (
                  <p key={item.id}>
                    <del>{item.text}</del>
                    <small>
                      {item.author?.kind === "user" ? "You" : "Earlier memory"}{" "}
                      · {date(item.at)}
                    </small>
                  </p>
                ))}
              </section>
            )}
            {owned(detail, ownerId) ? (
              <button
                type="button"
                className="hq-knows__forget"
                disabled={busy}
                onClick={() => forget(detail)}
              >
                <Trash2 size={13} /> Forget this
              </button>
            ) : (
              <p>
                {who(detail, ownerId, ownedAgents)} · Ask {askName(detail)} to
                change this memory.
              </p>
            )}
          </>
        ) : (
          <>
            <div
              className="hq-knows__tabs"
              role="tablist"
              aria-label="Memory scope"
            >
              {(
                [
                  ["project", "Project"],
                  ["me", "Me"],
                  ["unscoped", "Other"]
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => {
                    if (value === tab) return;
                    setRowState({ key: -1, items: [], cursor: null });
                    setDetail(null);
                    setError("");
                    setTab(value);
                  }}
                >
                  {label}
                  <em>{counts[value]}</em>
                </button>
              ))}
            </div>
            {busy && rows.length === 0 ? (
              <p className="hq-knows__empty">Loading memory…</p>
            ) : (
              groups.map(([kind, label]) => {
                const items = rows
                  .filter((row) => (row.kind ?? "legacy") === kind)
                  .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
                return items.length ? (
                  <section key={kind} className="hq-knows__group">
                    <h2>
                      {label} <span>· {items.length}</span>
                    </h2>
                    <div className="hq-knows__list">
                      {items.map((item) => (
                        <div
                          className="hq-knows__row"
                          key={item.id}
                          data-kind={kind}
                        >
                          <button
                            type="button"
                            className="hq-knows__item"
                            onClick={() => openDetail(item)}
                          >
                            <strong>{item.assertionText}</strong>
                            <small>
                              {who(item, ownerId, ownedAgents)} ·{" "}
                              {date(item.observedAt)} · {sourceLabel(item)}
                            </small>
                            {item.replaces.length > 0 && (
                              <small className="hq-knows__replaced">
                                Replaces an earlier {kind}
                              </small>
                            )}
                          </button>
                          {owned(item, ownerId) ? (
                            <button
                              type="button"
                              className="hq-knows__forget"
                              aria-label={`Forget: ${item.assertionText}`}
                              disabled={busy}
                              onClick={() => forget(item)}
                            >
                              <X size={13} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="hq-knows__ask"
                              onClick={() =>
                                setError(
                                  `Ask ${askName(item)} in your Team conversation.`
                                )
                              }
                            >
                              Ask {askName(item)}
                            </button>
                          )}
                          {tab === "unscoped" && owned(item, ownerId) && (
                            <select
                              aria-label={`Move ${item.assertionText} to`}
                              defaultValue=""
                              disabled={busy}
                              onChange={(event) => {
                                const value = event.target.value;
                                if (value === "me") move(item, "me");
                                else if (value) move(item, "project", value);
                                event.target.value = "";
                              }}
                            >
                              <option value="">Move to…</option>
                              <option value="me">Me</option>
                              {projects
                                .filter((p) => p.lifecycle === "active")
                                .map((p) => (
                                  <option value={p.id} key={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                            </select>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null;
              })
            )}
            {!busy && rows.length === 0 && !error && (
              <p className="hq-knows__empty">Nothing here yet.</p>
            )}
            {cursor && (
              <button
                type="button"
                className="hq-knows__load-more"
                disabled={busy}
                onClick={() =>
                  void act(async (current) => {
                    const page = await api.page(
                      tab,
                      tab === "project" ? project.id : undefined,
                      cursor
                    );
                    if (!current()) return;
                    verifyPage(page, tab);
                    if (
                      page.assertions.some((item) =>
                        rows.some((oldItem) => oldItem.id === item.id)
                      ) ||
                      (page.nextCursor &&
                        page.nextCursor.updatedAt === cursor.updatedAt &&
                        page.nextCursor.id === cursor.id)
                    )
                      throw new Error("Memory pagination did not advance.");
                    setRowState({
                      key,
                      items: [...rows, ...page.assertions],
                      cursor: page.nextCursor
                    });
                  })
                }
              >
                Load more memory
              </button>
            )}
            <p className="hq-knows__note">
              {tab === "me"
                ? "Only your agents see this in every Project. Nothing here is shared with your Team."
                : tab === "project"
                  ? "Decisions, facts and what agents learn here show up as you work."
                  : "Older memory stays here until you move it explicitly."}
            </p>
          </>
        )}
        {error && (
          <p className="hq-knows__error" role="alert">
            {error}{" "}
            <button
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RotateCw size={13} /> Retry
            </button>
          </p>
        )}
      </div>
      {undo && (
        <div className="hq-knows__undo" role="status">
          Forgotten{" "}
          <button type="button" disabled={busy} onClick={undoForget}>
            Undo
          </button>
          <small>Available for 7 days</small>
        </div>
      )}
    </aside>
  );
  return panelHost ? createPortal(panel, panelHost) : panel;
}
