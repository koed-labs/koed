"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listPersonalRemovals,
  setPersonalRemoval,
  type PersonalRemovalTarget
} from "@/lib/personal-removals-client";
import {
  applyPersonalRemoval,
  personalRemovalsLoadMayApply
} from "./personal-removals-state";
import {
  createPersonalCatalogCacheStore,
  persistPersonalCatalogRemovals,
  personalCatalogOwnerId
} from "./personal-catalog-cache";

const PERSONAL_REMOVALS_CHANGED_EVENT = "koed:personal-removals-changed";
type RemovalChange = {
  target: PersonalRemovalTarget;
  removed: boolean;
  scopeKey?: string | null;
};

function publishRemovalChange(change: RemovalChange, scopeKey: string | null) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PERSONAL_REMOVALS_CHANGED_EVENT, {
        detail: { ...change, scopeKey }
      })
    );
  }
}

async function loadRemovalsWithBoundedRetry(): Promise<
  PersonalRemovalTarget[]
> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await listPersonalRemovals();
    } catch (reason) {
      failure = reason;
      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt === 0 ? 250 : 650)
        );
      }
    }
  }
  throw failure;
}

export function usePersonalRemovals({
  enabled = true,
  scopeKey = null
}: { enabled?: boolean; scopeKey?: string | null } = {}) {
  const [removals, setRemovals] = useState<PersonalRemovalTarget[]>([]);
  const [lastRemoved, setLastRemoved] = useState<PersonalRemovalTarget | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const removalsRef = useRef<PersonalRemovalTarget[]>([]);
  const readyRef = useRef(false);
  const loadPromiseRef = useRef<Promise<PersonalRemovalTarget[]> | null>(null);
  const pendingChangesRef = useRef<RemovalChange[]>([]);
  const requestSequenceRef = useRef(0);
  const activeRef = useRef(false);
  const scopeRef = useRef<string | null>(scopeKey);
  const cacheStoreRef = useRef<ReturnType<
    typeof createPersonalCatalogCacheStore
  > | null>(null);
  scopeRef.current = scopeKey;

  const load = useCallback(() => {
    const sequence = ++requestSequenceRef.current;
    setLoading(true);
    setError(null);
    if (!readyRef.current) setReady(false);
    const request = loadRemovalsWithBoundedRetry()
      .then((result) => {
        // Mutations from another mounted hook in this window during this request are
        // deltas; apply them after the snapshot so none can be overwritten.
        if (
          !activeRef.current ||
          !personalRemovalsLoadMayApply(sequence, requestSequenceRef.current)
        ) {
          return removalsRef.current;
        }
        const current = pendingChangesRef.current.reduce(
          (snapshot, change) =>
            applyPersonalRemoval(snapshot, change.target, change.removed),
          result
        );
        pendingChangesRef.current = [];
        removalsRef.current = current;
        readyRef.current = true;
        setRemovals(current);
        setRemovalsScope(scopeKey);
        setReady(true);
        setError(null);
        if (scopeKey && cacheStoreRef.current) {
          void persistPersonalCatalogRemovals(
            cacheStoreRef.current,
            scopeKey,
            current
          );
        }
        return current;
      })
      .catch((reason: unknown) => {
        if (
          !activeRef.current ||
          !personalRemovalsLoadMayApply(sequence, requestSequenceRef.current)
        ) {
          throw reason;
        }
        const message =
          reason instanceof Error
            ? reason.message
            : "Personal Studio preferences could not be loaded.";
        setError(message);
        setReady(readyRef.current);
        throw reason;
      })
      .finally(() => {
        if (
          activeRef.current &&
          personalRemovalsLoadMayApply(sequence, requestSequenceRef.current)
        ) {
          setLoading(false);
        }
      });
    loadPromiseRef.current = request;
    return request;
  }, [scopeKey]);

  const [removalsScope, setRemovalsScope] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    activeRef.current = true;
    const ownerId = personalCatalogOwnerId(scopeKey);
    const store =
      ownerId && scopeKey
        ? createPersonalCatalogCacheStore({ ownerId, scopeKey })
        : null;
    scopeRef.current = scopeKey;
    cacheStoreRef.current = store;
    removalsRef.current = [];
    readyRef.current = false;
    setRemovals([]);
    setRemovalsScope(null);
    setLastRemoved(null);
    setReady(false);
    pendingChangesRef.current = [];
    const receiveUpdate = (event: Event) => {
      const change = (event as CustomEvent<unknown>).detail;
      if (
        !change ||
        typeof change !== "object" ||
        !("scopeKey" in change) ||
        change.scopeKey !== scopeKey ||
        !("target" in change) ||
        !("removed" in change) ||
        typeof change.removed !== "boolean"
      )
        return;
      const update = change as RemovalChange;
      if (!readyRef.current) {
        pendingChangesRef.current.push(update);
        return;
      }
      const next = applyPersonalRemoval(
        removalsRef.current,
        update.target,
        update.removed
      );
      removalsRef.current = next;
      setRemovals(next);
      if (scopeKey && cacheStoreRef.current) {
        void persistPersonalCatalogRemovals(
          cacheStoreRef.current,
          scopeKey,
          next
        );
      }
    };
    window.addEventListener(PERSONAL_REMOVALS_CHANGED_EVENT, receiveUpdate);
    if (store && scopeKey) {
      void store.read().then((cached) => {
        if (
          !activeRef.current ||
          scopeRef.current !== scopeKey ||
          !cached ||
          readyRef.current
        )
          return;
        const restored = pendingChangesRef.current.reduce(
          (snapshot, change) =>
            applyPersonalRemoval(snapshot, change.target, change.removed),
          [...cached.removals]
        );
        pendingChangesRef.current = [];
        removalsRef.current = restored;
        setRemovals(restored);
        setRemovalsScope(scopeKey);
        readyRef.current = true;
        setReady(true);
      });
    }
    // Loading synchronizes browsing preferences with the authenticated API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (scopeKey) void load().catch(() => undefined);
    else setLoading(false);
    return () => {
      activeRef.current = false;
      requestSequenceRef.current += 1;
      window.removeEventListener(
        PERSONAL_REMOVALS_CHANGED_EVENT,
        receiveUpdate
      );
    };
  }, [enabled, load, scopeKey]);

  const update = useCallback(
    async (target: PersonalRemovalTarget, removed: boolean) => {
      if (!readyRef.current) {
        try {
          await loadPromiseRef.current;
        } catch {
          // The error message is shown in the list and the operation stays blocked.
        }
      }
      if (!readyRef.current) {
        throw new Error(
          "Personal Studio preferences could not be loaded. Retry before changing this list."
        );
      }
      await setPersonalRemoval(target, removed);
      const next = applyPersonalRemoval(removalsRef.current, target, removed);
      removalsRef.current = next;
      setRemovals(next);
      setRemovalsScope(scopeRef.current);
      if (scopeRef.current && cacheStoreRef.current) {
        void persistPersonalCatalogRemovals(
          cacheStoreRef.current,
          scopeRef.current,
          next
        );
      }
      publishRemovalChange({ target, removed }, scopeRef.current);
      setError(null);
      setReady(true);
      if (removed) setLastRemoved(target);
      else {
        setLastRemoved((current) =>
          current &&
          current.kind === target.kind &&
          (current.kind === "project"
            ? current.projectId ===
              (target as Extract<PersonalRemovalTarget, { kind: "project" }>)
                .projectId
            : current.sourceId ===
              (
                target as Extract<
                  PersonalRemovalTarget,
                  { kind: "conversation" }
                >
              ).sourceId)
            ? null
            : current
        );
      }
    },
    []
  );

  const remove = useCallback(
    (target: PersonalRemovalTarget) => update(target, true),
    [update]
  );
  const restore = useCallback(
    (target: PersonalRemovalTarget) => update(target, false),
    [update]
  );
  const undoLast = useCallback(async () => {
    if (lastRemoved) await restore(lastRemoved);
  }, [lastRemoved, restore]);

  return {
    lastRemoved,
    error,
    removals: removalsScope === scopeKey ? removals : [],
    ready: !enabled || (removalsScope === scopeKey && ready),
    loading: enabled && loading,
    load,
    remove,
    restore,
    undoLast
  };
}
