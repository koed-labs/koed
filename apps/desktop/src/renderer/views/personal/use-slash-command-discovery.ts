import { useState, useCallback, useRef, useEffect } from "react";
import type { SupportedAiClientDriverId } from "@koed/shared/ai-client-contract";
import type { ManagedConversationSlashCommand } from "./ai-client-slash-suggestions.js";

const FETCH_DEBOUNCE_MS = 500;
const STALE_IF_ERROR_MS = 30_000;

export interface UseSlashCommandDiscoveryResult {
  commands: ManagedConversationSlashCommand[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
}

export function useSlashCommandDiscovery(
  api: { discoverCommands?: (...args: never[]) => unknown } | null,
  driverId: SupportedAiClientDriverId | null,
  instanceId: string | null,
  projectId: string | null,
  cwd: string | null
): UseSlashCommandDiscoveryResult {
  const [commands, setCommands] = useState<ManagedConversationSlashCommand[]>(
    []
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  const lastFetchRef = useRef(0);
  const cachedCommandsRef = useRef<ManagedConversationSlashCommand[]>([]);
  const cachedTimestampRef = useRef<number | null>(null);

  const fetchCommands = useCallback(() => {
    const discoverCommands = api?.discoverCommands as
      | ((input: {
          aiClientDriverId: SupportedAiClientDriverId;
          aiClientInstanceId: string;
          projectId: string;
          cwd?: string;
        }) => Promise<unknown>)
      | undefined;

    if (!discoverCommands || !driverId || !instanceId || !projectId) {
      return;
    }

    // Check stale-if-error
    const now = Date.now();
    if (
      cachedCommandsRef.current.length > 0 &&
      cachedTimestampRef.current !== null &&
      now - cachedTimestampRef.current < STALE_IF_ERROR_MS
    ) {
      return; // Use cached data while re-fetching
    }

    // Debounce
    if (now - lastFetchRef.current < FETCH_DEBOUNCE_MS) {
      return;
    }

    lastFetchRef.current = now;
    setLoading(true);
    setError(null);

    discoverCommands({
      aiClientDriverId: driverId,
      aiClientInstanceId: instanceId,
      projectId,
      ...(cwd ? { cwd } : {})
    })
      .then((result: unknown) => {
        if (
          typeof result === "object" &&
          result !== null &&
          "status" in result
        ) {
          const r = result as {
            status: string;
            commands?: unknown[];
            message?: string;
          };
          if (r.status === "ok" && Array.isArray(r.commands)) {
            setCommands(r.commands as ManagedConversationSlashCommand[]);
            setLastFetchedAt(now);
            cachedCommandsRef.current =
              r.commands as ManagedConversationSlashCommand[];
            cachedTimestampRef.current = now;
          } else if (r.status === "unavailable") {
            setCommands([]);
            setError(null);
            cachedCommandsRef.current = [];
            cachedTimestampRef.current = now;
          } else {
            setError(
              r.message ??
                (r.status === "stale"
                  ? "AI Client capability snapshot is stale."
                  : "Command discovery unavailable.")
            );
            setCommands([]);
          }
        }
      })
      .catch(() => {
        setError("Command discovery failed.");
        setCommands([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [api, driverId, instanceId, projectId, cwd]);

  // Trigger fetch when dependencies change
  useEffect(() => {
    if (driverId && instanceId && projectId) {
      fetchCommands();
    } else {
      setCommands([]);
      setLoading(false);
      setError(null);
      setLastFetchedAt(null);
    }
  }, [driverId, instanceId, projectId, cwd, fetchCommands]);

  // Invalidate cache when dependencies change
  useEffect(() => {
    cachedCommandsRef.current = [];
    cachedTimestampRef.current = null;
  }, [driverId, instanceId, projectId, cwd]);

  return { commands, loading, error, lastFetchedAt };
}
