import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupportedAiClientDriverId } from "@koed/shared/ai-client-contract";
import type { ManagedConversationSlashCommand } from "./ai-client-slash-suggestions.js";

const FETCH_DEBOUNCE_MS = 500;
const STALE_IF_ERROR_MS = 30_000;

type DiscoverCommandsApi = {
  discoverCommands: (input: {
    aiClientDriverId: SupportedAiClientDriverId;
    aiClientInstanceId: string;
    projectId?: string;
    mode?: "file" | "draft";
  }) => Promise<unknown>;
};

type CachedCommands = {
  commands: ManagedConversationSlashCommand[];
  timestamp: number;
};

export interface UseSlashCommandDiscoveryResult {
  commands: ManagedConversationSlashCommand[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
}

export function useSlashCommandDiscovery(
  api: DiscoverCommandsApi | null,
  driverId: SupportedAiClientDriverId | null,
  instanceId: string | null,
  projectId: string | null,
  cwd: string | null
): UseSlashCommandDiscoveryResult {
  const cacheKey = useMemo(
    () =>
      `${driverId ?? "none"}:${instanceId ?? "none"}:${projectId ?? "none"}:${cwd ?? "none"}`,
    [cwd, driverId, instanceId, projectId]
  );
  const [commands, setCommands] = useState<ManagedConversationSlashCommand[]>(
    []
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const cachedRef = useRef<Map<string, CachedCommands>>(new Map());
  const activeKeyRef = useRef(cacheKey);
  const requestIdRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFetchStartedAtRef = useRef(0);

  const fetchCommands = useCallback(() => {
    if (!api?.discoverCommands || !driverId || !instanceId) {
      setCommands([]);
      setError(null);
      setLastFetchedAt(null);
      setLoading(false);
      return;
    }

    const cached = cachedRef.current.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < STALE_IF_ERROR_MS) {
      setCommands(cached.commands);
      setLastFetchedAt(cached.timestamp);
      setError(null);
    }

    const startFetch = () => {
      if (activeKeyRef.current !== cacheKey) return;

      const requestId = ++requestIdRef.current;
      requestControllerRef.current?.abort();
      const controller = new AbortController();
      requestControllerRef.current = controller;
      const startedAt = Date.now();
      lastFetchStartedAtRef.current = startedAt;
      setLoading(true);
      setError(null);

      const isCurrentRequest = () =>
        !controller.signal.aborted &&
        requestId === requestIdRef.current &&
        activeKeyRef.current === cacheKey;
      const useStaleOr = (failureMessage: string | null) => {
        if (!isCurrentRequest()) return;
        const stale = cachedRef.current.get(cacheKey);
        if (stale && Date.now() - stale.timestamp < STALE_IF_ERROR_MS) {
          setCommands(stale.commands);
          setLastFetchedAt(stale.timestamp);
          setError(null);
        } else {
          setCommands([]);
          setLastFetchedAt(null);
          setError(failureMessage);
        }
      };

      api
        .discoverCommands({
          aiClientDriverId: driverId,
          aiClientInstanceId: instanceId,
          mode: "draft",
          ...(projectId ? { projectId } : {})
        })
        .then((result) => {
          if (!isCurrentRequest()) return;
          if (
            typeof result !== "object" ||
            result === null ||
            !("status" in result)
          ) {
            useStaleOr("Command discovery unavailable.");
            return;
          }

          const response = result as {
            status: string;
            commands?: unknown[];
            message?: string;
          };
          if (response.status === "ok" && Array.isArray(response.commands)) {
            const discovered =
              response.commands as ManagedConversationSlashCommand[];
            cachedRef.current.set(cacheKey, {
              commands: discovered,
              timestamp: startedAt
            });
            setCommands(discovered);
            setLastFetchedAt(startedAt);
            setError(null);
          } else if (response.status === "unavailable") {
            const stale = cachedRef.current.get(cacheKey);
            if (stale && Date.now() - stale.timestamp < STALE_IF_ERROR_MS) {
              setCommands(stale.commands);
              setLastFetchedAt(stale.timestamp);
            } else {
              setCommands([]);
              setLastFetchedAt(null);
            }
            setError(null);
          } else {
            if (
              response.status === "unauthorized" ||
              response.status === "stale"
            ) {
              cachedRef.current.delete(cacheKey);
            }
            setError(
              response.message ??
                (response.status === "stale"
                  ? "AI Client capability snapshot is stale."
                  : "Command discovery unavailable.")
            );
            setCommands([]);
            setLastFetchedAt(null);
          }
        })
        .catch(() => useStaleOr("Command discovery failed."))
        .finally(() => {
          if (isCurrentRequest()) setLoading(false);
        });
    };

    const elapsed = now - lastFetchStartedAtRef.current;
    const delay = elapsed < FETCH_DEBOUNCE_MS ? FETCH_DEBOUNCE_MS - elapsed : 0;
    if (delay > 0) {
      setLoading(true);
      debounceTimerRef.current = setTimeout(startFetch, delay);
    } else {
      startFetch();
    }
  }, [api, cacheKey, cwd, driverId, instanceId, projectId]);

  useEffect(() => {
    activeKeyRef.current = cacheKey;
    requestIdRef.current += 1;
    requestControllerRef.current?.abort();
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;

    for (const key of cachedRef.current.keys()) {
      if (key !== cacheKey) cachedRef.current.delete(key);
    }

    if (driverId && instanceId) {
      setCommands([]);
      fetchCommands();
    } else {
      setCommands([]);
      setError(null);
      setLastFetchedAt(null);
      setLoading(false);
      cachedRef.current.delete(cacheKey);
    }

    return () => {
      requestIdRef.current += 1;
      requestControllerRef.current?.abort();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    };
  }, [api, cacheKey, cwd, driverId, fetchCommands, instanceId, projectId]);

  return { commands, loading, error, lastFetchedAt };
}
