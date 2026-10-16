import type {
  EmbeddingQueueCounts,
  EmbeddingStateSnapshot,
  HistoricalAdmissionPauseReason
} from "@koed/shared";
import { Activity, ChevronDown, CircleAlert, CircleCheck } from "lucide-react";

const count = (value: number): string => value.toLocaleString("en-US");

const plural = (value: number, singular: string, pluralForm: string) =>
  `${count(value)} ${value === 1 ? singular : pluralForm}`;

export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${count(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const historicalPauseLabels = {
  no_historical_backlog: "No pending history",
  api_degraded: "Paused: API is not ready",
  queue_degraded: "Paused: work queue is unavailable",
  embedding_service_degraded: "Paused: Embedding Service is not ready",
  capacity_profile_unavailable: "Paused: Embedding Service calibration pending",
  live_projection_pressure: "Paused: live capture has priority",
  concurrency_cap: "Waiting for the current batch"
} as const satisfies Record<HistoricalAdmissionPauseReason, string>;

const pendingItems = (state: EmbeddingStateSnapshot): number =>
  state.backlog
    ? state.backlog.pendingMemoryEvents + state.backlog.pendingMemoryNodes
    : 0;

const summaryLabel = (state: EmbeddingStateSnapshot | null): string => {
  if (!state) return "Embedding state unavailable";
  if (state.activity === "unavailable") return "Embedding is unavailable";
  if (state.activity === "idle") return "Embedding is up to date";
  const pending = pendingItems(state);
  return pending > 0
    ? `Embedding ${plural(pending, "item", "items")}`
    : "Embedding in progress";
};

const queueLabel = (counts: EmbeddingQueueCounts | null): string =>
  counts
    ? `${count(counts.waiting + counts.delayed)} waiting · ${count(counts.active)} active${counts.failed > 0 ? ` · ${count(counts.failed)} failed` : ""}`
    : "Unavailable";

const historicalImportLabel = (state: EmbeddingStateSnapshot): string => {
  const pendingRows = state.projection?.historicalRows ?? 0;
  const admission = state.historicalAdmission;
  if (!admission) return pendingRows > 0 ? "Status unavailable" : "Idle";
  if (!admission.admitted) return historicalPauseLabels[admission.reason];
  return pendingRows > 0 ? "Running" : "No pending history";
};

function Row({
  label,
  value,
  detail
}: {
  detail?: string | null;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {detail ? <span>{detail}</span> : null}
      </dd>
    </div>
  );
}

export function EmbeddingStateDetails({
  state
}: {
  state: EmbeddingStateSnapshot | null;
}) {
  const summaryState = !state
    ? "needs_attention"
    : state.activity === "unavailable"
      ? "needs_attention"
      : state.activity === "working"
        ? "working"
        : "healthy";
  const pending = state ? pendingItems(state) : 0;

  return (
    <details className="koed-diagnostics">
      <summary>
        <span
          className="koed-diagnostics-summary-status"
          data-state={summaryState}
        >
          {summaryState === "healthy" ? (
            <CircleCheck aria-hidden="true" />
          ) : summaryState === "working" ? (
            <Activity aria-hidden="true" />
          ) : (
            <CircleAlert aria-hidden="true" />
          )}
          {summaryLabel(state)}
        </span>
        <ChevronDown aria-hidden="true" className="koed-diagnostics-chevron" />
      </summary>
      {!state ? (
        <p role="status">
          Koed could not read embedding state. Check that the API is running,
          then refresh status.
        </p>
      ) : (
        <dl aria-label="Embedding state">
          <Row
            detail={
              state.service.model
                ? `${state.service.model} · ${state.service.dimensions ?? "?"} dimensions`
                : null
            }
            label="Embedding Service"
            value={
              !state.service.healthy
                ? "Not ready"
                : !state.service.compatible
                  ? `Expected ${state.service.expectedModel}`
                  : state.activity === "working"
                    ? "Processing"
                    : "Ready"
            }
          />
          <Row
            detail={
              state.backlog && pending > 0
                ? `${plural(state.backlog.pendingMemoryEvents, "memory event", "memory events")} · ${plural(state.backlog.pendingMemoryNodes, "summary", "summaries")} · ~${count(state.backlog.pendingEstimatedTokens)} tokens`
                : null
            }
            label="Pending embeddings"
            value={state.backlog ? count(pending) : "Unavailable"}
          />
          {pending > 0 && state.drainEstimate ? (
            <Row
              label="Estimated time left"
              value={
                formatDuration(state.drainEstimate.lowerSeconds) ===
                formatDuration(state.drainEstimate.upperSeconds)
                  ? formatDuration(state.drainEstimate.upperSeconds)
                  : `${formatDuration(state.drainEstimate.lowerSeconds)} – ${formatDuration(state.drainEstimate.upperSeconds)}`
              }
            />
          ) : null}
          <Row label="Memory queue" value={queueLabel(state.queues.memory)} />
          <Row label="LCM queue" value={queueLabel(state.queues.lcm)} />
          <Row
            detail={
              state.projection && state.projection.waitingForAgentTurnRows > 0
                ? `${count(state.projection.waitingForAgentTurnRows)} waiting for an agent turn to finish`
                : null
            }
            label="Live Projection"
            value={
              state.projection
                ? plural(state.projection.liveRows, "row", "rows")
                : "Unavailable"
            }
          />
          <Row
            detail={
              state.projection && state.projection.historicalRows > 0
                ? `${plural(state.projection.historicalRows, "row", "rows")} · ${formatBytes(state.projection.historicalBytes)} pending`
                : null
            }
            label="Historical import"
            value={historicalImportLabel(state)}
          />
        </dl>
      )}
    </details>
  );
}
