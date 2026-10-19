import { useEffect, useState } from "react";
import { Button } from "@koed/ui";
import type { ComponentStatus } from "../../../types.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { useDesktopStatus } from "../../state/use-status.js";
import { HqEmbeddingStatus } from "./HqEmbeddingStatus.js";
import { HqSettingRow } from "./HqSettings.js";
export function HqSettingsServices({
  statusStore
}: {
  statusStore: DesktopStatusStore;
}) {
  const snapshot = useDesktopStatus(statusStore);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const status = snapshot.status;
  const components: [string, ComponentStatus][] = status
    ? (
        [
          ["Server package", status.serverPackage],
          ["API", status.api],
          ["Database", status.database],
          ["Redis", status.redis],
          ["Worker queues", status.workerQueues],
          ["Embedding Service", status.embeddingService],
          ["Privacy Filter Service", status.privacyService],
          ["Local AI Runtime", status.localAiRuntime],
          ["Local runtime credential", status.apiToken],
          ["MCP Server", status.mcpServer],
          ["Capture Hook", status.captureHook],
          ["LCM Summary Service", status.lcmSummaryService],
          ["Personal Device Sync", status.personalDeviceSync]
        ] as const
      ).flatMap(([name, component]) => (component ? [[name, component]] : []))
    : [];
  useEffect(() => {
    void statusStore.refresh();
  }, [statusStore]);
  const starting = components.some(([, value]) => value.state === "starting");
  useEffect(() => {
    if (!starting) return;
    const timer = setTimeout(() => void statusStore.refresh(), 1500);
    return () => clearTimeout(timer);
  }, [starting, snapshot.revision, statusStore]);
  const run = async (action: "status" | "doctor" | "open_logs") => {
    setRunning(action);
    setError(null);
    try {
      if (action === "status") await statusStore.refresh();
      else await statusStore.run(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(null);
    }
  };
  const embedding = status?.embeddingState;
  return (
    <>
      <div className="hq-settings__actions hq-settings__group">
        {(
          [
            ["status", "Refresh status"],
            ["doctor", "Run diagnostics"],
            ["open_logs", "Open logs"]
          ] as const
        ).map(([action, label]) => (
          <Button
            key={action}
            disabled={snapshot.busyCommand !== null || running !== null}
            aria-busy={running === action}
            className="hq-settings__action"
            variant="outline"
            onClick={() => void run(action)}
          >
            {running === action ? "Working…" : label}
          </Button>
        ))}
      </div>
      {error || snapshot.error ? (
        <p role="alert">{error ?? snapshot.error}</p>
      ) : null}
      {!status ? (
        <p role="status">Service status unavailable.</p>
      ) : (
        components.map(([name, component]) => (
          <HqSettingRow
            key={name}
            title={name}
            description={
              component.state !== "healthy" ? component.message : undefined
            }
          >
            <span>
              {component.state === "healthy"
                ? "Healthy"
                : component.state.replaceAll("_", " ")}
            </span>
          </HqSettingRow>
        ))
      )}
      {embedding !== undefined ? <HqEmbeddingStatus state={embedding} /> : null}
    </>
  );
}
