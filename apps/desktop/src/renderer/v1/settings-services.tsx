import { Activity, ChevronRight, Settings2 } from "lucide-react";
import type { ComponentStatus, KoedServerStatus } from "../../types.js";
import {
  EmbeddingStateDetails,
  embeddingSummaryLabel,
  formatDuration
} from "../views/preferences/EmbeddingStateDetails.js";
import { SettingsBack } from "./settings-tools.js";
import type { V1SettingsPage } from "./settings-navigation.js";

export function settingsServiceComponents(
  status: KoedServerStatus | null
): [string, ComponentStatus][] {
  if (!status) return [];
  return (
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
  ).flatMap(([title, component]) => (component ? [[title, component]] : []));
}
function healthSummary(components: [string, ComponentStatus][]) {
  if (!components.length) return "Service status unavailable";
  const attention = components.filter(
    ([, component]) => component.state !== "healthy"
  ).length;
  return attention
    ? `${attention} ${attention === 1 ? "service needs" : "services need"} attention`
    : "All services are healthy";
}
export function SettingsServicesOverview({
  status,
  onOpen,
  embeddingSupported
}: {
  status: KoedServerStatus | null;
  embeddingSupported?: boolean;
  onOpen: (page: V1SettingsPage) => void;
}) {
  const components = settingsServiceComponents(status);
  const healthy = components.filter(
    ([, component]) => component.state === "healthy"
  ).length;
  const embedding = status?.embeddingState;
  const hasEmbedding = embeddingSupported ?? embedding !== undefined;
  const pending = embedding?.backlog
    ? embedding.backlog.pendingMemoryEvents +
      embedding.backlog.pendingMemoryNodes
    : null;
  const estimate =
    pending && embedding?.drainEstimate
      ? `${formatDuration(embedding.drainEstimate.lowerSeconds)} – ${formatDuration(embedding.drainEstimate.upperSeconds)} left`
      : pending === 0 && embedding?.activity === "idle"
        ? "Up to date"
        : "Estimate unavailable";
  return (
    <>
      <div className="v1-service-metrics">
        <div>
          <span>Services</span>
          <b>{components.length ? `${healthy} / ${components.length}` : "—"}</b>
          <small>healthy</small>
        </div>
        {hasEmbedding && (
          <>
            <div>
              <span>Pending embeddings</span>
              <b>{pending === null ? "—" : pending.toLocaleString()}</b>
              <small>{estimate}</small>
            </div>
            <div>
              <span>Throughput</span>
              <b>
                {embedding?.throughput
                  ? Math.round(
                      embedding.throughput.measuredTokensPerSecond
                    ).toLocaleString()
                  : "—"}
              </b>
              <small>tokens / second</small>
            </div>
          </>
        )}
      </div>
      <div className="v1-service-links">
        <button
          type="button"
          data-settings-page="health"
          className="v1-service-link"
          onClick={() => onOpen("health")}
        >
          <span
            className="v1-tool-mark v1-service-health-mark"
            data-state={
              components.length &&
              components.every(([, component]) => component.state === "healthy")
                ? "healthy"
                : "needs_attention"
            }
          >
            <Activity size={18} />
          </span>
          <span>
            <b>Service health</b>
            <small>{healthSummary(components)}</small>
          </span>
          <ChevronRight size={17} />
        </button>
        {hasEmbedding && (
          <button
            type="button"
            data-settings-page="embedding"
            className="v1-service-link"
            onClick={() => onOpen("embedding")}
          >
            <span className="v1-tool-mark">
              <Settings2 size={18} />
            </span>
            <span>
              <b>Embedding status</b>
              <small>{embeddingSummaryLabel(embedding ?? null)}</small>
            </span>
            <ChevronRight size={17} />
          </button>
        )}
      </div>
    </>
  );
}
export function SettingsServicePage({
  page,
  status,
  onBack
}: {
  page: "health" | "embedding";
  status: KoedServerStatus | null;
  onBack: () => void;
}) {
  const components = settingsServiceComponents(status);
  return (
    <>
      <header className="v1-parity-heading">
        <SettingsBack parent="Services" onBack={onBack} />
        <h3>{page === "health" ? "Service health" : "Embedding status"}</h3>
        <p>
          {page === "health"
            ? "Current state of the services running on this Mac."
            : "Progress, queues and activity for your local memory index."}
        </p>
      </header>
      {page === "health" ? (
        <>
          <p className="v1-service-summary" role="status">
            <Activity size={18} />
            {healthSummary(components)}
          </p>
          {components.length ? (
            <dl className="v1-service-readout" aria-label="Service health">
              {components.map(([title, component]) => (
                <div key={title}>
                  <dt>{title}</dt>
                  <dd>
                    <strong data-state={component.state}>
                      {component.state === "healthy"
                        ? "Healthy"
                        : component.state === "needs_attention"
                          ? "Needs attention"
                          : component.state.replaceAll("_", " ")}
                    </strong>
                    {component.state !== "healthy" && component.message && (
                      <span>{component.message}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="v1-settings-caption" role="status">
              Service status has not loaded. Refresh status to try again.
            </p>
          )}
        </>
      ) : status?.embeddingState === undefined && status ? (
        <p className="v1-settings-caption" role="status">
          Embedding status is not offered by this deployment.
        </p>
      ) : (
        <div className="v1-embedding-readout">
          <EmbeddingStateDetails
            state={status?.embeddingState ?? null}
            presentation="page"
          />
        </div>
      )}
    </>
  );
}
