import type { HistoricalAdmissionDecision } from "./historical-admission.js";

export type EmbeddingActivity = "unavailable" | "working" | "idle";

export interface EmbeddingQueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

/**
 * Content-free Diagnostic Status for the local Embedding Service and the
 * Projection work that feeds it. Every count is global to the local Koed
 * deployment and carries no memory text or identifiers.
 */
export interface EmbeddingStateSnapshot {
  generatedAt: string;
  activity: EmbeddingActivity;
  service: {
    healthy: boolean;
    compatible: boolean;
    model: string | null;
    dimensions: number | null;
    expectedModel: string;
    expectedDimensions: number;
  };
  calibration: {
    mode: string;
    measuredTokensPerSecond: number;
    calibratedAt: string | null;
  } | null;
  backlog: {
    pendingMemoryEvents: number;
    pendingMemoryNodes: number;
    pendingEstimatedTokens: number;
  } | null;
  throughput: {
    windowMinutes: number;
    measuredTokensPerSecond: number;
    eventsPerMinute: number;
    retries: number;
    failures: number;
  } | null;
  drainEstimate: {
    lowerSeconds: number;
    upperSeconds: number;
    confidence: string;
  } | null;
  queues: {
    memory: EmbeddingQueueCounts | null;
    lcm: EmbeddingQueueCounts | null;
  };
  projection: {
    liveRows: number;
    waitingForAgentTurnRows: number;
    historicalRows: number;
    historicalBytes: number;
  } | null;
  historicalAdmission: HistoricalAdmissionDecision | null;
}

const queueBusy = (counts: EmbeddingQueueCounts | null): boolean =>
  Boolean(counts && counts.waiting + counts.active + counts.delayed > 0);

export const deriveEmbeddingActivity = (
  snapshot: Omit<EmbeddingStateSnapshot, "activity" | "generatedAt">
): EmbeddingActivity => {
  if (!snapshot.service.healthy || !snapshot.service.compatible) {
    return "unavailable";
  }
  const pending = snapshot.backlog
    ? snapshot.backlog.pendingMemoryEvents + snapshot.backlog.pendingMemoryNodes
    : 0;
  return pending > 0 ||
    queueBusy(snapshot.queues.memory) ||
    queueBusy(snapshot.queues.lcm)
    ? "working"
    : "idle";
};
