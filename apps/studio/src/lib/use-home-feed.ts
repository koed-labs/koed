"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HomeItem, HomeSnapshot, HomeSource } from "@koed/shared/home";
import {
  HomeFeedClient,
  HomeFeedError,
  type HomeFeedTransport
} from "./home-feed-client";
import { useVisibleRefresh } from "./use-visible-refresh";

export type HomeFeedState = "loading" | "ready" | "offline" | "unauthorized";
const HOME_SOURCES: HomeSource[] = [
  "managed_runtime_item",
  "managed_execution",
  "personal_agent_job",
  "pull_request_review"
];

export function useHomeFeed({
  transport,
  identityKey,
  enabled = true,
  autoRefresh = true
}: {
  transport: HomeFeedTransport;
  identityKey: string | null;
  enabled?: boolean;
  autoRefresh?: boolean;
}) {
  const client = useMemo(() => new HomeFeedClient(transport), [transport]);
  const [snapshot, setSnapshot] = useState<HomeSnapshot | null>(null);
  const [state, setState] = useState<HomeFeedState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(
    () => new Set()
  );
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState<Set<HomeSource>>(
    () => new Set()
  );
  const [lastLoadedIdentity, setLastLoadedIdentity] = useState<string | null>(
    null
  );
  const snapshotRef = useRef<HomeSnapshot | null>(null);
  const loadedIdentityRef = useRef<string | null>(null);
  const verifiedScopeRef = useRef<string | null>(null);
  const pageDepth = useRef<Record<HomeSource, number>>({
    managed_runtime_item: 1,
    managed_execution: 1,
    personal_agent_job: 1,
    pull_request_review: 1
  });
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || identityKey === null || controller.current) return;
    const current = ++sequence.current;
    const nextController = new AbortController();
    controller.current = nextController;
    const budget = { remaining: 4 * 1024 * 1024, requests: 0 };
    const timeout = window.setTimeout(
      () => nextController.abort(new Error("Home refresh timed out")),
      15_000
    );
    try {
      const access = await client.getAccess(nextController.signal);
      if (current !== sequence.current) return;
      setRefreshing(true);
      if (loadedIdentityRef.current !== identityKey) {
        snapshotRef.current = null;
        setSnapshot(null);
        setState("loading");
        setLastLoadedIdentity(null);
        setPendingItemIds(new Set());
        setMutationError(null);
        pageDepth.current = initialPageDepth();
      }
      if (
        verifiedScopeRef.current !== null &&
        verifiedScopeRef.current !== access.accountScope
      ) {
        snapshotRef.current = null;
        setSnapshot(null);
        setState("loading");
        setLastLoadedIdentity(null);
        setPendingItemIds(new Set());
        setMutationError(null);
        pageDepth.current = initialPageDepth();
      }
      verifiedScopeRef.current = access.accountScope;
      let result: HomeSnapshot;
      try {
        result = await readLoadedPages(
          client,
          nextController.signal,
          pageDepth.current,
          budget
        );
      } catch (error) {
        if (
          error instanceof HomeFeedError &&
          error.status === 409 &&
          snapshotRef.current
        ) {
          pageDepth.current = initialPageDepth();
          result = await readLoadedPages(
            client,
            nextController.signal,
            pageDepth.current,
            budget
          );
        } else {
          throw error;
        }
      }
      if (current !== sequence.current) return;
      if (result.accountScope !== access.accountScope) {
        snapshotRef.current = null;
        setSnapshot(null);
        setState("offline");
        throw new HomeFeedError("Home access changed while loading.", 409);
      }
      if (
        loadedIdentityRef.current !== identityKey ||
        snapshotRef.current?.accountScope !== result.accountScope
      ) {
        setPendingItemIds(new Set());
        setMutationError(null);
        pageDepth.current = initialPageDepth();
      }
      snapshotRef.current = result;
      loadedIdentityRef.current = identityKey;
      setSnapshot(result);
      setState("ready");
      setLastLoadedIdentity(identityKey);
      return result.coverage.every(
        (entry) => entry.complete || entry.nextCursor !== null
      );
    } catch (error) {
      if (
        current !== sequence.current ||
        (isAbortError(error) && isAbortError(nextController.signal.reason))
      )
        return;
      if (
        error instanceof HomeFeedError &&
        (error.status === 401 || error.status === 403)
      ) {
        snapshotRef.current = null;
        setSnapshot(null);
        setState("unauthorized");
        setLastLoadedIdentity(identityKey);
      } else {
        if (!snapshotRef.current) {
          setSnapshot(null);
          setLastLoadedIdentity(identityKey);
        }
        setState("offline");
      }
      return false;
    } finally {
      window.clearTimeout(timeout);
      if (current === sequence.current) {
        setRefreshing(false);
        controller.current = null;
      }
    }
  }, [client, enabled, identityKey]);

  useVisibleRefresh(refresh, autoRefresh && enabled && identityKey !== null);

  useEffect(() => {
    if (!enabled || identityKey === null) {
      snapshotRef.current = null;
      loadedIdentityRef.current = null;
      verifiedScopeRef.current = null;
      pageDepth.current = initialPageDepth();
      // Clear owner-scoped data as soon as auth is disabled; stale rows must not
      // reappear if the same identity signs in again before another fetch wins.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSnapshot(null);
      setLastLoadedIdentity(null);
      setState("loading");
      setPendingItemIds(new Set());
      setMutationError(null);
      return;
    }
    if (loadedIdentityRef.current !== identityKey) {
      snapshotRef.current = null;
      loadedIdentityRef.current = null;
      verifiedScopeRef.current = null;
      pageDepth.current = initialPageDepth();
    }
    return () => {
      sequence.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, [enabled, identityKey, refresh]);

  const setCleared = useCallback(
    async (item: HomeItem, cleared: boolean) => {
      if (
        state !== "ready" ||
        !snapshot ||
        pendingItemIds.has(item.sourceEventId)
      )
        return;
      setMutationError(null);
      setPendingItemIds((current) => new Set(current).add(item.sourceEventId));
      try {
        await client.setCleared(item, cleared);
        // A poll started before the mutation may contain its old state.
        controller.current?.abort();
        controller.current = null;
        await refresh();
      } catch (error) {
        setMutationError(
          error instanceof Error ? error.message : "Home update failed."
        );
        if (
          error instanceof HomeFeedError &&
          (error.status === 401 || error.status === 403)
        ) {
          snapshotRef.current = null;
          setSnapshot(null);
          setState("unauthorized");
        } else if (error instanceof HomeFeedError && error.status === 409) {
          await refresh();
        }
      } finally {
        setPendingItemIds((current) => {
          const next = new Set(current);
          next.delete(item.sourceEventId);
          return next;
        });
      }
    },
    [client, pendingItemIds, refresh, snapshot, state]
  );

  const loadMore = useCallback(
    async (source: HomeSource) => {
      const base = snapshotRef.current;
      if (state !== "ready" || !base || loadingSources.has(source)) return;
      const cursor = base.coverage.find(
        (entry) => entry.source === source
      )?.nextCursor;
      if (!cursor) return;
      const current = ++sequence.current;
      const nextController = new AbortController();
      controller.current?.abort();
      controller.current = nextController;
      setLoadingSources((value) => new Set(value).add(source));
      try {
        const access = await client.getAccess(nextController.signal);
        if (current !== sequence.current) return;
        if (access.accountScope !== base.accountScope) {
          verifiedScopeRef.current = access.accountScope;
          snapshotRef.current = null;
          setSnapshot(null);
          setLastLoadedIdentity(null);
          setPendingItemIds(new Set());
          pageDepth.current = initialPageDepth();
          setState("loading");
          controller.current = null;
          await refresh();
          return;
        }
        const page = await client.get(
          { source, cursor, limit: 100 },
          nextController.signal
        );
        if (
          current !== sequence.current ||
          page.accountScope !== base.accountScope
        )
          return;
        const merged = mergeSourcePage(base, page, source);
        snapshotRef.current = merged;
        pageDepth.current[source] += 1;
        setSnapshot(merged);
      } catch (error) {
        if (current !== sequence.current || isAbortError(error)) return;
        if (
          error instanceof HomeFeedError &&
          (error.status === 401 || error.status === 403)
        ) {
          snapshotRef.current = null;
          setSnapshot(null);
          setState("unauthorized");
        } else if (error instanceof HomeFeedError && error.status === 409) {
          pageDepth.current = initialPageDepth();
          controller.current = null;
          await refresh();
        } else {
          setState("offline");
        }
      } finally {
        if (current === sequence.current) controller.current = null;
        setLoadingSources((value) => {
          const next = new Set(value);
          next.delete(source);
          return next;
        });
      }
    },
    [client, loadingSources, refresh, state]
  );

  const visibleSnapshot = lastLoadedIdentity === identityKey ? snapshot : null;
  const visibleState =
    identityKey === null ||
    !enabled ||
    (lastLoadedIdentity !== null && lastLoadedIdentity !== identityKey) ||
    (snapshot !== null && visibleSnapshot === null && state === "ready")
      ? "loading"
      : state;

  return {
    snapshot: visibleSnapshot,
    state: visibleState,
    refreshing,
    mutationError,
    pendingItemIds,
    loadingSources,
    canMutate: visibleState === "ready",
    refresh,
    loadMore,
    setCleared
  };
}

export type HomeFeedController = ReturnType<typeof useHomeFeed>;

function isAbortError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function initialPageDepth(): Record<HomeSource, number> {
  return {
    managed_runtime_item: 1,
    managed_execution: 1,
    personal_agent_job: 1,
    pull_request_review: 1
  };
}

async function readLoadedPages(
  client: HomeFeedClient,
  signal: AbortSignal,
  depth: Record<HomeSource, number>,
  budget: { remaining: number; requests: number }
): Promise<HomeSnapshot> {
  // Bound the entire refresh, including pages explicitly opened by the user.
  if (++budget.requests > 32)
    throw new HomeFeedError("Home refresh exceeded its page budget.", 502);
  const first = await client.get({}, signal, budget);
  const allPages = await Promise.all(
    HOME_SOURCES.map(async (source) => {
      const pages = [first];
      let cursor =
        first.coverage.find((entry) => entry.source === source)?.nextCursor ??
        null;
      for (
        let pageIndex = 1;
        pageIndex < depth[source] && cursor;
        pageIndex += 1
      ) {
        if (++budget.requests > 32)
          throw new HomeFeedError(
            "Home refresh exceeded its page budget.",
            502
          );
        const page = await client.get(
          { source, cursor, limit: 100 },
          signal,
          budget
        );
        if (page.accountScope !== first.accountScope)
          throw new HomeFeedError("Home account changed while loading.", 409);
        pages.push(page);
        cursor =
          page.coverage.find((entry) => entry.source === source)?.nextCursor ??
          null;
      }
      return { source, pages };
    })
  );
  const merged = { ...first };
  for (const field of ["needsYou", "ongoing", "recent", "cleared"] as const) {
    const rows: HomeItem[] = [];
    for (const { source, pages } of allPages) {
      for (const page of pages)
        rows.push(...page[field].filter((item) => item.source === source));
    }
    merged[field] = mergeItems(rows).sort(
      compareHomeItems
    ) as (typeof merged)[typeof field];
  }
  merged.coverage = allPages.map(({ source, pages }) => {
    const lastPage = pages.at(-1) ?? first;
    return (
      lastPage.coverage.find((entry) => entry.source === source) ??
      first.coverage.find((entry) => entry.source === source)!
    );
  });
  return merged;
}

function mergeSourcePage(
  base: HomeSnapshot,
  page: HomeSnapshot,
  source: HomeSource
): HomeSnapshot {
  const next = { ...base };
  for (const field of ["needsYou", "ongoing", "recent", "cleared"] as const) {
    next[field] = mergeItems([
      ...base[field],
      ...page[field].filter((item) => item.source === source)
    ]).sort(compareHomeItems);
  }
  next.coverage = [
    ...base.coverage.filter((entry) => entry.source !== source),
    ...page.coverage.filter((entry) => entry.source === source)
  ];
  next.badgeCount = page.badgeCount;
  next.generatedAt = page.generatedAt;
  return next;
}

function mergeItems(items: HomeItem[]) {
  const byId = new Map<string, HomeItem>();
  for (const item of items) byId.set(item.sourceEventId, item);
  return [...byId.values()];
}

function compareHomeItems(a: HomeItem, b: HomeItem) {
  const rank = (item: HomeItem) =>
    item.state === "blocked" ? 0 : item.state === "review" ? 1 : 2;
  return (
    rank(a) - rank(b) ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.sourceEventId.localeCompare(b.sourceEventId)
  );
}
