"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  TeamOverviewItem,
  TeamOverviewSnapshot
} from "@koed/shared/team-overview";
import {
  TeamOverviewClient,
  TeamOverviewError,
  type TeamOverviewTransport
} from "./team-overview-client";

export type TeamOverviewState =
  | "loading"
  | "ready"
  | "offline"
  | "unauthorized";

export function useTeamOverview({
  transport,
  identityKey,
  enabled = true
}: {
  transport: TeamOverviewTransport;
  identityKey: string | null;
  enabled?: boolean;
}) {
  const client = useMemo(() => new TeamOverviewClient(transport), [transport]);
  const [snapshot, setSnapshot] = useState<TeamOverviewSnapshot | null>(null);
  const [state, setState] = useState<TeamOverviewState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(
    () => new Set()
  );
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const snapshotRef = useRef<TeamOverviewSnapshot | null>(null);
  const loadedIdentityRef = useRef<string | null>(null);
  const requestSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pendingRef = useRef(new Set<string>());
  const generation = useRef(0);
  const identityScope = useRef(identityKey);
  const pageCount = useRef(1);
  const refreshRef = useRef<
    (cursor?: string, retryAfterConflict?: boolean) => Promise<void>
  >(async () => undefined);

  // Fence outstanding requests as soon as auth identity changes, before effects run.
  useLayoutEffect(() => {
    if (identityScope.current === identityKey) return;
    identityScope.current = identityKey;
    generation.current += 1;
    snapshotRef.current = null;
    loadedIdentityRef.current = null;
    pendingRef.current.clear();
    pageCount.current = 1;
  }, [identityKey]);

  const refresh = useCallback(
    async (cursor?: string, retryAfterConflict = false) => {
      if (
        !enabled ||
        identityKey === null ||
        identityScope.current !== identityKey
      )
        return;
      const requestGeneration = generation.current;
      const sequence = ++requestSequence.current;
      controller.current?.abort();
      const requestController = new AbortController();
      controller.current = requestController;
      setRefreshing(true);
      try {
        const firstPage = cursor
          ? await client.getOverview(
              { cursor, limit: 100 },
              requestController.signal
            )
          : await readLoadedPages(
              client,
              requestController.signal,
              pageCount.current
            );
        if (
          !requestIsCurrent(
            sequence,
            requestGeneration,
            requestSequence,
            generation,
            identityScope,
            identityKey
          )
        )
          return;
        const prior = snapshotRef.current;
        const authorityChanged = Boolean(
          prior &&
          (prior.access.accountScope !== firstPage.access.accountScope ||
            prior.access.backendId !== firstPage.access.backendId ||
            !sameTeamAccess(prior, firstPage))
        );
        const identityChanged = loadedIdentityRef.current !== identityKey;
        if (authorityChanged || identityChanged) {
          generation.current += 1;
          snapshotRef.current = null;
          setSnapshot(null);
          setPendingItemIds(new Set());
          pendingRef.current.clear();
          setMutationError(null);
          pageCount.current = 1;
        }
        const next =
          cursor && prior && !authorityChanged && !identityChanged
            ? mergePage(prior, firstPage)
            : firstPage;
        snapshotRef.current = next;
        loadedIdentityRef.current = identityKey;
        setLoadedIdentity(identityKey);
        setSnapshot(next);
        setState("ready");
        if (cursor) pageCount.current += 1;
        else pageCount.current = countPagesRead(firstPage, pageCount.current);
      } catch (failure) {
        if (
          !requestIsCurrent(
            sequence,
            requestGeneration,
            requestSequence,
            generation,
            identityScope,
            identityKey
          ) ||
          isAbortError(failure)
        )
          return;
        if (
          failure instanceof TeamOverviewError &&
          [401, 403].includes(failure.status)
        ) {
          generation.current += 1;
          snapshotRef.current = null;
          loadedIdentityRef.current = null;
          setSnapshot(null);
          setLoadedIdentity(identityKey);
          setPendingItemIds(new Set());
          pendingRef.current.clear();
          setMutationError(null);
          pageCount.current = 1;
          setState("unauthorized");
        } else if (
          failure instanceof TeamOverviewError &&
          failure.status === 409
        ) {
          generation.current += 1;
          snapshotRef.current = null;
          loadedIdentityRef.current = null;
          setSnapshot(null);
          setLoadedIdentity(null);
          setPendingItemIds(new Set());
          pendingRef.current.clear();
          setMutationError(null);
          setState("loading");
          pageCount.current = 1;
          if (!retryAfterConflict) void refreshRef.current(undefined, true);
        } else {
          if (loadedIdentityRef.current !== identityKey) {
            snapshotRef.current = null;
            setSnapshot(null);
            setLoadedIdentity(identityKey);
          }
          setState("offline");
        }
      } finally {
        if (
          sequence === requestSequence.current &&
          identityScope.current === identityKey
        ) {
          setRefreshing(false);
          controller.current = null;
        }
      }
    },
    [client, enabled, identityKey]
  );

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled || identityKey === null) {
      generation.current += 1;
      snapshotRef.current = null;
      loadedIdentityRef.current = null;
      pendingRef.current.clear();
      pageCount.current = 1;
      // Authentication changes purge Team data and badges from memory.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSnapshot(null);
      setLoadedIdentity(null);
      setState("loading");
      setRefreshing(false);
      setPendingItemIds(new Set());
      setMutationError(null);
      return;
    }
    if (loadedIdentityRef.current !== identityKey) {
      snapshotRef.current = null;
      loadedIdentityRef.current = null;
      setSnapshot(null);
      setLoadedIdentity(null);
      setState("loading");
      setPendingItemIds(new Set());
      pendingRef.current.clear();
      pageCount.current = 1;
    }
    const initial = window.setTimeout(() => void refresh(), 0);
    const onWake = () => void refresh();
    const onOnline = () => void refresh();
    const onOffline = () => {
      if (loadedIdentityRef.current === identityKey && snapshotRef.current)
        setState("offline");
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => {
      requestSequence.current += 1;
      controller.current?.abort();
      window.clearTimeout(initial);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(interval);
    };
  }, [enabled, identityKey, refresh]);

  const mutate = useCallback(
    async (
      item: TeamOverviewItem,
      action: "clear" | "restore" | "seen"
    ): Promise<boolean> => {
      if (action === "seen" && item.kind !== "job_outcome") return false;
      if (
        state !== "ready" ||
        !snapshotRef.current ||
        identityScope.current !== identityKey ||
        pendingRef.current.has(item.sourceEventId)
      )
        return false;
      const capturedGeneration = generation.current;
      const capturedIdentity = identityKey;
      pendingRef.current.add(item.sourceEventId);
      setPendingItemIds((current) => new Set(current).add(item.sourceEventId));
      setMutationError(null);
      try {
        await client.mutate(item, action);
        if (
          capturedGeneration !== generation.current ||
          capturedIdentity !== identityScope.current
        )
          return false;
        if (action === "seen") void refresh();
        else await refresh();
        return true;
      } catch (failure) {
        if (
          capturedGeneration !== generation.current ||
          capturedIdentity !== identityScope.current
        )
          return false;
        setMutationError(
          failure instanceof Error
            ? failure.message
            : "Team activity could not be updated."
        );
        if (
          failure instanceof TeamOverviewError &&
          [401, 403].includes(failure.status)
        ) {
          generation.current += 1;
          snapshotRef.current = null;
          loadedIdentityRef.current = null;
          setSnapshot(null);
          setLoadedIdentity(capturedIdentity);
          setPendingItemIds(new Set());
          pendingRef.current.clear();
          setMutationError(null);
          setState("unauthorized");
          pageCount.current = 1;
        } else if (
          failure instanceof TeamOverviewError &&
          failure.status === 409
        ) {
          await refresh();
        }
        return false;
      } finally {
        if (
          capturedGeneration === generation.current &&
          capturedIdentity === identityScope.current
        ) {
          pendingRef.current.delete(item.sourceEventId);
          setPendingItemIds((current) => {
            const next = new Set(current);
            next.delete(item.sourceEventId);
            return next;
          });
        }
      }
    },
    [client, identityKey, refresh, state]
  );

  const verifiedIdentity =
    enabled && identityKey !== null && loadedIdentity === identityKey;
  const visibleSnapshot = verifiedIdentity ? snapshot : null;
  const visibleState =
    !enabled ||
    identityKey === null ||
    (loadedIdentity !== null && loadedIdentity !== identityKey)
      ? "loading"
      : state;
  const loadMore = useCallback(() => {
    const cursor = snapshotRef.current?.nextCursor;
    if (cursor && state === "ready") void refresh(cursor);
  }, [refresh, state]);
  const refreshNow = useCallback(() => void refresh(), [refresh]);

  return {
    snapshot: visibleSnapshot,
    state: visibleState,
    refreshing,
    mutationError: verifiedIdentity ? mutationError : null,
    pendingItemIds: verifiedIdentity ? pendingItemIds : new Set<string>(),
    refresh: refreshNow,
    loadMore,
    setCleared: (item: TeamOverviewItem, cleared: boolean) =>
      void mutate(item, cleared ? "clear" : "restore"),
    setSeen: (item: TeamOverviewItem) => mutate(item, "seen")
  };
}

