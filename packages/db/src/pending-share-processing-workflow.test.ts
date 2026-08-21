import { describe, expect, it } from "vitest";
import { decidePendingShareSourceReadiness } from "./pending-share-processing-workflow.js";

const baseSnapshot = {
  wantedRevision: 4,
  targetRevision: 4,
  replicaRevision: 4,
  logicalRevision: 4,
  remoteReplicaId: "replica-id",
  localSessionId: "session-id",
  lastProgressAtMs: 1_000,
  currentState: "preparing",
  currentStage: "processing",
  currentFailureCode: null
};

describe("Pending Share source-readiness decisions", () => {
  it("requires every source cursor and local binding at the wanted revision", () => {
    expect(
      decidePendingShareSourceReadiness(baseSnapshot, 60_000, 2_000)
    ).toEqual({ kind: "ready", remoteReplicaId: "replica-id" });
    expect(
      decidePendingShareSourceReadiness(
        { ...baseSnapshot, localSessionId: null },
        60_000,
        2_000
      )
    ).toMatchObject({ kind: "waiting", stage: "processing" });
  });

  it("marks any advanced cursor as stale", () => {
    for (const advanced of [
      { targetRevision: 5 },
      { replicaRevision: 5 },
      { logicalRevision: 5 }
    ]) {
      expect(
        decidePendingShareSourceReadiness(
          { ...baseSnapshot, ...advanced },
          60_000,
          2_000
        )
      ).toEqual({ kind: "stale" });
    }
  });

  it("distinguishes ordinary waiting from a visible stalled transition", () => {
    expect(
      decidePendingShareSourceReadiness(
        { ...baseSnapshot, targetRevision: 3 },
        60_000,
        2_000
      )
    ).toEqual({
      kind: "waiting",
      state: "preparing",
      stage: "processing",
      failureCode: null,
      visibleTransition: false
    });
    expect(
      decidePendingShareSourceReadiness(
        {
          ...baseSnapshot,
          targetRevision: 3,
          remoteReplicaId: null,
          currentStage: "processing"
        },
        60_000,
        61_000
      )
    ).toEqual({
      kind: "waiting",
      state: "needs_attention",
      stage: "syncing",
      failureCode: "source_preparation_stalled",
      visibleTransition: true
    });
  });
});
