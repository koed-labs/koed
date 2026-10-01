"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicSquarePage } from "@koed/shared/public-square";
import {
  PublicSquareClient,
  PublicSquareRequestError
} from "@/lib/public-square-client";
import {
  publicSquareCurrentPages,
  publicSquareProjectIdKey,
  publicSquareRequestMayApply,
  publicSquareScopeKey,
  type PublicSquareProject,
  type PublicSquareProjectConnection,
  type PublicSquarePublication,
  type PublicSquareScope,
  type TeamProjectMemberConnection
} from "@/lib/public-square";

type FeedState = "loading" | "ready" | "unavailable" | "access-lost";
type Feed = {
  scopeKey: string;
  state: FeedState;
  items: PublicSquarePublication[];
  idleAgents: PublicSquarePage["idleAgents"];
  refreshing: boolean;
  nextCursor: string | null;
  serverTime: string | undefined;
  connections: Record<string, PublicSquareProjectConnection>;
  ownerBriefDrafts: Record<string, string>;
  loadingMore: boolean;
  error: string | null;
};
const emptyFeed = (scopeKey: string, state: FeedState = "loading"): Feed => ({
  scopeKey,
  state,
  items: [],
  idleAgents: [],
  refreshing: false,
  nextCursor: null,
  serverTime: undefined,
  connections: {},
  ownerBriefDrafts: {},
  loadingMore: false,
  error: null
});