function requestIsCurrent(
  sequence: number,
  requestGeneration: number,
  requestSequence: { current: number },
  generation: { current: number },
  identityScope: { current: string | null },
  identityKey: string
) {
  return (
    sequence === requestSequence.current &&
    requestGeneration === generation.current &&
    identityScope.current === identityKey
  );
}

function sameTeamAccess(
  left: TeamOverviewSnapshot,
  right: TeamOverviewSnapshot
) {
  const previous = left.teams.map((team) => team.teamId).sort();
  const next = right.teams.map((team) => team.teamId).sort();
  return (
    previous.length === next.length &&
    previous.every((id, index) => id === next[index])
  );
}

function mergePage(
  base: TeamOverviewSnapshot,
  page: TeamOverviewSnapshot
): TeamOverviewSnapshot {
  const merge = (before: TeamOverviewItem[], after: TeamOverviewItem[]) => {
    const rows = new Map(before.map((item) => [item.sourceEventId, item]));
    for (const item of after) rows.set(item.sourceEventId, item);
    return Array.from(rows.values()).sort(
      (a, b) =>
        Number(b.priority === "blocker") - Number(a.priority === "blocker") ||
        b.updatedAt.localeCompare(a.updatedAt)
    );
  };
  return {
    ...page,
    attention: merge(base.attention, page.attention),
    catchUp: merge(base.catchUp, page.catchUp),
    cleared: merge(base.cleared, page.cleared)
  };
}

async function readLoadedPages(
  client: TeamOverviewClient,
  signal: AbortSignal,
  depth: number
) {
  const pages = [await client.getOverview({ limit: 100 }, signal)];
  let cursor = pages[0]?.nextCursor ?? null;
  const seen = new Set<string>();
  for (
    let index = 1;
    index < depth && cursor && !seen.has(cursor);
    index += 1
  ) {
    seen.add(cursor);
    const page = await client.getOverview({ cursor, limit: 100 }, signal);
    if (
      page.access.accountScope !== pages[0]?.access.accountScope ||
      page.access.backendId !== pages[0]?.access.backendId
    )
      throw new TeamOverviewError(
        "Team access changed while loading activity.",
        409
      );
    pages.push(page);
    cursor = page.nextCursor;
  }
  return pages
    .slice(1)
    .reduce((merged, page) => mergePage(merged, page), pages[0]!);
}

function countPagesRead(snapshot: TeamOverviewSnapshot, targetDepth: number) {
  return snapshot.nextCursor ? Math.max(1, targetDepth) : 1;
}

function isAbortError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}
