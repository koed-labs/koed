import type {
  EmbeddingQueueCounts,
  EmbeddingStateSnapshot
} from "@koed/shared";
const queue = (value: EmbeddingQueueCounts | null) =>
  value
    ? `${value.waiting} waiting · ${value.active} active · ${value.delayed} delayed · ${value.failed} failed`
    : "Unavailable";
export function HqEmbeddingStatus({
  state
}: {
  state: EmbeddingStateSnapshot | null;
}) {
  if (!state) return <p role="status">Embedding state unavailable</p>;
  const facts: [string, string][] = [
    ["Activity", state.activity],
    ["Model", state.service.model ?? "Unavailable"],
    ["Dimensions", state.service.dimensions?.toLocaleString() ?? "Unavailable"],
    [
      "Expected model",
      `${state.service.expectedModel} · ${state.service.expectedDimensions} dimensions`
    ],
    [
      "Model compatibility",
      state.service.compatible ? "Compatible" : "Needs attention"
    ],
    [
      "Calibration",
      state.calibration
        ? `${state.calibration.mode} · ${state.calibration.measuredTokensPerSecond.toLocaleString()} tokens/s`
        : "Unavailable"
    ],
    [
      "Pending memory",
      state.backlog
        ? `${state.backlog.pendingMemoryEvents.toLocaleString()} events · ${state.backlog.pendingMemoryNodes.toLocaleString()} nodes · ${state.backlog.pendingEstimatedTokens.toLocaleString()} estimated tokens`
        : "Unavailable"
    ],
    [
      "Throughput",
      state.throughput
        ? `${state.throughput.measuredTokensPerSecond.toLocaleString()} tokens/s · ${state.throughput.eventsPerMinute.toLocaleString()} events/min over ${state.throughput.windowMinutes} min · ${state.throughput.retries} retries · ${state.throughput.failures} failures`
        : "Unavailable"
    ],
    [
      "Drain estimate",
      state.drainEstimate
        ? `${Math.round(state.drainEstimate.lowerSeconds / 60)}–${Math.round(state.drainEstimate.upperSeconds / 60)} min · ${state.drainEstimate.confidence} confidence`
        : "Unavailable"
    ],
    ["Memory queue", queue(state.queues.memory)],
    ["LCM queue", queue(state.queues.lcm)],
    [
      "Projection",
      state.projection
        ? `${state.projection.liveRows.toLocaleString()} live · ${state.projection.waitingForAgentTurnRows.toLocaleString()} waiting for an Agent turn · ${state.projection.historicalRows.toLocaleString()} historical · ${state.projection.historicalBytes.toLocaleString()} historical bytes`
        : "Unavailable"
    ],
    [
      "Historical admission",
      state.historicalAdmission
        ? state.historicalAdmission.admitted
          ? "Admitted"
          : state.historicalAdmission.reason.replaceAll("_", " ")
        : "Unavailable"
    ]
  ];
  return (
    <details className="hq-settings__group">
      <summary>Embedding progress · {state.activity}</summary>
      <dl className="hq-settings__facts">
        {facts.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        Observed{" "}
        <time dateTime={state.generatedAt}>
          {new Date(state.generatedAt).toLocaleString()}
        </time>
        . Counts cover this local deployment and contain no Memory text.
      </p>
    </details>
  );
}
