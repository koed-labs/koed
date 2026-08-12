export type HistoricalAdmissionPauseReason =
  | "no_historical_backlog"
  | "api_degraded"
  | "queue_degraded"
  | "embedding_service_degraded"
  | "live_projection_pressure"
  | "concurrency_cap";

export interface HistoricalImportBatchConfig {
  maxBytes: number;
  maxConcurrency: number;
  maxRows: number;
  maxRuntimeMs: number;
  maxLiveProjectionRows: number;
}

export interface HistoricalAdmissionInput {
  apiHealthy: boolean;
  queueHealthy: boolean;
  embeddingServiceHealthy: boolean;
  historicalImportRows: number;
  liveProjectionRows: number;
  activeHistoricalBatches: number;
}

export type HistoricalAdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: HistoricalAdmissionPauseReason };

export const decideHistoricalAdmission = (
  input: HistoricalAdmissionInput,
  config: HistoricalImportBatchConfig
): HistoricalAdmissionDecision => {
  if (input.historicalImportRows === 0) {
    return { admitted: false, reason: "no_historical_backlog" };
  }
  if (!input.apiHealthy) {
    return { admitted: false, reason: "api_degraded" };
  }
  if (!input.queueHealthy) {
    return { admitted: false, reason: "queue_degraded" };
  }
  if (!input.embeddingServiceHealthy) {
    return { admitted: false, reason: "embedding_service_degraded" };
  }
  if (input.liveProjectionRows > config.maxLiveProjectionRows) {
    return { admitted: false, reason: "live_projection_pressure" };
  }
  return input.activeHistoricalBatches >= config.maxConcurrency
    ? { admitted: false, reason: "concurrency_cap" }
    : { admitted: true };
};
