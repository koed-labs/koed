import { ChevronDown, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CuratedAssertion,
  CuratedMemoryDesktopApi,
  MemoryCursor
} from "../../../ipc/curated-memory-protocol.js";
import { sourceLabel, who } from "../memory/WhatKoedKnows.js";
import "./hq-learned-today.css";

export const localTodayStart = (now = new Date()) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

export function HqLearnedToday({
  api,
  projectId,
  ownerId,
  onChanged,
  onCount,
  onOpenItem,
  memoryRevision,
  ownedAgents = []
}: {
  api: CuratedMemoryDesktopApi;
  projectId: string;
  ownerId: string | null;
  onChanged?: () => void;
  onCount?: (count: number) => void;
  onOpenItem?: (item: CuratedAssertion) => void;
  memoryRevision?: number;
  ownedAgents?: readonly { id: string; name: string }[];
}) {
  const [since, setSince] = useState(() => localTodayStart());
  const [items, setItems] = useState<CuratedAssertion[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const active = useRef(true);
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = localTodayStart();
      if (next !== since) {
        setItems([]);
        setSince(next);
      } else if (document.visibilityState === "visible") {
        setRevision((value) => value + 1);
      }
    }, 60_000);
    const onForeground = () => {
      if (document.visibilityState !== "visible") return;
      const next = localTodayStart();
      if (next !== since) {
        setItems([]);
        setSince(next);
      } else setRevision((value) => value + 1);
    };
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
    };
  }, [since]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setItems([]);
    setError("");
    const load = async () => {
      const found: CuratedAssertion[] = [];
      const seen = new Set<string>();
      let cursor: MemoryCursor | undefined;
      do {
        const page = await api.page("project", projectId, cursor, since);
        for (const assertion of page.assertions) {
          if (
            assertion.ownerUserId !== ownerId ||
            assertion.visibility !== "personal" ||
            assertion.scope !== "project" ||
            assertion.projectId !== projectId ||
            assertion.status !== "current" ||
            !Number.isFinite(Date.parse(assertion.createdAt)) ||
            Date.parse(assertion.createdAt) < Date.parse(since)
          )
            throw new Error("Learned today crossed memory scope.");
          if (!seen.has(assertion.id)) found.push(assertion);
          seen.add(assertion.id);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(`cursor:${cursor.id}`))
          throw new Error("Learned today cursor did not advance.");
        if (cursor) seen.add(`cursor:${cursor.id}`);
      } while (cursor && current);
      if (current) {
        setItems(found.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        onCountRef.current?.(found.length);
        setLoading(false);
      }
    };
    void load().catch((cause) => {
      if (current) {
        setError(
          cause instanceof Error ? cause.message : "Memory unavailable."
        );
        onCountRef.current?.(0);
        setLoading(false);
      }
    });
    return () => {
      current = false;
    };
  }, [api, projectId, ownerId, since, revision, memoryRevision]);

  const forget = async (item: CuratedAssertion) => {
    if (busyId || item.ownerUserId !== ownerId) return;
    setBusyId(item.id);
    setError("");
    try {
      const result = await api.forget(item.id);
      if (!active.current) return;
      if (
        result.id !== item.id ||
        result.ownerUserId !== ownerId ||
        result.visibility !== "personal" ||
        result.scope !== "project" ||
        result.projectId !== projectId ||
        result.status !== "suppressed" ||
        !result.suppressionToken
      )
        throw new Error("Forget did not return an Undo token.");
      setUndo({ id: item.id, token: result.suppressionToken });
      setItems((existing) => existing.filter((entry) => entry.id !== item.id));
      onCountRef.current?.(items.length - 1);
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Forget failed.");
    } finally {
      setBusyId(null);
    }
  };

  const undoForget = async () => {
    if (!undo || busyId) return;
    const exact = undo;
    setBusyId(exact.id);
    setError("");
    try {
      const result = await api.undo(exact.id, exact.token);
      if (!active.current) return;
      if (
        result.id !== exact.id ||
        result.ownerUserId !== ownerId ||
        result.visibility !== "personal" ||
        result.scope !== "project" ||
        result.projectId !== projectId ||
        result.status !== "current" ||
        result.suppressionToken !== null
      )
        throw new Error("Undo returned a different memory.");
      setUndo(null);
      setRevision((value) => value + 1);
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Undo failed.");
    } finally {
      setBusyId(null);
    }
  };

  if (!loading && !items.length && !undo && !error) return null;
  return (
    <div className="hq-learned-today" aria-label="Learned today">
      {items.length ? (
        <button
          type="button"
          className="hq-learned-today__heading"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Sparkles size={15} aria-hidden="true" />
          <strong>
            Learned {items.length} {items.length === 1 ? "thing" : "things"}{" "}
            today
          </strong>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      ) : loading ? (
        <span className="hq-learned-today__status">Loading memory…</span>
      ) : null}
      {expanded && items.length ? (
        <div className="hq-learned-today__list">
          {items.map((item) => (
            <div className="hq-learned-today__item" key={item.id}>
              <button
                type="button"
                className="hq-learned-today__detail"
                onClick={() => onOpenItem?.(item)}
              >
                <i data-kind={item.kind ?? "legacy"} aria-hidden="true" />
                <span>
                  <b>{item.assertionText}</b>
                  <em>
                    {item.kind
                      ? item.kind.charAt(0).toUpperCase() + item.kind.slice(1)
                      : "Memory"}
                    {` · ${who(item, ownerId, ownedAgents) === "You" ? "you" : who(item, ownerId, ownedAgents)} · ${sourceLabel(item)}`}
                  </em>
                </span>
              </button>
              <button
                type="button"
                className="hq-learned-today__forget"
                aria-label={`Forget: ${item.assertionText}`}
                title="Forget"
                disabled={busyId !== null || item.ownerUserId !== ownerId}
                onClick={() => void forget(item)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {undo ? (
        <div className="hq-learned-today__undo">
          Memory forgotten.
          <button
            type="button"
            disabled={busyId !== null}
            onClick={() => void undoForget()}
          >
            Undo
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
