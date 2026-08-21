export interface PendingShareSourceReadinessSnapshot {
  wantedRevision: number;
  targetRevision: number | null;
  replicaRevision: number | null;
  logicalRevision: number;
  remoteReplicaId: string | null;
  localSessionId: string | null;
  lastProgressAtMs: number;
  currentState: string;
  currentStage: string;
  currentFailureCode: string | null;
}

export type PendingShareSourceReadinessDecision =
  | { kind: "ready"; remoteReplicaId: string | null }
  | { kind: "stale" }
  | {
      kind: "waiting";
      state: "preparing" | "needs_attention";
      stage: "syncing" | "uploading" | "processing";
      failureCode: "source_preparation_stalled" | null;
      visibleTransition: boolean;
    };

export const decidePendingShareSourceReadiness = (
  snapshot: PendingShareSourceReadinessSnapshot,
  stallThresholdMs: number,
  nowMs: number
): PendingShareSourceReadinessDecision => {
  const ready =
    snapshot.remoteReplicaId !== null &&
    snapshot.localSessionId !== null &&
    snapshot.targetRevision === snapshot.wantedRevision &&
    snapshot.replicaRevision === snapshot.wantedRevision &&
    snapshot.logicalRevision === snapshot.wantedRevision;
  if (ready) {
    return { kind: "ready", remoteReplicaId: snapshot.remoteReplicaId! };
  }

  const stale =
    (snapshot.targetRevision !== null &&
      snapshot.targetRevision > snapshot.wantedRevision) ||
    (snapshot.replicaRevision !== null &&
      snapshot.replicaRevision > snapshot.wantedRevision) ||
    snapshot.logicalRevision > snapshot.wantedRevision;
  if (stale) return { kind: "stale" };

  const stalled = nowMs - snapshot.lastProgressAtMs >= stallThresholdMs;
  const state = stalled ? "needs_attention" : "preparing";
  const stage = snapshot.remoteReplicaId ? "processing" : "syncing";
  const failureCode = stalled ? "source_preparation_stalled" : null;
  return {
    kind: "waiting",
    state,
    stage,
    failureCode,
    visibleTransition:
      snapshot.currentState !== state ||
      snapshot.currentStage !== stage ||
      snapshot.currentFailureCode !== failureCode
  };
};
