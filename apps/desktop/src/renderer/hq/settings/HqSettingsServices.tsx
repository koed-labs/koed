import { useEffect } from "react";
import type { ComponentStatus } from "../../../types.js";
import type { DesktopStatusStore } from "../../services/desktop-commands.js";
import { useDesktopStatus } from "../../state/use-status.js";
import { HqSettingRow } from "./HqSettings.js";
export function HqSettingsServices({
  statusStore
}: {
  statusStore: DesktopStatusStore;
}) {
  const snapshot = useDesktopStatus(statusStore);
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
    const timer = setInterval(() => void statusStore.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [statusStore]);
  const starting = components.some(([, value]) => value.state === "starting");
  useEffect(() => {
    if (!starting) return;
    const timer = setTimeout(() => void statusStore.refresh(), 1500);
    return () => clearTimeout(timer);
  }, [starting, snapshot.revision, statusStore]);
  return (
    <>
      {!status ? (
        <p role="status">Service status unavailable.</p>
      ) : (
        components.map(([name, component]) => (
          <HqSettingRow key={name} title={name}>
            <span>
              {component.state === "healthy"
                ? "Healthy"
                : component.state.replaceAll("_", " ")}
            </span>
          </HqSettingRow>
        ))
      )}
    </>
  );
}
