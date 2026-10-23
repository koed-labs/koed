import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../../types.js";
import type { LocalAiClientResponse } from "../../../ipc/local-ai-client-protocol.js";
import type { UsageReading } from "./hq-usage-model.js";

type Bridge = DesktopApi["localAiClients"];
export function useHqUsage(
  bridge: Bridge,
  authorityKey: string,
  enabled = true,
  refreshKey?: string
) {
  const [readings, setReadings] = useState<UsageReading[]>([]);
  const [instances, setInstances] = useState<
    LocalAiClientResponse["readModel"]["instances"]
  >([]);
  const [readModel, setReadModel] = useState<
    LocalAiClientResponse["readModel"] | null
  >(null);
  const [refreshMessage, setRefreshMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [stateScope, setStateScope] = useState<{
    bridge: Bridge;
    authorityKey: string;
    enabled: boolean;
  } | null>(null);
  const scopeRef = useRef({ bridge, authorityKey, enabled });
  scopeRef.current = { bridge, authorityKey, enabled };
  const scopeMatches = () =>
    scopeRef.current.bridge === bridge &&
    scopeRef.current.authorityKey === authorityKey &&
    scopeRef.current.enabled === enabled;
  const generation = useRef(0);
  const request = useRef(0);
  const readingsRef = useRef<UsageReading[]>([]);
  const read = useCallback(async () => {
    if (!bridge?.usage || !authorityKey || !enabled) return;
    const currentGeneration = generation.current;
    const currentRequest = ++request.current;
    try {
      const response = await bridge.usage();
      if (
        !scopeMatches() ||
        generation.current !== currentGeneration ||
        request.current !== currentRequest
      )
        return;
      readingsRef.current = response.usage ?? [];
      setReadings(readingsRef.current);
      setInstances(response.readModel.instances);
      setReadModel(response.readModel);
      setStateScope({ bridge, authorityKey, enabled });
    } catch {
      // Keep the last reading for this authority when a transient read fails.
      // Authority changes and invalidation clear it in the effect above.
    }
  }, [bridge, authorityKey, enabled]);

  useEffect(() => {
    generation.current++;
    request.current++;
    setReadings([]);
    setInstances([]);
    setReadModel(null);
    setStateScope(null);
    readingsRef.current = [];
    setRefreshMessage("");
    setBusy(false);
    if (!bridge?.usage || !authorityKey || !enabled) return;
    // Subscribe first; the subsequent read also catches completions missed on reconnect.
    const unsubscribe = bridge.onUsageChanged?.((change) => {
      if (change.kind === "invalidated") {
        generation.current++;
        request.current++;
        setReadings([]);
        setInstances([]);
        setReadModel(null);
        setStateScope(null);
        readingsRef.current = [];
        setRefreshMessage("");
        setBusy(false);
      } else void read();
    });
    void read();
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => {
      generation.current++;
      request.current++;
      unsubscribe?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, authorityKey, enabled, read]);

  useEffect(() => {
    if (enabled && refreshKey) void read();
  }, [enabled, refreshKey, read]);

  const refresh = useCallback(
    async (instanceId: string) => {
      if (!bridge?.usage || !authorityKey || !enabled) return;
      const currentGeneration = generation.current;
      if (!scopeMatches()) return;
      setBusy(true);
      try {
        const response = await bridge.usage(instanceId);
        if (!scopeMatches() || generation.current !== currentGeneration) return;
        await read();
        if (!scopeMatches() || generation.current !== currentGeneration) return;
        const observed = readingsRef.current
          .filter((reading) => reading.instanceId === instanceId)
          .sort(
            (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)
          )[0]?.observedAt;
        const outcome = response.usageOutcome;
        const message =
          outcome === "checked"
            ? "Checked Codex just now."
            : outcome === "unsupported"
              ? "This Codex version doesn't share usage."
              : `Couldn't check Codex. Showing the reading from ${observed ? new Date(observed).toLocaleString() : "the last check"}.`;
        setRefreshMessage(`${message} Claude updates on its next run.`);
      } catch {
        if (scopeMatches() && generation.current === currentGeneration) {
          setRefreshMessage(
            "Couldn't check Codex. Showing the last reading. Claude updates on its next run."
          );
        }
      } finally {
        if (scopeMatches() && generation.current === currentGeneration)
          setBusy(false);
      }
    },
    [bridge, authorityKey, enabled, read]
  );
  const active =
    stateScope !== null &&
    stateScope.bridge === bridge &&
    stateScope.authorityKey === authorityKey &&
    stateScope.enabled === enabled;
  return {
    readings: active ? readings : [],
    instances: active ? instances : [],
    readModel: active ? readModel : null,
    refreshMessage: active ? refreshMessage : "",
    busy: active ? busy : false,
    refresh,
    read
  };
}