export function usePublicSquare(input: {
  client: PublicSquareClient;
  scope: PublicSquareScope;
  projects: PublicSquareProject[];
  localProjects: PublicSquareProject[];
  enabled?: boolean;
  onAuthorizationLost?: () => void;
}) {
  const {
    client,
    scope,
    projects,
    localProjects,
    enabled = true,
    onAuthorizationLost
  } = input;
  const scopeKey = publicSquareScopeKey(scope);
  const projectIdKey = publicSquareProjectIdKey(projects);
  const teamProjectIds = useMemo(
    () => (projectIdKey ? projectIdKey.split("\u0000") : []),
    [projectIdKey]
  );
  const generation = useRef(0);
  const mounted = useRef(false);
  const accessLost = useRef(false);
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;
  const [feed, setFeed] = useState<Feed>(() => emptyFeed(scopeKey));
  const visibleFeed = feed.scopeKey === scopeKey ? feed : emptyFeed(scopeKey);
  const mayApply = useCallback(
    (capturedScopeKey: string, capturedGeneration: number) =>
      publicSquareRequestMayApply({
        capturedScopeKey,
        currentScopeKey: currentScopeKey.current,
        capturedGeneration,
        currentGeneration: generation.current,
        mounted: mounted.current,
        accessLost: accessLost.current
      }),
    []
  );

  const loseAccess = useCallback(
    (capturedScopeKey: string, capturedGeneration: number) => {
      if (
        capturedScopeKey !== currentScopeKey.current ||
        capturedGeneration !== generation.current
      )
        return;
      accessLost.current = true;
      setFeed(emptyFeed(capturedScopeKey, "access-lost"));
      onAuthorizationLost?.();
    },
    [onAuthorizationLost]
  );

  const refresh = useCallback(async () => {
    if (!enabled) {
      setFeed(emptyFeed(scopeKey));
      return false;
    }
    const capturedScopeKey = scopeKey;
    const capturedGeneration = ++generation.current;
    accessLost.current = false;
    setFeed((current) =>
      current.scopeKey === capturedScopeKey && current.state === "ready"
        ? { ...current, refreshing: true }
        : emptyFeed(capturedScopeKey, "loading")
    );
    try {
      const [firstPage, connectionEntries] = await Promise.all([
        client.list(scope.teamId, { limit: 50 }),
        Promise.all(
          teamProjectIds.map(
            async (projectId) =>
              [
                projectId,
                await client.getConnection(scope.teamId, projectId)
              ] as const
          )
        )
      ]);
      if (!mayApply(capturedScopeKey, capturedGeneration)) return false;
      if (firstPage.teamId !== scope.teamId)
        throw new Error(
          "Koed returned Public Square history for another Team."
        );
      const page = await publicSquareCurrentPages(firstPage, async (cursor) => {
        const next = await client.list(scope.teamId, { limit: 50, cursor });
        if (!mayApply(capturedScopeKey, capturedGeneration))
          throw new Error("Public Square selection changed.");
        return next;
      });
      if (!mayApply(capturedScopeKey, capturedGeneration)) return false;
      setFeed({
        ...emptyFeed(capturedScopeKey, "ready"),
        items: page.items,
        idleAgents: page.idleAgents,
        nextCursor: page.nextCursor,
        serverTime: page.serverTime,
        connections: Object.fromEntries(connectionEntries)
      });
      return true;
    } catch (failure) {
      if (!mayApply(capturedScopeKey, capturedGeneration)) return false;
      if (
        failure instanceof PublicSquareRequestError &&
        [401, 403].includes(failure.status)
      ) {
        loseAccess(capturedScopeKey, capturedGeneration);
        return false;
      }
      setFeed({
        ...emptyFeed(capturedScopeKey, "unavailable"),
        error:
          failure instanceof Error
            ? failure.message
            : "Public Square is unavailable right now."
      });
      return false;
    }
  }, [
    client,
    enabled,
    loseAccess,
    mayApply,
    scope.teamId,
    scopeKey,
    teamProjectIds
  ]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (
      !visibleFeed.nextCursor ||
      visibleFeed.loadingMore ||
      visibleFeed.state !== "ready"
    )
      return;
    const cursor = visibleFeed.nextCursor;
    const capturedScopeKey = scopeKey;
    const capturedGeneration = generation.current;
    setFeed((current) =>
      current.scopeKey === capturedScopeKey
        ? { ...current, loadingMore: true }
        : current
    );
    try {
      const page = await client.list(scope.teamId, { limit: 50, cursor });
      if (!mayApply(capturedScopeKey, capturedGeneration)) return;
      if (page.teamId !== scope.teamId)
        throw new Error(
          "Koed returned Public Square history for another Team."
        );
      setFeed((current) =>
        current.scopeKey !== capturedScopeKey
          ? current
          : {
              ...current,
              items: mergePublications(current.items, page.items),
              idleAgents: page.idleAgents,
              nextCursor: page.nextCursor,
              serverTime: page.serverTime,
              loadingMore: false
            }
      );
    } catch (failure) {
      if (!mayApply(capturedScopeKey, capturedGeneration)) return;
      if (
        failure instanceof PublicSquareRequestError &&
        [401, 403].includes(failure.status)
      )
        loseAccess(capturedScopeKey, capturedGeneration);
      else
        setFeed((current) =>
          current.scopeKey === capturedScopeKey
            ? {
                ...current,
                loadingMore: false,
                error:
                  failure instanceof Error
                    ? failure.message
                    : "Completed history is unavailable."
              }
            : current
        );
    }
  }, [
    client,
    loseAccess,
    mayApply,
    scope.teamId,
    scopeKey,
    visibleFeed.loadingMore,
    visibleFeed.nextCursor,
    visibleFeed.state
  ]);

  const mutate = useCallback(
    async <T>(operation: () => Promise<T>, onSuccess: (value: T) => void) => {
      const capturedScopeKey = scopeKey;
      const capturedGeneration = generation.current;
      try {
        const value = await operation();
        if (!mayApply(capturedScopeKey, capturedGeneration)) return;
        onSuccess(value);
      } catch (failure) {
        if (!mayApply(capturedScopeKey, capturedGeneration)) throw failure;
        if (
          failure instanceof PublicSquareRequestError &&
          [401, 403].includes(failure.status)
        )
          loseAccess(capturedScopeKey, capturedGeneration);
        throw failure;
      }
    },
    [loseAccess, mayApply, scopeKey]
  );

  const connectProject = useCallback(
    async (
      teamProjectId: string,
      localProjectId: string | null,
      expectedVersion: number
    ) => {
      await mutate(
        () =>
          client.setConnection({
            teamId: scope.teamId,
            teamProjectId,
            localProjectId,
            expectedVersion
          }),
        (connection: TeamProjectMemberConnection) =>
          setFeed((current) =>
            current.scopeKey === scopeKey
              ? {
                  ...current,
                  connections: {
                    ...current.connections,
                    [teamProjectId]: connection
                  }
                }
              : current
          )
      );
    },
    [client, mutate, scope.teamId, scopeKey]
  );

  const setBrief = useCallback(
    async (
      publicationId: string,
      brief: string | null,
      expectedVersion: number
    ) => {
      await mutate(
        () =>
          client.setBrief({
            teamId: scope.teamId,
            publicationId,
            brief,
            expectedVersion
          }),
        (publication: PublicSquarePublication) =>
          setFeed((current) =>
            current.scopeKey === scopeKey
              ? {
                  ...current,
                  items: current.items.map((item) =>
                    item.id === publicationId ? publication : item
                  )
                }
              : current
          )
      );
    },
    [client, mutate, scope.teamId, scopeKey]
  );

  const loadBriefDraft = useCallback(
    async (publicationId: string) => {
      if (visibleFeed.ownerBriefDrafts[publicationId] !== undefined) return;
      const capturedScopeKey = scopeKey;
      const capturedGeneration = generation.current;
      try {
        const draft = await client.getBriefDraft(scope.teamId, publicationId);
        if (!mayApply(capturedScopeKey, capturedGeneration)) return;
        setFeed((current) =>
          current.scopeKey === capturedScopeKey
            ? {
                ...current,
                ownerBriefDrafts: {
                  ...current.ownerBriefDrafts,
                  [publicationId]: draft.briefDraft
                }
              }
            : current
        );
      } catch (failure) {
        if (
          failure instanceof PublicSquareRequestError &&
          [401, 403].includes(failure.status)
        )
          loseAccess(capturedScopeKey, capturedGeneration);
        throw failure;
      }
    },
    [
      client,
      loseAccess,
      mayApply,
      scope.teamId,
      scopeKey,
      visibleFeed.ownerBriefDrafts
    ]
  );

  const unshareProject = useCallback(
    async (teamProjectId: string) => {
      await mutate(
        () => client.unshareProject(scope.teamId, teamProjectId),
        () =>
          setFeed((current) =>
            current.scopeKey === scopeKey
              ? {
                  ...current,
                  items: current.items.filter(
                    (item) => item.projectId !== teamProjectId
                  ),
                  connections: { ...current.connections, [teamProjectId]: null }
                }
              : current
          )
      );
    },
    [client, mutate, scope.teamId, scopeKey]
  );

  return {
    ...visibleFeed,
    projects,
    localProjects,
    refresh,
    loadMore,
    connectProject,
    setBrief,
    loadBriefDraft,
    unshareProject
  };
}

function mergePublications(
  current: PublicSquarePublication[],
  incoming: PublicSquarePublication[]
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const previous = byId.get(item.id);
    if (!previous || item.version >= previous.version) byId.set(item.id, item);
  }
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
}
